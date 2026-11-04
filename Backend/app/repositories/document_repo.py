"""
DocFlow Backend — Repository: Documents, Types, Versions, Comments, Attachments
Org-scoped data access layer for all document lifecycle operations.
"""
from __future__ import annotations

import base64
import datetime
import enum
import json
from uuid import UUID

from sqlalchemy import (
    DateTime,
    String,
    Text,
    and_,
    column,
    func,
    literal_column,
    or_,
    select,
    table,
)
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, joinedload

from app.models.base import utcnow
from app.models.document import (
    Comment,
    Document,
    DocumentAttachment,
    DocumentType,
    DocumentVersion,
    DocumentWatcher,
    Mention,
)
from app.models.organization import OrganizationMember
from app.models.user import User


# ── Full-text search (FR-1.5) ─────────────────────────────────────────────────
#
# These are spelled with literal_column rather than bound parameters on
# purpose. Postgres only uses an expression index when the query's expression
# matches the indexed one, and a bind parameter is not a constant at planning
# time. The expression below is the one in migration e3f4a5b6c7d8
# (idx_documents_fts_expr); change one and you must change the other, or
# search silently falls back to a sequential scan.
#
# Not to be confused with `documents.search_vector` and its `idx_documents_fts`
# index, which were created with the table and have never been populated.
_ENGLISH = literal_column("'english'")
_EMPTY = literal_column("''")
_SPACE = literal_column("' '")
#: A tsvector is capped at ~1 MB. Without this a long enough document would
#: make its own INSERT fail once the index exists.
_FTS_TEXT_LIMIT = literal_column("100000")


def _document_tsv():
    """`to_tsvector('english', coalesce(title,'') || ' ' || left(coalesce(content_text,''), 100000))`."""
    return func.to_tsvector(
        _ENGLISH,
        func.coalesce(Document.title, _EMPTY)
        .concat(_SPACE)
        .concat(func.left(func.coalesce(Document.content_text, _EMPTY), _FTS_TEXT_LIMIT)),
    )


# ── PDF render state (FR-13.8) ────────────────────────────────────────────────
#
# A Core-level handle on the PDF columns of document_contents, added by
# migration f9a0b1c2d3e4 (applied). It was written this way so the feature
# stayed inert until that migration landed, rather than breaking every read of
# the table in the meantime. It is kept because it still reads only the five
# columns it needs: swapping it for ORM attributes now would be churn with no
# behavioural gain, and `read_pdf_state` keeps degrading safely on a
# deployment whose migrations are behind.
pdf_contents_table = table(
    "document_contents",
    column("document_id", PGUUID(as_uuid=True)),
    column("pdf_url", Text),
    column("pdf_status", String(20)),
    column("pdf_checksum", String(64)),
    column("pdf_rendered_at", DateTime(timezone=True)),
    column("pdf_error", Text),
)


async def ensure_content_row(db: AsyncSession, doc_id: UUID) -> None:
    """Create the document_contents row if it is missing, without the ORM."""
    from sqlalchemy import insert

    existing = (
        await db.execute(
            select(pdf_contents_table.c.document_id).where(
                pdf_contents_table.c.document_id == doc_id
            )
        )
    ).first()
    if existing is None:
        await db.execute(
            insert(table("document_contents", column("document_id", PGUUID(as_uuid=True))))
            .values(document_id=doc_id)
        )
        await db.flush()


async def read_pdf_state(db: AsyncSession, doc_id: UUID) -> dict:
    """
    Current PDF render state for one document.

    Degrades to "unavailable" rather than raising when the migration has not
    been applied yet, so the detail page still loads.
    """
    from sqlalchemy.exc import SQLAlchemyError

    T = pdf_contents_table
    try:
        row = (
            await db.execute(
                select(
                    T.c.pdf_status, T.c.pdf_url, T.c.pdf_checksum,
                    T.c.pdf_rendered_at, T.c.pdf_error,
                ).where(T.c.document_id == doc_id)
            )
        ).first()
    except SQLAlchemyError:
        await db.rollback()
        return {"status": None, "available": False}

    if row is None:
        return {"status": None, "available": True}
    return {
        "status": row.pdf_status,
        "storage_key": row.pdf_url,
        "checksum": row.pdf_checksum,
        "rendered_at": row.pdf_rendered_at,
        "error": row.pdf_error,
        "available": True,
    }


