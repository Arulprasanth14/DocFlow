"""
DocFlow Backend — Service: Workflow (Submission & Execution)

Implements the core workflow lifecycle per DocFlow-System-Architecture.md §6 & §8:

  submit()          — POST /documents/{id}/submit
  resume()          — POST /documents/{id}/revise-and-resume
  cancel()          — POST /workflow-instances/{id}/cancel
  get_instance()    — GET /workflow-instances/{id}
  stream_status()   — GET /workflow-instances/{id}/stream (SSE generator)
  advance_stage()   — internal: advance from one stage to the next after approval
  _resolve_approvers()  — resolve StageApproverRule → actual user IDs

CRITICAL INVARIANT — Resume at flagged stage, not from beginning:
  When a stage requests changes (changes_requested), WorkflowInstance.current_stage_id
  is NEVER reset. /revise-and-resume creates a NEW ApprovalStep at the SAME stage
  and increments round_number. Earlier stages' approved rows are untouched.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator, Sequence

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnprocessableEntityException,
)
from app.core.events import EventBus
from app.domain.permissions import AuthUser
from app.domain.enums import (
    AuditAction,
    WorkflowInstanceStatus,
)
from app.models.document import Document, DocumentVersion, DocumentStatus
from app.models.workflow import (
    ApprovalStep,
    StageInstance,
    ReviewRound,
    WorkflowInstance,
    WorkflowStage,
    WorkflowTemplate,
    WorkflowTemplateVersion,
    WorkflowVersionStage,
)
from app.repositories.workflow_repo import (
    ApprovalStepRepository,
    WorkflowInstanceRepository,
    WorkflowStageRepository,
    WorkflowTemplateRepository,
)
from app.schemas.workflow_instances import (
    CancelWorkflowRequest,
    PreflightResponse,
    PreflightStage,
    ReviseAndResumeRequest,
    SubmitDocumentRequest,
    WorkflowInstanceResponse,
)
from app.domain import notifications as notif_catalogue
from app.services.notification_service import NotificationService
from app.services.outbox_service import OutboxService

logger = structlog.get_logger(__name__)

# A run in one of these states is finished and its record is closed: no new
# decision, no withdrawal, no clock. The same set the BR-01 one-live-run
# index uses, so "live run" means the same thing to the index and to the
# service (migration e1f2a3b4c5d6).
TERMINAL_RUN_STATUSES = frozenset({
    WorkflowInstanceStatus.APPROVED,
    WorkflowInstanceStatus.REJECTED,
    WorkflowInstanceStatus.CANCELLED,
    WorkflowInstanceStatus.COMPLETED,
    WorkflowInstanceStatus.FINALIZED,
})


class WorkflowService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.instance_repo = WorkflowInstanceRepository(db)
        self.step_repo = ApprovalStepRepository(db)
        self.tmpl_repo = WorkflowTemplateRepository(db)
        self.stage_repo = WorkflowStageRepository(db)
        self.notif_svc = NotificationService(db)
        # X-NOT-01: notifications are queued in the caller's transaction and
        # delivered after it commits, so a run that rolls back never notifies.
        self.outbox = OutboxService(db)

    # ── start_workflow: internal callable (called by document_service in same tx) ──

    async def start_workflow(
        self,
        org_id: uuid.UUID,
        document_id: uuid.UUID,
        template_id: uuid.UUID,
        requester_id: uuid.UUID,
        current_version_id: uuid.UUID,
        doc_title: str,
    ) -> WorkflowInstanceResponse:
        """
        Internal method — creates a WorkflowInstance for a document that has already
        been set to status=SUBMITTED. Called by document_service.submit_document() in
        the same DB transaction. Does NOT commit — the caller owns the transaction.

        Steps:
        1. Load template + stages
        2. Freeze template snapshot
        3. Create WorkflowInstance
        4. Set doc.status = PENDING
        5. Resolve Stage-1 approvers + create ApprovalStep rows
        6. Write AuditLog
        7. Notify approvers
        """
        # 1. Load template
        tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl or not tmpl.is_active:
            raise NotFoundException("WorkflowTemplate not found or inactive")

        stages = await self.stage_repo.list_for_template(tmpl.id)
        if not stages:
            raise ConflictException("Workflow template has no stages defined")

        # 1b. Resolve EVERY stage before writing anything (WF-SUB-02,
        #     WF-STG-24, E1). The static check in document_validation.py
        #     inspects the RULES, so it cannot know that a
        #     `manager_of_requester` rule resolves to nobody for THIS
        #     submitter — no manager on record and no department head, or
        #     only the submitter themselves, who may not approve their own
        #     document (BR-05).
        #
        #     Without this the run was created anyway, with no ApprovalStep
        #     rows at all: the document sat in PENDING, nobody was notified
        #     and nobody could act on it. Refusing up front costs one
        #     resolution pass over at most ten stages and leaves the
        #     submitter with something they can fix.
        #     The same pass runs behind POST /workflow-templates/{id}/
        #     preflight, so what the submitter was shown when they picked the
        #     workflow and what happens when they press Submit are one rule,
        #     not two that can disagree (WF-SUB-02).
        report = await self.preflight(
            template_id=tmpl.id, requester_id=requester_id, org_id=org_id,
            tmpl=tmpl, stages=stages,
        )
        if not report.can_submit:
            raise UnprocessableEntityException(
                "This document cannot be submitted yet: "
                + "; ".join(report.blockers)
                + ". Ask an admin to fix the workflow or your reporting line."
            )

        # 1c. The document has to be displayable for review (WF-REV-09, E15).
        #
        # A password-protected or corrupt PDF must not enter review: by the
        # time an approver found out, the run would be live, an approver
        # notified and the owner told their document was in review. For an
        # office file this queues a background conversion instead, because a
        # conversion is minutes and a PDF header parse is microseconds.
        from app.services.rendition_service import (
            RenditionService,
            queue_rendition,
        )

        version = await self.db.get(DocumentVersion, current_version_id)
        rendition_svc = RenditionService(self.db)
        if version is not None:
            await rendition_svc.assert_version_reviewable(version)
            if version.rendition_status in (None, "pending"):
                await rendition_svc.mark_initial_state(version)

        # 2. Freeze snapshot
        snapshot = self._freeze_template(tmpl, stages)

        # 3. Create WorkflowInstance, PINNED to the definition it is being
        #    submitted against (DM-02). From here on the run is routed by
        #    this version and the live template is never consulted again.
        first_stage = stages[0]
        instance = await self.instance_repo.create(
            org_id=org_id,
            document_id=document_id,
            template_id=tmpl.id,
            template_version_snapshot=snapshot,
            current_stage_id=first_stage.id,
            status=WorkflowInstanceStatus.IN_PROGRESS,
        )
        instance.version_id = tmpl.current_version_id
        await self.db.flush()
        # P4-9: from here on, every line about this submission carries the
        # run id, including lines from the rendition and outbox services.
        structlog.contextvars.bind_contextvars(run_id=str(instance.id))

        # 3b. This run's own stage records (§4.3 D).
        await self._create_stage_instances(
            instance=instance, org_id=org_id, legacy_stages=stages,
        )

        # 4. Fetch doc and set PENDING
        doc = await self.db.get(Document, document_id)
        if doc:
            doc.status = DocumentStatus.PENDING
        await self.db.flush()

        # 5. Create Stage-1 ApprovalStep rows
        approver_ids = await self._resolve_approvers(first_stage, requester_id, org_id)
        due_at = None
        if first_stage.sla_hours:
            due_at = datetime.now(timezone.utc) + timedelta(hours=first_stage.sla_hours)

        for approver_id in approver_ids:
            await self.step_repo.create(
                instance_id=instance.id,
                stage_id=first_stage.id,
                document_version_id=current_version_id,
                approver_id=approver_id,
                due_at=due_at,
                round_number=1,
            )

        # Activate this run's first stage: fix its approver and start its
        # clock (WF-STG-23, AP-SLA-07). Stage 1 only — the rest stay pending
        # until the stage before them is approved.
        first_si = next(
            (si for si in await self._stage_instances(instance) if si.position == 1),
            None,
        )
        if first_si is not None:
            await self.activate_stage_instance(
                stage_instance=first_si,
                approver_id=approver_ids[0] if approver_ids else None,
                org_id=org_id,
            )
            if first_si.status == "active":
                await self.open_review_round(first_si, current_version_id)

        # 6. Write AuditLog
        await self._write_audit(
            org_id=org_id,
            actor_id=requester_id,
            action=AuditAction.WORKFLOW_INSTANCE_CREATE,
            resource_type="WorkflowInstance",
            resource_id=instance.id,
            instance_id=instance.id,
            after={"status": instance.status, "template_id": str(tmpl.id)},
        )

        # 7. Queue N1 for the first stage's approvers.
        #
        # Queued, not sent: this transaction has not committed, and the
        # submission can still fail after this point. The previous inline
        # notify_many() wrote the row inside the transaction (which would
        # roll back) but pushed to Redis and spawned the e-mail task straight
        # away (which would not) - so a failed submission could still tell an
        # approver they had work waiting (X-NOT-01).
        await self.outbox.enqueue_notification(
            notif_catalogue.n1_approval_requested(
                instance_id=instance.id,
                approver_ids=approver_ids,
                doc_title=doc_title,
                stage_name=first_stage.name,
                stage_instance_id=first_si.id if first_si is not None else None,
                cycle=instance.current_cycle or 1,
                document_id=document_id,
            ),
            org_id=org_id,
        )

        # Queue the review copy. After the run exists, so a submission that
        # is refused above never launches an office suite; best-effort, so a
        # broker that is down cannot block a submission - the 5-minute sweep
        # picks up anything left 'pending'.
        if version is not None and version.rendition_status == "pending":
            await queue_rendition(version.id)
        # AP-SUM-01: generated asynchronously at submission, so the summary is
        # usually waiting by the time the first approver opens the document.
        if version is not None:
            from app.services.summary_service import queue_summary

            await queue_summary(version.id)

        logger.info("workflow_started_internal", instance_id=str(instance.id), doc_id=str(document_id))
        return WorkflowInstanceResponse.model_validate(instance)

    # ── Submit (public route — kept for legacy; delegates to start_workflow) ────

    async def submit(
        self,
        org_id: uuid.UUID,
        document_id: uuid.UUID,
        requester_id: uuid.UUID,
        req: SubmitDocumentRequest,
    ) -> WorkflowInstanceResponse:
        """
        Submit a document for approval via the (now-internal) workflow router.
        NOTE: The canonical path is POST /documents/{id}/submit in documents.py.
        This method is kept for backward-compat but the router route has been removed.
        """
        doc = await self.db.get(Document, document_id)
        if not doc or doc.org_id != org_id:
            raise NotFoundException("Document not found")
        if doc.status not in (
            DocumentStatus.DRAFT, DocumentStatus.SUBMITTED,
            DocumentStatus.SENT_BACK,
        ):
            raise ConflictException(
                f"Document is in status '{doc.status}' and cannot be submitted"
            )

        current_version_id = doc.current_version_id
        if not current_version_id:
            raise ConflictException("Document has no version uploaded yet")

        instance = await self.start_workflow(
            org_id=org_id,
            document_id=document_id,
            template_id=req.workflow_template_id,
            requester_id=requester_id,
            current_version_id=current_version_id,
            doc_title=doc.title,
        )

        await self.db.commit()
        EventBus.publish("document.status_changed", {
            "doc_id": str(document_id),
            "org_id": str(org_id),
            "new_status": DocumentStatus.PENDING,
            "event": "workflow_started",
        })
        return instance


    async def resume(
        self,
        org_id: uuid.UUID,
        document_id: uuid.UUID,
        requester_id: uuid.UUID,
        req: ReviseAndResumeRequest,
    ) -> WorkflowInstanceResponse:
        """
        Upload a revised DocumentVersion and resume the workflow at the SAME
        stage that requested changes — without restarting from Stage 1.

        Per architecture §8 mechanics point 3:
          - Create new ApprovalStep at the SAME current_stage_id
          - Set WorkflowInstance.status = in_progress
          - Notify ONLY same-stage approver(s)
          - Earlier stages' approved rows are untouched
        """
        # Load document + instance
        doc = await self.db.get(Document, document_id)
        if not doc or doc.org_id != org_id:
            raise NotFoundException("Document not found")
        if doc.status not in (DocumentStatus.SENT_BACK, DocumentStatus.SUBMITTED):
            raise ConflictException(
                f"Document is not in 'sent_back' state (current: {doc.status})"
            )

        instance = await self.instance_repo.get_by_document(document_id)
        if not instance or instance.status not in (
            WorkflowInstanceStatus.CHANGES_REQUESTED, WorkflowInstanceStatus.IN_PROGRESS
        ):
            raise NotFoundException("No active workflow instance awaiting revision")

        if instance.current_stage_id is None:
            raise ConflictException("Workflow instance has no current stage")

        # Validate the new version exists and belongs to this document
        new_version = await self.db.get(DocumentVersion, req.new_version_id)
        if not new_version or new_version.document_id != document_id:
            raise NotFoundException("DocumentVersion not found for this document")

        # WF-REV-11 / E16: byte-identical to the version it replaces. Almost
        # always the wrong file picked from a folder, and resubmitting it
        # sends the approver the document they already sent back. Refused
        # once; `confirm_identical` is the owner saying they mean it.
        previous_version = (
            await self.db.get(DocumentVersion, doc.current_version_id)
            if doc.current_version_id else None
        )
        if (
            previous_version is not None
            and previous_version.id != new_version.id
            and previous_version.checksum
            and previous_version.checksum == new_version.checksum
            and not req.confirm_identical
        ):
            raise ConflictException(
                "This file is identical to the version that was sent back - "
                "nothing in it has changed. Upload the revised file, or "
                "confirm that you want to resubmit it unchanged."
            )

        # WF-REV-10: open reviewer comments must be acknowledged. Enforced
        # only when there ARE open comments, so a change request made with an
        # overall note alone does not demand a meaningless tick.
        if previous_version is not None and not req.addressed_confirmed:
            from app.models.annotation import Annotation

            still_open = (
                await self.db.execute(
                    select(Annotation.id).where(
                        Annotation.document_version_id == previous_version.id,
                        Annotation.status == "open",
                        Annotation.deleted_at.is_(None),
                    ).limit(1)
                )
            ).first()
            if still_open is not None:
                raise UnprocessableEntityException(
                    "Some reviewer comments are still open. Confirm that you "
                    "have addressed the requested changes before resubmitting."
                )

        # WF-REV-09: the revision has to be displayable, same gate as submit.
        from app.services.rendition_service import (
            RenditionService,
            queue_rendition,
        )

        rendition_svc = RenditionService(self.db)
        await rendition_svc.assert_version_reviewable(new_version)
        if new_version.rendition_status in (None, "pending"):
            await rendition_svc.mark_initial_state(new_version)
        # WF-REV-08: recorded, not inferred from version_num.
        if new_version.reason is None:
            new_version.reason = "revision"

        # Update document to point to new version and put back in PENDING
        doc.current_version_id = req.new_version_id
        doc.status = DocumentStatus.PENDING
        await self.db.flush()

        # Get current stage. IMPORTANT: fetch via list_for_template (which
        # selectinload()s approver_rules) rather than a bare db.get() — a bare
        # get() returns a WorkflowStage with approver_rules unloaded
        # (lazy="noload" on the model), so _resolve_approvers() below would
        # silently resolve zero approvers and no ApprovalStep would ever be
        # created, leaving the document stuck in "pending" with nobody able
        # to act on it. (Confirmed live: revise-and-resume returned 200 and
        # flipped the document to "pending", but the approvals queue stayed
        # empty and current_approval_step_id never changed.)
        # The PINNED definition (DM-02, task P2-2): a resubmission must
        # return to the stage that asked for changes as that stage was
        # defined when the run started, even if the template has been edited
        # since (BR-06).
        stages = await self._pinned_stages(instance)
        current_idx = (
            self._locate(stages, instance.current_stage_id)
            if stages is not None else None
        )
        if stages is None or current_idx is None:
            raise NotFoundException("Current workflow stage not found")
        current_stage = stages[current_idx]

        # Determine round number (max existing round + 1)
        existing_steps = await self.step_repo.get_for_instance_and_stage(
            instance.id, instance.current_stage_id
        )
        next_round = max((s.round_number for s in existing_steps), default=0) + 1

        # WF-REV-13 / T31: full re-approval, ONLY when the pinned version
        # says so. Earlier stage instances are kept as Superseded and the run
        # starts a new cycle at stage 1.
        if await self._requires_full_reapproval(instance):
            stages, current_idx, current_stage = await self._reset_for_full_reapproval(
                instance=instance, stages=stages, org_id=org_id,
                requester_id=requester_id,
            )
            existing_steps = await self.step_repo.get_for_instance_and_stage(
                instance.id, instance.current_stage_id
            )
            next_round = max((s.round_number for s in existing_steps), default=0) + 1

        # WF-STG-23: the approver fixed at activation is authoritative for
        # every later round. Re-resolving here could hand round 2 to a
        # different person than the one who asked for the changes, if the
        # org chart moved in between. Legacy runs with no stage instance
        # still resolve from the rules.
        by_position = {
            si.position: si for si in await self._stage_instances(instance)
        }
        current_si = by_position.get(current_idx + 1)
        blocked = False
        if current_si is not None and current_si.resolved_approver_id is not None:
            reason = await self._unusable_approver_reason(
                current_si.resolved_approver_id
            )
            if reason is not None:
                # WF-REV-15: the approver is gone. Blocked, clock paused, N12
                # to the submitter and Org Admins; nobody is handed the work
                # by guesswork.
                await self._block_stage_instance(
                    stage_instance=current_si, reason=reason,
                    org_id=org_id, at=datetime.now(timezone.utc),
                )
                approver_ids = []
                blocked = True
            else:
                approver_ids = [current_si.resolved_approver_id]
        else:
            approver_ids = await self._resolve_approvers(
                current_stage, requester_id, org_id
            )

        # Check reapproval_on_revision for earlier stages. Sliced by
        # POSITION in the pinned order rather than compared on
        # `sequence_order`, which is 0-based in some existing rows and can be
        # shared between a retired stage and its replacement.
        earlier_stage_approver_ids = []
        for stage in stages[:current_idx]:
            if stage.reapproval_on_revision:
                earlier_ids = await self._resolve_approvers(stage, requester_id, org_id)
                earlier_stage_approver_ids.extend(earlier_ids)
                due_at = None
                if stage.sla_hours:
                    due_at = datetime.now(timezone.utc) + timedelta(hours=stage.sla_hours)
                for aid in earlier_ids:
                    await self.step_repo.create(
                        instance_id=instance.id,
                        stage_id=stage.id,
                        document_version_id=req.new_version_id,
                        approver_id=aid,
                        due_at=due_at,
                        round_number=next_round,
                    )

        # Create new ApprovalStep(s) at current stage
        due_at = None
        if current_stage.sla_hours:
            due_at = datetime.now(timezone.utc) + timedelta(hours=current_stage.sla_hours)

        # A new round on the SAME stage instance, with a full new window
        # (O-11): the approver did not have the document while the owner was
        # revising it.
        if current_si is not None and not blocked:
            now = datetime.now(timezone.utc)
            if current_si.status == "pending":
                # Stage 1 of a fresh cycle after a full reset.
                await self.activate_stage_instance(
                    stage_instance=current_si,
                    approver_id=approver_ids[0] if approver_ids else None,
                    org_id=org_id,
                )
            else:
                current_si.status = "active"
                current_si.timer_paused_at = None
                current_si.activated_at = now
                current_si.round_count = (current_si.round_count or 1) + 1
                current_si.due_at = (
                    now + timedelta(hours=current_si.due_within_hours)
                    if current_si.due_within_hours else None
                )
            if current_si.due_at is not None:
                due_at = current_si.due_at
            if current_si.status == "active":
                # WF-REV-08 / BR-11: the revision records the round it
                # answers - the last one on this stage that asked for changes.
                answered = (
                    await self.db.execute(
                        select(ReviewRound)
                        .where(
                            ReviewRound.stage_instance_id == current_si.id,
                            ReviewRound.outcome == "changes_requested",
                        )
                        .order_by(ReviewRound.round_number.desc())
                        .limit(1)
                    )
                ).scalars().first()
                if answered is not None and new_version.responds_to_round_id is None:
                    new_version.responds_to_round_id = answered.id
                await self.open_review_round(current_si, new_version.id)
        for approver_id in approver_ids:
            await self.step_repo.create(
                instance_id=instance.id,
                stage_id=instance.current_stage_id,
                document_version_id=req.new_version_id,
                approver_id=approver_id,
                due_at=due_at,
                round_number=next_round,
            )

        # Advance instance status — current_stage_id is UNCHANGED
        instance.status = WorkflowInstanceStatus.IN_PROGRESS
        await self.db.flush()

        # Write AuditLog
        await self._write_audit(
            org_id=org_id,
            actor_id=requester_id,
            action=AuditAction.DOCUMENT_REVISE_AND_RESUME,
            resource_type="WorkflowInstance",
            resource_id=instance.id,
            instance_id=instance.id,
            after={
                "status": instance.status,
                "new_version_id": str(req.new_version_id),
                "resumed_at_stage_id": str(instance.current_stage_id),
                "round": next_round,
            },
        )

        # N5 to the SAME stage's approvers only — earlier stages are not
        # re-notified (BR-06, WF-REV-12), and later stages have not been
        # reached. `earlier_stage_approver_ids` is resolved above for the
        # reapproval_on_revision case and deliberately not notified here:
        # those stages are re-opened, not re-requested in this round.
        await self.outbox.enqueue_notification(
            notif_catalogue.n5_revision_submitted(
                instance_id=instance.id,
                approver_ids=approver_ids,
                doc_title=doc.title,
                stage_name=current_stage.name,
                stage_instance_id=current_si.id if current_si is not None else None,
                cycle=instance.current_cycle or 1,
                round_number=next_round,
            ),
            org_id=org_id,
        )

        # Review copy for the new version, and carry the still-open comments
        # onto it (AP-ANN-22). Both best-effort and after the state change:
        # neither may block or undo a resubmission.
        if new_version.rendition_status == "pending":
            await queue_rendition(new_version.id)
        if previous_version is not None:
            from app.services.annotation_carryover import queue_carry_over

            await queue_carry_over(previous_version.id, new_version.id)
        # AP-SUM-01: and again at each new version.
        from app.services.summary_service import queue_summary as _queue_summary

        await _queue_summary(new_version.id)

        await self.db.commit()
        EventBus.publish("document.status_changed", {
            "doc_id": str(document_id),
            "org_id": str(org_id),
            "new_status": DocumentStatus.PENDING,
            "event": "workflow_resumed",
        })
        logger.info(
            "workflow_resumed",
            instance_id=str(instance.id),
            stage_id=str(instance.current_stage_id),
            round=next_round,
        )
        # Re-fetch rather than reuse `instance`: the ApprovalStep rows created
        # above were added to the DB via step_repo.create(), but SQLAlchemy
        # doesn't retroactively refresh `instance.approval_steps` (already
        # loaded, or not, before those inserts) just because related rows
        # were added elsewhere in the same session — the response would show
        # approval_steps: [] even though the new step genuinely exists and is
        # visible via GET /approvals (confirmed live: this returned [] while
        # the approvals queue correctly showed the new round-2 step).
        fresh_instance = await self.instance_repo.get_by_id(instance.id, org_id)
        return WorkflowInstanceResponse.model_validate(fresh_instance)

    # ── Cancel ──────────────────────────────────────────────────────────────────

    async def cancel(
        self,
        org_id: uuid.UUID,
        instance_id: uuid.UUID,
        requester_id: uuid.UUID,
        req: CancelWorkflowRequest,
    ) -> WorkflowInstanceResponse:
        instance = await self.instance_repo.get_by_id(instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")
        # WF-WD-01: withdrawal is terminal and so is everything in this set.
        # FINALIZED and COMPLETED were missing, so a finished run could be
        # "withdrawn" after the fact — re-opening a closed decision record.
        if instance.status in TERMINAL_RUN_STATUSES:
            raise ConflictException(
                f"Cannot withdraw a workflow in '{instance.status}' state"
            )

        doc = await self.db.get(Document, instance.document_id)
        # A run whose document is gone is not withdrawable. This used to be
        # `if doc and doc.submitted_by != requester_id`, which skipped the
        # authorization check entirely when the document could not be
        # loaded — any caller in the org could then cancel the run.
        if not doc:
            raise NotFoundException("Document not found")
        # Owner only. The previous comment here said "owner or an admin" but
        # the code has always been owner-only; the comment was wrong, not the
        # code, so the check is left as it is rather than widened.
        if doc.submitted_by != requester_id:
            raise ForbiddenException("Only the document owner can withdraw a workflow")

        now = datetime.now(timezone.utc)
        instance.status = WorkflowInstanceStatus.CANCELLED
        instance.completed_at = now
        doc.status = DocumentStatus.CANCELLED
        await self.db.flush()

        # WF-WD-02: take the work off the approvers' desks, and stop the
        # clock on it. Both are needed — the steps are what the dashboard
        # lists, the stage instances are what the SLA sweep reads.
        notify_approver_ids = await self._close_out_run(
            instance=instance, reason=req.reason or "Withdrawn by the owner",
            at=now,
        )

        await self._write_audit(
            org_id=org_id,
            actor_id=requester_id,
            action=AuditAction.WORKFLOW_INSTANCE_CANCEL,
            resource_type="WorkflowInstance",
            resource_id=instance.id,
            instance_id=instance.id,
            after={"status": "cancelled", "reason": req.reason},
        )

        # N8 — the approver who had this open is told it has gone, instead of
        # discovering it by clicking into a 409.
        await self.outbox.enqueue_notification(
            notif_catalogue.n8_run_withdrawn(
                instance_id=instance.id,
                approver_ids=notify_approver_ids,
                doc_title=doc.title,
                document_id=doc.id,
            ),
            org_id=org_id,
        )

        await self.db.commit()
        return WorkflowInstanceResponse.model_validate(instance)

    async def _close_out_run(
        self,
        *,
        instance: WorkflowInstance,
        reason: str,
        at: datetime,
    ) -> list[uuid.UUID]:
        """Retire a terminated run's open work. Returns who was holding it.

        Used by withdrawal (WF-WD-02). The pending steps are superseded
        rather than given a decision, because nobody decided them — and
        `is_counted` then returns False, so a step left over from a
        terminated run can never be counted toward a stage gate if the run
        is somehow revived.
        """
        open_steps = (
            await self.db.execute(
                select(ApprovalStep).where(
                    ApprovalStep.instance_id == instance.id,
                    ApprovalStep.decision == "pending",
                    ApprovalStep.superseded_at.is_(None),
                )
            )
        ).scalars().all()

        holders: list[uuid.UUID] = []
        for step in open_steps:
            step.superseded_at = at
            if step.approver_id not in holders:
                holders.append(step.approver_id)

        # Stop every running clock and close the open stage instances. A
        # withdrawn document that kept its timer would still breach its SLA
        # and escalate to the approver's manager for a document nobody is
        # waiting on (§6.10).
        for si in await self._stage_instances(instance):
            if si.status in ("approved", "rejected", "superseded"):
                continue
            si.status = "superseded"
            si.blocked_reason = None
            if si.timer_paused_at is None:
                si.timer_paused_at = at
            si.completed_at = at
            await self.close_review_round(si, "withdrawn")

        await self.db.flush()
        return holders

    # ── Get Instance ────────────────────────────────────────────────────────────

    async def get_instance(
        self, instance_id: uuid.UUID, org_id: uuid.UUID
    ) -> WorkflowInstanceResponse:
        instance = await self.instance_repo.get_by_id(instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")

        resp = WorkflowInstanceResponse.model_validate(instance)
        if instance.approval_steps:
            from sqlalchemy import select
            from app.models.user import User
            stage_ids = {s.stage_id for s in instance.approval_steps}
            approver_ids = {s.approver_id for s in instance.approval_steps}
            stages_by_id = {
                st.id: st for st in
                (await self.db.execute(select(WorkflowStage).where(WorkflowStage.id.in_(stage_ids)))).scalars().all()
            }
            users_by_id = {
                u.id: u for u in
                (await self.db.execute(select(User).where(User.id.in_(approver_ids)))).scalars().all()
            }
            for step_summary, step in zip(resp.approval_steps, instance.approval_steps):
                stage = stages_by_id.get(step.stage_id)
                approver = users_by_id.get(step.approver_id)
                step_summary.stage_name = stage.name if stage else None
                step_summary.approver_name = approver.name if approver else None
        return resp

    # ── SSE Stream ──────────────────────────────────────────────────────────────

    async def stream_status(
        self,
        instance_id: uuid.UUID,
        org_id: uuid.UUID,
    ) -> AsyncGenerator[str, None]:
        """
        Server-Sent Events generator for live workflow status (§6, §10.6).
        Polls PostgreSQL every 5 seconds — no WebSocket needed for unidirectional data.
        """
        last_status = None
        max_polls = 720  # max 1 hour stream (720 × 5s)
        polls = 0

        while polls < max_polls:
            instance = await self.instance_repo.get_by_id(instance_id, org_id)
            if not instance:
                yield f"event: error\ndata: {json.dumps({'error': 'instance not found'})}\n\n"
                return

            if instance.status != last_status:
                last_status = instance.status
                event_data = {
                    "event": "status_update",
                    "instance_id": str(instance.id),
                    "status": instance.status,
                    "current_stage_id": str(instance.current_stage_id) if instance.current_stage_id else None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
                yield f"event: status_update\ndata: {json.dumps(event_data)}\n\n"

                # Terminal states — close stream
                if instance.status in (
                    WorkflowInstanceStatus.APPROVED,
                    WorkflowInstanceStatus.REJECTED,
                    WorkflowInstanceStatus.CANCELLED,
                ):
                    yield f"event: completed\ndata: {json.dumps({'status': instance.status})}\n\n"
                    return
            else:
                yield f": heartbeat\n\n"

            await asyncio.sleep(5)
            polls += 1

    # ── Stage Advancement (called by ApprovalService) ──────────────────────────

    async def advance_stage(
        self,
        instance: WorkflowInstance,
        org_id: uuid.UUID,
        requester_id: uuid.UUID,
        current_version_id: uuid.UUID,
    ) -> None:
        """
        After all required approvals at the current stage, advance to the next stage.
        If no next stage, mark the workflow as approved.
        """
        # THE PINNED definition — not the live template (DM-02, defect 1).
        stages = await self._pinned_stages(instance)
        if stages is None:
            raise ConflictException(
                "This workflow run has no pinned definition, so it cannot be "
                "advanced safely. An administrator must reassign it."
            )

        idx = self._locate(stages, instance.current_stage_id)
        if idx is None:
            # The run points at a stage that is not in its own pinned
            # definition. Choosing a next stage here would be a guess, and
            # guessing is precisely how an edit used to reroute or silently
            # approve an in-flight document.
            raise ConflictException(
                "This workflow run points at a stage that is not part of the "
                "definition it was submitted against, so it cannot be "
                "advanced safely. An administrator must reassign it."
            )
        current_stage = stages[idx]

        # Next by POSITION in the pinned order.
        next_stage = stages[idx + 1] if idx + 1 < len(stages) else None

        # Close out this run's record of the stage just approved. Positions
        # are 1-based, the pinned list is 0-based.
        by_position = {si.position: si for si in await self._stage_instances(instance)}
        current_si = by_position.get(idx + 1)
        if current_si is not None and current_si.status != "approved":
            current_si.status = "approved"
            current_si.completed_at = datetime.now(timezone.utc)
            await self.db.flush()
            await self.close_review_round(current_si, "approved")

        if next_stage is None:
            # No more stages — workflow complete!
            instance.status = WorkflowInstanceStatus.APPROVED
            instance.completed_at = datetime.now(timezone.utc)
            doc = await self.db.get(Document, instance.document_id)
            if doc:
                doc.status = DocumentStatus.APPROVED
            await self.db.flush()

            EventBus.publish("document.status_changed", {
                "doc_id": str(instance.document_id),
                "org_id": str(org_id),
                "new_status": DocumentStatus.APPROVED,
                "event": "workflow_approved",
            })

            # N6 — every step is done. Previously the owner's last message was
            # whatever approval_service published per step ("Approval step
            # approved"), so the one event they most needed to see read like
            # one more step among many.
            if doc is not None:
                await self.outbox.enqueue_notification(
                    notif_catalogue.n6_run_approved(
                        instance_id=instance.id,
                        owner_id=doc.submitted_by,
                        doc_title=doc.title,
                        document_id=doc.id,
                    ),
                    org_id=org_id,
                )

            await self._write_audit(
                org_id=org_id,
                actor_id=requester_id,
                action=AuditAction.WORKFLOW_INSTANCE_COMPLETE,
                resource_type="WorkflowInstance",
                resource_id=instance.id,
                instance_id=instance.id,
                after={"status": "approved"},
            )
            logger.info("workflow_approved", instance_id=str(instance.id))
        else:
            # Advance to next stage
            instance.current_stage_id = next_stage.id
            await self.db.flush()

            # Resolve approvers for next stage
            approver_ids = await self._resolve_approvers(next_stage, requester_id, org_id)
            due_at = None
            if next_stage.sla_hours:
                due_at = datetime.now(timezone.utc) + timedelta(hours=next_stage.sla_hours)

            # Fix this stage's approver and start its clock. Signing may be
            # forced on here even though the definition said off, when the
            # resolved approver's department requires it (WF-STG-21).
            next_si = by_position.get(idx + 2)
            if next_si is not None:
                await self.activate_stage_instance(
                    stage_instance=next_si,
                    approver_id=approver_ids[0] if approver_ids else None,
                    org_id=org_id,
                )
                if next_si.due_at is not None:
                    due_at = next_si.due_at
                if next_si.status == "active":
                    await self.open_review_round(next_si, current_version_id)

            # Get current round (1 for fresh instance)
            existing = await self.step_repo.get_for_instance_and_stage(
                instance.id, current_stage.id
            )
            round_num = max((s.round_number for s in existing), default=1)

            for approver_id in approver_ids:
                await self.step_repo.create(
                    instance_id=instance.id,
                    stage_id=next_stage.id,
                    document_version_id=current_version_id,
                    approver_id=approver_id,
                    due_at=due_at,
                    round_number=round_num,
                )

            await self._write_audit(
                org_id=org_id,
                actor_id=requester_id,
                action=AuditAction.WORKFLOW_STAGE_ADVANCE,
                resource_type="WorkflowInstance",
                resource_id=instance.id,
                instance_id=instance.id,
                after={
                    "from_stage_id": str(current_stage.id),
                    "to_stage_id": str(next_stage.id),
                },
            )

            # N2 to the approver whose turn it now is, and N3 to the owner
            # as progress. Only the stage that is actually active is told
            # (X-NOT-02) - stage k+2's approver hears nothing yet.
            adv_doc = await self.db.get(Document, instance.document_id)
            doc_title = adv_doc.title if adv_doc else "Document"
            await self.outbox.enqueue_notification(
                notif_catalogue.n2_next_stage_activated(
                    instance_id=instance.id,
                    approver_ids=approver_ids,
                    doc_title=doc_title,
                    stage_name=next_stage.name,
                    position=idx + 2,
                    stage_instance_id=next_si.id if next_si is not None else None,
                    cycle=instance.current_cycle or 1,
                    round_number=round_num,
                ),
                org_id=org_id,
            )
            if adv_doc is not None:
                await self.outbox.enqueue_notification(
                    notif_catalogue.n3_stage_approved_owner(
                        instance_id=instance.id,
                        owner_id=adv_doc.submitted_by,
                        doc_title=doc_title,
                        stage_name=current_stage.name,
                        position=idx + 1,
                        document_id=adv_doc.id,
                        cycle=instance.current_cycle or 1,
                        round_number=round_num,
                    ),
                    org_id=org_id,
                )
            logger.info(
                "workflow_stage_advanced",
                instance_id=str(instance.id),
                from_stage=str(current_stage.id),
                to_stage=str(next_stage.id),
            )

    # ── Stage instances (§4.3 D, task P2-7) ────────────────────────────────

    async def _create_stage_instances(
        self,
        *,
        instance: WorkflowInstance,
        org_id: uuid.UUID,
        legacy_stages: Sequence,
    ) -> list[StageInstance]:
        """Lay down one stage_instance per stage of the PINNED version.

        Only done when the pinned version maps one-to-one onto the legacy
        stage rows — the same conservative rule the P2-1 migration applies.
        A run whose template could not be represented as a version keeps
        working through `template_version_snapshot`, rather than getting a
        second, half-populated execution path that could disagree with the
        first.

        `legacy_stage_id` is carried on each row because
        `approval_steps.stage_id` is NOT NULL and references
        `workflow_stages`; it is never used to decide routing.
        """
        if instance.version_id is None:
            return []

        vstages = (
            await self.db.execute(
                select(WorkflowVersionStage)
                .where(
                    WorkflowVersionStage.version_id == instance.version_id,
                    WorkflowVersionStage.deleted_at.is_(None),
                )
                .order_by(WorkflowVersionStage.position)
            )
        ).scalars().all()

        legacy = list(legacy_stages)
        if not vstages or len(vstages) != len(legacy):
            logger.warning(
                "stage_instances_skipped_version_mismatch",
                instance_id=str(instance.id),
                version_stages=len(vstages),
                legacy_stages=len(legacy),
            )
            return []

        legacy_by_position = {
            rank: st for rank, st in enumerate(legacy, start=1)
        }

        created: list[StageInstance] = []
        for vs in vstages:
            legacy_stage = legacy_by_position.get(vs.position)
            si = StageInstance(
                org_id=org_id,
                instance_id=instance.id,
                version_stage_id=vs.id,
                legacy_stage_id=legacy_stage.id if legacy_stage else None,
                cycle=instance.current_cycle,
                position=vs.position,
                stage_name=vs.name,
                approver_type=vs.approver_type,
                department_id=vs.department_id,
                signing_required=vs.require_signing,
                signing_reason=(
                    "Required by the workflow definition"
                    if vs.require_signing else None
                ),
                due_within_hours=vs.due_within_hours,
                status="pending",
            )
            self.db.add(si)
            created.append(si)
        await self.db.flush()
        return created

    async def _stage_instances(
        self, instance: WorkflowInstance
    ) -> list[StageInstance]:
        """This run's stage rows for its live cycle, in order."""
        rows = await self.db.execute(
            select(StageInstance)
            .where(
                StageInstance.instance_id == instance.id,
                StageInstance.cycle == instance.current_cycle,
                StageInstance.deleted_at.is_(None),
            )
            .order_by(StageInstance.position)
        )
        return list(rows.scalars().all())

    async def activate_stage_instance(
        self,
        *,
        stage_instance: StageInstance,
        approver_id: uuid.UUID | None,
        org_id: uuid.UUID,
    ) -> None:
        """Start a stage's clock and fix its approver.

        The approver is resolved ONCE here and is authoritative from then on,
        even if the org chart changes afterwards (WF-STG-23, E5).

        Signing is re-evaluated at activation and may be forced ON even when
        the definition said off: WF-STG-21 requires it when the RESOLVED
        approver's department requires a signature, which is the case a
        manager rule resolving into Finance creates. It is never turned off
        here — a definition that demands a signature always keeps it.
        """
        now = datetime.now(timezone.utc)

        # E3 / E4 / AP-SLA-05: can this stage actually be acted on?
        #
        # Submit-time preflight checks every stage, but a stage's approver is
        # only FIXED when the stage activates - which for stage k+1 is when
        # stage k is approved, possibly weeks later. By then the person may
        # have been deactivated or deleted. This used to go ACTIVE with
        # `resolved_approver_id = None` and no ApprovalStep rows: nobody could
        # act, the clock kept running toward an escalation nobody could
        # answer, and nobody was told. The run was stuck silently.
        blocked_reason = await self._unusable_approver_reason(approver_id)
        if blocked_reason is not None:
            await self._block_stage_instance(
                stage_instance=stage_instance,
                reason=blocked_reason,
                org_id=org_id,
                at=now,
            )
            return

        stage_instance.resolved_approver_id = approver_id
        stage_instance.activated_at = now
        stage_instance.status = "active"
        stage_instance.timer_paused_at = None
        stage_instance.blocked_reason = None
        if stage_instance.due_within_hours:
            stage_instance.due_at = now + timedelta(
                hours=stage_instance.due_within_hours
            )

        if approver_id is not None and not stage_instance.signing_required:
            from app.models.user import User
            from app.services.template_service import TemplateService

            approver = await self.db.get(User, approver_id)
            dept_id = getattr(approver, "department_id", None)
            if dept_id is not None:
                requires = await TemplateService(
                    self.db
                )._department_requires_signature(dept_id)
                if requires:
                    stage_instance.signing_required = True
                    stage_instance.signing_reason = (
                        "The approver's department requires a signature"
                    )
                    await self._write_audit(
                        org_id=org_id,
                        actor_id=approver_id,
                        action=AuditAction.STAGE_SIGNING_REQUIRED,
                        resource_type="StageInstance",
                        resource_id=stage_instance.id,
                        instance_id=stage_instance.instance_id,
                        after={
                            "signing_required": True,
                            "reason": "approver_department",
                        },
                    )
        await self.db.flush()

    async def _unusable_approver_reason(
        self, approver_id: uuid.UUID | None
    ) -> str | None:
        """Why this person cannot hold a stage, or None if they can.

        The wording is what the submitter and the Org Admin read in the
        "Blocked: needs reassignment" notification, so it says what is wrong
        rather than naming a code.
        """
        if approver_id is None:
            return "no approver could be resolved for this stage"

        from app.models.user import User

        approver = await self.db.get(User, approver_id)
        if approver is None or approver.deleted_at is not None:
            return "the assigned approver's account no longer exists"
        if not approver.is_active or approver.status != "active":
            return f"{approver.name or 'the assigned approver'} is no longer active"
        return None

    async def _block_stage_instance(
        self,
        *,
        stage_instance: StageInstance,
        reason: str,
        org_id: uuid.UUID,
        at: datetime,
    ) -> None:
        """Park a stage that cannot proceed, and tell someone who can fix it.

        The clock is paused (§6.10): a stage nobody can act on must not
        accrue toward an approver's SLA breach, and escalating it would page
        a manager about work that has no owner. Because nothing will time out
        to raise the alarm, N12 is what makes it visible.
        """
        stage_instance.status = "blocked"
        stage_instance.blocked_reason = reason[:255]
        stage_instance.resolved_approver_id = None
        stage_instance.activated_at = stage_instance.activated_at or at
        stage_instance.timer_paused_at = at
        stage_instance.due_at = None
        await self.db.flush()

        await self._write_audit(
            org_id=org_id,
            actor_id=None,
            action=AuditAction.STAGE_BLOCKED,
            resource_type="StageInstance",
            resource_id=stage_instance.id,
            instance_id=stage_instance.instance_id,
            after={
                "status": "blocked",
                "position": stage_instance.position,
                "reason": reason,
            },
        )

        instance = await self.db.get(WorkflowInstance, stage_instance.instance_id)
        doc = (
            await self.db.get(Document, instance.document_id)
            if instance is not None else None
        )
        recipients: list[uuid.UUID] = []
        if doc is not None:
            recipients.append(doc.submitted_by)
        for admin_id in await self._org_admin_ids(org_id):
            if admin_id not in recipients:
                recipients.append(admin_id)

        await self.outbox.enqueue_notification(
            notif_catalogue.n12_stage_blocked(
                instance_id=stage_instance.instance_id,
                user_ids=recipients,
                doc_title=doc.title if doc else "a document",
                document_id=doc.id if doc else stage_instance.instance_id,
                stage_name=stage_instance.stage_name,
                position=stage_instance.position,
                reason=reason,
                cycle=stage_instance.cycle,
            ),
            org_id=org_id,
        )
        logger.warning(
            "stage_blocked",
            stage_instance_id=str(stage_instance.id),
            instance_id=str(stage_instance.instance_id),
            reason=reason,
        )

    async def _org_admin_ids(self, org_id: uuid.UUID) -> list[uuid.UUID]:
        """Active Org Admins, who are the only people who can reassign."""
        from app.models.organization import OrganizationMember, Role

        rows = await self.db.execute(
            select(OrganizationMember.user_id)
            .join(Role, Role.id == OrganizationMember.role_id)
            .where(
                OrganizationMember.org_id == org_id,
                Role.name == "admin",
                OrganizationMember.deleted_at.is_(None),
            )
        )
        return list(rows.scalars().all())

    # ── Review rounds (section 6.5.2, BR-06) ───────────────────────────────

    async def open_review_round(
        self, stage_instance: StageInstance, document_version_id: uuid.UUID,
    ) -> ReviewRound:
        """Record that this stage has started reviewing this version.

        One round per pass of a stage over a version: round 1 at activation,
        round 2 when the owner resubmits to the same stage. Idempotent on
        (stage instance, round number), so a retried request cannot open the
        same round twice.
        """
        number = stage_instance.round_count or 1
        existing = (
            await self.db.execute(
                select(ReviewRound).where(
                    ReviewRound.stage_instance_id == stage_instance.id,
                    ReviewRound.round_number == number,
                )
            )
        ).scalars().first()
        if existing is not None:
            return existing
        rnd = ReviewRound(
            org_id=stage_instance.org_id,
            stage_instance_id=stage_instance.id,
            round_number=number,
            document_version_id=document_version_id,
        )
        self.db.add(rnd)
        await self.db.flush()
        return rnd

    async def close_review_round(
        self, stage_instance: StageInstance, outcome: str,
    ) -> ReviewRound | None:
        """Close this stage's open round with how it ended."""
        rnd = (
            await self.db.execute(
                select(ReviewRound)
                .where(
                    ReviewRound.stage_instance_id == stage_instance.id,
                    ReviewRound.closed_at.is_(None),
                )
                .order_by(ReviewRound.round_number.desc())
                .limit(1)
            )
        ).scalars().first()
        if rnd is None:
            return None
        rnd.closed_at = datetime.now(timezone.utc)
        rnd.outcome = outcome
        await self.db.flush()
        return rnd

    # ── Full re-approval (WF-REV-13, task P3-12) ───────────────────────────

    async def _requires_full_reapproval(self, instance: WorkflowInstance) -> bool:
        """Read from the PINNED version, never the live template (DM-02): an
        owner switching the setting on later must not reset runs already in
        flight under the old rule."""
        if instance.version_id is None:
            return False
        version = await self.db.get(WorkflowTemplateVersion, instance.version_id)
        return bool(version is not None and version.require_full_reapproval)

    async def _reset_for_full_reapproval(
        self, *, instance: WorkflowInstance, stages, org_id: uuid.UUID,
        requester_id: uuid.UUID,
    ):
        """Start a new cycle at stage 1, keeping the old one for audit.

        Nothing is deleted. The earlier cycle's stage instances become
        Superseded and its decisions stop counting toward any gate, but both
        stay readable: WF-REV-13 asks for the trail to be retained, and an
        approval that silently vanished would be worse than one marked as no
        longer in force.
        """
        now = datetime.now(timezone.utc)
        for si in await self._stage_instances(instance):
            if si.status != "superseded":
                si.status = "superseded"
                si.completed_at = si.completed_at or now
                if si.timer_paused_at is None:
                    si.timer_paused_at = now
                await self.close_review_round(si, "superseded")

        old_steps = (
            await self.db.execute(
                select(ApprovalStep).where(
                    ApprovalStep.instance_id == instance.id,
                    ApprovalStep.superseded_at.is_(None),
                )
            )
        ).scalars().all()
        for step in old_steps:
            step.superseded_at = now

        previous_cycle = instance.current_cycle or 1
        instance.current_cycle = previous_cycle + 1
        instance.current_stage_id = stages[0].id
        await self.db.flush()
        await self._create_stage_instances(
            instance=instance, org_id=org_id, legacy_stages=stages,
        )
        await self._write_audit(
            org_id=org_id,
            actor_id=requester_id,
            action=AuditAction.RUN_FULL_REAPPROVAL_RESET,
            resource_type="WorkflowInstance",
            resource_id=instance.id,
            instance_id=instance.id,
            before={"cycle": previous_cycle},
            after={"cycle": instance.current_cycle, "restarted_at_position": 1},
        )
        return stages, 0, stages[0]

    # ── Preflight (WF-SUB-02, WF-SEL-06, tasks P2-5 / P2-21) ───────────────

    async def preflight(
        self,
        *,
        template_id: uuid.UUID,
        requester_id: uuid.UUID,
        org_id: uuid.UUID,
        tmpl=None,
        stages=None,
    ) -> PreflightResponse:
        """Resolve every stage for THIS submitter, and report what blocks them.

        Why a resolution pass and not a rules check: `document_validation.py`
        inspects the approver RULES, so it happily passes a
        `manager_of_requester` rule without knowing that this particular
        submitter has no manager on record and their department has no head.
        The run was then created with no ApprovalStep rows at all - the
        document sat in PENDING, nobody was notified, and nobody could act on
        it (E1, WF-STG-24).

        `tmpl` and `stages` are accepted so the submit path can pass what it
        has already loaded instead of fetching it twice.
        """
        from app.models.user import User
        from app.services.template_service import TemplateService

        if tmpl is None:
            tmpl = await self.tmpl_repo.get_by_id(template_id, org_id)
        if not tmpl:
            raise NotFoundException("WorkflowTemplate not found")
        if stages is None:
            stages = await self.stage_repo.list_for_template(tmpl.id)

        blockers: list[str] = []
        warnings: list[str] = []
        out: list[PreflightStage] = []

        if not tmpl.is_active:
            blockers.append("this workflow is not active")
        if not stages:
            blockers.append("this workflow has no stages configured")

        tmpl_svc = TemplateService(self.db)

        for position, st in enumerate(stages, start=1):
            approver_ids = await self._resolve_approvers(st, requester_id, org_id)
            blocker: str | None = None

            if not approver_ids:
                rules = list(st.approver_rules or [])
                manager_only = bool(rules) and all(
                    r.rule_type == "manager_of_requester" for r in rules
                )
                if manager_only:
                    blocker = (
                        f"'{st.name}' routes to your manager, but no manager "
                        "is on record for you and your department has no head"
                    )
                else:
                    blocker = (
                        f"'{st.name}' has no approver who is allowed to act "
                        "on this document"
                    )
                blockers.append(blocker)

            names: list[str] = []
            for uid in approver_ids:
                user = await self.db.get(User, uid)
                if user is not None:
                    names.append(user.name or user.email)

            # WF-STG-21: say up front when a signature will be required
            # because of the RESOLVED approver's department, not just because
            # the stage definition asks for one. Otherwise the requirement
            # appears out of nowhere at the approval screen.
            requires_signature = bool(st.requires_signature)
            signing_reason = None
            if requires_signature:
                signing_reason = "This stage is defined as requiring a signature"
            else:
                for uid in approver_ids:
                    user = await self.db.get(User, uid)
                    dept_id = getattr(user, "department_id", None)
                    if dept_id and await tmpl_svc._department_requires_signature(
                        dept_id
                    ):
                        requires_signature = True
                        signing_reason = (
                            "The approver's department requires a signature"
                        )
                        break

            if requester_id in approver_ids:
                # BR-05 / WF-STG-25. _resolve_approvers already excludes the
                # submitter, so reaching here means a rule named them
                # explicitly in a way that survived - worth saying out loud
                # rather than quietly dropping them.
                warnings.append(
                    f"'{st.name}' resolves to you, and you cannot approve "
                    "your own document"
                )

            out.append(
                PreflightStage(
                    position=position,
                    stage_id=st.id,
                    name=st.name,
                    approver_ids=list(approver_ids),
                    approver_names=names,
                    approver_summary=(
                        ", ".join(names) if names else "No approver resolved"
                    ),
                    requires_signature=requires_signature,
                    signing_reason=signing_reason,
                    sla_hours=st.sla_hours,
                    blocker=blocker,
                )
            )

        return PreflightResponse(
            template_id=tmpl.id,
            workflow_name=tmpl.name,
            can_submit=not blockers,
            blockers=blockers,
            warnings=warnings,
            stages=out,
        )

    # ── Submit as New (WF-SUB-06, BR-07, task P2-12) ───────────────────────

    async def submit_as_new(
        self,
        *,
        org_id: uuid.UUID,
        document_id: uuid.UUID,
        requester_id: uuid.UUID,
        template_id: uuid.UUID | None = None,
        version_id: uuid.UUID | None = None,
    ) -> WorkflowInstanceResponse:
        """Start a fresh run for a document whose previous run has ended.

        BR-07 keeps a rejection terminal: the closed run is never reopened,
        re-decided or edited. This creates a SECOND run, from stage 1, with
        `previous_run_id` pointing at the first, so the rejected run stays
        exactly as it was and the two read as a chain (AP-REJ-04, E18).

        Preflight is not re-implemented here. `start_workflow()` resolves
        every stage before it writes anything (P2-5), and the time between
        the rejection and this call is precisely when an approver chain goes
        stale - so this has to go through that path, not around it.
        """
        doc = await self.db.get(Document, document_id)
        if doc is None or doc.org_id != org_id or doc.deleted_at is not None:
            raise NotFoundException("Document not found")
        if doc.submitted_by != requester_id:
            raise ForbiddenException(
                "Only the document owner can submit it again"
            )

        previous = await self.instance_repo.get_by_document(document_id)
        if previous is None:
            raise ConflictException(
                "This document has not been submitted before. Use the normal "
                "submit instead."
            )
        # BR-01 / X-INT-06: one live run per document. A run that is still
        # going has to be withdrawn first - a second live run would be two
        # sets of approvers deciding on one document.
        if previous.status not in TERMINAL_RUN_STATUSES:
            raise ConflictException(
                f"This document already has a workflow in progress "
                f"(status: '{previous.status}'). Withdraw it first."
            )

        chosen_template_id = template_id or previous.template_id
        # The version to submit lives on the Document (`current_version_id`),
        # not on the run - a run records its version per ApprovalStep.
        chosen_version_id = version_id or doc.current_version_id
        if chosen_version_id is None:
            raise ConflictException(
                "This document has no version to submit"
            )

        run = await self.start_workflow(
            org_id=org_id,
            document_id=document_id,
            template_id=chosen_template_id,
            requester_id=requester_id,
            current_version_id=chosen_version_id,
            doc_title=doc.title,
        )

        # Link the chain. Done after start_workflow so that a submission
        # refused by preflight leaves no half-made link behind.
        new_run = await self.db.get(WorkflowInstance, run.id)
        if new_run is not None:
            new_run.previous_run_id = previous.id
            await self.db.flush()

        await self._write_audit(
            org_id=org_id,
            actor_id=requester_id,
            action=AuditAction.RUN_RESUBMITTED_AS_NEW,
            resource_type="WorkflowInstance",
            resource_id=run.id,
            instance_id=run.id,
            before={
                "previous_run_id": str(previous.id),
                "previous_status": str(previous.status),
            },
            after={
                "template_id": str(chosen_template_id),
                "document_version_id": str(chosen_version_id),
            },
        )
        logger.info(
            "run_submitted_as_new",
            document_id=str(document_id),
            previous_run_id=str(previous.id),
            new_run_id=str(run.id),
        )
        return WorkflowInstanceResponse.model_validate(new_run or run)

    # ── Admin reassignment (AP-SLA-06, N13, task P2-17) ────────────────────

    async def reassign_stage_instance(
        self,
        *,
        org_id: uuid.UUID,
        stage_instance_id: uuid.UUID,
        new_approver_id: uuid.UUID,
        reason: str,
        actor: AuthUser,
    ) -> StageInstance:
        """Hand an active or blocked stage to a different approver.

        This is the ONLY supported way to change an active stage's approver in
        v1. `Delegation` is out of scope per §2.1 and is left untouched.

        The reason is mandatory (AP-SLA-06): this overrides an approver chain
        the workflow's owner defined, so the audit has to say why. The timer
        restarts with a FULL window rather than inheriting what was left of
        the old one - the new approver did not have the document for the part
        that has already elapsed.
        """
        reason = (reason or "").strip()
        if len(reason) < 5:
            raise UnprocessableEntityException(
                "Give a reason for the reassignment (at least 5 characters). "
                "It is recorded in the audit trail and shown to both approvers."
            )

        si = await self.db.get(StageInstance, stage_instance_id)
        if si is None or si.org_id != org_id or si.deleted_at is not None:
            raise NotFoundException("Stage not found")

        # Org Admin only. Not the workflow owner and not the submitter: this
        # changes who may approve, and §7.3 puts that with the admin.
        if not (actor.is_superadmin or "admin" in actor.roles):
            raise ForbiddenException(
                "Only an organization admin can reassign an approval stage"
            )

        if si.status not in ("active", "blocked", "awaiting_signature"):
            raise ConflictException(
                f"A stage in '{si.status}' is not awaiting a decision, so it "
                f"cannot be reassigned"
            )

        instance = await self.db.get(WorkflowInstance, si.instance_id)
        if instance is None or instance.status in TERMINAL_RUN_STATUSES:
            raise ConflictException(
                "This workflow has finished, so its stages cannot be reassigned"
            )
        doc = await self.db.get(Document, instance.document_id)

        # The new approver must be someone who could have held the stage in
        # the first place, or reassignment becomes a way around the rules the
        # builder enforces.
        unusable = await self._unusable_approver_reason(new_approver_id)
        if unusable is not None:
            raise UnprocessableEntityException(
                f"That person cannot take this stage: {unusable}."
            )
        if not await self._is_org_member(new_approver_id, org_id):
            # BR-12 - org scoping. `users` has no org column; membership is
            # the organization_members row, so that is what gets checked.
            raise UnprocessableEntityException(
                "The new approver must be a member of this organization"
            )
        if doc is not None and new_approver_id == doc.submitted_by:
            # BR-05. Reassignment is the one path that could manufacture a
            # self-approval, because it bypasses the approver rules entirely.
            raise UnprocessableEntityException(
                "The document's own submitter cannot be made its approver"
            )
        await self._exclude_trainees_guard(new_approver_id, org_id)
        if new_approver_id == si.resolved_approver_id:
            raise ConflictException(
                "That is already this stage's approver"
            )

        previous_approver_id = si.resolved_approver_id
        now = datetime.now(timezone.utc)

        # Retire the outgoing approver's open step and raise one for the
        # incoming one, so the stage appears in the right queue on both
        # sides. Superseded, not decided: the old approver did not decide.
        open_steps = (
            await self.db.execute(
                select(ApprovalStep).where(
                    ApprovalStep.instance_id == si.instance_id,
                    ApprovalStep.stage_id == si.legacy_stage_id,
                    ApprovalStep.decision == "pending",
                    ApprovalStep.superseded_at.is_(None),
                )
            )
        ).scalars().all()
        version_id = open_steps[0].document_version_id if open_steps else None
        round_number = max((s.round_number for s in open_steps), default=1)
        for step in open_steps:
            step.superseded_at = now

        si.resolved_approver_id = new_approver_id
        si.status = "active"
        si.blocked_reason = None
        si.timer_paused_at = None
        si.activated_at = now
        si.row_version += 1
        si.due_at = (
            now + timedelta(hours=si.due_within_hours)
            if si.due_within_hours else None
        )
        if version_id is None and doc is not None:
            # No open step to inherit from (a blocked stage never had one),
            # so fall back to the document's current version.
            version_id = doc.current_version_id
        if version_id is not None:
            await self.step_repo.create(
                instance_id=si.instance_id,
                stage_id=si.legacy_stage_id,
                document_version_id=version_id,
                approver_id=new_approver_id,
                due_at=si.due_at,
                round_number=round_number,
            )
        await self.db.flush()

        await self._write_audit(
            org_id=org_id,
            actor_id=actor.id,
            action=AuditAction.STAGE_REASSIGNED,
            resource_type="StageInstance",
            resource_id=si.id,
            instance_id=si.instance_id,
            before={"resolved_approver_id": str(previous_approver_id)
                    if previous_approver_id else None},
            after={
                "resolved_approver_id": str(new_approver_id),
                "reason": reason,
                "due_at": si.due_at.isoformat() if si.due_at else None,
            },
        )

        # N13 to the incoming approver, the outgoing one and the submitter -
        # the outgoing approver is told so the item disappearing from their
        # queue is explained rather than just happening.
        recipients = [new_approver_id]
        for uid in (previous_approver_id, doc.submitted_by if doc else None):
            if uid is not None and uid not in recipients:
                recipients.append(uid)
        await self.outbox.enqueue_notification(
            notif_catalogue.n13_stage_reassigned(
                instance_id=si.instance_id,
                user_ids=recipients,
                doc_title=doc.title if doc else "a document",
                stage_name=si.stage_name,
                position=si.position,
                reason=reason,
                stage_instance_id=si.id,
                cycle=si.cycle,
                revision=si.row_version,
            ),
            org_id=org_id,
        )
        return si

    async def _exclude_trainees_guard(
        self, user_id: uuid.UUID, org_id: uuid.UUID
    ) -> None:
        """Trainees never approve - a DocFlow-wide rule enforced in three
        other places, and reassignment must not be a fourth way around it."""
        remaining = await self._exclude_trainees([user_id], org_id)
        if not remaining:
            raise UnprocessableEntityException(
                "Trainees cannot be approvers, so this stage cannot be "
                "reassigned to this person"
            )

    async def _is_org_member(
        self, user_id: uuid.UUID, org_id: uuid.UUID
    ) -> bool:
        from app.models.organization import OrganizationMember

        row = (
            await self.db.execute(
                select(OrganizationMember.id).where(
                    OrganizationMember.org_id == org_id,
                    OrganizationMember.user_id == user_id,
                    OrganizationMember.deleted_at.is_(None),
                )
            )
        ).first()
        return row is not None

    # ── Pinned definition (DM-02, task P2-2) ───────────────────────────────

    async def _pinned_stages(
        self, instance: WorkflowInstance
    ) -> list[WorkflowStage] | None:
        """The ordered stage definition THIS RUN is pinned to.

        Never reads the live template. That read was defect 1: because
        `advance_stage()` asked the template for its current stages, an owner
        editing a workflow re-routed every run already in flight, and an edit
        that left fewer stages than a run had already passed made the run
        complete — approving the document with the remaining approvals never
        collected.

        Resolution order:
          1. the pinned version's stage instances (runs from P2-1 onward);
          2. `template_version_snapshot`, which `_freeze_template()` has
             always written at submit and which nothing ever read — the
             frozen definition was sitting there unused the whole time;
          3. nothing resolvable -> None, and the caller refuses to advance
             rather than guessing a route.
        """
        ordered_ids: list[uuid.UUID] = []

        if instance.version_id is not None:
            rows = await self.db.execute(
                select(StageInstance.legacy_stage_id)
                .where(
                    StageInstance.instance_id == instance.id,
                    StageInstance.cycle == instance.current_cycle,
                    StageInstance.deleted_at.is_(None),
                )
                .order_by(StageInstance.position)
            )
            ordered_ids = [r for r in rows.scalars().all() if r is not None]

        if not ordered_ids:
            snapshot = instance.template_version_snapshot or {}
            snap_stages = snapshot.get("stages") or []
            try:
                ordered_ids = [
                    uuid.UUID(str(s["id"]))
                    for s in sorted(
                        snap_stages,
                        key=lambda s: s.get("sequence_order") or 0,
                    )
                    if s.get("id")
                ]
            except (AttributeError, TypeError, ValueError):
                # A snapshot written by an older shape, or hand-edited data.
                # Treated as "no pinned definition" rather than parsed
                # optimistically.
                ordered_ids = []

        if not ordered_ids:
            return None

        found = {s.id: s for s in await self.stage_repo.list_by_ids(ordered_ids)}
        stages = [found[sid] for sid in ordered_ids if sid in found]
        return stages or None

    @staticmethod
    def _locate(
        stages: list[WorkflowStage], stage_id: uuid.UUID | None
    ) -> int | None:
        """Index of a stage within the pinned order.

        Position in the pinned list is authoritative, not `sequence_order`:
        existing data has 0-based and 1-based orders side by side, and a
        retired stage can share an order with its replacement.
        """
        for i, st in enumerate(stages):
            if st.id == stage_id:
                return i
        return None

    # ── Private Helpers ─────────────────────────────────────────────────────────

    async def _resolve_approvers(
        self,
        stage: WorkflowStage,
        requester_id: uuid.UUID,
        org_id: uuid.UUID,
    ) -> list[uuid.UUID]:
        """
        Resolve StageApproverRule → actual user IDs.
        Returns a deduplicated list of approver UUIDs.
        """
        approver_ids: list[uuid.UUID] = []
        for rule in stage.approver_rules:
            ids = await self._apply_rule(rule, requester_id, org_id)
            approver_ids.extend(ids)

        approver_ids = list(set(approver_ids))

        # Hard gate: Trainees never gain approval authority, regardless of how
        # a rule resolved them (a misconfigured specific_user rule, a role
        # rename, etc.). Defense in depth — ApprovalService.decide() enforces
        # this again at decision time independent of this resolution step.
        approver_ids = await self._exclude_trainees(approver_ids, org_id)

        # Fallback: if no rules match, use department head
        if not approver_ids:
            logger.warning(
                "no_approvers_resolved",
                stage_id=str(stage.id),
                rule_count=len(stage.approver_rules),
            )

        return approver_ids

    async def _exclude_trainees(
        self, user_ids: list[uuid.UUID], org_id: uuid.UUID
    ) -> list[uuid.UUID]:
        """Filter out any user whose org role is `trainee` from a resolved
        approver-candidate list — trainees must never become a gating
        approver (see domain/enums.py SYSTEM_ROLES docstring)."""
        if not user_ids:
            return user_ids
        from sqlalchemy import select
        from app.models.organization import OrganizationMember, Role

        trainee_ids_result = await self.db.execute(
            select(OrganizationMember.user_id)
            .join(Role, Role.id == OrganizationMember.role_id)
            .where(
                OrganizationMember.org_id == org_id,
                OrganizationMember.user_id.in_(user_ids),
                Role.name == "trainee",
            )
        )
        trainee_ids = {row[0] for row in trainee_ids_result.all()}
        if trainee_ids:
            logger.warning(
                "trainee_excluded_from_approvers",
                org_id=str(org_id),
                trainee_ids=[str(u) for u in trainee_ids],
            )
        return [uid for uid in user_ids if uid not in trainee_ids]

    async def _apply_rule(self, rule, requester_id: uuid.UUID, org_id: uuid.UUID) -> list[uuid.UUID]:
        """Apply a single StageApproverRule and return matching user IDs."""
        from sqlalchemy import select
        from app.models.user import User
        from app.models.organization import OrganizationMember

        rt = rule.rule_type
        rv = rule.rule_value or {}

        if rt == "specific_user":
            user_id = rv.get("user_id")
            return [uuid.UUID(user_id)] if user_id else []

        elif rt == "role_in_department":
            role_name = rv.get("role_name")
            dept_id = rv.get("dept_id")
            if not role_name:
                return []
            from app.models.organization import Role
            role_result = await self.db.execute(
                select(OrganizationMember.user_id)
                .join(Role, Role.id == OrganizationMember.role_id)
                .where(
                    OrganizationMember.org_id == org_id,
                    Role.name == role_name,
                    *([OrganizationMember.dept_id == uuid.UUID(dept_id)] if dept_id else []),
                )
            )
            return [row[0] for row in role_result.all()]

        elif rt == "manager_of_requester":
            # D1 / WF-STG-23/24: the submitter's own manager line, with the
            # department head as the FALLBACK rather than the definition.
            # Previously this resolved to the department head only, which is
            # not the same person and silently mis-routed every manager stage
            # in an org that records a real reporting line (defect 3).
            #
            # A resolved approver must never be the submitter: BR-05 forbids
            # self-approval, and a department head submitting their own
            # document would otherwise resolve to themselves. Returning []
            # here makes the stage unresolvable, which preflight reports as a
            # blocker (WF-STG-24/25) instead of creating a self-approval.
            requester = await self.db.get(User, requester_id)
            if not requester:
                return []

            if requester.manager_id and requester.manager_id != requester_id:
                return [requester.manager_id]

            if requester.department_id:
                from app.models.organization import Department
                dept = await self.db.get(Department, requester.department_id)
                if (
                    dept
                    and dept.head_user_id
                    and dept.head_user_id != requester_id
                ):
                    return [dept.head_user_id]
            return []

        elif rt == "dynamic_by_amount_threshold":
            # RESERVED — NOT IMPLEMENTED.
            # Threshold-based approver resolution requires document field data at
            # workflow-start time (e.g., compare doc.form_data["amount"] > threshold).
            # This feature is deferred to a future milestone.
            #
            # IMPORTANT: Do NOT silently fall back to the hardcoded `user_id` here.
            # Emit a structured warning so this broken rule surfaces in logs.
            logger.warning(
                "dynamic_by_amount_threshold_not_implemented",
                rule_id=str(getattr(rule, "id", "unknown")),
                stage_id=str(getattr(rule, "stage_id", "unknown")),
                rule_value=rv,
                message=(
                    "Stage has a 'dynamic_by_amount_threshold' approver rule which is not yet "
                    "implemented. No approver was resolved from this rule. If this is the only "
                    "rule on the stage, the workflow will stall with no approvers."
                ),
            )
            return []

        return []

    def _freeze_template(self, tmpl: WorkflowTemplate, stages: Sequence) -> dict:
        """Serialize the template + stages into an immutable snapshot (§10.3)."""
        return {
            "id": str(tmpl.id),
            "name": tmpl.name,
            "version": tmpl.version,
            "frozen_at": datetime.now(timezone.utc).isoformat(),
            "stages": [
                {
                    "id": str(s.id),
                    "name": s.name,
                    "sequence_order": s.sequence_order,
                    "stage_type": s.stage_type,
                    "min_approvals_required": s.min_approvals_required,
                    "sla_hours": s.sla_hours,
                    "reapproval_on_revision": s.reapproval_on_revision,
                    "approver_rules": [
                        {"rule_type": r.rule_type, "rule_value": r.rule_value}
                        for r in s.approver_rules
                    ],
                }
                for s in stages
            ],
        }

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
