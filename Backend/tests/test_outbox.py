"""
Workflow module section 7.1 (X-NOT-01), section 7.4, T6/T16. Task P2-8.

X-NOT-01: "notifications are created inside the state-change transaction and
delivered asynchronously, so a rolled-back change never notifies".

Two paths broke that rule before:

  * a service calling `NotificationService.notify()` directly - the row joins
    the transaction and rolls back, but the Redis push and the e-mail task
    fire immediately and cannot be recalled; and
  * `EventBus.publish("document.status_changed", ...)`, whose subscriber
    dispatches on its own session with its own commit. A rejection that was
    flushed, published and then rolled back still told the owner their
    document had been rejected.

What these tests pin down is the observable contract: submitting queues the
notification and sends nothing, delivery is what sends it, and delivery is
idempotent so a retried or doubly-driven drain cannot notify twice.
"""
from __future__ import annotations

import uuid

from sqlalchemy import func, select

from app.models.document import Document, DocumentType, DocumentVersion
from app.models.notification import Notification
from app.models.outbox import OutboxEvent
from app.models.workflow import (
    StageApproverRule,
    WorkflowStage,
    WorkflowTemplate,
)
from app.services.outbox_service import OutboxService
from app.services.workflow_service import WorkflowService


async def _template(db_session, org, owner_id, approver_id):
    t = WorkflowTemplate(org_id=org.id, name="Outbox WF", created_by=owner_id)
    db_session.add(t)
    await db_session.flush()
    st = WorkflowStage(template_id=t.id, sequence_order=1, name="Review Stage")
    db_session.add(st)
    await db_session.flush()
    db_session.add(
        StageApproverRule(
            stage_id=st.id,
            rule_type="specific_user",
            rule_value={"user_id": str(approver_id)},
        )
    )
    await db_session.flush()
    return t, st


async def _doc(db_session, org, submitter_id):
    dt = DocumentType(
        org_id=org.id, name="General", code=f"gen-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dt)
    await db_session.flush()
    d = Document(
        org_id=org.id, doc_type_id=dt.id,
        public_id=f"DOC-{uuid.uuid4().hex[:8]}", title="Quarterly Report",
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


async def _count(db_session, model, **where):
    q = select(func.count()).select_from(model)
    for col, val in where.items():
        q = q.where(getattr(model, col) == val)
    return (await db_session.execute(q)).scalar()


async def _submit(db_session, org, submitter, approver):
    tmpl, _stage = await _template(db_session, org, submitter.id, approver.id)
    doc, version = await _doc(db_session, org, submitter.id)
    svc = WorkflowService(db_session)
    run = await svc.start_workflow(
        org_id=org.id, document_id=doc.id, template_id=tmpl.id,
        requester_id=submitter.id, current_version_id=version.id,
        doc_title=doc.title,
    )
    return doc, run


async def test_submitting_queues_the_notification_and_sends_nothing(
    db_session, org, worker, trainee
):
    """X-NOT-01 — the transaction has not committed yet, so nobody is told."""
    approver, _ = worker
    submitter, _ = trainee

    _doc_row, run = await _submit(db_session, org, submitter, approver)

    assert await _count(db_session, Notification, user_id=approver.id) == 0, (
        "the approver must not be notified from inside the submitting "
        "transaction - it can still roll back"
    )

    queued = (await db_session.execute(select(OutboxEvent))).scalars().all()
    assert len(queued) == 1
    event = queued[0]
    assert event.topic == "notification"
    assert event.payload["code"] == "N1"
    assert event.payload["user_ids"] == [str(approver.id)]
    assert event.delivered_at is None
    assert str(run.id) in event.dedupe_key


async def test_delivery_is_what_notifies(db_session, org, worker, trainee):
    approver, _ = worker
    submitter, _ = trainee
    await _submit(db_session, org, submitter, approver)

    delivered = await OutboxService(db_session).deliver_pending()
    assert delivered == 1

    rows = (
        await db_session.execute(
            select(Notification).where(Notification.user_id == approver.id)
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].dedupe_key is not None
    assert rows[0].dedupe_key.startswith("N1:")
    assert str(approver.id) in rows[0].dedupe_key
    assert "Quarterly Report" in rows[0].title

    event = (await db_session.execute(select(OutboxEvent))).scalars().one()
    assert event.delivered_at is not None


async def test_a_second_drain_does_not_notify_twice(
    db_session, org, worker, trainee
):
    """T16 — the sweep and the post-commit drain both run; between them they
    must not double-notify."""
    approver, _ = worker
    submitter, _ = trainee
    await _submit(db_session, org, submitter, approver)

    svc = OutboxService(db_session)
    assert await svc.deliver_pending() == 1
    # A delivered row is never picked up again...
    assert await svc.deliver_pending() == 0

    # ...and even if it were, the per-recipient dedupe key stops a second row.
    event = (await db_session.execute(select(OutboxEvent))).scalars().one()
    event.delivered_at = None
    await db_session.flush()
    assert await svc.deliver_pending() == 1

    assert await _count(db_session, Notification, user_id=approver.id) == 1, (
        "a re-delivered event must not produce a second notification"
    )


async def test_the_same_event_cannot_be_queued_twice(
    db_session, org, worker, trainee
):
    """Section 7.1 dedupe keys, at enqueue time."""
    approver, _ = worker
    submitter, _ = trainee
    _doc_row, run = await _submit(db_session, org, submitter, approver)

    from app.domain import notifications as cat

    svc = OutboxService(db_session)
    envelope = cat.n1_approval_requested(
        instance_id=run.id,
        approver_ids=[approver.id],
        doc_title="Quarterly Report",
        stage_name="Review Stage",
    )
    second = await svc.enqueue_notification(envelope, org_id=org.id)
    assert second is None, "the same event must not queue a second time"
    assert await _count(db_session, OutboxEvent) == 1


async def test_an_event_with_no_recipients_is_not_queued(
    db_session, org, worker, trainee
):
    """An empty recipient list is not an error, but it must not leave a row
    that the worker will retry forever."""
    approver, _ = worker
    submitter, _ = trainee
    _doc_row, run = await _submit(db_session, org, submitter, approver)

    from app.domain import notifications as cat

    before = await _count(db_session, OutboxEvent)
    queued = await OutboxService(db_session).enqueue_notification(
        cat.NotificationEnvelope(
            code="N3", user_ids=[], type="approved", title="X",
            scope=f"run:{run.id}:empty",
        ),
        org_id=org.id,
    )
    assert queued is None
    assert await _count(db_session, OutboxEvent) == before


async def test_a_failing_handler_backs_off_instead_of_losing_the_event(
    db_session, org, worker, trainee
):
    """One bad row must not stop the queue, and must not be discarded."""
    approver, _ = worker
    submitter, _ = trainee
    await _submit(db_session, org, submitter, approver)

    bad = OutboxEvent(
        org_id=org.id, topic="no.such.topic", payload={}, dedupe_key=None,
    )
    db_session.add(bad)
    await db_session.flush()

    # The good event still goes out.
    assert await OutboxService(db_session).deliver_pending() == 1

    await db_session.refresh(bad)
    assert bad.delivered_at is None
    assert bad.attempts == 1
    assert "no.such.topic" in (bad.last_error or "")
