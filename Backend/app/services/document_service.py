"""
DocFlow Backend — Service: Documents & Document Types
Business logic for dynamic form validation, version snapshots, threaded comments, and caching.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import structlog
from typing import Any
from uuid import UUID
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnprocessableEntityException,
    ValidationException,
    FieldValidationException,
)
from app.core.redis import cache_delete, cache_get, cache_set
from app.core.events import EventBus
from app.domain.enums import NotificationType
from app.domain.permissions import AuthUser
from app.models.base import utcnow
from app.models.document import Document, DocumentTemplate, DocumentStatus, DocumentVersion
from app.models.organization import OrganizationMember
from app.config import settings
from app.repositories.document_repo import (
    mark_pdf_pending,
    read_pdf_state,
    AttachmentRepository,
    CommentRepository,
    DocumentRepository,
    DocumentTypeRepository,
    DocumentVersionRepository,
    WatcherRepository,
)
from app.repositories.user_repo import UserRepository
from app.services.content_sanitizer import (
    ContentTooLargeError,
    content_to_text,
    sanitize_editor_content,
)
from app.schemas.document import (
    AttachmentResponse,
    CommentCreateRequest,
    CommentResponse,
    CommentUpdateRequest,
    DocumentContentResponse,
    DocumentContentUpdateRequest,
    DocumentFillFieldSchema,
    DocumentFillSchemaResponse,
    DocumentCreateRequest,
    DocumentResponse,
    DocumentSubmitRequest,
    DocumentTypeCreateRequest,
    DocumentTypeResponse,
    DocumentTypeUpdateRequest,
    DocumentUpdateRequest,
    DocumentVersionResponse,
    MentionResponse,
    PaginatedDocumentsResponse,
    WatcherCandidateResponse,
    WatcherResponse,
)
from app.models.audit import AuditLog
from app.services.notification_service import NotificationService

from app.services.document_validation import validate_document

logger = structlog.get_logger(__name__)

_DOC_TYPES_CACHE_TTL = 600  # 10 minutes


def _doc_types_cache_key(org_id: UUID) -> str:
    return f"doc_types:list:{org_id}"


async def get_user_departments(db: AsyncSession, user_id: UUID, org_id: UUID) -> list[UUID]:
    from sqlalchemy import select
    result = await db.execute(
        select(OrganizationMember.dept_id)
        .where(
            OrganizationMember.user_id == user_id,
            OrganizationMember.org_id == org_id,
            OrganizationMember.deleted_at.is_(None)
        )
    )
    return [d for d in result.scalars() if d is not None]


async def can_user_access_document(db: AsyncSession, user: AuthUser, doc: Document) -> bool:
    """Visibility Rule for Documents."""
    if user.id == doc.submitted_by:
        return True
    if "admin" in user.roles or "hr" in user.roles:
        return True

    if "worker" in user.roles:
        if doc.dept_id is None:
            return True
        user_depts = await get_user_departments(db, user.id, doc.org_id)
        if doc.dept_id in user_depts:
            return True
            
    return False


def validate_form_data(form_schema: list[Any], form_data: dict[str, Any]) -> None:
    """Validate that form_data satisfies required fields and constraints defined in form_schema."""
    for field in form_schema:
        f_dict = field.model_dump() if hasattr(field, "model_dump") else field
        key = f_dict.get("key")
        label = f_dict.get("label", key)
        required = f_dict.get("required", False)
        f_type = f_dict.get("type", "text")
        options = f_dict.get("options")

        val = form_data.get(key)
        if required and (val is None or val == "" or val == []):
            raise ValidationException(f"Field '{label}' ({key}) is required.")

        if val is not None and val != "":
            if f_type == "number":
                try:
                    float(val)
                except (ValueError, TypeError):
                    raise ValidationException(f"Field '{label}' ({key}) must be a valid number.")
            elif f_type == "select" and options:
                if val not in options:
                    raise ValidationException(
                        f"Value '{val}' for field '{label}' is not among valid options: {options}"
                    )


# ── Document Type Service ─────────────────────────────────────────────────────

class DocumentTypeService:
    """CRUD and caching for Organization Document Types."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = DocumentTypeRepository(db)

    async def list_types(self, org_id: UUID, active_only: bool = True) -> list[DocumentTypeResponse]:
        cache_key = _doc_types_cache_key(org_id)
        if active_only:
            cached = await cache_get(cache_key)
            if cached and isinstance(cached, list):
                return [DocumentTypeResponse.model_validate(item) for item in cached]

        types = await self.repo.list_by_org(org_id, active_only=active_only)
        result = [DocumentTypeResponse.model_validate(t) for t in types]

        if active_only:
            await cache_set(cache_key, [r.model_dump(mode="json") for r in result], ttl_seconds=_DOC_TYPES_CACHE_TTL)
        return result

    async def get_type(self, type_id: UUID, org_id: UUID) -> DocumentTypeResponse:
        dt = await self.repo.get_by_id(type_id, org_id)
        if not dt:
            raise NotFoundException("Document type not found")
        return DocumentTypeResponse.model_validate(dt)

    async def create_type(
        self,
        org_id: UUID,
        req: DocumentTypeCreateRequest,
    ) -> DocumentTypeResponse:
        existing = await self.repo.get_by_code(req.code, org_id)
        if existing:
            raise ConflictException(f"Document type with code '{req.code}' already exists in this organization")

        form_schema_dicts = [f.model_dump() for f in req.form_schema]
        dt = await self.repo.create(
            org_id=org_id,
            name=req.name,
            code=req.code,
            description=req.description,
            category=req.category,
            icon=req.icon,
            color=req.color,
            form_schema=form_schema_dicts,
            metadata_schema=req.metadata_schema,
            retention_days=req.retention_days,
        )
        await self.db.commit()
        await cache_delete(_doc_types_cache_key(org_id))
        logger.info("doc_type_created", org_id=str(org_id), code=req.code)
        return DocumentTypeResponse.model_validate(dt)

    async def update_type(
        self,
        type_id: UUID,
        org_id: UUID,
        req: DocumentTypeUpdateRequest,
    ) -> DocumentTypeResponse:
        dt = await self.repo.get_by_id(type_id, org_id)
        if not dt:
            raise NotFoundException("Document type not found")

        if req.code and req.code != dt.code:
            if await self.repo.get_by_code(req.code, org_id):
                raise ConflictException(f"Document type with code '{req.code}' already exists")

        form_schema_dicts = [f.model_dump() for f in req.form_schema] if req.form_schema is not None else None
        dt = await self.repo.update(
            dt,
            name=req.name,
            code=req.code,
            description=req.description,
            category=req.category,
            icon=req.icon,
            color=req.color,
            form_schema=form_schema_dicts,
            metadata_schema=req.metadata_schema,
            is_active=req.is_active,
            retention_days=req.retention_days,
        )
        await self.db.commit()
        await cache_delete(_doc_types_cache_key(org_id))
        return DocumentTypeResponse.model_validate(dt)

    async def delete_type(self, type_id: UUID, org_id: UUID) -> None:
        dt = await self.repo.get_by_id(type_id, org_id)
        if not dt:
            raise NotFoundException("Document type not found")
        await self.repo.soft_delete(dt)
        await self.db.commit()
        await cache_delete(_doc_types_cache_key(org_id))
        logger.info("doc_type_deleted", type_id=str(type_id))


