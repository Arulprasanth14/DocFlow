"""
DocFlow - Transactional outbox (X-NOT-01), task P2-8

Section 7.1 requires every notification to be "created inside the
state-change transaction and delivered asynchronously, so a rolled-back
change never notifies".

**What was wrong before.** Workflow notifications went out one of two ways,
and both could notify for something that did not happen:

  1. `NotificationService.notify()` called straight from a service. The
     Notification row joins the caller's transaction and rolls back
     correctly, but the Redis push and the e-mail are fired immediately and
     cannot be taken back.

  2. `EventBus.publish("document.status_changed", ...)`, whose subscriber
     (`app/subscribers.py`) spawns `asyncio.create_task` with **its own
     session and its own commit**. That commit does not wait for, and is not
     affected by, the caller's. A rejection that is flushed, published, and
     then rolled back still tells the owner their document was rejected.

**How it works now.** `enqueue()` writes a row in the caller's transaction -
nothing leaves the process. After that transaction commits, delivery happens
in a separate one (`deliver_pending`), driven by two things:

  * an opportunistic drain right after the request commits, so the bell still
    lights up immediately rather than on the next sweep; and
  * a Celery beat sweep every minute, which is what makes delivery durable -
    if the process dies between commit and drain, the row is still there.

Delivery is idempotent: each recipient's notification carries a dedupe key
with a unique index behind it, so a retried or doubly-driven delivery cannot
notify anyone twice.
"""
from __future__ import annotations

import uuid
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

import structlog
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.notifications import TOPIC_NOTIFICATION, NotificationEnvelope
from app.models.outbox import OutboxEvent

logger = structlog.get_logger(__name__)

# Give up after this many failures and leave the row for an operator. Not
# deleted: a notification nobody can explain is worse than a stuck row.
MAX_ATTEMPTS = 8
# Back-off between attempts, in seconds, indexed by attempt count.
_BACKOFF = (10, 30, 60, 300, 900, 1800, 3600)

# Set when this request enqueued something, so the post-commit hook can skip
# the query entirely on the (very many) requests that enqueue nothing. It is a
# ContextVar rather than an attribute because the hook runs in the session
# dependency, which has no reference to whichever service did the enqueuing.
_has_pending: ContextVar[bool] = ContextVar("outbox_has_pending", default=False)


def _backoff_for(attempts: int) -> timedelta:
    idx = min(attempts, len(_BACKOFF) - 1)
    return timedelta(seconds=_BACKOFF[idx])


