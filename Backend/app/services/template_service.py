"""
DocFlow Backend — Service: Template

Admin operations for creating, reading, updating, and managing
WorkflowTemplate + WorkflowStage + StageApproverRule.

Only users with `admin:workflow_templates` permission may call this service.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Sequence

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.enums import WorkflowInstanceStatus
from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnprocessableEntityException,
)
from app.models.workflow import WorkflowTemplate
from app.repositories.workflow_repo import (
    WorkflowShareRepository,
    WorkflowStageRepository,
    WorkflowTemplateRepository,
    WorkflowVersionRepository,
)
from app.schemas.workflow_instances import (
    TemplateReviewResponse,
    TemplateReviewStage,
    WorkflowTemplateCreate,
    WorkflowTemplateResponse,
    WorkflowTemplateSummary,
    WorkflowTemplateUpdate,
    WorkflowShareResponse,
    WorkflowShareResult,
    WorkflowVersionSummary,
)

logger = structlog.get_logger(__name__)


class TemplateService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.tmpl_repo = WorkflowTemplateRepository(db)
        self.stage_repo = WorkflowStageRepository(db)
        self.version_repo = WorkflowVersionRepository(db)
        self.share_repo = WorkflowShareRepository(db)

    async def create(
        self,
        org_id: uuid.UUID,
        req: WorkflowTemplateCreate,
        created_by: uuid.UUID | None = None,
        visibility: str = "organization",
        commit: bool = True,
    ) -> WorkflowTemplateResponse:
        """
        Create a WorkflowTemplate with its stages and approver rules in one transaction.

        `commit=False` flushes only and leaves the transaction to the caller,
        so a caller composing a larger all-or-nothing operation (organization
        bootstrap) is never silently committed part-way through.

        `created_by`/`visibility` support §7's user-owned workflows: any member
        can author their own named route; `visibility="private"` keeps it out
        of other members' pickers.
        """
        await self.validate_definition(req.stages, org_id)
        await self._reject_trainee_approvers(req.stages, org_id)
        await self._assert_name_available(
            org_id=org_id, owner_id=created_by, name=req.name
        )
        # Shape and fully validate the stages BEFORE writing anything, so a
        # rejected definition leaves no half-created template behind.
        version_stages = await self._build_version_stages(req.stages, org_id)

        tmpl = await self.tmpl_repo.create(
            org_id=org_id,
            name=req.name,
            description=req.description,
            department_id=req.department_id,
            doc_type_id=req.doc_type_id,
            document_type_scope=req.document_type_scope,
            is_active=req.is_active,
            created_by=created_by,
            visibility=visibility,
        )

        # `version_stages` is in the same sequence_order order as this loop.
        for i, stage_req in enumerate(
            sorted(req.stages, key=lambda s: s.sequence_order)
        ):
            sla_hours, requires_signature = self._legacy_stage_fields(
                stage_req, version_stages[i] if i < len(version_stages) else None
            )
            stage = await self.stage_repo.create(
                template_id=tmpl.id,
                name=stage_req.name,
                sequence_order=stage_req.sequence_order,
                stage_type=stage_req.stage_type,
                min_approvals_required=stage_req.min_approvals_required,
                sla_hours=sla_hours,
                reapproval_on_revision=stage_req.reapproval_on_revision,
                requires_signature=requires_signature,
            )
            for rule in stage_req.approver_rules:
                await self.stage_repo.add_approver_rule(
                    stage_id=stage.id,
                    rule_type=rule.rule_type,
                    rule_value=rule.rule_value,
                )

        # Version 1, immutable (DM-01). The legacy WorkflowStage rows above are
        # still written and are still what the engine executes today; this row
        # is what a run will pin to once the engine moves over, and it is what
        # makes a later edit a NEW version instead of a destructive rewrite.
        version = await self.version_repo.create_version(
            template_id=tmpl.id,
            name=req.name.strip(),
            description=req.description,
            require_full_reapproval=bool(
                getattr(req, "require_full_reapproval", False)
            ),
            created_by=created_by,
            stages=version_stages,
        )
        tmpl.current_version_id = version.id
        tmpl.require_full_reapproval = bool(
            getattr(req, "require_full_reapproval", False)
        )
        await self.db.flush()

        if commit:
            await self.db.commit()
        else:
            await self.db.flush()
        logger.info(
            "template_created",
            template_id=str(tmpl.id),
            org_id=str(org_id),
            version=version.version_number,
        )

        # Reload with stages
        tmpl = await self.tmpl_repo.get_by_id(tmpl.id, org_id)
        return await self._to_response(tmpl)

    async def validate_definition(self, stages: Sequence, org_id: uuid.UUID) -> None:
        """
        Validate a workflow definition before it is saved (§7: "Validate the
        workflow before saving: prevent missing approvers, invalid steps,
        unintended cycles, and configurations that can never reach a terminal
        state").

        Checks:
          1. At least one stage — a workflow with no stages can never
             terminate in an approval.
          2. sequence_order values unique (two stages claiming the same
             position is ambiguous) and non-negative.
          3. Every stage has at least one approver rule — a stage with no
             approvers would resolve to nobody, stalling forever (this is the
             "configurations that can never reach a terminal state" case).
          4. min_approvals_required >= 1 and never more than the number of
             approver rules on that stage, otherwise the gate can never be
             satisfied.
          5. Each rule is a known rule_type and carries the fields that type
             needs (a `specific_user` rule with no user_id resolves to
             nobody; a `role_in_department` rule with no role_name likewise).
          6. `specific_user` targets must be real, active members of this org
             (a stale user id from another org silently resolves to nobody).

        Cycles are structurally impossible in this engine — stages execute in
        ascending integer `sequence_order` and advance_stage() only ever
        moves forward to a strictly greater order — so the equivalent risk
        here is a stage that can never complete, which checks 3-6 cover.
        """
        from sqlalchemy import select

        from app.domain.enums import ApproverRuleType
        from app.models.organization import OrganizationMember

        if not stages:
            raise ConflictException(
                "A workflow needs at least one approval stage — otherwise a "
                "submitted document could never reach an approved state."
            )

        orders = [s.sequence_order for s in stages]
        if len(orders) != len(set(orders)):
            raise ConflictException("Stage sequence_order values must be unique within a template")
        if any(o < 0 for o in orders):
            raise ConflictException("Stage sequence_order values cannot be negative")

        known_rule_types = {str(t) for t in ApproverRuleType}
        specific_user_ids: set[uuid.UUID] = set()

        for stage in stages:
            label = getattr(stage, "name", None) or f"stage {stage.sequence_order}"
            rules = list(stage.approver_rules or [])
            if not rules:
                raise ConflictException(
                    f"'{label}' has no approvers configured. Every stage needs at "
                    "least one approver rule, or a document submitted through this "
                    "workflow would stall at that stage forever."
                )

            min_required = getattr(stage, "min_approvals_required", 1) or 1
            if min_required < 1:
                raise ConflictException(
                    f"'{label}' requires at least 1 approval (got {min_required})."
                )
            if min_required > len(rules):
                raise ConflictException(
                    f"'{label}' requires {min_required} approvals but only has "
                    f"{len(rules)} approver rule(s) — that gate could never be met."
                )

            for rule in rules:
                if rule.rule_type not in known_rule_types:
                    raise ConflictException(
                        f"'{label}' has an unknown approver rule type "
                        f"'{rule.rule_type}'."
                    )
                value = rule.rule_value or {}
                if rule.rule_type == ApproverRuleType.SPECIFIC_USER:
                    raw = value.get("user_id")
                    if not raw:
                        raise ConflictException(
                            f"'{label}' has a 'specific person' approver rule with no "
                            "user selected."
                        )
                    try:
                        specific_user_ids.add(uuid.UUID(str(raw)))
                    except ValueError:
                        raise ConflictException(
                            f"'{label}' has an invalid approver user id: {raw!r}"
                        ) from None
                elif rule.rule_type == ApproverRuleType.ROLE_IN_DEPARTMENT:
                    if not value.get("role_name"):
                        raise ConflictException(
                            f"'{label}' has a 'role' approver rule with no role selected."
                        )
                elif rule.rule_type == ApproverRuleType.DYNAMIC_BY_AMOUNT_THRESHOLD:
                    if value.get("threshold") is None or not value.get("field"):
                        raise ConflictException(
                            f"'{label}' has an amount-threshold rule missing its "
                            "'field' or 'threshold'."
                        )

        if specific_user_ids:
            rows = (
                await self.db.execute(
                    select(OrganizationMember.user_id).where(
                        OrganizationMember.org_id == org_id,
                        OrganizationMember.user_id.in_(specific_user_ids),
                        OrganizationMember.status == "active",
                        OrganizationMember.deleted_at.is_(None),
                    )
                )
            ).scalars().all()
            missing = specific_user_ids - set(rows)
            if missing:
                raise ConflictException(
                    "These approver(s) are not active members of this organization: "
                    + ", ".join(str(m) for m in sorted(missing, key=str))
                )

    async def _reject_trainee_approvers(self, stages: Sequence, org_id: uuid.UUID) -> None:
        """
        Validate at configuration time (not just at runtime resolution) that no
        `specific_user` approver rule targets a trainee — Trainees never have
        approval authority (see domain/enums.py SYSTEM_ROLES). Rejecting here
        gives the admin an immediate, actionable 400 instead of a silently
        skipped approver discovered later at submit time.
        """
        user_ids: set[uuid.UUID] = set()
        for stage in stages:
            for rule in stage.approver_rules:
                if rule.rule_type == "specific_user":
                    raw = rule.rule_value.get("user_id")
                    if raw:
                        try:
                            user_ids.add(uuid.UUID(str(raw)))
                        except ValueError:
                            pass
        if not user_ids:
            return

        from sqlalchemy import select
        from app.models.organization import OrganizationMember, Role
        from app.models.user import User

        result = await self.db.execute(
            select(User.name, User.email)
            .select_from(OrganizationMember)
            .join(Role, Role.id == OrganizationMember.role_id)
            .join(User, User.id == OrganizationMember.user_id)
            .where(
                OrganizationMember.org_id == org_id,
                OrganizationMember.user_id.in_(user_ids),
                Role.name == "trainee",
            )
        )
        trainees = [name or email for name, email in result.all()]
        if trainees:
            raise ForbiddenException(
                "Trainees cannot be assigned as approvers: " + ", ".join(trainees)
            )

    async def _to_response(self, tmpl) -> WorkflowTemplateResponse:
        """Serialize a template and restore the fields only the version row has.

        Every read of a full template goes through here. `workflow_stages`
        predates the Workflow module and carries no department and no
        due-within wording (§5.5 fields C/D), while the immutable
        `workflow_version_stages` row written beside it carries both. Without
        this, loading a workflow into the edit form dropped the department of
        every stage - and with it the department-mandated signing lock
        (WF-STG-20) - and showed the deadline re-derived from hours instead of
        the words the owner chose.

        Anything missing stays None: a template created before versioning
        existed has no current version, and that is a legitimate state rather
        than an error.
        """
        resp = WorkflowTemplateResponse.model_validate(tmpl)
        if not resp.stages or not getattr(tmpl, "current_version_id", None):
            return resp

        from app.models.workflow import WorkflowVersionStage

        rows = (
            await self.db.execute(
                select(WorkflowVersionStage)
                .where(WorkflowVersionStage.version_id == tmpl.current_version_id)
                .order_by(WorkflowVersionStage.position)
            )
        ).scalars().all()
        if not rows:
            return resp

        # Stage names are unique within a workflow (enforced in
        # _build_version_stages), so the name is a reliable join. Position is
        # the fallback for a legacy row whose name was changed outside the
        # versioned path.
        by_name = {(r.name or "").strip().casefold(): r for r in rows}
        ordered = sorted(resp.stages, key=lambda st: st.sequence_order)

        pairs: list[tuple] = []
        for i, stage in enumerate(ordered):
            match = by_name.get((stage.name or "").strip().casefold())
            if match is None and len(rows) == len(ordered):
                match = rows[i]
            if match is not None:
                pairs.append((stage, match))

        if not pairs:
            return resp

        dept_ids = {m.department_id for _, m in pairs if m.department_id}
        user_ids = {m.approver_user_id for _, m in pairs if m.approver_user_id}

        dept_names: dict[uuid.UUID, str] = {}
        if dept_ids:
            from app.models.organization import Department

            result = await self.db.execute(
                select(Department.id, Department.name).where(
                    Department.id.in_(dept_ids)
                )
            )
            dept_names = {d_id: name for d_id, name in result.all()}

        user_names: dict[uuid.UUID, str] = {}
        if user_ids:
            from app.models.user import User

            result = await self.db.execute(
                select(User.id, User.name, User.email).where(User.id.in_(user_ids))
            )
            user_names = {u_id: (name or email) for u_id, name, email in result.all()}

        for stage, match in pairs:
            stage.department_id = match.department_id
            stage.department_name = (
                dept_names.get(match.department_id) if match.department_id else None
            )
            stage.due_within_value = match.due_within_value
            stage.due_within_unit = match.due_within_unit
            stage.approver_user_id = match.approver_user_id
            stage.approver_name = (
                user_names.get(match.approver_user_id)
                if match.approver_user_id
                else None
            )

        return resp

    async def get(self, template_id: uuid.UUID, org_id: uuid.UUID) -> WorkflowTemplateResponse:
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        return await self._to_response(tmpl)

    async def get_readable(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        actor_id: uuid.UUID,
        is_admin: bool = False,
    ) -> WorkflowTemplateResponse:
        """Read the full definition as owner, grantee or org admin.

        WF-OWN-05 gives a grantee the right to "view the full configuration
        (stages, approvers, departments, deadlines, signing flags)", so the
        plain visibility check is not enough on its own: a LIVE share grants
        read on a private workflow. Anything else is 404 rather than 403, so
        a refusal never confirms that the workflow exists (WF-OWN-10, E28).
        """
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        await self._assert_can_read(tmpl, actor_id, is_admin)
        return await self._to_response(tmpl)

    async def _assert_can_read(self, tmpl, actor_id, is_admin: bool = False) -> None:
        """May this caller SEE that this workflow exists, and read it?

        Owner, org admin, any member of an organization-visible workflow, or
        a live grantee (WF-OWN-05). Everyone else gets 404 rather than 403, so
        a refusal never confirms existence (WF-OWN-10, E28).

        Separate from the owner-only checks that follow it: a grantee passes
        HERE and then fails those with 403, which is correct — they can see
        the workflow, they simply may not edit, re-share or delete it. Using
        404 for them would deny something they can plainly already read.
        """
        if is_admin or tmpl.created_by == actor_id or tmpl.visibility != "private":
            return
        if await self.share_repo.get_active(tmpl.id, actor_id):
            return
        raise NotFoundException("WorkflowTemplate not found")

    async def get_review(self, template_id: uuid.UUID, org_id: uuid.UUID) -> TemplateReviewResponse:
        """
        Non-admin, read-only view of a template for the pre-submit "review
        your workflow" step: ordered stages with a human-readable approver
        description instead of raw rule_type/rule_value, so a normal
        submitter can see who will approve their document without needing
        admin:users permission to resolve a specific_user's name themselves.
        """
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")

        # Resolve any specific_user rule_value user_ids to display names in
        # one batch query rather than one per rule.
        user_ids: set[uuid.UUID] = set()
        for stage in tmpl.stages:
            for rule in stage.approver_rules:
                if rule.rule_type == "specific_user" and rule.rule_value.get("user_id"):
                    try:
                        user_ids.add(uuid.UUID(str(rule.rule_value["user_id"])))
                    except ValueError:
                        pass

        names: dict[uuid.UUID, str] = {}
        if user_ids:
            from sqlalchemy import select
            from app.models.user import User
            result = await self.db.execute(
                select(User.id, User.name, User.email).where(User.id.in_(user_ids))
            )
            for uid, name, email in result.all():
                names[uid] = name or email

        def _describe(rule_type: str, rule_value: dict) -> str:
            if rule_type == "specific_user":
                uid = rule_value.get("user_id")
                try:
                    return names.get(uuid.UUID(str(uid)), "A specific person")
                except (ValueError, TypeError):
                    return "A specific person"
            if rule_type == "role_in_department":
                role = rule_value.get("role_name", "worker")
                return f"Any '{role}' in the relevant department"
            if rule_type == "manager_of_requester":
                return "The submitter's direct manager"
            return "An assigned approver"

        stages = sorted(tmpl.stages, key=lambda s: s.sequence_order)
        review_stages = [
            TemplateReviewStage(
                name=stage.name,
                sequence_order=stage.sequence_order,
                approver_summary=" or ".join(
                    _describe(r.rule_type, r.rule_value) for r in stage.approver_rules
                ) or "No approver configured",
                sla_hours=stage.sla_hours,
                requires_signature=stage.requires_signature,
            )
            for stage in stages
        ]
        return TemplateReviewResponse(
            id=tmpl.id, name=tmpl.name, description=tmpl.description, stages=review_stages
        )

    async def list(
        self,
        org_id: uuid.UUID,
        active_only: bool = True,
        department_id: uuid.UUID | None = None,
        *,
        visible_to_user_id: uuid.UUID | None = None,
        include_private_of_others: bool = False,
        owned_by: uuid.UUID | None = None,
        search: str | None = None,
    ) -> list[WorkflowTemplateSummary]:
        templates = await self.tmpl_repo.list_for_org(
            org_id,
            active_only,
            department_id,
            visible_to_user_id=visible_to_user_id,
            include_private_of_others=include_private_of_others,
            owned_by=owned_by,
            search=search,
        )
        return [WorkflowTemplateSummary.model_validate(t) for t in templates]

    # ── Ownership (§7) ──────────────────────────────────────────────────────

    @staticmethod
    def _assert_can_edit(
        tmpl: WorkflowTemplate,
        actor_id: uuid.UUID,
        is_admin: bool,
    ) -> None:
        """
        §7: "Prevent unauthorized users from editing another user's private
        workflow unless sharing or administration permissions allow it."

        Owner or org administrator only. Legacy templates with no
        `created_by` are org-level and therefore admin-managed.
        """
        if is_admin:
            return
        if tmpl.created_by is None:
            raise ForbiddenException(
                "This is an organization-level workflow — only an organization "
                "administrator can change it."
            )
        if tmpl.created_by != actor_id:
            raise ForbiddenException("You can only modify workflows you created")

    @staticmethod
    def _assert_can_view(
        tmpl: WorkflowTemplate,
        actor_id: uuid.UUID,
        is_admin: bool,
    ) -> None:
        if is_admin:
            return
        if tmpl.visibility == "private" and tmpl.created_by != actor_id:
            raise NotFoundException("WorkflowTemplate not found")

    async def update(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        req: WorkflowTemplateUpdate,
        actor_id: uuid.UUID | None = None,
        is_admin: bool = True,
    ) -> WorkflowTemplateResponse:
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        if actor_id is not None:
            self._assert_can_edit(tmpl, actor_id, is_admin)

        updates = req.model_dump(exclude_none=True)
        # `stages` is not a column on the template; it becomes a new version.
        updates.pop("stages", None)

        if req.name is not None:
            await self._assert_name_available(
                org_id=org_id,
                owner_id=tmpl.created_by,
                name=req.name,
                exclude_template_id=template_id,
            )

        # DM-01: every saved EDIT of the definition writes a new immutable
        # version and never touches an existing one. The stage rows a run
        # already pinned therefore stay exactly as they were, which is what
        # DM-02/BR-02 require — and is why this no longer has to refuse the
        # edit the way it did before versioning existed.
        #
        # An identical stage list is NOT a definition change: the builder
        # re-sends `stages` on every save, so treating that as an edit would
        # mint a new version each time someone fixed a typo in the name.
        #
        # The comparison runs on the NORMALIZED definition, not on the raw
        # request against the legacy `workflow_stages` rows. Those rows have
        # no department and no due-within columns, so a stage whose only
        # change was its department or its deadline wording compared equal
        # and the edit was silently dropped - no new version, nothing saved,
        # and the UI reporting success. `_build_version_stages()` writes
        # nothing; it validates and shapes, which also means a department
        # left blank is resolved to the approver's own on BOTH sides before
        # they are compared, so re-sending an unchanged list is still the
        # no-op the builder relies on.
        version_stages = None
        stages_changed = False
        if req.stages is not None:
            await self.validate_definition(req.stages, org_id)
            await self._reject_trainee_approvers(req.stages, org_id)
            version_stages = await self._build_version_stages(req.stages, org_id)
            stages_changed = await self._definition_changed(
                tmpl, version_stages, req.stages
            )

        new_version = None
        if stages_changed:
            assert version_stages is not None  # set together with stages_changed

            new_version = await self.version_repo.create_version(
                template_id=tmpl.id,
                name=(req.name or tmpl.name).strip(),
                description=(
                    req.description if req.description is not None
                    else tmpl.description
                ),
                require_full_reapproval=(
                    req.require_full_reapproval
                    if req.require_full_reapproval is not None
                    else tmpl.require_full_reapproval
                ),
                created_by=actor_id,
                stages=version_stages,
            )
            updates["current_version_id"] = new_version.id

            # Keep the legacy stage rows in step so the existing engine keeps
            # executing the definition the owner just saved. These rows are
            # REPLACED, not versioned - the version row above is the durable
            # record. Safe only because this is additive: nothing reads a
            # deleted stage once the run that used it has its own snapshot.
            await self._replace_legacy_stages(tmpl, req.stages, version_stages)

        if updates:
            # `version` stays as the human-facing counter it has always been;
            # the authoritative history now lives in workflow_template_versions.
            updates["version"] = tmpl.version + 1
            await self.tmpl_repo.update(template_id, org_id, **updates)

        await self.db.commit()
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        logger.info(
            "template_updated",
            template_id=str(template_id),
            stages_changed=stages_changed,
            new_version=(new_version.version_number if new_version else None),
        )
        return await self._to_response(tmpl)

    async def _definition_changed(
        self, tmpl, built: Sequence[dict], raw: Sequence
    ) -> bool:
        """Does `built` describe a different definition than the current version?

        `built` is the output of `_build_version_stages()`: validated,
        normalized and in execution order. The stored side is the template's
        current `workflow_version_stages`, which is the only place the
        department, the due-within wording and the forced signing flag are
        recorded. Comparing these two is what makes a department-only or
        deadline-only edit detectable.

        A template with no current version (created before versioning) has
        nothing to compare against, so it falls back to the legacy
        fingerprint over `workflow_stages`.
        """
        version_id = getattr(tmpl, "current_version_id", None)
        if not version_id:
            return self._stages_differ(tmpl.stages, raw)

        from app.models.workflow import WorkflowVersionStage

        rows = (
            await self.db.execute(
                select(WorkflowVersionStage)
                .where(WorkflowVersionStage.version_id == version_id)
                .order_by(WorkflowVersionStage.position)
            )
        ).scalars().all()
        if not rows:
            return self._stages_differ(tmpl.stages, raw)

        def stored_fp(r) -> tuple:
            return (
                (r.name or "").strip().casefold(),
                str(r.approver_type),
                str(r.approver_user_id) if r.approver_user_id else None,
                str(r.department_id) if r.department_id else None,
                int(r.due_within_value),
                str(r.due_within_unit),
                int(r.due_within_hours),
                bool(r.require_signing),
            )

        def built_fp(d: dict) -> tuple:
            return (
                (d.get("name") or "").strip().casefold(),
                str(d.get("approver_type")),
                str(d["approver_user_id"]) if d.get("approver_user_id") else None,
                str(d["department_id"]) if d.get("department_id") else None,
                int(d["due_within_value"]),
                str(d["due_within_unit"]),
                int(d["due_within_hours"]),
                bool(d.get("require_signing", False)),
            )

        # Order is part of the definition here, unlike the legacy fingerprint:
        # `built` is already sorted by sequence_order and `rows` by position,
        # so reordering two otherwise identical stages is a real change
        # (WF-STG-02) and must mint a version.
        return [stored_fp(r) for r in rows] != [built_fp(d) for d in built]

    @staticmethod
    def _stages_differ(stored: Sequence, incoming: Sequence) -> bool:
        """True when `incoming` describes a different definition than `stored`.

        The legacy fallback for a template with no current version, used only
        by `_definition_changed()`. It can see no department and no
        due-within wording, because `workflow_stages` has no column for
        either - which is exactly why the versioned comparison is preferred
        wherever a version exists. Compares only what actually defines
        behaviour, so re-ordering the JSON array or changing letter case in a
        name is not mistaken for a real edit.
        """
        import json

        def rules_of(stage) -> tuple:
            return tuple(sorted(
                (
                    str(getattr(r, "rule_type", "")),
                    json.dumps(getattr(r, "rule_value", None) or {},
                               sort_keys=True, default=str),
                )
                for r in (getattr(stage, "approver_rules", None) or [])
            ))

        def fingerprint(stage) -> tuple:
            return (
                int(getattr(stage, "sequence_order", 0) or 0),
                (getattr(stage, "name", "") or "").strip().casefold(),
                str(getattr(stage, "stage_type", "sequential") or "sequential"),
                int(getattr(stage, "min_approvals_required", 1) or 1),
                getattr(stage, "sla_hours", None),
                bool(getattr(stage, "reapproval_on_revision", False)),
                bool(getattr(stage, "requires_signature", False)),
                rules_of(stage),
            )

        return (
            sorted(fingerprint(s) for s in (stored or []))
            != sorted(fingerprint(s) for s in (incoming or []))
        )

    async def set_active(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        is_active: bool,
        actor_id: uuid.UUID | None = None,
        is_admin: bool = True,
    ) -> WorkflowTemplateResponse:
        """Enable/disable a workflow (§7) without editing its definition.
        Disabling hides it from pickers; in-flight instances keep running
        against their own snapshot."""
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        if actor_id is not None:
            self._assert_can_edit(tmpl, actor_id, is_admin)

        await self.tmpl_repo.update(template_id, org_id, is_active=is_active)
        await self.db.commit()
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        logger.info("template_active_toggled", template_id=str(template_id), is_active=is_active)
        return await self._to_response(tmpl)

    async def duplicate(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        actor_id: uuid.UUID,
        is_admin: bool = False,
        new_name: str | None = None,
    ) -> WorkflowTemplateResponse:
        """
        Copy an existing workflow into a new one owned by the caller (§7
        "duplicate"). The copy starts private to its new owner so duplicating
        someone else's org workflow never silently publishes a variant of it.
        """
        src = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not src:
            raise NotFoundException("WorkflowTemplate not found")
        self._assert_can_view(src, actor_id, is_admin)

        copy = await self.tmpl_repo.create(
            org_id=org_id,
            name=new_name or f"{src.name} (copy)",
            description=src.description,
            department_id=src.department_id,
            doc_type_id=src.doc_type_id,
            document_type_scope=src.document_type_scope,
            is_active=src.is_active,
            created_by=actor_id,
            visibility="private",
        )

        for stage in sorted(src.stages, key=lambda s: s.sequence_order):
            new_stage = await self.stage_repo.create(
                template_id=copy.id,
                name=stage.name,
                sequence_order=stage.sequence_order,
                stage_type=stage.stage_type,
                min_approvals_required=stage.min_approvals_required,
                sla_hours=stage.sla_hours,
                reapproval_on_revision=stage.reapproval_on_revision,
                requires_signature=stage.requires_signature,
            )
            for rule in stage.approver_rules:
                await self.stage_repo.add_approver_rule(
                    stage_id=new_stage.id,
                    rule_type=rule.rule_type,
                    rule_value=rule.rule_value,
                )

        await self.db.commit()
        logger.info(
            "template_duplicated",
            source_id=str(template_id),
            new_id=str(copy.id),
            owner=str(actor_id),
        )
        copy = await self.tmpl_repo.get_by_id(copy.id, org_id)
        return await self._to_response(copy)

    async def delete(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
        is_admin: bool = True,
    ) -> None:
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        if actor_id is not None:
            self._assert_can_edit(tmpl, actor_id, is_admin)

        # WF-LC-04: deletion is blocked while any run is still in flight.
        # Those runs would otherwise lose the definition they are executing,
        # and §4.3 A is explicit that historic runs keep their pinned version
        # for audit. The message points at archive, which WF-LIST-07 offers
        # as the way through.
        in_flight = await self._in_flight_run_count(template_id)
        if in_flight:
            raise ConflictException(
                f"This workflow has {in_flight} document(s) still in approval, "
                "so it cannot be deleted. Archive it instead — archiving hides "
                "it from new submissions and lets those runs finish."
            )

        # WF-LC-04: deleting also revokes the shares, so a grantee is not left
        # with a dangling entry in their list and picker.
        revoked = await self.share_repo.revoke_all(
            template_id=template_id, revoked_by=actor_id or tmpl.created_by
        )

        success = await self.tmpl_repo.soft_delete(template_id, org_id)
        if not success:
            raise NotFoundException("WorkflowTemplate not found")

        if actor_id is not None:
            await self._write_audit(
                org_id=org_id,
                actor_id=actor_id,
                action="workflow.deleted",
                resource_type="WorkflowTemplate",
                resource_id=template_id,
                after={"shares_revoked": revoked},
            )
        await self.db.commit()
        logger.info(
            "template_deleted",
            template_id=str(template_id),
            shares_revoked=revoked,
        )

    # ── Versioning helpers (DM-01..04) ──────────────────────────────────────

    # Spec limits. Both configurable on the server per O-5; the client's copy
    # of them is a convenience only (WF-STG-28).
    MAX_STAGES = 10
    MIN_DUE_WITHIN_HOURS = 1
    MAX_DUE_WITHIN_HOURS = 720  # 30 days

    _RULE_TO_APPROVER_TYPE = {
        "specific_user": "specific_user",
        "manager_of_requester": "submitter_manager",
    }

    async def _department_requires_signature(
        self, department_id: uuid.UUID | None
    ) -> bool:
        """Does this department, or any ancestor, require a signature?

        Decision Q6 (AUDIT/DECISIONS.md): the flag is INHERITED down the
        department tree. Without inheritance a sub-department of Finance would
        silently accept an unsigned approval, which is exactly the signing
        bypass G9 warns about. Identification is by the attribute or the id,
        never by matching the name "Finance" — WF-STG-20 forbids a name match
        because a rename would quietly disable the rule.

        The walk is depth-capped so a cycle in `parent_id` (which the schema
        does not prevent) can never hang a request.
        """
        if department_id is None:
            return False

        from app.models.organization import Department

        seen: set[uuid.UUID] = set()
        current_id: uuid.UUID | None = department_id
        for _ in range(16):
            if current_id is None or current_id in seen:
                return False
            seen.add(current_id)
            dept = await self.db.get(Department, current_id)
            if dept is None:
                return False
            if dept.requires_signature:
                return True
            current_id = dept.parent_id
        logger.warning(
            "department_parent_chain_too_deep", department_id=str(department_id)
        )
        return False

    @staticmethod
    def _legacy_stage_fields(stage_req, built: dict | None) -> tuple[int | None, bool]:
        """(sla_hours, requires_signature) for the legacy `workflow_stages` row.

        That row used to be written from the raw request while the version row
        was written from the normalized definition, so the two disagreed:
          * a client sending only `due_within_value`/`due_within_unit` got a
            legacy row with `sla_hours = NULL` - no deadline on the rows the
            engine still executes; and
          * the department-forced signing flag (WF-STG-20) reached the version
            row but not the legacy one.
        `sla_hours` is derived only when the request was explicit about the
        deadline; a stage that says nothing keeps NULL exactly as before.
        """
        sla_hours = stage_req.sla_hours
        requires_signature = bool(stage_req.requires_signature)
        if built is not None:
            explicit = (
                getattr(stage_req, "due_within_value", None) is not None
                and getattr(stage_req, "due_within_unit", None) is not None
            )
            if sla_hours is None and explicit:
                sla_hours = int(built["due_within_hours"])
            requires_signature = requires_signature or bool(
                built.get("require_signing", False)
            )
        return sla_hours, requires_signature

    @staticmethod
    def _due_within(stage) -> tuple[int, str, int]:
        """Resolve (value, unit, hours) for a stage.

        Accepts either the explicit value+unit the builder sends or the legacy
        `sla_hours`, so existing callers keep working (WF-STG-28). Falls back
        to the §5.5 field D default of 2 days when a stage says nothing.
        """
        value = getattr(stage, "due_within_value", None)
        unit = getattr(stage, "due_within_unit", None)
        if value is not None and unit is not None:
            hours = value * 24 if unit == "days" else value
            return int(value), unit, int(hours)

        hours = getattr(stage, "sla_hours", None)
        if hours is None:
            return 2, "days", 48
        hours = int(hours)
        if hours % 24 == 0:
            return hours // 24, "days", hours
        return hours, "hours", hours

    async def _build_version_stages(
        self, stages: Sequence, org_id: uuid.UUID
    ) -> list[dict]:
        """Validate a stage list and shape it for WorkflowVersionRepository.

        This is where the Workflow module's stage rules are enforced on the
        server, in addition to the structural checks in validate_definition():
        the stage cap (WF-STG-03), name rules, the due-within range (O-5), the
        approver-department match (WF-STG-22), and the Finance signing rule
        (WF-STG-20) — which is FORCED here rather than trusted from the
        request body, so a tampered `requireSigning: false` cannot get through
        (E22, T14).
        """
        from app.models.organization import Department
        from app.models.user import User

        ordered = sorted(stages, key=lambda s: s.sequence_order)
        if not ordered:
            raise ConflictException(
                "A workflow needs at least one approval stage — otherwise a "
                "submitted document could never reach an approved state."
            )
        if len(ordered) > self.MAX_STAGES:
            raise ConflictException(
                f"A workflow can have at most {self.MAX_STAGES} stages."
            )

        seen_names: set[str] = set()
        built: list[dict] = []

        for stage in ordered:
            label = (getattr(stage, "name", "") or "").strip()
            if len(label) < 2 or len(label) > 80:
                raise ConflictException(
                    f"Stage name {label!r} must be between 2 and 80 characters."
                )
            key = label.casefold()
            if key in seen_names:
                raise ConflictException("Stage names must be unique in a workflow.")
            seen_names.add(key)

            rules = list(getattr(stage, "approver_rules", None) or [])
            if len(rules) != 1:
                # v1 is strictly sequential with exactly one approver per
                # stage (BR-03). Parallel approval is out of scope (§2.1), and
                # the data model keeps room for it without exposing it.
                raise ConflictException(
                    f"'{label}' must have exactly one approver. Multiple "
                    "approvers at one stage are not supported in this version."
                )
            rule = rules[0]
            approver_type = self._RULE_TO_APPROVER_TYPE.get(rule.rule_type)
            if approver_type is None:
                raise ConflictException(
                    f"'{label}' uses approver rule '{rule.rule_type}', which this "
                    "version does not support. Choose a specific person or the "
                    "submitter's manager."
                )

            approver_user_id: uuid.UUID | None = None
            if approver_type == "specific_user":
                raw = (rule.rule_value or {}).get("user_id")
                if not raw:
                    raise ConflictException(
                        f"'{label}' has a 'specific person' approver rule with no "
                        "user selected."
                    )
                try:
                    approver_user_id = uuid.UUID(str(raw))
                except ValueError:
                    raise ConflictException(
                        f"'{label}' has an invalid approver user id: {raw!r}"
                    ) from None

            department_id = getattr(stage, "department_id", None)

            # WF-STG-22: for a specific-user stage the approver's primary
            # department must be the stage department. O-7's default is that
            # cross-department approvers are NOT allowed; when no department
            # is given we adopt the approver's own, which keeps the signing
            # rule meaningful instead of leaving it unset.
            if approver_user_id is not None:
                approver = await self.db.get(User, approver_user_id)
                if approver is None:
                    raise ConflictException(
                        f"'{label}' names an approver who does not exist."
                    )
                if department_id is None:
                    department_id = approver.department_id
                elif (
                    approver.department_id is not None
                    and approver.department_id != department_id
                ):
                    raise ConflictException(
                        "The selected approver does not belong to this department."
                    )

            if department_id is not None:
                dept = await self.db.get(Department, department_id)
                if dept is None or dept.org_id != org_id:
                    raise ConflictException(
                        f"'{label}' names a department that does not exist in this "
                        "organization."
                    )

            value, unit, hours = self._due_within(stage)
            if not (self.MIN_DUE_WITHIN_HOURS <= hours <= self.MAX_DUE_WITHIN_HOURS):
                raise ConflictException(
                    "Enter a due time between 1 hour and 30 days."
                )

            # WF-STG-20 / BR-08: the server decides this, not the client.
            require_signing = bool(getattr(stage, "requires_signature", False))
            if await self._department_requires_signature(department_id):
                require_signing = True

            built.append({
                "name": label,
                "approver_type": approver_type,
                "approver_user_id": approver_user_id,
                "department_id": department_id,
                "due_within_value": value,
                "due_within_unit": unit,
                "due_within_hours": hours,
                "require_signing": require_signing,
            })

        return built

    async def _assert_name_available(
        self,
        *,
        org_id: uuid.UUID,
        owner_id: uuid.UUID | None,
        name: str,
        exclude_template_id: uuid.UUID | None = None,
    ) -> None:
        """§5.3: a workflow name is 3-100 characters and unique among the
        owner's own non-deleted workflows, case-insensitively."""
        trimmed = (name or "").strip()
        if len(trimmed) < 3 or len(trimmed) > 100:
            raise ConflictException(
                "Enter a workflow name (at least 3 characters, at most 100)."
            )
        if owner_id is None:
            return

        from sqlalchemy import func as sa_func

        q = select(WorkflowTemplate.id).where(
            WorkflowTemplate.org_id == org_id,
            WorkflowTemplate.created_by == owner_id,
            WorkflowTemplate.deleted_at.is_(None),
            sa_func.lower(WorkflowTemplate.name) == trimmed.casefold(),
        )
        if exclude_template_id is not None:
            q = q.where(WorkflowTemplate.id != exclude_template_id)
        if (await self.db.execute(q)).first() is not None:
            raise ConflictException("You already have a workflow with this name.")

    async def _in_flight_run_count(self, template_id: uuid.UUID) -> int:
        """Runs still moving through this workflow.

        Used by WF-BLD-06's banner and by WF-LC-04's delete guard. Terminal
        runs do not count: they keep their pinned version for audit and are
        unaffected by anything done to the definition (DM-02).
        """
        from app.models.workflow import WorkflowInstance

        terminal = (
            WorkflowInstanceStatus.APPROVED,
            WorkflowInstanceStatus.REJECTED,
            WorkflowInstanceStatus.CANCELLED,
            WorkflowInstanceStatus.COMPLETED,
            WorkflowInstanceStatus.FINALIZED,
        )
        result = await self.db.execute(
            select(func.count())
            .select_from(WorkflowInstance)
            .where(
                WorkflowInstance.template_id == template_id,
                WorkflowInstance.status.notin_([str(s) for s in terminal]),
            )
        )
        return int(result.scalar() or 0)

    async def _replace_legacy_stages(
        self, tmpl, stages: Sequence, built: Sequence[dict] | None = None
    ) -> None:
        """Rewrite the legacy WorkflowStage rows to match a new version.

        The engine still executes `workflow_stages`, so a saved edit has to be
        reflected there or the owner would see "Version 3" while submissions
        kept routing by version 2.

        Deleting a stage row is only safe when nothing references it:
        `approval_steps.stage_id` and `workflow_instances.current_stage_id`
        both point at it with no ON DELETE, so a stage that any run has
        touched must be left alone. Rows that are still referenced are kept
        and the new definition is added alongside; the durable record of what
        changed is the version row, which is never rewritten.
        """
        from sqlalchemy import or_

        from app.models.workflow import (
            ApprovalStep,
            WorkflowInstance,
            WorkflowStage,
        )

        existing = list(tmpl.stages or [])
        if existing:
            ids = [st.id for st in existing]

            # A run in flight needs the stages it has NOT REACHED YET just as
            # much as the ones it has already passed: those are the rest of
            # the route it is pinned to (DM-02). Keying "keep this row" off
            # existing references alone hard-deleted every future stage of a
            # live run, so after an edit the run had nowhere left to advance
            # to and took the completion branch instead — approving the
            # document. So if ANY non-terminal run exists on this template,
            # every current stage row is retired rather than deleted.
            has_live_run = await self._in_flight_run_count(tmpl.id) > 0

            referenced = set(ids) if has_live_run else set(
                (
                    await self.db.execute(
                        select(ApprovalStep.stage_id).where(
                            ApprovalStep.stage_id.in_(ids)
                        )
                    )
                ).scalars().all()
            )
            referenced |= set(
                (
                    await self.db.execute(
                        select(WorkflowInstance.current_stage_id).where(
                            or_(*[WorkflowInstance.current_stage_id == i for i in ids])
                        )
                    )
                ).scalars().all()
            )
            # `uq_stage_template_order` is UNIQUE (template_id,
            # sequence_order) and is NOT partial, so it still counts
            # soft-deleted rows. A retired stage therefore keeps its slot
            # occupied and the replacement stage at the same position
            # violates it — which made saving an edit to a workflow with ANY
            # in-flight run fail outright. Retired rows are parked on
            # negative orders, below every order the template has ever used.
            #
            # Safe because nothing routes by a retired row's own
            # sequence_order: the pinned path orders by the snapshot's copied
            # order or by stage_instances.position, and list_for_template()
            # filters retired rows out entirely.
            min_order = (
                await self.db.execute(
                    select(func.min(WorkflowStage.sequence_order)).where(
                        WorkflowStage.template_id == tmpl.id
                    )
                )
            ).scalar()
            park_at = min(0, min_order if min_order is not None else 0) - 1

            now = datetime.now(timezone.utc)
            for stage in existing:
                if stage.id in referenced:
                    # Keep it for history; take it out of the live
                    # definition by soft-deleting. The repository filters
                    # `deleted_at` out of both list_for_template() and the
                    # get_by_id() eager load, so a retired row stops being
                    # part of the live definition while remaining available
                    # by id for any run still pinned to it (task P2-2).
                    stage.deleted_at = now
                    stage.sequence_order = park_at
                    park_at -= 1
                else:
                    await self.db.delete(stage)
            await self.db.flush()

        for i, stage_req in enumerate(sorted(stages, key=lambda s: s.sequence_order)):
            sla_hours, requires_signature = self._legacy_stage_fields(
                stage_req, built[i] if built and i < len(built) else None
            )
            stage = await self.stage_repo.create(
                template_id=tmpl.id,
                name=stage_req.name,
                sequence_order=stage_req.sequence_order,
                stage_type=stage_req.stage_type,
                min_approvals_required=stage_req.min_approvals_required,
                sla_hours=sla_hours,
                reapproval_on_revision=stage_req.reapproval_on_revision,
                requires_signature=requires_signature,
            )
            for rule in stage_req.approver_rules:
                await self.stage_repo.add_approver_rule(
                    stage_id=stage.id,
                    rule_type=rule.rule_type,
                    rule_value=rule.rule_value,
                )
        await self.db.flush()

    # ── Version history (WF-LC-05, DM-03/04) ────────────────────────────────

    async def list_versions(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        actor_id: uuid.UUID,
        is_admin: bool = False,
    ) -> list[WorkflowVersionSummary]:
        """Owner-only version history. A grantee can read the CURRENT
        definition but not the history of how it got there (§7.3)."""
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        # View check FIRST: for a workflow private to someone else this
        # raises 404, so a 403 can never confirm that it exists
        # (WF-OWN-10, E28). Only then is the owner-only check applied,
        # which is what distinguishes the owner of an
        # organization-visible workflow from another member of it.
        await self._assert_can_read(tmpl, actor_id, is_admin)
        self._assert_can_edit(tmpl, actor_id, is_admin)

        versions = await self.version_repo.list_for_template(template_id)
        return [
            WorkflowVersionSummary(
                id=v.id,
                version_number=v.version_number,
                name=v.name,
                created_by=v.created_by,
                created_at=v.created_at,
                stage_count=len(v.stages_snapshot or []),
                is_current=(v.id == tmpl.current_version_id),
            )
            for v in versions
        ]

    # ── Archive / restore (WF-LC-03) ────────────────────────────────────────

    async def set_archived(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        archived: bool,
        actor_id: uuid.UUID,
        is_admin: bool = False,
    ) -> WorkflowTemplateResponse:
        """Archive or restore.

        Archiving makes a workflow unavailable for NEW submissions and hides
        it from pickers; runs already in flight continue, and shares are
        retained but hidden (§4.3 A). Restore reverses it. Unlike delete this
        is always allowed, which is why WF-LIST-07 tells the user to archive
        when deletion is blocked.

        Both the owner and an Org Admin may archive (§7.3) — the one lifecycle
        action an admin shares with the owner, so a workflow can be taken out
        of circulation without its owner.
        """
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        if not is_admin and tmpl.created_by != actor_id:
            raise ForbiddenException(
                "Only the workflow owner or an organization administrator can "
                "archive or restore a workflow."
            )

        await self.tmpl_repo.update(
            template_id, org_id,
            status="archived" if archived else "active",
            # Kept in step so the existing pickers, which filter on
            # is_active, honour the archive without needing to change.
            is_active=not archived,
        )
        await self.db.commit()
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        logger.info(
            "template_archived" if archived else "template_restored",
            template_id=str(template_id), actor=str(actor_id),
        )
        return await self._to_response(tmpl)

    # ── Sharing (§5.1, WF-OWN-02..11) ───────────────────────────────────────

    async def share(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        grantee_user_id: uuid.UUID,
        actor_id: uuid.UUID,
    ) -> WorkflowShareResult:
        """Grant USE on a workflow to one colleague.

        Idempotent (WF-OWN-07): sharing again returns the existing share and
        sends no second chat message. Every rejection is deliberate:
          * not the owner            -> 403 (a grantee cannot re-share)
          * unknown/private template -> 404, never 403 (WF-OWN-10, E28)
          * self, cross-org, or an
            inactive user            -> 422 (WF-OWN-08)
        """
        from app.models.organization import OrganizationMember
        from app.models.user import User

        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        # Sharing is the owner's alone: an Org Admin may archive but not
        # hand out access to a definition they cannot even read (O-10).
        # View check FIRST: for a workflow private to someone else this
        # raises 404, so a 403 can never confirm that it exists
        # (WF-OWN-10, E28). Only then is the owner-only check applied,
        # which is what distinguishes the owner of an
        # organization-visible workflow from another member of it.
        await self._assert_can_read(tmpl, actor_id)
        if tmpl.created_by is None or tmpl.created_by != actor_id:
            raise ForbiddenException("Only the workflow owner can share it.")

        if grantee_user_id == actor_id:
            raise UnprocessableEntityException(
                "This workflow is already yours — you do not need to share it "
                "with yourself."
            )

        membership = (
            await self.db.execute(
                select(OrganizationMember).where(
                    OrganizationMember.org_id == org_id,
                    OrganizationMember.user_id == grantee_user_id,
                    OrganizationMember.status == "active",
                    OrganizationMember.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if membership is None:
            raise UnprocessableEntityException(
                "That person is not an active member of this organization."
            )

        grantee = await self.db.get(User, grantee_user_id)
        if grantee is None or not grantee.is_active:
            raise UnprocessableEntityException(
                "That user account is not active."
            )

        share, created = await self.share_repo.grant(
            template_id=template_id,
            grantee_user_id=grantee_user_id,
            granted_by=actor_id,
        )

        if created:
            await self._write_audit(
                org_id=org_id,
                actor_id=actor_id,
                action="workflow.shared",
                resource_type="WorkflowTemplate",
                resource_id=template_id,
                after={
                    "grantee_user_id": str(grantee_user_id),
                    "permission": "USE",
                },
            )

        await self.db.commit()
        logger.info(
            "workflow_shared",
            template_id=str(template_id),
            grantee=str(grantee_user_id),
            created=created,
        )
        return WorkflowShareResult(
            share=self._share_response(share, grantee),
            created=created,
            chat_message_sent=False,
        )

    async def revoke_share(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        grantee_user_id: uuid.UUID,
        actor_id: uuid.UUID,
    ) -> None:
        """Revoke a share.

        The workflow leaves the grantee's list and picker immediately, but
        runs they already started continue untouched (WF-OWN-06, DM-02, E6).
        Idempotent: revoking a share that is not live is not an error
        (WF-LC-06).
        """
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        await self._assert_can_read(tmpl, actor_id)
        if tmpl.created_by is None or tmpl.created_by != actor_id:
            raise ForbiddenException("Only the workflow owner can revoke a share.")

        revoked = await self.share_repo.revoke(
            template_id=template_id,
            grantee_user_id=grantee_user_id,
            revoked_by=actor_id,
        )
        if revoked:
            await self._write_audit(
                org_id=org_id,
                actor_id=actor_id,
                action="workflow.share_revoked",
                resource_type="WorkflowTemplate",
                resource_id=template_id,
                after={"grantee_user_id": str(grantee_user_id)},
            )
        await self.db.commit()
        logger.info(
            "workflow_share_revoked",
            template_id=str(template_id),
            grantee=str(grantee_user_id),
            was_active=revoked,
        )

    async def list_shares(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        actor_id: uuid.UUID,
    ) -> list[WorkflowShareResponse]:
        """The owner's "Shared with" panel."""
        from app.models.user import User

        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        await self._assert_can_read(tmpl, actor_id)
        if tmpl.created_by is None or tmpl.created_by != actor_id:
            raise ForbiddenException(
                "Only the workflow owner can see who it is shared with."
            )

        shares = await self.share_repo.list_active(template_id)
        if not shares:
            return []
        users = {
            u.id: u
            for u in (
                await self.db.execute(
                    select(User).where(
                        User.id.in_([sh.grantee_user_id for sh in shares])
                    )
                )
            ).scalars().all()
        }
        return [
            self._share_response(sh, users.get(sh.grantee_user_id)) for sh in shares
        ]

    @staticmethod
    def _share_response(share, grantee) -> WorkflowShareResponse:
        return WorkflowShareResponse(
            id=share.id,
            template_id=share.template_id,
            grantee_user_id=share.grantee_user_id,
            permission=share.permission,
            granted_at=share.granted_at,
            granted_by=share.granted_by,
            grantee_name=getattr(grantee, "name", None),
            grantee_email=getattr(grantee, "email", None),
        )

    async def _write_audit(
        self,
        *,
        org_id: uuid.UUID,
        actor_id: uuid.UUID | None,
        action: str,
        resource_type: str,
        resource_id: uuid.UUID,
        after: dict | None = None,
    ) -> None:
        """Write one audit row in the SAME transaction as the change (BR-10).

        Not committed here: the caller owns the transaction, so a rolled-back
        change can never leave an audit row claiming it happened.
        """
        from app.models.audit import AuditLog

        self.db.add(
            AuditLog(
                org_id=org_id,
                actor_id=actor_id,
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                after=after or {},
            )
        )
        await self.db.flush()
