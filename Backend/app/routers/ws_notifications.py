"""
DocFlow Backend — Router: WebSocket Notifications
Endpoint:
  WS /ws/notifications?token=JWT

Auth: the DocFlow access token as ?token=. It runs through the SAME
validation as an authenticated HTTP request - pinned algorithm, token kind,
session bound to the user, account still allowed to authenticate - and the
session is re-checked periodically while the socket is open, so revoking a
session cuts live sockets too.

NOTE (ops): the access token travels in the query string, because browsers
cannot set headers on a WebSocket. DocFlow's own request logger records the
path only (middleware/logging.py), but the ASGI server's and any reverse
proxy's access logs must be configured to scrub `?token=` - otherwise live
credentials land in log storage. Replacing this with a single-use ticket
endpoint is tracked as a separate item.


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

import structlog
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.config import settings
from app.core.exceptions import ForbiddenException, UnauthorizedException
from app.core.redis import get_redis
from app.database import async_session_factory
from app.dependencies import authenticate_token

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["Notifications WebSocket"])


@router.websocket("/ws/notifications")
async def notifications_websocket(
    websocket: WebSocket,
    token: str = Query(..., description="JWT — passed as ?token= query param (browser WS limitation)"),
) -> None:
    # ── Step 1: Authenticate via token query param ────────────────────────────
    try:
        async with async_session_factory() as db:
            auth = await authenticate_token(db, token)
    except (UnauthorizedException, ForbiddenException) as exc:
        # 1008 = policy violation. Previously this only verified the JWT
        # signature, so a revoked session kept full live access and a refresh
        # token was accepted as a WebSocket credential.
        logger.warning("ws_notifications_auth_failed", error=str(exc.detail))
        await websocket.close(code=1008)
        return
    except Exception as exc:  # noqa: BLE001 - never surface an internal error
        logger.error(
            "ws_notifications_auth_error", error=f"{type(exc).__name__}: {exc}"
        )
        await websocket.close(code=1011)
        return

    user_id = auth.id
    # org_id is legitimately null for a signed-in user with no organization
    # yet; it is only logging context here, since the Redis channel is already
    # per-user.
    org_id = auth.org_id

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


    async def revalidate_loop() -> None:
        """Re-run authentication while the socket is open.

        Revocation used to apply to HTTP only: an already-open socket kept
        streaming until the user closed the tab. The interval is the window
        during which a revoked session still has a live socket.
        """
        interval = max(settings.WS_REVALIDATE_SECONDS, 30)
        while True:
            await asyncio.sleep(interval)
            try:
                async with async_session_factory() as db:
                    await authenticate_token(db, token)
            except (UnauthorizedException, ForbiddenException) as exc:
                logger.info(
                    "ws_notifications_session_revoked",
                    user_id=str(user_id), reason=str(exc.detail),
                )
                await websocket.close(code=1008)
                return
            except Exception as exc:  # noqa: BLE001 - a DB blip is not a revocation
                logger.warning(
                    "ws_notifications_revalidation_failed",
                    error=f"{type(exc).__name__}: {exc}",
                )

    reader_task = asyncio.create_task(reader_loop())
    writer_task = asyncio.create_task(writer_loop())
    revalidate_task = asyncio.create_task(revalidate_loop())

    try:
        await asyncio.gather(reader_task, writer_task, revalidate_task)
    except Exception:
        pass
    finally:
        reader_task.cancel()
        writer_task.cancel()
        revalidate_task.cancel()
        await pubsub.unsubscribe(channel)
        await pubsub.close()
        logger.info("ws_notifications_disconnected", user_id=str(user_id))
