"""
Workflow module section 5.10 (WF-REV-03..06), N15, T9. Task P3-10.

The owner's side of the review loop: read the approver's comments grouped by
page, reply, mark each one addressed, and see earlier rounds as history.

Three rules carry most of the weight, and each has a test that fails loudly
if it regresses:

  * a **draft** is invisible to everyone but its author (AP-ANN-05);
  * a published comment is **never edited** - only replied to, and its status
    changed (AP-ANN-09, BR-09); and
  * the owner marks "addressed", but **only the approver marks "resolved"** -
    letting the owner resolve would be approving their own corrections.

Note on scope: the approver side that CREATES and publishes annotations is
P3-6 and P3-9, which are not built yet, so these tests insert published
annotations directly. In the running application the owner's panel stays
empty until the Request Changes transaction lands.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.exceptions import (
    ConflictException,
    ForbiddenException,
    NotFoundException,
    UnprocessableEntityException,
)
from app.domain.permissions import AuthUser
from app.models.annotation import Annotation, AnnotationReply
from app.models.document import Document, DocumentType, DocumentVersion
from app.models.outbox import OutboxEvent
from app.services.annotation_service import AnnotationService


def _as(user, org, *roles) -> AuthUser:
    return AuthUser(
        id=user.id, org_id=org.id, roles=list(roles) or ["worker"],
        permissions=[],
    )


async def _run_with_approver(db_session, org, doc, version, approver):
    """Give the document a run with `approver` on a stage.

    Not decoration: `can_user_access_document` (narrowed in P2-20) only lets
    an approver read a document under review if they are actually an approver
    on its run. A comment author with no run would legitimately be refused —
    which is correct behaviour, and means a fixture without a run is not a
    realistic setup for testing the approver's side.
    """
    from app.models.workflow import (
        ApprovalStep,
        WorkflowInstance,
        WorkflowStage,
        WorkflowTemplate,
    )

    tmpl = WorkflowTemplate(
        org_id=org.id, name=f"T-{uuid.uuid4().hex[:4]}", created_by=doc.submitted_by
    )
    db_session.add(tmpl)
    await db_session.flush()
    stage = WorkflowStage(template_id=tmpl.id, sequence_order=1, name="Review")
    db_session.add(stage)
    await db_session.flush()
    instance = WorkflowInstance(
        org_id=org.id, document_id=doc.id, template_id=tmpl.id,
        template_version_snapshot={"id": str(tmpl.id), "stages": []},
        current_stage_id=stage.id, status="changes_requested",
    )
    db_session.add(instance)
    await db_session.flush()
    db_session.add(
        ApprovalStep(
            instance_id=instance.id, stage_id=stage.id,
            document_version_id=version.id, approver_id=approver.id,
            decision="changes_requested",
        )
    )
    await db_session.flush()
    return instance


async def _doc_with_versions(db_session, org, owner, *, versions=1):
    dt = DocumentType(
        org_id=org.id, name="General", code=f"gen-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dt)
    await db_session.flush()
    doc = Document(
        org_id=org.id, doc_type_id=dt.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}", title="Policy Update",
        submitted_by=owner.id,
    )
    db_session.add(doc)
    await db_session.flush()
    rows = []
    for n in range(1, versions + 1):
        v = DocumentVersion(
            document_id=doc.id, version_num=n, title=doc.title,
            uploaded_by=owner.id,
        )
        db_session.add(v)
        rows.append(v)
    await db_session.flush()
    doc.current_version_id = rows[-1].id
    await db_session.flush()
    return doc, rows


async def _annotation(
    db_session, org, version, author, *, page=1, status="open",
    text="Fix this clause", created_offset=0,
):
    ann = Annotation(
        org_id=org.id,
        document_version_id=version.id,
        author_id=author.id,
        anchor_type="text",
        page_number=page,
        rects=[{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}],
        selected_text="the clause in question",
        comment_text=text,
        status=status,
        published_at=(
            None if status == "draft"
            else datetime.now(timezone.utc) + timedelta(seconds=created_offset)
        ),
    )
    db_session.add(ann)
    await db_session.flush()
    return ann


# -- Reading (WF-REV-03, WF-REV-04) -----------------------------------------

async def test_the_owner_sees_published_comments_grouped_by_page(
    db_session, org, trainee, worker
):
    """WF-REV-04 — grouped by page, because that is how the work gets done."""
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _annotation(db_session, org, versions[0], approver, page=3, text="Third")
    await _annotation(db_session, org, versions[0], approver, page=1, text="First")
    await _annotation(db_session, org, versions[0], approver, page=1, text="Also first")

    feedback = await AnnotationService(db_session).document_feedback(
        doc.id, _as(owner, org, "trainee")
    )

    assert feedback.total_count == 3
    assert feedback.open_count == 3
    assert len(feedback.versions) == 1
    pages = feedback.versions[0].pages
    assert [p.page_number for p in pages] == [1, 3]
    assert len(pages[0].comments) == 2
    assert pages[0].comments[0].author_name == approver.name


async def test_a_draft_is_never_shown_to_the_owner(
    db_session, org, trainee, worker
):
    """AP-ANN-05 — the one that matters most.

    An approver annotates while deciding and publishes the set when they
    request changes. A draft reaching the owner would show them half-formed
    criticism the approver had not chosen to send, and might never send.
    """
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _annotation(db_session, org, versions[0], approver, text="Published")
    await _annotation(
        db_session, org, versions[0], approver, status="draft",
        text="Half-formed thought I never sent",
    )

    feedback = await AnnotationService(db_session).document_feedback(
        doc.id, _as(owner, org, "trainee")
    )
    assert feedback.total_count == 1
    bodies = [
        c.comment_text
        for v in feedback.versions for p in v.pages for c in p.comments
    ]
    assert bodies == ["Published"]


async def test_a_draft_is_not_even_shown_to_an_admin(
    db_session, org, trainee, worker, admin
):
    """Not a permission question — an unpublished draft is nobody's business
    but its author's."""
    owner, _ = trainee
    approver, _ = worker
    admin_user, _ = admin
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _annotation(db_session, org, versions[0], approver, status="draft")

    feedback = await AnnotationService(db_session).document_feedback(
        doc.id, _as(admin_user, org, "admin")
    )
    assert feedback.total_count == 0


