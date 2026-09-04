"""
DocFlow Backend — Repository: Organizations & Memberships
Data access layer for Organization, Role, RolePermission, and OrganizationMember.
"""
from __future__ import annotations

import re
import uuid
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.domain.enums import SYSTEM_ROLES
from app.models.organization import (
    Organization,
    OrganizationMember,
    Permission as PermissionModel,
    Role,
    RolePermission,
)


def _slugify(name: str) -> str:
    """Convert an org name to a URL-safe slug."""
    slug = name.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s_-]+", "-", slug)
    slug = re.sub(r"^-+|-+$", "", slug)
    return slug[:100]


class OrganizationRepository:
    """Data access for the organizations table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_by_id(self, org_id: UUID) -> Organization | None:
        result = await self.db.execute(
            select(Organization).where(
                Organization.id == org_id,
                Organization.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def get_by_slug(self, slug: str) -> Organization | None:
        result = await self.db.execute(
            select(Organization).where(Organization.slug == slug)
        )
        return result.scalar_one_or_none()

    async def create(self, name: str, plan: str = "trial") -> Organization:
        """Create an org with a unique slug (append random suffix on collision)."""
        base_slug = _slugify(name)
        slug = base_slug
        # Ensure slug uniqueness
        existing = await self.get_by_slug(slug)
        if existing:
            slug = f"{base_slug}-{str(uuid.uuid4())[:8]}"

        org = Organization(name=name, slug=slug, plan=plan, status="active")
        self.db.add(org)
        await self.db.flush()
        return org

    async def create_default_roles(self, org_id: UUID) -> dict[str, Role]:
        """
        Seed the 5 system roles for a newly created organization.
        Returns a dict mapping role name → Role object.
        """
        # Ensure all permission codes exist in the permissions table
        for role_name, role_def in SYSTEM_ROLES.items():
            for perm_code in role_def["permissions"]:
                existing = await self.db.execute(
                    select(PermissionModel).where(PermissionModel.code == str(perm_code))
                )
                if not existing.scalar_one_or_none():
                    perm = PermissionModel(
                        code=str(perm_code),
                        category=str(perm_code).split(":")[0],
                    )
                    self.db.add(perm)

        await self.db.flush()

        created: dict[str, Role] = {}
        for role_name, role_def in SYSTEM_ROLES.items():
            role = Role(
                org_id=org_id,
                name=role_name,
                description=role_def["description"],
                is_system=True,
            )
            self.db.add(role)
            await self.db.flush()

            # Attach permissions
            for perm_code in role_def["permissions"]:
                rp = RolePermission(role_id=role.id, permission_code=str(perm_code))
                self.db.add(rp)

            created[role_name] = role

        await self.db.flush()
        return created


class OrgMemberRepository:
    """Data access for organization_members, roles, and permissions."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_membership(
        self, user_id: UUID, org_id: UUID
    ) -> OrganizationMember | None:
        result = await self.db.execute(
            select(OrganizationMember).where(
                OrganizationMember.user_id == user_id,
                OrganizationMember.org_id == org_id,
                OrganizationMember.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def add_member(
        self,
        org_id: UUID,
        user_id: UUID,
        role_id: UUID,
        dept_id: UUID | None = None,
    ) -> OrganizationMember:
        member = OrganizationMember(
            org_id=org_id,
            user_id=user_id,
            role_id=role_id,
            dept_id=dept_id,
            status="active",
        )
        self.db.add(member)
        await self.db.flush()
        return member

    async def get_role(self, role_id: UUID) -> Role | None:
        result = await self.db.execute(
            select(Role)
            .where(Role.id == role_id)
            .options(selectinload(Role.permissions))
        )
        return result.scalar_one_or_none()

    async def get_role_by_name(self, org_id: UUID, name: str) -> Role | None:
        result = await self.db.execute(
            select(Role)
            .where(Role.org_id == org_id, Role.name == name)
            .options(selectinload(Role.permissions))
        )
        return result.scalar_one_or_none()

    async def resolve_permissions(self, role_id: UUID) -> list[str]:
        """
        Load all permission codes for a given role.
        Returns sorted list of permission code strings.
        """
        role = await self.get_role(role_id)
        if not role:
            return []
        return sorted(str(rp.permission_code) for rp in role.permissions)

    async def get_membership_with_details(
        self, user_id: UUID, org_id: UUID
    ) -> tuple[OrganizationMember, Organization, Role, list[str]] | None:
        """
        Load membership + org + role + resolved permissions in one call.
        Returns (member, org, role, permission_codes) or None.
        """
        member = await self.get_membership(user_id, org_id)
        if not member:
            return None

        # Load org
        org_result = await self.db.execute(
            select(Organization).where(Organization.id == org_id)
        )
        org = org_result.scalar_one_or_none()
        if not org:
            return None

        role = await self.get_role(member.role_id)
        if not role:
            return None

        permissions = sorted(str(rp.permission_code) for rp in role.permissions)
        return member, org, role, permissions

    async def get_first_org_for_user(self, user_id: UUID) -> OrganizationMember | None:
        """Find the user's primary org membership (first active one)."""
        result = await self.db.execute(
            select(OrganizationMember)
            .where(
                OrganizationMember.user_id == user_id,
                OrganizationMember.status == "active",
                OrganizationMember.deleted_at.is_(None),
            )
            .limit(1)
        )
        return result.scalar_one_or_none()
