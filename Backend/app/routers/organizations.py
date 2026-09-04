"""
DocFlow Backend — Router: Organizations & RBAC
Thin HTTP adapter — all business logic delegates to service layer.

Endpoints:
  GET    /orgs/me                          → current org info
  PATCH  /orgs/me                          → update org settings (admin:orgs)
  GET    /orgs/me/stats                    → member/dept/doc counts (admin:orgs)

  GET    /orgs/me/departments              → department tree (all members)
  POST   /orgs/me/departments              → create dept (admin:orgs)
  PATCH  /orgs/me/departments/{id}         → update dept (admin:orgs)
  DELETE /orgs/me/departments/{id}         → delete dept (admin:orgs)

  GET    /orgs/me/teams                    → list teams (all members)
  POST   /orgs/me/teams                    → create team (admin:orgs)
  PATCH  /orgs/me/teams/{id}              → update team (admin:orgs)
  DELETE /orgs/me/teams/{id}              → delete team (admin:orgs)

  GET    /orgs/me/roles                    → list roles (admin:roles)
  POST   /orgs/me/roles                    → create custom role (admin:roles)
  PATCH  /orgs/me/roles/{id}              → update role name/desc (admin:roles)
  PUT    /orgs/me/roles/{id}/permissions   → replace permission set (admin:roles)
  DELETE /orgs/me/roles/{id}              → delete custom role (admin:roles)
  GET    /orgs/me/permissions              → permission catalog (admin:roles)

  GET    /orgs/me/members                  → paginated members (admin:users)
  POST   /orgs/me/members/invite           → invite by email (admin:users)
  PATCH  /orgs/me/members/{id}             → change role/dept (admin:users)
  DELETE /orgs/me/members/{id}             → remove member (admin:users)
"""
from __future__ import annotations

from uuid import UUID

import structlog
from fastapi import APIRouter, Query

from app.dependencies import CurrentUser, DatabaseDep, require_permission
from app.schemas.org import (
    DepartmentCreateRequest,
    DepartmentResponse,
    DepartmentUpdateRequest,
    MemberInviteRequest,
    MemberResponse,
    MemberUpdateRequest,
    MessageResponse,
    OrgResponse,
    OrgStatsResponse,
    OrgUpdateRequest,
    PaginatedMembersResponse,
    PermissionCatalogResponse,
    RoleCreateRequest,
    RolePermissionsRequest,
    RoleResponse,
    RoleUpdateRequest,
    TeamCreateRequest,
    TeamResponse,
    TeamUpdateRequest,
)
from app.services.org_service import (
    DeptService,
    MemberService,
    OrgService,
    RoleService,
)

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["organizations"])


# ── Org ───────────────────────────────────────────────────────────────────────

@router.get("/me", response_model=OrgResponse)
async def get_my_org(
    current_user: CurrentUser,
    db: DatabaseDep,
) -> OrgResponse:
    """Get the current user's organization details."""
    if not current_user.org_id:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("You are not a member of any organization")
    svc = OrgService(db)
    org = await svc.get_org(current_user.org_id)
    return OrgResponse.model_validate(org)


