"""
Workflow module section 6.2 (AP-DSH-01..08). Task P2-18.

The queue downloaded every pending step and filtered the array in the
browser. With twelve rows that works; with twelve hundred it does not - the
search box searched only what had already arrived, "page 2" paged over data
the server had already sent in full, and the tab counts could not be
computed at all because the client held one tab's worth of rows.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.exceptions import UnprocessableEntityException
from app.domain.enums import ApprovalDecision, WorkflowInstanceStatus
from app.models.document import Document, DocumentType, DocumentVersion
from app.models.workflow import (
    ApprovalStep,
    WorkflowInstance,
    WorkflowStage,
    WorkflowTemplate,
)
from app.services.approval_service import ApprovalService


async def _step(
    db_session, org, submitter_id, approver_id, *,
    title="Doc", due_in_hours=None, decision="pending",
    run_status=WorkflowInstanceStatus.IN_PROGRESS, template=None,
    dept_id=None, submitted_ago_hours=1,
):
    """One approval step, with just enough around it to be listable."""
    dt = DocumentType(
        org_id=org.id, name="General", code=f"gen-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dt)
    await db_session.flush()
    doc = Document(
        org_id=org.id, doc_type_id=dt.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}", title=title,
        submitted_by=submitter_id, dept_id=dept_id,
    )
    db_session.add(doc)
    await db_session.flush()
    version = DocumentVersion(
        document_id=doc.id, version_num=1, title=title, uploaded_by=submitter_id
    )
    db_session.add(version)
    await db_session.flush()

    if template is None:
        template = WorkflowTemplate(
            org_id=org.id, name=f"T-{uuid.uuid4().hex[:4]}",
            created_by=submitter_id,
        )
        db_session.add(template)
        await db_session.flush()
    stage = WorkflowStage(
        template_id=template.id, sequence_order=1, name="Review Stage"
    )
    db_session.add(stage)
    await db_session.flush()

    instance = WorkflowInstance(
        org_id=org.id, document_id=doc.id, template_id=template.id,
        template_version_snapshot={"id": str(template.id), "stages": []},
        current_stage_id=stage.id, status=run_status,
        submitted_at=datetime.now(timezone.utc)
        - timedelta(hours=submitted_ago_hours),
    )
    db_session.add(instance)
    await db_session.flush()

    step = ApprovalStep(
        instance_id=instance.id, stage_id=stage.id,
        document_version_id=version.id, approver_id=approver_id,
        decision=decision,
        due_at=(
            datetime.now(timezone.utc) + timedelta(hours=due_in_hours)
            if due_in_hours is not None else None
        ),
        decided_at=(
            datetime.now(timezone.utc) if decision != "pending" else None
        ),
    )
    db_session.add(step)
    await db_session.flush()
    return doc, instance, step, template


# -- Filtering --------------------------------------------------------------

async def test_the_search_runs_on_the_server(db_session, org, worker, trainee):
    """AP-DSH-04 — it used to filter whatever had already been downloaded."""
    approver, _ = worker
    submitter, _ = trainee
    await _step(db_session, org, submitter.id, approver.id, title="Budget Plan")
    await _step(db_session, org, submitter.id, approver.id, title="Hiring Memo")

    svc = ApprovalService(db_session)
    page = await svc.approval_dashboard(approver.id, org.id, q="budget")

    assert page.total == 1
    assert [i.document_title for i in page.items] == ["Budget Plan"]


async def test_a_document_id_is_searchable(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    doc, _i, _s, _t = await _step(
        db_session, org, submitter.id, approver.id, title="Anything"
    )

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id, q=doc.public_id
    )
    assert page.total == 1


async def test_filtering_by_workflow(db_session, org, worker, trainee):
    """AP-DSH-05."""
    approver, _ = worker
    submitter, _ = trainee
    _d, _i, _s, first = await _step(
        db_session, org, submitter.id, approver.id, title="Via first"
    )
    await _step(db_session, org, submitter.id, approver.id, title="Via second")

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id, template_id=first.id
    )
    assert [i.document_title for i in page.items] == ["Via first"]


async def test_only_my_own_steps_are_listed(db_session, org, worker, trainee, hr):
    """Section 7.3 — somebody else's queue is not mine to see."""
    approver, _ = worker
    other, _ = hr
    submitter, _ = trainee
    await _step(db_session, org, submitter.id, approver.id, title="Mine")
    await _step(db_session, org, submitter.id, other.id, title="Theirs")

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id
    )
    assert [i.document_title for i in page.items] == ["Mine"]


# -- Tabs and counts --------------------------------------------------------

async def test_the_tab_counts_come_from_the_database(
    db_session, org, worker, trainee
):
    """AP-DSH-02 — impossible before: the client had one tab of rows."""
    approver, _ = worker
    submitter, _ = trainee
    await _step(db_session, org, submitter.id, approver.id, title="P1")
    await _step(db_session, org, submitter.id, approver.id, title="P2")
    await _step(
        db_session, org, submitter.id, approver.id, title="A1",
        decision="approved", run_status=WorkflowInstanceStatus.APPROVED,
    )
    await _step(
        db_session, org, submitter.id, approver.id, title="R1",
        decision="rejected", run_status=WorkflowInstanceStatus.REJECTED,
    )

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id
    )
    assert page.counts["pending"] == 2
    assert page.counts["approved"] == 1
    assert page.counts["rejected"] == 1
    assert page.counts["all"] == 4


