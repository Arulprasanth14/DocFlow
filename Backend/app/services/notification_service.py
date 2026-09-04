"""
DocFlow Backend — Service: Notification Dispatch

Creates Notification rows in PostgreSQL and pushes real-time delivery
via Redis Pub/Sub → WebSocket fan-out.

Architecture rule (§5):
  PostgreSQL is the source of truth for notifications.
  Redis carries only the ephemeral "push it now" signal.
  If Redis is unavailable, the notification still exists in the DB;
  the user will see it on next page load.
"""
from __future__ import annotations

import json
import structlog
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.notification_repo import NotificationRepository

logger = structlog.get_logger(__name__)


class NotificationService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.repo = NotificationRepository(db)

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
    ) -> None:
        """
        Create a Notification row in PostgreSQL, then optionally push to the
        user's WebSocket connection(s) via Redis Pub/Sub.
        """
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

        if push_realtime:
            await self._push_to_redis(user_id, notif)

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
    ) -> None:
        """Notify multiple users at once (e.g., all approvers at a stage)."""
        for user_id in user_ids:
            await self.notify(
                org_id=org_id,
                user_id=user_id,
                type=type,
                title=title,
                body=body,
                deep_link=deep_link,
                instance_id=instance_id,
                metadata=metadata,
            )

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
