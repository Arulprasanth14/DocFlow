"""
Workflow module section 6.3 (AP-DET-01..05), section 9.4, T17, T39, E28.
Task P2-19.

There was no per-approval view at all - the dashboard row linked to
/documents/{id}, which is the owner's screen.

The delicate part is the access rule. Section 9.4 and WF-OWN-10 require
**404, not 403**, wherever existence must not leak: a stranger probing ids
must not be able to tell a real stage from an invented one by the status code
that comes back, because the difference between "no such thing" and "not
yours" is itself information about another department's documents.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.exceptions import NotFoundException
from app.domain.enums import ApprovalDecision, WorkflowInstanceStatus
from app.domain.permissions import AuthUser
from app.models.document import Document, DocumentType, DocumentVersion
from app.models.workflow import (
    ApprovalStep,
    StageInstance,
    WorkflowInstance,
    WorkflowStage,
    WorkflowTemplate,
)
from app.services.approval_service import ApprovalService


def _as(user, org, *roles) -> AuthUser:
    return AuthUser(
        id=user.id, email=user.email, org_id=org.id, roles=list(roles),
        permissions=[],
    )


async def _run(db_session, org, submitter, approver, *, stages=2):
    dt = DocumentType(
        org_id=org.id, name="General", code=f"gen-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dt)
    await db_session.flush()
    doc = Document(
        org_id=org.id, doc_type_id=dt.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}", title="Capex Request",
        submitted_by=submitter.id,
    )
    db_session.add(doc)
    await db_session.flush()
    version = DocumentVersion(
        document_id=doc.id, version_num=3, title=doc.title,
        uploaded_by=submitter.id,
    )
    db_session.add(version)
    await db_session.flush()
    doc.current_version_id = version.id

    tmpl = WorkflowTemplate(
        org_id=org.id, name="Capex Approval", created_by=submitter.id
    )
    db_session.add(tmpl)
    await db_session.flush()
    stage_rows = []
    for i in range(1, stages + 1):
        st = WorkflowStage(
            template_id=tmpl.id, sequence_order=i, name=f"Stage {i}"
        )
        db_session.add(st)
        stage_rows.append(st)
    await db_session.flush()

    instance = WorkflowInstance(
        org_id=org.id, document_id=doc.id, template_id=tmpl.id,
        template_version_snapshot={"id": str(tmpl.id), "stages": []},
        current_stage_id=stage_rows[0].id,
        status=WorkflowInstanceStatus.IN_PROGRESS,
        submitted_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    db_session.add(instance)
    await db_session.flush()

    sis = []
    for i, st in enumerate(stage_rows, start=1):
        si = StageInstance(
            org_id=org.id, instance_id=instance.id, legacy_stage_id=st.id,
            cycle=1, position=i, stage_name=st.name,
            status="active" if i == 1 else "pending",
            resolved_approver_id=approver.id if i == 1 else None,
            due_at=(
                datetime.now(timezone.utc) + timedelta(hours=6)
                if i == 1 else None
            ),
        )
        db_session.add(si)
        sis.append(si)
    step = ApprovalStep(
        instance_id=instance.id, stage_id=stage_rows[0].id,
        document_version_id=version.id, approver_id=approver.id,
        decision="pending",
        due_at=datetime.now(timezone.utc) + timedelta(hours=6),
    )
    db_session.add(step)
    await db_session.flush()
    return doc, instance, sis, step, tmpl


# -- Access (the part that must not leak) -----------------------------------

async def test_an_unrelated_user_gets_404_not_403(
    db_session, org, worker, trainee, hr
):
    """T17 / T39 / E28 — and it must be the SAME exception a bogus id gets."""
    approver, _ = worker
    submitter, _ = trainee
    stranger, _ = hr
    _doc, _inst, sis, _step, _t = await _run(
        db_session, org, submitter, approver
    )

    svc = ApprovalService(db_session)
    with pytest.raises(NotFoundException) as real:
        await svc.stage_instance_detail(sis[0].id, _as(stranger, org, "hr_x"))
    with pytest.raises(NotFoundException) as fake:
        await svc.stage_instance_detail(uuid.uuid4(), _as(stranger, org, "hr_x"))

    assert str(real.value) == str(fake.value), (
        "a real stage and an invented one must be indistinguishable to "
        "someone with no right to either"
    )


async def test_the_assigned_approver_can_see_it(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    doc, _inst, sis, step, tmpl = await _run(
        db_session, org, submitter, approver
    )

    detail = await ApprovalService(db_session).stage_instance_detail(
        sis[0].id, _as(approver, org, "worker")
    )

    assert detail.document_title == "Capex Request"
    assert detail.document_public_id == doc.public_id
    assert detail.document_version_num == 3
    assert detail.workflow_name == tmpl.name
    assert detail.position == 1
    assert detail.total_stages == 2
    assert detail.submitter_name == submitter.name
    assert detail.can_act is True
    assert detail.my_step_id == step.id
    assert detail.cannot_act_reason is None
    assert detail.urgency == "due_soon"


async def test_the_owner_can_see_it_but_cannot_act(
    db_session, org, worker, trainee
):
    """Section 7.3 — the owner may follow their document's progress; they are
    not its approver."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, _inst, sis, _step, _t = await _run(
        db_session, org, submitter, approver
    )

    detail = await ApprovalService(db_session).stage_instance_detail(
        sis[0].id, _as(submitter, org, "trainee")
    )
    assert detail.can_act is False
    assert detail.my_step_id is None, (
        "a viewer must not be handed a step id to post a decision to"
    )
    assert detail.cannot_act_reason