@router.patch("/me", response_model=OrgResponse, dependencies=[require_permission("admin:orgs")])
async def update_my_org(
    body: OrgUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> OrgResponse:
    """Update organization name, logo, or settings."""
    if not current_user.org_id:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("You are not a member of any organization")
    svc = OrgService(db)
    org = await svc.update_org(
        current_user.org_id,
        name=body.name,
        logo_url=body.logo_url,
        settings=body.settings,
    )
    return OrgResponse.model_validate(org)


@router.get("/me/stats", response_model=OrgStatsResponse, dependencies=[require_permission("admin:orgs")])
async def get_org_stats(
    current_user: CurrentUser,
    db: DatabaseDep,
) -> OrgStatsResponse:
    """Get org stats: member count, dept count, etc."""
    if not current_user.org_id:
        from app.core.exceptions import NotFoundException
        raise NotFoundException("You are not a member of any organization")
    svc = OrgService(db)
    return await svc.get_stats(current_user.org_id)


# ── Departments ───────────────────────────────────────────────────────────────

@router.get("/me/departments", response_model=list[DepartmentResponse])
async def list_departments(
    current_user: CurrentUser,
    db: DatabaseDep,
    flat: bool = Query(False, description="Return flat list instead of tree"),
) -> list[DepartmentResponse]:
    """List all departments. Returns hierarchical tree by default."""
    if not current_user.org_id:
        return []
    svc = DeptService(db)
    if flat:
        return await svc.list_departments_flat(current_user.org_id)
    return await svc.get_department_tree(current_user.org_id)


@router.post("/me/departments", response_model=DepartmentResponse, status_code=201,
             dependencies=[require_permission("admin:orgs")])
async def create_department(
    body: DepartmentCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DepartmentResponse:
    """Create a new department."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DeptService(db)
    return await svc.create_department(
        org_id=current_user.org_id,
        name=body.name,
        code=body.code,
        parent_id=body.parent_id,
        head_user_id=body.head_user_id,
    )


@router.patch("/me/departments/{dept_id}", response_model=DepartmentResponse,
              dependencies=[require_permission("admin:orgs")])
async def update_department(
    dept_id: UUID,
    body: DepartmentUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DepartmentResponse:
    """Update department name, code, parent, or head."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DeptService(db)
    return await svc.update_department(
        dept_id=dept_id,
        org_id=current_user.org_id,
        name=body.name,
        code=body.code,
        parent_id=body.parent_id,
        head_user_id=body.head_user_id,
    )


@router.delete("/me/departments/{dept_id}", response_model=MessageResponse,
               dependencies=[require_permission("admin:orgs")])
async def delete_department(
    dept_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Soft-delete a department."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DeptService(db)
    await svc.delete_department(dept_id=dept_id, org_id=current_user.org_id)
    return MessageResponse(message="Department deleted")


# ── Teams ─────────────────────────────────────────────────────────────────────

@router.get("/me/teams", response_model=list[TeamResponse])
async def list_teams(
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[TeamResponse]:
    """List all teams in the organization."""
    if not current_user.org_id:
        return []
    svc = DeptService(db)
    return await svc.list_teams(current_user.org_id)


@router.post("/me/teams", response_model=TeamResponse, status_code=201,
             dependencies=[require_permission("admin:orgs")])
async def create_team(
    body: TeamCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TeamResponse:
    """Create a new team."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DeptService(db)
    return await svc.create_team(
        org_id=current_user.org_id, name=body.name, dept_id=body.dept_id
    )


@router.patch("/me/teams/{team_id}", response_model=TeamResponse,
              dependencies=[require_permission("admin:orgs")])
async def update_team(
    team_id: UUID,
    body: TeamUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TeamResponse:
    """Update team name or department assignment."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DeptService(db)
    return await svc.update_team(
        team_id=team_id, org_id=current_user.org_id, name=body.name, dept_id=body.dept_id
    )


@router.delete("/me/teams/{team_id}", response_model=MessageResponse,
               dependencies=[require_permission("admin:orgs")])
async def delete_team(
    team_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Delete a team."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = DeptService(db)
    await svc.delete_team(team_id=team_id, org_id=current_user.org_id)
    return MessageResponse(message="Team deleted")


# ── Roles ─────────────────────────────────────────────────────────────────────

@router.get("/me/roles", response_model=list[RoleResponse],
            dependencies=[require_permission("admin:roles")])
async def list_roles(
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[RoleResponse]:
    """List all roles (system + custom) with their permission sets."""
    if not current_user.org_id:
        return []
    svc = RoleService(db)
    return await svc.list_roles(current_user.org_id)


@router.post("/me/roles", response_model=RoleResponse, status_code=201,
             dependencies=[require_permission("admin:roles")])
async def create_role(
    body: RoleCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> RoleResponse:
    """Create a custom role with optional initial permissions."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = RoleService(db)
    return await svc.create_role(
        org_id=current_user.org_id,
        name=body.name,
        description=body.description,
        permissions=body.permissions,
    )


@router.patch("/me/roles/{role_id}", response_model=RoleResponse,
              dependencies=[require_permission("admin:roles")])
async def update_role(
    role_id: UUID,
    body: RoleUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> RoleResponse:
    """Update a role's name or description."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = RoleService(db)
    return await svc.update_role(
        role_id=role_id,
        org_id=current_user.org_id,
        name=body.name,
        description=body.description,
    )


@router.put("/me/roles/{role_id}/permissions", response_model=RoleResponse,
            dependencies=[require_permission("admin:roles")])
async def set_role_permissions(
    role_id: UUID,
    body: RolePermissionsRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> RoleResponse:
    """Replace the full permission set for a role. Invalidates member caches."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = RoleService(db)
    return await svc.set_permissions(
        role_id=role_id,
        org_id=current_user.org_id,
        permission_codes=body.permissions,
    )


@router.delete("/me/roles/{role_id}", response_model=MessageResponse,
               dependencies=[require_permission("admin:roles")])
async def delete_role(
    role_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Delete a custom role (fails if system role or has members)."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = RoleService(db)
    await svc.delete_role(role_id=role_id, org_id=current_user.org_id)
    return MessageResponse(message="Role deleted")


@router.get("/me/permissions", response_model=PermissionCatalogResponse,
            dependencies=[require_permission("admin:roles")])
async def get_permission_catalog(
    db: DatabaseDep,
) -> PermissionCatalogResponse:
    """Get all available permission codes grouped by category."""
    svc = RoleService(db)
    return await svc.get_permission_catalog()


# ── Members ───────────────────────────────────────────────────────────────────

@router.get("/me/members", response_model=PaginatedMembersResponse,
            dependencies=[require_permission("admin:users")])
async def list_members(
    current_user: CurrentUser,
    db: DatabaseDep,
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    search: str | None = Query(None),
    role_id: UUID | None = Query(None),
    dept_id: UUID | None = Query(None),
    status: str | None = Query(None),
) -> PaginatedMembersResponse:
    """List organization members with optional filters and pagination."""
    if not current_user.org_id:
        from app.schemas.org import PaginatedMembersResponse
        return PaginatedMembersResponse(items=[], total=0, page=1, limit=limit, pages=0)
    svc = MemberService(db)
    return await svc.list_members(
        org_id=current_user.org_id,
        page=page,
        limit=limit,
        search=search,
        role_id=role_id,
        dept_id=dept_id,
        status=status,
    )


@router.post("/me/members/invite", response_model=MemberResponse, status_code=201,
             dependencies=[require_permission("admin:users")])
async def invite_member(
    body: MemberInviteRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MemberResponse:
    """Invite a user by email. Creates a pending account if they don't exist."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = MemberService(db)
    return await svc.invite_member(org_id=current_user.org_id, invite=body)


@router.patch("/me/members/{member_id}", response_model=MemberResponse,
              dependencies=[require_permission("admin:users")])
async def update_member(
    member_id: UUID,
    body: MemberUpdateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MemberResponse:
    """Change a member's role, department, team, or status."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = MemberService(db)
    return await svc.update_member(
        member_id=member_id,
        org_id=current_user.org_id,
        role_id=body.role_id,
        dept_id=body.dept_id,
        team_id=body.team_id,
        status=body.status,
    )


@router.delete("/me/members/{member_id}", response_model=MessageResponse,
               dependencies=[require_permission("admin:users")])
async def remove_member(
    member_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Remove a member from the organization."""
    if not current_user.org_id:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("No organization context")
    svc = MemberService(db)
    await svc.remove_member(member_id=member_id, org_id=current_user.org_id)
    return MessageResponse(message="Member removed")
