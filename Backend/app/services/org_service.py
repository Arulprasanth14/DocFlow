"""
DocFlow Backend — Service: Organizations & RBAC
Business logic for org settings, departments, teams, roles, and member management.
Includes Redis permission cache with 5-minute TTL (invalidated on role/member changes).
"""
from __future__ import annotations

import math
import structlog
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
)
from app.core.redis import cache_delete, cache_get, cache_set
from app.domain.enums import Permission
from app.models.organization import Organization, OrganizationMember
from app.repositories.dept_repo import DepartmentRepository, TeamRepository
from app.repositories.org_repo import OrgMemberRepository, OrganizationRepository
from app.repositories.role_repo import MemberRepository, RoleRepository
from app.repositories.user_repo import UserRepository
from app.schemas.org import (
    DepartmentResponse,
    MemberInviteRequest,
    MemberResponse,
    MemberRoleInfo,
    MemberUserInfo,
    OrgStatsResponse,
    PaginatedMembersResponse,
    PermissionCatalogResponse,
    PermissionEntry,
    RoleResponse,
    TeamResponse,
)

logger = structlog.get_logger(__name__)

_PERM_CACHE_TTL = 300  # 5 minutes


def _perm_cache_key(user_id: UUID, org_id: UUID) -> str:
    return f"permissions:{user_id}:{org_id}"


# ── Org Service ───────────────────────────────────────────────────────────────

class OrgService:
    """Manage organization-level settings and stats."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.org_repo = OrganizationRepository(db)
        self.dept_repo = DepartmentRepository(db)
        self.team_repo = TeamRepository(db)
        self.role_repo = RoleRepository(db)
        self.member_repo_ext = MemberRepository(db)

    async def get_org(self, org_id: UUID) -> Organization:
        org = await self.org_repo.get_by_id(org_id)
        if not org:
            raise NotFoundException("Organization not found")
        return org

    async def update_org(
        self,
        org_id: UUID,
        *,
        name: str | None = None,
        logo_url: str | None = None,
        settings: dict | None = None,
    ) -> Organization:
        org = await self.get_org(org_id)
        if name is not None:
            org.name = name
        if logo_url is not None:
            org.logo_url = logo_url
        if settings is not None:
            org.settings = {**org.settings, **settings}
        await self.db.flush()
        await self.db.commit()
        logger.info("org_updated", org_id=str(org_id))
        return org

    async def get_stats(self, org_id: UUID) -> OrgStatsResponse:
        member_count = await self.member_repo_ext.count_by_org(org_id)
        active_member_count = await self.member_repo_ext.count_active_by_org(org_id)
        dept_count = await self.dept_repo.count_by_org(org_id)
        team_count = await self.team_repo.count_by_org(org_id)
        role_count = await self.role_repo.count_by_org(org_id)
        return OrgStatsResponse(
            member_count=member_count,
            department_count=dept_count,
            team_count=team_count,
            role_count=role_count,
            active_member_count=active_member_count,
        )


# ── Department Service ────────────────────────────────────────────────────────

class DeptService:
    """Department and Team CRUD with org-scope enforcement."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.dept_repo = DepartmentRepository(db)
        self.team_repo = TeamRepository(db)

    async def list_departments_flat(self, org_id: UUID) -> list[DepartmentResponse]:
        depts = await self.dept_repo.list_by_org(org_id)
        return [DepartmentResponse.model_validate(d) for d in depts]

    async def get_department_tree(self, org_id: UUID) -> list[DepartmentResponse]:
        """Return department tree: top-level depts with nested children."""
        all_depts = await self.dept_repo.list_by_org(org_id)
        return _build_dept_tree(all_depts)

    async def create_department(
        self,
        org_id: UUID,
        name: str,
        code: str | None = None,
        parent_id: UUID | None = None,
        head_user_id: UUID | None = None,
    ) -> DepartmentResponse:
        # Validate code uniqueness
        if code and await self.dept_repo.code_exists(org_id, code):
            raise ConflictException(f"Department code '{code}' already exists in this organization")

        # Validate parent belongs to same org
        if parent_id:
            parent = await self.dept_repo.get_by_id(parent_id, org_id)
            if not parent:
                raise NotFoundException("Parent department not found")

        dept = await self.dept_repo.create(
            org_id=org_id,
            name=name,
            code=code,
            parent_id=parent_id,
            head_user_id=head_user_id,
        )
        await self.db.commit()
        logger.info("dept_created", org_id=str(org_id), dept_id=str(dept.id))
        return DepartmentResponse.model_validate(dept)

    async def update_department(
        self,
        dept_id: UUID,
        org_id: UUID,
        *,
        name: str | None = None,
        code: str | None = None,
        parent_id: UUID | None = None,
        head_user_id: UUID | None = None,
    ) -> DepartmentResponse:
        dept = await self.dept_repo.get_by_id(dept_id, org_id)
        if not dept:
            raise NotFoundException("Department not found")

        if code and code != dept.code:
            if await self.dept_repo.code_exists(org_id, code, exclude_id=dept_id):
                raise ConflictException(f"Department code '{code}' already exists")

        dept = await self.dept_repo.update(
            dept, name=name, code=code, parent_id=parent_id, head_user_id=head_user_id
        )
        await self.db.commit()
        return DepartmentResponse.model_validate(dept)

    async def delete_department(self, dept_id: UUID, org_id: UUID) -> None:
        dept = await self.dept_repo.get_by_id(dept_id, org_id)
        if not dept:
            raise NotFoundException("Department not found")
        await self.dept_repo.soft_delete(dept)
        await self.db.commit()
        logger.info("dept_deleted", dept_id=str(dept_id))

    async def list_teams(self, org_id: UUID) -> list[TeamResponse]:
        teams = await self.team_repo.list_by_org(org_id)
        return [TeamResponse.model_validate(t) for t in teams]

    async def create_team(
        self, org_id: UUID, name: str, dept_id: UUID | None = None
    ) -> TeamResponse:
        if dept_id:
            dept = await self.dept_repo.get_by_id(dept_id, org_id)
            if not dept:
                raise NotFoundException("Department not found")
        team = await self.team_repo.create(org_id=org_id, name=name, dept_id=dept_id)
        await self.db.commit()
        return TeamResponse.model_validate(team)

    async def update_team(
        self, team_id: UUID, org_id: UUID, *, name: str | None = None, dept_id: UUID | None = None
    ) -> TeamResponse:
        team = await self.team_repo.get_by_id(team_id, org_id)
        if not team:
            raise NotFoundException("Team not found")
        team = await self.team_repo.update(team, name=name, dept_id=dept_id)
        await self.db.commit()
        return TeamResponse.model_validate(team)

    async def delete_team(self, team_id: UUID, org_id: UUID) -> None:
        team = await self.team_repo.get_by_id(team_id, org_id)
        if not team:
            raise NotFoundException("Team not found")
        await self.team_repo.soft_delete(team)
        await self.db.commit()


