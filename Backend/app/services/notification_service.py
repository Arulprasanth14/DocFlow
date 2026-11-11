"""
DocFlow Backend — Service: Notification Dispatch

Creates Notification rows in PostgreSQL and pushes real-time delivery
via Redis Pub/Sub → WebSocket fan-out.

Architecture rule (§5):
  PostgreSQL is the source of truth for notifications.
  Redis carries only the ephemeral "push it now" signal.
  If Redis is unavailable, the notification still exists in the DB;
  the user will see it on next page load.

Step 2 (Notifications module): NotificationService.notify() now gates
delivery channels through the org's notification_defaults JSON field:
  {
    "in_app":  true,   # persist to DB (the bell/tray)
    "push":    true,   # push to WS via Redis
    "email":   true,   # email delivery via Celery → SMTP (Mailpit in dev)
    "sms":     false,  # SMS delivery (not yet implemented — reserved key)
  }
If the field is NULL, all channels default to enabled (backwards compat).
"""
from __future__ import annotations

import asyncio
import json
import structlog
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.notification_repo import NotificationRepository

logger = structlog.get_logger(__name__)

# Strong references so fire-and-forget email tasks aren't garbage collected
# mid-flight, and so they can be awaited (tests, shutdown).
_EMAIL_TASKS: set[asyncio.Task] = set()


async def drain_email_tasks() -> None:
    while _EMAIL_TASKS:
        await asyncio.gather(*list(_EMAIL_TASKS), return_exceptions=True)


