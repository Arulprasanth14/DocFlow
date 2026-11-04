"""
DocFlow Backend — Router: Template Studio (Documents module, Phase 2)

Endpoints for the versioned, form-driven templates (spec §10):
    GET    /templates                   gallery (system + own)
    POST   /templates                   create a template draft
    GET    /templates/{id}              detail + field schema
    PATCH  /templates/{id}              autosave content / fields / metadata
    GET    /templates/{id}/publish-check  live publish checklist (FR-11.2)
    POST   /templates/{id}/publish      validate checklist and publish a version
    POST   /templates/{id}/duplicate    duplicate into my templates
    DELETE /templates/{id}              soft delete (owner only)

Authorisation is enforced in the service/repository on every call; a template
the caller may not see returns 404, never 403 (FR-5.2).
"""
from __future__ import annotations

from uuid import UUID

import structlog
from fastapi import APIRouter, Query

from app.core.exceptions import ForbiddenException
from app.dependencies import CurrentUser, DatabaseDep
from app.schemas.document import DocumentFillSchemaResponse
from app.schemas.org import MessageResponse
from app.schemas.template import (
    DetectBlanksRequest,
    DetectBlanksResponse,
    PublishIssue,
    TemplateCreateRequest,
    TemplateDetailResponse,
    TemplatePublishRequest,
    TemplateSummaryResponse,
    TemplateUpdateRequest,
    TemplateVersionSummary,
)
from app.services.template_studio_service import TemplateStudioService

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["templates"])


def _svc(db: DatabaseDep, current_user: CurrentUser) -> TemplateStudioService:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    return TemplateStudioService(db)


@router.get("", response_model=list[TemplateSummaryResponse])
async def list_templates(
    current_user: CurrentUser,
    db: DatabaseDep,
    scope: str | None = Query(None, description="user | system"),
    category: str | None = Query(None),
    q: str | None = Query(None, description="Free-text search on name/description"),
    favourites_only: bool = Query(False, description="Only the caller's favourites (FR-2.3)"),
    include_archived: bool = Query(False),
    published_only: bool = Query(False, description="Gallery view: usable templates only"),
    sort: str = Query("recent", description="recent | most_used | az"),
) -> list[TemplateSummaryResponse]:
    """Gallery: the organisation's published templates plus the caller's own."""
    if not current_user.org_id:
        return []
    return await _svc(db, current_user).list_templates(
        current_user, scope=scope, category=category, q=q,
        favourites_only=favourites_only, include_archived=include_archived,
        published_only=published_only, sort=sort,
    )


@router.post("", response_model=TemplateDetailResponse, status_code=201)
async def create_template(
    body: TemplateCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """Create a template draft (scope=system requires an administrator)."""
    return await _svc(db, current_user).create_template(current_user, body)


@router.get("/{template_id}", response_model=TemplateDetailResponse)
async def get_template(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """Template detail with its content and field schema."""
    return await _svc(db, current_user).get_template(template_id, current_user)


@router.patch("/{template_id}", response_model=TemplateDetailResponse)
async def update_template(
    template_id: UUID,
    body: TemplateUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """
    Autosave template metadata, editor content and field definitions.
    Editing a PUBLISHED template starts a new draft version (FR-11.5).
    """
    return await _svc(db, current_user).update_template(template_id, current_user, body)


@router.get("/{template_id}/fill-schema", response_model=DocumentFillSchemaResponse)
async def template_fill_schema(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DocumentFillSchemaResponse:
    """
    FR-12.1 — the questions of this template's published version.

    Lets Form Fill open before a draft exists, so the draft can be created by
    the author's first answer instead of by opening the page. `document_id` is
    null in the reply; everything else is the shape the document route returns.
    """
    return await TemplateStudioService(db).fill_schema(template_id, current_user)


@router.post("/{template_id}/detect-blanks", response_model=DetectBlanksResponse)
async def detect_blanks(
    template_id: UUID,
    body: DetectBlanksRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DetectBlanksResponse:
    """
    Turn plain fill-in patterns (___, {{token}}, [Name]) into real blanks.

    Rule-based, not AI: the same deterministic detector the document import
    uses, so it works with AI switched off and the body goes nowhere.
    """
    return DetectBlanksResponse(
        **await _svc(db, current_user).detect_blanks_rules(
            template_id, current_user, body.content
        )
    )


@router.get("/{template_id}/publish-check", response_model=list[PublishIssue])
async def publish_check(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[PublishIssue]:
    """The publish checklist as data — empty list means ready to publish."""
    return await _svc(db, current_user).publish_check(template_id, current_user)


@router.post("/{template_id}/publish", response_model=TemplateDetailResponse)
async def publish_template(
    template_id: UUID,
    body: TemplatePublishRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """Validate the checklist and publish the current draft version."""
    return await _svc(db, current_user).publish_template(template_id, current_user, body)


@router.put("/{template_id}/favourite", response_model=TemplateDetailResponse)
async def favourite_template(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """Mark a visible template as a favourite for the caller (FR-5.3)."""
    return await _svc(db, current_user).set_favourite(template_id, current_user, True)


@router.delete("/{template_id}/favourite", response_model=TemplateDetailResponse)
async def unfavourite_template(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """Remove the caller's favourite."""
    return await _svc(db, current_user).set_favourite(template_id, current_user, False)


@router.post("/{template_id}/archive", response_model=TemplateDetailResponse)
async def archive_template(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """Archive: hides the template from the gallery and frees a quota slot."""
    return await _svc(db, current_user).set_archived(template_id, current_user, True)


@router.post("/{template_id}/unarchive", response_model=TemplateDetailResponse)
async def unarchive_template(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """Restore an archived template to published (or draft if never published)."""
    return await _svc(db, current_user).set_archived(template_id, current_user, False)


@router.post("/{template_id}/duplicate", response_model=TemplateDetailResponse, status_code=201)
async def duplicate_template(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """Duplicate any visible template into the caller's own private templates."""
    return await _svc(db, current_user).duplicate_template(template_id, current_user)


@router.delete("/{template_id}", response_model=MessageResponse)
async def delete_template(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Soft-delete a template. Documents already created keep their snapshot."""
    await _svc(db, current_user).delete_template(template_id, current_user)
    return MessageResponse(message="Template deleted")


@router.get("/{template_id}/versions", response_model=list[TemplateVersionSummary])
async def list_template_versions(
    template_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[TemplateVersionSummary]:
    """FR-14.8 — version history, newest first."""
    return await _svc(db, current_user).list_versions(template_id, current_user)


@router.post("/{template_id}/versions/{version_id}/restore", response_model=TemplateDetailResponse)
async def restore_template_version(
    template_id: UUID,
    version_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """
    FR-14.8 — bring an earlier version back as the working draft.

    Copies it forward instead of rewinding, so documents pinned to any older
    version keep working and the restore itself appears in the history.
    """
    return await _svc(db, current_user).restore_version(template_id, version_id, current_user)
