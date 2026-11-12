"""
DocFlow Backend — Service: Template Studio (Documents module, Phase 2)

Business rules for the versioned, form-driven templates authored in the
Template Studio. Not to be confused with `template_service.py`, which manages
WorkflowTemplates (approval routing).

Key rules implemented here:
  - Visibility / IDOR: a template the caller may not see returns 404, never 403
    (enforced in the repository's query — spec FR-5.2, §26).
  - Versioning: editing a PUBLISHED template starts a NEW draft version; already
    created documents stay pinned to the version they used (FR-11.5, conflict C9).
  - Publish gate: the checklist must pass before a template leaves DRAFT (FR-11.2).
  - Per-user quota (spec §30 TEMPLATE_QUOTA_PER_USER).
"""
from __future__ import annotations

from uuid import UUID

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    ValidationException,
)
from app.domain.permissions import AuthUser
from app.models.organization import OrganizationMember
from app.models.base import utcnow
from app.models.template import Template, TemplateVersion
from app.repositories.template_repo import TemplateRepository
from app.schemas.template import (
    PlaceholderOccurrenceSchema,
    PublishIssue,
    SaveAsTemplateRequest,
    TemplateCreateRequest,
    TemplateDetailResponse,
    TemplateFieldSchema,
    TemplatePublishRequest,
    TemplateSummaryResponse,
    TemplateVersionSummary,
    TemplateUpdateRequest,
)
from app.services.content_sanitizer import (
    ContentTooLargeError,
    sanitize_editor_content,
    sanitize_page_settings,
)

logger = structlog.get_logger(__name__)

#: "Department not looked up yet" - see TemplateStudioService._dept_id. None is
#: a real answer (the member has no department) and must not be re-queried.
_UNSET = object()

def _reject_repeat_group_collisions(fields: list[dict]) -> None:
    """
    FR-7.10 — a repeating section's name must not be a field key.

    Answers are one flat dict: a normal field lives at `answers[key]` as a
    scalar, and a repeating section lives at `answers[group]` as a LIST of
    rows. If a template declares a field keyed `experience` *and* a repeating
    group named `experience`, they share one slot — whichever is written last
    wins, and the validator's `isinstance(answers[group], list)` check then
    quietly skips the whole section, so required answers inside it stop being
    required. Nothing downstream can detect that, so it is refused here, at
    authoring time, where the author can still rename one of them.
    """
    keys = {
        str(f.get("key") or "").strip().lower()
        for f in fields
        if f.get("key")
    }
    groups: set[str] = set()
    for f in fields:
        val = f.get("validation") or {}
        group = val.get("repeat_group") if isinstance(val, dict) else None
        if group:
            groups.add(str(group).strip().lower())

    clash = sorted(keys & groups)
    if clash:
        raise ValidationException(
            "A repeating section cannot have the same name as a question: "
            + ", ".join(clash)
            + ". Rename one of them — answers for both would be stored in the "
            "same place and overwrite each other."
        )


# Spec §30 — configurable; kept as a module constant until it earns a settings entry.
TEMPLATE_QUOTA_PER_USER = 50

FIELD_COLUMNS = (
    "key", "label", "type", "required", "help_text", "example", "default_value",
    "validation", "format", "options", "if_empty_behavior", "order_index", "section",
)