class NotificationService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = NotificationRepository(db)

    async def _get_org_channel_flags(self, org_id: uuid.UUID) -> dict:
        """
        Return the channel-enable flags for the given org.
        Defaults to all enabled when notification_defaults is NULL or absent.
        """
        try:
            from app.models.organization import Organization
            org = await self.db.get(Organization, org_id)
            if org and org.notification_defaults:
                defaults = org.notification_defaults
                return {
                    "in_app": bool(defaults.get("in_app", True)),
                    "push":   bool(defaults.get("push",   True)),
                    "email":  bool(defaults.get("email",  True)),
                }
        except Exception as exc:
            logger.warning("notification_defaults_fetch_failed", org_id=str(org_id), error=str(exc))
        return {"in_app": True, "push": True, "email": True}

    def _send_emails(
        self,
        user_ids: list[uuid.UUID],
        title: str,
        body: str | None,
        deep_link: str | None,
        email_kind: str = "generic",
        email_context: dict | None = None,
    ) -> None:
        """
        Fire-and-forget email dispatch for a list of recipients.

        Deliberately NOT awaited by notify()/notify_many() - the in-app/DB
        notification is the source of truth, and a slow or unavailable mail
        path must never add latency to (or break) the request that triggered
        it. A new asyncio task with its OWN fresh DB session resolves the
        recipients (self.db belongs to the caller's request scope and may be
        closed by then); the actual send goes through app.core.email_dispatch,
        which never raises. Tasks are tracked in _EMAIL_TASKS so tests (and
        graceful shutdown) can await them via drain_email_tasks().
        """
        if not user_ids:
            return

        async def _dispatch() -> None:
            try:
                from sqlalchemy import select
                from app.core.email_dispatch import dispatch_email
                from app.database import async_session_factory
                from app.emails.templates import render
                from app.models.user import User

                async with async_session_factory() as db:
                    result = await db.execute(
                        select(User.id, User.email, User.name).where(User.id.in_(user_ids))
                    )
                    recipients = result.all()

                for _uid, email, name in recipients:
                    if not email:
                        continue
                    ctx = {"title": title, "body": body, "cta_url": deep_link,
                           **(email_context or {}), "name": name}
                    try:
                        mail = render(email_kind, ctx)
                        # dispatch_email is blocking (broker / SMTP sockets):
                        # keep it off the event loop.
                        outcome = await asyncio.to_thread(
                            dispatch_email, to=email, subject=mail.subject,
                            html=mail.html, text=mail.text,
                            entity_ref=f"{email_kind}:{_uid}",
                        )
                        logger.info("notification_email_dispatched", kind=email_kind, outcome=outcome)
                    except Exception as exc:
                        logger.error("notification_email_failed", kind=email_kind, error=str(exc))
            except Exception as exc:
                logger.error("notification_email_dispatch_failed", kind=email_kind, error=str(exc))

        task = asyncio.create_task(_dispatch())
        _EMAIL_TASKS.add(task)
        task.add_done_callback(_EMAIL_TASKS.discard)

    async def notify(
        self,
        org_id: uuid.UUID,
        user_id: uuid.UUID,
        type: str,
        title: str,
        body: str | None = None,
        deep_link: str | None = None,
        instance_id: uuid.UUID | None = None,
        metadata: dict | None = None,
        push_realtime: bool = True,
        email_kind: str = "generic",
        email_context: dict | None = None,
        dedupe_key: str | None = None,
    ) -> None:
        """
        Create a Notification row in PostgreSQL, then optionally push to the
        user's WebSocket connection(s) via Redis Pub/Sub.

        Channel gating: skips DB persist if in_app=False for the org;
        skips Redis push if push=False for the org.

        `dedupe_key` (section 7.1) makes the whole call idempotent - row,
        push and e-mail alike. The outbox delivers with one key per recipient
        per event, so a retried delivery, a re-run SLA sweep or a doubly
        driven drain stops here instead of notifying the same person twice.
        """
        if dedupe_key and await self.repo.dedupe_key_exists(dedupe_key):
            logger.debug("notification_deduped", key=dedupe_key, type=str(type))
            return

        flags = await self._get_org_channel_flags(org_id)

        if not flags["in_app"]:
            # Email is an independent channel: disabling the in-app tray must
            # not silently swallow the email (this hid org-created emails).
            logger.debug("notification_in_app_disabled", org_id=str(org_id), type=type)
            if flags["email"]:
                self._send_emails([user_id], title, body, deep_link, email_kind, email_context)
            return

        notif = await self.repo.create(
            org_id=org_id,
            user_id=user_id,
            type=type,
            title=title,
            body=body,
            deep_link=deep_link,
            instance_id=instance_id,
            metadata=metadata or {},
            dedupe_key=dedupe_key,
        )

        if push_realtime and flags["push"]:
            await self._push_to_redis(user_id, notif)

        if flags["email"]:
            self._send_emails([user_id], title, body, deep_link, email_kind, email_context)

    async def notify_many(
        self,
        org_id: uuid.UUID,
        user_ids: list[uuid.UUID],
        type: str,
        title: str,
        body: str | None = None,
        deep_link: str | None = None,
        instance_id: uuid.UUID | None = None,
        metadata: dict | None = None,
        email_kind: str = "generic",
        email_context: dict | None = None,
    ) -> None:
        """Notify multiple users at once (e.g., all approvers at a stage)."""
        # Fetch flags once for the org, shared across all recipients
        flags = await self._get_org_channel_flags(org_id)
        if not flags["in_app"]:
            logger.debug("notification_in_app_disabled_bulk", org_id=str(org_id), type=type)
            if flags["email"]:
                self._send_emails(user_ids, title, body, deep_link, email_kind, email_context)
            return

        for user_id in user_ids:
            notif = await self.repo.create(
                org_id=org_id,
                user_id=user_id,
                type=type,
                title=title,
                body=body,
                deep_link=deep_link,
                instance_id=instance_id,
                metadata=metadata or {},
            )
            if flags["push"]:
                await self._push_to_redis(user_id, notif)

        if flags["email"]:
            self._send_emails(user_ids, title, body, deep_link, email_kind, email_context)

    async def _push_to_redis(self, user_id: uuid.UUID, notif) -> None:
        """Publish notification to Redis so WebSocket manager can forward it."""
        try:
            from app.core.redis import get_redis
            redis = await get_redis()
            payload = json.dumps({
                "type": "notification.new",
                "payload": {
                    "id": str(notif.id),
                    "type": notif.type,
                    "title": notif.title,
                    "body": notif.body,
                    "deep_link": notif.deep_link,
                    "instance_id": str(notif.instance_id) if notif.instance_id else None,
                    "created_at": notif.created_at.isoformat() if notif.created_at else None,
                },
            })
            await redis.publish(f"ws:{user_id}", payload)
        except Exception as exc:
            # Non-fatal: notification persisted in PG, only real-time push fails
            logger.warning("notification_realtime_push_failed", user_id=str(user_id), error=str(exc))
