"""
DocFlow Backend — Router: Admin (Workflow Templates, User Lifecycle, Audit Logs)
Endpoints:
  POST   /api/v1/admin/workflow-templates       — create workflow template with stages
  GET    /api/v1/admin/workflow-templates       — list templates
  GET    /api/v1/admin/workflow-templates/{id}  — get full template with stages
  PATCH  /api/v1/admin/workflow-templates/{id}  — update template metadata (bumps version)
  DELETE /api/v1/admin/workflow-templates/{id}  — soft-delete template
  POST   /api/v1/admin/users/{id}/deactivate     — deactivate a user
  GET    /api/v1/admin/audit-logs                — query immutable audit trail
"""
from __future__ import annotations

import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import structlog

from app.core.exceptions import ForbiddenException, NotFoundException
from app.core.firebase import revoke_firebase_sessions
from app.dependencies import CurrentUser, require_admin_or_hr, require_main_admin
from app.database import get_db
from app.domain.enums import SYSTEM_ROLES
from app.models.audit import AuditLog
from app.models.user import User
from app.repositories.org_repo import OrgMemberRepository
from app.repositories.user_repo import SessionRepository
from app.schemas.workflow_instances import (
    WorkflowTemplateCreate,
    WorkflowTemplateResponse,
    WorkflowTemplateSummary,
    WorkflowTemplateUpdate,
)
from app.services.template_service import TemplateService

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/admin", tags=["Admin"])


# The two role gates now live in app/dependencies.py, built on
# AuthUser.is_org_admin() / is_admin_or_hr(), so there is one definition of
# each. Aliased here so the call sites below read unchanged.
_require_main_admin = require_main_admin
_require_admin_or_hr = require_admin_or_hr


# ── Roles Catalog ──────────────────────────────────────────────────────────────

class RoleCatalogEntry(BaseModel):
    name: str
    description: str
    permissions: list[str]


@router.get(
    "/roles/catalog",
    response_model=list[RoleCatalogEntry],
    status_code=200,
    summary="Get the canonical role → permission mapping for all DocFlow roles",
)
async def get_roles_catalog(
    current_user: CurrentUser,
) -> list[RoleCatalogEntry]:
    """
    Returns the full catalog of system roles and their associated permissions.
    Used by the frontend to render permission badges and role pickers without
    hardcoding permission lists client-side.

    Main Administrator-only endpoint (roles/permissions management is
    reserved per §13.4 unless explicitly granted to HR — not implemented
    as a grantable toggle in this baseline).
    """
    _require_main_admin(current_user)
    return [
        RoleCatalogEntry(
            name=role_name,
            description=role_def["description"],
            permissions=[str(p) for p in role_def["permissions"]],
        )
        for role_name, role_def in SYSTEM_ROLES.items()
    ]




# ── Workflow Templates ─────────────────────────────────────────────────────────

