"""
DocFlow Backend — Service: Template

Admin operations for creating, reading, updating, and managing
WorkflowTemplate + WorkflowStage + StageApproverRule.

Only users with `admin:workflow_templates` permission may call this service.
"""
from __future__ import annotations

import uuid
from typing import Sequence

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.models.workflow import WorkflowStage, WorkflowTemplate
from app.repositories.workflow_repo import WorkflowStageRepository, WorkflowTemplateRepository
from app.schemas.workflow_instances import (
    TemplateReviewResponse,
    TemplateReviewStage,
    WorkflowTemplateCreate,
    WorkflowTemplateResponse,
    WorkflowTemplateSummary,
    WorkflowTemplateUpdate,
)

logger = structlog.get_logger(__name__)


class TemplateService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.tmpl_repo = WorkflowTemplateRepository(db)
        self.stage_repo = WorkflowStageRepository(db)

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

        for stage_req in sorted(req.stages, key=lambda s: s.sequence_order):
            stage = await self.stage_repo.create(
                template_id=tmpl.id,
                name=stage_req.name,
                sequence_order=stage_req.sequence_order,
                stage_type=stage_req.stage_type,
                min_approvals_required=stage_req.min_approvals_required,
                sla_hours=stage_req.sla_hours,
                reapproval_on_revision=stage_req.reapproval_on_revision,
                requires_signature=stage_req.requires_signature,
            )
            for rule in stage_req.approver_rules:
                await self.stage_repo.add_approver_rule(
                    stage_id=stage.id,
                    rule_type=rule.rule_type,
                    rule_value=rule.rule_value,
                )

        if commit:
            await self.db.commit()
        else:
            await self.db.flush()
        logger.info("template_created", template_id=str(tmpl.id), org_id=str(org_id))

        # Reload with stages
        tmpl = await self.tmpl_repo.get_by_id(tmpl.id, org_id)
        return WorkflowTemplateResponse.model_validate(tmpl)

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

    async def get(self, template_id: uuid.UUID, org_id: uuid.UUID) -> WorkflowTemplateResponse:
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        return WorkflowTemplateResponse.model_validate(tmpl)

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
        if updates:
            # Bump version on any update. NOTE: in-flight instances are
            # unaffected — each one carries its own frozen
            # `template_version_snapshot` (§7: "Store a snapshot of the
            # workflow configuration used for each submitted document, so
            # later edits to a reusable workflow do not silently change an
            # active process").
            updates["version"] = tmpl.version + 1
            await self.tmpl_repo.update(template_id, org_id, **updates)

        await self.db.commit()
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        return WorkflowTemplateResponse.model_validate(tmpl)

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
        return WorkflowTemplateResponse.model_validate(tmpl)

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
        return WorkflowTemplateResponse.model_validate(copy)

    async def delete(
        self,
        template_id: uuid.UUID,
        org_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
        is_admin: bool = True,
    ) -> None:
        if actor_id is not None:
            tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
            if not tmpl:
                raise NotFoundException("WorkflowTemplate not found")
            self._assert_can_edit(tmpl, actor_id, is_admin)

        success = await self.tmpl_repo.soft_delete(template_id, org_id)
        if not success:
            raise NotFoundException("WorkflowTemplate not found")
        await self.db.commit()
        logger.info("template_deleted", template_id=str(template_id))