# ── Role Service ──────────────────────────────────────────────────────────────

class RoleService:
    """Role + Permission management with cache invalidation."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.role_repo = RoleRepository(db)
        self.member_repo = OrgMemberRepository(db)

    async def list_roles(self, org_id: UUID) -> list[RoleResponse]:
        roles = await self.role_repo.list_by_org(org_id)
        result = []
        for role in roles:
            member_count = await self.role_repo.count_members_with_role(role.id)
            result.append(
                RoleResponse(
                    id=role.id,
                    org_id=role.org_id,
                    name=role.name,
                    description=role.description,
                    is_system=role.is_system,
                    permissions=[str(rp.permission_code) for rp in role.permissions],
                    member_count=member_count,
                    created_at=role.created_at,
                )
            )
        return result

    async def create_role(
        self,
        org_id: UUID,
        name: str,
        description: str | None = None,
        permissions: list[str] | None = None,
    ) -> RoleResponse:
        if await self.role_repo.name_exists(org_id, name):
            raise ConflictException(f"A role named '{name}' already exists")

        role = await self.role_repo.create(org_id=org_id, name=name, description=description)
        if permissions:
            await self.role_repo.set_permissions(role.id, permissions)
        await self.db.commit()

        logger.info("role_created", org_id=str(org_id), role_id=str(role.id))
        return RoleResponse(
            id=role.id,
            org_id=role.org_id,
            name=role.name,
            description=role.description,
            is_system=role.is_system,
            permissions=permissions or [],
            member_count=0,
            created_at=role.created_at,
        )

    async def update_role(
        self,
        role_id: UUID,
        org_id: UUID,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> RoleResponse:
        role = await self.role_repo.get_by_id(role_id, org_id)
        if not role:
            raise NotFoundException("Role not found")

        if name and name != role.name:
            if await self.role_repo.name_exists(org_id, name, exclude_id=role_id):
                raise ConflictException(f"A role named '{name}' already exists")

        role = await self.role_repo.update(role, name=name, description=description)
        await self.db.commit()

        member_count = await self.role_repo.count_members_with_role(role_id)
        return RoleResponse(
            id=role.id,
            org_id=role.org_id,
            name=role.name,
            description=role.description,
            is_system=role.is_system,
            permissions=[str(rp.permission_code) for rp in role.permissions],
            member_count=member_count,
            created_at=role.created_at,
        )

    async def set_permissions(
        self, role_id: UUID, org_id: UUID, permission_codes: list[str]
    ) -> RoleResponse:
        """Replace the permission set — then invalidate all member caches for this role."""
        role = await self.role_repo.get_by_id(role_id, org_id)
        if not role:
            raise NotFoundException("Role not found")

        # Validate permission codes
        valid_codes = {str(p) for p in Permission}
        invalid = [c for c in permission_codes if c not in valid_codes]
        if invalid:
            raise ValueError(f"Invalid permission codes: {invalid}")

        await self.role_repo.set_permissions(role_id, permission_codes)
        await self.db.commit()

        # Invalidate permission cache for all members with this role
        await self._invalidate_role_permission_caches(role_id, org_id)

        logger.info("role_permissions_set", role_id=str(role_id), count=len(permission_codes))

        member_count = await self.role_repo.count_members_with_role(role_id)
        return RoleResponse(
            id=role.id,
            org_id=role.org_id,
            name=role.name,
            description=role.description,
            is_system=role.is_system,
            permissions=permission_codes,
            member_count=member_count,
            created_at=role.created_at,
        )

    async def delete_role(self, role_id: UUID, org_id: UUID) -> None:
        role = await self.role_repo.get_by_id(role_id, org_id)
        if not role:
            raise NotFoundException("Role not found")
        if role.is_system:
            raise ForbiddenException("System roles cannot be deleted")

        # Check no members use this role
        member_count = await self.role_repo.count_members_with_role(role_id)
        if member_count > 0:
            raise ConflictException(
                f"Cannot delete role — {member_count} member(s) still have this role assigned"
            )

        await self.role_repo.soft_delete(role)
        await self.db.commit()
        logger.info("role_deleted", role_id=str(role_id))

    async def get_permission_catalog(self) -> PermissionCatalogResponse:
        """Return all available permission codes grouped by category."""
        perms = [
            PermissionEntry(
                code=str(p),
                category=str(p).split(":")[0],
                description=_PERM_DESCRIPTIONS.get(str(p)),
            )
            for p in Permission
        ]
        by_category: dict[str, list[str]] = {}
        for p in perms:
            by_category.setdefault(p.category, []).append(p.code)
        return PermissionCatalogResponse(permissions=perms, by_category=by_category)

    async def _invalidate_role_permission_caches(self, role_id: UUID, org_id: UUID) -> None:
        """Delete Redis permission cache entries for all users with this role."""
        from sqlalchemy import select
        from app.models.organization import OrganizationMember
        result = await self.db.execute(
            select(OrganizationMember.user_id).where(
                OrganizationMember.role_id == role_id,
                OrganizationMember.deleted_at.is_(None),
            )
        )
        user_ids = result.scalars().all()
        for uid in user_ids:
            await cache_delete(_perm_cache_key(uid, org_id))


# ── Member Service ────────────────────────────────────────────────────────────

class MemberService:
    """User invite, role change, suspension, and removal flows."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.user_repo = UserRepository(db)
        self.org_repo = OrganizationRepository(db)
        self.org_member_repo = OrgMemberRepository(db)
        self.member_repo = MemberRepository(db)
        self.role_repo = RoleRepository(db)

    async def list_members(
        self,
        org_id: UUID,
        page: int = 1,
        limit: int = 20,
        search: str | None = None,
        role_id: UUID | None = None,
        dept_id: UUID | None = None,
        status: str | None = None,
    ) -> PaginatedMembersResponse:
        limit = min(limit, 100)
        offset = (page - 1) * limit
        members, total = await self.member_repo.list_by_org(
            org_id, offset=offset, limit=limit,
            search=search, role_id=role_id, dept_id=dept_id, status=status,
        )

        items = []
        for member in members:
            user = await self.member_repo.get_user_for_member(member)
            item = MemberResponse(
                id=member.id,
                org_id=member.org_id,
                user_id=member.user_id,
                role_id=member.role_id,
                dept_id=member.dept_id,
                team_id=member.team_id,
                status=member.status,
                joined_at=member.joined_at,
                user=MemberUserInfo.model_validate(user) if user else None,
                role=MemberRoleInfo.model_validate(member.role) if member.role else None,
            )
            items.append(item)

        pages = math.ceil(total / limit) if limit else 1
        return PaginatedMembersResponse(
            items=items, total=total, page=page, limit=limit, pages=pages
        )

    async def invite_member(
        self,
        org_id: UUID,
        invite: MemberInviteRequest,
    ) -> MemberResponse:
        """
        Invite a user to the org by email.
        - If user exists → add them as member (or raise conflict if already a member).
        - If user doesn't exist → create a pending_invite user and add as member.
        """
        # Validate role belongs to org
        role = await self.role_repo.get_by_id(invite.role_id, org_id)
        if not role:
            raise NotFoundException("Role not found")

        # Find or create user
        user = await self.user_repo.get_by_email(str(invite.email))
        if not user:
            user = await self.user_repo.create(
                email=str(invite.email),
                name=invite.name,
            )
            # Mark as pending invite
            user.status = "pending_invite"
            await self.db.flush()
        else:
            # Check not already a member
            existing = await self.org_member_repo.get_membership(user.id, org_id)
            if existing and not existing.is_deleted:
                raise ConflictException("This user is already a member of the organization")

        member = await self.org_member_repo.add_member(
            org_id=org_id,
            user_id=user.id,
            role_id=invite.role_id,
            dept_id=invite.dept_id,
        )
        await self.db.commit()

        logger.info("member_invited", org_id=str(org_id), user_id=str(user.id))

        return MemberResponse(
            id=member.id,
            org_id=member.org_id,
            user_id=member.user_id,
            role_id=member.role_id,
            dept_id=member.dept_id,
            team_id=member.team_id,
            status=member.status,
            joined_at=member.joined_at,
            user=MemberUserInfo.model_validate(user),
            role=MemberRoleInfo.model_validate(role),
        )

    async def update_member(
        self,
        member_id: UUID,
        org_id: UUID,
        *,
        role_id: UUID | None = None,
        dept_id: UUID | None = None,
        team_id: UUID | None = None,
        status: str | None = None,
    ) -> MemberResponse:
        member = await self.member_repo.get_member_with_user(member_id, org_id)
        if not member:
            raise NotFoundException("Member not found")

        if role_id is not None:
            role = await self.role_repo.get_by_id(role_id, org_id)
            if not role:
                raise NotFoundException("Role not found")
            member.role_id = role_id
            # Invalidate permission cache on role change
            await cache_delete(_perm_cache_key(member.user_id, org_id))

        if dept_id is not None:
            member.dept_id = dept_id
        if team_id is not None:
            member.team_id = team_id
        if status is not None:
            member.status = status

        await self.db.flush()
        await self.db.commit()

        user = await self.member_repo.get_user_for_member(member)
        return MemberResponse(
            id=member.id,
            org_id=member.org_id,
            user_id=member.user_id,
            role_id=member.role_id,
            dept_id=member.dept_id,
            team_id=member.team_id,
            status=member.status,
            joined_at=member.joined_at,
            user=MemberUserInfo.model_validate(user) if user else None,
            role=MemberRoleInfo.model_validate(member.role) if member.role else None,
        )

    async def remove_member(self, member_id: UUID, org_id: UUID) -> None:
        member = await self.member_repo.get_member_with_user(member_id, org_id)
        if not member:
            raise NotFoundException("Member not found")
        from app.models.base import utcnow
        member.deleted_at = utcnow()
        member.status = "inactive"
        # Invalidate permission cache
        await cache_delete(_perm_cache_key(member.user_id, org_id))
        await self.db.flush()
        await self.db.commit()
        logger.info("member_removed", member_id=str(member_id))


