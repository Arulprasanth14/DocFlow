"""
Workflow module section 6.10 (AP-SLA-01..04), N9/N10/N11, T34. Task P2-16.

The sweep used to do one thing: anything past its deadline was marked
breached AND escalated in the same pass, to the approver's DEPARTMENT HEAD.
Section 6.10 asks for three separate stages, and the gap between them is the
point - a reminder before the deadline is useful, an escalation an hour after
it is noise.

These tests drive the classification directly rather than through Celery, so
they pin the rules rather than the scheduling.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.domain.enums import WorkflowInstanceStatus
from app.models.outbox import OutboxEvent
from app.models.workflow import StageInstance
from app.repositories.workflow_repo import ApprovalStepRepository
from app.workers.sla_tasks import sweep
from test_signatures_and_revocation import _make_instance


async def _stage_with_window(
    db_session, org, submitter_id, approver_id, *,
    activated_hours_ago: float, window_hours: float,
    run_status=WorkflowInstanceStatus.IN_PROGRESS,
    si_status="active", paused=False,
):
    """A run whose single stage opened `activated_hours_ago` with a
    `window_hours` deadline, so the sweep's arithmetic has something real."""
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter_id, approver_id=approver_id
    )
    now = datetime.now(timezone.utc)
    activated = now - timedelta(hours=activated_hours_ago)
    due = activated + timedelta(hours=window_hours)

    instance.status = run_status
    step.due_at = due
    db_session.add(
        StageInstance(
            org_id=org.id, instance_id=instance.id,
            legacy_stage_id=stages[0].id, cycle=instance.current_cycle or 1,
            position=1, stage_name=stages[0].name, status=si_status,
            resolved_approver_id=approver_id,
            activated_at=activated, due_at=due,
            timer_paused_at=now if paused else None,
            due_within_hours=int(window_hours),
        )
    )
    await db_session.flush()
    return doc, instance, step


async def _codes(db_session) -> dict[str, list[dict]]:
    rows = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(r.payload.get("code", "?"), []).append(r.payload)
    return out


# -- Stage 1: the 75% reminder ---------------------------------------------

async def test_a_reminder_goes_out_at_75_percent(
    db_session, org, worker, trainee
):
    """AP-SLA-02a — this did not exist, so the first an approver heard about
    a deadline was after missing it."""
    approver, _ = worker
    submitter, _ = trainee
    # 8-hour window, 7 hours in: 87% elapsed, not yet due.
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=7, window_hours=8,
    )

    result = await sweep(db_session)
    assert result["reminded"] == 1
    assert result["overdue"] == 0

    codes = await _codes(db_session)
    assert "N9" in codes
    assert codes["N9"][0]["user_ids"] == [str(approver.id)]
    assert "N10" not in codes, "it is not due yet"


async def test_no_reminder_early_in_the_window(
    db_session, org, worker, trainee
):
    """A fraction of the window, not a fixed lead time — a 30-day stage must
    not start nagging on day one."""
    approver, _ = worker
    submitter, _ = trainee
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=2, window_hours=24,
    )

    result = await sweep(db_session)
    assert result["reminded"] == 0
    assert await _codes(db_session) == {}


async def test_the_reminder_is_sent_once(db_session, org, worker, trainee):
    """X-INT-07 / AP-SLA-02c — the sweep now runs sixty times an hour where
    it used to run four. Without dedupe that is a reminder a minute."""
    approver, _ = worker
    submitter, _ = trainee
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=7, window_hours=8,
    )

    assert (await sweep(db_session))["reminded"] == 1
    assert (await sweep(db_session))["reminded"] == 0
    assert (await sweep(db_session))["reminded"] == 0

    codes = await _codes(db_session)
    assert len(codes["N9"]) == 1


# -- Stage 2: overdue ------------------------------------------------------

async def test_passing_the_deadline_flags_overdue_without_escalating(
    db_session, org, worker, trainee
):
    """AP-SLA-03 / AP-SLA-04 — escalation used to fire in the same pass."""
    approver, _ = worker
    submitter, _ = trainee
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=10, window_hours=8,  # 2 hours overdue
    )

    result = await sweep(db_session)
    assert result["overdue"] == 1
    assert result["escalated"] == 0, (
        "two hours late must not page the approver's manager"
    )

    codes = await _codes(db_session)
    assert "N10" in codes
    assert "N11" not in codes


async def test_the_submitter_is_told_their_document_is_late(
    db_session, org, worker, trainee
):
    """Two events, not one with two recipients: 'your approval is late' and
    'your document is late' are different messages."""
    approver, _ = worker
    submitter, _ = trainee
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=10, window_hours=8,
    )

    await sweep(db_session)
    codes = await _codes(db_session)
    recipients = {u for p in codes["N10"] for u in p["user_ids"]}
    assert str(approver.id) in recipients
    assert str(submitter.id) in recipients
    assert len(codes["N10"]) == 2, "one event each, separately deduped"


