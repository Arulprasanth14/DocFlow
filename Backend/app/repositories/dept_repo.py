"""
DocFlow Backend — Repository: Departments & Teams
Data access layer for Department and Team models.
Org-scoped — every query filters by org_id to enforce tenant isolation.
"""
from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.organization import Department, Team


class DepartmentRepository:
    """Data access for the departments table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_by_id(self, dept_id: UUID, org_id: UUID) -> Department | None:
        result = await self.db.execute(
            select(Department).where(
                Department.id == dept_id,
                Department.org_id == org_id,
                Department.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list_by_org(self, org_id: UUID) -> list[Department]:
        """Return all non-deleted departments for an org (flat list)."""
        result = await self.db.execute(
            select(Department).where(
                Department.org_id == org_id,
                Department.deleted_at.is_(None),
            ).order_by(Department.name)
        )
        return list(result.scalars().all())

    async def get_tree(self, org_id: UUID) -> list[Department]:
        """
        Return top-level departments (parent_id IS NULL).
        Children are nested by caller via build_dept_tree().
        """
        result = await self.db.execute(
            select(Department).where(
                Department.org_id == org_id,
                Department.parent_id.is_(None),
                Department.deleted_at.is_(None),
            ).order_by(Department.name)
        )
        return list(result.scalars().all())

    async def get_children(self, parent_id: UUID, org_id: UUID) -> list[Department]:
        result = await self.db.execute(
            select(Department).where(
                Department.parent_id == parent_id,
                Department.org_id == org_id,
                Department.deleted_at.is_(None),
            ).order_by(Department.name)
        )
        return list(result.scalars().all())

    async def count_by_org(self, org_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Department).where(
                Department.org_id == org_id,
                Department.deleted_at.is_(None),
            )
        )
        return result.scalar_one()

    async def code_exists(self, org_id: UUID, code: str, exclude_id: UUID | None = None) -> bool:
        """Check if a department code is already taken in the org."""
        q = select(Department).where(
            Department.org_id == org_id,
            Department.code == code,
            Department.deleted_at.is_(None),
        )
        if exclude_id:
            q = q.where(Department.id != exclude_id)
        result = await self.db.execute(q)
        return result.scalar_one_or_none() is not None

    async def create(
        self,
        org_id: UUID,
        name: str,
        code: str | None = None,
        parent_id: UUID | None = None,
        head_user_id: UUID | None = None,
    ) -> Department:
        dept = Department(
            org_id=org_id,
            name=name,
            code=code,
            parent_id=parent_id,
            head_user_id=head_user_id,
        )
        self.db.add(dept)
        await self.db.flush()
        return dept

    async def update(
        self,
        dept: Department,
        *,
        name: str | None = None,
        code: str | None = None,
        parent_id: UUID | None = None,
        head_user_id: UUID | None = None,
    ) -> Department:
        if name is not None:
            dept.name = name
        if code is not None:
            dept.code = code
        if parent_id is not None:
            dept.parent_id = parent_id
        if head_user_id is not None:
            dept.head_user_id = head_user_id
        await self.db.flush()
        return dept

    async def soft_delete(self, dept: Department) -> None:
        from app.models.base import utcnow
        dept.deleted_at = utcnow()
        await self.db.flush()


class TeamRepository:
    """Data access for the teams table."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_by_id(self, team_id: UUID, org_id: UUID) -> Team | None:
        result = await self.db.execute(
            select(Team).where(
                Team.id == team_id,
                Team.org_id == org_id,
                Team.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list_by_org(self, org_id: UUID) -> list[Team]:
        result = await self.db.execute(
            select(Team).where(
                Team.org_id == org_id,
                Team.deleted_at.is_(None),
            ).order_by(Team.name)
        )
        return list(result.scalars().all())

    async def list_by_dept(self, dept_id: UUID, org_id: UUID) -> list[Team]:
        result = await self.db.execute(
            select(Team).where(
                Team.dept_id == dept_id,
                Team.org_id == org_id,
                Team.deleted_at.is_(None),
            ).order_by(Team.name)
        )
        return list(result.scalars().all())

    async def count_by_org(self, org_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Team).where(
                Team.org_id == org_id,
                Team.deleted_at.is_(None),
            )
        )
        return result.scalar_one()

    async def create(self, org_id: UUID, name: str, dept_id: UUID | None = None) -> Team:
        team = Team(org_id=org_id, name=name, dept_id=dept_id)
        self.db.add(team)
        await self.db.flush()
        return team

    async def update(
        self,
        team: Team,
        *,
        name: str | None = None,
        dept_id: UUID | None = None,
    ) -> Team:
        if name is not None:
            team.name = name
        if dept_id is not None:
            team.dept_id = dept_id
        await self.db.flush()
        return team

    async def soft_delete(self, team: Team) -> None:
        from app.models.base import utcnow
        team.deleted_at = utcnow()
        await self.db.flush()
