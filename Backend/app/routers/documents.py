"""
DocFlow Backend — Router: Documents & Document Types
17 REST endpoints for Document Types and Document lifecycle management.
"""
from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

import structlog
from fastapi import APIRouter, File, Form, Header, Query, Response, UploadFile, status

from app.core.exceptions import ForbiddenException, ValidationException
from app.dependencies import CurrentUser, DatabaseDep, require_permission
from app.schemas.document import (
    AttachmentCreateRequest,
    AttachmentResponse,
    CommentCreateRequest,
    CommentResponse,
    CommentUpdateRequest,
    DocumentContentResponse,
    DocumentContentUpdateRequest,
    DocumentCreateRequest,
    DocumentFillSchemaResponse,
    DocumentPDFStateResponse,
    DocumentResponse,
    DocumentSubmitRequest,
    DocumentTypeCreateRequest,
    DocumentTypeResponse,
    DocumentTypeUpdateRequest,
    DocumentUpdateRequest,
    DocumentVersionResponse,
    PaginatedDocumentsResponse,
    DocumentTemplateCreateRequest,
    DocumentTemplateResponse,
    WatcherAddRequest,
    WatcherCandidateResponse,
    WatcherResponse,
    SubmitCheckRequest,
    SubmitCheckResponse,
)
from app.schemas.org import MessageResponse
from app.schemas.workflow_instances import SubmitAsNewRequest
from app.schemas.template import SaveAsTemplateRequest, TemplateDetailResponse
from app.services.document_service import DocumentService, DocumentTypeService
from app.services.template_studio_service import TemplateStudioService

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


@types_router.post(
    "/templates",
    response_model=DocumentTemplateResponse,
    status_code=201,
    dependencies=[require_permission("admin:doc_types")],
)
async def create_document_template(
    body: DocumentTemplateCreateRequest,
    doc_type_id: UUID = Query(...),
    current_user: CurrentUser = None, # type: ignore
    db: DatabaseDep = None, # type: ignore
) -> DocumentTemplateResponse:
    """Create a new document template."""
    from app.models.document import DocumentTemplate
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
        
    template = DocumentTemplate(
        org_id=current_user.org_id,
        doc_type_id=doc_type_id,
        name=body.name,
        default_field_values=body.default_field_values,
        created_by=current_user.id
    )
    db.add(template)
    await db.commit()
    await db.refresh(template)
    return DocumentTemplateResponse.model_validate(template)


# ── AI-assisted creation (§5.4) ───────────────────────────────────────────────
# Declared before "/{doc_id}" so these literal paths aren't captured by the
# UUID path parameter (FastAPI matches in declaration order).

@documents_router.post(
    "/ai/suggest-type",
    summary="Identify the likely document type and template for a description",
)
async def ai_suggest_document_type(
    current_user: CurrentUser,
    db: DatabaseDep,
    instructions: str = Form(...),
) -> dict:
    """
    §5.4 step one: "The system identifies the intended document type and
    checks whether an applicable template exists." Matching is deterministic
    against this organization's own configured document types, so it can
    never propose a type that doesn't exist here.
    """
    from app.services.ai_document_service import AIDocumentService

    if not current_user.org_id:
        return {"suggested": None, "available": []}
    svc = AIDocumentService(db)
    suggested, available = await svc.suggest_document_type(
        current_user.org_id, instructions
    )
    return {
        "suggested": (
            {"id": str(suggested.id), "name": suggested.name, "code": suggested.code}
            if suggested
            else None
        ),
        "available": [
            {"id": str(t.id), "name": t.name, "code": t.code} for t in available
        ],
    }


