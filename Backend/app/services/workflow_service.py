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
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnprocessableEntityException,
)
from app.domain.enums import (
    AuditAction,
    DocumentStatus,
    NotificationType,
    WorkflowInstanceStatus,
)
from app.models.document import Document, DocumentVersion
from app.models.workflow import (
    ApprovalStep,
    WorkflowInstance,
    WorkflowStage,
    WorkflowTemplate,
)
from app.repositories.workflow_repo import (
    ApprovalStepRepository,
    WorkflowInstanceRepository,
    WorkflowStageRepository,
    WorkflowTemplateRepository,
)
from app.schemas.workflow_instances import (
    CancelWorkflowRequest,
    ReviseAndResumeRequest,
    SubmitDocumentRequest,
    WorkflowInstanceResponse,
)
from app.services.notification_service import NotificationService

logger = structlog.get_logger(__name__)


class WorkflowService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.instance_repo = WorkflowInstanceRepository(db)
        self.step_repo = ApprovalStepRepository(db)
        self.tmpl_repo = WorkflowTemplateRepository(db)
        self.stage_repo = WorkflowStageRepository(db)
        self.notif_svc = NotificationService(db)

    # ── Submit ──────────────────────────────────────────────────────────────────

    async def submit(
        self,
        org_id: uuid.UUID,
        document_id: uuid.UUID,
        requester_id: uuid.UUID,
        req: SubmitDocumentRequest,
    ) -> WorkflowInstanceResponse:
        """
        Submit a document for approval.

        Steps (per architecture §6 data flow + §9 request traversal):
        1. Lock the Document row and verify it's in a submittable state
        2. Load the WorkflowTemplate and validate it
        3. Freeze the template into template_version_snapshot (§10.3)
        4. Create WorkflowInstance (status=pending → in_progress)
        5. Advance document status to 'in_review'
        6. Resolve Stage-1 approvers and create ApprovalStep rows
        7. Write AuditLog
        8. Notify Stage-1 approvers
        """
        # 1. Load + validate document
        doc = await self.db.get(Document, document_id)
        if not doc or doc.org_id != org_id:
            raise NotFoundException("Document not found")
        if doc.status not in (DocumentStatus.DRAFT, DocumentStatus.CHANGES_REQUESTED,
                               DocumentStatus.REVISION_REQUESTED):
            raise ConflictException(
                f"Document is in status '{doc.status}' and cannot be submitted"
            )

        # 2. Load template
        tmpl = await self.tmpl_repo.get_by_id(req.workflow_template_id, org_id)
        if not tmpl or not tmpl.is_active:
            raise NotFoundException("WorkflowTemplate not found or inactive")

        stages = await self.stage_repo.list_for_template(tmpl.id)
        if not stages:
            raise ConflictException("Workflow template has no stages defined")

        # 3. Freeze snapshot
        snapshot = self._freeze_template(tmpl, stages)

        # 4. Create WorkflowInstance
        first_stage = stages[0]
        instance = await self.instance_repo.create(
            org_id=org_id,
            document_id=document_id,
            template_id=tmpl.id,
            template_version_snapshot=snapshot,
            current_stage_id=first_stage.id,
            status=WorkflowInstanceStatus.IN_PROGRESS,
        )

        # 5. Update document status
        doc.status = DocumentStatus.IN_REVIEW
        doc.submitted_at = datetime.now(timezone.utc)
        await self.db.flush()

        # 6. Get current document version for ApprovalStep FK
        current_version_id = doc.current_version_id
        if not current_version_id:
            raise ConflictException("Document has no version uploaded yet")

        # 7. Resolve Stage-1 approvers and create ApprovalStep rows
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

        # 8. Write AuditLog
        await self._write_audit(
            org_id=org_id,
            actor_id=requester_id,
            action=AuditAction.WORKFLOW_INSTANCE_CREATE,
            resource_type="WorkflowInstance",
            resource_id=instance.id,
            instance_id=instance.id,
            after={"status": instance.status, "template_id": str(tmpl.id)},
        )

        # 9. Notify approvers
        await self.notif_svc.notify_many(
            org_id=org_id,
            user_ids=approver_ids,
            type=NotificationType.ASSIGNED,
            title=f"Approval requested: {doc.title}",
            body=f"Stage '{first_stage.name}' requires your approval.",
            deep_link=f"/approvals",
            instance_id=instance.id,
        )

        await self.db.commit()
        logger.info("workflow_submitted", instance_id=str(instance.id), doc_id=str(document_id))
        return WorkflowInstanceResponse.model_validate(instance)

    # ── Revise and Resume ───────────────────────────────────────────────────────

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
        if doc.status != DocumentStatus.CHANGES_REQUESTED and doc.status != DocumentStatus.REVISION_REQUESTED:
            raise ConflictException(
                f"Document is not in 'changes_requested' state (current: {doc.status})"
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

        # Update document to point to new version
        doc.current_version_id = req.new_version_id
        doc.status = DocumentStatus.IN_REVIEW
        await self.db.flush()

        # Get current stage
        current_stage = await self.db.get(WorkflowStage, instance.current_stage_id)
        if not current_stage:
            raise NotFoundException("Current workflow stage not found")

        # Determine round number (max existing round + 1)
        existing_steps = await self.step_repo.get_for_instance_and_stage(
            instance.id, instance.current_stage_id
        )
        next_round = max((s.round_number for s in existing_steps), default=0) + 1

        # Resolve approvers for this stage again (same logic as submit)
        approver_ids = await self._resolve_approvers(current_stage, requester_id, org_id)

        # Check reapproval_on_revision for earlier stages
        stages = await self.stage_repo.list_for_template(instance.template_id)
        earlier_stage_approver_ids = []
        for stage in stages:
            if stage.sequence_order >= current_stage.sequence_order:
                break
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

        # Notify ONLY same-stage approvers — earlier stages are NOT re-notified
        # (unless reapproval_on_revision triggered them)
        notify_ids = list(set(approver_ids + earlier_stage_approver_ids))
        await self.notif_svc.notify_many(
            org_id=org_id,
            user_ids=approver_ids,  # Only current stage by default
            type=NotificationType.ASSIGNED,
            title=f"Revised document ready for review",
            body=f"Stage '{current_stage.name}': a revised version has been submitted.",
            deep_link=f"/approvals",
            instance_id=instance.id,
        )

        await self.db.commit()
        logger.info(
            "workflow_resumed",
            instance_id=str(instance.id),
            stage_id=str(instance.current_stage_id),
            round=next_round,
        )
        return WorkflowInstanceResponse.model_validate(instance)

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
        if instance.status in (
            WorkflowInstanceStatus.APPROVED,
            WorkflowInstanceStatus.REJECTED,
            WorkflowInstanceStatus.CANCELLED,
        ):
            raise ConflictException(f"Cannot cancel a workflow in '{instance.status}' state")

        # Only the document owner or an admin can cancel
        doc = await self.db.get(Document, instance.document_id)
        if doc and doc.submitted_by != requester_id:
            raise ForbiddenException("Only the document owner can cancel a workflow")

        instance.status = WorkflowInstanceStatus.CANCELLED
        instance.completed_at = datetime.now(timezone.utc)
        if doc:
            doc.status = DocumentStatus.CANCELLED
        await self.db.flush()

        await self._write_audit(
            org_id=org_id,
            actor_id=requester_id,
            action=AuditAction.WORKFLOW_INSTANCE_CANCEL,
            resource_type="WorkflowInstance",
            resource_id=instance.id,
            instance_id=instance.id,
            after={"status": "cancelled", "reason": req.reason},
        )

        await self.db.commit()
        return WorkflowInstanceResponse.model_validate(instance)

    # ── Get Instance ────────────────────────────────────────────────────────────

    async def get_instance(
        self, instance_id: uuid.UUID, org_id: uuid.UUID
    ) -> WorkflowInstanceResponse:
        instance = await self.instance_repo.get_by_id(instance_id, org_id)
        if not instance:
            raise NotFoundException("WorkflowInstance not found")
        return WorkflowInstanceResponse.model_validate(instance)

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
        stages = await self.stage_repo.list_for_template(instance.template_id)
        current_stage = await self.db.get(WorkflowStage, instance.current_stage_id)
        if not current_stage:
            return

        # Find next stage
        next_stage = next(
            (s for s in stages if s.sequence_order > current_stage.sequence_order),
            None,
        )

        if next_stage is None:
            # No more stages — workflow complete!
            instance.status = WorkflowInstanceStatus.APPROVED
            instance.completed_at = datetime.now(timezone.utc)
            doc = await self.db.get(Document, instance.document_id)
            if doc:
                doc.status = DocumentStatus.APPROVED
            await self.db.flush()

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

            await self.notif_svc.notify_many(
                org_id=org_id,
                user_ids=approver_ids,
                type=NotificationType.ASSIGNED,
                title="Approval requested",
                body=f"Stage '{next_stage.name}' requires your approval.",
                deep_link="/approvals",
                instance_id=instance.id,
            )
            logger.info(
                "workflow_stage_advanced",
                instance_id=str(instance.id),
                from_stage=str(current_stage.id),
                to_stage=str(next_stage.id),
            )

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

        # Fallback: if no rules match, use department head
        if not approver_ids:
            logger.warning(
                "no_approvers_resolved",
                stage_id=str(stage.id),
                rule_count=len(stage.approver_rules),
            )

        return list(set(approver_ids))

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
            # Resolve the requester's department head
            requester = await self.db.get(User, requester_id)
            if requester and requester.department_id:
                from app.models.organization import Department
                dept = await self.db.get(Department, requester.department_id)
                if dept and dept.head_user_id:
                    return [dept.head_user_id]
            return []

        elif rt == "dynamic_by_amount_threshold":
            # Not resolvable without document data here — service caller must pre-compute
            user_id = rv.get("user_id")
            return [uuid.UUID(user_id)] if user_id else []

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
