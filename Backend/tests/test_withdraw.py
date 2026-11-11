"""
Workflow module section 5.11 (WF-WD-01..03), E8, T32. Task P2-13.

Withdrawing is supposed to be terminal: the run closes, the clock stops, the
work leaves the approver's queue and the approver is told.

It did none of those things. In particular `decide()` never looked at the
run's status, so after the owner withdrew a document the approver could still
approve it - and approving the last stage set the document to APPROVED. A
document the owner had pulled back came out of the far end approved.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.core.exceptions import ConflictException, ForbiddenException
from app.domain.enums import ApprovalDecision, WorkflowInstanceStatus
from app.models.outbox import OutboxEvent
from app.models.workflow import StageInstance
from app.repositories.workflow_repo import ApprovalStepRepository
from app.schemas.workflow_instances import CancelWorkflowRequest, DecisionRequest
from app.services.approval_service import ApprovalService
from app.services.workflow_service import WorkflowService
from sqlalchemy import select
from test_signatures_and_revocation import _make_instance


async def _running(db_session, org, submitter_id, approver_id):
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter_id, approver_id=approver_id
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    step.due_at = datetime.now(timezone.utc) + timedelta(hours=4)
    db_session.add(
        StageInstance(
            org_id=org.id,
            instance_id=instance.id,
            legacy_stage_id=stages[0].id,
            cycle=instance.current_cycle or 1,
            position=1,
            stage_name=stages[0].name,
            status="active",
            resolved_approver_id=approver_id,
            due_at=step.due_at,
        )
    )
    await db_session.flush()
    return doc, version, instance, stages, step


async def _withdraw(db_session, org, instance, owner_id):
    return await WorkflowService(db_session).cancel(
        org_id=org.id,
        instance_id=instance.id,
        requester_id=owner_id,
        req=CancelWorkflowRequest(reason="No longer needed"),
    )


async def test_withdrawing_takes_the_work_out_of_the_approvers_queue(
    db_session, org, worker, trainee
):
    """WF-WD-02 — the step was left pending, so it kept its place in the
    dashboard with live Approve / Reject buttons."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, step = await _running(
        db_session, org, submitter.id, approver.id
    )

    repo = ApprovalStepRepository(db_session)
    before = await repo.get_pending_for_approver(approver.id, org.id)
    assert step.id in [s.id for s in before]

    await _withdraw(db_session, org, instance, submitter.id)

    after = await repo.get_pending_for_approver(approver.id, org.id)
    assert step.id not in [s.id for s in after], (
        "a withdrawn document must not stay in the approver's queue"
    )


async def test_an_approval_after_a_withdrawal_is_refused(
    db_session, org, worker, trainee
):
    """T32 / E8 — and the document must NOT end up approved."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v, instance, _s, step = await _running(
        db_session, org, submitter.id, approver.id
    )

    await _withdraw(db_session, org, instance, submitter.id)

    with pytest.raises(ConflictException) as exc:
        await ApprovalService(db_session).decide(
            step_id=step.id,
            actor_id=approver.id,
            org_id=org.id,
            req=DecisionRequest(decision=ApprovalDecision.APPROVED),
        )
    assert "withdrew" in str(exc.value).lower()

    await db_session.refresh(instance)
    await db_session.refresh(doc)
    assert instance.status == WorkflowInstanceStatus.CANCELLED
    assert doc.status != "approved", (
        "a withdrawn document must never come out of the far end approved"
    )


async def test_the_clock_stops_on_withdrawal(db_session, org, worker, trainee):
    """Section 6.10 — a withdrawn document that kept its timer would breach
    its SLA and escalate to the approver's manager for nothing."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, step = await _running(
        db_session, org, submitter.id, approver.id
    )

    await _withdraw(db_session, org, instance, submitter.id)

    si = (
        await db_session.execute(
            select(StageInstance).where(StageInstance.instance_id == instance.id)
        )
    ).scalars().one()
    assert si.status == "superseded"
    assert si.timer_paused_at is not None

    # And it is not swept, even once its due time has passed.
    step.due_at = datetime.now(timezone.utc) - timedelta(hours=1)
    await db_session.flush()
    overdue = await ApprovalStepRepository(db_session).get_overdue_pending()
    assert step.id not in [s.id for s in overdue]


async def test_the_approver_is_told(db_session, org, worker, trainee):
    """WF-WD-02 / N8 — queued, not sent inline, so a withdrawal that rolls
    back does not notify (X-NOT-01)."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, _step = await _running(
        db_session, org, submitter.id, approver.id
    )

    await _withdraw(db_session, org, instance, submitter.id)

    events = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    n8 = [e for e in events if e.payload.get("code") == "N8"]
    assert len(n8) == 1
    assert n8[0].payload["user_ids"] == [str(approver.id)]


async def test_withdrawing_twice_is_refused(db_session, org, worker, trainee):
    """WF-WD-01 — terminal."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, _step = await _running(
        db_session, org, submitter.id, approver.id
    )

    await _withdraw(db_session, org, instance, submitter.id)
    with pytest.raises(ConflictException):
        await _withdraw(db_session, org, instance, submitter.id)


async def test_a_finalized_run_cannot_be_withdrawn(
    db_session, org, worker, trainee
):
    """FINALIZED and COMPLETED were missing from the terminal set, so a
    finished run could be withdrawn after the fact."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, _step = await _running(
        db_session, org, submitter.id, approver.id
    )
    instance.status = WorkflowInstanceStatus.FINALIZED
    await db_session.flush()

    with pytest.raises(ConflictException):
        await _withdraw(db_session, org, instance, submitter.id)


async def test_only_the_owner_can_withdraw(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, _step = await _running(
        db_session, org, submitter.id, approver.id
    )

    with pytest.raises(ForbiddenException):
        await _withdraw(db_session, org, instance, approver.id)


async def test_a_decision_is_refused_while_the_document_is_with_its_owner(
    db_session, org, worker, trainee
):
    """AP-SLA-03 / BR-06 — in Changes Requested the version in front of the
    approver is not the one under review any more."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, instance, _s, step = await _running(
        db_session, org, submitter.id, approver.id
    )
    instance.status = WorkflowInstanceStatus.CHANGES_REQUESTED
    await db_session.flush()

    with pytest.raises(ConflictException) as exc:
        await ApprovalService(db_session).decide(
            step_id=step.id,
            actor_id=approver.id,
            org_id=org.id,
            req=DecisionRequest(decision=ApprovalDecision.APPROVED),
        )
    assert "owner" in str(exc.value).lower()
