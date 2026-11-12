"""
DocFlow Backend — Repository: Template Studio

Org-scoped data access for Template / TemplateVersion / TemplateField /
PlaceholderOccurrence.

Visibility (spec §26, FR-5.2) is enforced HERE, in the query, so a template the
caller may not see simply does not exist as far as the service is concerned —
the service turns that into a 404 (never 403), which is what prevents IDOR
probing of other users' private templates.
"""
from __future__ import annotations

from uuid import UUID, uuid4

from sqlalchemy import and_, func, literal_column, or_, select, update
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.base import utcnow
from app.models.template import (
    PlaceholderOccurrence,
    Template,
    TemplateFavourite,
    TemplateField,
    TemplateVersion,
)


def _template_dept_col():
    """
    `templates.dept_id`, fully qualified.

    The model DOES map this column now (migration f5a6b7c8d9e0 is what added
    it), so `Template.dept_id` would work here. The qualified literal stays
    for the second reason below - ambiguity - which has nothing to do with
    whether the column is mapped:

      * `column("dept_id")` is unqualified, so in any statement that also
        touches `documents` — which has its own `dept_id` — Postgres rejects it
        as ambiguous.
      * the literal carries an explicit UUID type, so the bound parameter is
        sent as a uuid rather than text. Without it Postgres fails the
        comparison with "operator does not exist: uuid = character varying".

    Once the migration is applied and the attribute mapped, the mapped column
    is returned and this helper becomes a no-op.
    """
    mapped = getattr(Template, "dept_id", None)
    if mapped is not None:
        return mapped
    return literal_column("templates.dept_id", type_=PGUUID(as_uuid=True))


def _visibility_clause(user_id: UUID, is_admin: bool, dept_id: UUID | None = None):
    """
    Visibility rules (FR-5.2 / FR-5.6):
      - USER scope: visible only to owner (plus admins).
      - SYSTEM / ORG scope: visible org-wide (drafts visible only to admins).
      - TEAM scope: visible only to members of that department (dept_id), plus admins.
        A team template belonging to another department is strictly invisible (returns 404).
    """
    own = Template.owner_id == user_id
    if is_admin:
        system = Template.scope.in_(["system", "org"])
        team = Template.scope == "team"
        return or_(own, system, team)

    system = and_(Template.scope.in_(["system", "org"]), Template.status == "published")
    clauses = [own, system]
    if dept_id is not None:
        dept_col = _template_dept_col()
        team = and_(
            Template.scope == "team",
            Template.status == "published",
            dept_col == dept_id,
        )
        clauses.append(team)

    return or_(*clauses)


class TemplateRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # ── Reads ─────────────────────────────────────────────────────────────────

    async def get_for_user(
        self, template_id: UUID, org_id: UUID, user_id: UUID, is_admin: bool, dept_id: UUID | None = None
    ) -> Template | None:
        result = await self.db.execute(
            select(Template).where(
                Template.id == template_id,
                Template.org_id == org_id,
                Template.deleted_at.is_(None),
                _visibility_clause(user_id, is_admin, dept_id),
            )
        )
        return result.scalar_one_or_none()

    async def list_for_user(
        self,
        org_id: UUID,
        user_id: UUID,
        is_admin: bool,
        dept_id: UUID | None = None,
        scope: str | None = None,
        category: str | None = None,
        q: str | None = None,
        include_archived: bool = False,
        favourites_only: bool = False,
        published_only: bool = False,
        sort: str = "recent",
    ) -> list[Template]:
        stmt = select(Template).where(
            Template.org_id == org_id,
            Template.deleted_at.is_(None),
            _visibility_clause(user_id, is_admin, dept_id),
        )
        if scope:
            stmt = stmt.where(Template.scope == scope)
        if category:
            stmt = stmt.where(Template.category == category)
        if not include_archived:
            stmt = stmt.where(Template.status != "archived")
        if published_only:
            stmt = stmt.where(Template.status == "published")
        if favourites_only:
            # Filtered in-query rather than in Python so paging and counts stay honest.
            stmt = stmt.where(
                Template.id.in_(
                    select(TemplateFavourite.template_id).where(
                        TemplateFavourite.user_id == user_id
                    )
                )
            )
        if q:
            pattern = f"%{q}%"
            stmt = stmt.where(
                or_(Template.name.ilike(pattern), Template.description.ilike(pattern))
            )
        # FR-2.3 sort options; id tie-break keeps the order stable.
        if sort == "most_used":
            order = (Template.usage_count.desc(), Template.updated_at.desc())
        elif sort == "az":
            order = (func.lower(Template.name).asc(),)
        else:
            order = (Template.updated_at.desc(),)
        stmt = stmt.order_by(*order, Template.id.desc())
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    # ── Favourites (FR-5.3 / FR-2.3) ──────────────────────────────────────────

    async def favourite_ids(self, user_id: UUID, template_ids: list[UUID]) -> set[UUID]:
        if not template_ids:
            return set()
        result = await self.db.execute(
            select(TemplateFavourite.template_id).where(
                TemplateFavourite.user_id == user_id,
                TemplateFavourite.template_id.in_(template_ids),
            )
        )
        return {row[0] for row in result.all()}

    async def set_favourite(self, user_id: UUID, template_id: UUID, on: bool) -> None:
        existing = await self.db.execute(
            select(TemplateFavourite).where(
                TemplateFavourite.user_id == user_id,
                TemplateFavourite.template_id == template_id,
            )
        )
        row = existing.scalar_one_or_none()
        if on and row is None:
            self.db.add(TemplateFavourite(user_id=user_id, template_id=template_id))
        elif not on and row is not None:
            await self.db.delete(row)
        await self.db.flush()

    async def increment_usage(self, template_id: UUID) -> None:
        """Bumped when a document is started from the template (FR-2.5)."""
        await self.db.execute(
            update(Template)
            .where(Template.id == template_id)
            .values(usage_count=Template.usage_count + 1)
        )

    async def count_owned(self, org_id: UUID, user_id: UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Template).where(
                Template.org_id == org_id,
                Template.owner_id == user_id,
                Template.deleted_at.is_(None),
                Template.status != "archived",
            )
        )
        return result.scalar_one()

    async def owned_name_rows(self, org_id: UUID, user_id: UUID) -> list[tuple[str, str]]:
        """
        Every non-deleted template this user owns, as (name, status).

        `count_owned` + a `name_exists` probe per candidate suffix is one
        database round trip each, and creating a template ran both. On a
        remote database that is most of the wait before the editor opens, so
        the quota count and the name-collision check are answered from one
        query instead. The result is bounded by the per-user quota.
        """
        result = await self.db.execute(
            select(Template.name, Template.status).where(
                Template.org_id == org_id,
                Template.owner_id == user_id,
                Template.deleted_at.is_(None),
            )
        )
        return [(row[0], row[1]) for row in result.all()]

    async def name_exists(self, org_id: UUID, user_id: UUID, name: str, exclude_id: UUID | None = None) -> bool:
        """Unique per owner, case-insensitive, among non-deleted templates."""
        stmt = select(func.count()).select_from(Template).where(
            Template.org_id == org_id,
            Template.owner_id == user_id,
            Template.deleted_at.is_(None),
            func.lower(Template.name) == name.strip().lower(),
        )
        if exclude_id:
            stmt = stmt.where(Template.id != exclude_id)
        result = await self.db.execute(stmt)
        return result.scalar_one() > 0

    async def field_counts(self, version_ids: list[UUID]) -> dict[UUID, int]:
        if not version_ids:
            return {}
        result = await self.db.execute(
            select(TemplateField.template_version_id, func.count())
            .where(TemplateField.template_version_id.in_(version_ids))
            .group_by(TemplateField.template_version_id)
        )
        return {row[0]: row[1] for row in result.all()}

    # ── Versions ──────────────────────────────────────────────────────────────

    async def get_version(self, version_id: UUID) -> TemplateVersion | None:
        result = await self.db.execute(
            select(TemplateVersion).where(TemplateVersion.id == version_id)
        )
        return result.scalar_one_or_none()

    async def get_template_of_version(self, version_id: UUID) -> Template | None:
        """
        The owning template of a PINNED version, ignoring visibility and soft
        delete: a document keeps filling from its pinned version even after the
        template is deleted (C9). Callers must have already authorised the
        DOCUMENT — this is never reached from a template-id lookup.
        """
        result = await self.db.execute(
            select(Template)
            .join(TemplateVersion, TemplateVersion.template_id == Template.id)
            .where(TemplateVersion.id == version_id)
        )
        return result.scalar_one_or_none()

    async def latest_version(self, template_id: UUID) -> TemplateVersion | None:
        result = await self.db.execute(
            select(TemplateVersion)
            .where(TemplateVersion.template_id == template_id)
            .order_by(TemplateVersion.version_no.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def next_version_no(self, template_id: UUID) -> int:
        result = await self.db.execute(
            select(func.max(TemplateVersion.version_no)).where(
                TemplateVersion.template_id == template_id
            )
        )
        current = result.scalar_one_or_none()
        return (current or 0) + 1

    async def create_version(
        self,
        template_id: UUID,
        version_no: int,
        content: dict | None = None,
        page_settings: dict | None = None,
        source_file_id: UUID | None = None,
    ) -> TemplateVersion:
        version = TemplateVersion(
            template_id=template_id,
            version_no=version_no,
            content=content or {},
            page_settings=page_settings or {},
            source_file_id=source_file_id,
        )
        self.db.add(version)
        await self.db.flush()
        return version

    async def list_versions(self, template_id: UUID) -> list[TemplateVersion]:
        """Newest first — version history for FR-14.8."""
        result = await self.db.execute(
            select(TemplateVersion)
            .where(TemplateVersion.template_id == template_id)
            .order_by(TemplateVersion.version_no.desc())
        )
        return list(result.scalars().all())

    async def list_fields(self, version_id: UUID) -> list[TemplateField]:
        result = await self.db.execute(
            select(TemplateField)
            .where(TemplateField.template_version_id == version_id)
            .order_by(TemplateField.order_index, TemplateField.key)
        )
        return list(result.scalars().all())

    async def list_occurrences(self, version_id: UUID) -> list[PlaceholderOccurrence]:
        result = await self.db.execute(
            select(PlaceholderOccurrence)
            .where(PlaceholderOccurrence.template_version_id == version_id)
            .order_by(PlaceholderOccurrence.order_no)
        )
        return list(result.scalars().all())

    async def replace_fields(self, version_id: UUID, fields: list[dict]) -> None:
        """The editor owns the whole field set — replace wholesale."""
        for existing in await self.list_fields(version_id):
            await self.db.delete(existing)
        await self.db.flush()
        for f in fields:
            self.db.add(TemplateField(template_version_id=version_id, **f))
        await self.db.flush()

    async def replace_occurrences(self, version_id: UUID, occurrences: list[dict]) -> None:
        for existing in await self.list_occurrences(version_id):
            await self.db.delete(existing)
        await self.db.flush()
        for o in occurrences:
            self.db.add(PlaceholderOccurrence(template_version_id=version_id, **o))
        await self.db.flush()

    # ── Writes ────────────────────────────────────────────────────────────────

    async def create(self, **kwargs) -> Template:
        template = Template(**kwargs)
        self.db.add(template)
        await self.db.flush()
        return template

    async def create_with_version(self, **kwargs) -> tuple[Template, TemplateVersion]:
        """
        A template and its first version in ONE flush.

        The primary key is generated in Python, so the version's FK does not
        have to wait for the template's INSERT to come back. Flushing twice
        costs a second round trip, which on a remote database is most of a
        second the author spends looking at an empty editor.
        """
        template = Template(id=uuid4(), **kwargs)
        version = TemplateVersion(
            template_id=template.id, version_no=1, content={}, page_settings={},
        )
        self.db.add(template)
        self.db.add(version)
        await self.db.flush()
        return template, version

    async def soft_delete(self, template: Template) -> None:
        template.deleted_at = utcnow()
        await self.db.flush()
