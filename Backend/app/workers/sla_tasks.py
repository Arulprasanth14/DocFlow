"""
DocFlow — Celery Worker: SLA sweep

Workflow module section 6.10, AP-SLA-01..04, N9/N10/N11. Task P2-16.

Runs every minute (AP-SLA-01). The cadence matters: at fifteen minutes a
four-hour stage's 75% mark is a fifteen-minute window, so a "due soon"
reminder could arrive after the deadline it was warning about.

Three distinct stages, which the previous sweep collapsed into one:

  1. **75% of the window elapsed** -> N9 to the approver (AP-SLA-02a). This
     did not exist at all, so the first an approver heard about a deadline
     was after they had already missed it.
  2. **The deadline passes** -> overdue flagged, N10 to the approver and once
     to the submitter (AP-SLA-03). Previously conflated with escalation. It
     never auto-approves or auto-rejects anything.
  3. **24 hours after overdue** -> N11 to the approver's MANAGER and the Org
     Admins (AP-SLA-04). Escalation used to fire the instant a step was
     late, which pages a manager about something an hour overdue, and it went
     to the department head rather than the manager line decision D1
     settled - `users.manager_id` first, department head only as a fallback.

Idempotence (X-INT-07) comes from the notification scope: every one of these
is deduped on stage instance + round + kind, so a tick that overlaps the
previous one, or a sweep that runs sixty times in the hour it used to run
four, cannot turn a reminder into a stream of them.

A paused stage has no running clock (section 6.10): a document sent back for
changes is with its owner, and a blocked stage has nobody to chase, so
neither accrues toward anyone's breach. That exclusion lives in
`get_sla_candidates`.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import structlog

from app.core.celery_app import celery_app
from app.workers._db import task_session
from app.domain import notifications as notif_catalogue
from app.domain.enums import SLAEventType
from app.models.document import Document
from app.models.organization import Department, OrganizationMember, Role
from app.models.sla import SLAEvent
from app.models.user import User
from app.models.workflow import ApprovalStep, StageInstance, WorkflowInstance
from app.repositories.workflow_repo import ApprovalStepRepository
from app.services.outbox_service import OutboxService

logger = structlog.get_logger(__name__)

# AP-SLA-02a. A fraction of the window rather than a fixed lead time, because
# a 2-hour stage and a 30-day one need very different warnings.
REMINDER_AT_FRACTION = 0.75

# AP-SLA-04. Configurable per O-12; this is the documented default.
ESCALATE_AFTER_OVERDUE_HOURS = 24


@celery_app.task(name="app.workers.sla_tasks.check_sla_breaches")
def check_sla_breaches() -> dict:
    """Sweep every in-flight approval with a live deadline."""
    logger.info("sla_check_starting")
    return asyncio.run(_run_sla_check())


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


async def _org_admin_ids(db, org_id: uuid.UUID) -> list[uuid.UUID]:
    from sqlalchemy import select

    rows = await db.execute(
        select(OrganizationMember.user_id)
        .join(Role, Role.id == OrganizationMember.role_id)
        .where(
            OrganizationMember.org_id == org_id,
            Role.name == "admin",
            OrganizationMember.deleted_at.is_(None),
        )
    )
    return list(rows.scalars().all())


async def _escalation_targets(
    db, approver: User | None, org_id: uuid.UUID
) -> list[uuid.UUID]:
    """Who hears about an escalation: the approver's manager, plus Org Admins.

    Decision D1 — `users.manager_id` is the manager, with the department head
    only as a fallback when none is recorded. The previous sweep went
    straight to the department head, which in an org that keeps a reporting
    line is a different person entirely.
    """
    targets: list[uuid.UUID] = []
    if approver is not None:
        manager_id = getattr(approver, "manager_id", None)
        if manager_id and manager_id != approver.id:
            targets.append(manager_id)
        elif approver.department_id:
            dept = await db.get(Department, approver.department_id)
            if dept and dept.head_user_id and dept.head_user_id != approver.id:
                targets.append(dept.head_user_id)
    for admin_id in await _org_admin_ids(db, org_id):
        if admin_id not in targets:
            targets.append(admin_id)
    return targets


async def _stage_for(db, step: ApprovalStep) -> StageInstance | None:
    from sqlalchemy import select

    if step.stage_id is None:
        return None
    return (
        await db.execute(
            select(StageInstance)
            .where(
                StageInstance.instance_id == step.instance_id,
                StageInstance.legacy_stage_id == step.stage_id,
                StageInstance.deleted_at.is_(None),
            )
            .order_by(StageInstance.cycle.desc())
            .limit(1)
        )
    ).scalars().first()


async def _run_sla_check() -> dict:
    """Open a session, sweep, commit, deliver."""
    async with task_session() as db:
        counts = await sweep(db)
        # One commit for the tick. The notifications are outbox rows, so they
        # go out only if this commits - a sweep that dies half way through has
        # told nobody anything (X-NOT-01).
        await db.commit()

        # Deliver what was just queued rather than waiting for the outbox's
        # own tick, so a reminder is not a minute late on top of being due.
        try:
            delivered = await OutboxService(db).deliver_pending()
            await db.commit()
            if delivered:
                logger.debug("sla_notifications_delivered", count=delivered)
        except Exception as exc:  # noqa: BLE001
            # Never fatal: the rows are committed and the outbox sweep will
            # pick them up.
            logger.warning("sla_outbox_drain_failed", error=str(exc))
            await db.rollback()

    logger.info("sla_check_completed", **counts)
    return {"status": "ok", **counts}


async def sweep(db, *, as_of: datetime | None = None) -> dict:
    """Classify every candidate and queue what it is owed. Does not commit.

    Takes a session rather than opening one so the rules can be driven
    directly in a test; the Celery task above owns the transaction.
    """
    now = as_of or datetime.now(timezone.utc)
    counts = {"checked": 0, "reminded": 0, "overdue": 0, "escalated": 0}

    step_repo = ApprovalStepRepository(db)
    outbox = OutboxService(db)

    candidates = await step_repo.get_sla_candidates(as_of=now)
    counts["checked"] = len(candidates)
    if not candidates:
        return counts

    # Build every envelope this tick WOULD send, then ask the outbox in
    # one query which of them have already gone out. Without this the
    # per-minute sweep does a round-trip per candidate per kind just to
    # discover there is nothing to do.
    planned: list[tuple[ApprovalStep, StageInstance | None, object, str]] = []

    for step in candidates:
        due_at = _aware(step.due_at)
        if due_at is None:
            continue
        try:
            instance = await db.get(WorkflowInstance, step.instance_id)
            if instance is None:
                continue
            doc = await db.get(Document, instance.document_id)
            doc_title = doc.title if doc else "a document"
            si = await _stage_for(db, step)
            position = si.position if si else 1
            stage_name = si.stage_name if si else "Approval"
            cycle = si.cycle if si else 1

            started = _aware(
                (si.activated_at if si else None) or step.created_at
            ) or due_at
            window = (due_at - started).total_seconds()
            hours_left = (due_at - now).total_seconds() / 3600
            hours_overdue = -hours_left

            if now < due_at:
                # Stage 1 — 75% elapsed. A window of zero or less is a
                # due_at that was set in the past; the overdue branch
                # below handles it, there is nothing to warn about.
                if window > 0:
                    elapsed = (now - started).total_seconds() / window
                    if elapsed >= REMINDER_AT_FRACTION:
                        planned.append((
                            step, si,
                            notif_catalogue.n9_due_soon(
                                instance_id=instance.id,
                                approver_ids=[step.approver_id],
                                doc_title=doc_title,
                                stage_name=stage_name,
                                position=position,
                                hours_left=max(0.0, hours_left),
                                stage_instance_id=si.id if si else None,
                                cycle=cycle,
                                round_number=step.round_number,
                            ),
                            "reminded",
                        ))
                continue

            # Stage 2 — overdue. Flagged to the approver, and once to the
            # submitter. Two events, not one with two recipients: "your
            # approval is late" and "your document is late" are different
            # messages and each must be sent exactly once.
            planned.append((
                step, si,
                notif_catalogue.n10_overdue(
                    instance_id=instance.id,
                    user_ids=[step.approver_id],
                    doc_title=doc_title, stage_name=stage_name,
                    position=position,
                    stage_instance_id=si.id if si else None,
                    cycle=cycle, round_number=step.round_number,
                ),
                "overdue",
            ))
            if doc is not None and doc.submitted_by != step.approver_id:
                planned.append((
                    step, si,
                    notif_catalogue.n10_overdue(
                        instance_id=instance.id,
                        user_ids=[doc.submitted_by],
                        doc_title=doc_title, stage_name=stage_name,
                        position=position, for_submitter=True,
                        cycle=cycle, round_number=step.round_number,
                    ),
                    "",
                ))

            # Stage 3 — escalation, a full day after the deadline.
            if hours_overdue >= ESCALATE_AFTER_OVERDUE_HOURS:
                approver = await db.get(User, step.approver_id)
                targets = await _escalation_targets(
                    db, approver, instance.org_id
                )
                if targets:
                    planned.append((
                        step, si,
                        notif_catalogue.n11_escalated(
                            instance_id=instance.id,
                            user_ids=targets,
                            doc_title=doc_title, stage_name=stage_name,
                            position=position,
                            approver_name=(
                                approver.name or approver.email
                                if approver else None
                            ),
                            hours_overdue=hours_overdue,
                            cycle=cycle, round_number=step.round_number,
                        ),
                        "escalated",
                    ))
                elif step.escalated_at is None:
                    # Nobody to escalate to: no manager, no department head
                    # and no Org Admin. The step is still marked escalated,
                    # because otherwise this branch is reached again on every
                    # tick for the rest of the run's life — once a minute,
                    # forever. The warning is the record that an escalation
                    # was due and the org had nobody to send it to.
                    logger.warning(
                        "sla_escalation_has_no_recipient",
                        step_id=str(step.id),
                        instance_id=str(instance.id),
                        approver_id=str(step.approver_id),
                    )
                    db.add(SLAEvent(
                        approval_step_id=step.id,
                        event_type=SLAEventType.ESCALATED,
                        metadata_={
                            "escalated_at": now.isoformat(),
                            "delivered": False,
                            "reason": "no manager, department head or org admin",
                        },
                    ))
                    await step_repo.mark_escalated(step.id)
        except Exception as exc:  # noqa: BLE001 — one bad row must not
            # stop the sweep; the rest of the queue still needs chasing.
            logger.error(
                "sla_candidate_failed", step_id=str(step.id), error=str(exc)
            )

    already = await outbox.existing_dedupe_keys(
        [env.dedupe_key for _s, _si, env, _k in planned]
    )

    for step, si, envelope, kind in planned:
        if envelope.dedupe_key in already:
            continue
        instance = await db.get(WorkflowInstance, step.instance_id)
        if instance is None:
            continue
        await outbox.enqueue_notification(envelope, org_id=instance.org_id)
        if kind:
            counts[kind] += 1

        # SLAEvent is the append-only audit record (section 4). Written
        # for the two events that are facts about the step, not for the
        # pre-deadline reminder, which is a nudge rather than an event in
        # its lifecycle.
        if kind == "overdue":
            db.add(SLAEvent(
                approval_step_id=step.id,
                event_type=SLAEventType.BREACHED,
                metadata_={
                    "due_at": step.due_at.isoformat() if step.due_at else None,
                    "detected_at": now.isoformat(),
                },
            ))
        elif kind == "escalated":
            db.add(SLAEvent(
                approval_step_id=step.id,
                event_type=SLAEventType.ESCALATED,
                metadata_={
                    "escalated_at": now.isoformat(),
                    "after_hours_overdue": ESCALATE_AFTER_OVERDUE_HOURS,
                },
            ))
            # Kept for the existing `get_overdue_pending` contract, which
            # excludes escalated steps. Set at ESCALATION now, not at the
            # deadline — the two were the same moment before.
            await step_repo.mark_escalated(step.id)

        # No stage transition on overdue, deliberately: AP-SLA-03 makes
        # overdue a FLAG, derived from due_at, and the sweep never
        # auto-approves or auto-rejects. The stage stays Active and the
        # approver stays the person who has to decide.

    await db.flush()

    return counts