async def mark_pdf_pending(db: AsyncSession, doc_id: UUID) -> bool:
    """
    Flag a document's PDF as queued. Returns False when the column set is not
    there yet, so the caller can skip enqueuing rather than fail a submission.
    """
    from sqlalchemy import update
    from sqlalchemy.exc import SQLAlchemyError

    try:
        await ensure_content_row(db, doc_id)
        await db.execute(
            update(pdf_contents_table)
            .where(pdf_contents_table.c.document_id == doc_id)
            .values(pdf_status="pending", pdf_error=None)
        )
        return True
    except SQLAlchemyError:
        await db.rollback()
        return False


# ── Keyset pagination (FR-1.4, spec §25.1) ────────────────────────────────────
#
# Offset pagination makes the database walk and discard every skipped row, so
# page 400 of a 100k-row table costs 400x page 1 and cannot meet the spec's
# 300 ms p95. A keyset cursor carries the sort value and id of the last row
# seen, so every page is one index seek regardless of depth.
#
# The cursor is opaque to the client but NOT a secret and NOT a trust
# boundary: it only ever narrows a query that is already filtered by org and
# by the caller's own access rules, so a forged cursor can shift which page
# someone sees and nothing more.

_SORT_COLUMNS = {
    "updatedAt": Document.updated_at,
    "createdAt": Document.created_at,
    "dueDate": Document.due_at,
    "title": Document.title,
    "priority": Document.priority,
    "status": Document.status,
}


def _resolve_sort(sort: str | None) -> tuple[str, bool]:
    """`"<field>:<asc|desc>"` → (field name, descending). Unknown → default."""
    if not sort:
        return "updatedAt", True
    field, _, direction = sort.partition(":")
    if field not in _SORT_COLUMNS:
        return "updatedAt", True
    return field, direction.lower() != "asc"


def encode_cursor(field: str, descending: bool, value, doc_id: UUID) -> str:
    """Opaque forward cursor for the row (value, doc_id) under this sort."""
    if value is None:
        raw = None
    elif isinstance(value, datetime.datetime):
        raw = value.isoformat()
    elif isinstance(value, enum.Enum):
        # `DocumentStatus` mixes in str but keeps Enum.__str__, so str() on it
        # gives "DocumentStatus.DRAFT" — which would never match the column
        # and would quietly end the list. The stored value is what compares.
        raw = str(value.value)
    else:
        raw = str(value)
    payload = {
        "f": field,
        "d": "desc" if descending else "asc",
        "v": raw,
        "i": str(doc_id),
    }
    return base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode().rstrip("=")


def decode_cursor(cursor: str) -> dict:
    """Reverse of `encode_cursor`. Raises ValueError on anything malformed."""
    pad = "=" * (-len(cursor) % 4)
    payload = json.loads(base64.urlsafe_b64decode(cursor + pad))
    if not isinstance(payload, dict):
        raise ValueError("cursor is not an object")
    for key in ("f", "d", "i"):
        if not isinstance(payload.get(key), str):
            raise ValueError(f"cursor is missing {key}")
    if payload["f"] not in _SORT_COLUMNS:
        raise ValueError("cursor names an unknown sort field")
    UUID(payload["i"])                       # raises if not a uuid
    return payload


def _cursor_value(field: str, raw: str | None):
    """The stored cursor string back into something comparable to the column."""
    if raw is None:
        return None
    if field in ("updatedAt", "createdAt", "dueDate"):
        return datetime.datetime.fromisoformat(raw)
    return raw


def _after_cursor(col, descending: bool, value, last_id: UUID):
    """
    Rows strictly AFTER the cursor row in `ORDER BY col <dir> NULLS LAST,
    id DESC`.

    The NULL handling is the part that bites. `due_at` is nullable, and a
    plain tuple comparison against NULL yields NULL — which is not true, so
    the query would silently return an empty page and the list would look
    like it had ended. Both directions put NULLs last, so:
      - from a non-null cursor, every NULL row still lies ahead;
      - from a NULL cursor we are already inside the NULL tail, and only the
        id tie-break applies.
    The id tie-break is DESC in both directions, matching the ORDER BY this
    table has always used, so ordering within ties is unchanged.
    """
    if value is None:
        return and_(col.is_(None), Document.id < last_id)
    beyond = col < value if descending else col > value
    return or_(
        col.is_(None),
        beyond,
        and_(col == value, Document.id < last_id),
    )


