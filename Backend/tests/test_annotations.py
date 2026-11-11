"""
Workflow module section 6.5 (AP-ANN-01..09, AP-ANN-20), section 6.6
(AP-CHG-01..05), E11, E12, T8, T9, T27, T28. Tasks P3-6 and P3-9.

P3-6: an annotation is created as a draft, autosaved through PATCH, and is
its author's alone until published.

P3-9: Request Changes publishes the approver's drafts, records the decision
and stops the stage clock in ONE transaction. The guarantee that a conflict
never loses a draft is structural: publishing happens inside the decision's
transaction, so a refusal leaves every draft a draft.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnprocessableEntityException,
)
from app.domain.anchors import AnchorError, validate_anchor
from app.domain.enums import ApprovalDecision, WorkflowInstanceStatus
from app.domain.permissions import AuthUser
from app.models.annotation import Annotation
from app.models.workflow import StageInstance
from app.schemas.annotations import (
    AnnotationCreate,
    AnnotationRect,
    AnnotationUpdate,
)
from app.schemas.workflow_instances import CancelWorkflowRequest, DecisionRequest
from app.services.annotation_service import AnnotationService
from app.services.approval_service import ApprovalService
from app.services.workflow_service import WorkflowService
from test_signatures_and_revocation import _make_instance

RECT = AnnotationRect(x=0.1, y=0.2, w=0.3, h=0.04)


def _as(user, org, *roles) -> AuthUser:
    return AuthUser(
        id=user.id, email=user.email, org_id=org.id,
        roles=list(roles) or ["worker"], permissions=[],
    )


async def _review(db_session, org, submitter, approver):
    """A live run with `approver` on stage 1, and its stage instance."""
    doc, version, instance, stages, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=approver.id
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    si = StageInstance(
        org_id=org.id, instance_id=instance.id, legacy_stage_id=stages[0].id,
        cycle=instance.current_cycle or 1, position=1,
        stage_name=stages[0].name, status="active",
        resolved_approver_id=approver.id,
    )
    db_session.add(si)
    await db_session.flush()
    return doc, version, instance, step, si


def _create(version, *, text="Fix this clause", page=1):
    return AnnotationCreate(
        document_version_id=version.id, page_number=page, rects=[RECT],
        selected_text="the clause", comment_text=text,
    )


# -- Anchor validation ------------------------------------------------------

def test_a_normalized_anchor_is_accepted_and_cleaned():
    rects = validate_anchor(
        anchor_type="text", page_number=2,
        rects=[{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04, "junk": "dropped"}],
    )
    assert rects == [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}]


def test_pixel_coordinates_are_refused_by_name():
    """A client working in pixels would store fine and draw nowhere."""
    with pytest.raises(AnchorError) as exc:
        validate_anchor(
            anchor_type="text", page_number=1,
            rects=[{"x": 820.5, "y": 40, "w": 120, "h": 18}],
        )
    assert "pixels" in str(exc.value)


@pytest.mark.parametrize("rects", [
    [], None, [{"x": 0.1, "y": 0.1, "w": 0, "h": 0.1}], [{"x": 0.1}],
])
def test_an_undrawable_anchor_is_refused(rects):
    with pytest.raises(AnchorError):
        validate_anchor(anchor_type="text", page_number=1, rects=rects)


def test_a_rect_hanging_over_the_edge_is_trimmed():
    rects = validate_anchor(
        anchor_type="area", page_number=1,
        rects=[{"x": 0.9, "y": 0.9, "w": 0.105, "h": 0.105}],
    )
    assert rects[0]["x"] + rects[0]["w"] <= 1.0
    assert rects[0]["y"] + rects[0]["h"] <= 1.0


# -- P3-6: drafts ------------------------------------------------------------

async def test_an_annotation_is_always_created_as_a_draft(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, _i, _s, _si = await _review(db_session, org, submitter, approver)

    thread = await AnnotationService(db_session).create_draft(
        _create(version), _as(approver, org, "worker")
    )
    assert thread.status == "draft"
    assert thread.published_at is None


async def test_a_draft_survives_as_a_server_row(db_session, org, worker, trainee):
    """T28 / E12 — a refresh or a closed tab loses nothing, because the draft
    was on the server from the moment the highlight was drawn."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, _i, _s, _si = await _review(db_session, org, submitter, approver)
    svc = AnnotationService(db_session)
    actor = _as(approver, org, "worker")

    created = await svc.create_draft(_create(version, text=None), actor)
    await svc.update_draft(
        created.id, AnnotationUpdate(comment_text="Typed after anchoring"), actor
    )

    again = await svc.list_for_version(version.id, actor)
    assert [a.comment_text for a in again.annotations] == ["Typed after anchoring"]
    assert again.draft_count == 1