@documents_router.post(
    "/ai/draft",
    status_code=status.HTTP_201_CREATED,
    summary="Generate an AI-assisted document draft (saved as a draft for review)",
)
async def ai_generate_draft(
    current_user: CurrentUser,
    db: DatabaseDep,
    instructions: str = Form(...),
    doc_type_id: UUID | None = Form(None),
    template_id: UUID | None = Form(None),
    title: str | None = Form(None),
    save: bool = Form(True),
    files: list[UploadFile] | None = File(None),
) -> dict:
    """
    Generates a draft from the user's instructions, optional source files,
    and the applicable template.

    The result is always a DRAFT requiring review — this endpoint never
    submits anything into an approval workflow. Any detail the user didn't
    supply comes back as a `[TO BE COMPLETED: …]` placeholder and is listed
    in `missing_information`, rather than being invented.
    """
    from app.services.ai_document_service import AIDocumentService

    if not current_user.org_id:
        raise ForbiddenException("No organization context")

    sources: list[tuple[bytes, str | None, str | None]] = []
    for upload in files or []:
        sources.append((await upload.read(), upload.filename, upload.content_type))

    svc = AIDocumentService(db)
    return await svc.generate_draft(
        current_user,
        instructions=instructions,
        doc_type_id=doc_type_id,
        template_id=template_id,
        title_hint=title,
        source_files=sources,
        save=save,
    )


# ── Documents (/api/v1/documents) ─────────────────────────────────────────────

@documents_router.get("/analytics", response_model=dict[str, int])
async def get_documents_analytics(
    current_user: CurrentUser,
    db: DatabaseDep,
) -> dict[str, int]:
    """Get analytics for document statuses, scoped to user visibility."""
    if not current_user.org_id:
        return {}
    svc = DocumentService(db)
    return await svc.get_analytics(current_user)

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
    tags: list[str] | None = Query(None),
    priority: str | None = Query(None),
    date_from: str | None = Query(None),
    date_to: str | None = Query(None),
    sort: str | None = Query(None, description="<field>:<asc|desc>, e.g. updatedAt:desc"),
    workflow_template_id: UUID | None = Query(
        None, description="Only documents routed through this workflow (FR-1.2)"
    ),
    cursor: str | None = Query(
        None,
        description=(
            "Keyset cursor from a previous response's next_cursor (FR-1.4). "
            "Takes precedence over `page`. Must be used with the same `sort`."
        ),
    ),
) -> PaginatedDocumentsResponse:
    """List and search organization documents with filters and pagination."""
    if not current_user.org_id:
        return PaginatedDocumentsResponse(items=[], total=0, page=1, limit=limit, pages=0)
    svc = DocumentService(db)
    
    import datetime
    def _parse_date(d: str | None) -> datetime.datetime | None:
        if not d:
            return None
        return datetime.datetime.fromisoformat(d.replace("Z", "+00:00"))

    try:
        return await svc.list_documents(
            user=current_user,
            page=page,
            limit=limit,
            status=status,
            doc_type_id=doc_type_id,
            dept_id=dept_id,
            submitted_by=submitted_by,
            search=search,
            tags=tags,
            priority=priority,
            date_from=_parse_date(date_from),
            date_to=_parse_date(date_to),
            sort=sort,
            cursor=cursor,
            workflow_template_id=workflow_template_id,
        )
    except ValueError as exc:
        # A malformed cursor, or one taken under a different sort. Both are
        # the client's to fix, and both would otherwise surface as a 500.
        raise ValidationException(f"Invalid cursor: {exc}") from exc


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
        user=current_user,
    )