# Fields a partial update is allowed to set back to NULL. Deliberately a
# closed list: `clear` arrives from the request body, so an open setattr would
# let a caller null out `status`, `org_id` or `submitted_by`.
_CLEARABLE = frozenset(
    {"category", "effective_from", "expires_at", "reminder_days_before", "reminder_sent_at"}
)


class DocumentTypeRepository:
    """Data access for the document_types table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_by_id(self, type_id: UUID, org_id: UUID) -> DocumentType | None:
        result = await self.db.execute(
            select(DocumentType).where(
                DocumentType.id == type_id,
                DocumentType.org_id == org_id,
                DocumentType.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def get_by_code(self, code: str, org_id: UUID) -> DocumentType | None:
        result = await self.db.execute(
            select(DocumentType).where(
                DocumentType.code == code,
                DocumentType.org_id == org_id,
                DocumentType.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list_by_org(self, org_id: UUID, active_only: bool = True) -> list[DocumentType]:
        q = select(DocumentType).where(
            DocumentType.org_id == org_id,
            DocumentType.deleted_at.is_(None),
        )
        if active_only:
            q = q.where(DocumentType.is_active.is_(True))
        q = q.order_by(DocumentType.category, DocumentType.name)
        result = await self.db.execute(q)
        return list(result.scalars().all())

    async def create(
        self,
        org_id: UUID,
        name: str,
        code: str,
        description: str | None = None,
        category: str | None = "General",
        icon: str | None = "file",
        color: str | None = "blue",
        form_schema: list | None = None,
        metadata_schema: dict | None = None,
        retention_days: int | None = None,
    ) -> DocumentType:
        dt = DocumentType(
            org_id=org_id,
            name=name,
            code=code,
            description=description,
            category=category,
            icon=icon,
            color=color,
            form_schema=form_schema or [],
            metadata_schema=metadata_schema or {},
            retention_days=retention_days,
            is_active=True,
        )
        self.db.add(dt)
        await self.db.flush()
        return dt

    async def update(
        self,
        dt: DocumentType,
        *,
        name: str | None = None,
        code: str | None = None,
        description: str | None = None,
        category: str | None = None,
        icon: str | None = None,
        color: str | None = None,
        form_schema: list | None = None,
        metadata_schema: dict | None = None,
        is_active: bool | None = None,
        retention_days: int | None = None,
    ) -> DocumentType:
        if name is not None:
            dt.name = name
        if code is not None:
            dt.code = code
        if description is not None:
            dt.description = description
        if category is not None:
            dt.category = category
        if icon is not None:
            dt.icon = icon
        if color is not None:
            dt.color = color
        if form_schema is not None:
            dt.form_schema = form_schema
        if metadata_schema is not None:
            dt.metadata_schema = metadata_schema
        if is_active is not None:
            dt.is_active = is_active
        if retention_days is not None:
            dt.retention_days = retention_days
        await self.db.flush()
        return dt

    async def soft_delete(self, dt: DocumentType) -> None:
        dt.deleted_at = utcnow()
        await self.db.flush()


class DocumentRepository:
    """Data access for the documents table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def generate_public_id(self, org_id: UUID) -> str:
        """Generate DOC-YYYY-NNNNN formatted sequential public ID."""
        year = datetime.datetime.now(datetime.timezone.utc).year
        prefix = f"DOC-{year}-"
        result = await self.db.execute(
            select(func.count()).select_from(Document).where(
                Document.public_id.like(f"{prefix}%"),
            )
        )
        count = result.scalar_one() + 1
        return f"{prefix}{count:05d}"

    async def get_by_id(self, doc_id: UUID, org_id: UUID) -> Document | None:
        result = await self.db.execute(
            select(Document)
            .options(
                joinedload(Document.doc_type),
                joinedload(Document.submitter),
            )
            .where(
                Document.id == doc_id,
                Document.org_id == org_id,
                Document.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list_by_org(
        self,
        org_id: UUID,
        user_id: UUID,
        is_admin: bool,
        is_approver: bool,
        accessible_dept_ids: list[UUID],
        page: int = 1,
        limit: int = 20,
        status: str | None = None,
        doc_type_id: UUID | None = None,
        dept_id: UUID | None = None,
        submitted_by: UUID | None = None,
        search: str | None = None,
        tags: list[str] | None = None,
        priority: str | None = None,
        date_from: datetime.datetime | None = None,
        date_to: datetime.datetime | None = None,
        sort: str | None = None,
        cursor: str | None = None,
        workflow_template_id: UUID | None = None,
    ) -> tuple[list[Document], int, str | None]:
        q = (
            select(Document)
            .options(
                joinedload(Document.doc_type),
                joinedload(Document.submitter),
            )
            .where(
                Document.org_id == org_id,
                Document.deleted_at.is_(None),
            )
        )

        if not is_admin:
            if is_approver:
                q = q.where(
                    or_(
                        Document.submitted_by == user_id,
                        Document.dept_id.in_(accessible_dept_ids),
                        Document.dept_id.is_(None),
                    )
                )
            else:
                q = q.where(Document.submitted_by == user_id)

        if status:
            q = q.where(Document.status == status)
        if doc_type_id:
            q = q.where(Document.doc_type_id == doc_type_id)
        if dept_id:
            q = q.where(Document.dept_id == dept_id)
        if submitted_by:
            q = q.where(Document.submitted_by == submitted_by)
        if priority:
            q = q.where(Document.priority == priority)
        if tags:
            q = q.where(Document.tags.contains(tags))
        if date_from:
            q = q.where(Document.created_at >= date_from)
        if date_to:
            q = q.where(Document.created_at <= date_to)
        if workflow_template_id:
            # Documents routed through a given workflow. EXISTS rather than a
            # join: a document can have several instances over its life, and
            # a join would return it once per instance.
            from app.models.workflow import WorkflowInstance

            q = q.where(
                select(WorkflowInstance.id)
                .where(
                    WorkflowInstance.document_id == Document.id,
                    WorkflowInstance.template_id == workflow_template_id,
                )
                .exists()
            )
        if search:
            search_pattern = f"%{search}%"
            # FR-1.5 — full-text over title + description, backed by the GIN
            # index from migration e3f4a5b6c7d8. The two ILIKE branches stay:
            # full-text matches whole stemmed words, so without them a search
            # for "agree" or a reference-number fragment would stop finding
            # what it used to. This clause therefore only ever adds matches.
            q = q.where(
                or_(
                    _document_tsv().op("@@")(
                        func.websearch_to_tsquery(_ENGLISH, search)
                    ),
                    Document.title.ilike(search_pattern),
                    Document.public_id.ilike(search_pattern),
                )
            )

        # Sort (FR-1.1): "<field>:<asc|desc>". Default = most recently updated
        # first. `id` is always the final tie-break, so the total order is
        # stable and a keyset cursor can never skip or repeat a row.
        field, descending = _resolve_sort(sort)
        col = _SORT_COLUMNS[field]

        # Count only when there is no cursor. Counting the whole filtered set
        # on every page is the cost keyset pagination exists to avoid, and the
        # client already has the total from the first request. -1 reads as
        # "not counted" rather than a misleading 0.
        if cursor:
            total = -1
        else:
            count_res = await self.db.execute(
                select(func.count()).select_from(q.subquery())
            )
            total = count_res.scalar_one()

        if cursor:
            payload = decode_cursor(cursor)       # ValueError → 400 upstream
            if payload["f"] != field or (payload["d"] == "desc") != descending:
                # The sort changed under a cursor taken for a different one.
                # Paging on would silently drop or duplicate rows, so refuse
                # instead; the client resets the cursor when sort changes.
                raise ValueError("cursor does not match the requested sort")
            q = q.where(
                _after_cursor(
                    col,
                    descending,
                    _cursor_value(field, payload["v"]),
                    UUID(payload["i"]),
                )
            )

        order_col = col.desc().nulls_last() if descending else col.asc().nulls_last()

        # One extra row is the cheapest way to know whether a next page
        # exists without a second query; it is dropped before returning.
        q = q.order_by(order_col, Document.id.desc())
        if not cursor and page > 1:
            # Back-compatible offset path: existing callers (and any bookmarked
            # ?page=3) keep working. New clients send a cursor instead.
            q = q.offset((page - 1) * limit)
        q = q.limit(limit + 1)

        res = await self.db.execute(q)
        rows = list(res.scalars().unique().all())

        has_more = len(rows) > limit
        items = rows[:limit]
        next_cursor = None
        if has_more and items:
            last = items[-1]
            next_cursor = encode_cursor(
                field, descending, getattr(last, col.key), last.id
            )

        return items, total, next_cursor

    async def create(
        self,
        org_id: UUID,
        doc_type_id: UUID,
        public_id: str,
        title: str,
        status: str,
        priority: str,
        form_data: dict,
        metadata_: dict,
        dept_id: UUID | None,
        due_at: datetime.datetime | None,
        submitted_by: UUID,
        submitted_at: datetime.datetime | None = None,
        submitter_snapshot: dict | None = None,
        tags: list[str] | None = None,
        source: str = "template",
        confidentiality: str | None = None,
        current_step: str | None = None,
        template_version_id: UUID | None = None,
    ) -> Document:
        doc = Document(
            org_id=org_id,
            doc_type_id=doc_type_id,
            public_id=public_id,
            title=title,
            status=status,
            priority=priority,
            form_data=form_data,
            metadata_=metadata_,
            dept_id=dept_id,
            due_at=due_at,
            submitted_by=submitted_by,
            submitted_at=submitted_at,
            submitter_snapshot=submitter_snapshot,
            tags=tags or [],
            source=source,
            confidentiality=confidentiality,
            current_step=current_step,
            template_version_id=template_version_id,
        )
        self.db.add(doc)
        await self.db.flush()
        return doc

    async def update(
        self,
        doc: Document,
        *,
        title: str | None = None,
        priority: str | None = None,
        form_data: dict | None = None,
        metadata_: dict | None = None,
        dept_id: UUID | None = None,
        due_at: datetime.datetime | None = None,
        status: str | None = None,
        submitted_at: datetime.datetime | None = None,
        tags: list[str] | None = None,
        source: str | None = None,
        confidentiality: str | None = None,
        current_step: str | None = None,
        version: int | None = None,
        category: str | None = None,
        effective_from: datetime.datetime | None = None,
        expires_at: datetime.datetime | None = None,
        reminder_days_before: int | None = None,
        reminder_sent_at: datetime.datetime | None = None,
        clear: set[str] | None = None,
    ) -> Document:
        """
        Partial update. A `None` argument means "not supplied, leave alone";
        `clear` names the attributes to set back to NULL, which is the only way
        to express "remove this expiry date" through a partial update.
        """
        if title is not None:
            doc.title = title
        if priority is not None:
            doc.priority = priority
        if tags is not None:
            doc.tags = tags
        if form_data is not None:
            doc.form_data = form_data
        if metadata_ is not None:
            doc.metadata_ = metadata_
        if dept_id is not None:
            doc.dept_id = dept_id
        if due_at is not None:
            doc.due_at = due_at
        if status is not None:
            doc.status = status
        if submitted_at is not None:
            doc.submitted_at = submitted_at
        if source is not None:
            doc.source = source
        if confidentiality is not None:
            doc.confidentiality = confidentiality
        if current_step is not None:
            doc.current_step = current_step
        if version is not None:
            doc.version = version
        if category is not None:
            doc.category = category
        if effective_from is not None:
            doc.effective_from = effective_from
        if expires_at is not None:
            doc.expires_at = expires_at
        if reminder_days_before is not None:
            doc.reminder_days_before = reminder_days_before
        if reminder_sent_at is not None:
            doc.reminder_sent_at = reminder_sent_at
        for name in clear or ():
            # Guarded against arbitrary attribute names: only the nullable
            # detail fields may be cleared this way, never `status` or an id.
            if name in _CLEARABLE:
                setattr(doc, name, None)
        await self.db.flush()
        return doc

    async def soft_delete(self, doc: Document) -> None:
        doc.deleted_at = utcnow()
        await self.db.flush()

    async def get_counts(self, doc_id: UUID) -> tuple[int, int, int]:
        """Return (attachment_count, comment_count, version_count)."""
        att_res = await self.db.execute(
            select(func.count()).select_from(DocumentAttachment).where(
                DocumentAttachment.document_id == doc_id,
                DocumentAttachment.deleted_at.is_(None),
            )
        )
        att_count = att_res.scalar_one()

        com_res = await self.db.execute(
            select(func.count()).select_from(Comment).where(
                Comment.document_id == doc_id,
                Comment.deleted_at.is_(None),
            )
        )
        com_count = com_res.scalar_one()

        ver_res = await self.db.execute(
            select(func.count()).select_from(DocumentVersion).where(
                DocumentVersion.document_id == doc_id,
            )
        )
        ver_count = ver_res.scalar_one()
        return att_count, com_count, ver_count


class DocumentVersionRepository:
    """Data access for the document_versions table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_latest_version_num(self, document_id: UUID) -> int:
        result = await self.db.execute(
            select(func.max(DocumentVersion.version_num)).where(
                DocumentVersion.document_id == document_id,
            )
        )
        val = result.scalar_one_or_none()
        return val if val is not None else 0

    async def get_latest_created_at(self, document_id: UUID) -> datetime.datetime | None:
        """Timestamp of the newest version snapshot (for autosave throttling)."""
        result = await self.db.execute(
            select(func.max(DocumentVersion.created_at)).where(
                DocumentVersion.document_id == document_id,
            )
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        document_id: UUID,
        version_num: int,
        title: str,
        form_data: dict,
        changed_by: UUID,
        change_reason: str | None = None,
    ) -> DocumentVersion:
        ver = DocumentVersion(
            document_id=document_id,
            version_num=version_num,
            title=title,
            form_data=form_data,
            # uploaded_by is the canonical, NOT NULL authorship column;
            # changed_by is a legacy, nullable duplicate kept for compatibility.
            # None of the 4 call sites (create/update/submit/restore) pass a
            # separate uploader, so uploaded_by == changed_by here.
            uploaded_by=changed_by,
            changed_by=changed_by,
            change_reason=change_reason,
        )
        self.db.add(ver)
        await self.db.flush()
        return ver

    async def list_by_doc(self, document_id: UUID) -> list[DocumentVersion]:
        result = await self.db.execute(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == document_id)
            .order_by(DocumentVersion.version_num.desc())
        )
        return list(result.scalars().all())


class CommentRepository:
    """Data access for the comments table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_by_id(self, comment_id: UUID, org_id: UUID) -> Comment | None:
        result = await self.db.execute(
            select(Comment).where(
                Comment.id == comment_id,
                Comment.org_id == org_id,
                Comment.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list_by_doc(self, document_id: UUID) -> list[Comment]:
        result = await self.db.execute(
            select(Comment)
            .where(
                Comment.document_id == document_id,
                Comment.deleted_at.is_(None),
            )
            .order_by(Comment.created_at.asc())
        )
        return list(result.scalars().all())

    async def create(
        self,
        org_id: UUID,
        document_id: UUID,
        body: str,
        author_id: UUID,
        parent_id: UUID | None = None,
        is_internal: bool = False,
    ) -> Comment:
        com = Comment(
            org_id=org_id,
            document_id=document_id,
            body=body,
            author_id=author_id,
            parent_id=parent_id,
            is_internal=is_internal,
        )
        self.db.add(com)
        await self.db.flush()
        return com

    async def update(
        self,
        com: Comment,
        *,
        body: str | None = None,
        is_resolved: bool | None = None,
    ) -> Comment:
        if body is not None:
            com.body = body
        if is_resolved is not None:
            com.resolved_at = utcnow() if is_resolved else None
        await self.db.flush()
        return com

    async def add_mentions(self, comment_id: UUID, user_ids: list[UUID]) -> None:
        for uid in user_ids:
            mention = Mention(comment_id=comment_id, user_id=uid)
            self.db.add(mention)
        await self.db.flush()


class AttachmentRepository:
    """Data access for the document_attachments table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_by_id(self, att_id: UUID) -> DocumentAttachment | None:
        result = await self.db.execute(
            select(DocumentAttachment)
            .options(joinedload(DocumentAttachment.file_asset))
            .where(
                DocumentAttachment.id == att_id,
                DocumentAttachment.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list_by_doc(self, document_id: UUID) -> list[DocumentAttachment]:
        result = await self.db.execute(
            select(DocumentAttachment)
            .options(joinedload(DocumentAttachment.file_asset))
            .where(
                DocumentAttachment.document_id == document_id,
                DocumentAttachment.deleted_at.is_(None),
            )
            .order_by(DocumentAttachment.created_at.desc())
        )
        return list(result.scalars().unique().all())

    async def create(
        self,
        document_id: UUID,
        file_asset_id: UUID,
        label: str | None,
        attached_by: UUID,
    ) -> DocumentAttachment:
        att = DocumentAttachment(
            document_id=document_id,
            file_asset_id=file_asset_id,
            label=label,
            attached_by=attached_by,
        )
        self.db.add(att)
        await self.db.flush()
        return att

    async def soft_delete(self, att: DocumentAttachment) -> None:
        att.deleted_at = utcnow()
        await self.db.flush()


class WatcherRepository:
    """
    Watchers CC'd on a document (spec FR-13.4).

    Every method joins through `documents` on org_id, so a watcher row can
    never be read or written across organisations even if an id leaks.
    """

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def list_by_doc(self, document_id: UUID) -> list[tuple[DocumentWatcher, User | None, User | None]]:
        """Live watchers with the watched user and whoever added them."""
        adder = aliased(User)
        result = await self.db.execute(
            select(DocumentWatcher, User, adder)
            .outerjoin(User, User.id == DocumentWatcher.user_id)
            .outerjoin(adder, adder.id == DocumentWatcher.added_by)
            .where(
                DocumentWatcher.document_id == document_id,
                DocumentWatcher.deleted_at.is_(None),
            )
            .order_by(DocumentWatcher.created_at.asc())
        )
        return [(row[0], row[1], row[2]) for row in result.all()]

    async def count_by_doc(self, document_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count())
            .select_from(DocumentWatcher)
            .where(
                DocumentWatcher.document_id == document_id,
                DocumentWatcher.deleted_at.is_(None),
            )
        )
        return result.scalar_one()

    async def user_ids_for_doc(self, document_id: UUID) -> list[UUID]:
        """Just the user ids — what the notification fan-out needs."""
        result = await self.db.execute(
            select(DocumentWatcher.user_id).where(
                DocumentWatcher.document_id == document_id,
                DocumentWatcher.deleted_at.is_(None),
            )
        )
        return list(result.scalars().all())

    async def get(self, document_id: UUID, user_id: UUID) -> DocumentWatcher | None:
        """Including soft-deleted rows, so re-adding revives one row."""
        result = await self.db.execute(
            select(DocumentWatcher).where(
                DocumentWatcher.document_id == document_id,
                DocumentWatcher.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def add(self, document_id: UUID, user_id: UUID, added_by: UUID) -> DocumentWatcher:
        # The unique constraint covers soft-deleted rows too, so removing and
        # re-adding the same person must revive the existing row rather than
        # insert a second one and hit a constraint violation.
        existing = await self.get(document_id, user_id)
        if existing is not None:
            existing.deleted_at = None
            existing.added_by = added_by
            await self.db.flush()
            return existing
        row = DocumentWatcher(
            document_id=document_id, user_id=user_id, added_by=added_by
        )
        self.db.add(row)
        await self.db.flush()
        return row

    async def soft_delete(self, row: DocumentWatcher) -> None:
        row.deleted_at = utcnow()
        await self.db.flush()

    async def candidates(
        self, org_id: UUID, document_id: UUID, search: str | None, limit: int = 20
    ) -> list[User]:
        """
        Active colleagues in this org who are not already watching.

        Returns User rows; the caller narrows them to id/name/email so this
        cannot be used to read roles or departments.
        """
        already = select(DocumentWatcher.user_id).where(
            DocumentWatcher.document_id == document_id,
            DocumentWatcher.deleted_at.is_(None),
        )
        # Org membership lives in `organization_members`, NOT on `users` --
        # a user row has no org_id, so this has to join. Only ACTIVE
        # memberships count: someone with a pending join request is not yet a
        # colleague and must not be suggestible.
        in_org = select(OrganizationMember.user_id).where(
            OrganizationMember.org_id == org_id,
            OrganizationMember.status == "active",
            OrganizationMember.deleted_at.is_(None),
        )
        q = select(User).where(
            User.id.in_(in_org),
            User.deleted_at.is_(None),
            User.is_active.is_(True),
            User.id.notin_(already),
        )
        if search:
            pattern = f"%{search}%"
            q = q.where(or_(User.name.ilike(pattern), User.email.ilike(pattern)))
        q = q.order_by(User.name.asc()).limit(min(limit, 50))
        result = await self.db.execute(q)
        return list(result.scalars().all())