# ── Document Service ──────────────────────────────────────────────────────────

# Statuses whose body and metadata a user may still change. Everything else is
# frozen: once a document is handed to the workflow engine, approvers must be
# looking at exactly what the submitter sent (spec FR-13.8). SENT_BACK is
# editable on purpose — "changes requested" is an instruction to edit.
EDITABLE_STATUSES = frozenset(
    {DocumentStatus.DRAFT, DocumentStatus.READY, DocumentStatus.SENT_BACK}
)


def _snapshot_checksum(snapshot: dict) -> str:
    """
    SHA-256 over the canonical JSON of the snapshot (excluding the checksum
    itself). Not a signature — it cannot stop someone with database access —
    but it makes an edit to a frozen submission detectable instead of silent.
    """
    payload = {k: v for k, v in snapshot.items() if k != "checksum"}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def verify_snapshot(snapshot: dict | None) -> bool:
    """True when a stored snapshot still matches its checksum."""
    if not isinstance(snapshot, dict) or "checksum" not in snapshot:
        return False
    return _snapshot_checksum(snapshot) == snapshot["checksum"]


# Detail fields the client may explicitly null out via `clear_fields`.
# `reminder_sent_at` is NOT in this set: it is the server's own bookkeeping,
# and letting a client reset it would let anyone re-trigger reminder emails.
_CLEARABLE_DETAILS = frozenset(
    {"category", "effective_from", "expires_at", "reminder_days_before"}
)


def _require_editable(doc: Document) -> None:
    if doc.status not in EDITABLE_STATUSES:
        raise ConflictException(
            f"This document is locked (status: {doc.status.value}) and can no longer be edited."
        )