async def test_an_admin_can_see_it(db_session, org, worker, trainee, admin):
    approver, _ = worker
    submitter, _ = trainee
    admin_user, _ = admin
    _doc, _inst, sis, _step, _t = await _run(
        db_session, org, submitter, approver
    )

    detail = await ApprovalService(db_session).stage_instance_detail(
        sis[0].id, _as(admin_user, org, "admin")
    )
    assert detail.can_act is False
    assert detail.stage_name == "Stage 1"


async def test_another_org_gets_404(db_session, org, worker, trainee):
    """BR-12 org scoping, by the same 404."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, _inst, sis, _step, _t = await _run(
        db_session, org, submitter, approver
    )

    outsider = AuthUser(
        id=approver.id, email=approver.email, org_id=uuid.uuid4(),
        roles=["admin"], permissions=[],
    )
    with pytest.raises(NotFoundException):
        await ApprovalService(db_session).stage_instance_detail(
            sis[0].id, outsider
        )


# -- can_act, from stored state only ----------------------------------------

async def test_a_withdrawn_run_explains_itself(
    db_session, org, worker, trainee
):
    """UX-INT-01 — say why, rather than show a disabled button."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, instance, sis, _step, _t = await _run(
        db_session, org, submitter, approver
    )
    instance.status = WorkflowInstanceStatus.CANCELLED
    await db_session.flush()

    detail = await ApprovalService(db_session).stage_instance_detail(
        sis[0].id, _as(approver, org, "worker")
    )
    assert detail.can_act is False
    assert "withdrew" in detail.cannot_act_reason.lower()


async def test_a_blocked_stage_says_it_needs_an_admin(
    db_session, org, worker, trainee
):
    """AP-SLA-05 — the approver should not be left guessing."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, _inst, sis, _step, _t = await _run(
        db_session, org, submitter, approver
    )
    sis[0].status = "blocked"
    sis[0].blocked_reason = "the assigned approver is no longer active"
    await db_session.flush()

    detail = await ApprovalService(db_session).stage_instance_detail(
        sis[0].id, _as(approver, org, "worker")
    )
    assert detail.can_act is False
    assert "reassign" in detail.cannot_act_reason.lower()
    assert detail.urgency == "none", "a blocked stage's clock is paused"


async def test_an_already_decided_step_cannot_act_again(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    _doc, _inst, sis, step, _t = await _run(
        db_session, org, submitter, approver
    )
    step.decision = ApprovalDecision.APPROVED
    step.decided_at = datetime.now(timezone.utc)
    await db_session.flush()

    detail = await ApprovalService(db_session).stage_instance_detail(
        sis[0].id, _as(approver, org, "worker")
    )
    assert detail.can_act is False
    assert "already" in detail.cannot_act_reason.lower()


# -- History (AP-DET-02) ----------------------------------------------------

async def test_earlier_decisions_are_shown(db_session, org, worker, trainee, hr):
    """AP-DET-02 — an approver needs to see what was decided before them."""
    approver, _ = worker
    submitter, _ = trainee
    earlier, _ = hr
    _doc, instance, sis, _step, tmpl = await _run(
        db_session, org, submitter, approver
    )
    stage_two = sis[1]
    db_session.add(
        ApprovalStep(
            instance_id=instance.id, stage_id=stage_two.legacy_stage_id,
            document_version_id=_doc.current_version_id,
            approver_id=earlier.id, decision=ApprovalDecision.APPROVED,
            decision_note="Fine by me", decided_at=datetime.now(timezone.utc),
        )
    )
    await db_session.flush()

    detail = await ApprovalService(db_session).stage_instance_detail(
        sis[0].id, _as(approver, org, "worker")
    )
    assert len(detail.history) == 1
    entry = detail.history[0]
    assert entry.approver_name == earlier.name
    assert entry.decision == "approved"
    assert entry.note == "Fine by me"
    assert entry.is_counted is True


async def test_a_revoked_approval_is_shown_as_not_counting(
    db_session, org, worker, trainee, hr
):
    """Section 6.5 — kept for audit, but flagged. An approver deciding now
    has to know that an earlier approval no longer counts."""
    approver, _ = worker
    submitter, _ = trainee
    earlier, _ = hr
    _doc, instance, sis, _step, _t = await _run(
        db_session, org, submitter, approver
    )
    db_session.add(
        ApprovalStep(
            instance_id=instance.id, stage_id=sis[1].legacy_stage_id,
            document_version_id=_doc.current_version_id,
            approver_id=earlier.id, decision=ApprovalDecision.APPROVED,
            decided_at=datetime.now(timezone.utc),
            revoked_at=datetime.now(timezone.utc),
            revocation_reason="Approved the wrong version",
        )
    )
    await db_session.flush()

    detail = await ApprovalService(db_session).stage_instance_detail(
        sis[0].id, _as(approver, org, "worker")
    )
    assert len(detail.history) == 1
    assert detail.history[0].is_counted is False
