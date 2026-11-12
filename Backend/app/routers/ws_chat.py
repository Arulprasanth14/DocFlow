"""
DocFlow Backend — Router: WebSocket Chat
Endpoint:
  WS /ws/chat/{conversation_id}?token=JWT

Auth: the DocFlow access token as ?token= (browsers cannot set headers on a
WebSocket). It runs through the SAME validation as an authenticated HTTP
request - pinned algorithm, token kind, session bound to the user, account
still allowed to authenticate - re-checked periodically while open.

NOTE (ops): the access token travels in the query string, because browsers
cannot set headers on a WebSocket. DocFlow's own request logger records the
path only (middleware/logging.py), but the ASGI server's and any reverse
proxy's access logs must be configured to scrub `?token=` - otherwise live
credentials land in log storage. Replacing this with a single-use ticket
endpoint is tracked as a separate item.


Step 0.3 fix applied: per-message re-authorization — is_participant() is checked
      via ChatService.send() on EVERY inbound 'message' frame, not just at
      connect time. This means a user removed from a conversation mid-session
      will get a 403 on the next message send without needing to disconnect.

Step 0.2 confirmed: Redis channel is ws:chat:{conversation_id} (UUID-based) —
      per-conversation scoping is correct and carries no sequential-ID risk.

Implements §5 bidirectional WebSocket chat with Redis Pub/Sub fan-out.
Online presence and typing indicators are published through ephemeral Redis keys.
All chat messages are persisted to PostgreSQL FIRST via ChatService.send().
"""
from __future__ import annotations

import asyncio
import json
import uuid

import structlog
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.config import settings
from app.core.exceptions import ForbiddenException, UnauthorizedException
from app.core.redis import get_redis
from app.database import async_session_factory
from app.dependencies import authenticate_token
from app.repositories.chat_repo import ConversationRepository
from app.schemas.chat import SendMessageRequest
from app.services.chat_service import ChatService

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["Chat WebSocket"])


@router.websocket("/ws/chat/{conversation_id}")
async def chat_websocket(
    websocket: WebSocket,
    conversation_id: uuid.UUID,
    token: str = Query(..., description="Firebase JWT — passed as ?token= query param (browser WS limitation)"),
) -> None:
    # ── Step 1: Authenticate via token query param ───────────────────────────
    try:
        async with async_session_factory() as db:
            auth = await authenticate_token(db, token)
    except (UnauthorizedException, ForbiddenException) as exc:
        # 1008 = policy violation. Previously this only verified the JWT
        # signature, so a revoked session kept a live chat socket and a refresh
        # token was accepted as a credential.
        logger.warning("ws_chat_auth_failed", error=str(exc.detail))
        await websocket.close(code=1008)
        return
    except Exception as exc:  # noqa: BLE001 - never surface an internal error
        logger.error("ws_chat_auth_error", error=f"{type(exc).__name__}: {exc}")
        await websocket.close(code=1011)
        return

    user_id = auth.id
    org_id = auth.org_id

    # ── Step 2: Verify participant access at connect time ────────────────────
    async with async_session_factory() as db:
        conv_repo = ConversationRepository(db)
        is_part = await conv_repo.is_participant(conversation_id, user_id)
        if not is_part:
            logger.warning(
                "ws_chat_access_denied",
                user_id=str(user_id),
                conv_id=str(conversation_id),
            )
            await websocket.close(code=4003)
            return

    await websocket.accept()
    channel = f"ws:chat:{conversation_id}"  # Per-conversation UUID channel — Step 0.2
    try:
        redis = await get_redis()
        pubsub = redis.pubsub()
        await pubsub.subscribe(channel)
    except Exception as exc:
        logger.warning("ws_chat_redis_unavailable", conv_id=str(conversation_id), error=str(exc))
        await websocket.close(code=1013)  # 1013 = "Try Again Later"
        return

    async def reader_loop() -> None:
        """
        Read incoming frames from client and dispatch.

        Step 0.3: Per-message re-authorization happens inside ChatService.send()
        which checks is_participant() on every message. If the user is removed
        from the conversation while connected, the next 'message' frame will
        raise ForbiddenException and we send an error frame + close.
        """
        try:
            while True:
                text = await websocket.receive_text()
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "payload": {"message": "Invalid JSON frame"},
                    }))
                    continue

                msg_type = data.get("type")
                payload = data.get("payload", {})

                if msg_type == "message":
                    body = payload.get("body", "").strip()
                    if body:
                        try:
                            async with async_session_factory() as db:
                                svc = ChatService(db)
                                # send() internally re-checks is_participant (Step 0.3)
                                await svc.send(
                                    conversation_id=conversation_id,
                                    sender_id=user_id,
                                    org_id=org_id,
                                    req=SendMessageRequest(
                                        body=body,
                                        attachment_ids=[
                                            uuid.UUID(a) for a in payload.get("attachment_ids", [])
                                            if a
                                        ],
                                    ),
                                )
                        except Exception as exc:
                            # Surface service-layer errors (e.g. 403 Forbidden) to client
                            error_type = type(exc).__name__
                            await websocket.send_text(json.dumps({
                                "type": "error",
                                "payload": {
                                    "message": str(exc),
                                    "error_type": error_type,
                                },
                            }))
                            # If access was revoked mid-session, close the socket
                            if "ForbiddenException" in error_type:
                                await websocket.close(code=4003)
                                return

                elif msg_type == "typing":
                    # Debounced client-side — we just broadcast the frame as-is
                    typing_data = json.dumps({
                        "type": "typing",
                        "payload": {
                            "user_id": str(user_id),
                            "is_typing": payload.get("is_typing", True),
                        },
                    })
                    await redis.publish(channel, typing_data)

                elif msg_type == "read":
                    async with async_session_factory() as db:
                        svc = ChatService(db)
                        try:
                            await svc.mark_read(conversation_id, user_id)
                        except Exception:
                            pass  # Non-critical — silently ignore

                elif msg_type == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))

        except WebSocketDisconnect:
            pass
        except Exception as exc:
            logger.error("ws_chat_reader_error", error=str(exc))

    async def writer_loop() -> None:
        """Listen to Redis channel and forward to client WebSocket."""
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
            logger.error("ws_chat_writer_error", error=str(exc))


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
                    "ws_chat_session_revoked",
                    user_id=str(user_id), reason=str(exc.detail),
                )
                await websocket.close(code=1008)
                return
            except Exception as exc:  # noqa: BLE001 - a DB blip is not a revocation
                logger.warning(
                    "ws_chat_revalidation_failed",
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
        logger.info(
            "ws_chat_disconnected",
            user_id=str(user_id),
            conv_id=str(conversation_id),
        )