class DocumentService:
    """Document creation, form validation, version snapshots, and comments."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.doc_repo = DocumentRepository(db)
        self.type_repo = DocumentTypeRepository(db)
        self.ver_repo = DocumentVersionRepository(db)
        self.comment_repo = CommentRepository(db)
        self.att_repo = AttachmentRepository(db)
        self.watcher_repo = WatcherRepository(db)
        self.user_repo = UserRepository(db)

    async def _format_doc_response(self, doc: Document) -> DocumentResponse:
        att_count, com_count, ver_count = await self.doc_repo.get_counts(doc.id)
        watcher_count = await self.watcher_repo.count_by_doc(doc.id)
        dt = doc.doc_type
        sub = doc.submitter

        current_step_id: UUID | None = None
        current_instance_id: UUID | None = None
        if doc.status not in (DocumentStatus.DRAFT,):
            from sqlalchemy import select
            from app.models.workflow import ApprovalStep, WorkflowInstance
            step_result = await self.db.execute(
                select(ApprovalStep.id, WorkflowInstance.id)
                .join(WorkflowInstance, WorkflowInstance.id == ApprovalStep.instance_id)
                .where(WorkflowInstance.document_id == doc.id)
                .order_by(ApprovalStep.created_at.desc())
                .limit(1)
            )
            row = step_result.first()
            if row:
                current_step_id, current_instance_id = row

        return DocumentResponse(
            id=doc.id,
            org_id=doc.org_id,
            doc_type_id=doc.doc_type_id,
            doc_type_name=dt.name if dt else "Unknown",
            doc_type_code=dt.code if dt else "unknown",
            dept_id=doc.dept_id,
            public_id=doc.public_id,
            title=doc.title,
            status=doc.status,
            priority=doc.priority,
            tags=doc.tags or [],
            form_data=doc.form_data or {},
            metadata=doc.metadata_ or {},
            submitted_by=doc.submitted_by,
            submitter_name=sub.name if sub else "Unknown",
            submitter_email=sub.email if sub else None,
            submitted_at=doc.submitted_at,
            due_at=doc.due_at,
            created_at=doc.created_at,
            updated_at=doc.updated_at,
            source=doc.source,
            template_version_id=doc.template_version_id,
            confidentiality=doc.confidentiality,
            current_step=doc.current_step,
            version=doc.version,
            category=doc.category,
            effective_from=doc.effective_from,
            expires_at=doc.expires_at,
            reminder_days_before=doc.reminder_days_before,
            reminder_sent_at=doc.reminder_sent_at,
            watcher_count=watcher_count,
            attachment_count=att_count,
            comment_count=com_count,
            version_count=max(ver_count, 1),
            current_approval_step_id=current_step_id,
            current_workflow_instance_id=current_instance_id,
        )

    async def get_document(self, doc_id: UUID, user: AuthUser) -> DocumentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")
        return await self._format_doc_response(doc)

    async def list_documents(
        self,
        user: AuthUser,
        page: int = 1,
        limit: int = 20,
        status: str | None = None,
        doc_type_id: UUID | None = None,
        dept_id: UUID | None = None,
        submitted_by: UUID | None = None,
        search: str | None = None,
        tags: list[str] | None = None,
        priority: str | None = None,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
        sort: str | None = None,
        cursor: str | None = None,
        workflow_template_id: UUID | None = None,
    ) -> PaginatedDocumentsResponse:
        limit = min(limit, 100)
        accessible_dept_ids = await get_user_departments(self.db, user.id, user.org_id)

        items_db, total, next_cursor = await self.doc_repo.list_by_org(
            user.org_id,
            user_id=user.id,
            is_admin="admin" in user.roles or "hr" in user.roles,
            is_approver="worker" in user.roles,
            accessible_dept_ids=accessible_dept_ids,
            page=page, limit=limit,
            status=status, doc_type_id=doc_type_id, dept_id=dept_id,
            submitted_by=submitted_by, search=search,
            tags=tags, priority=priority, date_from=date_from, date_to=date_to,
            sort=sort, cursor=cursor,
            workflow_template_id=workflow_template_id,
        )
        items = [await self._format_doc_response(d) for d in items_db]
        # `total` is -1 on a cursor request (not counted — see the schema), and
        # a page count derived from that would be nonsense, so it stays 0 and
        # the client uses `next_cursor` to know whether to keep going.
        pages = math.ceil(total / limit) if (limit and total >= 0) else 0
        return PaginatedDocumentsResponse(
            items=items, total=total, page=page, limit=limit, pages=pages,
            next_cursor=next_cursor,
        )

    async def get_analytics(self, user: AuthUser) -> dict[str, int]:
        from sqlalchemy import select, func
        accessible_dept_ids = await get_user_departments(self.db, user.id, user.org_id)
        
        q = select(Document.status, func.count()).where(
            Document.org_id == user.org_id,
            Document.deleted_at.is_(None)
        )
        
        if "admin" not in user.roles and "hr" not in user.roles:
            from sqlalchemy import or_
            if "worker" in user.roles:
                q = q.where(
                    or_(
                        Document.submitted_by == user.id,
                        Document.dept_id.in_(accessible_dept_ids),
                        Document.dept_id.is_(None)
                    )
                )
            else:
                q = q.where(Document.submitted_by == user.id)
                
        q = q.group_by(Document.status)
        result = await self.db.execute(q)
        counts = {r[0].value if hasattr(r[0], 'value') else r[0]: r[1] for r in result.all()}
        
        # Ensure base keys exist
        for k in ["draft", "submitted", "pending", "approved", "rejected"]:
            if k not in counts:
                counts[k] = 0
        return counts

    async def create_document(
        self,
        org_id: UUID,
        submitted_by: UUID,
        req: DocumentCreateRequest,
        user: AuthUser | None = None,
    ) -> DocumentResponse:
        dt = await self.type_repo.get_by_id(req.doc_type_id, org_id)
        if not dt:
            raise NotFoundException("Document type not found")

        # Validate form_data against form_schema
        if dt.form_schema:
            validate_form_data(dt.form_schema, req.form_data)

        # Starting from a Template Studio template: pin the CURRENT PUBLISHED
        # version now, so later edits to the template cannot change this
        # document (spec C9 / FR-11.5). Visibility is checked there — an
        # invisible template id raises 404, not 403.
        pinned_version = None
        if req.template_id is not None:
            if user is None:
                raise ValidationException("Template documents must be created by a signed-in user")
            # Imported here: template_studio_service imports nothing from this
            # module, but keeping it local avoids any future import cycle.
            from app.services.template_studio_service import TemplateStudioService

            pinned_version = await TemplateStudioService(self.db).pin_published_version(
                req.template_id, user
            )
        template_version_id = pinned_version.id if pinned_version else None

        public_id = await self.doc_repo.generate_public_id(org_id)
        status = DocumentStatus.SUBMITTED if req.submit_immediately else DocumentStatus.DRAFT
        submitted_at = utcnow() if req.submit_immediately else None

        doc = await self.doc_repo.create(
            org_id=org_id,
            doc_type_id=req.doc_type_id,
            public_id=public_id,
            title=req.title,
            status=status,
            priority=req.priority,
            tags=req.tags,
            form_data=req.form_data,
            metadata_=req.metadata_,
            dept_id=req.dept_id,
            due_at=req.due_at,
            submitted_by=submitted_by,
            submitted_at=submitted_at,
            submitter_snapshot={"form_data": req.form_data, "title": req.title} if req.submit_immediately else None,
            source=req.source or "template",
            confidentiality=req.confidentiality,
            current_step=req.current_step,
            template_version_id=template_version_id,
        )
        await self.db.flush()

        # Seed the body from the pinned template version so Form Fill opens on
        # the real document immediately (FR-12.2 "left = live document").
        if pinned_version is not None:
            content_row = await self._get_or_create_content(doc.id)
            content_row.content = pinned_version.content or {}
            content_row.answers = {}

        # Record version 1
        await self.ver_repo.create(
            document_id=doc.id,
            version_num=1,
            title=req.title,
            form_data=req.form_data,
            changed_by=submitted_by,
            change_reason="Initial creation" if not req.submit_immediately else "Submitted document",
        )

        await self.db.commit()
        logger.info("document_created", org_id=str(org_id), doc_id=str(doc.id), public_id=public_id)

        # Re-fetch with relationships
        doc_loaded = await self.doc_repo.get_by_id(doc.id, org_id)
        resp = await self._format_doc_response(doc_loaded)  # type: ignore[arg-type]
        
        if req.submit_immediately:
            EventBus.publish("document.submitted", {"doc_id": str(doc.id), "org_id": str(org_id), "user_id": str(submitted_by)})
            
        return resp

    async def create_from_template(
        self,
        user: AuthUser,
        template_id: UUID,
        req: DocumentCreateRequest,
    ) -> DocumentResponse:
        from sqlalchemy import select
        result = await self.db.execute(
            select(DocumentTemplate).where(
                DocumentTemplate.id == template_id,
                DocumentTemplate.org_id == user.org_id
            )
        )
        template = result.scalar_one_or_none()
        if not template:
            raise NotFoundException("Template not found")
        
        # Merge template default values with provided form data
        merged_form_data = {**template.default_field_values, **req.form_data}
        req.form_data = merged_form_data
        
        return await self.create_document(user.org_id, user.id, req)

    async def update_document(
        self,
        doc_id: UUID,
        user: AuthUser,
        req: DocumentUpdateRequest,
        expected_version: int | None = None,
    ) -> DocumentResponse:
        """
        Update / autosave a document.

        `expected_version` comes from the client's `If-Match` header and marks an
        autosave call (spec §24). When supplied it enables optimistic locking
        (409 VERSION_CONFLICT on a stale value) and lenient behaviour per
        FR-14.4: partial/invalid draft data is accepted and version snapshots are
        throttled to at most one every 5 minutes (§24.4). Manual saves (no
        If-Match) keep the original strict-validate + always-snapshot behaviour.
        """
        from datetime import timedelta

        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to edit this document")
        # FR-13.8: a submitted document is immutable. Without this the body was
        # locked by save_content but the title/form_data/tags were not.
        _require_editable(doc)

        is_autosave = expected_version is not None

        # Optimistic locking: reject a save built on a stale version (§24.1).
        if is_autosave and doc.version != expected_version:
            raise ConflictException(
                f"VERSION_CONFLICT: this draft was changed elsewhere "
                f"(your version {expected_version}, current {doc.version})."
            )

        dt = doc.doc_type
        # FR-14.4: autosave accepts partial/invalid data; validate on manual save.
        if req.form_data is not None and dt and dt.form_schema and not is_autosave:
            validate_form_data(dt.form_schema, req.form_data)

        # ── Submission details (FR-13.4) ──────────────────────────────────
        clear = {name for name in (req.clear_fields or ()) if name in _CLEARABLE_DETAILS}

        # Resolve what the dates WILL be, so the ordering check sees the final
        # state rather than only the fields this request happened to touch.
        eff = None if "effective_from" in clear else (req.effective_from or doc.effective_from)
        exp = None if "expires_at" in clear else (req.expires_at or doc.expires_at)
        if eff and exp and exp <= eff:
            # Checked even on autosave: FR-14.4's leniency is about half-typed
            # answers, and a date range that runs backwards is not a partial
            # value — saving it would put a document on the reminder sweep with
            # an expiry it already passed.
            raise ValidationException(
                "The expiry date must be after the date the document takes effect."
            )

        # A reminder needs something to count back from.
        reminder = (
            None if "reminder_days_before" in clear
            else (req.reminder_days_before if req.reminder_days_before is not None
                  else doc.reminder_days_before)
        )
        if reminder is not None and exp is None:
            raise ValidationException(
                "Set an expiry date before choosing when to be reminded."
            )

        # Re-arm the reminder whenever the thing it is based on moves.
        # Without this, changing an expiry date after a reminder had already
        # gone out would mean the new date was never announced.
        if (
            doc.reminder_sent_at is not None
            and (exp != doc.expires_at or reminder != doc.reminder_days_before)
        ):
            clear = clear | {"reminder_sent_at"}

        # Update document (always bump the optimistic-lock counter).
        doc = await self.doc_repo.update(
            doc,
            title=req.title,
            priority=req.priority,
            tags=req.tags,
            form_data=req.form_data,
            metadata_=req.metadata_,
            dept_id=req.dept_id,
            due_at=req.due_at,
            confidentiality=req.confidentiality,
            current_step=req.current_step,
            version=doc.version + 1,
            category=req.category,
            effective_from=req.effective_from,
            expires_at=req.expires_at,
            reminder_days_before=req.reminder_days_before,
            clear=clear,
        )

        # Record a version snapshot when content changed. Autosave snapshots are
        # throttled (§24.4); manual saves always snapshot.
        make_snapshot = req.title is not None or req.form_data is not None
        if make_snapshot and is_autosave:
            last_at = await self.ver_repo.get_latest_created_at(doc.id)
            if last_at is not None and (utcnow() - last_at) < timedelta(minutes=5):
                make_snapshot = False

        if make_snapshot:
            latest_num = await self.ver_repo.get_latest_version_num(doc.id)
            await self.ver_repo.create(
                document_id=doc.id,
                version_num=latest_num + 1,
                title=doc.title,
                form_data=doc.form_data,
                changed_by=user.id,
                change_reason=req.change_reason or "Document updated",
            )
            EventBus.publish("document.version_uploaded", {"doc_id": str(doc.id), "org_id": str(user.org_id), "user_id": str(user.id), "version": latest_num + 1})

        await self.db.commit()
        return await self._format_doc_response(doc)

    @staticmethod
    def _dispatch_pdf_render(doc_id: UUID) -> None:
        """
        Hand the render to Celery. A broker that is down must not fail or undo
        a submission — the document is already safely submitted and the PDF
        stays 'pending' until the retry endpoint or a later task picks it up.
        """
        try:
            from app.workers.pdf_tasks import render_submission_pdf

            render_submission_pdf.delay(str(doc_id))
        except Exception as exc:  # noqa: BLE001
            logger.warning("pdf_render_dispatch_failed", doc_id=str(doc_id), error=str(exc))

    async def export_document(
        self, doc_id: UUID, user: AuthUser, fmt: str
    ) -> tuple[bytes, str, str]:
        """
        FR-6.7 — export a document as PDF or DOCX.

        Returns (bytes, media type, filename).

        Which content is exported depends on the document's state, and that
        distinction matters: a SUBMITTED document exports its frozen snapshot,
        so the file matches what approvers saw. A DRAFT exports the live body,
        because that is the only version that exists.
        """
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")

        snapshot = doc.submitter_snapshot
        from_snapshot = (
            doc.status not in EDITABLE_STATUSES
            and isinstance(snapshot, dict)
            and bool(snapshot.get("schema"))
        )
        if from_snapshot:
            content = snapshot.get("content") or {}
            answers = snapshot.get("answers") or {}
        else:
            row = await self._get_content_row(doc_id)
            content = (row.content or {}) if row else {}
            answers = (row.answers or {}) if row else {}

        images = await self._export_images(doc.org_id, content)
        safe_name = re.sub(r"[^\w\-. ]+", "", doc.title or "document").strip() or "document"
        reference = doc.public_id or ""

        if fmt == "docx":
            from app.services.docx_renderer import DocxRenderError, render_docx

            try:
                rendered = render_docx(
                    content, answers=answers, image_resolver=images.get,
                    title=doc.title, reference=reference,
                )
            except DocxRenderError as exc:
                raise ValidationException(str(exc)) from exc
            return (
                rendered.data,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                f"{safe_name}.docx",
            )

        from app.services.pdf_renderer import PDFRenderError, PageFurniture, render_document

        try:
            rendered = render_document(
                content,
                answers=answers,
                furniture=PageFurniture(
                    header_left=(doc.title or "")[:80],
                    header_right=reference,
                    footer_left="" if from_snapshot else "Draft",
                    footer_right="Page {page} of {pages}",
                    # A draft must not be mistaken for the submitted article.
                    watermark="" if from_snapshot else "DRAFT",
                ),
                image_resolver=images.get,
                title=doc.title,
                created=str(snapshot.get("submitted_at")) if from_snapshot else None,
            )
        except PDFRenderError as exc:
            raise ValidationException(str(exc)) from exc
        return rendered.data, "application/pdf", f"{safe_name}.pdf"

    async def _export_images(self, org_id: UUID, content) -> dict[str, bytes]:
        """Prefetch embedded images, org-scoped, for a synchronous renderer."""
        from app.workers.pdf_tasks import _prefetch_images

        return await _prefetch_images(self.db, org_id, content)

    async def get_pdf_state(self, doc_id: UUID, user: AuthUser) -> dict:
        """Render state plus a download URL when it is ready (FR-13.8)."""
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")

        state = await read_pdf_state(self.db, doc_id)
        download_url = None
        if state.get("status") == "ready" and state.get("storage_key"):
            from app.core.storage import generate_presigned_download_url

            download_url = generate_presigned_download_url(
                bucket=settings.S3_BUCKET_DOCUMENTS,
                storage_key=state["storage_key"],
                filename=f"{doc.public_id or 'document'}.pdf",
            )
        return {
            "status": state.get("status"),
            "checksum": state.get("checksum"),
            "rendered_at": state.get("rendered_at"),
            "error": state.get("error"),
            "download_url": download_url,
            # False when the migration has not been applied, so the UI can
            # stay quiet instead of showing a broken control.
            "available": state.get("available", True),
            "has_snapshot": isinstance(doc.submitter_snapshot, dict)
            and bool(doc.submitter_snapshot.get("schema")),
        }

    async def retry_pdf_render(self, doc_id: UUID, user: AuthUser) -> dict:
        """Re-queue a failed render (FR-13.8 Retry)."""
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to edit this document")
        if not isinstance(doc.submitter_snapshot, dict) or not doc.submitter_snapshot.get("schema"):
            raise ValidationException(
                "This document hasn't been submitted, so there is no snapshot to render."
            )
        if not await mark_pdf_pending(self.db, doc_id):
            raise ValidationException("PDF rendering isn't available on this deployment yet.")
        await self.db.commit()
        self._dispatch_pdf_render(doc_id)
        return await self.get_pdf_state(doc_id, user)

    async def check_submission(
        self,
        doc_id: UUID,
        user: AuthUser,
        stage: str = "confirm",
        workflow_template_id: UUID | None = None,
    ) -> dict:
        """
        Pre-flight for the wizard: the same checks `submit_document` runs,
        without submitting. Lets a Continue button block with the real answer
        instead of the client's guess at it.
        """
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")

        errors, warnings = await validate_document(
            self.db, doc=doc, submitter_id=user.id,
            stage=stage, workflow_template_id=workflow_template_id,
        )
        return {
            "ok": not errors,
            "errors": [e.as_dict() for e in errors],
            "warnings": [w.as_dict() for w in warnings],
        }

    async def _pinned_page_settings(self, doc) -> dict:
        """
        Page size and orientation from the template version this document is
        pinned to. Empty for a document with no template.
        """
        if not doc.template_version_id:
            return {}
        from sqlalchemy import select
        from app.models.template import TemplateVersion

        settings = (await self.db.execute(
            select(TemplateVersion.page_settings)
            .where(TemplateVersion.id == doc.template_version_id)
        )).scalar_one_or_none()
        return settings or {}

    async def submit_document(
        self,
        doc_id: UUID,
        user: AuthUser,
        req: DocumentSubmitRequest,
        idempotency_key: str | None = None,
    ) -> DocumentResponse:
        """
        Atomically submit a document AND start its approval workflow.

        Transaction:
        1. Validate doc is DRAFT + user has access
        2. Validate form_data
        3. Create version snapshot
        4. Set doc.status = SUBMITTED
        5. Resolve workflow_template_id (from request or doc_type default)
        6. Call WorkflowService.start_workflow() → sets doc.status = PENDING,
           creates WorkflowInstance + Stage-1 ApprovalStep rows, notifies approvers
        7. Single commit
        8. Fire EventBus.publish (after commit — no partial events)
        """
        from app.services.workflow_service import WorkflowService

        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to submit this document")

        # FR-13.7 idempotent submit: a retry carrying the same Idempotency-Key
        # returns the current document instead of erroring, so a double-click or
        # a network retry can never create a second submission. Checked BEFORE
        # the DRAFT guard — by then the first call has already left DRAFT.
        idem_key = f"idem:submit:{doc_id}:{idempotency_key}" if idempotency_key else None
        if idem_key and await cache_get(idem_key):
            logger.info("document_submit_idempotent_replay", doc_id=str(doc_id))
            return await self._format_doc_response(doc)

        if doc.status != DocumentStatus.DRAFT:
            raise ConflictException(f"Only draft documents can be submitted (current status: {doc.status})")

        # Resolve workflow_template_id. NOTE: DocumentType has no
        # "default per doc type" column today, so this must always be
        # supplied explicitly by the caller — see PENDING_WORK.md if a
        # default-template-per-doc-type feature is wanted (needs a migration).
        template_id = req.workflow_template_id
        if template_id is None:
            raise UnprocessableEntityException(
                "No workflow template specified. Provide workflow_template_id in the request body."
            )

        dt = doc.doc_type
        if dt and dt.form_schema:
            validate_form_data(dt.form_schema, doc.form_data)

        # FR-13.7 / §25.4 — everything the wizard checked, checked again here.
        # The wizard's own pre-flight can be stale (a workflow deactivated, an
        # attachment removed, a template unpublished since) and can be skipped
        # entirely by calling this endpoint directly, so this is the check that
        # decides. Field codes come back so the UI can point at what to fix.
        errors, _warnings = await validate_document(
            self.db, doc=doc, submitter_id=user.id,
            stage="confirm", workflow_template_id=template_id,
        )
        if errors:
            raise FieldValidationException(errors)

        now = utcnow()
        doc = await self.doc_repo.update(
            doc,
            status=DocumentStatus.SUBMITTED,
            submitted_at=now,
        )
        # FR-13.8 — immutable snapshot of EXACTLY what was submitted.
        #
        # The previous snapshot held only form_data + title, which misses the
        # whole document for TEMPLATE/BLANK/UPLOAD sources, where the real
        # content lives in DocumentContent. Approvers must be able to prove
        # what they approved, so the body, the answers and the pinned template
        # version are frozen here too, with a checksum over the payload so a
        # later tampering of the JSONB is detectable.
        content_row = await self._get_content_row(doc.id)
        snapshot: dict = {
            "schema": 1,
            "title": doc.title,
            "form_data": doc.form_data,
            "source": doc.source,
            "template_version_id": str(doc.template_version_id) if doc.template_version_id else None,
            "content": (content_row.content or {}) if content_row else {},
            "answers": (content_row.answers or {}) if content_row else {},
            # FR-6.1 Layout tab. Frozen with the rest of the submission so a
            # PDF rendered later uses the page the author chose, and so that
            # changing the template afterwards cannot alter what the stored
            # checksum covers. Absent for blank and uploaded documents, which
            # render A4 portrait.
            "page_settings": await self._pinned_page_settings(doc),
            "submitted_at": now.isoformat(),
            "submitted_by": str(user.id),
        }
        snapshot["checksum"] = _snapshot_checksum(snapshot)
        doc.submitter_snapshot = snapshot

        # Create version snapshot (flush only — no commit yet)
        latest_num = await self.ver_repo.get_latest_version_num(doc.id)
        new_ver = await self.ver_repo.create(
            document_id=doc.id,
            version_num=latest_num + 1,
            title=doc.title,
            form_data=doc.form_data,
            changed_by=user.id,
            change_reason=req.change_reason or "Submitted document",
        )
        # Set current_version_id so WorkflowService can FK to it
        doc.current_version_id = new_ver.id
        await self.db.flush()

        # Start workflow in the same transaction (no commit inside start_workflow)
        wf_svc = WorkflowService(self.db)
        await wf_svc.start_workflow(
            org_id=user.org_id,
            document_id=doc.id,
            template_id=template_id,
            requester_id=user.id,
            current_version_id=new_ver.id,
            doc_title=doc.title,
        )

        # FR-13.8: queue the snapshot PDF. Flagged pending INSIDE the same
        # transaction so the UI never sees a submitted document with no PDF
        # state at all; the task itself is dispatched after the commit, so a
        # broker outage cannot roll back a successful submission.
        pdf_queued = await mark_pdf_pending(self.db, doc.id)

        # Single commit for everything above
        await self.db.commit()
        logger.info("document_submitted", doc_id=str(doc_id))

        if pdf_queued:
            self._dispatch_pdf_render(doc.id)

        # Record the idempotency key only after the submission really committed.
        if idem_key:
            await cache_set(idem_key, {"doc_id": str(doc.id)}, ttl_seconds=86_400)

        # EventBus fires after successful commit only
        EventBus.publish("document.submitted", {
            "doc_id": str(doc.id),
            "org_id": str(user.org_id),
            "user_id": str(user.id),
        })
        # Confirmation to the submitter that their submission went through —
        # distinct from the approver-assignment notifications start_workflow()
        # already sent above. Without notif_user_id here, subscribers.py's
        # handler no-ops (it's informational-only for call-sites that don't
        # name a recipient), so the submitter never heard back at all.
        EventBus.publish("document.status_changed", {
            "doc_id": str(doc.id),
            "org_id": str(user.org_id),
            "new_status": DocumentStatus.PENDING,
            "event": "workflow_started",
            "notif_user_id": str(user.id),
            "notif_type": NotificationType.SYSTEM,
            "notif_title": "Document submitted",
            "notif_body": f"'{doc.title}' was submitted successfully and is now awaiting approval.",
            "notif_deep_link": f"/documents/{doc.id}",
        })
        # CC the watchers (FR-13.4). After the commit and after the submitter's
        # own confirmation, because a watcher notification must never be able
        # to affect whether the submission itself succeeded.
        await self.notify_watchers(
            doc,
            type=NotificationType.DOCUMENT_SUBMITTED,
            title="A document you follow was submitted",
            body=f"'{doc.title}' was submitted for approval.",
        )
        return await self._format_doc_response(doc)


    async def get_document_for_copy(self, doc_id: UUID, user: AuthUser):
        """
        Authorise a document and hand back (document, body content) for
        "Save as template" (FR-5.4). Read-only; the template side owns the rest.
        """
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")
        row = await self._get_or_create_content(doc_id)
        await self.db.commit()
        return doc, (row.content or {})

    # ── Form Fill: the document's PINNED template version (FR-12.x / C9) ──────

    async def get_fill_schema(self, doc_id: UUID, user: AuthUser) -> DocumentFillSchemaResponse:
        """
        The questions this document must answer, read from the version it was
        pinned to at creation — not from the template's current state. Editing,
        archiving or deleting the template afterwards changes nothing here.
        """
        from app.services.template_studio_service import TemplateStudioService

        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")

        row = await self._get_or_create_content(doc_id)
        await self.db.commit()

        if not doc.template_version_id:
            # Blank and uploaded documents have no questions (FR-13.9).
            return DocumentFillSchemaResponse(
                document_id=doc_id, content=row.content or {}, answers=row.answers or {}
            )

        template, version, fields = await TemplateStudioService(self.db).pinned_fill_data(
            doc.template_version_id
        )
        return DocumentFillSchemaResponse(
            document_id=doc_id,
            template_id=template.id if template else None,
            template_version_id=doc.template_version_id,
            template_name=template.name if template else None,
            version_no=version.version_no if version else None,
            # The live body wins: it already holds the user's answers in place.
            content=row.content or (version.content if version else {}) or {},
            fields=[
                DocumentFillFieldSchema(
                    key=f.key, label=f.label, type=f.type, required=f.required,
                    help_text=f.help_text, example=f.example, default_value=f.default_value,
                    validation=f.validation or {}, format=f.format, options=f.options or [],
                    if_empty_behavior=f.if_empty_behavior, order_index=f.order_index,
                    section=f.section,
                )
                for f in fields
            ],
            answers=row.answers or {},
            template_deleted=template is not None and template.deleted_at is not None,
        )

    # ── Document body (spec §9 DocumentContent) ───────────────────────────────

    async def _get_content_row(self, doc_id: UUID):
        """Read the body row without creating one — used when snapshotting."""
        from sqlalchemy import select
        from app.models.document import DocumentContent

        result = await self.db.execute(
            select(DocumentContent).where(DocumentContent.document_id == doc_id)
        )
        return result.scalar_one_or_none()

    async def _get_or_create_content(self, doc_id: UUID):
        from sqlalchemy import select
        from app.models.document import DocumentContent

        result = await self.db.execute(
            select(DocumentContent).where(DocumentContent.document_id == doc_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            row = DocumentContent(document_id=doc_id, content={}, answers={})
            self.db.add(row)
            await self.db.flush()
        return row

    async def get_content(self, doc_id: UUID, user: AuthUser) -> DocumentContentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")

        row = await self._get_or_create_content(doc_id)
        await self.db.commit()

        # FR-13.8: once locked, serve the frozen submission, not the live row.
        # Writes are already blocked, so the two agree — reading the snapshot
        # makes that a guarantee rather than a coincidence, and means a
        # reviewer always sees what the submitter actually sent.
        snap = doc.submitter_snapshot if doc.status not in EDITABLE_STATUSES else None
        if isinstance(snap, dict) and snap.get("schema"):
            return DocumentContentResponse(
                document_id=doc_id,
                content=snap.get("content") or {},
                answers=snap.get("answers") or {},
                rendered_snapshot_url=row.rendered_snapshot_url,
                pdf_url=row.pdf_url,
                updated_at=row.updated_at,
            )

        return DocumentContentResponse(
            document_id=doc_id,
            content=row.content or {},
            answers=row.answers or {},
            rendered_snapshot_url=row.rendered_snapshot_url,
            pdf_url=row.pdf_url,
            updated_at=row.updated_at,
        )

    async def save_content(
        self, doc_id: UUID, user: AuthUser, req: DocumentContentUpdateRequest
    ) -> DocumentContentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to edit this document")
        # FR-13.8. SENT_BACK stays editable: the approver asked for changes.
        _require_editable(doc)

        row = await self._get_or_create_content(doc_id)
        if req.content is not None:
            # Untrusted rich text — allow-list the node/mark tree before it is
            # stored and rendered back into anyone's DOM (spec §12 Security).
            try:
                row.content = sanitize_editor_content(req.content)
            except ContentTooLargeError as exc:
                raise ValidationException(str(exc)) from exc
            # Keep the FTS text column in step with the body.
            doc.content_text = content_to_text(row.content) or None
        if req.answers is not None:
            if not isinstance(req.answers, dict):
                raise ValidationException("answers must be an object keyed by field key")
            row.answers = req.answers
        # Keep the optimistic-lock counter moving so the list shows fresh activity.
        doc.version = (doc.version or 1) + 1
        await self.db.commit()
        return DocumentContentResponse(
            document_id=doc_id,
            content=row.content or {},
            answers=row.answers or {},
            rendered_snapshot_url=row.rendered_snapshot_url,
            pdf_url=row.pdf_url,
            updated_at=row.updated_at,
        )

    async def delete_document(self, doc_id: UUID, user: AuthUser) -> None:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to delete this document")
        await self.doc_repo.soft_delete(doc)
        await self.db.commit()
        logger.info("document_deleted", doc_id=str(doc_id))

    async def list_versions(self, doc_id: UUID, user: AuthUser) -> list[DocumentVersionResponse]:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")

        versions = await self.ver_repo.list_by_doc(doc_id)
        result = []
        for ver in versions:
            user = await self.user_repo.get_by_id(ver.changed_by)
            result.append(
                DocumentVersionResponse(
                    id=ver.id,
                    document_id=ver.document_id,
                    version_num=ver.version_num,
                    title=ver.title,
                    form_data=ver.form_data or {},
                    changed_by=ver.changed_by,
                    changer_name=user.name if user else None,
                    change_reason=ver.change_reason,
                    created_at=ver.created_at,
                )
            )
        return result

    async def restore_version(self, doc_id: UUID, version_id: UUID, user: AuthUser) -> DocumentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to edit this document")
            
        from sqlalchemy import select
        res = await self.db.execute(select(DocumentVersion).where(DocumentVersion.id == version_id, DocumentVersion.document_id == doc_id))
        ver = res.scalar_one_or_none()
        if not ver:
            raise NotFoundException("Version not found")
            
        # Create new version duplicating the old one
        latest_num = await self.ver_repo.get_latest_version_num(doc.id)
        await self.ver_repo.create(
            document_id=doc.id,
            version_num=latest_num + 1,
            title=ver.title,
            form_data=ver.form_data,
            changed_by=user.id,
            change_reason=f"Restored from version {ver.version_num}",
        )
        
        doc = await self.doc_repo.update(
            doc,
            title=ver.title,
            form_data=ver.form_data,
        )
        await self.db.commit()
        EventBus.publish("document.version_uploaded", {"doc_id": str(doc.id), "org_id": str(user.org_id), "user_id": str(user.id), "version": latest_num + 1})
        return await self._format_doc_response(doc)

    async def list_comments(self, doc_id: UUID, user: AuthUser) -> list[CommentResponse]:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view comments on this document")

        all_comments = await self.comment_repo.list_by_doc(doc_id)

        # Cache user info
        user_ids = {c.author_id for c in all_comments}
        for c in all_comments:
            for m in c.mentions:
                user_ids.add(m.user_id)
        users_map = {}
        for uid in user_ids:
            u = await self.user_repo.get_by_id(uid)
            if u:
                users_map[uid] = u

        def _to_resp(c: Any) -> CommentResponse:
            u = users_map.get(c.author_id)
            m_resps = [
                MentionResponse(
                    user_id=m.user_id,
                    user_name=users_map[m.user_id].name if m.user_id in users_map else None,
                )
                for m in c.mentions
            ]
            return CommentResponse(
                id=c.id,
                document_id=c.document_id,
                parent_id=c.parent_id,
                body=c.body,
                author_id=c.author_id,
                author_name=u.name if u else "Unknown",
                author_email=u.email if u else None,
                author_avatar=u.avatar_url if u else None,
                is_internal=c.is_internal,
                resolved_at=c.resolved_at,
                created_at=c.created_at,
                updated_at=c.updated_at,
                replies=[],
                mentions=m_resps,
            )

        comment_map: dict[str, CommentResponse] = {}
        roots: list[CommentResponse] = []
        for c in all_comments:
            resp = _to_resp(c)
            comment_map[str(c.id)] = resp

        for c in all_comments:
            resp = comment_map[str(c.id)]
            if c.parent_id and str(c.parent_id) in comment_map:
                comment_map[str(c.parent_id)].replies.append(resp)
            else:
                roots.append(resp)

        return roots

    async def add_comment(
        self,
        doc_id: UUID,
        user: AuthUser,
        req: CommentCreateRequest,
    ) -> CommentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to comment on this document")

        if req.parent_id:
            parent = await self.comment_repo.get_by_id(req.parent_id, user.org_id)
            if not parent:
                raise NotFoundException("Parent comment not found")

        com = await self.comment_repo.create(
            org_id=user.org_id,
            document_id=doc_id,
            body=req.body,
            author_id=user.id,
            parent_id=req.parent_id,
            is_internal=req.is_internal,
        )

        if req.mention_user_ids:
            await self.comment_repo.add_mentions(com.id, req.mention_user_ids)

        await self.db.commit()
        logger.info("comment_added", doc_id=str(doc_id), comment_id=str(com.id))
        EventBus.publish("document.comment_added", {"doc_id": str(doc.id), "org_id": str(user.org_id), "user_id": str(user.id), "comment_id": str(com.id)})

        u = await self.user_repo.get_by_id(user.id)
        return CommentResponse(
            id=com.id,
            document_id=com.document_id,
            parent_id=com.parent_id,
            body=com.body,
            author_id=com.author_id,
            author_name=u.name if u else "Unknown",
            author_email=u.email if u else None,
            author_avatar=u.avatar_url if u else None,
            is_internal=com.is_internal,
            resolved_at=com.resolved_at,
            created_at=com.created_at,
            updated_at=com.updated_at,
            replies=[],
            mentions=[],
        )

    async def update_comment(
        self,
        comment_id: UUID,
        doc_id: UUID,
        user: AuthUser,
        req: CommentUpdateRequest,
    ) -> CommentResponse:
        com = await self.comment_repo.get_by_id(comment_id, user.org_id)
        if not com or com.document_id != doc_id:
            raise NotFoundException("Comment not found")
        if com.author_id != user.id:
            raise ForbiddenException("You can only edit your own comments")

        com = await self.comment_repo.update(com, body=req.body, is_resolved=req.is_resolved)
        await self.db.commit()

        u = await self.user_repo.get_by_id(com.author_id)
        return CommentResponse(
            id=com.id,
            document_id=com.document_id,
            parent_id=com.parent_id,
            body=com.body,
            author_id=com.author_id,
            author_name=u.name if u else "Unknown",
            author_email=u.email if u else None,
            author_avatar=u.avatar_url if u else None,
            is_internal=com.is_internal,
            resolved_at=com.resolved_at,
            created_at=com.created_at,
            updated_at=com.updated_at,
            replies=[],
            mentions=[],
        )

    async def list_attachments(self, doc_id: UUID, user: AuthUser) -> list[AttachmentResponse]:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document's attachments")

        atts = await self.att_repo.list_by_doc(doc_id)
        result = []
        for att in atts:
            user = await self.user_repo.get_by_id(att.attached_by)
            f = att.file_asset
            result.append(
                AttachmentResponse(
                    id=att.id,
                    document_id=att.document_id,
                    file_asset_id=att.file_asset_id,
                    label=att.label,
                    attached_by=att.attached_by,
                    attacher_name=user.name if user else None,
                    filename=f.filename if f else "Unknown File",
                    mime_type=f.mime_type if f else "application/octet-stream",
                    size_bytes=f.size_bytes if f else 0,
                    preview_url=f.preview_url if f else None,
                    created_at=att.created_at,
                )
            )
        return result

    async def add_attachment(
        self,
        doc_id: UUID,
        user: AuthUser,
        file_asset_id: UUID,
        label: str | None = None,
    ) -> AttachmentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to add attachments to this document")
            
        # Update FileAsset doc_id
        from app.models.document import FileAsset
        from sqlalchemy import select
        res = await self.db.execute(select(FileAsset).where(FileAsset.id == file_asset_id, FileAsset.org_id == user.org_id))
        asset = res.scalar_one_or_none()
        if not asset:
            raise NotFoundException("FileAsset not found")
        asset.document_id = doc_id

        att = await self.att_repo.create(
            document_id=doc_id,
            file_asset_id=file_asset_id,
            label=label,
            attached_by=user.id,
        )
        await self.db.commit()

        u = await self.user_repo.get_by_id(user.id)
        # NOTE: att.file_asset is lazy="noload" and att_repo.create() doesn't
        # eager-load it, so it would be None here. Use `asset` (already fetched
        # above, with real data) instead of re-reading the unset relationship —
        # otherwise the response right after a successful attach would show
        # "Attached File" / 0 bytes until the next GET /attachments refetch.
        return AttachmentResponse(
            id=att.id,
            document_id=att.document_id,
            file_asset_id=att.file_asset_id,
            label=att.label,
            attached_by=att.attached_by,
            attacher_name=u.name if u else None,
            filename=asset.filename,
            mime_type=asset.mime_type,
            size_bytes=asset.size_bytes,
            preview_url=asset.preview_url,
            created_at=att.created_at,
        )

    async def remove_attachment(self, att_id: UUID, doc_id: UUID, org_id: UUID) -> None:
        att = await self.att_repo.get_by_id(att_id)
        if not att or att.document_id != doc_id:
            raise NotFoundException("Attachment not found")
        await self.att_repo.soft_delete(att)
        await self.db.commit()

    # ── Watchers / CC (spec FR-13.4) ──────────────────────────────────────────
    #
    # A watcher receives the document's notifications and nothing else: no
    # approval step, no ability to act. The workflow engine never reads this
    # table, so a watcher cannot be mistaken for an approver.
    #
    # Being a watcher does NOT grant access. `can_user_access_document` is
    # unchanged, so CC-ing someone who could not already open the document
    # gives them a notification whose link they still cannot follow. That is
    # the safe direction to fail, and the UI says so.

    async def _watched_doc(self, doc_id: UUID, user: AuthUser) -> Document:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this document")
        return doc

    async def list_watchers(self, doc_id: UUID, user: AuthUser) -> list[WatcherResponse]:
        await self._watched_doc(doc_id, user)
        rows = await self.watcher_repo.list_by_doc(doc_id)
        return [
            WatcherResponse(
                id=w.id,
                user_id=w.user_id,
                name=u.name if u else None,
                email=u.email if u else None,
                added_by=w.added_by,
                added_by_name=adder.name if adder else None,
                created_at=w.created_at,
            )
            for w, u, adder in rows
        ]

    async def add_watcher(
        self, doc_id: UUID, user: AuthUser, watcher_user_id: UUID
    ) -> WatcherResponse:
        doc = await self._watched_doc(doc_id, user)
        # Only the owner (or an admin, via can_user_access_document plus the
        # ownership test below) decides who is CC'd. Without this an approver
        # who can merely READ the document could add watchers to it.
        is_admin = "admin" in user.roles or "hr" in user.roles
        if doc.submitted_by != user.id and not is_admin:
            raise ForbiddenException("Only the document's owner can change its watchers")

        target = await self.user_repo.get_by_id(watcher_user_id)
        if not target or target.deleted_at is not None:
            raise NotFoundException("User not found")

        # Org check before anything else: an id from another organisation must
        # look like it does not exist, not like a permission problem (FR-5.2).
        # A `users` row carries no org_id -- membership is a separate table --
        # so this is a real query, and only an ACTIVE membership counts.
        from sqlalchemy import select as _select
        member = await self.db.execute(
            _select(OrganizationMember.id).where(
                OrganizationMember.org_id == user.org_id,
                OrganizationMember.user_id == watcher_user_id,
                OrganizationMember.status == "active",
                OrganizationMember.deleted_at.is_(None),
            )
        )
        if member.scalar_one_or_none() is None:
            raise NotFoundException("User not found")
        if not target.is_active:
            raise ValidationException("That account is deactivated.")
        if target.id == doc.submitted_by:
            raise ValidationException(
                "The document's owner already gets every notification."
            )

        row = await self.watcher_repo.add(doc_id, watcher_user_id, user.id)
        self.db.add(
            AuditLog(
                org_id=user.org_id,
                actor_id=user.id,
                action="document.watcher_added",
                resource_type="Document",
                resource_id=doc_id,
                after={"user_id": str(watcher_user_id)},
            )
        )
        await self.db.commit()

        adder = await self.user_repo.get_by_id(user.id)
        return WatcherResponse(
            id=row.id,
            user_id=row.user_id,
            name=target.name,
            email=target.email,
            added_by=row.added_by,
            added_by_name=adder.name if adder else None,
            created_at=row.created_at,
        )

    async def remove_watcher(
        self, doc_id: UUID, user: AuthUser, watcher_user_id: UUID
    ) -> None:
        doc = await self._watched_doc(doc_id, user)
        is_admin = "admin" in user.roles or "hr" in user.roles
        # Someone may always take themselves off a document they are CC'd on.
        if doc.submitted_by != user.id and not is_admin and watcher_user_id != user.id:
            raise ForbiddenException("Only the document's owner can change its watchers")

        row = await self.watcher_repo.get(doc_id, watcher_user_id)
        if not row or row.deleted_at is not None:
            raise NotFoundException("Watcher not found")
        await self.watcher_repo.soft_delete(row)
        self.db.add(
            AuditLog(
                org_id=user.org_id,
                actor_id=user.id,
                action="document.watcher_removed",
                resource_type="Document",
                resource_id=doc_id,
                after={"user_id": str(watcher_user_id)},
            )
        )
        await self.db.commit()

    async def watcher_candidates(
        self, doc_id: UUID, user: AuthUser, search: str | None, limit: int = 20
    ) -> list[WatcherCandidateResponse]:
        await self._watched_doc(doc_id, user)
        users = await self.watcher_repo.candidates(
            user.org_id, doc_id, search, limit=limit
        )
        return [
            WatcherCandidateResponse(user_id=u.id, name=u.name, email=u.email)
            for u in users
            if u.id != user.id
        ]

    async def notify_watchers(
        self,
        doc: Document,
        type: str,
        title: str,
        body: str,
    ) -> None:
        """
        Fan a document event out to its watchers.

        Deliberately separate from the owner/approver notifications rather than
        folded into them: the approval chain's own notify calls are load-bearing
        and a watcher list that failed to load must never stop an approval being
        announced. Hence the try/except — a CC is strictly additive.
        """
        try:
            watcher_ids = await self.watcher_repo.user_ids_for_doc(doc.id)
            watcher_ids = [uid for uid in watcher_ids if uid != doc.submitted_by]
            if not watcher_ids:
                return
            notif = NotificationService(self.db)
            await notif.notify_many(
                org_id=doc.org_id,
                user_ids=watcher_ids,
                type=type,
                title=title,
                body=body,
                deep_link=f"/documents/{doc.id}",
            )
        except Exception:
            logger.warning("watcher_notify_failed", doc_id=str(doc.id), exc_info=True)