async def test_earlier_versions_are_history_not_current(
    db_session, org, trainee, worker
):
    """WF-REV-12 — the owner needs v1's comments while revising v2, but they
    are not actionable any more."""
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner, versions=2)
    await _annotation(db_session, org, versions[0], approver, text="On v1")
    await _annotation(db_session, org, versions[1], approver, text="On v2")

    feedback = await AnnotationService(db_session).document_feedback(
        doc.id, _as(owner, org, "trainee")
    )
    # Newest version first.
    assert [v.version_num for v in feedback.versions] == [2, 1]
    assert feedback.versions[0].is_current is True
    assert feedback.versions[1].is_current is False


async def test_an_unrelated_user_gets_404(db_session, org, trainee, hr):
    """Section 9.4 / E28 — the same 404 the rest of the module gives."""
    owner, _ = trainee
    stranger, _ = hr
    doc, _versions = await _doc_with_versions(db_session, org, owner)

    svc = AnnotationService(db_session)
    with pytest.raises(NotFoundException) as real:
        await svc.document_feedback(doc.id, _as(stranger, org, "worker"))
    with pytest.raises(NotFoundException) as fake:
        await svc.document_feedback(uuid.uuid4(), _as(stranger, org, "worker"))
    assert str(real.value) == str(fake.value)


async def test_a_document_with_no_comments_is_an_empty_answer(
    db_session, org, trainee
):
    """Not an error — plenty of documents come back with nothing on them."""
    owner, _ = trainee
    doc, _versions = await _doc_with_versions(db_session, org, owner)

    feedback = await AnnotationService(db_session).document_feedback(
        doc.id, _as(owner, org, "trainee")
    )
    assert feedback.versions == []
    assert feedback.total_count == 0


# -- Replying (WF-REV-05, N15) ----------------------------------------------

