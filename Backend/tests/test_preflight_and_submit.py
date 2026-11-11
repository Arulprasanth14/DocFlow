"""
Workflow module §5.9 (WF-SUB-02), §5.5 (WF-STG-23/24), §4.5 (BR-05), E1.
Tasks P2-4 and P2-5.

Two rules:

  * A stage whose approver cannot be resolved for THIS submitter must stop
    the submission. The static check in `document_validation.py` inspects the
    approver RULES, so it passes a `manager_of_requester` rule and cannot
    know that this particular submitter has no manager. The run was created
    anyway with no ApprovalStep rows: the document sat in PENDING, nobody was
    notified, and nobody could act on it.

  * "Submitter's manager" means the submitter's manager — `users.manager_id`,
    with the department head only as a FALLBACK (decision D1). It previously
    resolved to the department head always, which is a different person
    (defect 3), and it must never resolve to the submitter themselves, since
    that would manufacture a self-approval (BR-05).
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.core.exceptions import UnprocessableEntityException
from app.models.document import Document, DocumentType, DocumentVersion
from app.models.organization import Department
from app.models.workflow import (
    StageApproverRule,
    WorkflowInstance,
    WorkflowStage,
    WorkflowTemplate,
)
from app.services.workflow_service import WorkflowService


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


async def _manager_template(db_session, org, owner_id):
    t = WorkflowTemplate(org_id=org.id, name="Manager WF", created_by=owner_id)
    db_session.add(t)
    await db_session.flush()
    st = WorkflowStage(template_id=t.id, sequence_order=1, name="Manager Review")
    db_session.add(st)
    await db_session.flush()
    db_session.add(
        StageApproverRule(
            stage_id=st.id, rule_type="manager_of_requester", rule_value={}
        )
    )
    await db_session.flush()
    return t, st


async def test_submit_is_refused_when_the_manager_stage_cannot_resolve(
    db_session, org, worker
):
    """E1 / WF-STG-24 — and critically, NO run is created."""
    submitter, _ = worker
    assert submitter.manager_id is None

    tmpl, _stage = await _manager_template(db_session, org, submitter.id)
    doc, version = await _doc(db_session, org, submitter.id)

    svc = WorkflowService(db_session)
    with pytest.raises(UnprocessableEntityException) as exc:
        await svc.start_workflow(
            org_id=org.id, document_id=doc.id, template_id=tmpl.id,
            requester_id=submitter.id, current_version_id=version.id,
            doc_title=doc.title,
        )
    assert "manager" in str(exc.value).lower()

    runs = (
        await db_session.execute(
            select(WorkflowInstance).where(WorkflowInstance.document_id == doc.id)
        )
    ).scalars().all()
    assert runs == [], "a submission that cannot be routed must not create a run"


async def test_manager_id_is_preferred_over_the_department_head(
    db_session, org, worker, admin, hr
):
    """D1 — the manager line wins; the department head is only a fallback."""
    submitter, _ = worker
    real_manager, _ = admin
    dept_head, _ = hr

    dept = Department(
        org_id=org.id, name=f"Ops-{uuid.uuid4().hex[:4]}",
        code=f"ops-{uuid.uuid4().hex[:4]}", head_user_id=dept_head.id,
    )
    db_session.add(dept)
    await db_session.flush()

    submitter.department_id = dept.id
    submitter.manager_id = real_manager.id
    await db_session.flush()

    _tmpl, stage = await _manager_template(db_session, org, submitter.id)

    # approver_rules is lazy="noload", so the stage must be loaded the way
    # the service loads it (selectinload via the repository) or the rules
    # come back empty and the resolver sees no rules at all.
    svc = WorkflowService(db_session)
    stage = (await svc.stage_repo.list_by_ids([stage.id]))[0]
    resolved = await svc._resolve_approvers(stage, submitter.id, org.id)
    assert resolved == [real_manager.id], (
        "manager_id must win over the department head"
    )


async def test_department_head_is_used_when_no_manager_is_set(
    db_session, org, worker, hr
):
    submitter, _ = worker
    dept_head, _ = hr

    dept = Department(
        org_id=org.id, name=f"Ops-{uuid.uuid4().hex[:4]}",
        code=f"ops-{uuid.uuid4().hex[:4]}", head_user_id=dept_head.id,
    )
    db_session.add(dept)
    await db_session.flush()
    submitter.department_id = dept.id
    submitter.manager_id = None
    await db_session.flush()

    _tmpl, stage = await _manager_template(db_session, org, submitter.id)

    # approver_rules is lazy="noload", so the stage must be loaded the way
    # the service loads it (selectinload via the repository) or the rules
    # come back empty and the resolver sees no rules at all.
    svc = WorkflowService(db_session)
    stage = (await svc.stage_repo.list_by_ids([stage.id]))[0]
    assert await svc._resolve_approvers(stage, submitter.id, org.id) == [
        dept_head.id
    ]


async def test_a_department_head_submitting_does_not_approve_their_own_document(
    db_session, org, worker
):
    """BR-05 — the head of their own department must not resolve to
    themselves. Resolving to nobody is correct here: the submission is then
    refused with something the submitter can act on, rather than creating a
    self-approval."""
    submitter, _ = worker

    dept = Department(
        org_id=org.id, name=f"Ops-{uuid.uuid4().hex[:4]}",
        code=f"ops-{uuid.uuid4().hex[:4]}", head_user_id=submitter.id,
    )
    db_session.add(dept)
    await db_session.flush()
    submitter.department_id = dept.id
    submitter.manager_id = None
    await db_session.flush()

    _tmpl, stage = await _manager_template(db_session, org, submitter.id)

    # approver_rules is lazy="noload", so the stage must be loaded the way
    # the service loads it (selectinload via the repository) or the rules
    # come back empty and the resolver sees no rules at all.
    svc = WorkflowService(db_session)
    stage = (await svc.stage_repo.list_by_ids([stage.id]))[0]
    assert await svc._resolve_approvers(stage, submitter.id, org.id) == []
