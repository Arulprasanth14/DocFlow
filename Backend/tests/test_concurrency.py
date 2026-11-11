"""
Workflow module section 7.4 (X-INT-02, X-INT-03, X-INT-06), E9, E10, T25, T26.
Task P4-12 — written because the E1-E30 sweep found these had none.

`decide()` takes a row lock (`FOR UPDATE`) and then checks whether the step
already has a decision. Both halves are needed and neither is provable by
reading: without the lock two requests read 'pending' simultaneously and both
write a decision; without the check the lock would serialise them and the
second would still overwrite the first.

These use two REAL concurrent sessions against the test database. A single
session cannot demonstrate it — the point is what Postgres does when two
transactions contend for one row, and one session never contends with itself.
"""
from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import func, select

from app.core.exceptions import ConflictException
from app.domain.enums import ApprovalDecision, WorkflowInstanceStatus
from app.models.workflow import ApprovalStep, StageInstance, WorkflowInstance
from app.schemas.workflow_instances import DecisionRequest
from app.services.approval_service import ApprovalService
from conftest import TestSessionFactory
from test_signatures_and_revocation import _make_instance


async def _ready_step(db_session, org, submitter, approver):
    """A run with one active stage and one pending step, committed so other
    sessions can see it."""
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=approver.id
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    db_session.add(
        StageInstance(
            org_id=org.id, instance_id=instance.id,
            legacy_stage_id=stages[0].id, cycle=instance.current_cycle or 1,
            position=1, stage_name=stages[0].name, status="active",
            resolved_approver_id=approver.id,
        )
    )
    await db_session.flush()
    await db_session.commit()
    return doc, instance, step


async def test_two_simultaneous_approvals_leave_exactly_one_decision(
    db_session, org, worker, trainee
):
    """E9 / T25 / X-INT-03 — one 200, one 409, one decision."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, instance, step = await _ready_step(db_session, org, submitter, approver)

    async def decide_in_own_session():
        async with TestSessionFactory() as session:
            try:
                await ApprovalService(session).decide(
                    step_id=step.id, actor_id=approver.id, org_id=org.id,
                    req=DecisionRequest(
                        decision=ApprovalDecision.APPROVED, note="Looks right",
                    ),
                )
                await session.commit()
                return "ok"
            except ConflictException:
                await session.rollback()
                return "conflict"
            except Exception as exc:  # noqa: BLE001
                await session.rollback()
                return f"error:{type(exc).__name__}"

    first, second = await asyncio.gather(
        decide_in_own_session(), decide_in_own_session()
    )

    outcomes = sorted([first, second])
    assert outcomes == ["conflict", "ok"], (
        f"expected exactly one success and one 409, got {outcomes}"
    )

    # And the database agrees: one decision, not two.
    async with TestSessionFactory() as check:
        decided = (
            await check.execute(
                select(func.count())
                .select_from(ApprovalStep)
                .where(
                    ApprovalStep.instance_id == instance.id,
                    ApprovalStep.decision != ApprovalDecision.PENDING,
                )
            )
        ).scalar()
    assert decided == 1


async def test_a_second_live_run_for_one_document_is_impossible(
    db_session, org, worker, trainee
):
    """E10 / BR-01 / X-INT-06 — enforced by a partial unique index, so it
    holds against two concurrent submits and not merely against a check in
    application code."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, instance, _step = await _ready_step(db_session, org, submitter, approver)

    async def insert_second_run():
        async with TestSessionFactory() as session:
            session.add(
                WorkflowInstance(
                    org_id=org.id,
                    document_id=instance.document_id,
                    template_id=instance.template_id,
                    template_version_snapshot={},
                    status=WorkflowInstanceStatus.IN_PROGRESS,
                )
            )
            try:
                await session.commit()
                return "inserted"
            except Exception as exc:  # noqa: BLE001
                await session.rollback()
                return type(exc).__name__

    result = await insert_second_run()
    assert result != "inserted", (
        "BR-01 must be a database guarantee: a second live run for one "
        "document has to be refused even when application code does not check"
    )

    # A terminal run does not block a new one - that is what submit-as-new
    # relies on.
    async with TestSessionFactory() as session:
        run = await session.get(WorkflowInstance, instance.id)
        run.status = WorkflowInstanceStatus.REJECTED
        await session.commit()
    assert await insert_second_run() == "inserted"


async def test_an_already_decided_step_is_refused_without_contention(
    db_session, org, worker, trainee
):
    """The guard on its own, so a failure here distinguishes 'the check is
    broken' from 'the locking is broken'."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, _instance, step = await _ready_step(db_session, org, submitter, approver)

    svc = ApprovalService(db_session)
    await svc.decide(
        step_id=step.id, actor_id=approver.id, org_id=org.id,
        req=DecisionRequest(decision=ApprovalDecision.APPROVED),
    )
    await db_session.commit()

    with pytest.raises(ConflictException):
        await ApprovalService(db_session).decide(
            step_id=step.id, actor_id=approver.id, org_id=org.id,
            req=DecisionRequest(decision=ApprovalDecision.APPROVED),
        )
