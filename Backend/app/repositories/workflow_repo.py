"""
DocFlow Backend — Repositories: Workflow
Provides data-access for WorkflowTemplate, WorkflowInstance, ApprovalStep, and Delegation.
All methods are async and accept an AsyncSession.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.domain.enums import WorkflowInstanceStatus
from app.models.workflow import (
    ApprovalStep,
    Delegation,
    ESignature,
    StageInstance,
    WorkflowInstance,
    WorkflowShare,
    WorkflowStage,
    WorkflowTemplate,
    WorkflowTemplateVersion,
    WorkflowVersionStage,
    StageApproverRule,
)


class WorkflowTemplateRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        org_id: uuid.UUID,
        name: str,
        description: str | None = None,
        department_id: uuid.UUID | None = None,
        doc_type_id: uuid.UUID | None = None,
        document_type_scope: str | None = None,
        is_active: bool = True,
        created_by: uuid.UUID | None = None,
        visibility: str = "organization",
    ) -> WorkflowTemplate:
        tmpl = WorkflowTemplate(
            org_id=org_id,
            name=name,
            description=description,
            department_id=department_id,
            doc_type_id=doc_type_id,
            document_type_scope=document_type_scope,
            is_active=is_active,
            created_by=created_by,
            visibility=visibility,
        )
        self.db.add(tmpl)
        await self.db.flush()
        return tmpl

    async def get_by_id(self, template_id: uuid.UUID, org_id: uuid.UUID) -> WorkflowTemplate | None:
        result = await self.db.execute(
            select(WorkflowTemplate)
            .options(
                # Retired stages are excluded for the same reason as in
                # WorkflowStageRepository.list_for_template: this is the
                # LIVE definition, and a soft-deleted row left in it
                # showed the owner duplicated stages after an edit.
                selectinload(
                    WorkflowTemplate.stages.and_(WorkflowStage.deleted_at.is_(None))
                ).selectinload(WorkflowStage.approver_rules)
            )
            .where(
                WorkflowTemplate.id == template_id,
                WorkflowTemplate.org_id == org_id,
                WorkflowTemplate.deleted_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def list_for_org(
        self,
        org_id: uuid.UUID,
        active_only: bool = True,
        department_id: uuid.UUID | None = None,
        *,
        visible_to_user_id: uuid.UUID | None = None,
        include_private_of_others: bool = False,
        owned_by: uuid.UUID | None = None,
        search: str | None = None,
        shared_template_ids: Sequence[uuid.UUID] | None = None,
        only_template_ids: Sequence[uuid.UUID] | None = None,
        include_archived: bool = True,
    ) -> Sequence[WorkflowTemplate]:
        """
        List templates for an org.

        `visible_to_user_id` applies §7's private-workflow rule: a template
        with visibility='private' is only listed for its own owner. Pass
        `include_private_of_others=True` for org administrators, who manage
        every workflow in the org. `owned_by` narrows to one user's own
        workflows ("my workflows"), and `search` does a case-insensitive
        name match ("the user can search workflows by name").
        """
        from sqlalchemy import or_

        q = select(WorkflowTemplate).where(
            WorkflowTemplate.org_id == org_id,
            WorkflowTemplate.deleted_at.is_(None),
        )
        if active_only:
            q = q.where(WorkflowTemplate.is_active.is_(True))
        if department_id:
            q = q.where(WorkflowTemplate.department_id == department_id)
        if owned_by:
            q = q.where(WorkflowTemplate.created_by == owned_by)
        if search:
            q = q.where(WorkflowTemplate.name.ilike(f"%{search}%"))
        if only_template_ids is not None:
            # "Shared with me" tab: exactly the workflows granted to the caller.
            if not only_template_ids:
                return []
            q = q.where(WorkflowTemplate.id.in_(list(only_template_ids)))
        if not include_archived:
            q = q.where(WorkflowTemplate.status != "archived")
        if visible_to_user_id is not None and not include_private_of_others:
            visible = [
                WorkflowTemplate.visibility != "private",
                WorkflowTemplate.created_by == visible_to_user_id,
            ]
            # A private workflow shared with the caller IS visible to them:
            # WF-OWN-09 puts it under "Shared with me" and in the upload
            # picker. Without this clause a share would grant nothing, which
            # is the hole WF-OWN-02 warns about ("sending a chat message
            # alone grants nothing" - the grant has to be readable).
            if shared_template_ids:
                visible.append(WorkflowTemplate.id.in_(list(shared_template_ids)))
            q = q.where(or_(*visible))
        result = await self.db.execute(q.order_by(WorkflowTemplate.name))
        return result.scalars().all()

    async def update(self, template_id: uuid.UUID, org_id: uuid.UUID, **kwargs) -> WorkflowTemplate | None:
        tmpl = await self.db.get(WorkflowTemplate, template_id)
        if not tmpl or tmpl.org_id != org_id:
            return None
        for k, v in kwargs.items():
            if hasattr(tmpl, k):
                setattr(tmpl, k, v)
        await self.db.flush()
        return tmpl

    async def soft_delete(self, template_id: uuid.UUID, org_id: uuid.UUID) -> bool:
        from datetime import timezone
        tmpl = await self.db.get(WorkflowTemplate, template_id)
        if not tmpl or tmpl.org_id != org_id:
            return False
        tmpl.deleted_at = datetime.now(timezone.utc)
        await self.db.flush()
        return True


class WorkflowStageRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        template_id: uuid.UUID,
        name: str,
        sequence_order: int,
        stage_type: str = "sequential",
        min_approvals_required: int = 1,
        sla_hours: int | None = None,
        reapproval_on_revision: bool = False,
        requires_signature: bool = False,
    ) -> WorkflowStage:
        stage = WorkflowStage(
            template_id=template_id,
            name=name,
            sequence_order=sequence_order,
            stage_type=stage_type,
            min_approvals_required=min_approvals_required,
            sla_hours=sla_hours,
            reapproval_on_revision=reapproval_on_revision,
            requires_signature=requires_signature,
        )
        self.db.add(stage)
        await self.db.flush()
        return stage

    async def list_for_template(self, template_id: uuid.UUID) -> Sequence[WorkflowStage]:
        """The template's LIVE stage definition.

        Retired rows are excluded. `_replace_legacy_stages()` soft-deletes a
        stage row that an in-flight run still references (it cannot be
        deleted: `approval_steps.stage_id` and
        `workflow_instances.current_stage_id` reference it with no ON DELETE)
        and inserts the new definition alongside it. There is no global
        soft-delete filter in this codebase, so without the predicate below
        this method returned the retired rows AND the new ones together, and
        the caller saw a definition with duplicated stages.

        A run that was submitted against a retired stage still has to resolve
        it; that is done by id through `list_by_ids()`, not here.
        """
        result = await self.db.execute(
            select(WorkflowStage)
            .options(
                selectinload(WorkflowStage.approver_rules),
                selectinload(WorkflowStage.conditions),
            )
            .where(
                WorkflowStage.template_id == template_id,
                WorkflowStage.deleted_at.is_(None),
            )
            .order_by(WorkflowStage.sequence_order)
        )
        return result.scalars().all()

    async def list_by_ids(
        self, stage_ids: Sequence[uuid.UUID]
    ) -> Sequence[WorkflowStage]:
        """Specific stages by id, INCLUDING soft-deleted ones.

        This is how a run is routed by the definition it was pinned to
        (DM-02): a stage retired from the live template must still resolve
        for a run that was already in flight when the owner edited it.
        `approver_rules` is eagerly loaded because the model declares it
        lazy="noload" — a bare get() yields zero approver rules and the
        caller would silently create no ApprovalStep at all.
        """
        if not stage_ids:
            return []
        result = await self.db.execute(
            select(WorkflowStage)
            .options(
                selectinload(WorkflowStage.approver_rules),
                selectinload(WorkflowStage.conditions),
            )
            .where(WorkflowStage.id.in_(list(stage_ids)))
        )
        return result.scalars().all()

    async def add_approver_rule(
        self,
        stage_id: uuid.UUID,
        rule_type: str,
        rule_value: dict,
    ) -> StageApproverRule:
        rule = StageApproverRule(
            stage_id=stage_id,
            rule_type=rule_type,
            rule_value=rule_value,
        )
        self.db.add(rule)
        await self.db.flush()
        return rule


class WorkflowInstanceRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        org_id: uuid.UUID,
        document_id: uuid.UUID,
        template_id: uuid.UUID | None,
        template_version_snapshot: dict,
        current_stage_id: uuid.UUID | None = None,
        status: str = "pending",
    ) -> WorkflowInstance:
        instance = WorkflowInstance(
            org_id=org_id,
            document_id=document_id,
            template_id=template_id,
            template_version_snapshot=template_version_snapshot,
            current_stage_id=current_stage_id,
            status=status,
            submitted_at=datetime.now(timezone.utc),
        )
        self.db.add(instance)
        await self.db.flush()
        return instance

    async def get_by_id(self, instance_id: uuid.UUID, org_id: uuid.UUID | None = None) -> WorkflowInstance | None:
        # approval_steps is lazy="noload" — eager-load it explicitly, otherwise
        # WorkflowInstanceResponse.approval_steps always serializes as [] even
        # when steps exist (confirmed live: a freshly-resumed instance with a
        # real pending step still returned "approval_steps":[]).
        q = (
            select(WorkflowInstance)
            .options(selectinload(WorkflowInstance.approval_steps))
            .where(WorkflowInstance.id == instance_id)
        )
        if org_id:
            q = q.where(WorkflowInstance.org_id == org_id)
        result = await self.db.execute(q)
        return result.scalar_one_or_none()

    async def get_by_document(self, document_id: uuid.UUID) -> WorkflowInstance | None:
        """Get the most recent workflow instance for a document."""
        result = await self.db.execute(
            select(WorkflowInstance)
            .where(WorkflowInstance.document_id == document_id)
            .order_by(WorkflowInstance.submitted_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def list_for_org(
        self,
        org_id: uuid.UUID,
        status: str | None = None,
        page: int = 1,
        limit: int = 20,
    ) -> tuple[Sequence[WorkflowInstance], int]:
        from sqlalchemy import func
        q = select(WorkflowInstance).where(WorkflowInstance.org_id == org_id)
        if status:
            q = q.where(WorkflowInstance.status == status)
        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.db.execute(count_q)).scalar_one()
        items = (await self.db.execute(
            q.order_by(WorkflowInstance.submitted_at.desc())
             .offset((page - 1) * limit).limit(limit)
        )).scalars().all()
        return items, total

    async def update_status(
        self,
        instance_id: uuid.UUID,
        status: str,
        current_stage_id: uuid.UUID | None = None,
        completed_at: datetime | None = None,
    ) -> WorkflowInstance | None:
        instance = await self.db.get(WorkflowInstance, instance_id)
        if not instance:
            return None
        instance.status = status
        if current_stage_id is not None:
            instance.current_stage_id = current_stage_id
        if completed_at is not None:
            instance.completed_at = completed_at
        await self.db.flush()
        return instance


class ApprovalStepRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        instance_id: uuid.UUID,
        stage_id: uuid.UUID,
        document_version_id: uuid.UUID,
        approver_id: uuid.UUID,
        due_at: datetime | None = None,
        round_number: int = 1,
    ) -> ApprovalStep:
        step = ApprovalStep(
            instance_id=instance_id,
            stage_id=stage_id,
            document_version_id=document_version_id,
            approver_id=approver_id,
            decision="pending",
            due_at=due_at,
            round_number=round_number,
        )
        self.db.add(step)
        await self.db.flush()
        return step

    async def get_by_id(
        self, step_id: uuid.UUID, *, for_update: bool = False
    ) -> ApprovalStep | None:
        """One approval step.

        `for_update` takes a row lock, which a decision needs (X-INT-03, E9,
        T25). The "has this step already been decided?" guard reads
        `step.decision`, so without a lock two approvals arriving together
        both read `pending`, both pass the guard and both record a decision —
        advancing the run twice and notifying the next approver twice. With
        the lock the second waits, then sees the first decision and is
        correctly refused with a conflict.
        """
        if for_update:
            result = await self.db.execute(
                select(ApprovalStep)
                .where(ApprovalStep.id == step_id)
                .with_for_update()
            )
            return result.scalar_one_or_none()
        return await self.db.get(ApprovalStep, step_id)

    async def get_pending_for_approver(
        self,
        approver_id: uuid.UUID,
        org_id: uuid.UUID | None = None,
        decisions: Sequence[str] | None = None,
    ) -> Sequence[ApprovalStep]:
        """Approval steps assigned to a user.

        `decisions` selects which outcomes to return; the default keeps the
        original pending-only behaviour, so existing callers are unchanged.
        The dashboard needs the decided ones too (AP-DSH-01): its Approved /
        Rejected / All tabs were rendered but could never contain a row,
        because this query filtered on `decision == 'pending'` unconditionally
        (defect 7).

        Decided steps are ordered newest-first — for history the useful end is
        the recent one, whereas pending work is ordered by what is due soonest.
        """
        wanted = list(decisions) if decisions else ["pending"]
        pending_only = wanted == ["pending"]

        q = select(ApprovalStep).where(
            ApprovalStep.approver_id == approver_id,
            ApprovalStep.decision.in_(wanted),
        )

        if pending_only:
            # A step is only actionable while its run is. Without this, work
            # from a run that has already ended stayed in the approver's
            # queue with live Approve / Reject buttons (UX-INT-01):
            #
            #   * the owner withdrew the document (WF-WD-02) - the step was
            #     left pending, so it kept its place in the list; and
            #   * a stage needing two approvals where one approver rejected -
            #     the run is terminal, but the other approver's step is still
            #     pending and still offered to them.
            #
            # A superseded step is excluded for the same reason: it has no
            # decision, but it is no longer anybody's to make.
            q = q.join(
                WorkflowInstance, WorkflowInstance.id == ApprovalStep.instance_id
            ).where(
                ApprovalStep.superseded_at.is_(None),
                WorkflowInstance.status.notin_(
                    [
                        str(st) for st in (
                            WorkflowInstanceStatus.APPROVED,
                            WorkflowInstanceStatus.REJECTED,
                            WorkflowInstanceStatus.CANCELLED,
                            WorkflowInstanceStatus.COMPLETED,
                            WorkflowInstanceStatus.FINALIZED,
                        )
                    ]
                ),
                WorkflowInstance.deleted_at.is_(None),
            )
        q = q.order_by(
            ApprovalStep.due_at.asc().nullslast() if pending_only
            else ApprovalStep.decided_at.desc().nullslast()
        )
        if org_id:
            # The pending branch above has already joined WorkflowInstance;
            # joining it a second time is a duplicate-alias error, so only
            # add the join where it is not there yet.
            if not pending_only:
                q = q.join(WorkflowInstance)
            q = q.where(WorkflowInstance.org_id == org_id)
        result = await self.db.execute(q)
        return result.scalars().all()

    async def get_for_instance_and_stage(
        self,
        instance_id: uuid.UUID,
        stage_id: uuid.UUID,
    ) -> Sequence[ApprovalStep]:
        """Get all ApprovalStep rows for a stage (across all rounds)."""
        result = await self.db.execute(
            select(ApprovalStep)
            .where(
                ApprovalStep.instance_id == instance_id,
                ApprovalStep.stage_id == stage_id,
            )
            .order_by(ApprovalStep.round_number, ApprovalStep.created_at)
        )
        return result.scalars().all()

    async def get_for_instance(self, instance_id: uuid.UUID) -> Sequence[ApprovalStep]:
        """Every ApprovalStep row for an instance, across all stages and
        rounds — the raw material for the §6.6 chain-of-custody view and for
        the finalization/recall checks that must consider the whole history,
        not just the current stage."""
        result = await self.db.execute(
            select(ApprovalStep)
            .where(ApprovalStep.instance_id == instance_id)
            .order_by(ApprovalStep.round_number, ApprovalStep.created_at)
        )
        return result.scalars().all()

    async def get_current_round_steps(
        self,
        instance_id: uuid.UUID,
        stage_id: uuid.UUID,
    ) -> Sequence[ApprovalStep]:
        """Get ApprovalStep rows for the latest round at a stage."""
        # Subquery: get max round for this stage
        from sqlalchemy import func
        max_round_q = select(func.max(ApprovalStep.round_number)).where(
            ApprovalStep.instance_id == instance_id,
            ApprovalStep.stage_id == stage_id,
        ).scalar_subquery()
        result = await self.db.execute(
            select(ApprovalStep).where(
                ApprovalStep.instance_id == instance_id,
                ApprovalStep.stage_id == stage_id,
                ApprovalStep.round_number == max_round_q,
            )
        )
        return result.scalars().all()

    async def record_decision(
        self,
        step_id: uuid.UUID,
        decision: str,
        decision_note: str | None = None,
    ) -> ApprovalStep | None:
        step = await self.db.get(ApprovalStep, step_id)
        if not step:
            return None
        step.decision = decision
        step.decision_note = decision_note
        step.decided_at = datetime.now(timezone.utc)
        await self.db.flush()
        return step

    # ── Dashboard query (AP-DSH-02..07, task P2-18) ────────────────────

    # Statuses in which a run is finished; its steps are history, not work.
    _DEAD_RUN_STATUSES = (
        WorkflowInstanceStatus.APPROVED,
        WorkflowInstanceStatus.REJECTED,
        WorkflowInstanceStatus.CANCELLED,
        WorkflowInstanceStatus.COMPLETED,
        WorkflowInstanceStatus.FINALIZED,
    )

    DASHBOARD_SORTS = (
        "due_at", "-due_at", "submitted_at", "-submitted_at", "title", "-title",
    )

    def _dashboard_query(
        self,
        approver_id: uuid.UUID,
        org_id: uuid.UUID | None,
        decisions: Sequence[str],
        *,
        q: str | None = None,
        template_id: uuid.UUID | None = None,
        department_id: uuid.UUID | None = None,
    ):
        """The shared FROM/WHERE for the dashboard, so the rows and the
        counts can never disagree about what belongs in a tab.

        Joined rather than looked up per row: the search and the department
        filter are both over the DOCUMENT, which is two hops from the step
        (step -> instance -> document), and that is a join, not an N+1.
        """
        from app.models.document import Document

        wanted = list(decisions)
        pending_only = wanted == ["pending"]

        query = (
            select(ApprovalStep)
            .join(WorkflowInstance, WorkflowInstance.id == ApprovalStep.instance_id)
            .join(Document, Document.id == WorkflowInstance.document_id)
            .where(
                ApprovalStep.approver_id == approver_id,
                ApprovalStep.decision.in_(wanted),
                WorkflowInstance.deleted_at.is_(None),
                Document.deleted_at.is_(None),
            )
        )
        if org_id is not None:
            query = query.where(WorkflowInstance.org_id == org_id)

        if pending_only:
            # Still-to-do work only: a pending step on a run that has ended
            # is not actionable (see get_pending_for_approver).
            query = query.where(
                ApprovalStep.superseded_at.is_(None),
                WorkflowInstance.status.notin_(
                    [str(s) for s in self._DEAD_RUN_STATUSES]
                ),
            )

        if template_id is not None:
            query = query.where(WorkflowInstance.template_id == template_id)
        if department_id is not None:
            query = query.where(Document.dept_id == department_id)
        if q:
            # Trailing-wildcard only on purpose: a leading `%` cannot use an
            # index, and this list is the one screen an approver reloads all
            # day. Title and the human-facing document id are what people
            # actually search by.
            like = f"%{q.strip()}%"
            prefix = f"{q.strip()}%"
            query = query.where(
                or_(
                    Document.title.ilike(like),
                    Document.public_id.ilike(prefix),
                )
            )
        return query

    async def query_dashboard(
        self,
        approver_id: uuid.UUID,
        org_id: uuid.UUID | None = None,
        *,
        decisions: Sequence[str] = ("pending",),
        q: str | None = None,
        template_id: uuid.UUID | None = None,
        department_id: uuid.UUID | None = None,
        sort: str = "due_at",
        page: int = 1,
        limit: int = 25,
    ) -> tuple[Sequence[ApprovalStep], int]:
        """One page of the approver's queue, and the size of the whole set."""
        base = self._dashboard_query(
            approver_id, org_id, decisions,
            q=q, template_id=template_id, department_id=department_id,
        )

        total = (
            await self.db.execute(
                select(func.count()).select_from(base.subquery())
            )
        ).scalar() or 0

        from app.models.document import Document

        column = {
            "due_at": ApprovalStep.due_at,
            "submitted_at": WorkflowInstance.submitted_at,
            "title": Document.title,
        }[sort.lstrip("-")]
        descending = sort.startswith("-")
        order = column.desc() if descending else column.asc()
        # NULLs last either way: a step with no deadline is not the most
        # urgent thing on the list, and it is not the least recent either.
        order = order.nullslast()

        rows = (
            await self.db.execute(
                base.order_by(order, ApprovalStep.created_at.desc())
                .offset(max(0, (page - 1)) * limit)
                .limit(limit)
            )
        ).scalars().all()
        return rows, total

    async def dashboard_counts(
        self,
        approver_id: uuid.UUID,
        org_id: uuid.UUID | None = None,
        *,
        tabs: dict[str, Sequence[str]],
        q: str | None = None,
        template_id: uuid.UUID | None = None,
        department_id: uuid.UUID | None = None,
    ) -> dict[str, int]:
        """A count per tab (AP-DSH-02).

        The counts honour the active filters, so a tab badge never promises
        rows that the current search would hide — a count that disagrees with
        what the tab then shows is worse than no count.
        """
        counts: dict[str, int] = {}
        for tab, decisions in tabs.items():
            base = self._dashboard_query(
                approver_id, org_id, decisions,
                q=q, template_id=template_id, department_id=department_id,
            )
            counts[tab] = (
                await self.db.execute(
                    select(func.count()).select_from(base.subquery())
                )
            ).scalar() or 0
        return counts

    async def dashboard_urgency_summary(
        self,
        approver_id: uuid.UUID,
        org_id: uuid.UUID | None = None,
        *,
        as_of: datetime | None = None,
    ) -> dict[str, int]:
        """Overdue / due-today / due-this-week across the whole pending queue.

        Deliberately NOT filtered by the current search or tab: this is the
        summary strip (AP-DSH-08), and its job is to say what is on fire
        overall. A strip that changed every time somebody typed in the search
        box would be telling them about their filter, not their workload.
        """
        now = as_of or datetime.now(timezone.utc)
        base = self._dashboard_query(approver_id, org_id, ["pending"])
        sub = base.subquery()

        async def _count(*conditions) -> int:
            return (
                await self.db.execute(
                    select(func.count()).select_from(sub).where(*conditions)
                )
            ).scalar() or 0

        return {
            "pending": await _count(),
            "overdue": await _count(
                sub.c.due_at.isnot(None), sub.c.due_at < now
            ),
            "due_today": await _count(
                sub.c.due_at.isnot(None),
                sub.c.due_at >= now,
                sub.c.due_at < now + timedelta(days=1),
            ),
            "due_this_week": await _count(
                sub.c.due_at.isnot(None),
                sub.c.due_at >= now,
                sub.c.due_at < now + timedelta(days=7),
            ),
        }

    async def get_overdue_pending(self, as_of: datetime | None = None) -> Sequence[ApprovalStep]:
        """Pending steps past their due_at, for the SLA worker.

        Excludes runs whose clock is not running (§6.10, AP-SLA-03, defect 6).
        The timer stops while the document is back with its owner for changes,
        or while the stage is blocked awaiting reassignment: the approver is
        not sitting on it, so it must not accrue toward their breach. This
        previously filtered on `decision == pending` alone, so a document sent
        back for corrections kept counting down and the approver was escalated
        on for work that was not theirs to do.

        A terminal run is excluded for the same reason — its steps are history.
        """
        if as_of is None:
            as_of = datetime.now(timezone.utc)

        # Statuses in which the approver's clock is NOT running.
        paused_or_done = [
            WorkflowInstanceStatus.CHANGES_REQUESTED,
            WorkflowInstanceStatus.APPROVED,
            WorkflowInstanceStatus.REJECTED,
            WorkflowInstanceStatus.CANCELLED,
            WorkflowInstanceStatus.COMPLETED,
            WorkflowInstanceStatus.FINALIZED,
        ]
        result = await self.db.execute(
            select(ApprovalStep)
            .join(WorkflowInstance, WorkflowInstance.id == ApprovalStep.instance_id)
            .where(
                ApprovalStep.decision == "pending",
                ApprovalStep.due_at < as_of,
                ApprovalStep.escalated_at.is_(None),
                WorkflowInstance.status.notin_([str(s) for s in paused_or_done]),
                WorkflowInstance.deleted_at.is_(None),
                # A stage explicitly paused or blocked is never overdue
                # (§6.10): no stage instance at all means an older run, which
                # keeps its previous behaviour.
                ~select(StageInstance.id)
                .where(
                    StageInstance.instance_id == ApprovalStep.instance_id,
                    StageInstance.legacy_stage_id == ApprovalStep.stage_id,
                    StageInstance.deleted_at.is_(None),
                    or_(
                        StageInstance.timer_paused_at.isnot(None),
                        StageInstance.status.in_(("blocked", "changes_requested")),
                    ),
                )
                .exists(),
            )
        )
        return result.scalars().all()

    async def get_sla_candidates(
        self, as_of: datetime | None = None
    ) -> Sequence[ApprovalStep]:
        """Pending steps with a live deadline, for the SLA sweep.

        Deliberately NOT filtered on `due_at < now`: the 75% reminder fires
        BEFORE the deadline (AP-SLA-02a), so a query that only returns
        overdue rows cannot send it. The sweep classifies each candidate
        itself.

        The exclusions match `get_overdue_pending` - a paused or blocked
        stage, and a terminal run, have no running clock (section 6.10,
        AP-SLA-03), so nothing about them is due.
        """
        if as_of is None:
            as_of = datetime.now(timezone.utc)

        paused_or_done = [
            WorkflowInstanceStatus.CHANGES_REQUESTED,
            WorkflowInstanceStatus.APPROVED,
            WorkflowInstanceStatus.REJECTED,
            WorkflowInstanceStatus.CANCELLED,
            WorkflowInstanceStatus.COMPLETED,
            WorkflowInstanceStatus.FINALIZED,
        ]
        result = await self.db.execute(
            select(ApprovalStep)
            .join(WorkflowInstance, WorkflowInstance.id == ApprovalStep.instance_id)
            .where(
                ApprovalStep.decision == "pending",
                ApprovalStep.due_at.isnot(None),
                ApprovalStep.superseded_at.is_(None),
                WorkflowInstance.status.notin_([str(s) for s in paused_or_done]),
                WorkflowInstance.deleted_at.is_(None),
                ~select(StageInstance.id)
                .where(
                    StageInstance.instance_id == ApprovalStep.instance_id,
                    StageInstance.legacy_stage_id == ApprovalStep.stage_id,
                    StageInstance.deleted_at.is_(None),
                    or_(
                        StageInstance.timer_paused_at.isnot(None),
                        StageInstance.status.in_(
                            ("blocked", "changes_requested", "superseded")
                        ),
                    ),
                )
                .exists(),
            )
            .order_by(ApprovalStep.due_at.asc())
        )
        return result.scalars().all()

    async def mark_escalated(self, step_id: uuid.UUID) -> ApprovalStep | None:
        step = await self.db.get(ApprovalStep, step_id)
        if not step:
            return None
        step.escalated_at = datetime.now(timezone.utc)
        await self.db.flush()
        return step

    async def add_esignature(
        self,
        step_id: uuid.UUID,
        signature_method: str,
        signed_hash: str,
        ip_address: str | None = None,
        user_agent: str | None = None,
        provider_reference: str | None = None,
        *,
        signed_payload: dict | None = None,
        payload_hash: str | None = None,
        signature_b64: str | None = None,
        algorithm: str | None = None,
        key_id: str | None = None,
    ) -> ESignature:
        """
        Persist the signature record for a decided step.

        The keyword-only fields carry the real cryptographic proof
        (requirements §6.4) produced by app/core/signing.py: the exact
        canonical payload that was signed, its hash, the RSA-PSS-SHA256
        signature, the algorithm name, and the signing key's fingerprint.
        `signature_method`/`signed_hash`/`ip_address`/`user_agent`/
        `provider_reference` remain supplementary ceremony metadata.
        """
        sig = ESignature(
            approval_step_id=step_id,
            signature_method=signature_method,
            signed_hash=signed_hash,
            ip_address=ip_address,
            user_agent=user_agent,
            provider_reference=provider_reference,
            signed_payload=signed_payload,
            payload_hash=payload_hash,
            signature_b64=signature_b64,
            algorithm=algorithm,
            key_id=key_id,
        )
        self.db.add(sig)
        await self.db.flush()
        return sig

    async def get_esignature(self, step_id: uuid.UUID) -> ESignature | None:
        result = await self.db.execute(
            select(ESignature).where(ESignature.approval_step_id == step_id)
        )
        return result.scalar_one_or_none()


class DelegationRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        delegator_id: uuid.UUID,
        delegate_id: uuid.UUID,
        starts_at: datetime,
        scope: str = "all",
        ends_at: datetime | None = None,
        approval_step_id: uuid.UUID | None = None,
        template_id: uuid.UUID | None = None,
        department_id: uuid.UUID | None = None,
        reason: str | None = None,
    ) -> Delegation:
        delegation = Delegation(
            delegator_id=delegator_id,
            delegate_id=delegate_id,
            starts_at=starts_at,
            ends_at=ends_at,
            scope=scope,
            approval_step_id=approval_step_id,
            template_id=template_id,
            department_id=department_id,
            reason=reason,
        )
        self.db.add(delegation)
        await self.db.flush()
        return delegation

    async def get_active_for_user(self, user_id: uuid.UUID) -> Sequence[Delegation]:
        """Get active delegations where this user is the delegator."""
        now = datetime.now(timezone.utc)
        result = await self.db.execute(
            select(Delegation).where(
                Delegation.delegator_id == user_id,
                Delegation.is_active.is_(True),
                Delegation.starts_at <= now,
                (Delegation.ends_at.is_(None)) | (Delegation.ends_at >= now),
            )
        )
        return result.scalars().all()


def _json_safe(stage: dict) -> dict:
    """Make one stage dict safe for a JSONB column.

    The stage dicts the service builds hold real UUID objects, which asyncpg
    cannot serialize into JSONB ("Object of type UUID is not JSON
    serializable"). Only the snapshot needs this: the relational columns in
    workflow_version_stages take UUIDs directly.
    """
    out: dict = {}
    for key, value in stage.items():
        out[key] = str(value) if isinstance(value, uuid.UUID) else value
    return out