async def test_the_counts_honour_the_active_filter(
    db_session, org, worker, trainee
):
    """A badge that promises rows the search then hides is worse than no
    badge."""
    approver, _ = worker
    submitter, _ = trainee
    await _step(db_session, org, submitter.id, approver.id, title="Budget Plan")
    await _step(db_session, org, submitter.id, approver.id, title="Hiring Memo")

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id, q="budget"
    )
    assert page.counts["pending"] == 1


async def test_an_unknown_tab_is_refused(db_session, org, worker):
    approver, _ = worker
    with pytest.raises(UnprocessableEntityException):
        await ApprovalService(db_session).approval_dashboard(
            approver.id, org.id, tab="whatever"
        )


async def test_an_unknown_sort_is_refused(db_session, org, worker):
    """Refused rather than silently ignored: a sort the server drops looks to
    the user like a broken column header."""
    approver, _ = worker
    with pytest.raises(UnprocessableEntityException):
        await ApprovalService(db_session).approval_dashboard(
            approver.id, org.id, sort="due_at; DROP TABLE"
        )


# -- Sorting and paging -----------------------------------------------------

async def test_pending_work_is_sorted_by_what_is_due_soonest(
    db_session, org, worker, trainee
):
    """AP-DSH-07."""
    approver, _ = worker
    submitter, _ = trainee
    await _step(
        db_session, org, submitter.id, approver.id, title="Later", due_in_hours=48
    )
    await _step(
        db_session, org, submitter.id, approver.id, title="Sooner", due_in_hours=2
    )
    await _step(db_session, org, submitter.id, approver.id, title="No deadline")

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id
    )
    assert [i.document_title for i in page.items] == [
        "Sooner", "Later", "No deadline",
    ], "a step with no deadline is not the most urgent thing on the list"


async def test_sorting_by_title(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    for t in ("Charlie", "Alpha", "Bravo"):
        await _step(db_session, org, submitter.id, approver.id, title=t)

    svc = ApprovalService(db_session)
    asc = await svc.approval_dashboard(approver.id, org.id, sort="title")
    assert [i.document_title for i in asc.items] == ["Alpha", "Bravo", "Charlie"]
    desc = await svc.approval_dashboard(approver.id, org.id, sort="-title")
    assert [i.document_title for i in desc.items] == ["Charlie", "Bravo", "Alpha"]


async def test_paging_is_done_in_the_database(db_session, org, worker, trainee):
    """AP-DSH-03 — `total` describes the whole set, `items` only this page."""
    approver, _ = worker
    submitter, _ = trainee
    for i in range(5):
        await _step(
            db_session, org, submitter.id, approver.id,
            title=f"Doc {i}", due_in_hours=i + 1,
        )

    svc = ApprovalService(db_session)
    first = await svc.approval_dashboard(approver.id, org.id, page=1, limit=2)
    assert len(first.items) == 2
    assert first.total == 5
    assert first.pages == 3

    second = await svc.approval_dashboard(approver.id, org.id, page=2, limit=2)
    assert len(second.items) == 2
    assert {i.id for i in first.items}.isdisjoint({i.id for i in second.items})

    last = await svc.approval_dashboard(approver.id, org.id, page=3, limit=2)
    assert len(last.items) == 1


# -- Urgency ----------------------------------------------------------------

async def test_urgency_is_decided_by_the_server(
    db_session, org, worker, trainee
):
    """AP-DSH-06 / BR-13 — the deadline is server-owned, so a browser with a
    skewed clock must not paint its own idea of overdue."""
    approver, _ = worker
    submitter, _ = trainee
    await _step(
        db_session, org, submitter.id, approver.id, title="Late",
        due_in_hours=-3,
    )
    await _step(
        db_session, org, submitter.id, approver.id, title="Soon",
        due_in_hours=6,
    )
    await _step(
        db_session, org, submitter.id, approver.id, title="Plenty",
        due_in_hours=96,
    )
    await _step(db_session, org, submitter.id, approver.id, title="Open-ended")

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id
    )
    by_title = {i.document_title: i.urgency for i in page.items}
    assert by_title == {
        "Late": "overdue",
        "Soon": "due_soon",
        "Plenty": "normal",
        "Open-ended": "none",
    }


async def test_a_decided_step_is_never_urgent(db_session, org, worker, trainee):
    """Its deadline is history — flagging it overdue would nag about work
    that is finished."""
    approver, _ = worker
    submitter, _ = trainee
    await _step(
        db_session, org, submitter.id, approver.id, title="Done late",
        due_in_hours=-10, decision=ApprovalDecision.APPROVED,
        run_status=WorkflowInstanceStatus.APPROVED,
    )

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id, tab="approved"
    )
    assert [i.urgency for i in page.items] == ["none"]


async def test_the_summary_strip_ignores_the_search_box(
    db_session, org, worker, trainee
):
    """AP-DSH-08 — the strip reports the workload, not the filter. One that
    changed as you typed would be telling you about your search."""
    approver, _ = worker
    submitter, _ = trainee
    await _step(
        db_session, org, submitter.id, approver.id, title="Budget Plan",
        due_in_hours=-2,
    )
    await _step(
        db_session, org, submitter.id, approver.id, title="Hiring Memo",
        due_in_hours=-5,
    )

    page = await ApprovalService(db_session).approval_dashboard(
        approver.id, org.id, q="budget"
    )
    assert page.total == 1, "the rows are filtered"
    assert page.summary.overdue == 2, "the strip is not"
    assert page.summary.pending == 2
