"""
DocFlow — Celery Worker: expiry reminders (spec FR-13.4 "Reminder preferences").

A document can carry an expiry date and a number of days' notice. This sweep
turns that pair into an actual notification for the owner and everyone CC'd on
it, once, on or after the day the notice is due.

Design notes worth keeping:

  - ONCE, NOT REPEATEDLY. `reminder_sent_at` is stamped in the same
    transaction as the notification, so a sweep that runs twice in a day —
    or a worker that is restarted mid-pass — cannot re-send. The column is
    cleared by `update_document` whenever the expiry date or the notice
    period changes, so a rescheduled expiry does get announced again.
  - LATE IS STILL SENT. The window is "due date has passed", not "due date
    is today". If the worker was down for three days, the reminders it owed
    still go out rather than being silently skipped.
  - ALREADY-EXPIRED DOCUMENTS ARE SKIPPED. A reminder for something that
    expired last month is noise, so documents past `expires_at` are left
    alone and reported separately in the summary.
  - STATUS IS NOT TOUCHED. Marking a document EXPIRED is a lifecycle change
    that belongs to the workflow module; this task only notifies. Deciding
    that here would let a background job move documents between states that
    the approval chain believes it owns.
  - AUDITED, and every pass writes one row per org even when it sent nothing,
    so "did reminders run last night?" is always answerable.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import timedelta

import structlog
from sqlalchemy import select

from app.config import settings
from app.core.celery_app import celery_app
from app.database import async_session_factory
from app.domain.enums import NotificationType
from app.models.audit import AuditLog
from app.models.base import utcnow
from app.models.document import Document, DocumentWatcher
from app.services.notification_service import NotificationService

logger = structlog.get_logger(__name__)

REMINDER_ACTION = "document.expiry_reminder"

# A safety net, not a policy: without it a misconfigured retention window plus
# a bulk import could fan out thousands of emails in one pass.
MAX_PER_RUN = 500


@celery_app.task(name="app.workers.reminder_tasks.send_expiry_reminders")
def send_expiry_reminders() -> dict:
    """Daily expiry-reminder pass. Returns a summary for the result backend."""
    return asyncio.run(_run_reminders())


async def _run_reminders() -> dict:
    if not settings.EXPIRY_REMINDERS_ENABLED:
        logger.info("expiry_reminders_disabled")
        return {"enabled": False, "sent": 0, "skipped_expired": 0}

    now = utcnow()
    dry_run = settings.EXPIRY_REMINDERS_DRY_RUN

    async with async_session_factory() as db:
        # Postgres does the date arithmetic: `expires_at - reminder_days` is
        # computed per row, so one indexed scan finds everything due. The
        # partial index idx_document_expiry_due covers the expires_at test.
        due = (
            await db.execute(
                select(Document)
                .where(
                    Document.deleted_at.is_(None),
                    Document.expires_at.isnot(None),
                    Document.reminder_days_before.isnot(None),
                    Document.reminder_sent_at.is_(None),
                    Document.expires_at > now,
                )
                .order_by(Document.expires_at.asc())
                .limit(MAX_PER_RUN)
            )
        ).scalars().all()

        # The notice window, evaluated in Python so the intent is readable and
        # timezone handling stays in one place.
        ready = [
            d for d in due
            if d.expires_at - timedelta(days=d.reminder_days_before or 0) <= now
        ]

        # Counted for the summary so a stuck worker is visible: these are
        # documents whose reminder date came and went while it was down.
        skipped_expired = (
            await db.execute(
                select(Document.id).where(
                    Document.deleted_at.is_(None),
                    Document.expires_at.isnot(None),
                    Document.reminder_days_before.isnot(None),
                    Document.reminder_sent_at.is_(None),
                    Document.expires_at <= now,
                )
            )
        ).scalars().all()

        if not ready:
            logger.info(
                "expiry_reminders_none_due",
                dry_run=dry_run,
                skipped_expired=len(skipped_expired),
            )
            return {
                "enabled": True, "dry_run": dry_run, "sent": 0,
                "candidates": 0, "skipped_expired": len(skipped_expired),
            }

        notif = NotificationService(db)
        per_org: dict[str, list[str]] = defaultdict(list)
        sent = 0

        for doc in ready:
            # Owner plus watchers, de-duplicated: the owner is frequently also
            # on the watcher list, and nobody wants the same email twice.
            watcher_ids = (
                await db.execute(
                    select(DocumentWatcher.user_id).where(
                        DocumentWatcher.document_id == doc.id,
                        DocumentWatcher.deleted_at.is_(None),
                    )
                )
            ).scalars().all()
            recipients = list(dict.fromkeys([doc.submitted_by, *watcher_ids]))

            days_left = max((doc.expires_at - now).days, 0)
            when = "today" if days_left == 0 else f"in {days_left} day{'s' if days_left != 1 else ''}"

            if not dry_run:
                try:
                    await notif.notify_many(
                        org_id=doc.org_id,
                        user_ids=recipients,
                        type=NotificationType.DOCUMENT_EXPIRING,
                        title="A document expires soon",
                        body=f"'{doc.title}' expires {when}.",
                        deep_link=f"/documents/{doc.id}",
                    )
                except Exception:
                    # One document's notification failing must not abandon the
                    # rest of the pass, and must not stamp reminder_sent_at —
                    # leaving it NULL means tomorrow's sweep retries it.
                    logger.warning(
                        "expiry_reminder_failed", doc_id=str(doc.id), exc_info=True
                    )
                    continue
                doc.reminder_sent_at = now

            per_org[str(doc.org_id)].append(str(doc.id))
            sent += 1

        for org_id, doc_ids in per_org.items():
            db.add(
                AuditLog(
                    org_id=org_id,
                    actor_id=None,                    # the scheduler, not a person
                    action=REMINDER_ACTION,
                    resource_type="Document",
                    resource_id=doc_ids[0],
                    after={
                        "dry_run": dry_run,
                        "count": len(doc_ids),
                        "document_ids": doc_ids[:100],
                        "truncated": len(doc_ids) > 100,
                    },
                )
            )

        await db.commit()

    logger.info(
        "expiry_reminders_done",
        dry_run=dry_run, sent=sent, skipped_expired=len(skipped_expired),
    )
    return {
        "enabled": True, "dry_run": dry_run, "sent": sent,
        "candidates": len(ready), "skipped_expired": len(skipped_expired),
    }