class WorkflowVersionRepository:
    """Immutable workflow definition versions (DM-01..04).

    There is deliberately no `update` here: a version row is written once and
    never altered. A change to a workflow is a new row, which is what lets a
    run pin the definition it was submitted against (BR-02, DM-02).
    """

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def next_version_number(self, template_id: uuid.UUID) -> int:
        """Next free version number for a template (1 if it has none yet).

        Derived from MAX rather than counted, so a future hard-deleted row
        could never hand out a number that was already used, and the unique
        constraint on (template_id, version_number) stays satisfiable.
        """
        result = await self.db.execute(
            select(func.max(WorkflowTemplateVersion.version_number)).where(
                WorkflowTemplateVersion.template_id == template_id
            )
        )
        return int(result.scalar() or 0) + 1

    async def create_version(
        self,
        *,
        template_id: uuid.UUID,
        name: str,
        description: str | None,
        require_full_reapproval: bool,
        created_by: uuid.UUID | None,
        stages: Sequence[dict],
    ) -> WorkflowTemplateVersion:
        """Write one immutable version plus its ordered stages.

        `stages` is a list of plain dicts, already validated by the service.
        Positions are assigned here from list order and are the single source
        of truth for execution order (WF-STG-02): the caller sends the whole
        ordered list and never patches a position (X-INT-05).
        """
        version = WorkflowTemplateVersion(
            template_id=template_id,
            version_number=await self.next_version_number(template_id),
            name=name,
            description=description,
            require_full_reapproval=require_full_reapproval,
            created_by=created_by,
            stages_snapshot=[_json_safe(s) for s in stages],
        )
        self.db.add(version)
        await self.db.flush()

        for position, stage in enumerate(stages, start=1):
            self.db.add(
                WorkflowVersionStage(
                    version_id=version.id,
                    position=position,
                    name=stage["name"],
                    approver_type=stage["approver_type"],
                    approver_user_id=stage.get("approver_user_id"),
                    department_id=stage.get("department_id"),
                    due_within_value=stage["due_within_value"],
                    due_within_unit=stage["due_within_unit"],
                    due_within_hours=stage["due_within_hours"],
                    require_signing=stage.get("require_signing", False),
                )
            )
        await self.db.flush()
        return version

    async def get_with_stages(
        self, version_id: uuid.UUID
    ) -> WorkflowTemplateVersion | None:
        result = await self.db.execute(
            select(WorkflowTemplateVersion)
            .options(selectinload(WorkflowTemplateVersion.stages))
            .where(WorkflowTemplateVersion.id == version_id)
        )
        return result.scalar_one_or_none()

    async def list_for_template(
        self, template_id: uuid.UUID
    ) -> Sequence[WorkflowTemplateVersion]:
        result = await self.db.execute(
            select(WorkflowTemplateVersion)
            .where(WorkflowTemplateVersion.template_id == template_id)
            .order_by(WorkflowTemplateVersion.version_number.desc())
        )
        return result.scalars().all()


