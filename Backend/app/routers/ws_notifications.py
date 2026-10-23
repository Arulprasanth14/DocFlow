"""
DocFlow Backend — Router: WebSocket Notifications
Endpoint:
  WS /ws/notifications?token=JWT

Auth: JWT passed as ?token= query param (same proven pattern as ws_chat.py).

Purpose: Global per-user notification socket. The backend's NotificationService
already publishes to Redis channel ws:{user_id} for every notification.
This endpoint subscribes to that channel and forwards frames to the browser.

Multi-tab: Redis pub/sub fan-out means every simultaneous connection for the
same user_id subscribes independently to ws:{user_id}, so all tabs receive
the same frame natively — no single-consumer assumption is made here.

Cross-user isolation: The Redis channel is already narrower than org-level
(ws:{user_id}) so org_id isolation is implicit. We still extract org_id from
JWT for logging context but no separate org check is needed.
"""
from __future__ import annotations

import asyncio
import uuid

import structlog
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.redis import get_redis
from app.core.security import verify_jwt

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["Notifications WebSocket"])


@router.websocket("/ws/notifications")
async def notifications_websocket(
    websocket: WebSocket,
    token: str = Query(..., description="JWT — passed as ?token= query param (browser WS limitation)"),
) -> None:
    # ── Step 1: Authenticate via token query param ────────────────────────────
    try:
        payload = verify_jwt(token)
        user_id = uuid.UUID(payload["sub"])
        # org_id is legitimately null for a logged-in user who hasn't joined/
        # created an org yet — uuid.UUID(None) raised TypeError here, and since
        # that happened before websocket.accept(), uvicorn reported it to the
        # browser as a handshake 403 instead of a clean close, causing an
        # infinite reconnect loop (org_id is only used for logging below, not
        # for the channel subscription, so there's nothing to gate on it).
        org_id = uuid.UUID(payload["org_id"]) if payload.get("org_id") else None
    except Exception as exc:
        logger.warning("ws_notifications_auth_failed", error=str(exc))
        await websocket.close(code=4001)
        return

    await websocket.accept()

    # Subscribe to the per-user Redis channel (same channel NotificationService publishes to).
    # This genuinely requires Redis — real-time fan-out has no non-Redis fallback —
    # but a Redis outage should fail this one connection predictably (clean close +
    # log), not raise unhandled after accept() and leave the client to guess why.
    channel = f"ws:{user_id}"
    try:
        redis = await get_redis()
        pubsub = redis.pubsub()
        await pubsub.subscribe(channel)
    except Exception as exc:
        logger.warning("ws_notifications_redis_unavailable", user_id=str(user_id), error=str(exc))
        await websocket.close(code=1013)  # 1013 = "Try Again Later"
        return

    logger.info("ws_notifications_connected", user_id=str(user_id), org_id=str(org_id))

    async def reader_loop() -> None:
        """
        Accept client-to-server frames.
        Only 'ping' is meaningful here — this is a server-push channel.
        """
        try:
            while True:
                text = await websocket.receive_text()
                try:
                    import json
                    data = json.loads(text)
                    if data.get("type") == "ping":
                        await websocket.send_text('{"type":"pong"}')
                except Exception:
                    pass  # Silently ignore malformed frames
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            logger.error("ws_notifications_reader_error", error=str(exc))

    async def writer_loop() -> None:
        """
        Listen to Redis channel ws:{user_id} and forward each notification
        frame to the connected browser client.

        The frame shape published by NotificationService._push_to_redis() is:
          {"type": "notification.new", "payload": {...notification fields...}}
        We forward it as-is — no re-serialisation needed.
        """
        try:
            async for message in pubsub.listen():
                if message["type"] == "message":
                    data_str = message["data"]
                    if isinstance(data_str, bytes):
                        data_str = data_str.decode("utf-8")
                    await websocket.send_text(data_str)
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            logger.error("ws_notifications_writer_error", error=str(exc))

    reader_task = asyncio.create_task(reader_loop())
    writer_task = asyncio.create_task(writer_loop())

    try:
        await asyncio.gather(reader_task, writer_task)
    except Exception:
        pass
    finally:
        reader_task.cancel()
        writer_task.cancel()
        await pubsub.unsubscribe(channel)
        await pubsub.close()
        logger.info("ws_notifications_disconnected", user_id=str(user_id))
