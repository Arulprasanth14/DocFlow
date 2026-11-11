"""
Workflow module section 5.9 (WF-SUB-06), section 6.8 (AP-REJ-04), BR-01,
BR-07, E18, T33. Task P2-12.

A rejection is terminal (BR-07): the run closes and is never reopened,
re-decided or edited. The owner's way forward is a NEW run from stage 1,
linked to the one it follows, with the rejected run left exactly as it was
and still fully visible.

BR-01 still holds across the two: a document may have only one live run, so
the previous one has to have ended before a new one can start.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
)
from app.domain.enums import WorkflowInstanceStatus
from app.models.document import Document, DocumentType, DocumentVersion
from app.models.workflow import (
    StageApproverRule,
    WorkflowInstance,
    WorkflowStage,
    WorkflowTemplate,
)
from app.services.workflow_service import WorkflowService


async def _template(db_session, org, owner_id, approver_id, name="Resubmit WF"):
    t = WorkflowTemplate(org_id=org.id, name=name, created_by=owner_id)
    db_session.add(t)
    await db_session.flush()
    st = WorkflowStage(template_id=t.id, sequence_order=1, name="Review Stage")
    db_session.add(st)
    await db_session.flush()
    db_session.add(
        StageApproverRule(
            stage_id=st.id, rule_type="specific_user",
            rule_value={"user_id": str(approver_id)},
        )
    )
    await db_session.flush()
    return t


async def _rejected_run(db_session, org, submitter, approver):
    dt = DocumentType(
        org_id=org.id, name="General", code=f"gen-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dt)
    await db_session.flush()
    doc = Document(
        org_id=org.id, doc_type_id=dt.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}", title="Budget Request",
        submitted_by=submitter.id,
    )
    db_session.add(doc)
    await db_session.flush()
    version = DocumentVersion(
        document_id=doc.id, version_num=1, title=doc.title,
        uploaded_by=submitter.id,
    )
    db_session.add(version)
    await db_session.flush()
    doc.current_version_id = version.id
    await db_session.flush()

    tmpl = await _template(db_session, org, submitter.id, approver.id)
    svc = WorkflowService(db_session)
    first = await svc.start_workflow(
        org_id=org.id, document_id=doc.id, template_id=tmpl.id,
        requester_id=submitter.id, current_version_id=version.id,
        doc_title=doc.title,
    )
    run = await db_session.get(WorkflowInstance, first.id)
    run.status = WorkflowInstanceStatus.REJECTED
    await db_session.flush()
    return doc, version, tmpl, run


async def test_a_rejected_document_can_start_a_new_run(
    db_session, org, worker, trainee
):
    """T33 / E18 — a second run, from stage 1, linked to the first."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v, _t, rejected = await _rejected_run(
        db_session, org, submitter, approver
    )

    new_run = await WorkflowService(db_session).submit_as_new(
        org_id=org.id, document_id=doc.id, requester_id=submitter.id,
    )

    assert new_run.id != rejected.id
    fresh = await db_session.get(WorkflowInstance, new_run.id)
    assert fresh.previous_run_id == rejected.id, (
        "the chain has to be recorded, or the two read as unrelated "
        "submissions"
    )
    assert fresh.status not in (
        WorkflowInstanceStatus.REJECTED, WorkflowInstanceStatus.CANCELLED,
    )

    runs = (
        await db_session.execute(
            select(WorkflowInstance).where(WorkflowInstance.document_id == doc.id)
        )
    ).scalars().all()
    assert len(runs) == 2


async def test_the_rejected_run_is_left_untouched(
    db_session, org, worker, trainee
):
    """BR-07 / BR-09 — terminal means terminal. The old run keeps its status
    and its decisions; nothing is reopened or rewritten."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v, _t, rejected = await _rejected_run(
        db_session, org, submitter, approver
    )
    before_status = rejected.status
    before_template = rejected.template_id

    await WorkflowService(db_session).submit_as_new(
        org_id=org.id, document_id=doc.id, requester_id=submitter.id,
    )

    await db_session.refresh(rejected)
    assert rejected.status == before_status
    assert rejected.template_id == before_template
    assert rejected.previous_run_id is None


async def test_a_different_workflow_can_be_chosen(
    db_session, org, worker, trainee, hr
):
    """Often the answer to a rejection is a different route, not the same
    one again."""
    approver, _ = worker
    submitter, _ = trainee
    other_approver, _ = hr
    doc, _v, first_tmpl, _rejected = await _rejected_run(
        db_session, org, submitter, approver
    )
    other = await _template(
        db_session, org, submitter.id, other_approver.id, name="Other WF"
    )

    new_run = await WorkflowService(db_session).submit_as_new(
        org_id=org.id, document_id=doc.id, requester_id=submitter.id,
        template_id=other.id,
    )
    fresh = await db_session.get(WorkflowInstance, new_run.id)
    assert fresh.template_id == other.id
    assert fresh.template_id != first_tmpl.id


async def test_a_live_run_blocks_a_second_one(db_session, org, worker, trainee):
    """BR-01 / X-INT-06 — one live run per document. Two would mean two sets
    of approvers deciding on the same document."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v, _t, run = await _rejected_run(db_session, org, submitter, approver)
    run.status = WorkflowInstanceStatus.IN_PROGRESS
    await db_session.flush()

    with pytest.raises(ConflictException) as exc:
        await WorkflowService(db_session).submit_as_new(
            org_id=org.id, document_id=doc.id, requester_id=submitter.id,
        )
    assert "withdraw" in str(exc.value).lower()


async def test_a_withdrawn_document_is_not_a_dead_end(
    db_session, org, worker, trainee
):
    """Withdrawal sets the document to CANCELLED, which the ordinary submit
    path refuses — so without this the owner could never resubmit."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v, _t, run = await _rejected_run(db_session, org, submitter, approver)
    run.status = WorkflowInstanceStatus.CANCELLED
    await db_session.flush()

    new_run = await WorkflowService(db_session).submit_as_new(
        org_id=org.id, document_id=doc.id, requester_id=submitter.id,
    )
    fresh = await db_session.get(WorkflowInstance, new_run.id)
    assert fresh.previous_run_id == run.id


async def test_only_the_owner_can_resubmit(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    doc, _v, _t, _run = await _rejected_run(
        db_session, org, submitter, approver
    )

    with pytest.raises(ForbiddenException):
        await WorkflowService(db_session).submit_as_new(
            org_id=org.id, document_id=doc.id, requester_id=approver.id,
        )


async def test_a_never_submitted_document_is_refused(
    db_session, org, trainee
):
    """There is nothing to follow on from — the normal submit path applies."""
    submitter, _ = trainee
    dt = DocumentType(
        org_id=org.id, name="General", code=f"gen-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dt)
    await db_session.flush()
    doc = Document(
        org_id=org.id, doc_type_id=dt.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}", title="Fresh",
        submitted_by=submitter.id,
    )
    db_session.add(doc)
    await db_session.flush()

    with pytest.raises(ConflictException) as exc:
        await WorkflowService(db_session).submit_as_new(
            org_id=org.id, document_id=doc.id, requester_id=submitter.id,
        )
    assert "not been submitted" in str(exc.value).lower()


async def test_an_unknown_document_is_404(db_session, org, trainee):
    submitter, _ = trainee
    with pytest.raises(NotFoundException):
        await WorkflowService(db_session).submit_as_new(
            org_id=org.id, document_id=uuid.uuid4(), requester_id=submitter.id,
        )