class OutboxService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # -- Enqueue (inside the caller's transaction) ---------------------------

    async def enqueue(
        self,
        topic: str,
        payload: dict,
        *,
        org_id: uuid.UUID | None = None,
        dedupe_key: str | None = None,
        available_at: datetime | None = None,
    ) -> OutboxEvent | None:
        """Record a side effect to be delivered after this transaction commits.

        Returns None when `dedupe_key` names an event that is already queued
        or delivered - the caller has nothing to handle, the event is simply
        already accounted for.
        """
        if dedupe_key:
            existing = (
                await self.db.execute(
                    select(OutboxEvent.id).where(OutboxEvent.dedupe_key == dedupe_key)
                )
            ).first()
            if existing is not None:
                logger.debug("outbox_duplicate_skipped", topic=topic, key=dedupe_key)
                return None

        event = OutboxEvent(
            org_id=org_id,
            topic=topic,
            payload=payload,
            dedupe_key=dedupe_key,
            available_at=available_at or datetime.now(timezone.utc),
        )
        self.db.add(event)

        # The SELECT above closes the common case; this savepoint closes the
        # race, where two concurrent transactions both pass that check. The
        # unique index is the real guarantee, and without the savepoint its
        # IntegrityError would poison the caller's whole transaction - losing
        # the state change over a duplicate notification.
        try:
            async with self.db.begin_nested():
                await self.db.flush()
        except IntegrityError:
            logger.debug("outbox_duplicate_race", topic=topic, key=dedupe_key)
            return None

        _has_pending.set(True)
        return event

    async def enqueue_notification(
        self, envelope: NotificationEnvelope, *, org_id: uuid.UUID,
    ) -> OutboxEvent | None:
        """Queue one catalogue event (N1-N15)."""
        if not envelope.user_ids:
            # Nobody to tell. Not an error - a stage can legitimately resolve
            # to the person who is already looking at it - but worth a line,
            # because a silently empty recipient list is how notifications go
            # missing.
            logger.info(
                "outbox_notification_no_recipients",
                code=envelope.code, scope=envelope.scope,
            )
            return None
        return await self.enqueue(
            TOPIC_NOTIFICATION,
            envelope.to_payload(),
            org_id=org_id,
            dedupe_key=envelope.dedupe_key,
        )

    async def existing_dedupe_keys(self, keys: list[str]) -> set[str]:
        """Which of these events have already been queued.

        One query instead of one per candidate. The SLA sweep runs every
        minute over every in-flight approval and would otherwise do a
        round-trip per reminder per tick just to find out there was nothing
        to do.
        """
        if not keys:
            return set()
        rows = await self.db.execute(
            select(OutboxEvent.dedupe_key).where(OutboxEvent.dedupe_key.in_(keys))
        )
        return {k for (k,) in rows.all() if k}

    # -- Delivery (its own transaction, after the cause has committed) -------

    async def deliver_pending(self, limit: int = 50) -> int:
        """Deliver up to `limit` due events. Returns how many were delivered.

        Does not commit - the caller owns the transaction, which is what lets
        a test drive this without committing its fixtures.
        """
        now = datetime.now(timezone.utc)
        rows = (
            await self.db.execute(
                select(OutboxEvent)
                .where(
                    OutboxEvent.delivered_at.is_(None),
                    OutboxEvent.available_at <= now,
                    OutboxEvent.attempts < MAX_ATTEMPTS,
                )
                .order_by(OutboxEvent.available_at.asc())
                .limit(limit)
                # Several workers (and the opportunistic drain) run this at
                # once; SKIP LOCKED means they share the queue instead of
                # queueing behind each other on the same row.
                .with_for_update(skip_locked=True)
            )
        ).scalars().all()

        delivered = 0
        for event in rows:
            try:
                await self._dispatch(event)
            except Exception as exc:  # noqa: BLE001 - one bad row must not
                # stop the queue; it is retried with back-off and the error is
                # kept on the row for whoever looks.
                event.attempts += 1
                event.last_error = str(exc)[:2000]
                event.available_at = now + _backoff_for(event.attempts)
                logger.error(
                    "outbox_delivery_failed",
                    event_id=str(event.id), topic=event.topic,
                    attempts=event.attempts, error=str(exc),
                )
                continue
            event.delivered_at = datetime.now(timezone.utc)
            event.attempts += 1
            delivered += 1

        await self.db.flush()
        return delivered

    async def _dispatch(self, event: OutboxEvent) -> None:
        handler = _HANDLERS.get(event.topic)
        if handler is None:
            # Unknown topic is a code error, not a transient one. Raising puts
            # it on the row with back-off rather than discarding it silently.
            raise RuntimeError(f"No outbox handler for topic '{event.topic}'")
        await handler(self.db, event)


# -- Handlers ---------------------------------------------------------------

async def _handle_notification(db: AsyncSession, event: OutboxEvent) -> None:
    """Create one notification per recipient, then push and e-mail."""
    from app.services.notification_service import NotificationService

    envelope = NotificationEnvelope.from_payload(event.payload)
    if event.org_id is None:
        raise RuntimeError("notification outbox event has no org_id")

    svc = NotificationService(db)
    for user_id in envelope.user_ids:
        await svc.notify(
            org_id=event.org_id,
            user_id=user_id,
            type=envelope.type,
            title=envelope.title,
            body=envelope.body,
            deep_link=envelope.deep_link,
            instance_id=envelope.instance_id,
            metadata={**envelope.metadata, "code": envelope.code},
            # Per recipient, so two people both get told about one event but
            # neither is told twice if this delivery is retried.
            dedupe_key=envelope.recipient_key(user_id),
            email_kind=envelope.email_kind,
        )


_HANDLERS = {
    TOPIC_NOTIFICATION: _handle_notification,
}


# -- Post-commit drain ------------------------------------------------------

async def drain_after_commit(db: AsyncSession) -> None:
    """Deliver what this request queued, now that its transaction has committed.

    Best-effort by design. A failure here must not fail a request whose work
    is already committed, and it does not lose the notification: the rows stay
    pending and the Celery sweep picks them up.
    """
    if not _has_pending.get():
        return
    _has_pending.set(False)
    try:
        svc = OutboxService(db)
        delivered = await svc.deliver_pending()
        await db.commit()
        if delivered:
            logger.debug("outbox_drained_after_commit", delivered=delivered)
    except Exception as exc:  # noqa: BLE001
        logger.warning("outbox_post_commit_drain_failed", error=str(exc))
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001
            pass
