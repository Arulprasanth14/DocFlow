"""
DocFlow Backend — EventBus Subscriber Registry

This module is imported ONCE at startup (in main.py lifespan) as a side-effect
import. All EventBus.subscribe() calls live here so they are registered exactly
once per process.

Design constraint: EventBus.publish() is synchronous (calls sync callbacks).
Handlers that need async DB access spawn a new asyncio task with a fresh
session. This avoids blocking the publisher's request-response cycle.

IMPORTANT — no duplicate notifications:
  Each handler below is the SINGLE path for its notification.
  The corresponding direct notif_svc.notify() calls have been REMOVED from:
    - chat_service.py:send()  (removed notify_many; EventBus.publish retained)
    - approval_service.py:_handle_approved/_handle_rejected/_handle_changes_requested
      (removed direct notify; EventBus.publish retained)
  Only this file calls NotificationService.notify() for those events.
"""
from __future__ import annotations

import asyncio
import uuid
import structlog

from app.core.events import EventBus

logger = structlog.get_logger(__name__)


# ── chat.message_sent ──────────────────────────────────────────────────────────
# Published by: chat_service.py:send()
# Payload fields: conversation_id, message_id, sender_id, org_id, offline_user_ids

def _on_chat_message_sent(payload: dict) -> None:
    """
    Notify each offline participant of a new chat message.
    offline_user_ids already computed by chat_service — no recomputation needed.
    """
    offline_ids = payload.get("offline_user_ids", [])
    if not offline_ids:
        return

    org_id = uuid.UUID(payload["org_id"])
    conv_id = payload["conversation_id"]
    msg_id = payload["message_id"]

    async def _dispatch() -> None:
        from app.database import async_session_factory
        from app.services.notification_service import NotificationService
        from app.domain.enums import NotificationType

        async with async_session_factory() as db:
            svc = NotificationService(db)
            await svc.notify_many(
                org_id=org_id,
                user_ids=[uuid.UUID(uid) for uid in offline_ids],
                type=NotificationType.NEW_MESSAGE,
                title="New message",
                body=payload.get("body_preview", "You have a new message"),
                deep_link=f"/chat/{conv_id}",
                metadata={"conversation_id": conv_id, "message_id": msg_id},
            )
            await db.commit()

    asyncio.create_task(_dispatch())


EventBus.subscribe("chat.message_sent", _on_chat_message_sent)


# ── document.status_changed ───────────────────────────────────────────────────
# Published by:
#   - approval_service.py:_handle_rejected (event="workflow_rejected")
#   - approval_service.py:_handle_changes_requested (event="changes_requested")
#   - approval_service.py:_handle_approved via workflow_service.advance_stage
#   - workflow_service.py (various advance_stage calls)
#   - document_service.py submit()
# Payload fields: doc_id, org_id, new_status, event, [notif_user_id], [title], [body], [deep_link], [instance_id]

def _on_document_status_changed(payload: dict) -> None:
    """
    Route document status change notifications to the document owner (or
    explicit recipient if provided in the payload).

    Approval service provides: notif_user_id, notif_title, notif_body,
    notif_deep_link, notif_instance_id, notif_type in the payload so each
    call-site can customise the notification text without duplicating logic here.
    """
    user_id_str = payload.get("notif_user_id")
    if not user_id_str:
        # No explicit recipient — this event is informational only (e.g. from
        # workflow_service.advance_stage which already handles its own notifs).
        return

    async def _dispatch() -> None:
        from app.database import async_session_factory
        from app.services.notification_service import NotificationService
        from app.domain.enums import NotificationType

        async with async_session_factory() as db:
            svc = NotificationService(db)
            instance_id_str = payload.get("notif_instance_id")
            await svc.notify(
                org_id=uuid.UUID(payload["org_id"]),
                user_id=uuid.UUID(user_id_str),
                # NotificationType has no STATUS_CHANGED member; SYSTEM is the
                # closest generic fallback for call-sites that don't pass an
                # explicit notif_type (most call-sites do pass one).
                type=payload.get("notif_type", NotificationType.SYSTEM),
                title=payload.get("notif_title", "Document status updated"),
                body=payload.get("notif_body"),
                deep_link=payload.get("notif_deep_link"),
                instance_id=uuid.UUID(instance_id_str) if instance_id_str else None,
                metadata={"doc_id": payload["doc_id"], "event": payload.get("event")},
            )
            await db.commit()

    asyncio.create_task(_dispatch())


EventBus.subscribe("document.status_changed", _on_document_status_changed)
