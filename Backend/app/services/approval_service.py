"""
DocFlow Backend — Service: Approval

Handles per-step approval decisions and delegation.

The three decision branches (per architecture §6):

  approved          → advance workflow to next stage (or complete if last stage)
  rejected          → close workflow as rejected; no further stages
  changes_requested → stay at current stage; auto-create Conversation pinned
                      to this ApprovalStep; notify requester

Per-step authorization:
  Only the assigned approver_id (or their active delegate) may decide a step.
  This is enforced at the step level, NOT by route-level role — any `member`
  can call the endpoint, but only the right person can act on a specific step.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.domain.enums import (
    AuditAction,
    ApprovalDecision,
    ConversationKind,
    DocumentStatus,
    NotificationType,
    WorkflowInstanceStatus,
)
from app.models.document import Document
from app.models.workflow import ApprovalStep, WorkflowInstance
from app.repositories.chat_repo import ConversationRepository
from app.repositories.workflow_repo import (
    ApprovalStepRepository,
    DelegationRepository,
    WorkflowInstanceRepository,
)
from app.schemas.workflow_instances import (
    DecisionRequest,
    DelegateRequest,
    ApprovalStepResponse,
)
from app.services.notification_service import NotificationService
from app.services.workflow_service import WorkflowService

logger = structlog.get_logger(__name__)


class ApprovalService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.step_repo = ApprovalStepRepository(db)
        self.instance_repo = WorkflowInstanceRepository(db)
        self.conv_repo = ConversationRepository(db)
        self.delegation_repo = DelegationRepository(db)
        self.notif_svc = NotificationService(db)
        self.workflow_svc = WorkflowService(db)

    # ── List My Pending Approvals ───────────────────────────────────────────────

    async def list_my_approvals(
        self,
        approver_id: uuid.UUID,
        org_id: uuid.UUID,
    ) -> list[ApprovalStepResponse]:
        steps = await self.step_repo.get_pending_for_approver(approver_id, org_id)
        return [ApprovalStepResponse.model_validate(s) for s in steps]

    # ── Record Decision ─────────────────────────────────────────────────────────

    async def decide(
        self,
        step_id: uuid.UUID,
        actor_id: uuid.UUID,
        org_id: uuid.UUID,
        req: DecisionRequest,
        ip_address: str | None = None,
        user_agent: str | None = None,
    ) -> ApprovalStepResponse:
        """
        Record a decision on an ApprovalStep.

        Authorization: actor must be the step's approver_id OR have an active
        delegation from that approver.

        Branches:
          'approved'           → check stage gate; if stage complete, advance
          'rejected'           → mark instance rejected; notify creator
          'changes_requested'  → mark instance changes_requested; auto-create chat;
                                 notify creator
        """
        step = await self.step_repo.get_by_id(step_id)
        if not step:
            raise NotFoundException("ApprovalStep not found")
        if step.decision != ApprovalDecision.PENDING:
            raise ConflictException(f"This step already has a decision: '{step.decision}'")

        # Load instance (for org check)
        instance = await self.instance_repo.get_by_id(step.instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")

        # Authorization check
        await self._authorize_actor(step, actor_id)

        # Record decision
        step = await self.step_repo.record_decision(
            step_id=step_id,
            decision=req.decision,
            decision_note=req.note,
        )

        # Optional e-signature
        if req.decision == ApprovalDecision.APPROVED and req.signature:
            await self.step_repo.add_esignature(
                step_id=step_id,
                signature_method=req.signature.signature_method,
                signed_hash=req.signature.signed_hash,
                ip_address=ip_address,
                user_agent=user_agent,
                provider_reference=req.signature.provider_reference,
            )

        # Write AuditLog
        await self._write_audit(
            org_id=org_id,
            actor_id=actor_id,
            action=self._decision_to_audit_action(req.decision),
            resource_type="ApprovalStep",
            resource_id=step_id,
            instance_id=instance.id,
            after={"decision": req.decision, "note": req.note},
        )

        # Branch on decision
        if req.decision == ApprovalDecision.APPROVED:
            await self._handle_approved(step, instance, actor_id, org_id)
        elif req.decision == ApprovalDecision.REJECTED:
            await self._handle_rejected(step, instance, actor_id, org_id)
        elif req.decision in (ApprovalDecision.CHANGES_REQUESTED, ApprovalDecision.RETURNED):
            await self._handle_changes_requested(step, instance, actor_id, org_id)

        await self.db.commit()
        logger.info(
            "approval_decided",
            step_id=str(step_id),
            decision=req.decision,
            actor=str(actor_id),
        )
        return ApprovalStepResponse.model_validate(step)

    # ── Delegate ────────────────────────────────────────────────────────────────

    async def delegate(
        self,
        step_id: uuid.UUID,
        delegator_id: uuid.UUID,
        org_id: uuid.UUID,
        req: DelegateRequest,
    ) -> ApprovalStepResponse:
        """
        Delegate this specific ApprovalStep to another user.
        Creates a Delegation record and reassigns the step's approver_id.
        """
        step = await self.step_repo.get_by_id(step_id)
        if not step:
            raise NotFoundException("ApprovalStep not found")
        if step.decision != ApprovalDecision.PENDING:
            raise ConflictException("Cannot delegate a step that already has a decision")

        # Only the current approver can delegate
        if step.approver_id != delegator_id:
            raise ForbiddenException("Only the assigned approver can delegate this step")

        # Create delegation record
        await self.delegation_repo.create(
            delegator_id=delegator_id,
            delegate_id=req.delegate_user_id,
            starts_at=datetime.now(timezone.utc),
            ends_at=req.ends_at,
            scope="specific_workflow",
            approval_step_id=step_id,
            reason=req.reason,
        )

        # Reassign the step
        step.approver_id = req.delegate_user_id
        step.decision = ApprovalDecision.DELEGATED
        await self.db.flush()

        # Create a fresh pending step for the delegate
        new_step = await self.step_repo.create(
            instance_id=step.instance_id,
            stage_id=step.stage_id,
            document_version_id=step.document_version_id,
            approver_id=req.delegate_user_id,
            due_at=step.due_at,
            round_number=step.round_number,
        )

        await self._write_audit(
            org_id=org_id,
            actor_id=delegator_id,
            action=AuditAction.APPROVAL_DELEGATE,
            resource_type="ApprovalStep",
            resource_id=step_id,
            instance_id=step.instance_id,
            after={"delegate_user_id": str(req.delegate_user_id), "reason": req.reason},
        )

        # Notify the delegate
        instance = await self.instance_repo.get_by_id(step.instance_id, org_id)
        await self.notif_svc.notify(
            org_id=org_id,
            user_id=req.delegate_user_id,
            type=NotificationType.DELEGATED,
            title="Approval delegated to you",
            body=f"An approval step has been delegated to you.",
            deep_link="/approvals",
            instance_id=step.instance_id,
        )

        await self.db.commit()
        logger.info("approval_delegated", step_id=str(step_id), delegate=str(req.delegate_user_id))
        return ApprovalStepResponse.model_validate(new_step)

    # ── Private: Decision Handlers ──────────────────────────────────────────────

    async def _handle_approved(
        self,
        step: ApprovalStep,
        instance: WorkflowInstance,
        actor_id: uuid.UUID,
        org_id: uuid.UUID,
    ) -> None:
        """
        Check stage gate: if all required approvals met, advance workflow.
        For parallel stages — check min_approvals_required.
        """
        from app.models.workflow import WorkflowStage
        stage = await self.db.get(WorkflowStage, step.stage_id)
        if not stage:
            return

        # Get all current-round steps for this stage
        current_steps = await self.step_repo.get_current_round_steps(instance.id, step.stage_id)
        approved_count = sum(1 for s in current_steps if s.decision == ApprovalDecision.APPROVED)

        if approved_count >= stage.min_approvals_required:
            # Stage gate passed — advance
            await self.workflow_svc.advance_stage(
                instance=instance,
                org_id=org_id,
                requester_id=actor_id,
                current_version_id=step.document_version_id,
            )

        # Notify document owner of progress
        doc = await self.db.get(Document, instance.document_id)
        if doc:
            await self.notif_svc.notify(
                org_id=org_id,
                user_id=doc.submitted_by,
                type=NotificationType.APPROVED,
                title="Approval step approved",
                body=f"Stage '{stage.name}' has been approved.",
                deep_link=f"/documents/{doc.id}",
                instance_id=instance.id,
            )

    async def _handle_rejected(
        self,
        step: ApprovalStep,
        instance: WorkflowInstance,
        actor_id: uuid.UUID,
        org_id: uuid.UUID,
    ) -> None:
        """Mark workflow as rejected; notify document owner."""
        instance.status = WorkflowInstanceStatus.REJECTED
        instance.completed_at = datetime.now(timezone.utc)
        doc = await self.db.get(Document, instance.document_id)
        if doc:
            doc.status = DocumentStatus.REJECTED
        await self.db.flush()

        if doc:
            await self.notif_svc.notify(
                org_id=org_id,
                user_id=doc.submitted_by,
                type=NotificationType.REJECTED,
                title="Document rejected",
                body=f"Your document '{doc.title}' was rejected.",
                deep_link=f"/documents/{doc.id}",
                instance_id=instance.id,
            )
        logger.info("workflow_rejected", instance_id=str(instance.id), step_id=str(step.id))

    async def _handle_changes_requested(
        self,
        step: ApprovalStep,
        instance: WorkflowInstance,
        actor_id: uuid.UUID,
        org_id: uuid.UUID,
    ) -> None:
        """
        Per architecture §6 & §8:
        1. Mark instance.status = changes_requested (current_stage_id UNCHANGED)
        2. Auto-create Conversation(kind=workflow_context, pinned to this step)
        3. Add requester + approver as participants
        4. Notify requester
        """
        # 1. Update instance — DO NOT change current_stage_id
        instance.status = WorkflowInstanceStatus.CHANGES_REQUESTED
        doc = await self.db.get(Document, instance.document_id)
        if doc:
            doc.status = DocumentStatus.CHANGES_REQUESTED
        await self.db.flush()

        # 2. Create (or reuse) the workflow-context conversation for this step
        existing_conv = await self.conv_repo.get_by_approval_step(step.id)
        if not existing_conv:
            conv = await self.conv_repo.create(
                kind=ConversationKind.WORKFLOW_CONTEXT,
                created_by=actor_id,
                workflow_instance_id=instance.id,
                approval_step_id=step.id,
                title=f"Change request — step {step.id}",
            )
            # 3. Add both parties as participants
            await self.conv_repo.add_participant(conv.id, actor_id)  # approver
            if doc:
                await self.conv_repo.add_participant(conv.id, doc.submitted_by)  # requester
            conv_id = conv.id
        else:
            conv_id = existing_conv.id

        # 4. Notify document owner
        if doc:
            await self.notif_svc.notify(
                org_id=org_id,
                user_id=doc.submitted_by,
                type=NotificationType.CHANGES_REQUESTED,
                title="Changes requested on your document",
                body=f"An approver has requested changes on '{doc.title}'.",
                deep_link=f"/chat/{conv_id}",
                instance_id=instance.id,
                metadata={"conversation_id": str(conv_id)},
            )
        logger.info(
            "changes_requested",
            instance_id=str(instance.id),
            step_id=str(step.id),
            conversation_id=str(conv_id),
        )

    # ── Private: Helpers ────────────────────────────────────────────────────────

    async def _authorize_actor(self, step: ApprovalStep, actor_id: uuid.UUID) -> None:
        """
        Verify actor is either the assigned approver or has an active delegation.
        """
        if step.approver_id == actor_id:
            return  # Direct match

        # Check active delegations from the step's approver to actor
        delegations = await self.delegation_repo.get_active_for_user(step.approver_id)
        for d in delegations:
            if d.delegate_id == actor_id:
                return  # Delegated access

        raise ForbiddenException(
            "You are not the assigned approver for this step and have no active delegation"
        )

    def _decision_to_audit_action(self, decision: str) -> str:
        mapping = {
            "approved": AuditAction.APPROVAL_APPROVE,
            "rejected": AuditAction.APPROVAL_REJECT,
            "changes_requested": AuditAction.APPROVAL_CHANGES_REQUESTED,
            "returned": AuditAction.APPROVAL_RETURN,
            "delegated": AuditAction.APPROVAL_DELEGATE,
        }
        return mapping.get(decision, "approval.decide")

    async def _write_audit(
        self,
        org_id: uuid.UUID,
        actor_id: uuid.UUID,
        action: str,
        resource_type: str,
        resource_id: uuid.UUID,
        instance_id: uuid.UUID | None = None,
        before: dict | None = None,
        after: dict | None = None,
    ) -> None:
        from app.models.audit import AuditLog
        log = AuditLog(
            org_id=org_id,
            actor_id=actor_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            instance_id=instance_id,
            before=before,
            after=after,
        )
        self.db.add(log)
        await self.db.flush()
