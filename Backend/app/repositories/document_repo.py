"""
DocFlow Backend — Repository: Documents, Types, Versions, Comments, Attachments
Org-scoped data access layer for all document lifecycle operations.
"""
from __future__ import annotations

import datetime
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.models.base import utcnow
from app.models.document import (
    Comment,
    Document,
    DocumentAttachment,
    DocumentType,
    DocumentVersion,
    Mention,
)
from app.models.user import User


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
                Document.org_id == org_id,
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
        page: int = 1,
        limit: int = 20,
        status: str | None = None,
        doc_type_id: UUID | None = None,
        dept_id: UUID | None = None,
        submitted_by: UUID | None = None,
        search: str | None = None,
    ) -> tuple[list[Document], int]:
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

        if status:
            q = q.where(Document.status == status)
        if doc_type_id:
            q = q.where(Document.doc_type_id == doc_type_id)
        if dept_id:
            q = q.where(Document.dept_id == dept_id)
        if submitted_by:
            q = q.where(Document.submitted_by == submitted_by)
        if search:
            search_pattern = f"%{search}%"
            q = q.where(
                or_(
                    Document.title.ilike(search_pattern),
                    Document.public_id.ilike(search_pattern),
                )
            )

        # Count total
        count_q = select(func.count()).select_from(q.subquery())
        total_res = await self.db.execute(count_q)
        total = total_res.scalar_one()

        # Paginate
        q = q.order_by(Document.created_at.desc()).offset((page - 1) * limit).limit(limit)
        res = await self.db.execute(q)
        items = list(res.scalars().unique().all())

        return items, total

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
    ) -> Document:
        if title is not None:
            doc.title = title
        if priority is not None:
            doc.priority = priority
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
