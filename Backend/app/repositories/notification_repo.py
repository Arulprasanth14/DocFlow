"""
DocFlow Backend — Repository: Notifications
Provides data-access for the Notification model.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification


class NotificationRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        org_id: uuid.UUID,
        user_id: uuid.UUID,
        type: str,
        title: str,
        body: str | None = None,
        deep_link: str | None = None,
        instance_id: uuid.UUID | None = None,
        metadata: dict | None = None,
    ) -> Notification:
        notif = Notification(
            org_id=org_id,
            user_id=user_id,
            type=type,
            title=title,
            body=body,
            deep_link=deep_link,
            instance_id=instance_id,
            metadata_=metadata or {},
        )
        self.db.add(notif)
        await self.db.flush()
        return notif

    async def create_bulk(self, notifications: list[dict]) -> list[Notification]:
        """Bulk-create multiple notifications (e.g., notify all stage approvers)."""
        created = []
        for n in notifications:
            notif = Notification(**{k if k != "metadata" else "metadata_": v for k, v in n.items()})
            self.db.add(notif)
            created.append(notif)
        await self.db.flush()
        return created

    async def get_for_user(
        self,
        user_id: uuid.UUID,
        unread_only: bool = False,
        page: int = 1,
        limit: int = 30,
    ) -> tuple[Sequence[Notification], int]:
        from sqlalchemy import func
        q = select(Notification).where(Notification.user_id == user_id)
        if unread_only:
            q = q.where(Notification.read_at.is_(None))

        count_q = select(func.count()).select_from(q.subquery())
        total = (await self.db.execute(count_q)).scalar_one()
        items = (await self.db.execute(
            q.order_by(Notification.created_at.desc())
             .offset((page - 1) * limit).limit(limit)
        )).scalars().all()
        return items, total

    async def mark_read(self, notification_id: uuid.UUID, user_id: uuid.UUID) -> Notification | None:
        notif = await self.db.get(Notification, notification_id)
        if not notif or notif.user_id != user_id:
            return None
        notif.read_at = datetime.now(timezone.utc)
        await self.db.flush()
        return notif

    async def mark_all_read(self, user_id: uuid.UUID) -> int:
        from sqlalchemy import update
        now = datetime.now(timezone.utc)
        result = await self.db.execute(
            update(Notification)
            .where(Notification.user_id == user_id, Notification.read_at.is_(None))
            .values(read_at=now)
        )
        await self.db.flush()
        return result.rowcount

    async def unread_count(self, user_id: uuid.UUID) -> int:
        from sqlalchemy import func
        result = await self.db.execute(
            select(func.count()).where(
                Notification.user_id == user_id,
                Notification.read_at.is_(None),
            )
        )
        return result.scalar_one()
