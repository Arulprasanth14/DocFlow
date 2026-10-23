"""
DocFlow Backend — Service: Documents & Document Types
Business logic for dynamic form validation, version snapshots, threaded comments, and caching.
"""
from __future__ import annotations

import math
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
)
from app.core.redis import cache_delete, cache_get, cache_set
from app.core.events import EventBus
from app.domain.enums import NotificationType
from app.domain.permissions import AuthUser
from app.models.base import utcnow
from app.models.document import Document, DocumentType, DocumentTemplate, DocumentStatus, DocumentVersion
from app.models.organization import OrganizationMember
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
    ) -> PaginatedDocumentsResponse:
        limit = min(limit, 100)
        accessible_dept_ids = await get_user_departments(self.db, user.id, user.org_id)
        
        items_db, total = await self.doc_repo.list_by_org(
            user.org_id,
            user_id=user.id,
            is_admin="admin" in user.roles or "hr" in user.roles,
            is_approver="worker" in user.roles,
            accessible_dept_ids=accessible_dept_ids,
            page=page, limit=limit,
            status=status, doc_type_id=doc_type_id, dept_id=dept_id,
            submitted_by=submitted_by, search=search,
            tags=tags, priority=priority, date_from=date_from, date_to=date_to,
        )
        items = [await self._format_doc_response(d) for d in items_db]
        pages = math.ceil(total / limit) if limit else 1
        return PaginatedDocumentsResponse(
            items=items, total=total, page=page, limit=limit, pages=pages
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
    ) -> DocumentResponse:
        dt = await self.type_repo.get_by_id(req.doc_type_id, org_id)
        if not dt:
            raise NotFoundException("Document type not found")

        # Validate form_data against form_schema
        if dt.form_schema:
            validate_form_data(dt.form_schema, req.form_data)

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
    ) -> DocumentResponse:
        doc = await self.doc_repo.get_by_id(doc_id, user.org_id)
        if not doc:
            raise NotFoundException("Document not found")
        if not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to edit this document")

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
                changed_by=user.id,
                change_reason=req.change_reason or "Document updated",
            )
            EventBus.publish("document.version_uploaded", {"doc_id": str(doc.id), "org_id": str(user.org_id), "user_id": str(user.id), "version": latest_num + 1})

        await self.db.commit()
        return await self._format_doc_response(doc)

    async def submit_document(
        self,
        doc_id: UUID,
        user: AuthUser,
        req: DocumentSubmitRequest,
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

        now = utcnow()
        doc = await self.doc_repo.update(
            doc,
            status=DocumentStatus.SUBMITTED,
            submitted_at=now,
        )
        doc.submitter_snapshot = {"form_data": doc.form_data, "title": doc.title, "submitted_at": now.isoformat()}

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

        # Single commit for everything above
        await self.db.commit()
        logger.info("document_submitted", doc_id=str(doc_id))

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
        return await self._format_doc_response(doc)


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