async def test_the_owner_cannot_see_or_count_a_draft(
    db_session, org, worker, trainee
):
    """AP-ANN-05."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, _i, _s, _si = await _review(db_session, org, submitter, approver)
    svc = AnnotationService(db_session)
    await svc.create_draft(_create(version), _as(approver, org, "worker"))

    owner_view = await svc.list_for_version(version.id, _as(submitter, org, "trainee"))
    assert owner_view.annotations == []
    assert owner_view.draft_count == 0


async def test_only_an_approver_on_the_run_may_annotate(
    db_session, org, worker, trainee
):
    """The owner answers comments with replies; they do not review their own
    document."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, _i, _s, _si = await _review(db_session, org, submitter, approver)

    with pytest.raises(ForbiddenException):
        await AnnotationService(db_session).create_draft(
            _create(version), _as(submitter, org, "trainee")
        )


async def test_a_bad_anchor_is_a_422(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, _i, _s, _si = await _review(db_session, org, submitter, approver)
    req = AnnotationCreate(
        document_version_id=version.id, page_number=1,
        rects=[AnnotationRect(x=900, y=10, w=50, h=10)],
    )
    with pytest.raises(UnprocessableEntityException):
        await AnnotationService(db_session).create_draft(
            req, _as(approver, org, "worker")
        )


async def test_a_discarded_draft_is_soft_deleted(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, _i, _s, _si = await _review(db_session, org, submitter, approver)
    svc = AnnotationService(db_session)
    actor = _as(approver, org, "worker")
    created = await svc.create_draft(_create(version), actor)

    await svc.delete_draft(created.id, actor)

    assert (await svc.list_for_version(version.id, actor)).annotations == []
    row = await db_session.get(Annotation, created.id)
    assert row is not None and row.deleted_at is not None


# -- P3-9: Request Changes ---------------------------------------------------

async def _request_changes(db_session, org, step, approver, note=None):
    return await ApprovalService(db_session).decide(
        step_id=step.id, actor_id=approver.id, org_id=org.id,
        req=DecisionRequest(
            decision=ApprovalDecision.CHANGES_REQUESTED, note=note
        ),
    )


async def test_requesting_changes_publishes_the_drafts_and_stops_the_clock(
    db_session, org, worker, trainee
):
    """T9 — one transaction."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, instance, step, si = await _review(
        db_session, org, submitter, approver
    )
    svc = AnnotationService(db_session)
    await svc.create_draft(_create(version), _as(approver, org, "worker"))

    await _request_changes(db_session, org, step, approver)

    owner_view = await svc.list_for_version(version.id, _as(submitter, org, "trainee"))
    assert [a.status for a in owner_view.annotations] == ["open"]
    assert owner_view.annotations[0].published_at is not None

    await db_session.refresh(instance)
    await db_session.refresh(si)
    assert instance.status == WorkflowInstanceStatus.CHANGES_REQUESTED
    assert si.status == "changes_requested"
    assert si.timer_paused_at is not None


async def test_a_change_request_with_nothing_to_change_is_refused(
    db_session, org, worker, trainee
):
    """AP-CHG-02 — no comment and no note leaves the owner nothing to act on."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, _version, instance, step, _si = await _review(
        db_session, org, submitter, approver
    )
    for note in (None, "", "   "):
        with pytest.raises(UnprocessableEntityException):
            await _request_changes(db_session, org, step, approver, note=note)
    await db_session.refresh(instance)
    assert instance.status == WorkflowInstanceStatus.IN_PROGRESS


async def test_an_overall_note_alone_is_enough(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    _doc, _version, instance, step, _si = await _review(
        db_session, org, submitter, approver
    )
    await _request_changes(
        db_session, org, step, approver, note="Section 2 needs reworking."
    )
    await db_session.refresh(instance)
    assert instance.status == WorkflowInstanceStatus.CHANGES_REQUESTED


async def test_a_withdrawal_mid_review_keeps_every_draft(
    db_session, org, worker, trainee
):
    """T27 / E8 / E11 / AP-CHG-04 — 409, and the drafts are still drafts."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, instance, step, _si = await _review(
        db_session, org, submitter, approver
    )
    svc = AnnotationService(db_session)
    actor = _as(approver, org, "worker")
    await svc.create_draft(_create(version), actor)

    await WorkflowService(db_session).cancel(
        org_id=org.id, instance_id=instance.id, requester_id=submitter.id,
        req=CancelWorkflowRequest(reason="Changed my mind"),
    )

    with pytest.raises(ConflictException):
        await _request_changes(db_session, org, step, approver)

    rows = (
        await db_session.execute(
            select(Annotation).where(Annotation.document_version_id == version.id)
        )
    ).scalars().all()
    assert [r.status for r in rows] == ["draft"], (
        "a refused change request must not publish or lose anything"
    )


async def test_only_the_deciding_approvers_drafts_are_published(
    db_session, org, worker, trainee, hr
):
    """A second reviewer's unfinished notes on the same version stay theirs."""
    approver, _ = worker
    submitter, _ = trainee
    other, _ = hr
    _doc, version, _instance, step, _si = await _review(
        db_session, org, submitter, approver
    )
    db_session.add(
        Annotation(
            org_id=org.id, document_version_id=version.id, author_id=other.id,
            anchor_type="text", page_number=1,
            rects=[{"x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}],
            comment_text="Someone else's unfinished note", status="draft",
        )
    )
    await db_session.flush()
    await AnnotationService(db_session).create_draft(
        _create(version, text="Mine"), _as(approver, org, "worker")
    )

    await _request_changes(db_session, org, step, approver)

    rows = (
        await db_session.execute(
            select(Annotation).where(Annotation.document_version_id == version.id)
        )
    ).scalars().all()
    by_author = {r.author_id: r.status for r in rows}
    assert by_author[approver.id] == "open"
    assert by_author[other.id] == "draft"


async def test_a_published_comment_can_no_longer_be_edited_or_discarded(
    db_session, org, worker, trainee
):
    """AP-ANN-09 / BR-09 — 409, because the author had every right to edit
    it until they published it themselves."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, _instance, step, _si = await _review(
        db_session, org, submitter, approver
    )
    svc = AnnotationService(db_session)
    actor = _as(approver, org, "worker")
    created = await svc.create_draft(_create(version), actor)
    await _request_changes(db_session, org, step, approver)

    with pytest.raises(ConflictException):
        await svc.update_draft(
            created.id, AnnotationUpdate(comment_text="Softened"), actor
        )
    with pytest.raises(ConflictException):
        await svc.delete_draft(created.id, actor)


async def test_an_anchor_with_no_text_is_dropped_not_published_empty(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    _doc, version, _instance, step, _si = await _review(
        db_session, org, submitter, approver
    )
    svc = AnnotationService(db_session)
    actor = _as(approver, org, "worker")
    await svc.create_draft(_create(version, text=None), actor)
    await svc.create_draft(_create(version, text="Real comment"), actor)

    await _request_changes(db_session, org, step, approver)

    owner_view = await svc.list_for_version(version.id, _as(submitter, org, "trainee"))
    assert [a.comment_text for a in owner_view.annotations] == ["Real comment"]


async def test_an_unknown_annotation_is_404(db_session, org, worker):
    approver, _ = worker
    with pytest.raises(NotFoundException):
        await AnnotationService(db_session).update_draft(
            uuid.uuid4(), AnnotationUpdate(comment_text="x"),
            _as(approver, org, "worker"),
        )