@router.post(
    "/workflow-templates",
    response_model=WorkflowTemplateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new workflow template with stages and approver rules",
)
async def create_workflow_template(
    req: WorkflowTemplateCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    _require_admin_or_hr(current_user)
    service = TemplateService(db)
    # Admin-authored templates are organization-wide by definition (every
    # member should be able to pick them at submit time); member-authored
    # ones default to private — see routers/workflow_templates_public.py.
    return await service.create(
        org_id=current_user.org_id,
        req=req,
        created_by=current_user.id,
        visibility="organization",
    )


@router.get(
    "/workflow-templates",
    response_model=list[WorkflowTemplateSummary],
    status_code=status.HTTP_200_OK,
    summary="List workflow templates for organization",
)
async def list_workflow_templates(
    current_user: CurrentUser,
    active_only: Annotated[bool, Query()] = True,
    department_id: Annotated[Optional[uuid.UUID], Query()] = None,
    db: AsyncSession = Depends(get_db),
) -> list[WorkflowTemplateSummary]:
    _require_admin_or_hr(current_user)
    service = TemplateService(db)
    # Administrators manage every workflow in the org, including members'
    # private ones (§7's sharing rule exempts administration permissions).
    return await service.list(
        org_id=current_user.org_id,
        active_only=active_only,
        department_id=department_id,
        visible_to_user_id=current_user.id,
        include_private_of_others=True,
    )


@router.get(
    "/workflow-templates/{template_id}",
    response_model=WorkflowTemplateResponse,
    status_code=status.HTTP_200_OK,
    summary="Get workflow template with all stages and rules",
)
async def get_workflow_template(
    template_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    _require_admin_or_hr(current_user)
    service = TemplateService(db)
    return await service.get(template_id=template_id, org_id=current_user.org_id)


@router.patch(
    "/workflow-templates/{template_id}",
    response_model=WorkflowTemplateResponse,
    status_code=status.HTTP_200_OK,
    summary="Update workflow template metadata (bumps version)",
)
async def update_workflow_template(
    template_id: Annotated[uuid.UUID, Path(...)],
    req: WorkflowTemplateUpdate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowTemplateResponse:
    _require_admin_or_hr(current_user)
    service = TemplateService(db)
    return await service.update(
        template_id=template_id,
        org_id=current_user.org_id,
        req=req,
    )


@router.delete(
    "/workflow-templates/{template_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    summary="Soft-delete a workflow template",
)
async def delete_workflow_template(
    template_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    _require_admin_or_hr(current_user)
    service = TemplateService(db)
    await service.delete(template_id=template_id, org_id=current_user.org_id)


# ── User Lifecycle Management ──────────────────────────────────────────────────

@router.post(
    "/users/{user_id}/deactivate",
    status_code=status.HTTP_200_OK,
    summary="Deactivate a user and revoke all active sessions",
)
async def deactivate_user(
    user_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    # §2.1/13.3: deleting/deactivating a user account is reserved exclusively
    # for the Main Administrator — HR support staff must not pass this gate.
    _require_main_admin(current_user)
    target_user = await db.get(User, user_id)
    if not target_user:
        raise NotFoundException("User not found")

    # Tenant isolation: an org admin may only deactivate users who are
    # members of their own organization (superadmins, which have no
    # org_id, are exempt from this check by definition).
    if not current_user.is_superadmin:
        member_repo = OrgMemberRepository(db)
        membership = await member_repo.get_membership(user_id, current_user.org_id)
        if not membership:
            raise NotFoundException("User not found")

    target_user.is_active = False
    target_user.status = "inactive"

    # Revoke every session in the SAME transaction as the flags. Without this
    # the flags were the only effect, and a deactivated user kept working
    # until their session expired - this endpoint's summary line has always
    # promised the revocation.
    # TODO(multi-org): revoke_all cuts the user's sessions in EVERY
    # organization. Per-org revocation needs sessions.org_id (Phase F).
    await SessionRepository(db).revoke_all(user_id)
    await db.flush()

    # Write audit entry
    log = AuditLog(
        org_id=current_user.org_id,
        actor_id=current_user.id,
        action="user.deactivate",
        resource_type="User",
        resource_id=user_id,
    )
    db.add(log)
    await db.commit()

    logger.info(
        "auth.session.revoked",
        reason="deactivate",
        actor_user_id=str(current_user.id),
        target_user_id=str(user_id),
        org_id=str(current_user.org_id) if current_user.org_id else None,
    )

    # Firebase side, AFTER the commit: the DocFlow change is authoritative and
    # must not be rolled back because an external provider is unreachable.
    # Deactivation here is permanent, so the identity is disabled too, not
    # just stripped of its refresh tokens.
    if target_user.firebase_uid:
        revoked = await revoke_firebase_sessions(
            target_user.firebase_uid, disable_user=True
        )
        if not revoked:
            logger.warning(
                "firebase_deactivation_incomplete",
                target_user_id=str(user_id),
                detail="DocFlow access is revoked; the Firebase identity may still mint ID tokens",
            )

    return {"status": "deactivated", "user_id": str(user_id)}


# ── Audit Logs Query ───────────────────────────────────────────────────────────

class AuditLogEntry(BaseModel):
    id: uuid.UUID
    actor_id: uuid.UUID | None
    action: str
    resource_type: str
    resource_id: uuid.UUID
    instance_id: uuid.UUID | None
    before: dict | None
    after: dict | None
    created_at: str

    model_config = {"from_attributes": True}


class AuditLogListResponse(BaseModel):
    items: list[AuditLogEntry]
    total: int


@router.get(
    "/audit-logs",
    response_model=AuditLogListResponse,
    status_code=status.HTTP_200_OK,
    summary="Query immutable system audit logs",
)
async def list_audit_logs(
    current_user: CurrentUser,
    instance_id: Annotated[Optional[uuid.UUID], Query()] = None,
    actor_id: Annotated[Optional[uuid.UUID], Query()] = None,
    action: Annotated[Optional[str], Query()] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    db: AsyncSession = Depends(get_db),
) -> AuditLogListResponse:
    _require_admin_or_hr(current_user)
    from sqlalchemy import func

    q = select(AuditLog).where(AuditLog.org_id == current_user.org_id)
    if instance_id:
        q = q.where(AuditLog.instance_id == instance_id)
    if actor_id:
        q = q.where(AuditLog.actor_id == actor_id)
    if action:
        q = q.where(AuditLog.action == action)

    count_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(count_q)).scalar_one()
    items = (
        await db.execute(
            q.order_by(AuditLog.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit)
        )
    ).scalars().all()

    entries = [
        AuditLogEntry(
            id=log.id,
            actor_id=log.actor_id,
            action=log.action,
            resource_type=log.resource_type,
            resource_id=log.resource_id,
            instance_id=log.instance_id,
            before=log.before,
            after=log.after,
            created_at=log.created_at.isoformat() if log.created_at else "",
        )
        for log in items
    ]
    return AuditLogListResponse(items=entries, total=total)
