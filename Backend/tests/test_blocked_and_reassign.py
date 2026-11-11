"""
Workflow module section 6.9 / 6.10 (AP-SLA-05, AP-SLA-06), E3, E4, T24, N12,
N13. Task P2-17.

A stage's approver is fixed at ACTIVATION (WF-STG-23), which for stage k+1
means when stage k is approved - possibly long after submit-time preflight
passed. If the person cannot be resolved by then, `activate_stage_instance()`
used to set the stage ACTIVE with `resolved_approver_id = None` and create no
ApprovalStep rows: nobody could act on it, the clock kept running toward an
escalation nobody could answer, and nobody was told. The run was stuck for
good, silently.

Such a stage is now BLOCKED with a reason and a paused clock, the submitter
and every Org Admin are notified (N12), and an Org Admin can reassign it.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    UnprocessableEntityException,
)
from app.domain.enums import WorkflowInstanceStatus
from app.domain.permissions import AuthUser
from app.models.outbox import OutboxEvent
from app.models.workflow import ApprovalStep, StageInstance
from app.repositories.workflow_repo import ApprovalStepRepository
from app.services.workflow_service import WorkflowService
from test_signatures_and_revocation import _make_instance


def _as(user, *roles) -> AuthUser:
    return AuthUser(
        id=user.id, email=user.email, org_id=None, roles=list(roles),
        permissions=[],
    )


async def _stage(db_session, org, submitter_id, approver_id, *, status="pending"):
    """A run with one stage instance ready to be activated."""
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter_id, approver_id=approver_id
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    si = StageInstance(
        org_id=org.id,
        instance_id=instance.id,
        legacy_stage_id=stages[0].id,
        cycle=instance.current_cycle or 1,
        position=1,
        stage_name=stages[0].name,
        status=status,
        due_within_hours=8,
    )
    db_session.add(si)
    await db_session.flush()
    return doc, version, instance, stages, step, si


async def _n_codes(db_session) -> list[str]:
    rows = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    return [r.payload.get("code") for r in rows]


# -- Detection --------------------------------------------------------------

async def test_a_stage_with_no_resolvable_approver_blocks(
    db_session, org, worker, trainee
):
    """E3 — it used to go ACTIVE with no approver and a running clock."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, _i, _s, _st, si = await _stage(
        db_session, org, submitter.id, approver.id
    )

    await WorkflowService(db_session).activate_stage_instance(
        stage_instance=si, approver_id=None, org_id=org.id,
    )

    assert si.status == "blocked"
    assert si.resolved_approver_id is None
    assert si.blocked_reason
    assert si.due_at is None, "a stage nobody can act on must not have a deadline"
    assert si.timer_paused_at is not None, (
        "the clock must be stopped, or this escalates to a manager for work "
        "that has no owner"
    )


async def test_a_deactivated_approver_blocks_the_stage(
    db_session, org, worker, trainee
):
    """E4 — resolved at build time, gone by the time the stage activates."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, _i, _s, _st, si = await _stage(
        db_session, org, submitter.id, approver.id
    )
    approver.is_active = False
    await db_session.flush()

    await WorkflowService(db_session).activate_stage_instance(
        stage_instance=si, approver_id=approver.id, org_id=org.id,
    )

    assert si.status == "blocked"
    assert "no longer active" in (si.blocked_reason or "")


async def test_blocking_notifies_the_submitter_and_the_admins(
    db_session, org, worker, trainee, admin
):
    """N12 — nothing will time out to raise the alarm, so this is the alarm."""
    approver, _ = worker
    submitter, _ = trainee
    admin_user, _ = admin
    _d, _v, _i, _s, _st, si = await _stage(
        db_session, org, submitter.id, approver.id
    )

    await WorkflowService(db_session).activate_stage_instance(
        stage_instance=si, approver_id=None, org_id=org.id,
    )

    events = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    n12 = [e for e in events if e.payload.get("code") == "N12"]
    assert len(n12) == 1
    recipients = set(n12[0].payload["user_ids"])
    assert str(submitter.id) in recipients
    assert str(admin_user.id) in recipients, (
        "an Org Admin is the only person who can clear this, so one has to "
        "be told"
    )


async def test_a_blocked_stage_is_not_overdue(db_session, org, worker, trainee):
    """Section 6.10 — paused, so the sweep leaves it alone."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _v, _i, _s, step, si = await _stage(
        db_session, org, submitter.id, approver.id
    )
    await WorkflowService(db_session).activate_stage_instance(
        stage_instance=si, approver_id=None, org_id=org.id,
    )
    step.due_at = datetime.now(timezone.utc) - timedelta(hours=3)
    await db_session.flush()

    overdue = await ApprovalStepRepository(db_session).get_overdue_pending()
    assert step.id not in [s.id for s in overdue]


