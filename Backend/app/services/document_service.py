"""
DocFlow Backend — Service: Documents & Document Types
Business logic for dynamic form validation, version snapshots, threaded comments, and caching.
"""
from __future__ import annotations

import math
import structlog
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    ValidationException,
)
from app.core.redis import cache_delete, cache_get, cache_set
from app.models.base import utcnow
from app.models.document import Document, DocumentType
from app.repositories.document_repo import (
    AttachmentRepository,
    CommentRepository,
    DocumentRepository,
    DocumentTypeRepository,
    DocumentVersionRepository,
)
from app.repositories.user_repo import UserRepository
from app.schemas.document import (
    AttachmentResponse,
    CommentCreateRequest,
    CommentResponse,
    CommentUpdateRequest,
    DocumentCreateRequest,
    DocumentResponse,
    DocumentSubmitRequest,
    DocumentTypeCreateRequest,
    DocumentTypeResponse,
    DocumentTypeUpdateRequest,
    DocumentUpdateRequest,
    DocumentVersionResponse,
    FormFieldSchema,
    MentionResponse,
    PaginatedDocumentsResponse,
)

logger = structlog.get_logger(__name__)

_DOC_TYPES_CACHE_TTL = 600  # 10 minutes


def _doc_types_cache_key(org_id: UUID) -> str:
    return f"doc_types:list:{org_id}"


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

