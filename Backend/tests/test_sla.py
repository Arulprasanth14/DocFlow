"""
Workflow module §6.10 (AP-SLA-03), T34. Task P2-16 — defect 6.

The SLA sweep selected pending steps on `decision == 'pending'` and
`due_at < now` alone. So a document the approver had SENT BACK for
corrections kept counting down while it sat with its owner, and the approver
was escalated on for work that was not theirs to do. §6.10 is explicit that
the timer stops while the document is in Changes Requested, and while a stage
is blocked awaiting reassignment.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.domain.enums import WorkflowInstanceStatus
from app.models.workflow import StageInstance
from app.repositories.workflow_repo import ApprovalStepRepository
from test_signatures_and_revocation import _make_instance


async def _overdue(db_session, org, submitter_id, approver_id):
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter_id, approver_id=approver_id
    )
    step.due_at = datetime.now(timezone.utc) - timedelta(hours=5)
    await db_session.flush()
    return doc, version, instance, stages, step


async def test_an_overdue_step_on_a_running_workflow_is_swept(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, step = await _overdue(
        db_session, org, submitter.id, approver.id
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    await db_session.flush()

    overdue = await ApprovalStepRepository(db_session).get_overdue_pending()
    assert step.id in [s.id for s in overdue]


async def test_the_timer_does_not_run_while_changes_are_requested(
    db_session, org, worker, trainee
):
    """T34 / AP-SLA-03 — the document is with its owner, not the approver."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, step = await _overdue(
        db_session, org, submitter.id, approver.id
    )
    instance.status = WorkflowInstanceStatus.CHANGES_REQUESTED
    await db_session.flush()

    overdue = await ApprovalStepRepository(db_session).get_overdue_pending()
    assert step.id not in [s.id for s in overdue], (
        "a document sent back for corrections must not accrue toward the "
        "approver's SLA breach"
    )


async def test_a_blocked_stage_is_not_overdue(db_session, org, worker, trainee):
    """§6.10 — a stage awaiting admin reassignment has its clock paused."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, stages, step = await _overdue(
        db_session, org, submitter.id, approver.id
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    db_session.add(
        StageInstance(
            org_id=org.id,
            instance_id=instance.id,
            legacy_stage_id=stages[0].id,
            cycle=instance.current_cycle,
            position=1,
            stage_name=stages[0].name,
            status="blocked",
            blocked_reason="Approver deactivated",
        )
    )
    await db_session.flush()

    overdue = await ApprovalStepRepository(db_session).get_overdue_pending()
    assert step.id not in [s.id for s in overdue]


async def test_an_explicitly_paused_stage_is_not_overdue(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, stages, step = await _overdue(
        db_session, org, submitter.id, approver.id
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    db_session.add(
        StageInstance(
            org_id=org.id,
            instance_id=instance.id,
            legacy_stage_id=stages[0].id,
            cycle=instance.current_cycle,
            position=1,
            stage_name=stages[0].name,
            status="active",
            timer_paused_at=datetime.now(timezone.utc),
        )
    )
    await db_session.flush()

    overdue = await ApprovalStepRepository(db_session).get_overdue_pending()
    assert step.id not in [s.id for s in overdue]


async def test_a_terminal_run_is_never_overdue(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, step = await _overdue(
        db_session, org, submitter.id, approver.id
    )
    instance.status = WorkflowInstanceStatus.CANCELLED
    await db_session.flush()

    overdue = await ApprovalStepRepository(db_session).get_overdue_pending()
    assert step.id not in [s.id for s in overdue]
