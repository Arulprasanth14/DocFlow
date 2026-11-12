"""
Workflow module section 5.10 (WF-REV-01, 08, 10..15), section 6.5.2
(AP-ANN-22/23), BR-06, E16, E17, E30, T10, T11, T12, T31, T38.
Tasks P3-11, P3-12, P3-13, P3-14.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.core.exceptions import ConflictException, UnprocessableEntityException
from app.domain.enums import ApprovalDecision, WorkflowInstanceStatus
from app.domain.permissions import AuthUser
from app.domain.reanchor import relocate
from app.models.annotation import Annotation
from app.models.document import DocumentStatus, DocumentVersion
from app.models.outbox import OutboxEvent
from app.models.workflow import ApprovalStep, StageInstance
from app.schemas.workflow_instances import DecisionRequest, ReviseAndResumeRequest
from app.services.annotation_carryover import carry_over
from app.services.approval_service import ApprovalService
from app.services.workflow_service import WorkflowService
from test_signatures_and_revocation import _make_instance


# -- P3-13: the pure matcher -------------------------------------------------

PAGES = {
    1: "Introduction. The supplier shall deliver goods within thirty days.",
    2: "Payment terms. The buyer shall pay within sixty days of invoice.",
    3: "Termination. Either party may terminate with written notice.",
}


def test_text_found_on_the_same_page():
    hit = relocate(
        selected_text="deliver goods within thirty days",
        text_prefix="supplier shall", text_suffix="", original_page=1, pages=PAGES,
    )
    assert hit.found and hit.page_number == 1


def test_text_that_moved_to_a_nearby_page_is_followed():
    """E17 — an insertion earlier in the document pushes text a page later."""
    hit = relocate(
        selected_text="pay within sixty days of invoice",
        text_prefix="", text_suffix="", original_page=1, pages=PAGES,
    )
    assert hit.found and hit.page_number == 2


def test_reflowed_whitespace_and_case_still_match():
    hit = relocate(
        selected_text="Either   party may\nTERMINATE",
        text_prefix="", text_suffix="", original_page=3, pages=PAGES,
    )
    assert hit.found and hit.page_number == 3


def test_text_that_was_removed_is_reported_not_guessed():
    """AP-ANN-23 / E30 — "Location changed" beats a confident wrong highlight."""
    hit = relocate(
        selected_text="liquidated damages of five percent",
        text_prefix="", text_suffix="", original_page=2, pages=PAGES,
    )
    assert hit.found is False


def test_an_ambiguous_quote_is_not_trusted_without_context():
    pages = {1: "The fee is due on signing.", 2: "The fee is due on signing."}
    hit = relocate(
        selected_text="The fee is due on signing",
        text_prefix="", text_suffix="", original_page=1, pages=pages,
    )
    assert hit.found is False, "two occurrences: cannot say which was meant"


def test_context_disambiguates_a_repeated_quote():
    pages = {
        1: "First, the fee is due on signing. Then work begins.",
        2: "Finally the fee is due on signing again, for phase two.",
    }
    hit = relocate(
        selected_text="the fee is due on signing",
        text_prefix="Finally", text_suffix="again", original_page=1, pages=pages,
    )
    assert hit.found and hit.page_number == 2


def test_no_text_layer_means_not_found():
    assert relocate(
        selected_text="anything at all here", text_prefix=None, text_suffix=None,
        original_page=1, pages={},
    ).found is False


# -- helpers -----------------------------------------------------------------

def _as(user, org, *roles) -> AuthUser:
    return AuthUser(
        id=user.id, org_id=org.id,
        roles=list(roles) or ["worker"], permissions=[],
    )


async def _sent_back(db_session, org, submitter, approver, *, stages=2):
    """A run sent back at stage 1 with a note, plus v2 ready to resubmit."""
    doc, v1, instance, stage_rows, step = await _make_instance(
        db_session, org, submitter_id=submitter.id, approver_id=approver.id,
        stages=stages, checksum="hash-v1",
    )
    instance.status = WorkflowInstanceStatus.IN_PROGRESS
    doc.current_version_id = v1.id
    sis = []
    for i, st in enumerate(stage_rows, start=1):
        si = StageInstance(
            org_id=org.id, instance_id=instance.id, legacy_stage_id=st.id,
            cycle=instance.current_cycle or 1, position=i, stage_name=st.name,
            status="active" if i == 1 else "pending",
            resolved_approver_id=approver.id if i == 1 else None,
            due_within_hours=8,
        )
        db_session.add(si)
        sis.append(si)
    await db_session.flush()

    await ApprovalService(db_session).decide(
        step_id=step.id, actor_id=approver.id, org_id=org.id,
        req=DecisionRequest(
            decision=ApprovalDecision.CHANGES_REQUESTED, note="Please rework section 2.",
        ),
    )
    v2 = DocumentVersion(
        document_id=doc.id, version_num=2, title=doc.title,
        uploaded_by=submitter.id, checksum="hash-v2",
    )
    db_session.add(v2)
    await db_session.flush()
    await db_session.refresh(doc)
    await db_session.refresh(instance)
    return doc, v1, v2, instance, sis, step


async def _resume(db_session, org, doc, submitter, version, **kw):
    return await WorkflowService(db_session).resume(
        org_id=org.id, document_id=doc.id, requester_id=submitter.id,
        req=ReviseAndResumeRequest(new_version_id=version.id, **kw),
    )


# -- P3-11 --------------------------------------------------------------------

async def test_an_identical_revision_is_refused_until_confirmed(
    db_session, org, worker, trainee
):
    """WF-REV-11 / E16."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v1, v2, _i, _sis, _s = await _sent_back(db_session, org, submitter, approver)
    v2.checksum = "hash-v1"
    await db_session.flush()

    with pytest.raises(ConflictException) as exc:
        await _resume(db_session, org, doc, submitter, v2)
    assert "identical" in str(exc.value).lower()

    await _resume(db_session, org, doc, submitter, v2, confirm_identical=True)
    await db_session.refresh(doc)
    assert doc.status == DocumentStatus.PENDING


