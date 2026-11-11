"""
DocFlow - Worker: transactional outbox drain (X-NOT-01), task P2-8

This sweep, not the opportunistic drain in `get_db`, is what makes delivery
durable. If the process dies between the business transaction committing and
its notifications going out, the rows are still pending and this picks them
up on the next tick.

It runs every minute. The drain after each request means a notification
normally appears immediately; a minute is the worst case, when the process
that queued it did not survive to deliver it.
"""
from __future__ import annotations

import asyncio

import structlog

from app.core.celery_app import celery_app

logger = structlog.get_logger(__name__)

# One batch per tick. Big enough that a backlog clears quickly, small enough
# that a single tick cannot hold a long transaction open over the queue.
BATCH_SIZE = 200


async def _drain() -> int:
    from app.workers._db import task_session
    from app.services.outbox_service import OutboxService

    delivered = 0
    async with task_session() as db:
        svc = OutboxService(db)
        # Loop so a backlog drains within the tick instead of one batch per
        # minute. `deliver_pending` claims rows with SKIP LOCKED, so this
        # never fights another worker for the same row.
        while True:
            batch = await svc.deliver_pending(limit=BATCH_SIZE)
            await db.commit()
            delivered += batch
            if batch < BATCH_SIZE:
                break
    return delivered


@celery_app.task(name="app.workers.outbox_tasks.drain_outbox")
def drain_outbox() -> dict:
    """Deliver every due outbox event."""
    try:
        delivered = asyncio.run(_drain())
    except Exception as exc:  # noqa: BLE001
        # Swallowed on purpose: an exception here would mark the beat task
        # failed and, with task_acks_late, have it retried immediately in a
        # tight loop. Undelivered rows already carry their own back-off.
        logger.error("outbox_drain_failed", error=str(exc))
        return {"delivered": 0, "error": str(exc)}

    if delivered:
        logger.info("outbox_drained", delivered=delivered)
    return {"delivered": delivered}