async def test_the_owner_can_reply_and_the_approver_is_notified(
    db_session, org, trainee, worker
):
    """N15."""
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    ann = await _annotation(db_session, org, versions[0], approver)

    reply = await AnnotationService(db_session).add_reply(
        ann.id, _as(owner, org, "trainee"), "Reworded as asked, see page 1.",
    )
    assert reply.body == "Reworded as asked, see page 1."
    assert reply.author_id == owner.id

    events = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    n15 = [e for e in events if e.payload.get("code") == "N15"]
    assert len(n15) == 1
    assert n15[0].payload["user_ids"] == [str(approver.id)]


async def test_a_replier_is_never_notified_of_their_own_reply(
    db_session, org, trainee, worker
):
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _run_with_approver(db_session, org, doc, versions[0], approver)
    ann = await _annotation(db_session, org, versions[0], approver)

    await AnnotationService(db_session).add_reply(
        ann.id, _as(approver, org, "worker"), "Checking back in on this.",
    )
    events = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    recipients = {u for e in events for u in e.payload.get("user_ids", [])}
    assert str(approver.id) not in recipients
    assert str(owner.id) in recipients


async def test_every_reply_notifies_not_just_the_first(
    db_session, org, trainee, worker
):
    """The dedupe key is the REPLY's id. Keyed on the annotation or the run,
    every reply after the first would be deduped out of existence."""
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    ann = await _annotation(db_session, org, versions[0], approver)

    svc = AnnotationService(db_session)
    await svc.add_reply(ann.id, _as(owner, org, "trainee"), "First answer.")
    await svc.add_reply(ann.id, _as(owner, org, "trainee"), "Second answer.")

    events = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    n15 = [e for e in events if e.payload.get("code") == "N15"]
    assert len(n15) == 2
    assert len({e.dedupe_key for e in n15}) == 2


async def test_a_blank_reply_is_refused(db_session, org, trainee, worker):
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    ann = await _annotation(db_session, org, versions[0], approver)

    svc = AnnotationService(db_session)
    for blank in ("", "   ", "\n\t "):
        with pytest.raises(UnprocessableEntityException):
            await svc.add_reply(ann.id, _as(owner, org, "trainee"), blank)


async def test_a_draft_cannot_be_replied_to(db_session, org, trainee, worker):
    """Its author is the only person who can see it, and there is no
    counterparty yet."""
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _run_with_approver(db_session, org, doc, versions[0], approver)
    ann = await _annotation(db_session, org, versions[0], approver, status="draft")

    svc = AnnotationService(db_session)
    # The owner cannot even see it.
    with pytest.raises(NotFoundException):
        await svc.add_reply(ann.id, _as(owner, org, "trainee"), "Replying")
    # Its author can see it, but there is nothing to reply to.
    with pytest.raises(ConflictException):
        await svc.add_reply(ann.id, _as(approver, org, "worker"), "Replying")


async def test_a_third_party_in_the_thread_is_kept_in_it(
    db_session, org, trainee, worker, hr
):
    """A three-way thread must not silently drop one of its participants."""
    owner, _ = trainee
    approver, _ = worker
    third, _ = hr
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _run_with_approver(db_session, org, doc, versions[0], approver)
    ann = await _annotation(db_session, org, versions[0], approver)
    db_session.add(
        AnnotationReply(
            org_id=org.id, annotation_id=ann.id, author_id=third.id,
            body="Adding a thought.",
        )
    )
    await db_session.flush()

    await AnnotationService(db_session).add_reply(
        ann.id, _as(owner, org, "trainee"), "Answering both of you.",
    )
    events = (
        await db_session.execute(
            select(OutboxEvent).where(OutboxEvent.topic == "notification")
        )
    ).scalars().all()
    recipients = {u for e in events for u in e.payload.get("user_ids", [])}
    assert str(approver.id) in recipients
    assert str(third.id) in recipients
    assert str(owner.id) not in recipients


# -- Status (WF-REV-06) -----------------------------------------------------