# -- Reassignment -----------------------------------------------------------

async def _blocked(db_session, org, submitter_id, approver_id):
    _d, _v, instance, stages, step, si = await _stage(
        db_session, org, submitter_id, approver_id
    )
    await WorkflowService(db_session).activate_stage_instance(
        stage_instance=si, approver_id=None, org_id=org.id,
    )
    return instance, stages, step, si


async def test_an_admin_can_reassign_a_blocked_stage(
    db_session, org, worker, trainee, admin, hr
):
    """AP-SLA-06, T24 — full new window, old step retired, new step raised."""
    old_approver, _ = worker
    submitter, _ = trainee
    admin_user, _ = admin
    new_approver, _ = hr
    instance, _stages, step, si = await _blocked(
        db_session, org, submitter.id, old_approver.id
    )

    svc = WorkflowService(db_session)
    await svc.reassign_stage_instance(
        org_id=org.id,
        stage_instance_id=si.id,
        new_approver_id=new_approver.id,
        reason="Original approver has left the company",
        actor=_as(admin_user, "admin"),
    )

    assert si.status == "active"
    assert si.resolved_approver_id == new_approver.id
    assert si.blocked_reason is None
    assert si.timer_paused_at is None
    assert si.due_at is not None, "the clock restarts on reassignment"
    # A FULL window, not what was left of the old one (O-11).
    assert si.due_at > datetime.now(timezone.utc) + timedelta(hours=7)

    steps = (
        await db_session.execute(
            select(ApprovalStep).where(ApprovalStep.instance_id == instance.id)
        )
    ).scalars().all()
    assert step.superseded_at is not None, (
        "the outgoing approver's step is superseded, not decided - they did "
        "not decide anything"
    )
    live = [s for s in steps if s.superseded_at is None]
    assert [s.approver_id for s in live] == [new_approver.id]

    # And it is now in the new approver's queue, not the old one's.
    repo = ApprovalStepRepository(db_session)
    assert si.legacy_stage_id in [
        s.stage_id for s in await repo.get_pending_for_approver(new_approver.id, org.id)
    ]
    assert await repo.get_pending_for_approver(old_approver.id, org.id) == []


async def test_reassignment_notifies_all_three_parties(
    db_session, org, worker, trainee, admin, hr
):
    """N13 — including the outgoing approver, so the item vanishing from
    their queue is explained rather than just happening."""
    old_approver, _ = worker
    submitter, _ = trainee
    admin_user, _ = admin
    new_approver, _ = hr
    _i, _s, _st, si = await _blocked(
        db_session, org, submitter.id, old_approver.id
    )
    # Give the stage a live approver so there is an outgoing party to tell.
    si.resolved_approver_id = old_approver.id
    si.status = "active"
    await db_session.flush()

    await WorkflowService(db_session).reassign_stage_instance(
        org_id=org.id, stage_instance_id=si.id,
        new_approver_id=new_approver.id,
        reason="Approver is on extended leave",
        actor=_as(admin_user, "admin"),
    )

    events = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    n13 = [e for e in events if e.payload.get("code") == "N13"]
    assert len(n13) == 1
    recipients = set(n13[0].payload["user_ids"])
    assert recipients == {
        str(new_approver.id), str(old_approver.id), str(submitter.id)
    }