class DocumentService:
    """Document creation, form validation, version snapshots, and comments."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.doc_repo = DocumentRepository(db)
        self.type_repo = DocumentTypeRepository(db)
        self.ver_repo = DocumentVersionRepository(db)
        self.comment_repo = CommentRepository(db)
        self.att_repo = AttachmentRepository(db)
        self.user_repo = UserRepository(db)

    async def _format_doc_response(self, doc: Document) -> DocumentResponse:
        att_count, com_count, ver_count = await self.doc_repo.get_counts(doc.id)
        dt = doc.doc_type
        sub = doc.submitter

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
            form_data=doc.form_data or {},
            metadata=doc.metadata_ or {},
            submitted_by=doc.submitted_by,
            submitter_name=sub.name if sub else "Unknown",
            submitter_email=sub.email if sub else None,
            submitted_at=doc.submitted_at,
            due_at=doc.due_at,
            created_at=doc.created_at,
            updated_at=doc.updated_at,
            attachment_count=att_count,
            comment_count=com_count,
            version_count=max(ver_count, 1),
        )

    async def get_document(self, doc_id: UUID, org_id: UUID) -> DocumentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")
        return await self._format_doc_response(doc)

    async def list_documents(
        self,
        org_id: UUID,
        page: int = 1,
        limit: int = 20,
        status: str | None = None,
        doc_type_id: UUID | None = None,
        dept_id: UUID | None = None,
        submitted_by: UUID | None = None,
        search: str | None = None,
    ) -> PaginatedDocumentsResponse:
        limit = min(limit, 100)
        items_db, total = await self.doc_repo.list_by_org(
            org_id, page=page, limit=limit,
            status=status, doc_type_id=doc_type_id, dept_id=dept_id,
            submitted_by=submitted_by, search=search,
        )
        items = [await self._format_doc_response(d) for d in items_db]
        pages = math.ceil(total / limit) if limit else 1
        return PaginatedDocumentsResponse(
            items=items, total=total, page=page, limit=limit, pages=pages
        )

    async def create_document(
        self,
        org_id: UUID,
        submitted_by: UUID,
        req: DocumentCreateRequest,
    ) -> DocumentResponse:
        dt = await self.type_repo.get_by_id(req.doc_type_id, org_id)
        if not dt:
            raise NotFoundException("Document type not found")

        # Validate form_data against form_schema
        if dt.form_schema:
            validate_form_data(dt.form_schema, req.form_data)

        public_id = await self.doc_repo.generate_public_id(org_id)
        status = "submitted" if req.submit_immediately else "draft"
        submitted_at = utcnow() if req.submit_immediately else None

        doc = await self.doc_repo.create(
            org_id=org_id,
            doc_type_id=req.doc_type_id,
            public_id=public_id,
            title=req.title,
            status=status,
            priority=req.priority,
            form_data=req.form_data,
            metadata_=req.metadata_,
            dept_id=req.dept_id,
            due_at=req.due_at,
            submitted_by=submitted_by,
            submitted_at=submitted_at,
            submitter_snapshot={"form_data": req.form_data, "title": req.title} if req.submit_immediately else None,
        )
        await self.db.flush()

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
        return await self._format_doc_response(doc_loaded)  # type: ignore[arg-type]

    async def update_document(
        self,
        doc_id: UUID,
        org_id: UUID,
        user_id: UUID,
        req: DocumentUpdateRequest,
    ) -> DocumentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")

        dt = doc.doc_type
        if req.form_data is not None and dt and dt.form_schema:
            validate_form_data(dt.form_schema, req.form_data)

        # Update document
        doc = await self.doc_repo.update(
            doc,
            title=req.title,
            priority=req.priority,
            form_data=req.form_data,
            metadata_=req.metadata_,
            dept_id=req.dept_id,
            due_at=req.due_at,
        )

        # If title or form_data changed, record a new version
        if req.title is not None or req.form_data is not None:
            latest_num = await self.ver_repo.get_latest_version_num(doc.id)
            await self.ver_repo.create(
                document_id=doc.id,
                version_num=latest_num + 1,
                title=doc.title,
                form_data=doc.form_data,
                changed_by=user_id,
                change_reason=req.change_reason or "Document updated",
            )

        await self.db.commit()
        return await self._format_doc_response(doc)

    async def submit_document(
        self,
        doc_id: UUID,
        org_id: UUID,
        user_id: UUID,
        req: DocumentSubmitRequest,
    ) -> DocumentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")

        if doc.status != "draft":
            raise ConflictException(f"Only draft documents can be submitted (current status: {doc.status})")

        dt = doc.doc_type
        if dt and dt.form_schema:
            validate_form_data(dt.form_schema, doc.form_data)

        now = utcnow()
        doc = await self.doc_repo.update(
            doc,
            status="submitted",
            submitted_at=now,
        )
        doc.submitter_snapshot = {"form_data": doc.form_data, "title": doc.title, "submitted_at": now.isoformat()}

        latest_num = await self.ver_repo.get_latest_version_num(doc.id)
        await self.ver_repo.create(
            document_id=doc.id,
            version_num=latest_num + 1,
            title=doc.title,
            form_data=doc.form_data,
            changed_by=user_id,
            change_reason=req.change_reason or "Submitted document",
        )

        await self.db.commit()
        logger.info("document_submitted", doc_id=str(doc_id))
        return await self._format_doc_response(doc)

    async def delete_document(self, doc_id: UUID, org_id: UUID) -> None:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")
        await self.doc_repo.soft_delete(doc)
        await self.db.commit()
        logger.info("document_deleted", doc_id=str(doc_id))

    async def list_versions(self, doc_id: UUID, org_id: UUID) -> list[DocumentVersionResponse]:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")

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

    async def list_comments(self, doc_id: UUID, org_id: UUID) -> list[CommentResponse]:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")

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
        org_id: UUID,
        author_id: UUID,
        req: CommentCreateRequest,
    ) -> CommentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")

        if req.parent_id:
            parent = await self.comment_repo.get_by_id(req.parent_id, org_id)
            if not parent:
                raise NotFoundException("Parent comment not found")

        com = await self.comment_repo.create(
            org_id=org_id,
            document_id=doc_id,
            body=req.body,
            author_id=author_id,
            parent_id=req.parent_id,
            is_internal=req.is_internal,
        )

        if req.mention_user_ids:
            await self.comment_repo.add_mentions(com.id, req.mention_user_ids)

        await self.db.commit()
        logger.info("comment_added", doc_id=str(doc_id), comment_id=str(com.id))

        u = await self.user_repo.get_by_id(author_id)
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
        org_id: UUID,
        author_id: UUID,
        req: CommentUpdateRequest,
    ) -> CommentResponse:
        com = await self.comment_repo.get_by_id(comment_id, org_id)
        if not com or com.document_id != doc_id:
            raise NotFoundException("Comment not found")

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

    async def list_attachments(self, doc_id: UUID, org_id: UUID) -> list[AttachmentResponse]:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")

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
        org_id: UUID,
        attached_by: UUID,
        file_asset_id: UUID,
        label: str | None = None,
    ) -> AttachmentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, org_id)
        if not doc:
            raise NotFoundException("Document not found")

        att = await self.att_repo.create(
            document_id=doc_id,
            file_asset_id=file_asset_id,
            label=label,
            attached_by=attached_by,
        )
        await self.db.commit()

        u = await self.user_repo.get_by_id(attached_by)
        f = att.file_asset
        return AttachmentResponse(
            id=att.id,
            document_id=att.document_id,
            file_asset_id=att.file_asset_id,
            label=att.label,
            attached_by=att.attached_by,
            attacher_name=u.name if u else None,
            filename=f.filename if f else "Attached File",
            mime_type=f.mime_type if f else "application/octet-stream",
            size_bytes=f.size_bytes if f else 0,
            preview_url=f.preview_url if f else None,
            created_at=att.created_at,
        )

    async def remove_attachment(self, att_id: UUID, doc_id: UUID, org_id: UUID) -> None:
        att = await self.att_repo.get_by_id(att_id)
        if not att or att.document_id != doc_id:
            raise NotFoundException("Attachment not found")
        await self.att_repo.soft_delete(att)
        await self.db.commit()