class TemplateStudioService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = TemplateRepository(db)
        # _UNSET, not None: None is a real answer ("this member has no
        # department") and must not be looked up again on every call.
        self._dept_cache: UUID | None | object = _UNSET

    # ── helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _is_admin(user: AuthUser) -> bool:
        # Org role only, no superadmin bypass: template ownership is an
        # in-organization concept. Deliberately not AuthUser.is_org_admin().
        return "admin" in user.roles

    async def _dept_id(self, user: AuthUser) -> UUID | None:
        """The caller's department, read from their membership.

        The access token carries no department claim, so `AuthUser.dept_id` is
        None for every HTTP caller - which silently disabled the whole "team"
        template scope: a team template was invisible to the department that
        owned it, and `_require_can_edit` could never match. Loading it here
        on demand fixes that without growing the token.

        One query per service instance (so once per request), and only for the
        paths that need it. `user.dept_id` is honoured when a caller already
        populated it (background workers construct AuthUser directly).
        """
        if user.dept_id is not None:
            return user.dept_id
        if self._dept_cache is not _UNSET:
            return self._dept_cache
        if user.org_id is None:
            self._dept_cache = None
            return None
        self._dept_cache = (
            await self.db.execute(
                select(OrganizationMember.dept_id).where(
                    OrganizationMember.org_id == user.org_id,
                    OrganizationMember.user_id == user.id,
                    OrganizationMember.deleted_at.is_(None),
                )
            )
        ).scalars().first()
        return self._dept_cache

    async def _require(self, template_id: UUID, user: AuthUser) -> Template:
        t = await self.repo.get_for_user(
            template_id, user.org_id, user.id, self._is_admin(user),
            await self._dept_id(user),
        )
        if not t:
            # 404 (not 403) so private templates can't be probed by id.
            raise NotFoundException("Template", str(template_id))
        return t

    async def _require_can_edit(self, template: Template, user: AuthUser) -> None:
        """Async because the team-scope branch needs the caller's department,
        which is read from their membership rather than from the token."""
        if template.owner_id == user.id:
            return
        if template.scope in ("system", "org") and self._is_admin(user):
            return
        if template.scope == "team":
            if self._is_admin(user):
                return
            dept_id = await self._dept_id(user)
            if dept_id is not None and template.dept_id == dept_id:
                return
        raise ForbiddenException("You can only edit your own templates")

    async def _version_for(self, template: Template, user: AuthUser) -> TemplateVersion | None:
        """Owners/editors see their working draft; everyone else the published one."""
        can_edit = template.owner_id == user.id or (template.scope == "system" and self._is_admin(user))
        if can_edit:
            return await self.repo.latest_version(template.id)
        if template.current_version_id:
            return await self.repo.get_version(template.current_version_id)
        return await self.repo.latest_version(template.id)

    async def _to_summary(self, t: Template, user: AuthUser, field_count: int = 0,
                          version_no: int | None = None,
                          is_favourite: bool = False) -> TemplateSummaryResponse:
        return TemplateSummaryResponse(
            id=t.id, org_id=t.org_id, owner_id=t.owner_id, scope=t.scope, name=t.name,
            description=t.description, category=t.category, tags=t.tags or [],
            icon=t.icon, color=t.color, status=t.status, usage_count=t.usage_count,
            field_count=field_count, version_no=version_no,
            is_owner=t.owner_id == user.id, is_favourite=is_favourite,
            created_at=t.created_at, updated_at=t.updated_at,
        )

    async def _to_detail(self, t: Template, user: AuthUser) -> TemplateDetailResponse:
        version = await self._version_for(t, user)
        fields: list[TemplateFieldSchema] = []
        placeholders: list[PlaceholderOccurrenceSchema] = []
        if version:
            fields = [
                TemplateFieldSchema(**{c: getattr(f, c) for c in FIELD_COLUMNS})
                for f in await self.repo.list_fields(version.id)
            ]
            placeholders = [
                PlaceholderOccurrenceSchema(field_key=o.field_key, node_id=o.node_id, order_no=o.order_no)
                for o in await self.repo.list_occurrences(version.id)
            ]
        favs = await self.repo.favourite_ids(user.id, [t.id])
        summary = await self._to_summary(
            t, user, len(fields), version.version_no if version else None, t.id in favs
        )
        return TemplateDetailResponse(
            **summary.model_dump(),
            version_id=version.id if version else None,
            content=(version.content or {}) if version else {},
            page_settings=(version.page_settings or {}) if version else {},
            fields=fields,
            placeholders=placeholders,
        )

    async def _editable_version(self, template: Template) -> TemplateVersion:
        """
        The draft version to write into. Editing a PUBLISHED template starts a new
        draft version copied from the published one, so documents already created
        keep pointing at the version they were built from (FR-11.5 / C9).
        """
        latest = await self.repo.latest_version(template.id)
        if latest is None:
            return await self.repo.create_version(template.id, 1)
        if latest.published_at is None:
            return latest

        new_version = await self.repo.create_version(
            template.id,
            await self.repo.next_version_no(template.id),
            content=dict(latest.content or {}),
            page_settings=dict(latest.page_settings or {}),
        )
        await self.repo.replace_fields(
            new_version.id,
            [{c: getattr(f, c) for c in FIELD_COLUMNS} for f in await self.repo.list_fields(latest.id)],
        )
        await self.repo.replace_occurrences(
            new_version.id,
            [
                {"field_key": o.field_key, "node_id": o.node_id, "order_no": o.order_no}
                for o in await self.repo.list_occurrences(latest.id)
            ],
        )
        return new_version

    # ── operations ────────────────────────────────────────────────────────────

    async def list_templates(
        self, user: AuthUser, scope: str | None = None,
        category: str | None = None, q: str | None = None,
        favourites_only: bool = False, include_archived: bool = False,
        published_only: bool = False, sort: str = "recent",
    ) -> list[TemplateSummaryResponse]:
        templates = await self.repo.list_for_user(
            user.org_id, user.id, self._is_admin(user),
            dept_id=await self._dept_id(user), scope=scope, category=category, q=q,
            favourites_only=favourites_only, include_archived=include_archived,
            published_only=published_only, sort=sort,
        )
        # One aggregate query for all field counts rather than N per card.
        version_by_template: dict[UUID, TemplateVersion] = {}
        for t in templates:
            v = await self._version_for(t, user)
            if v:
                version_by_template[t.id] = v
        counts = await self.repo.field_counts([v.id for v in version_by_template.values()])
        favs = await self.repo.favourite_ids(user.id, [t.id for t in templates])
        out = []
        for t in templates:
            v = version_by_template.get(t.id)
            out.append(await self._to_summary(
                t, user, counts.get(v.id, 0) if v else 0,
                v.version_no if v else None, t.id in favs,
            ))
        return out

    async def set_favourite(self, template_id: UUID, user: AuthUser, on: bool) -> TemplateDetailResponse:
        """FR-5.3 — favouriting needs visibility, not ownership."""
        template = await self._require(template_id, user)
        await self.repo.set_favourite(user.id, template.id, on)
        await self.db.commit()
        return await self._to_detail(template, user)

    async def set_archived(self, template_id: UUID, user: AuthUser, archived: bool) -> TemplateDetailResponse:
        """
        FR-5.3 / §11 lifecycle: PUBLISHED → ARCHIVED and back. Archiving hides a
        template from the gallery and frees a quota slot; documents created from
        it are untouched because they are pinned to their own version (C9).
        """
        template = await self._require(template_id, user)
        await self._require_can_edit(template, user)
        if archived:
            template.status = "archived"
        elif template.current_version_id:
            template.status = "published"
        else:
            template.status = "draft"
        await self.db.commit()
        logger.info("template_archive_set", template_id=str(template_id), archived=archived)
        return await self._to_detail(template, user)

    async def get_template(self, template_id: UUID, user: AuthUser) -> TemplateDetailResponse:
        return await self._to_detail(await self._require(template_id, user), user)

    async def create_template(self, user: AuthUser, req: TemplateCreateRequest) -> TemplateDetailResponse:
        scope = (req.scope or "user").lower()
        if scope == "system" and not self._is_admin(user):
            raise ForbiddenException("Only an administrator can create organisation templates")
        if scope not in ("user", "system"):
            raise ValidationException("scope must be 'user' or 'system'")

        # Names are unique per owner (case-insensitive); suggest "Name (2)".
        name = req.name.strip() or "Untitled template"

        if scope == "user":
            # One query answers both the quota and every name-collision probe.
            # Asking separately cost a round trip per existing "Untitled
            # template (n)", which is the bulk of the delay the author sees
            # between clicking "Create from scratch" and the editor opening.
            rows = await self.repo.owned_name_rows(user.org_id, user.id)
            if sum(1 for _, status in rows if status != "archived") >= TEMPLATE_QUOTA_PER_USER:
                raise ConflictException(
                    f"You've reached the limit of {TEMPLATE_QUOTA_PER_USER} templates. "
                    "Archive one to create another."
                )
            taken = {n.strip().lower() for n, _ in rows}
            base, suffix = name, 2
            while name.strip().lower() in taken:
                name = f"{base} ({suffix})"
                suffix += 1

        template, version = await self.repo.create_with_version(
            org_id=user.org_id,
            owner_id=user.id if scope == "user" else None,
            scope=scope,
            name=name,
            description=req.description,
            category=req.category,
            tags=req.tags or [],
            icon=req.icon,
            color=req.color,
            status="draft",
        )
        await self.db.commit()
        logger.info("template_created", template_id=str(template.id), scope=scope)
        # Built directly rather than through _to_detail: a template created a
        # line ago has no fields, no placeholder occurrences and cannot be
        # anyone's favourite yet, so those four queries are four round trips
        # that can only come back empty.
        summary = await self._to_summary(
            template, user, field_count=0, version_no=version.version_no, is_favourite=False
        )
        return TemplateDetailResponse(
            **summary.model_dump(),
            version_id=version.id,
            content=version.content or {},
            page_settings=version.page_settings or {},
            fields=[],
            placeholders=[],
        )

    async def detect_blanks_rules(
        self, template_id: UUID, user: AuthUser, content: dict | None
    ) -> dict:
        """
        FR-7.2 / FR-9.3 — find blanks in the live editor body with the SAME
        deterministic rules the document import uses. No AI: this is pattern
        matching over the text, so it works with the org AI switch off and
        sends nothing anywhere.

        The body is returned rewritten rather than as a list of offsets: the
        import pipeline already knows how to splice a placeholder into a text
        node without disturbing the surrounding formatting, and reimplementing
        that in the browser is how the two would drift apart.
        """
        from app.services.blank_detector import detect as detect_blanks
        from app.services.import_service import (
            MAX_DETECTIONS, apply_detections, _index_text_nodes, verify_untouched,
        )

        template = await self._require(template_id, user)
        await self._require_can_edit(template, user)

        # Untrusted: this body came from a browser and is written straight
        # back into the version row.
        body = sanitize_editor_content(content or {}) if content else {}
        if not body.get("content"):
            return {"content": body, "found": 0, "skipped": [], "fields": []}

        _, text = _index_text_nodes(body)
        detections = detect_blanks(text, limit=MAX_DETECTIONS)
        if not detections:
            return {"content": body, "found": 0, "skipped": [], "fields": []}

        # Don't let a generated key land on an existing question that means
        # something else; an identical label SHOULD share a key (FR-7.4).
        version = await self._editable_version(template)
        existing = {
            f.key: (f.label or "").strip().lower()
            for f in await self.repo.list_fields(version.id)
        }
        for det in detections:
            clash = existing.get(det["key"])
            if clash is not None and clash != (det["label"] or "").strip().lower():
                n = 2
                while f"{det['key']}_{n}" in existing:
                    n += 1
                det["key"] = f"{det['key']}_{n}"

        new_content, applied, skipped = apply_detections(body, detections)
        if not verify_untouched(text, new_content, applied):
            # FR-9.4 — refuse rather than hand back a body we cannot prove
            # is unchanged outside the blanks.
            raise ValidationException(
                "Couldn't add those blanks without changing the text. "
                "Add them by hand in the editor."
            )

        seen: dict[str, dict] = {}
        for det in applied:
            seen.setdefault(det["key"], {
                "key": det["key"], "label": det["label"], "type": det["type"],
            })
        return {
            "content": new_content,
            "found": len(applied),
            "skipped": [
                {"original": d["original"], "reason": d.get("skip_reason", "")}
                for d in skipped
            ],
            "fields": list(seen.values()),
        }

    async def update_template(
        self, template_id: UUID, user: AuthUser, req: TemplateUpdateRequest
    ) -> TemplateDetailResponse:
        template = await self._require(template_id, user)
        await self._require_can_edit(template, user)

        if req.name is not None:
            template.name = req.name.strip() or template.name
        if req.description is not None:
            template.description = req.description
        if req.category is not None:
            template.category = req.category
        if req.tags is not None:
            template.tags = req.tags
        if req.icon is not None:
            template.icon = req.icon
        if req.color is not None:
            template.color = req.color

        touches_version = (
            req.content is not None or req.page_settings is not None
            or req.fields is not None or req.placeholders is not None
        )
        if touches_version:
            version = await self._editable_version(template)
            if req.content is not None:
                # Untrusted: the body is rendered into every viewer's DOM
                # (spec §12 Security, §32 "XSS in pasted HTML").
                try:
                    version.content = sanitize_editor_content(req.content)
                except ContentTooLargeError as exc:
                    raise ValidationException(str(exc)) from exc
            if req.page_settings is not None:
                # FR-6.6 — authored header/footer text ends up drawn on every
                # page of the PDF, so it is validated like any other authored
                # content instead of being stored as sent.
                version.page_settings = sanitize_page_settings(req.page_settings)
            if req.fields is not None:
                field_dicts = [f.model_dump() for f in req.fields]
                _reject_repeat_group_collisions(field_dicts)
                await self.repo.replace_fields(version.id, field_dicts)
            if req.placeholders is not None:
                await self.repo.replace_occurrences(
                    version.id, [p.model_dump() for p in req.placeholders]
                )

        await self.db.commit()
        return await self._to_detail(template, user)

    # ── used by the Documents side (Form Fill) ────────────────────────────────

    async def pin_published_version(self, template_id: UUID, user: AuthUser) -> TemplateVersion:
        """
        Resolve the version a new document should be PINNED to, and count the
        use. Always the template's CURRENT PUBLISHED version — never the owner's
        working draft — so two people starting the same template on the same day
        get the same questions (C9 / FR-11.5 / FR-2.5).
        """
        template = await self._require(template_id, user)
        if template.status == "archived":
            raise ValidationException("This template has been archived and can no longer be used.")
        if not template.current_version_id:
            raise ValidationException(
                "This template hasn't been published yet, so it has no fixed version to fill."
            )
        version = await self.repo.get_version(template.current_version_id)
        if version is None:
            raise ValidationException("This template's published version is missing.")
        await self.repo.increment_usage(template.id)
        return version

    async def pinned_fill_data(self, version_id: UUID) -> tuple[Template | None, TemplateVersion | None, list]:
        """
        Read a document's pinned version WITHOUT a template-visibility check:
        the caller has already authorised the document, and the pin must keep
        working after the template is archived or deleted (C9).
        """
        version = await self.repo.get_version(version_id)
        if version is None:
            return None, None, []
        template = await self.repo.get_template_of_version(version_id)
        fields = await self.repo.list_fields(version.id)
        return template, version, fields

    async def fill_schema(self, template_id: UUID, user: AuthUser):
        """
        FR-12.1 — the questions of a template's PUBLISHED version, with no
        document involved.

        Shares `pin_published_version` with document creation, so "which
        version would a draft be pinned to?" has exactly one answer. The
        wizard renders from this, and the draft is created from the first
        answer — at which point the server pins the version again. If the
        template were republished in between, the draft pins the newer version,
        which is the same race the old flow had and the same resolution: the
        pin is taken when the row is written, never before.
        """
        from app.schemas.document import (
            DocumentFillFieldSchema,
            DocumentFillSchemaResponse,
        )

        template = await self._require(template_id, user)
        version = await self.pin_published_version(template_id, user)
        if version is None:
            raise ValidationException(
                "This template has no published version to fill in yet."
            )
        fields = await self.repo.list_fields(version.id)
        return DocumentFillSchemaResponse(
            document_id=None,
            template_id=template.id,
            template_version_id=version.id,
            template_name=template.name,
            version_no=version.version_no,
            content=version.content or {},
            fields=[
                DocumentFillFieldSchema(
                    key=f.key, label=f.label, type=f.type, required=f.required,
                    help_text=f.help_text, example=f.example, default_value=f.default_value,
                    validation=f.validation or {}, format=f.format, options=f.options or [],
                    if_empty_behavior=f.if_empty_behavior, order_index=f.order_index,
                    section=f.section,
                )
                for f in fields
            ],
            answers={},
            template_deleted=False,
        )

    # ── publish ───────────────────────────────────────────────────────────────

    async def publish_check(self, template_id: UUID, user: AuthUser) -> list[PublishIssue]:
        """The FR-11.2 checklist, as data, so the UI can show it live."""
        template = await self._require(template_id, user)
        version = await self.repo.latest_version(template.id)
        issues: list[PublishIssue] = []

        if not (template.name or "").strip():
            issues.append(PublishIssue(rule="NAME_REQUIRED", message="Template name is required."))

        fields = await self.repo.list_fields(version.id) if version else []
        if not fields:
            issues.append(PublishIssue(
                rule="AT_LEAST_ONE_FIELD",
                message="No blanks found. Without blanks this will be a plain document, not a fillable template.",
            ))

        seen: set[str] = set()
        for f in fields:
            if not (f.label or "").strip():
                issues.append(PublishIssue(rule="FIELD_CONFIGURED", field_key=f.key, message="Question text is missing."))
            if not (f.type or "").strip():
                issues.append(PublishIssue(rule="FIELD_CONFIGURED", field_key=f.key, message="Field type is missing."))
            if f.key in seen:
                issues.append(PublishIssue(rule="DUPLICATE_KEY", field_key=f.key, message=f"Duplicate field key '{f.key}'."))
            seen.add(f.key)

        return issues

    async def publish_template(
        self, template_id: UUID, user: AuthUser, req: TemplatePublishRequest
    ) -> TemplateDetailResponse:
        template = await self._require(template_id, user)
        await self._require_can_edit(template, user)

        # Metadata captured at publish time (FR-11.3).
        if req.name is not None:
            template.name = req.name.strip() or template.name
        if req.description is not None:
            template.description = req.description
        if req.category is not None:
            template.category = req.category
        if req.tags is not None:
            template.tags = req.tags
        if req.icon is not None:
            template.icon = req.icon
        if req.color is not None:
            template.color = req.color
        await self.db.flush()

        issues = await self.publish_check(template_id, user)
        if issues:
            summary = "; ".join(
                f"{i.message}" + (f" (field '{i.field_key}')" if i.field_key else "") for i in issues
            )
            raise ValidationException(f"Template is not ready to publish. {summary}")

        version = await self.repo.latest_version(template.id)
        if version is None:
            raise ValidationException("Template has no content to publish.")

        version.published_at = utcnow()
        template.current_version_id = version.id
        template.status = "published"
        await self.db.commit()
        logger.info("template_published", template_id=str(template.id), version_no=version.version_no)
        return await self._to_detail(template, user)

    # ── version history (FR-14.8) ─────────────────────────────────────────────

    async def list_versions(self, template_id: UUID, user: AuthUser) -> list[TemplateVersionSummary]:
        """
        Every version of this template, newest first.

        Visible to anyone who can see the template, because an approver asking
        "which version was this document built from?" needs to be able to look
        it up. Restoring is a separate, owner-only action.
        """
        template = await self._require(template_id, user)
        versions = await self.repo.list_versions(template.id)
        counts = await self.repo.field_counts([v.id for v in versions])
        return [
            TemplateVersionSummary(
                id=v.id,
                version_no=v.version_no,
                is_published=v.published_at is not None,
                is_current=template.current_version_id == v.id,
                field_count=counts.get(v.id, 0),
                published_at=v.published_at,
                created_at=v.created_at,
            )
            for v in versions
        ]

    async def restore_version(
        self, template_id: UUID, version_id: UUID, user: AuthUser
    ) -> TemplateDetailResponse:
        """
        Restore an earlier version (FR-14.8).

        COPIES the old version forward into a new draft rather than rewinding
        the history. Two reasons, both load-bearing:
          - documents pinned to any earlier version keep working, because no
            existing version row is touched (C9 / FR-11.5);
          - the restore itself is visible in the history, so "we went back to
            v3" is a recorded event rather than a silent edit.
        The restored draft is NOT published — the author reviews it and
        publishes as usual.
        """
        template = await self._require(template_id, user)
        await self._require_can_edit(template, user)

        source = await self.repo.get_version(version_id)
        if source is None or source.template_id != template.id:
            # 404 rather than 403: a version id from another template must not
            # be distinguishable from one that does not exist.
            raise NotFoundException("Template version", str(version_id))

        latest = await self.repo.latest_version(template.id)
        if latest is not None and latest.id == source.id and latest.published_at is None:
            raise ValidationException("That version is already the working draft.")

        target = await self._editable_version(template)
        target.content = dict(source.content or {})
        target.page_settings = dict(source.page_settings or {})
        await self.repo.replace_fields(
            target.id,
            [
                {c: getattr(f, c) for c in FIELD_COLUMNS}
                for f in await self.repo.list_fields(source.id)
            ],
        )
        await self.repo.replace_occurrences(
            target.id,
            [
                {"field_key": o.field_key, "node_id": o.node_id, "order_no": o.order_no}
                for o in await self.repo.list_occurrences(source.id)
            ],
        )
        # Restoring produces an unpublished draft; the published version stays
        # whatever it was until the author publishes again.
        template.status = "draft" if template.current_version_id is None else template.status
        await self.db.commit()
        logger.info(
            "template_version_restored",
            template_id=str(template.id),
            from_version=source.version_no,
            into_version=target.version_no,
        )
        return await self._to_detail(template, user)

    # ── duplicate / delete ────────────────────────────────────────────────────

    async def duplicate_template(self, template_id: UUID, user: AuthUser) -> TemplateDetailResponse:
        source = await self._require(template_id, user)

        owned = await self.repo.count_owned(user.org_id, user.id)
        if owned >= TEMPLATE_QUOTA_PER_USER:
            raise ConflictException(
                f"You've reached the limit of {TEMPLATE_QUOTA_PER_USER} templates. "
                "Archive one to create another."
            )

        name, suffix = f"{source.name} (copy)", 2
        base = name
        while await self.repo.name_exists(user.org_id, user.id, name):
            name = f"{base} ({suffix})"
            suffix += 1

        copy = await self.repo.create(
            org_id=user.org_id, owner_id=user.id, scope="user", name=name,
            description=source.description, category=source.category,
            tags=list(source.tags or []), icon=source.icon, color=source.color,
            status="draft",
        )
        src_version = await self._version_for(source, user)
        new_version = await self.repo.create_version(
            copy.id, 1,
            content=dict(src_version.content or {}) if src_version else {},
            page_settings=dict(src_version.page_settings or {}) if src_version else {},
        )
        if src_version:
            await self.repo.replace_fields(
                new_version.id,
                [{c: getattr(f, c) for c in FIELD_COLUMNS} for f in await self.repo.list_fields(src_version.id)],
            )
            await self.repo.replace_occurrences(
                new_version.id,
                [
                    {"field_key": o.field_key, "node_id": o.node_id, "order_no": o.order_no}
                    for o in await self.repo.list_occurrences(src_version.id)
                ],
            )
        await self.db.commit()
        logger.info("template_duplicated", source_id=str(source.id), copy_id=str(copy.id))
        return await self._to_detail(copy, user)

    async def save_document_as_template(
        self, document, body_content: dict | None, user: AuthUser, req: SaveAsTemplateRequest
    ) -> TemplateDetailResponse:
        """
        FR-5.4 — "Save as template" from an existing document. The DOCUMENT must
        already have been authorised by the caller; this only enforces the
        template-side rules (quota, unique name).

        The copy starts as a DRAFT with no fields: the body carries over, and
        the author marks the blanks in the editor. A freeform document has no
        placeholders to inherit, so inventing any would be guesswork.
        """
        owned = await self.repo.count_owned(user.org_id, user.id)
        if owned >= TEMPLATE_QUOTA_PER_USER:
            raise ConflictException(
                f"You've reached the limit of {TEMPLATE_QUOTA_PER_USER} templates. "
                "Archive one to create another."
            )

        base = (req.name or document.title or "Untitled template").strip()[:255]
        name, suffix = base, 2
        while await self.repo.name_exists(user.org_id, user.id, name):
            name = f"{base} ({suffix})"
            suffix += 1

        template = await self.repo.create(
            org_id=user.org_id, owner_id=user.id, scope="user", name=name,
            description=req.description, category=req.category,
            tags=[], icon=None, color=None, status="draft",
        )
        await self.repo.create_version(
            template.id, 1, content=sanitize_editor_content(body_content or {})
        )
        await self.db.commit()
        logger.info("template_saved_from_document", document_id=str(document.id), template_id=str(template.id))
        return await self._to_detail(template, user)

    async def delete_template(self, template_id: UUID, user: AuthUser) -> None:
        template = await self._require(template_id, user)
        await self._require_can_edit(template, user)
        # Soft delete only — documents created from it keep their pinned version.
        await self.repo.soft_delete(template)
        await self.db.commit()
        logger.info("template_deleted", template_id=str(template_id))
