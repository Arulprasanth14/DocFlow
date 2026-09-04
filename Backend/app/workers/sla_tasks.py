"""DocFlow — Celery Worker: SLA Tasks
Runs every 15 minutes via Celery Beat.
Implements §4 SLAEvent audit tracking and automatic escalation.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import structlog
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.celery_app import celery_app
from app.database import async_session_factory
from app.domain.enums import NotificationType, SLAEventType
from app.models.sla import SLAEvent
from app.models.user import User
from app.models.workflow import ApprovalStep, WorkflowInstance
from app.repositories.notification_repo import NotificationRepository
from app.repositories.workflow_repo import ApprovalStepRepository

logger = structlog.get_logger(__name__)


@celery_app.task(name="app.workers.sla_tasks.check_sla_breaches")
def check_sla_breaches() -> dict:
    """
    Check all pending ApprovalStep rows for SLA breaches.
    On breach:
      1. Write immutable SLAEvent('breached')
      2. Set escalated_at on ApprovalStep
      3. Write immutable SLAEvent('escalated')
      4. Notify assigned approver + their department manager
    """
    logger.info("sla_check_starting")
    return asyncio.run(_run_sla_check())


async def _run_sla_check() -> dict:
    checked = 0
    breached = 0

    async with async_session_factory() as db:
        step_repo = ApprovalStepRepository(db)
        notif_repo = NotificationRepository(db)

        overdue_steps = await step_repo.get_overdue_pending(
            as_of=datetime.now(timezone.utc)
        )
        checked = len(overdue_steps)

        for step in overdue_steps:
            try:
                # 1. Write SLAEvent for breach
                ev_breached = SLAEvent(
                    approval_step_id=step.id,
                    event_type=SLAEventType.BREACHED,
                    metadata_={"due_at": step.due_at.isoformat() if step.due_at else None},
                )
                db.add(ev_breached)

                # 2. Mark escalated
                await step_repo.mark_escalated(step.id)

                # 3. Write SLAEvent for escalation
                ev_escalated = SLAEvent(
                    approval_step_id=step.id,
                    event_type=SLAEventType.ESCALATED,
                    metadata_={"escalated_at": datetime.now(timezone.utc).isoformat()},
                )
                db.add(ev_escalated)

                # 4. Notify approver of breach & escalation
                instance = await db.get(WorkflowInstance, step.instance_id)
                if instance:
                    await notif_repo.create(
                        org_id=instance.org_id,
                        user_id=step.approver_id,
                        type=NotificationType.ESCALATED,
                        title="SLA Breached & Escalated",
                        body=f"Approval step has exceeded its SLA and has been escalated.",
                        deep_link="/approvals",
                        instance_id=step.instance_id,
                        metadata={"approval_step_id": str(step.id)},
                    )

                    # Also notify department manager if approver has one
                    approver = await db.get(User, step.approver_id)
                    if approver and approver.department_id:
                        from app.models.organization import Department
                        dept = await db.get(Department, approver.department_id)
                        if dept and dept.head_user_id and dept.head_user_id != step.approver_id:
                            await notif_repo.create(
                                org_id=instance.org_id,
                                user_id=dept.head_user_id,
                                type=NotificationType.ESCALATED,
                                title="SLA Breach in your Department",
                                body=f"Approver {approver.name or approver.email} breached SLA on an approval step.",
                                deep_link="/approvals",
                                instance_id=step.instance_id,
                            )

                breached += 1
            except Exception as exc:
                logger.error("sla_check_error", step_id=str(step.id), error=str(exc))

        await db.commit()

    logger.info("sla_check_completed", checked=checked, breached=breached)
    return {"status": "ok", "checked": checked, "breached": breached}
