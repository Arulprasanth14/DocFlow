"""
Workflow module section 5.9 (WF-SUB-02), section 5.8 (WF-SEL-06), E1, E2,
T19, T20. Tasks P2-5 and P2-21.

WF-SUB-02 is specific: preflight runs when the workflow is SELECTED and
again inside the submit transaction, "because the first can go stale". That
only holds if both run the same rules, so what these tests really pin down
is that the selection-time answer and the submit-time answer are one rule -
two copies would be two verdicts, and the one the user is shown would be the
one that is wrong.
"""
from __future__ import annotations

import uuid

import pytest

from app.core.exceptions import UnprocessableEntityException
from app.models.document import Document, DocumentType, DocumentVersion
from app.models.organization import Department
from app.models.workflow import (
    StageApproverRule,
    WorkflowStage,
    WorkflowTemplate,
)
from app.services.workflow_service import WorkflowService


async def _template(db_session, org, owner_id, *, rules, names=None):
    t = WorkflowTemplate(org_id=org.id, name="Preflight WF", created_by=owner_id)
    db_session.add(t)
    await db_session.flush()
    names = names or [f"Stage {i + 1}" for i in range(len(rules))]
    for position, (name, rule) in enumerate(zip(names, rules), start=1):
        st = WorkflowStage(
            template_id=t.id, sequence_order=position, name=name,
            sla_hours=24,
        )
        db_session.add(st)
        await db_session.flush()
        if rule is not None:
            db_session.add(
                StageApproverRule(
                    stage_id=st.id, rule_type=rule[0], rule_value=rule[1],
                )
            )
    await db_session.flush()
    return t


async def _doc(db_session, org, submitter_id):
    dt = DocumentType(
        org_id=org.id, name="General", code=f"gen-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dt)
    await db_session.flush()
    d = Document(
        org_id=org.id, doc_type_id=dt.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}", title="Doc",
        submitted_by=submitter_id,
    )
    db_session.add(d)
    await db_session.flush()
    v = DocumentVersion(
        document_id=d.id, version_num=1, title=d.title, uploaded_by=submitter_id
    )
    db_session.add(v)
    await db_session.flush()
    return d, v


async def test_preflight_names_the_resolved_approvers(
    db_session, org, worker, trainee
):
    """WF-SEL-06 — the submitter sees who will actually approve, not the rule."""
    approver, _ = worker
    submitter, _ = trainee
    tmpl = await _template(
        db_session, org, submitter.id,
        rules=[("specific_user", {"user_id": str(approver.id)})],
        names=["Line Review"],
    )

    report = await WorkflowService(db_session).preflight(
        template_id=tmpl.id, requester_id=submitter.id, org_id=org.id,
    )

    assert report.can_submit is True
    assert report.blockers == []
    assert len(report.stages) == 1
    stage = report.stages[0]
    assert stage.position == 1
    assert stage.name == "Line Review"
    assert stage.approver_ids == [approver.id]
    assert approver.name in stage.approver_summary
    assert stage.sla_hours == 24


async def test_an_unresolvable_manager_stage_blocks_and_says_which(
    db_session, org, worker, trainee
):
    """E1 / WF-STG-24 — the static rules check cannot catch this: the rule is
    valid, it is THIS submitter who has no manager."""
    approver, _ = worker
    submitter, _ = trainee
    assert submitter.manager_id is None
    tmpl = await _template(
        db_session, org, submitter.id,
        rules=[
            ("specific_user", {"user_id": str(approver.id)}),
            ("manager_of_requester", {}),
        ],
        names=["First Pass", "Manager Sign-off"],
    )

    report = await WorkflowService(db_session).preflight(
        template_id=tmpl.id, requester_id=submitter.id, org_id=org.id,
    )

    assert report.can_submit is False
    assert len(report.blockers) == 1
    assert "manager" in report.blockers[0].lower()
    # The offending stage carries the reason, so the UI can mark that stage
    # rather than print one message for the whole workflow.
    first, second = report.stages
    assert first.blocker is None
    assert second.blocker is not None
    assert "Manager Sign-off" in second.blocker


