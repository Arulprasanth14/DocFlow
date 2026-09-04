"""
DocFlow Backend — Router: Documents & Document Types
17 REST endpoints for Document Types and Document lifecycle management.
"""
from __future__ import annotations

from uuid import UUID

import structlog
from fastapi import APIRouter, Query

from app.dependencies import CurrentUser, DatabaseDep, require_permission
from app.schemas.document import (
    AttachmentCreateRequest,
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
    PaginatedDocumentsResponse,
)
from app.schemas.org import MessageResponse
from app.services.document_service import DocumentService, DocumentTypeService

logger = structlog.get_logger(__name__)

types_router = APIRouter(tags=["document-types"])
documents_router = APIRouter(tags=["documents"])


# ── Document Types (/api/v1/document-types) ───────────────────────────────────

@types_router.get("", response_model=list[DocumentTypeResponse])
async def list_document_types(
    current_user: CurrentUser,
    db: DatabaseDep,
    active_only: bool = Query(True),
) -> list[DocumentTypeResponse]:
    """List document types in the organization."""
    if not current_user.org_id:
        return []
    svc = DocumentTypeService(db)
    return await svc.list_types(current_user.org_id, active_only=active_only)


@types_router.post(
    "",
    response_model=DocumentTypeResponse,
    status_code=201,
    dependencies=[require_permission("admin:doc_types")],
)
async def create_document_type(
    body: DocumentTypeCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentTypeResponse:
    """Create a new document type with custom form_schema."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentTypeService(db)
    return await svc.create_type(current_user.org_id, body)


@types_router.get("/{type_id}", response_model=DocumentTypeResponse)
async def get_document_type(
    type_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentTypeResponse:
    """Get document type details."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentTypeService(db)
    return await svc.get_type(type_id, current_user.org_id)


@types_router.patch(
    "/{type_id}",
    response_model=DocumentTypeResponse,
    dependencies=[require_permission("admin:doc_types")],
)
async def update_document_type(
    type_id: UUID,
    body: DocumentTypeUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentTypeResponse:
    """Update document type name, code, form_schema, or status."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentTypeService(db)
    return await svc.update_type(type_id, current_user.org_id, body)


@types_router.delete(
    "/{type_id}",
    response_model=MessageResponse,
    dependencies=[require_permission("admin:doc_types")],
)
async def delete_document_type(
    type_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Soft-delete a document type."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentTypeService(db)
    await svc.delete_type(type_id, current_user.org_id)
    return MessageResponse(message="Document type deleted")


# ── Documents (/api/v1/documents) ─────────────────────────────────────────────

@documents_router.get("", response_model=PaginatedDocumentsResponse)
async def list_documents(
    current_user: CurrentUser,
    db: DatabaseDep,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str | None = Query(None),
    doc_type_id: UUID | None = Query(None),
    dept_id: UUID | None = Query(None),
    submitted_by: UUID | None = Query(None),
    search: str | None = Query(None),
) -> PaginatedDocumentsResponse:
    """List and search organization documents with filters and pagination."""
    if not current_user.org_id:
        return PaginatedDocumentsResponse(items=[], total=0, page=1, limit=limit, pages=0)
    svc = DocumentService(db)
    return await svc.list_documents(
        org_id=current_user.org_id,
        page=page,
        limit=limit,
        status=status,
        doc_type_id=doc_type_id,
        dept_id=dept_id,
        submitted_by=submitted_by,
        search=search,
    )


@documents_router.post(
    "",
    response_model=DocumentResponse,
    status_code=201,
    dependencies=[require_permission("documents:create")],
)
async def create_document(
    body: DocumentCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentResponse:
    """Create a new document as draft or submit immediately."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.create_document(
        org_id=current_user.org_id,
        submitted_by=current_user.id,
        req=body,
    )


@documents_router.get("/{doc_id}", response_model=DocumentResponse)
async def get_document(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentResponse:
    """Get full document details with metadata and attachment/comment counts."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.get_document(doc_id, current_user.org_id)


@documents_router.patch(
    "/{doc_id}",
    response_model=DocumentResponse,
    dependencies=[require_permission("documents:edit")],
)
async def update_document(
    doc_id: UUID,
    body: DocumentUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentResponse:
    """Update document form data, title, priority, or metadata (records a version snapshot)."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.update_document(
        doc_id=doc_id,
        org_id=current_user.org_id,
        user_id=current_user.id,
        req=body,
    )


@documents_router.post(
    "/{doc_id}/submit",
    response_model=DocumentResponse,
    dependencies=[require_permission("documents:submit")],
)
async def submit_document(
    doc_id: UUID,
    body: DocumentSubmitRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentResponse:
    """Submit a draft document for review/approval."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.submit_document(
        doc_id=doc_id,
        org_id=current_user.org_id,
        user_id=current_user.id,
        req=body,
    )


@documents_router.delete(
    "/{doc_id}",
    response_model=MessageResponse,
    dependencies=[require_permission("documents:delete")],
)
async def delete_document(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Soft-delete a document."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    await svc.delete_document(doc_id, current_user.org_id, current_user.id)
    return MessageResponse(message="Document deleted")


@documents_router.get("/{doc_id}/versions", response_model=list[DocumentVersionResponse])
async def list_document_versions(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[DocumentVersionResponse]:
    """Get version history of a document."""
    if not current_user.org_id:
        return []
    svc = DocumentService(db)
    return await svc.list_versions(doc_id, current_user.org_id)


@documents_router.get("/{doc_id}/comments", response_model=list[CommentResponse])
async def list_document_comments(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[CommentResponse]:
    """Get threaded comments for a document."""
    if not current_user.org_id:
        return []
    svc = DocumentService(db)
    return await svc.list_comments(doc_id, current_user.org_id)


@documents_router.post(
    "/{doc_id}/comments",
    response_model=CommentResponse,
    status_code=201,
    dependencies=[require_permission("documents:comment")],
)
async def add_document_comment(
    doc_id: UUID,
    body: CommentCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> CommentResponse:
    """Add a comment or reply to a document."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.add_comment(
        doc_id=doc_id,
        org_id=current_user.org_id,
        author_id=current_user.id,
        req=body,
    )


@documents_router.patch(
    "/{doc_id}/comments/{comment_id}",
    response_model=CommentResponse,
    dependencies=[require_permission("documents:comment")],
)
async def update_document_comment(
    doc_id: UUID,
    comment_id: UUID,
    body: CommentUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> CommentResponse:
    """Update comment body or resolution status."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.update_comment(
        comment_id=comment_id,
        doc_id=doc_id,
        org_id=current_user.org_id,
        author_id=current_user.id,
        req=body,
    )


@documents_router.get("/{doc_id}/attachments", response_model=list[AttachmentResponse])
async def list_document_attachments(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[AttachmentResponse]:
    """List attachments for a document."""
    if not current_user.org_id:
        return []
    svc = DocumentService(db)
    return await svc.list_attachments(doc_id, current_user.org_id)


@documents_router.post(
    "/{doc_id}/attachments",
    response_model=AttachmentResponse,
    status_code=201,
    dependencies=[require_permission("documents:edit")],
)
async def add_document_attachment(
    doc_id: UUID,
    body: AttachmentCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> AttachmentResponse:
    """Attach a file asset to a document."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.add_attachment(
        doc_id=doc_id,
        org_id=current_user.org_id,
        attached_by=current_user.id,
        file_asset_id=body.file_asset_id,
        label=body.label,
    )


@documents_router.delete(
    "/{doc_id}/attachments/{att_id}",
    response_model=MessageResponse,
    dependencies=[require_permission("documents:edit")],
)
async def delete_document_attachment(
    doc_id: UUID,
    att_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Remove an attachment from a document."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    await svc.remove_attachment(att_id, doc_id, current_user.org_id)
    return MessageResponse(message="Attachment removed")
