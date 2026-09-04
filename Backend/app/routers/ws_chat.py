"""
DocFlow Backend — Router: WebSocket Chat
Endpoint:
  WS /ws/chat/{conversation_id}?token=JWT

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

from app.core.redis import get_redis
from app.core.security import verify_jwt
from app.database import async_session_factory
from app.repositories.chat_repo import ConversationRepository
from app.schemas.chat import SendMessageRequest
from app.services.chat_service import ChatService

logger = structlog.get_logger(__name__)
router = APIRouter(tags=["Chat WebSocket"])


@router.websocket("/ws/chat/{conversation_id}")
async def chat_websocket(
    websocket: WebSocket,
    conversation_id: uuid.UUID,
    token: str = Query(...),
) -> None:
    # Authenticate via token query param
    try:
        payload = verify_jwt(token)
        user_id = uuid.UUID(payload["sub"])
        org_id = uuid.UUID(payload["org_id"])
    except Exception as exc:
        logger.warning("ws_chat_auth_failed", error=str(exc))
        await websocket.close(code=4001)
        return

    # Verify participant access
    async with async_session_factory() as db:
        conv_repo = ConversationRepository(db)
        is_part = await conv_repo.is_participant(conversation_id, user_id)
        if not is_part:
            await websocket.close(code=4003)
            return

    await websocket.accept()
    channel = f"ws:chat:{conversation_id}"
    redis = await get_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe(channel)

    async def reader_loop() -> None:
        """Read incoming frames from client and dispatch."""
        try:
            while True:
                text = await websocket.receive_text()
                data = json.loads(text)
                msg_type = data.get("type")
                payload = data.get("payload", {})

                if msg_type == "message":
                    body = payload.get("body", "").strip()
                    if body:
                        async with async_session_factory() as db:
                            svc = ChatService(db)
                            await svc.send(
                                conversation_id=conversation_id,
                                sender_id=user_id,
                                org_id=org_id,
                                req=SendMessageRequest(
                                    body=body,
                                    attachment_ids=[
                                        uuid.UUID(a) for a in payload.get("attachment_ids", [])
                                    ],
                                ),
                            )
                elif msg_type == "typing":
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
                        await svc.mark_read(conversation_id, user_id)
                elif msg_type == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            logger.error("ws_chat_reader_error", error=str(exc))

    async def writer_loop() -> None:
        """Listen to Redis channel and send to client WebSocket."""
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
        logger.info("ws_chat_disconnected", user_id=str(user_id), conv_id=str(conversation_id))
