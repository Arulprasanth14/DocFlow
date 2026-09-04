"""
DocFlow Backend — Repository: Roles & Permissions
Data access for Role, RolePermission, Permission, and OrganizationMember (extended).
"""
from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.organization import (
    OrganizationMember,
    Permission as PermissionModel,
    Role,
    RolePermission,
)
from app.models.user import User


class RoleRepository:
    """Data access for roles and their permission sets."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_by_id(self, role_id: UUID, org_id: UUID) -> Role | None:
        result = await self.db.execute(
            select(Role)
            .where(
                Role.id == role_id,
                Role.org_id == org_id,
                Role.deleted_at.is_(None),
            )
            .options(selectinload(Role.permissions))
        )
        return result.scalar_one_or_none()

    async def list_by_org(self, org_id: UUID) -> list[Role]:
        result = await self.db.execute(
            select(Role)
            .where(
                Role.org_id == org_id,
                Role.deleted_at.is_(None),
            )
            .options(selectinload(Role.permissions))
            .order_by(Role.is_system.desc(), Role.name)
        )
        return list(result.scalars().all())

    async def count_by_org(self, org_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Role).where(
                Role.org_id == org_id,
                Role.deleted_at.is_(None),
            )
        )
        return result.scalar_one()

    async def count_members_with_role(self, role_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(OrganizationMember).where(
                OrganizationMember.role_id == role_id,
                OrganizationMember.deleted_at.is_(None),
            )
        )
        return result.scalar_one()

    async def name_exists(
        self, org_id: UUID, name: str, exclude_id: UUID | None = None
    ) -> bool:
        q = select(Role).where(
            Role.org_id == org_id,
            Role.name == name,
            Role.deleted_at.is_(None),
        )
        if exclude_id:
            q = q.where(Role.id != exclude_id)
        result = await self.db.execute(q)
        return result.scalar_one_or_none() is not None

    async def create(
        self,
        org_id: UUID,
        name: str,
        description: str | None = None,
        is_system: bool = False,
    ) -> Role:
        role = Role(
            org_id=org_id,
            name=name,
            description=description,
            is_system=is_system,
        )
        self.db.add(role)
        await self.db.flush()
        return role

    async def update(
        self,
        role: Role,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> Role:
        if name is not None:
            role.name = name
        if description is not None:
            role.description = description
        await self.db.flush()
        return role

    async def set_permissions(self, role_id: UUID, permission_codes: list[str]) -> None:
        """
        Replace the full permission set for a role atomically.
        Ensures all permission codes exist in the permissions table first.
        """
        # Ensure codes exist in permissions catalog
        for code in permission_codes:
            existing = await self.db.execute(
                select(PermissionModel).where(PermissionModel.code == code)
            )
            if not existing.scalar_one_or_none():
                perm = PermissionModel(
                    code=code,
                    category=code.split(":")[0] if ":" in code else "other",
                )
                self.db.add(perm)
        await self.db.flush()

        # Delete existing role-permissions
        from sqlalchemy import delete
        await self.db.execute(
            delete(RolePermission).where(RolePermission.role_id == role_id)
        )

        # Insert new ones
        for code in permission_codes:
            rp = RolePermission(role_id=role_id, permission_code=code)
            self.db.add(rp)

        await self.db.flush()

    async def soft_delete(self, role: Role) -> None:
        from app.models.base import utcnow
        role.deleted_at = utcnow()
        await self.db.flush()

    # ── Permission Catalog ────────────────────────────────────────────────────

    async def get_all_permission_codes(self) -> list[PermissionModel]:
        """Return all available permission codes from the catalog."""
        result = await self.db.execute(
            select(PermissionModel).order_by(PermissionModel.category, PermissionModel.code)
        )
        return list(result.scalars().all())


class MemberRepository:
    """Extended member data access for admin management flows."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def list_by_org(
        self,
        org_id: UUID,
        offset: int = 0,
        limit: int = 20,
        search: str | None = None,
        role_id: UUID | None = None,
        dept_id: UUID | None = None,
        status: str | None = None,
    ) -> tuple[list[OrganizationMember], int]:
        """Return paginated members with optional filters."""
        base_q = (
            select(OrganizationMember)
            .join(User, User.id == OrganizationMember.user_id)
            .where(
                OrganizationMember.org_id == org_id,
                OrganizationMember.deleted_at.is_(None),
            )
            .options(
                selectinload(OrganizationMember.role),
            )
        )

        if search:
            pattern = f"%{search.lower()}%"
            from sqlalchemy import or_
            base_q = base_q.where(
                or_(
                    func.lower(User.email).like(pattern),
                    func.lower(User.name).like(pattern),
                )
            )
        if role_id:
            base_q = base_q.where(OrganizationMember.role_id == role_id)
        if dept_id:
            base_q = base_q.where(OrganizationMember.dept_id == dept_id)
        if status:
            base_q = base_q.where(OrganizationMember.status == status)

        # Count
        count_q = select(func.count()).select_from(base_q.subquery())
        total_result = await self.db.execute(count_q)
        total = total_result.scalar_one()

        # Paginate
        paged_q = base_q.order_by(OrganizationMember.joined_at.desc()).offset(offset).limit(limit)
        result = await self.db.execute(paged_q)
        items = list(result.scalars().all())

        return items, total

    async def get_member_with_user(
        self, member_id: UUID, org_id: UUID
    ) -> OrganizationMember | None:
        result = await self.db.execute(
            select(OrganizationMember)
            .where(
                OrganizationMember.id == member_id,
                OrganizationMember.org_id == org_id,
                OrganizationMember.deleted_at.is_(None),
            )
            .options(
                selectinload(OrganizationMember.role),
            )
        )
        return result.scalar_one_or_none()

    async def count_active_by_org(self, org_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(OrganizationMember).where(
                OrganizationMember.org_id == org_id,
                OrganizationMember.status == "active",
                OrganizationMember.deleted_at.is_(None),
            )
        )
        return result.scalar_one()

    async def count_by_org(self, org_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(OrganizationMember).where(
                OrganizationMember.org_id == org_id,
                OrganizationMember.deleted_at.is_(None),
            )
        )
        return result.scalar_one()

    async def get_user_for_member(self, member: OrganizationMember) -> User | None:
        result = await self.db.execute(
            select(User).where(User.id == member.user_id)
        )
        return result.scalar_one_or_none()