async def test_open_comments_must_be_acknowledged(db_session, org, worker, trainee):
    """WF-REV-10."""
    approver, _ = worker
    submitter, _ = trainee
    doc, v1, v2, _i, _sis, _s = await _sent_back(db_session, org, submitter, approver)
    db_session.add(
        Annotation(
            org_id=org.id, document_version_id=v1.id, author_id=approver.id,
            anchor_type="text", page_number=1,
            rects=[{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05}],
            comment_text="Fix this", status="open",
        )
    )
    await db_session.flush()

    with pytest.raises(UnprocessableEntityException):
        await _resume(db_session, org, doc, submitter, v2)
    await _resume(db_session, org, doc, submitter, v2, addressed_confirmed=True)


async def test_the_revision_is_recorded_as_a_revision(db_session, org, worker, trainee):
    """WF-REV-08."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v1, v2, _i, _sis, _s = await _sent_back(db_session, org, submitter, approver)
    await _resume(db_session, org, doc, submitter, v2)
    assert v2.reason == "revision"


# -- P3-12 --------------------------------------------------------------------

async def test_resubmission_returns_to_the_same_stage_and_approver(
    db_session, org, worker, trainee
):
    """BR-06 / WF-STG-23 / T11 / T12."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v1, v2, instance, sis, _s = await _sent_back(
        db_session, org, submitter, approver
    )
    stage_before = instance.current_stage_id

    await _resume(db_session, org, doc, submitter, v2)

    await db_session.refresh(instance)
    assert instance.current_stage_id == stage_before
    assert instance.status == WorkflowInstanceStatus.IN_PROGRESS
    await db_session.refresh(sis[0])
    assert sis[0].status == "active"
    assert sis[0].timer_paused_at is None
    assert sis[0].round_count == 2
    assert sis[0].due_at is not None, "a full new window (O-11)"
    await db_session.refresh(sis[1])
    assert sis[1].status == "pending", "later stages are untouched"

    live = (
        await db_session.execute(
            select(ApprovalStep).where(
                ApprovalStep.instance_id == instance.id,
                ApprovalStep.decision == "pending",
            )
        )
    ).scalars().all()
    assert [s.approver_id for s in live] == [approver.id]
    assert live[0].document_version_id == v2.id


async def test_a_departed_approver_blocks_the_resubmitted_stage(
    db_session, org, worker, trainee, admin
):
    """WF-REV-15 — blocked and reported, never handed on by guesswork."""
    approver, _ = worker
    submitter, _ = trainee
    _admin_user, _ = admin
    doc, _v1, v2, instance, sis, _s = await _sent_back(
        db_session, org, submitter, approver
    )
    approver.is_active = False
    await db_session.flush()

    await _resume(db_session, org, doc, submitter, v2)

    await db_session.refresh(sis[0])
    assert sis[0].status == "blocked"
    codes = [
        e.payload.get("code") for e in (
            await db_session.execute(select(OutboxEvent))
        ).scalars().all()
    ]
    assert "N12" in codes


# -- P3-13: carry-over ---------------------------------------------------------

async def _comment(db_session, org, version, author, **kw):
    ann = Annotation(
        org_id=org.id, document_version_id=version.id, author_id=author.id,
        anchor_type=kw.pop("anchor_type", "text"), page_number=kw.pop("page", 1),
        rects=[{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.05}],
        selected_text=kw.pop("selected", "deliver goods within thirty days"),
        comment_text="Tighten this", status=kw.pop("status", "open"), **kw,
    )
    db_session.add(ann)
    await db_session.flush()
    return ann