async def test_the_owner_marks_a_comment_addressed(
    db_session, org, trainee, worker
):
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    ann = await _annotation(db_session, org, versions[0], approver)

    thread = await AnnotationService(db_session).set_status(
        ann.id, _as(owner, org, "trainee"), "addressed",
    )
    assert thread.status == "addressed"
    # Still outstanding: the approver has not accepted it yet.
    assert thread.is_open is True


async def test_the_owner_can_take_addressed_back(
    db_session, org, trainee, worker
):
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    ann = await _annotation(db_session, org, versions[0], approver, status="addressed")

    thread = await AnnotationService(db_session).set_status(
        ann.id, _as(owner, org, "trainee"), "open",
    )
    assert thread.status == "open"


async def test_the_owner_cannot_resolve_their_own_feedback(
    db_session, org, trainee, worker
):
    """WF-REV-06, and the point of the whole asymmetry: resolving is the
    approver accepting the fix. An owner who could resolve would be
    approving their own corrections by the back door."""
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _run_with_approver(db_session, org, doc, versions[0], approver)
    ann = await _annotation(db_session, org, versions[0], approver)

    with pytest.raises(ConflictException) as exc:
        await AnnotationService(db_session).set_status(
            ann.id, _as(owner, org, "trainee"), "resolved",
        )
    # The message has to say what they CAN do, or the UI has nothing to
    # explain (UX-INT-01).
    assert "addressed" in str(exc.value)


async def test_the_approver_resolves(db_session, org, trainee, worker):
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _run_with_approver(db_session, org, doc, versions[0], approver)
    ann = await _annotation(db_session, org, versions[0], approver, status="addressed")

    thread = await AnnotationService(db_session).set_status(
        ann.id, _as(approver, org, "worker"), "resolved",
    )
    assert thread.status == "resolved"
    assert thread.is_open is False


async def test_the_approver_can_reopen_if_the_fix_did_not_land(
    db_session, org, trainee, worker
):
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _run_with_approver(db_session, org, doc, versions[0], approver)
    ann = await _annotation(db_session, org, versions[0], approver, status="resolved")

    thread = await AnnotationService(db_session).set_status(
        ann.id, _as(approver, org, "worker"), "open",
    )
    assert thread.status == "open"


async def test_a_bystander_cannot_change_a_comments_state(
    db_session, org, trainee, worker, hr
):
    owner, _ = trainee
    approver, _ = worker
    bystander, _ = hr
    doc, versions = await _doc_with_versions(db_session, org, owner)
    ann = await _annotation(db_session, org, versions[0], approver)

    # HR can read the document, so it is not a 404 — but it is not their
    # comment and not their document.
    with pytest.raises(ForbiddenException):
        await AnnotationService(db_session).set_status(
            ann.id, _as(bystander, org, "hr"), "resolved",
        )


async def test_a_comment_cannot_be_pushed_back_to_draft(
    db_session, org, trainee, worker
):
    """Publication is one-way. The schema refuses the value and the service
    refuses the transition; this pins the service's half."""
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _run_with_approver(db_session, org, doc, versions[0], approver)
    ann = await _annotation(db_session, org, versions[0], approver)

    with pytest.raises(ConflictException):
        await AnnotationService(db_session).set_status(
            ann.id, _as(approver, org, "worker"), "draft",
        )


async def test_open_count_tracks_what_is_outstanding(
    db_session, org, trainee, worker
):
    """AP-APR-01 asks the same question when it warns an approver that
    comments are still open, so the client must not be computing it."""
    owner, _ = trainee
    approver, _ = worker
    doc, versions = await _doc_with_versions(db_session, org, owner)
    await _annotation(db_session, org, versions[0], approver, status="open")
    await _annotation(db_session, org, versions[0], approver, status="addressed")
    await _annotation(db_session, org, versions[0], approver, status="resolved")

    feedback = await AnnotationService(db_session).document_feedback(
        doc.id, _as(owner, org, "trainee")
    )
    assert feedback.total_count == 3
    # 'resolved' is settled; 'open' and 'addressed' are not.
    assert feedback.open_count == 2