@documents_router.post(
    "/from-template/{template_id}",
    response_model=DocumentResponse,
    status_code=201,
    dependencies=[require_permission("documents:create")],
)
async def create_document_from_template(
    template_id: UUID,
    body: DocumentCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentResponse:
    """Create a new document from a template."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.create_from_template(
        user=current_user,
        template_id=template_id,
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
    return await svc.get_document(doc_id, current_user)


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
    if_match: str | None = Header(default=None, alias="If-Match"),
) -> DocumentResponse:
    """
    Update / autosave a document.

    When the client sends an `If-Match: <version>` header (autosave path,
    spec §24), optimistic locking is enforced — a stale version returns 409 —
    and partial/invalid draft data is accepted with throttled version snapshots.
    Without the header this behaves as a strict manual save (records a snapshot).
    """
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")

    expected_version: int | None = None
    if if_match is not None:
        try:
            expected_version = int(if_match.strip().strip('"'))
        except (ValueError, AttributeError):
            expected_version = None

    svc = DocumentService(db)
    return await svc.update_document(
        doc_id=doc_id,
        user=current_user,
        req=body,
        expected_version=expected_version,
    )


@documents_router.post("/{doc_id}/submit-check", response_model=SubmitCheckResponse)
async def check_document_submission(
    doc_id: UUID,
    body: SubmitCheckRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> SubmitCheckResponse:
    """
    Whether this draft may move past a wizard step, and what blocks it.

    Read-only. The client mirrors the cheap rules for instant feedback, but
    this is the answer that decides — and the submit endpoint runs exactly
    the same checks again, so a draft that goes stale in between is caught.
    """
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    result = await DocumentService(db).check_submission(
        doc_id=doc_id,
        user=current_user,
        stage=body.stage,
        workflow_template_id=body.workflow_template_id,
    )
    return SubmitCheckResponse(**result)


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
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> DocumentResponse:
    """
    Submit a draft document for review/approval.

    Send an `Idempotency-Key` header to make retries safe (FR-13.7): a repeat
    call with the same key returns the already-submitted document instead of a
    409, so a double-click or network retry cannot submit twice.
    """
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.submit_document(
        doc_id=doc_id,
        user=current_user,
        req=body,
        idempotency_key=idempotency_key,
    )


@documents_router.post(
    "/{doc_id}/submit-as-new",
    dependencies=[require_permission("documents:submit")],
)
async def submit_as_new(
    doc_id: UUID,
    body: SubmitAsNewRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> dict:
    """WF-SUB-06 / AP-REJ-04 / E18 — start a fresh run after a terminal one.

    A rejection is terminal (BR-07), so the way forward is a new run rather
    than reopening the old one. The closed run keeps every decision, comment
    and signature exactly as it was and stays fully visible; the new run
    starts at stage 1 and records which run it follows.

    Also the way back from a withdrawal, which would otherwise be a dead
    end — the document's status is CANCELLED, which the ordinary submit path
    refuses.
    """
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    from app.services.workflow_service import WorkflowService

    run = await WorkflowService(db).submit_as_new(
        org_id=current_user.org_id,
        document_id=doc_id,
        requester_id=current_user.id,
        template_id=body.template_id,
        version_id=body.version_id,
    )
    await db.commit()
    return run.model_dump(mode="json")


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
    await svc.delete_document(doc_id, current_user)
    return MessageResponse(message="Document deleted")


@documents_router.get("/{doc_id}/content", response_model=DocumentContentResponse)
async def get_document_content(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentContentResponse:
    """The document's editable body (freeform editor JSON / template answers)."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.get_content(doc_id, current_user)


@documents_router.patch(
    "/{doc_id}/content",
    response_model=DocumentContentResponse,
    dependencies=[require_permission("documents:edit")],
)
async def update_document_content(
    doc_id: UUID,
    body: DocumentContentUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentContentResponse:
    """Autosave the body of a draft document. Submitted documents are locked."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.save_content(doc_id, current_user, body)


@documents_router.get("/{doc_id}/fill-schema", response_model=DocumentFillSchemaResponse)
async def get_document_fill_schema(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentFillSchemaResponse:
    """
    Form Fill's questions, read from the template version this document was
    PINNED to at creation (FR-12.x / C9). Blank and uploaded documents return
    an empty field list — they have no questions (FR-13.9).
    """
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.get_fill_schema(doc_id, current_user)


@documents_router.get(
    "/{doc_id}/export",
    dependencies=[require_permission("documents:read")],
    response_class=Response,
)
async def export_document(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
    format: Annotated[Literal["pdf", "docx"], Query()] = "pdf",
) -> Response:
    """
    FR-6.7 — download this document as PDF or DOCX.

    A submitted document exports its frozen snapshot; a draft exports the live
    body and is watermarked DRAFT, so the two can never be confused.
    """
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    data, media_type, filename = await svc.export_document(doc_id, current_user, format)
    return Response(
        content=data,
        media_type=media_type,
        headers={
            # Quoted filename: a title with a space or comma would otherwise
            # truncate the header.
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(data)),
        },
    )


@documents_router.get(
    "/{doc_id}/pdf",
    response_model=DocumentPDFStateResponse,
    dependencies=[require_permission("documents:read")],
)
async def get_document_pdf(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentPDFStateResponse:
    """
    FR-13.8 — the frozen snapshot's PDF: its render state, and a download URL
    once it is ready. Polled by the UI while the status is 'pending'.
    """
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return DocumentPDFStateResponse(**await svc.get_pdf_state(doc_id, current_user))


@documents_router.post(
    "/{doc_id}/pdf/retry",
    response_model=DocumentPDFStateResponse,
    dependencies=[require_permission("documents:read")],
)
async def retry_document_pdf(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentPDFStateResponse:
    """Re-queue a failed snapshot render. The snapshot itself is untouched."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return DocumentPDFStateResponse(**await svc.retry_pdf_render(doc_id, current_user))


@documents_router.post(
    "/{doc_id}/save-as-template",
    response_model=TemplateDetailResponse,
    status_code=201,
    dependencies=[require_permission("documents:create")],
)
async def save_document_as_template(
    doc_id: UUID,
    body: SaveAsTemplateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """FR-5.4 — turn this document into a private, editable template draft."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    # Authorise the DOCUMENT first; the template side then applies its own
    # quota and unique-name rules.
    doc, content = await svc.get_document_for_copy(doc_id, current_user)
    return await TemplateStudioService(db).save_document_as_template(
        doc, content, current_user, body
    )


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
    return await svc.list_versions(doc_id, current_user)

@documents_router.post(
    "/{doc_id}/versions/{version_id}/restore",
    response_model=DocumentResponse,
    dependencies=[require_permission("documents:edit")],
)
async def restore_document_version(
    doc_id: UUID,
    version_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentResponse:
    """Restore a previous version of a document."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.restore_version(doc_id, version_id, current_user)


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
    return await svc.list_comments(doc_id, current_user)


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
        user=current_user,
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
        user=current_user,
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
    return await svc.list_attachments(doc_id, current_user)


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
        user=current_user,
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


# ── Watchers / CC (spec FR-13.4) ──────────────────────────────────────────────
#
# Reading the watcher list needs only document access; changing it is the
# owner's (or an admin's) call, enforced in the service. The permission
# dependency here is the coarse gate — `documents:edit` is held by anyone who
# can edit their OWN documents, so it cannot stand in for the ownership check.

@documents_router.get("/{doc_id}/watchers", response_model=list[WatcherResponse])
async def list_document_watchers(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[WatcherResponse]:
    """People CC'd on this document."""
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.list_watchers(doc_id, current_user)


@documents_router.get(
    "/{doc_id}/watcher-candidates",
    response_model=list[WatcherCandidateResponse],
)
async def list_watcher_candidates(
    doc_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
    q: str | None = Query(None, max_length=100, description="Filter by name or email"),
    limit: int = Query(20, ge=1, le=50),
) -> list[WatcherCandidateResponse]:
    """
    Colleagues who could be added as watchers.

    Open to any member who can open the document, which is why it returns
    only id/name/email — never roles, departments or activity. It exists
    because `GET /orgs/me/members` requires `admin:users`, and a CC picker
    must not require widening that.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.watcher_candidates(doc_id, current_user, q, limit=limit)


@documents_router.post(
    "/{doc_id}/watchers",
    response_model=WatcherResponse,
    status_code=201,
    dependencies=[require_permission("documents:edit")],
)
async def add_document_watcher(
    doc_id: UUID,
    body: WatcherAddRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> WatcherResponse:
    """CC someone on this document."""
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    return await svc.add_watcher(doc_id, current_user, body.user_id)


@documents_router.delete(
    "/{doc_id}/watchers/{user_id}",
    response_model=MessageResponse,
    dependencies=[require_permission("documents:edit")],
)
async def remove_document_watcher(
    doc_id: UUID,
    user_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Stop CC-ing someone. A watcher may always remove themselves."""
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = DocumentService(db)
    await svc.remove_watcher(doc_id, current_user, user_id)
    return MessageResponse(message="Watcher removed")
