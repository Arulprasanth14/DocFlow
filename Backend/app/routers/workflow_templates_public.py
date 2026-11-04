"""
DocFlow Backend — Router: Public Workflow Template Reads (Step 7)

Provides a read-only, non-admin endpoint for listing workflow templates.
Any authenticated org member may call this to discover available templates
at document-submit time — without needing admin:workflow_templates permission.

Full stage/rule details are intentionally excluded (use the admin endpoints
for those) — only the summary fields needed to populate a submit form are returned.

Endpoints:
  GET /api/v1/workflow-templates — list active templates (summary, no stage details)
"""
from __future__ import annotations

from typing import Annotated, Optional

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import CurrentUser
from app.core.exceptions import ForbiddenException
from app.schemas.workflow_instances import (
    TemplateReviewResponse,
    WorkflowShareCreate,
    WorkflowShareResponse,
    WorkflowShareResult,
    WorkflowTemplateCreate,
    WorkflowTemplateResponse,
    WorkflowTemplateSummary,
    WorkflowTemplateUpdate,
    WorkflowVersionSummary,
)
from app.services.template_service import TemplateService

router = APIRouter(tags=["Workflow Templates"])


def _is_org_admin(current_user: CurrentUser) -> bool:
    return bool(
        current_user.is_superadmin or ({"admin", "hr"} & set(current_user.roles))
    )


@router.get(
    "/workflow-templates",
    response_model=list[WorkflowTemplateSummary],
    status_code=200,
    summary="List active workflow templates (non-admin read — summary only)",
)
async def list_workflow_templates_public(
    current_user: CurrentUser,
    active_only: Annotated[bool, Query()] = True,
    department_id: Annotated[Optional[uuid.UUID], Query()] = None,
    doc_type_id: Annotated[Optional[uuid.UUID], Query()] = None,
    search: Annotated[Optional[str], Query(description="Case-insensitive name search")] = None,
    mine_only: Annotated[bool, Query(description="Only workflows I created")] = False,
    scope: Annotated[
        str,
        Query(
            pattern="^(all|mine|shared)$",
            description="WF-LIST-01 tabs: 'mine' = My Workflows, "
            "'shared' = Shared with me, 'all' = both (default).",
        ),
    ] = "all",
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowTemplateSummary]:
    """
    Returns a lightweight list of workflow templates for the caller's organization.
    Used by the document-submit UI to populate/search the workflow picker
    (§7 "the user can search workflows by name and select the intended
    workflow") and by the Workflows page to list the caller's own workflows.

    - No admin privilege required — any authenticated org member may call this.
    - Private workflows belonging to OTHER users are never returned (org
      admins see everything).
    - Only summary fields are returned; full stage/approver-rule details come
      from the detail endpoint.
    """
    if not current_user.org_id:
        return []
    svc = TemplateService(db)
    # Live USE grants decide what the "Shared with me" tab holds, and also
    # make a private-but-shared workflow visible at all (WF-OWN-09).
    shared_ids = await svc.share_repo.active_template_ids_for_user(current_user.id)
    templates = await svc.tmpl_repo.list_for_org(
        org_id=current_user.org_id,
        active_only=active_only,
        department_id=department_id,
        visible_to_user_id=current_user.id,
        include_private_of_others=_is_org_admin(current_user),
        owned_by=current_user.id if (mine_only or scope == "mine") else None,
        search=search,
        shared_template_ids=shared_ids,
        only_template_ids=shared_ids if scope == "shared" else None,
    )
    # Client-side filter by doc_type_id if provided (no DB join needed)
    if doc_type_id is not None:
        templates = [t for t in templates if t.doc_type_id == doc_type_id]
    return [WorkflowTemplateSummary.model_validate(t) for t in templates]