async def test_overdue_does_not_decide_anything(
    db_session, org, worker, trainee
):
    """AP-SLA-03 — it never auto-approves and never auto-rejects."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, instance, step = await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=40, window_hours=8,
    )

    await sweep(db_session)

    await db_session.refresh(step)
    await db_session.refresh(instance)
    assert step.decision == "pending"
    assert instance.status == WorkflowInstanceStatus.IN_PROGRESS
    si = (
        await db_session.execute(
            select(StageInstance).where(StageInstance.instance_id == instance.id)
        )
    ).scalars().one()
    assert si.status == "active", "overdue is a flag, not a state"


# -- Stage 3: escalation ---------------------------------------------------

async def test_escalation_waits_a_full_day(
    db_session, org, worker, trainee, admin
):
    """AP-SLA-04. The `admin` fixture is required, not incidental: an
    escalation goes to the approver's manager AND the Org Admins, and this
    approver has no manager, so the admin is the only recipient."""
    approver, _ = worker
    submitter, _ = trainee
    _admin_user, _ = admin
    # 8-hour window opened 36 hours ago: 28 hours overdue.
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=36, window_hours=8,
    )

    result = await sweep(db_session)
    assert result["escalated"] == 1
    codes = await _codes(db_session)
    assert "N11" in codes


async def test_escalation_follows_the_manager_line(
    db_session, org, worker, trainee, admin, hr
):
    """Decision D1 — `users.manager_id` is the manager. The sweep used to go
    straight to the department head, a different person in any org that keeps
    a reporting line."""
    approver, _ = worker
    submitter, _ = trainee
    manager, _ = admin
    dept_head, _ = hr

    from app.models.organization import Department

    dept = Department(
        org_id=org.id, name=f"Ops-{uuid.uuid4().hex[:4]}",
        code=f"ops-{uuid.uuid4().hex[:4]}", head_user_id=dept_head.id,
    )
    db_session.add(dept)
    await db_session.flush()
    approver.department_id = dept.id
    approver.manager_id = manager.id
    await db_session.flush()

    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=36, window_hours=8,
    )

    await sweep(db_session)
    codes = await _codes(db_session)
    recipients = {u for p in codes["N11"] for u in p["user_ids"]}
    assert str(manager.id) in recipients
    assert str(dept_head.id) not in recipients, (
        "the department head is the FALLBACK, not the manager"
    )


async def test_escalation_is_sent_once(db_session, org, worker, trainee, admin):
    approver, _ = worker
    submitter, _ = trainee
    _admin_user, _ = admin
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=36, window_hours=8,
    )

    assert (await sweep(db_session))["escalated"] == 1
    assert (await sweep(db_session))["escalated"] == 0
    assert len((await _codes(db_session))["N11"]) == 1


# -- Paused clocks ---------------------------------------------------------

async def test_a_document_sent_back_accrues_nothing(
    db_session, org, worker, trainee
):
    """AP-SLA-03 / T34 — it is with its owner, not the approver."""
    approver, _ = worker
    submitter, _ = trainee
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=36, window_hours=8,
        run_status=WorkflowInstanceStatus.CHANGES_REQUESTED,
    )

    result = await sweep(db_session)
    assert result["checked"] == 0
    assert await _codes(db_session) == {}


async def test_a_blocked_stage_accrues_nothing(db_session, org, worker, trainee):
    """Section 6.10 — escalating a stage with no approver pages a manager
    about work that has no owner."""
    approver, _ = worker
    submitter, _ = trainee
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=36, window_hours=8, si_status="blocked",
    )

    result = await sweep(db_session)
    assert result["checked"] == 0


async def test_an_explicitly_paused_stage_accrues_nothing(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=36, window_hours=8, paused=True,
    )

    assert (await sweep(db_session))["checked"] == 0


async def test_a_step_with_no_deadline_is_never_swept(
    db_session, org, worker, trainee
):
    """A stage with no SLA is not late — it has nothing to be late for."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, _version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=approver.id
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    step.due_at = None
    await db_session.flush()

    assert (await sweep(db_session))["checked"] == 0


async def test_the_candidate_query_includes_not_yet_due_steps(
    db_session, org, worker, trainee
):
    """The old query filtered `due_at < now`, which cannot ever send a
    pre-deadline reminder."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, instance, step = await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=1, window_hours=8,
    )

    repo = ApprovalStepRepository(db_session)
    candidates = await repo.get_sla_candidates()
    assert step.id in [s.id for s in candidates]
    # ...and it is correctly NOT overdue.
    overdue = await repo.get_overdue_pending()
    assert step.id not in [s.id for s in overdue]


async def test_an_escalation_with_nobody_to_tell_does_not_spin(
    db_session, org, worker, trainee
):
    """No manager, no department head, no Org Admin — a misconfigured org.

    The step is still marked escalated. Without that this branch is reached
    on every tick for the rest of the run's life: once a minute, forever.
    """
    approver, _ = worker
    submitter, _ = trainee
    _doc, _instance, step = await _stage_with_window(
        db_session, org, submitter.id, approver.id,
        activated_hours_ago=36, window_hours=8,
    )

    first = await sweep(db_session)
    assert first["escalated"] == 0
    assert "N11" not in await _codes(db_session)

    await db_session.refresh(step)
    assert step.escalated_at is not None, (
        "an escalation nobody can receive must still be recorded, or the "
        "sweep retries it every minute for ever"
    )