async def test_the_submit_transaction_reaches_the_same_verdict(
    db_session, org, worker, trainee
):
    """WF-SUB-02 — one rule, not two that can disagree."""
    approver, _ = worker
    submitter, _ = trainee
    tmpl = await _template(
        db_session, org, submitter.id,
        rules=[("manager_of_requester", {})], names=["Manager Sign-off"],
    )
    doc, version = await _doc(db_session, org, submitter.id)

    svc = WorkflowService(db_session)
    report = await svc.preflight(
        template_id=tmpl.id, requester_id=submitter.id, org_id=org.id,
    )
    assert report.can_submit is False

    with pytest.raises(UnprocessableEntityException) as exc:
        await svc.start_workflow(
            org_id=org.id, document_id=doc.id, template_id=tmpl.id,
            requester_id=submitter.id, current_version_id=version.id,
            doc_title=doc.title,
        )
    # The same sentence the selection step showed.
    assert report.blockers[0] in str(exc.value)


async def test_preflight_is_per_person(db_session, org, worker, trainee, admin):
    """The same workflow can be submittable by one person and not another -
    that is the whole reason this is not a property of the template."""
    approver, _ = worker
    blocked_user, _ = trainee
    manager, _ = admin

    dept = Department(
        org_id=org.id, name=f"Ops-{uuid.uuid4().hex[:4]}",
        code=f"ops-{uuid.uuid4().hex[:4]}", head_user_id=manager.id,
    )
    db_session.add(dept)
    await db_session.flush()
    approver.department_id = dept.id
    await db_session.flush()

    tmpl = await _template(
        db_session, org, approver.id,
        rules=[("manager_of_requester", {})], names=["Manager Sign-off"],
    )

    svc = WorkflowService(db_session)
    # The worker's department has a head, so their manager stage resolves.
    ok = await svc.preflight(
        template_id=tmpl.id, requester_id=approver.id, org_id=org.id,
    )
    assert ok.can_submit is True
    assert ok.stages[0].approver_ids == [manager.id]

    # The trainee is in no department and has no manager, so it does not.
    not_ok = await svc.preflight(
        template_id=tmpl.id, requester_id=blocked_user.id, org_id=org.id,
    )
    assert not_ok.can_submit is False


async def test_a_signing_requirement_is_reported_up_front(
    db_session, org, worker, trainee
):
    """WF-STG-21 — when signing is forced on by the RESOLVED approver's
    department, the submitter should learn it here, not have it appear out of
    nowhere at the approval screen."""
    approver, _ = worker
    submitter, _ = trainee

    finance = Department(
        org_id=org.id, name=f"Finance-{uuid.uuid4().hex[:4]}",
        code=f"fin-{uuid.uuid4().hex[:4]}", requires_signature=True,
    )
    db_session.add(finance)
    await db_session.flush()
    approver.department_id = finance.id
    await db_session.flush()

    tmpl = await _template(
        db_session, org, submitter.id,
        rules=[("specific_user", {"user_id": str(approver.id)})],
        names=["Finance Review"],
    )

    report = await WorkflowService(db_session).preflight(
        template_id=tmpl.id, requester_id=submitter.id, org_id=org.id,
    )
    stage = report.stages[0]
    assert stage.requires_signature is True
    assert "department" in (stage.signing_reason or "").lower()


async def test_a_workflow_with_no_stages_cannot_be_submitted(
    db_session, org, trainee
):
    submitter, _ = trainee
    tmpl = WorkflowTemplate(
        org_id=org.id, name="Empty WF", created_by=submitter.id
    )
    db_session.add(tmpl)
    await db_session.flush()

    report = await WorkflowService(db_session).preflight(
        template_id=tmpl.id, requester_id=submitter.id, org_id=org.id,
    )
    assert report.can_submit is False
    assert any("no stages" in b for b in report.blockers)


async def test_an_inactive_workflow_cannot_be_submitted(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    tmpl = await _template(
        db_session, org, submitter.id,
        rules=[("specific_user", {"user_id": str(approver.id)})],
    )
    tmpl.is_active = False
    await db_session.flush()

    report = await WorkflowService(db_session).preflight(
        template_id=tmpl.id, requester_id=submitter.id, org_id=org.id,
    )
    assert report.can_submit is False
    assert any("not active" in b for b in report.blockers)