class WorkflowShareRepository:
    """Per-user USE grants on a workflow (§5.1, WF-OWN-*)."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get_active(
        self, template_id: uuid.UUID, grantee_user_id: uuid.UUID
    ) -> WorkflowShare | None:
        result = await self.db.execute(
            select(WorkflowShare).where(
                WorkflowShare.template_id == template_id,
                WorkflowShare.grantee_user_id == grantee_user_id,
                WorkflowShare.revoked_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    async def grant(
        self,
        *,
        template_id: uuid.UUID,
        grantee_user_id: uuid.UUID,
        granted_by: uuid.UUID,
    ) -> tuple[WorkflowShare, bool]:
        """Create the share, or return the existing live one.

        Returns `(share, created)`. WF-OWN-07 requires sharing to be
        idempotent: a second share with the same user must not create a
        duplicate row and must not send a second chat message, which is what
        `created` tells the caller. The partial unique index
        `uq_workflow_share_active` makes that a database guarantee rather
        than a check-then-insert race.
        """
        existing = await self.get_active(template_id, grantee_user_id)
        if existing:
            return existing, False

        share = WorkflowShare(
            template_id=template_id,
            grantee_user_id=grantee_user_id,
            granted_by=granted_by,
            permission="USE",
        )
        self.db.add(share)
        await self.db.flush()
        return share, True

    async def revoke(
        self,
        *,
        template_id: uuid.UUID,
        grantee_user_id: uuid.UUID,
        revoked_by: uuid.UUID,
    ) -> bool:
        """Mark the live share revoked. Rows are never deleted: the audit
        trail keeps who granted what to whom and when it ended (E20)."""
        share = await self.get_active(template_id, grantee_user_id)
        if not share:
            return False
        share.revoked_at = datetime.now(timezone.utc)
        share.revoked_by = revoked_by
        await self.db.flush()
        return True

    async def list_active(self, template_id: uuid.UUID) -> Sequence[WorkflowShare]:
        result = await self.db.execute(
            select(WorkflowShare)
            .where(
                WorkflowShare.template_id == template_id,
                WorkflowShare.revoked_at.is_(None),
            )
            .order_by(WorkflowShare.granted_at)
        )
        return result.scalars().all()

    async def active_template_ids_for_user(
        self, grantee_user_id: uuid.UUID
    ) -> list[uuid.UUID]:
        """Template ids shared live with this user — the "Shared with me" tab
        and the upload picker's shared group (WF-OWN-09)."""
        result = await self.db.execute(
            select(WorkflowShare.template_id).where(
                WorkflowShare.grantee_user_id == grantee_user_id,
                WorkflowShare.revoked_at.is_(None),
            )
        )
        return [row[0] for row in result.all()]

    async def count_active(self, template_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count())
            .select_from(WorkflowShare)
            .where(
                WorkflowShare.template_id == template_id,
                WorkflowShare.revoked_at.is_(None),
            )
        )
        return int(result.scalar() or 0)

    async def revoke_all(
        self, *, template_id: uuid.UUID, revoked_by: uuid.UUID
    ) -> int:
        """Revoke every live share on a workflow.

        Used when a workflow is deleted: WF-LC-04 says deleting also revokes
        its shares, so a grantee does not keep a dangling entry.
        """
        shares = await self.list_active(template_id)
        now = datetime.now(timezone.utc)
        for share in shares:
            share.revoked_at = now
            share.revoked_by = revoked_by
        await self.db.flush()
        return len(shares)