@router.post(
    "/workflow-templates",
    response_model=WorkflowTemplateResponse,
    status_code=201,
    summary="Create my own reusable workflow",
)
async def create_my_workflow(
    req: WorkflowTemplateCreate,
    current_user: CurrentUser,
    visibility: Annotated[str, Query(pattern="^(private|organization)$")] = "private",
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    """
    §7 + §2.5 matrix ("Create and manage own workflows: Yes" for every
    role): any member may define their own named approval route with ordered
    approvers. The definition is validated before saving (missing approvers,
    duplicate/negative stage order, unsatisfiable approval gates, approvers
    who aren't members of this org, trainees as approvers).

    Defaults to `private`; pass visibility=organization to share it with the
    whole organization.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.create(
        org_id=current_user.org_id,
        req=req,
        created_by=current_user.id,
        visibility=visibility,
    )


@router.get(
    "/workflow-templates/{template_id}",
    response_model=WorkflowTemplateResponse,
    status_code=200,
    summary="Full definition of a workflow I own (or any, for org admins)",
)
async def get_my_workflow(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    """
    The complete, editable definition — stages and approver rules — for the
    workflow edit form.

    Needed because the only other full-detail read is the admin endpoint
    (`/admin/workflow-templates/{id}`), which a Worker or Trainee can't
    call: without this they could create a workflow under §7 but never load
    it back to edit. A private workflow belonging to someone else is a 404,
    not a 403 — we don't confirm it exists.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    # Share-aware: a grantee may read the full configuration (WF-OWN-05).
    return await svc.get_readable(
        template_id=template_id,
        org_id=current_user.org_id,
        actor_id=current_user.id,
        is_admin=_is_org_admin(current_user),
    )


@router.patch(
    "/workflow-templates/{template_id}",
    response_model=WorkflowTemplateResponse,
    status_code=200,
    summary="Update a workflow I own",
)
async def update_my_workflow(
    template_id: uuid.UUID,
    req: WorkflowTemplateUpdate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.update(
        template_id=template_id,
        org_id=current_user.org_id,
        req=req,
        actor_id=current_user.id,
        is_admin=_is_org_admin(current_user),
    )


@router.post(
    "/workflow-templates/{template_id}/duplicate",
    response_model=WorkflowTemplateResponse,
    status_code=201,
    summary="Duplicate a workflow into a new one I own",
)
async def duplicate_my_workflow(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    new_name: Annotated[Optional[str], Query()] = None,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.duplicate(
        template_id=template_id,
        org_id=current_user.org_id,
        actor_id=current_user.id,
        is_admin=_is_org_admin(current_user),
        new_name=new_name,
    )


@router.post(
    "/workflow-templates/{template_id}/active",
    response_model=WorkflowTemplateResponse,
    status_code=200,
    summary="Enable or disable a workflow I own",
)
async def set_my_workflow_active(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    is_active: Annotated[bool, Query()] = True,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.set_active(
        template_id=template_id,
        org_id=current_user.org_id,
        is_active=is_active,
        actor_id=current_user.id,
        is_admin=_is_org_admin(current_user),
    )


@router.delete(
    "/workflow-templates/{template_id}",
    status_code=204,
    response_model=None,
    summary="Delete a workflow I own",
)
async def delete_my_workflow(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    await svc.delete(
        template_id=template_id,
        org_id=current_user.org_id,
        actor_id=current_user.id,
        is_admin=_is_org_admin(current_user),
    )


@router.get(
    "/workflow-templates/{template_id}/review",
    response_model=TemplateReviewResponse,
    status_code=200,
    summary="Non-admin, human-readable template detail for the pre-submit review step",
)
async def get_workflow_template_review(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> TemplateReviewResponse:
    """
    Returns ordered stages with a plain-English approver description (not the
    raw rule_type/rule_value) so any org member can review who will approve
    their document, in what order, before submitting — without needing the
    admin:users permission the full admin template-detail endpoint would
    otherwise require to resolve a specific_user's name.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.get_review(template_id=template_id, org_id=current_user.org_id)


# ── Versioning, lifecycle and sharing (Workflow module §4.4, §5.1, §5.7) ─────

@router.get(
    "/workflow-templates/{template_id}/versions",
    response_model=list[WorkflowVersionSummary],
    status_code=200,
    summary="Version history of a workflow I own",
)
async def list_my_workflow_versions(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowVersionSummary]:
    """
    DM-01/DM-04: every saved edit of a workflow creates a new immutable
    version, and this is the history of them. Owner-only (§7.3): a grantee may
    read the CURRENT definition but not the history of how it got there.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.list_versions(
        template_id=template_id,
        org_id=current_user.org_id,
        actor_id=current_user.id,
        is_admin=_is_org_admin(current_user),
    )


@router.post(
    "/workflow-templates/{template_id}/archive",
    response_model=WorkflowTemplateResponse,
    status_code=200,
    summary="Archive a workflow (owner or org admin)",
)
async def archive_my_workflow(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    """
    WF-LC-03: archiving makes the workflow unavailable for new submissions and
    hides it from pickers. Runs already in flight continue, and shares are kept
    but hidden. This is the way out when deletion is blocked (WF-LIST-07).
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.set_archived(
        template_id=template_id,
        org_id=current_user.org_id,
        archived=True,
        actor_id=current_user.id,
        is_admin=_is_org_admin(current_user),
    )


@router.post(
    "/workflow-templates/{template_id}/restore",
    response_model=WorkflowTemplateResponse,
    status_code=200,
    summary="Restore an archived workflow (owner or org admin)",
)
async def restore_my_workflow(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.set_archived(
        template_id=template_id,
        org_id=current_user.org_id,
        archived=False,
        actor_id=current_user.id,
        is_admin=_is_org_admin(current_user),
    )


@router.get(
    "/workflow-templates/{template_id}/shares",
    response_model=list[WorkflowShareResponse],
    status_code=200,
    summary="Who this workflow is shared with (owner only)",
)
async def list_my_workflow_shares(
    template_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowShareResponse]:
    """The owner's "Shared with" panel (WF-OWN-06)."""
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.list_shares(
        template_id=template_id,
        org_id=current_user.org_id,
        actor_id=current_user.id,
    )


@router.post(
    "/workflow-templates/{template_id}/shares",
    response_model=WorkflowShareResult,
    status_code=201,
    summary="Share a workflow with one colleague (owner only)",
)
async def share_my_workflow(
    template_id: uuid.UUID,
    req: WorkflowShareCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowShareResult:
    """
    WF-OWN-02/05: grants USE only. The recipient may view the configuration,
    select the workflow on upload and duplicate it into their own copy; they
    cannot edit, archive, delete or re-share the original.

    Idempotent (WF-OWN-07): sharing again with the same person returns the
    existing share, creates no duplicate row and sends no second message —
    `created` in the response says which happened.

    Rejected by the server, not just hidden in the UI (WF-OWN-08/10): sharing
    with yourself, someone outside the organization or a deactivated user is
    422; a workflow you do not own is 403; one that does not exist, or is
    private to someone else, is 404 rather than 403 so its existence is not
    revealed.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    return await svc.share(
        template_id=template_id,
        org_id=current_user.org_id,
        grantee_user_id=req.user_id,
        actor_id=current_user.id,
    )


@router.delete(
    "/workflow-templates/{template_id}/shares/{user_id}",
    status_code=204,
    response_model=None,
    summary="Revoke a share (owner only)",
)
async def revoke_my_workflow_share(
    template_id: uuid.UUID,
    user_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    """
    WF-OWN-06: revocation removes the workflow from the recipient's list and
    upload picker immediately. Runs they already started continue unaffected
    (DM-02, E6). The share row is kept, marked revoked, for the audit trail.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = TemplateService(db)
    await svc.revoke_share(
        template_id=template_id,
        org_id=current_user.org_id,
        grantee_user_id=user_id,
        actor_id=current_user.id,
    )