async def test_open_comments_are_copied_not_moved(db_session, org, worker, trainee):
    """T38 — the original stays on the version it was written on."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, v1, v2, _i, _sis, _s = await _sent_back(db_session, org, submitter, approver)
    src = await _comment(db_session, org, v1, approver)

    result = await carry_over(
        db_session, from_version_id=v1.id, to_version_id=v2.id, pages=PAGES,
    )
    assert result["carried"] == 1

    copy = (
        await db_session.execute(
            select(Annotation).where(Annotation.document_version_id == v2.id)
        )
    ).scalars().one()
    assert copy.carried_from_id == src.id
    assert copy.relocated is True
    await db_session.refresh(src)
    assert src.document_version_id == v1.id


async def test_a_vanished_anchor_is_carried_as_location_changed(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    _doc, v1, v2, _i, _sis, _s = await _sent_back(db_session, org, submitter, approver)
    await _comment(db_session, org, v1, approver, selected="text that was deleted entirely")

    await carry_over(db_session, from_version_id=v1.id, to_version_id=v2.id, pages=PAGES)
    copy = (
        await db_session.execute(
            select(Annotation).where(Annotation.document_version_id == v2.id)
        )
    ).scalars().one()
    assert copy.relocated is False


async def test_resolved_comments_and_drafts_are_not_carried(
    db_session, org, worker, trainee
):
    approver, _ = worker
    submitter, _ = trainee
    _doc, v1, v2, _i, _sis, _s = await _sent_back(db_session, org, submitter, approver)
    await _comment(db_session, org, v1, approver, status="resolved")
    await _comment(db_session, org, v1, approver, status="draft")

    result = await carry_over(
        db_session, from_version_id=v1.id, to_version_id=v2.id, pages=PAGES,
    )
    assert result["carried"] == 0


async def test_carry_over_is_idempotent(db_session, org, worker, trainee):
    """A retried task must not duplicate the thread."""
    approver, _ = worker
    submitter, _ = trainee
    _doc, v1, v2, _i, _sis, _s = await _sent_back(db_session, org, submitter, approver)
    await _comment(db_session, org, v1, approver)

    await carry_over(db_session, from_version_id=v1.id, to_version_id=v2.id, pages=PAGES)
    again = await carry_over(
        db_session, from_version_id=v1.id, to_version_id=v2.id, pages=PAGES,
    )
    assert again["carried"] == 0


# -- P3-14 --------------------------------------------------------------------

async def test_the_owner_sees_progress_and_the_lock(db_session, org, worker, trainee):
    """WF-REV-01, BR-15."""
    approver, _ = worker
    submitter, _ = trainee
    doc, _v1, v2, _i, _sis, _s = await _sent_back(db_session, org, submitter, approver)
    svc = ApprovalService(db_session)
    owner = _as(submitter, org, "trainee")

    sent_back = await svc.document_progress(doc.id, owner)
    assert [s.status for s in sent_back.stages] == ["changes_requested", "pending"]
    assert sent_back.locked is False, "with the owner, so they can revise it"

    await _resume(db_session, org, doc, submitter, v2)
    in_review = await svc.document_progress(doc.id, owner)
    assert in_review.stages[0].status == "active"
    assert in_review.stages[0].approver_name == approver.name
    assert in_review.stages[0].is_current is True
    assert in_review.locked is True and in_review.locked_reason


async def test_progress_for_an_unknown_document_is_404(db_session, org, trainee):
    from app.core.exceptions import NotFoundException

    submitter, _ = trainee
    with pytest.raises(NotFoundException):
        await ApprovalService(db_session).document_progress(
            uuid.uuid4(), _as(submitter, org, "trainee")
        )


# -- Review rounds (section 6.5.2, BR-06, WF-REV-08) ---------------------------

async def test_rounds_record_the_change_request_and_the_resubmission(
    db_session, org, worker, trainee
):
    from app.models.workflow import ReviewRound

    approver, _ = worker
    submitter, _ = trainee
    doc, v1, v2, _instance, sis, _s = await _sent_back(
        db_session, org, submitter, approver
    )

    rounds = (
        await db_session.execute(
            select(ReviewRound)
            .where(ReviewRound.stage_instance_id == sis[0].id)
            .order_by(ReviewRound.round_number)
        )
    ).scalars().all()
    assert [(r.round_number, r.outcome) for r in rounds] == [(1, "changes_requested")]
    assert rounds[0].document_version_id == v1.id
    assert rounds[0].closed_at is not None

    await _resume(db_session, org, doc, submitter, v2)

    rounds = (
        await db_session.execute(
            select(ReviewRound)
            .where(ReviewRound.stage_instance_id == sis[0].id)
            .order_by(ReviewRound.round_number)
        )
    ).scalars().all()
    assert [r.round_number for r in rounds] == [1, 2]
    assert rounds[1].document_version_id == v2.id
    assert rounds[1].closed_at is None, "round two is open until it is decided"
    assert v2.responds_to_round_id == rounds[0].id, (
        "the revision records the round it answers"
    )
