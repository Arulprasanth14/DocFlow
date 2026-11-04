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
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import EventBus
from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.domain.enums import (
    AuditAction,
    ApprovalDecision,
    ConversationKind,
    NotificationType,
    WorkflowInstanceStatus,
)
from app.domain.permissions import AuthUser
from app.models.document import Document, DocumentStatus
from app.models.organization import Organization
from app.models.workflow import ApprovalStep, WorkflowInstance, WorkflowStage
from app.repositories.chat_repo import ConversationRepository
from app.repositories.org_repo import OrgMemberRepository
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
        """
        NOTE: stage_name/approver_name/approver_email/document context were all
        declared on ApprovalStepResponse ("populated when loaded with joins")
        but no code path ever actually populated them — the approvals queue UI
        had nothing to show per row except raw UUIDs. Batch-fetched below (one
        query per related table, not one per step) rather than N+1 per field.
        """
        steps = await self.step_repo.get_pending_for_approver(approver_id, org_id)
        if not steps:
            return []

        from app.models.user import User

        stage_ids = {s.stage_id for s in steps}
        instance_ids = {s.instance_id for s in steps}

        stages_by_id = {
            st.id: st for st in
            (await self.db.execute(select(WorkflowStage).where(WorkflowStage.id.in_(stage_ids)))).scalars().all()
        }
        instances_by_id = {
            i.id: i for i in
            (await self.db.execute(select(WorkflowInstance).where(WorkflowInstance.id.in_(instance_ids)))).scalars().all()
        }
        doc_ids = {i.document_id for i in instances_by_id.values()}
        docs_by_id = {
            d.id: d for d in
            (await self.db.execute(select(Document).where(Document.id.in_(doc_ids)))).scalars().all()
        } if doc_ids else {}

        user_ids = {s.approver_id for s in steps} | {d.submitted_by for d in docs_by_id.values()}
        users_by_id = {
            u.id: u for u in
            (await self.db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        } if user_ids else {}

        responses = []
        for s in steps:
            stage = stages_by_id.get(s.stage_id)
            instance = instances_by_id.get(s.instance_id)
            doc = docs_by_id.get(instance.document_id) if instance else None
            approver = users_by_id.get(s.approver_id)
            submitter = users_by_id.get(doc.submitted_by) if doc else None

            resp = ApprovalStepResponse.model_validate(s)
            resp.stage_name = stage.name if stage else None
            resp.approver_name = approver.name if approver else None
            resp.approver_email = approver.email if approver else None
            resp.document_id = doc.id if doc else None
            resp.document_title = doc.title if doc else None
            resp.document_public_id = doc.public_id if doc else None
            resp.submitted_by = doc.submitted_by if doc else None
            resp.submitter_name = submitter.name if submitter else None
            responses.append(resp)
        return responses

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

        doc = await self.db.get(Document, instance.document_id)
        if not doc:
            raise NotFoundException("Document not found")

        # Hard backend gates — enforced unconditionally, independent of how
        # step.approver_id was resolved/configured, so neither a misconfigured
        # StageApproverRule nor a direct API call can grant approval/signing
        # authority to someone who shouldn't have it (per DocFlow role policy:
        # Trainees never approve/sign; self-approval is opt-in per org).
        await self._enforce_approval_authority(actor_id, org_id, doc)

        # Authorization check
        await self._authorize_actor(step, actor_id)

        # Signature enforcement: if stage.requires_signature, an Approve decision
        # MUST include a valid ESignatureRequest
        if req.decision == ApprovalDecision.APPROVED:
            stage = await self.db.get(WorkflowStage, step.stage_id)
            if stage and stage.requires_signature and not req.signature:
                from app.core.exceptions import UnprocessableEntityException
                raise UnprocessableEntityException(
                    "This stage requires a digital signature to approve. "
                    "Provide a 'signature' in your request body."
                )

        # Record decision
        step = await self.step_repo.record_decision(
            step_id=step_id,
            decision=req.decision,
            decision_note=req.note,
        )

        # Cryptographically sign EVERY decision (§6.4) — not only the ones
        # where a stage opted into a signing ceremony via requires_signature.
        # The requirement is that approval decisions are "attributable to the
        # authenticated approver and protected against tampering", which
        # applies to approve/reject/changes-requested alike; `req.signature`
        # (drawn/typed/provider) remains optional ceremony metadata layered
        # on top of the real RSA-PSS-SHA256 proof generated here.
        await self._sign_decision(
            step=step,
            instance=instance,
            doc=doc,
            actor_id=actor_id,
            decision=req.decision,
            ip_address=ip_address,
            user_agent=user_agent,
            ceremony=req.signature,
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

        # Get all current-round steps for this stage. A revoked (§6.5) or
        # version-superseded decision must NOT count toward the gate — the
        # original row is preserved for audit but is no longer a live
        # approval, so a revoked approval can never silently satisfy a stage.
        current_steps = await self.step_repo.get_current_round_steps(instance.id, step.stage_id)
        approved_count = sum(
            1
            for s in current_steps
            if s.decision == ApprovalDecision.APPROVED and s.is_counted
        )

        if approved_count >= stage.min_approvals_required:
            # Stage gate passed — advance
            await self.workflow_svc.advance_stage(
                instance=instance,
                org_id=org_id,
                requester_id=actor_id,
                current_version_id=step.document_version_id,
            )

        # Notify document owner of progress via EventBus (subscribers.py dispatches)
        # DO NOT also call notif_svc.notify() here — that would double-fire.
        doc = await self.db.get(Document, instance.document_id)
        if doc:
            EventBus.publish("document.status_changed", {
                "doc_id": str(instance.document_id),
                "org_id": str(org_id),
                "new_status": "approved",
                "event": "workflow_stage_approved",
                # Notification fields for subscribers.py:
                "notif_user_id": str(doc.submitted_by),
                "notif_type": NotificationType.APPROVED,
                "notif_title": "Approval step approved",
                "notif_body": f"Stage '{stage.name}' has been approved.",
                "notif_deep_link": f"/documents/{doc.id}",
                "notif_instance_id": str(instance.id),
            })

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
            EventBus.publish("document.status_changed", {
                "doc_id": str(instance.document_id),
                "org_id": str(instance.org_id),
                "new_status": DocumentStatus.REJECTED,
                "event": "workflow_rejected",
                # Notification fields for subscribers.py:
                "notif_user_id": str(doc.submitted_by),
                "notif_type": NotificationType.REJECTED,
                "notif_title": "Document rejected",
                "notif_body": f"Your document '{doc.title}' was rejected.",
                "notif_deep_link": f"/documents/{doc.id}",
                "notif_instance_id": str(instance.id),
            })
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
            # SENT_BACK is the canonical diagram value for "returned for changes"
            doc.status = DocumentStatus.SENT_BACK
        await self.db.flush()

        if doc:
            EventBus.publish("document.status_changed", {
                "doc_id": str(instance.document_id),
                "org_id": str(instance.org_id),
                "new_status": DocumentStatus.SENT_BACK,
                "event": "changes_requested",
            })

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

        # 4. Notify document owner via EventBus (subscribers.py dispatches)
        # DO NOT also call notif_svc.notify() here — that would double-fire.
        if doc:
            EventBus.publish("document.status_changed", {
                "doc_id": str(instance.document_id),
                "org_id": str(org_id),
                "new_status": DocumentStatus.SENT_BACK,
                "event": "changes_requested",
                # Notification fields for subscribers.py:
                "notif_user_id": str(doc.submitted_by),
                "notif_type": NotificationType.CHANGES_REQUESTED,
                "notif_title": "Changes requested on your document",
                "notif_body": f"An approver has requested changes on '{doc.title}'.",
                "notif_deep_link": f"/chat/{conv_id}",
                "notif_instance_id": str(instance.id),
                "notif_metadata": {"conversation_id": str(conv_id)},
            })
        logger.info(
            "changes_requested",
            instance_id=str(instance.id),
            step_id=str(step.id),
            conversation_id=str(conv_id),
        )

    # ── Get Single Step ──────────────────────────────────────────────────────────

    async def get_step(
        self,
        step_id: uuid.UUID,
        user: AuthUser,
    ) -> ApprovalStepResponse:
        """
        Get a single approval step. Readable by the assigned approver/delegate,
        or by anyone who can otherwise access the underlying document.
        """
        step = await self.step_repo.get_by_id(step_id)
        if not step:
            raise NotFoundException("ApprovalStep not found")

        instance = await self.instance_repo.get_by_id(step.instance_id, user.org_id)
        if not instance:
            raise NotFoundException("ApprovalStep not found")

        try:
            await self._authorize_actor(step, user.id)
        except ForbiddenException:
            from app.services.document_service import can_user_access_document
            doc = await self.db.get(Document, instance.document_id)
            if not doc or not await can_user_access_document(self.db, user, doc):
                raise ForbiddenException("You do not have permission to view this approval step")

        return ApprovalStepResponse.model_validate(step)

    # ── Revocation / Recall (§6.5) ──────────────────────────────────────────────

    async def revoke_decision(
        self,
        step_id: uuid.UUID,
        actor_id: uuid.UUID,
        org_id: uuid.UUID,
        reason: str,
    ) -> dict:
        """
        Revoke/recall a decision the actor already recorded (§6.5).

        Rules enforced here:
          - Only the approver who made the decision (or their delegate) may
            revoke it.
          - A FINALIZED workflow cannot be revoked — that requires the
            explicit reopen/supersede process ("Once a workflow is formally
            finalized, changes should follow a defined reopening or
            superseding-document process rather than silently altering the
            finalized record").
          - If NOTHING downstream has happened, the revocation applies
            immediately and the document returns to its owner for
            correction.
          - If the document HAS already moved to a later approver, the
            earlier approver may NOT roll it back. A recall REQUEST is
            recorded, the instance moves to RECALL_REQUESTED, and affected
            participants are notified. The workflow stays OPEN either way.
          - The original ApprovalStep row is never deleted and its
            `decision` is never rewritten.
        """
        from app.models.workflow import ApprovalRevocation, WorkflowStage

        step = await self.step_repo.get_by_id(step_id)
        if not step:
            raise NotFoundException("ApprovalStep not found")

        instance = await self.instance_repo.get_by_id(step.instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")

        if step.decision == ApprovalDecision.PENDING:
            raise ConflictException("This step has no decision to revoke")
        if step.revoked_at is not None:
            raise ConflictException("This decision has already been revoked")
        if instance.status == WorkflowInstanceStatus.FINALIZED:
            raise ConflictException(
                "This workflow is already finalized. A finalized record cannot be "
                "altered — reopen it or supersede the document instead."
            )

        # Only the deciding approver (or an active delegate of theirs) may revoke.
        await self._authorize_actor(step, actor_id)

        now = datetime.now(timezone.utc)
        doc = await self.db.get(Document, instance.document_id)

        # Has anything downstream happened? Either a later stage has
        # progressed, or another step recorded a decision after this one.
        this_stage = await self.db.get(WorkflowStage, step.stage_id)
        all_steps = await self.step_repo.get_for_instance(instance.id)
        stage_ids = {s.stage_id for s in all_steps}
        stages_by_id = {
            st.id: st
            for st in (
                await self.db.execute(
                    select(WorkflowStage).where(WorkflowStage.id.in_(stage_ids))
                )
            ).scalars().all()
        } if stage_ids else {}

        downstream_steps = [
            s
            for s in all_steps
            if s.id != step.id
            and s.decision != ApprovalDecision.PENDING
            and s.revoked_at is None
            and this_stage is not None
            and (stages_by_id.get(s.stage_id) is not None)
            and stages_by_id[s.stage_id].sequence_order > this_stage.sequence_order
        ]

        if not downstream_steps:
            # ── Immediate revocation path ──────────────────────────────────
            step.revoked_at = now
            step.revoked_by = actor_id
            step.revocation_reason = reason

            revocation = ApprovalRevocation(
                org_id=org_id,
                instance_id=instance.id,
                approval_step_id=step.id,
                requested_by=actor_id,
                reason=reason,
                status="applied",
                affected_step_ids=[],
                resolved_by=actor_id,
                resolved_at=now,
            )
            self.db.add(revocation)

            # Workflow stays OPEN and goes back for correction — it must NOT
            # be closed just because an approval was revoked.
            instance.status = WorkflowInstanceStatus.CHANGES_REQUESTED
            instance.completed_at = None
            if doc:
                doc.status = DocumentStatus.REVOKED
            await self.db.flush()

            await self._write_audit(
                org_id=org_id,
                actor_id=actor_id,
                action="approval.revoked",
                resource_type="ApprovalStep",
                resource_id=step.id,
                instance_id=instance.id,
                before={"decision": step.decision, "revoked": False},
                after={
                    "decision": step.decision,
                    "revoked": True,
                    "reason": reason,
                    "revocation_status": "applied",
                },
            )

            if doc:
                await self.notif_svc.notify(
                    org_id=org_id,
                    user_id=doc.submitted_by,
                    type=NotificationType.CHANGES_REQUESTED,
                    title="An approval was revoked",
                    body=(
                        f"An approver revoked their decision on '{doc.title}' and "
                        f"returned it for correction. Reason: {reason}"
                    ),
                    deep_link=f"/documents/{doc.id}",
                    instance_id=instance.id,
                )

            await self.db.commit()
            logger.info(
                "approval_revocation_applied",
                step_id=str(step.id),
                instance_id=str(instance.id),
            )
            return {
                "status": "applied",
                "revocation_id": str(revocation.id),
                "instance_status": instance.status,
                "affected_step_ids": [],
                "detail": "Approval revoked. The document was returned to its owner for correction.",
            }

        # ── Controlled recall path (downstream work already happened) ──────
        revocation = ApprovalRevocation(
            org_id=org_id,
            instance_id=instance.id,
            approval_step_id=step.id,
            requested_by=actor_id,
            reason=reason,
            status="requested",
            affected_step_ids=[str(s.id) for s in downstream_steps],
        )
        self.db.add(revocation)

        # Instance stays OPEN, flagged as having an outstanding recall.
        instance.status = WorkflowInstanceStatus.RECALL_REQUESTED
        instance.completed_at = None
        await self.db.flush()

        await self._write_audit(
            org_id=org_id,
            actor_id=actor_id,
            action="approval.recall_requested",
            resource_type="ApprovalStep",
            resource_id=step.id,
            instance_id=instance.id,
            after={
                "reason": reason,
                "revocation_status": "requested",
                "affected_step_ids": [str(s.id) for s in downstream_steps],
            },
        )

        # Notify affected participants: downstream approvers + the owner.
        affected_users = {s.approver_id for s in downstream_steps}
        if doc:
            affected_users.add(doc.submitted_by)
        if affected_users:
            await self.notif_svc.notify_many(
                org_id=org_id,
                user_ids=list(affected_users),
                type=NotificationType.SYSTEM,
                title="Approval recall requested",
                body=(
                    "An earlier approver requested to recall their approval on "
                    f"'{doc.title if doc else 'a document'}'. Reason: {reason}"
                ),
                deep_link=f"/documents/{doc.id}" if doc else "/approvals",
                instance_id=instance.id,
            )

        await self.db.commit()
        logger.info(
            "approval_recall_requested",
            step_id=str(step.id),
            instance_id=str(instance.id),
            affected=len(downstream_steps),
        )
        return {
            "status": "requested",
            "revocation_id": str(revocation.id),
            "instance_status": instance.status,
            "affected_step_ids": [str(s.id) for s in downstream_steps],
            "detail": (
                "The document has already moved to a later approver, so it was not "
                "rolled back. A recall request was recorded and affected participants "
                "were notified; an administrator must approve or deny the recall."
            ),
        }

    async def resolve_recall(
        self,
        revocation_id: uuid.UUID,
        actor_id: uuid.UUID,
        org_id: uuid.UUID,
        approve: bool,
        note: str | None = None,
        actor_roles: list[str] | None = None,
        actor_is_superadmin: bool = False,
    ) -> dict:
        """
        Approve or deny an outstanding recall request (§6.5).

        Approving invalidates the recalled decision AND every affected
        downstream decision (preserving all rows), then returns the document
        to its owner for correction. Denying leaves every decision standing
        and puts the workflow back in progress. Either way the original
        records are preserved and the resolution is audited.

        Authorization: an organization administrator (Main Admin or HR) or
        the platform superadmin — not the requester acting alone, since this
        is the "controlled" part of a controlled recall.
        """
        from app.models.workflow import ApprovalRevocation

        if not (actor_is_superadmin or ({"admin", "hr"} & set(actor_roles or []))):
            raise ForbiddenException(
                "Only an organization administrator can approve or deny a recall request"
            )

        revocation = await self.db.get(ApprovalRevocation, revocation_id)
        if not revocation or revocation.org_id != org_id:
            raise NotFoundException("Recall request not found")
        if revocation.status != "requested":
            raise ConflictException(
                f"This recall request is already resolved ('{revocation.status}')"
            )

        instance = await self.instance_repo.get_by_id(revocation.instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")

        now = datetime.now(timezone.utc)
        doc = await self.db.get(Document, instance.document_id)
        step = await self.step_repo.get_by_id(revocation.approval_step_id)

        if approve:
            # Invalidate the recalled decision and all affected downstream ones.
            if step:
                step.revoked_at = now
                step.revoked_by = revocation.requested_by
                step.revocation_reason = revocation.reason

            for affected_id in revocation.affected_step_ids or []:
                affected = await self.step_repo.get_by_id(uuid.UUID(affected_id))
                if affected and affected.revoked_at is None:
                    # Preserved, but no longer counts — it was given against a
                    # document state that the recall invalidated.
                    affected.superseded_at = now

            revocation.status = "approved"
            instance.status = WorkflowInstanceStatus.CHANGES_REQUESTED
            instance.completed_at = None
            if doc:
                doc.status = DocumentStatus.REVOKED
            detail = (
                "Recall approved. The recalled approval and all affected downstream "
                "approvals were invalidated (records preserved) and the document was "
                "returned for correction."
            )
        else:
            revocation.status = "denied"
            # Workflow resumes exactly where it was — nothing was rolled back.
            instance.status = WorkflowInstanceStatus.IN_PROGRESS
            detail = "Recall denied. All existing approvals stand and the workflow continues."

        revocation.resolution_note = note
        revocation.resolved_by = actor_id
        revocation.resolved_at = now
        await self.db.flush()

        await self._write_audit(
            org_id=org_id,
            actor_id=actor_id,
            action="approval.recall_approved" if approve else "approval.recall_denied",
            resource_type="ApprovalRevocation",
            resource_id=revocation.id,
            instance_id=instance.id,
            after={
                "status": revocation.status,
                "note": note,
                "affected_step_ids": revocation.affected_step_ids,
            },
        )

        notify_users = {revocation.requested_by}
        if doc:
            notify_users.add(doc.submitted_by)
        for affected_id in revocation.affected_step_ids or []:
            affected = await self.step_repo.get_by_id(uuid.UUID(affected_id))
            if affected:
                notify_users.add(affected.approver_id)
        if notify_users:
            await self.notif_svc.notify_many(
                org_id=org_id,
                user_ids=list(notify_users),
                type=NotificationType.SYSTEM,
                title=f"Approval recall {'approved' if approve else 'denied'}",
                body=detail,
                deep_link=f"/documents/{doc.id}" if doc else "/approvals",
                instance_id=instance.id,
            )

        await self.db.commit()
        logger.info(
            "approval_recall_resolved",
            revocation_id=str(revocation.id),
            approved=approve,
        )
        return {
            "status": revocation.status,
            "revocation_id": str(revocation.id),
            "instance_status": instance.status,
            "detail": detail,
        }

    async def list_recalls(self, org_id: uuid.UUID, instance_id: uuid.UUID | None = None) -> list[dict]:
        """Outstanding and historical recall requests for the org (or one instance)."""
        from app.models.workflow import ApprovalRevocation

        q = select(ApprovalRevocation).where(ApprovalRevocation.org_id == org_id)
        if instance_id:
            q = q.where(ApprovalRevocation.instance_id == instance_id)
        rows = (
            await self.db.execute(q.order_by(ApprovalRevocation.created_at.desc()))
        ).scalars().all()
        return [
            {
                "id": str(r.id),
                "instance_id": str(r.instance_id),
                "approval_step_id": str(r.approval_step_id),
                "requested_by": str(r.requested_by),
                "reason": r.reason,
                "status": r.status,
                "affected_step_ids": r.affected_step_ids,
                "resolution_note": r.resolution_note,
                "resolved_by": str(r.resolved_by) if r.resolved_by else None,
                "resolved_at": r.resolved_at.isoformat() if r.resolved_at else None,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]

    # ── Finalization (§6.2 / §6.6) ──────────────────────────────────────────────

    async def finalize_workflow(
        self,
        instance_id: uuid.UUID,
        actor_id: uuid.UUID,
        org_id: uuid.UUID,
        actor_roles: list[str] | None = None,
        actor_is_superadmin: bool = False,
    ) -> dict:
        """
        Explicitly finalize/close a workflow (§6.2 "Finalize/Close: only the
        authorized final approver may finalize the workflow, and only when
        all required steps and conditions are satisfied"; §6.6 "Closing must
        be blocked while mandatory steps, corrections, or required
        re-approvals remain incomplete").

        Blocks finalization when:
          - the instance isn't in APPROVED state (i.e. approvals outstanding)
          - any step is still pending
          - any recall request is unresolved
          - any recorded signature fails verification (§6.4 "Verify
            signatures and document hashes when ... finalizing a workflow")

        Authorized actors: an approver on the FINAL stage of this instance,
        an org administrator (Main Admin/HR), or the platform superadmin.
        """
        from app.models.workflow import ApprovalRevocation, WorkflowStage

        instance = await self.instance_repo.get_by_id(instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")
        if instance.status == WorkflowInstanceStatus.FINALIZED:
            raise ConflictException("This workflow is already finalized")
        if instance.status != WorkflowInstanceStatus.APPROVED:
            raise ConflictException(
                f"This workflow cannot be finalized while its status is "
                f"'{instance.status}' — every required approval must be complete first."
            )

        all_steps = await self.step_repo.get_for_instance(instance.id)
        pending = [s for s in all_steps if s.decision == ApprovalDecision.PENDING]
        if pending:
            raise ConflictException(
                f"{len(pending)} approval step(s) are still pending — "
                "the workflow cannot be closed yet."
            )

        open_recalls = (
            await self.db.execute(
                select(ApprovalRevocation).where(
                    ApprovalRevocation.instance_id == instance.id,
                    ApprovalRevocation.status == "requested",
                )
            )
        ).scalars().all()
        if open_recalls:
            raise ConflictException(
                "An approval recall request is still outstanding — resolve it "
                "before finalizing this workflow."
            )

        # Authorization: final-stage approver, org admin, or superadmin.
        is_admin = actor_is_superadmin or bool({"admin", "hr"} & set(actor_roles or []))
        if not is_admin:
            stage_ids = {s.stage_id for s in all_steps}
            stages = (
                await self.db.execute(
                    select(WorkflowStage).where(WorkflowStage.id.in_(stage_ids))
                )
            ).scalars().all() if stage_ids else []
            final_order = max((st.sequence_order for st in stages), default=None)
            final_stage_ids = {
                st.id for st in stages if st.sequence_order == final_order
            }
            actor_is_final_approver = any(
                s.approver_id == actor_id and s.stage_id in final_stage_ids
                for s in all_steps
            )
            if not actor_is_final_approver:
                raise ForbiddenException(
                    "Only the final approver on this workflow (or an organization "
                    "administrator) can finalize it."
                )

        # Verify every recorded signature before closing the record.
        signature_results = []
        for s in all_steps:
            if s.decision == ApprovalDecision.PENDING or not s.is_counted:
                continue
            result = await self.verify_step_signature(s.id, org_id, actor_id)
            signature_results.append(result)
        invalid = [r for r in signature_results if r.get("signed") and not r.get("valid")]
        if invalid:
            raise ConflictException(
                f"{len(invalid)} recorded signature(s) failed verification — the "
                "document or its approval records may have been altered. "
                "Finalization is blocked."
            )

        now = datetime.now(timezone.utc)
        instance.status = WorkflowInstanceStatus.FINALIZED
        instance.completed_at = now
        doc = await self.db.get(Document, instance.document_id)
        if doc:
            doc.status = DocumentStatus.FINALIZED
        await self.db.flush()

        await self._write_audit(
            org_id=org_id,
            actor_id=actor_id,
            action="workflow.finalized",
            resource_type="WorkflowInstance",
            resource_id=instance.id,
            instance_id=instance.id,
            after={
                "status": WorkflowInstanceStatus.FINALIZED,
                "signatures_verified": len(signature_results),
            },
        )

        if doc:
            await self.notif_svc.notify(
                org_id=org_id,
                user_id=doc.submitted_by,
                type=NotificationType.APPROVED,
                title="Document finalized",
                body=f"'{doc.title}' has been finalized and closed.",
                deep_link=f"/documents/{doc.id}",
                instance_id=instance.id,
            )

        await self.db.commit()
        logger.info("workflow_finalized", instance_id=str(instance.id), actor=str(actor_id))
        return {
            "instance_id": str(instance.id),
            "status": WorkflowInstanceStatus.FINALIZED,
            "signatures_verified": len(signature_results),
            "finalized_at": now.isoformat(),
        }

    # ── Approval History / Chain of Custody (§6.6) ──────────────────────────────

    async def get_approval_history(
        self,
        instance_id: uuid.UUID,
        org_id: uuid.UUID,
        user: AuthUser,
    ) -> dict:
        """
        The full, ordered chain of custody for a workflow instance (§6.6):
        who approved before whom, at which step, with what decision, when,
        with what comment, against which document version, and whether a
        cryptographic signature exists and currently verifies.

        Access control: the caller must be able to read the underlying
        document (same rule as the document itself — owner, org admin/HR, or
        department/workflow participant).
        """
        from app.models.user import User
        from app.models.workflow import ApprovalRevocation, WorkflowStage
        from app.services.document_service import can_user_access_document

        instance = await self.instance_repo.get_by_id(instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")

        doc = await self.db.get(Document, instance.document_id)
        if not doc:
            raise NotFoundException("Document not found")
        # Participation also grants visibility: an approver on this instance
        # must be able to see who decided before them even if the generic
        # document-visibility rule wouldn't otherwise include them.
        all_steps = await self.step_repo.get_for_instance(instance.id)
        is_participant = any(s.approver_id == user.id for s in all_steps)
        if not is_participant and not await can_user_access_document(self.db, user, doc):
            raise ForbiddenException("You do not have permission to view this approval history")

        stage_ids = {s.stage_id for s in all_steps}
        stages_by_id = {
            st.id: st
            for st in (
                await self.db.execute(
                    select(WorkflowStage).where(WorkflowStage.id.in_(stage_ids))
                )
            ).scalars().all()
        } if stage_ids else {}

        user_ids = {s.approver_id for s in all_steps} | {
            s.revoked_by for s in all_steps if s.revoked_by
        }
        users_by_id = {
            u.id: u
            for u in (
                await self.db.execute(select(User).where(User.id.in_(user_ids)))
            ).scalars().all()
        } if user_ids else {}

        entries = []
        for s in sorted(
            all_steps,
            key=lambda x: (
                stages_by_id[x.stage_id].sequence_order if x.stage_id in stages_by_id else 0,
                x.round_number,
                x.created_at or datetime.min.replace(tzinfo=timezone.utc),
            ),
        ):
            stage = stages_by_id.get(s.stage_id)
            approver = users_by_id.get(s.approver_id)
            sig = await self.step_repo.get_esignature(s.id)
            signature_info = None
            if sig and sig.signature_b64:
                signature_info = {
                    "algorithm": sig.algorithm,
                    "key_id": sig.key_id,
                    "signed_at": sig.signed_at.isoformat() if sig.signed_at else None,
                    "last_verified_at": (
                        sig.last_verified_at.isoformat() if sig.last_verified_at else None
                    ),
                    "last_verification_valid": sig.last_verification_valid,
                }
            entries.append({
                "step_id": str(s.id),
                "stage_id": str(s.stage_id),
                "stage_name": stage.name if stage else None,
                "stage_order": stage.sequence_order if stage else None,
                "round_number": s.round_number,
                "approver_id": str(s.approver_id),
                "approver_name": approver.name if approver else None,
                "approver_email": approver.email if approver else None,
                "decision": s.decision,
                "decision_note": s.decision_note,
                "decided_at": s.decided_at.isoformat() if s.decided_at else None,
                "document_version_id": str(s.document_version_id),
                "counts_toward_approval": s.is_counted,
                "revoked_at": s.revoked_at.isoformat() if s.revoked_at else None,
                "revoked_by": str(s.revoked_by) if s.revoked_by else None,
                "revocation_reason": s.revocation_reason,
                "superseded_at": s.superseded_at.isoformat() if s.superseded_at else None,
                "signature": signature_info,
            })

        recalls = await self.list_recalls(org_id, instance_id=instance.id)

        current_stage = (
            stages_by_id.get(instance.current_stage_id)
            if instance.current_stage_id
            else None
        )
        outstanding = [
            {
                "step_id": str(s.id),
                "stage_name": stages_by_id[s.stage_id].name if s.stage_id in stages_by_id else None,
                "approver_id": str(s.approver_id),
            }
            for s in all_steps
            if s.decision == ApprovalDecision.PENDING
        ]

        return {
            "instance_id": str(instance.id),
            "document_id": str(doc.id),
            "document_title": doc.title,
            "document_status": doc.status.value if hasattr(doc.status, "value") else doc.status,
            "instance_status": instance.status,
            "current_stage_id": str(instance.current_stage_id) if instance.current_stage_id else None,
            "current_stage_name": current_stage.name if current_stage else None,
            "submitted_at": instance.submitted_at.isoformat() if instance.submitted_at else None,
            "completed_at": instance.completed_at.isoformat() if instance.completed_at else None,
            "can_finalize": (
                instance.status == WorkflowInstanceStatus.APPROVED
                and not outstanding
                and not any(r["status"] == "requested" for r in recalls)
            ),
            "outstanding_steps": outstanding,
            "history": entries,
            "recalls": recalls,
        }

    # ── Digital Signatures (§6.4) ───────────────────────────────────────────────

    async def _sign_decision(
        self,
        *,
        step: ApprovalStep,
        instance: WorkflowInstance,
        doc: Document,
        actor_id: uuid.UUID,
        decision: str,
        ip_address: str | None,
        user_agent: str | None,
        ceremony=None,
    ) -> None:
        """
        Produce and persist a cryptographic signature binding this decision
        to the approver, the exact document version, the workflow step, and
        the moment in time — per requirements §6.4.

        Failure to sign must NOT silently pass: a decision that cannot be
        cryptographically attributed is not acceptable under §6.4/§15, so
        the exception propagates and the whole decision transaction rolls
        back rather than recording an unsigned, unverifiable approval.
        """
        from app.core.signing import payload_hash as _payload_hash, sign_payload
        from app.models.document import DocumentVersion

        version = await self.db.get(DocumentVersion, step.document_version_id)
        signed_at = datetime.now(timezone.utc)

        payload = {
            "approver_id": str(actor_id),
            "approval_step_id": str(step.id),
            "instance_id": str(instance.id),
            "stage_id": str(step.stage_id),
            "document_id": str(doc.id),
            "document_public_id": doc.public_id,
            "document_version_id": str(step.document_version_id),
            # Binds the signature to the document CONTENT, so any later
            # change to the bytes/form data is detectable (§6.4 "Any
            # document change after signing must be detectable").
            "document_version_num": version.version_num if version else None,
            "document_version_checksum": version.checksum if version else None,
            "decision": str(decision),
            "round_number": step.round_number,
            "signed_at": signed_at.isoformat(),
        }

        sig = sign_payload(payload)

        await self.step_repo.add_esignature(
            step_id=step.id,
            # The decision itself IS the signing event unless the approver
            # went through an explicit drawn/typed ceremony.
            signature_method=(ceremony.signature_method if ceremony else "system"),
            # Legacy column, NOT NULL: prefer the document-content hash it
            # was always meant to hold; fall back to the payload hash so the
            # row is still self-describing for form-only documents that have
            # no binary checksum.
            signed_hash=(
                (version.checksum if version and version.checksum else None)
                or (ceremony.signed_hash if ceremony and ceremony.signed_hash else None)
                or _payload_hash(payload)
            ),
            ip_address=ip_address,
            user_agent=user_agent,
            provider_reference=(ceremony.provider_reference if ceremony else None),
            signed_payload=payload,
            payload_hash=sig["payload_hash"],
            signature_b64=sig["signature"],
            algorithm=sig["algorithm"],
            key_id=sig["key_id"],
        )

    async def verify_step_signature(
        self, step_id: uuid.UUID, org_id: uuid.UUID, actor_id: uuid.UUID | None = None
    ) -> dict:
        """
        Re-verify a step's stored signature and report the result (§6.4:
        "Verify signatures and document hashes when displaying signed
        approvals or finalizing a workflow"; "Record signature verification
        results, key identifiers, timestamps").

        Three independent checks:
          1. payload integrity — the stored payload still hashes to the
             stored payload_hash (detects tampering with the DB row itself)
          2. signature validity — RSA-PSS verification against the public key
          3. document integrity — the document version's CURRENT checksum
             still matches the one captured at signing time (detects a
             document changed after it was signed)
        """
        from app.core.signing import payload_hash as _payload_hash, verify_signature
        from app.models.document import DocumentVersion

        step = await self.step_repo.get_by_id(step_id)
        if not step:
            raise NotFoundException("ApprovalStep not found")
        instance = await self.instance_repo.get_by_id(step.instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")

        sig = await self.step_repo.get_esignature(step_id)
        if not sig or not sig.signature_b64 or not sig.signed_payload:
            return {
                "step_id": str(step_id),
                "signed": False,
                "valid": False,
                "reason": "No cryptographic signature is recorded for this step",
            }

        payload_intact = _payload_hash(sig.signed_payload) == sig.payload_hash
        signature_valid = verify_signature(
            sig.signed_payload, sig.signature_b64, sig.key_id or ""
        )

        document_intact = True
        document_detail = None
        version = await self.db.get(DocumentVersion, step.document_version_id)
        signed_checksum = sig.signed_payload.get("document_version_checksum")
        if version and signed_checksum:
            document_intact = version.checksum == signed_checksum
            if not document_intact:
                document_detail = (
                    "The document version's content hash no longer matches the "
                    "hash that was signed — the document changed after signing."
                )

        valid = bool(payload_intact and signature_valid and document_intact)

        sig.last_verified_at = datetime.now(timezone.utc)
        sig.last_verification_valid = valid
        await self.db.flush()

        await self._write_audit(
            org_id=org_id,
            actor_id=actor_id,
            action="approval.signature_verified",
            resource_type="ESignature",
            resource_id=sig.id,
            instance_id=instance.id,
            after={
                "valid": valid,
                "payload_intact": payload_intact,
                "signature_valid": signature_valid,
                "document_intact": document_intact,
                "key_id": sig.key_id,
                "algorithm": sig.algorithm,
            },
        )
        await self.db.commit()

        return {
            "step_id": str(step_id),
            "signed": True,
            "valid": valid,
            "payload_intact": payload_intact,
            "signature_valid": signature_valid,
            "document_intact": document_intact,
            "algorithm": sig.algorithm,
            "key_id": sig.key_id,
            "signed_at": sig.signed_at.isoformat() if sig.signed_at else None,
            "signer_id": sig.signed_payload.get("approver_id"),
            "decision": sig.signed_payload.get("decision"),
            "document_version_id": sig.signed_payload.get("document_version_id"),
            "verified_at": sig.last_verified_at.isoformat(),
            "reason": document_detail,
        }

    # ── Private: Helpers ────────────────────────────────────────────────────────

    async def _enforce_approval_authority(
        self, actor_id: uuid.UUID, org_id: uuid.UUID, doc: Document
    ) -> None:
        """
        Backend policy gates for any approval decision, resolved live from the
        DB (not from the JWT's role snapshot, which can be stale for up to its
        2-hour lifetime if an admin just changed the actor's role):

        1. A `trainee` may never record an approval decision, full stop —
           Trainees have no approval/signing authority under any
           circumstance, regardless of how a StageApproverRule resolved them.
        2. Self-approval (actor == document submitter) is blocked by default;
           an org may opt in via `Organization.settings.allow_self_approval`.
        """
        member_repo = OrgMemberRepository(self.db)
        membership = await member_repo.get_membership(actor_id, org_id)
        if membership:
            role = await member_repo.get_role(membership.role_id)
            if role and role.name == "trainee":
                raise ForbiddenException(
                    "Trainees do not have approval or signing authority"
                )

        if doc.submitted_by == actor_id:
            org = await self.db.get(Organization, org_id)
            allow_self_approval = bool(
                org and org.settings and org.settings.get("allow_self_approval")
            )
            if not allow_self_approval:
                raise ForbiddenException(
                    "You cannot approve your own document. Ask your organization "
                    "admin to enable self-approval in organization settings if "
                    "this is intentional for your workflow."
                )

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
        actor_id: uuid.UUID | None,
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
