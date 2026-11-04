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
    WorkflowTemplateCreate,
    WorkflowTemplateResponse,
    WorkflowTemplateSummary,
    WorkflowTemplateUpdate,
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
    templates = await svc.tmpl_repo.list_for_org(
        org_id=current_user.org_id,
        active_only=active_only,
        department_id=department_id,
        visible_to_user_id=current_user.id,
        include_private_of_others=_is_org_admin(current_user),
        owned_by=current_user.id if mine_only else None,
        search=search,
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
    tmpl = await svc.tmpl_repo.get_by_id(template_id, current_user.org_id)
    if not tmpl:
        from app.core.exceptions import NotFoundException

        raise NotFoundException("WorkflowTemplate not found")
    svc._assert_can_view(tmpl, current_user.id, _is_org_admin(current_user))
    return WorkflowTemplateResponse.model_validate(tmpl)


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
