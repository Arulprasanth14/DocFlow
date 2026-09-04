"""DocFlow — Celery Worker: Notification Tasks"""
from __future__ import annotations

import structlog
from app.core.celery_app import celery_app

logger = structlog.get_logger(__name__)


@celery_app.task(name="app.workers.notification_tasks.send_notification", bind=True, max_retries=3)
def send_notification(self, user_id: str, notification_type: str, payload: dict) -> bool:
    """
    Persist a notification and publish it to Redis for WebSocket delivery.
    Called from notification_service — fire and forget.
    """
    try:
        import asyncio
        from app.core.redis import publish
        asyncio.run(publish(f"ws:{user_id}", {"type": notification_type, "payload": payload}))
        logger.info("Notification published", user_id=user_id, type=notification_type)
        return True
    except Exception as exc:
        logger.error("Notification failed", user_id=user_id, error=str(exc))
        raise self.retry(exc=exc, countdown=2 ** self.request.retries * 30)
