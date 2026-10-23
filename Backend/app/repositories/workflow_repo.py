"""
DocFlow Backend — Repositories: Workflow
Provides data-access for WorkflowTemplate, WorkflowInstance, ApprovalStep, and Delegation.
All methods are async and accept an AsyncSession.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Sequence

from sqlalchemy import and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.workflow import (
    ApprovalStep,
    Delegation,
    ESignature,
    WorkflowInstance,
    WorkflowStage,
    WorkflowTemplate,
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
            .options(selectinload(WorkflowTemplate.stages).selectinload(WorkflowStage.approver_rules))
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
        if visible_to_user_id is not None and not include_private_of_others:
            q = q.where(
                or_(
                    WorkflowTemplate.visibility != "private",
                    WorkflowTemplate.created_by == visible_to_user_id,
                )
            )
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
        result = await self.db.execute(
            select(WorkflowStage)
            .options(
                selectinload(WorkflowStage.approver_rules),
                selectinload(WorkflowStage.conditions),
            )
            .where(WorkflowStage.template_id == template_id)
            .order_by(WorkflowStage.sequence_order)
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

    async def get_by_id(self, step_id: uuid.UUID) -> ApprovalStep | None:
        return await self.db.get(ApprovalStep, step_id)

    async def get_pending_for_approver(
        self,
        approver_id: uuid.UUID,
        org_id: uuid.UUID | None = None,
    ) -> Sequence[ApprovalStep]:
        """Get all pending approval steps assigned to a user."""
        q = (
            select(ApprovalStep)
            .where(
                ApprovalStep.approver_id == approver_id,
                ApprovalStep.decision == "pending",
            )
            .order_by(ApprovalStep.due_at.asc().nullslast())
        )
        if org_id:
            q = q.join(WorkflowInstance).where(WorkflowInstance.org_id == org_id)
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

    async def get_overdue_pending(self, as_of: datetime | None = None) -> Sequence[ApprovalStep]:
        """Return pending steps past their due_at (for SLA worker)."""
        if as_of is None:
            as_of = datetime.now(timezone.utc)
        result = await self.db.execute(
            select(ApprovalStep).where(
                ApprovalStep.decision == "pending",
                ApprovalStep.due_at < as_of,
                ApprovalStep.escalated_at.is_(None),
            )
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