async def test_a_non_admin_cannot_reassign(
    db_session, org, worker, trainee, hr
):
    """Section 7.3 — reassignment changes who may approve."""
    old_approver, _ = worker
    submitter, _ = trainee
    new_approver, _ = hr
    _i, _s, _st, si = await _blocked(
        db_session, org, submitter.id, old_approver.id
    )

    for actor, roles in (
        (submitter, ("trainee",)),   # the document's own owner
        (old_approver, ("worker",)),  # the approver who is stuck
        (new_approver, ("hr",)),      # HR is not Org Admin for this
    ):
        with pytest.raises(ForbiddenException):
            await WorkflowService(db_session).reassign_stage_instance(
                org_id=org.id, stage_instance_id=si.id,
                new_approver_id=new_approver.id,
                reason="I would like to approve this myself",
                actor=_as(actor, *roles),
            )


async def test_a_reason_is_mandatory(db_session, org, worker, trainee, admin, hr):
    """AP-SLA-06 — this overrides the owner's approver chain, so the audit
    has to say why."""
    old_approver, _ = worker
    submitter, _ = trainee
    admin_user, _ = admin
    new_approver, _ = hr
    _i, _s, _st, si = await _blocked(
        db_session, org, submitter.id, old_approver.id
    )

    for bad in ("", "   ", "x"):
        with pytest.raises(UnprocessableEntityException):
            await WorkflowService(db_session).reassign_stage_instance(
                org_id=org.id, stage_instance_id=si.id,
                new_approver_id=new_approver.id, reason=bad,
                actor=_as(admin_user, "admin"),
            )


async def test_the_submitter_cannot_be_made_the_approver(
    db_session, org, worker, trainee, admin
):
    """BR-05 — reassignment bypasses the approver rules entirely, so it is
    the one path that could manufacture a self-approval."""
    old_approver, _ = worker
    submitter, _ = trainee
    admin_user, _ = admin
    _i, _s, _st, si = await _blocked(
        db_session, org, submitter.id, old_approver.id
    )

    with pytest.raises(UnprocessableEntityException) as exc:
        await WorkflowService(db_session).reassign_stage_instance(
            org_id=org.id, stage_instance_id=si.id,
            new_approver_id=submitter.id,
            reason="Let the owner sign it off themselves",
            actor=_as(admin_user, "admin"),
        )
    assert "submitter" in str(exc.value).lower()


async def test_a_deactivated_user_cannot_be_made_the_approver(
    db_session, org, worker, trainee, admin, hr
):
    """Reassigning to somebody unusable would just block the stage again."""
    old_approver, _ = worker
    submitter, _ = trainee
    admin_user, _ = admin
    new_approver, _ = hr
    _i, _s, _st, si = await _blocked(
        db_session, org, submitter.id, old_approver.id
    )
    new_approver.is_active = False
    await db_session.flush()

    with pytest.raises(UnprocessableEntityException):
        await WorkflowService(db_session).reassign_stage_instance(
            org_id=org.id, stage_instance_id=si.id,
            new_approver_id=new_approver.id,
            reason="Trying to hand it to a disabled account",
            actor=_as(admin_user, "admin"),
        )


async def test_a_finished_run_cannot_be_reassigned(
    db_session, org, worker, trainee, admin, hr
):
    old_approver, _ = worker
    submitter, _ = trainee
    admin_user, _ = admin
    new_approver, _ = hr
    instance, _s, _st, si = await _blocked(
        db_session, org, submitter.id, old_approver.id
    )
    instance.status = WorkflowInstanceStatus.APPROVED
    await db_session.flush()

    with pytest.raises(ConflictException):
        await WorkflowService(db_session).reassign_stage_instance(
            org_id=org.id, stage_instance_id=si.id,
            new_approver_id=new_approver.id,
            reason="This workflow is already over",
            actor=_as(admin_user, "admin"),
        )


async def test_an_unknown_stage_is_404(db_session, org, admin, hr):
    from app.core.exceptions import NotFoundException

    admin_user, _ = admin
    new_approver, _ = hr
    with pytest.raises(NotFoundException):
        await WorkflowService(db_session).reassign_stage_instance(
            org_id=org.id, stage_instance_id=uuid.uuid4(),
            new_approver_id=new_approver.id,
            reason="No such stage exists",
            actor=_as(admin_user, "admin"),
        )