# ── Permission Cache Helpers (for external use) ───────────────────────────────

async def get_cached_permissions(user_id: UUID, org_id: UUID) -> list[str] | None:
    """Check Redis cache for user permissions. Returns None on miss."""
    cached = await cache_get(_perm_cache_key(user_id, org_id))
    if cached and isinstance(cached, list):
        return cached
    return None


async def set_cached_permissions(
    user_id: UUID, org_id: UUID, permissions: list[str]
) -> None:
    await cache_set(_perm_cache_key(user_id, org_id), permissions, ttl_seconds=_PERM_CACHE_TTL)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_dept_tree(all_depts: list) -> list[DepartmentResponse]:
    """Build nested department tree from flat list."""
    dept_map: dict[str, DepartmentResponse] = {}
    roots: list[DepartmentResponse] = []

    for dept in all_depts:
        resp = DepartmentResponse.model_validate(dept)
        dept_map[str(dept.id)] = resp

    for dept in all_depts:
        resp = dept_map[str(dept.id)]
        if dept.parent_id and str(dept.parent_id) in dept_map:
            dept_map[str(dept.parent_id)].children.append(resp)
        else:
            roots.append(resp)

    return roots


_PERM_DESCRIPTIONS: dict[str, str] = {
    "documents:create": "Create new documents",
    "documents:read": "View documents",
    "documents:edit": "Edit document content",
    "documents:delete": "Delete documents",
    "documents:submit": "Submit documents for approval",
    "documents:cancel": "Cancel submitted documents",
    "documents:comment": "Add comments to documents",
    "workflows:read": "View workflow templates",
    "workflows:admin": "Create and manage workflow templates",
    "approvals:decide": "Approve or reject documents",
    "analytics:read": "View analytics and reports",
    "analytics:export": "Export analytics data",
    "admin:users": "Manage organization members",
    "admin:roles": "Manage roles and permissions",
    "admin:orgs": "Manage organization settings",
    "admin:audit": "View audit logs",
    "admin:doc_types": "Manage document types",
    "uploads:create": "Upload file attachments",
}
