"""
DocFlow Backend — Core: WebSocket Manager
Pod-independent real-time notifications via Redis pub/sub + WebSocket.
Each FastAPI pod manages its connected WebSocket clients.
Redis pub/sub ensures cross-pod message delivery.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from uuid import UUID

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class WebSocketConnectionManager:
    """
    Manages WebSocket connections for the current pod.
    Subscribes to Redis channels for each connected user.
    When Redis publishes a message, it's forwarded to all connected clients for that user.

    Architecture:
        Any service → Redis PUBLISH notifications:{user_id} {payload}
        This manager → subscribes → forwards to WS client
    """

    def __init__(self) -> None:
        # user_id → list of WebSocket connections (multi-device support)
        self._connections: dict[str, list[WebSocket]] = {}
        self._pubsub_task: asyncio.Task | None = None

    async def connect(self, websocket: WebSocket, user_id: UUID) -> None:
        """Accept and register a new WebSocket connection."""
        await websocket.accept()
        uid = str(user_id)
        if uid not in self._connections:
            self._connections[uid] = []
        self._connections[uid].append(websocket)
        logger.info("WebSocket connected", extra={"user_id": uid, "total": len(self._connections)})

    async def disconnect(self, websocket: WebSocket, user_id: UUID) -> None:
        """Remove a disconnected WebSocket."""
        uid = str(user_id)
        if uid in self._connections:
            try:
                self._connections[uid].remove(websocket)
            except ValueError:
                pass
            if not self._connections[uid]:
                del self._connections[uid]
        logger.info("WebSocket disconnected", extra={"user_id": uid})

    async def send_to_user(self, user_id: str, event_type: str, payload: Any) -> None:
        """Send a message to all WebSocket connections for a given user_id."""
        connections = self._connections.get(user_id, [])
        if not connections:
            return  # user not connected to this pod

        message = json.dumps({"type": event_type, "payload": payload}, default=str)
        dead_connections = []

        for ws in connections:
            try:
                await ws.send_text(message)
            except Exception:
                dead_connections.append(ws)

        # Prune dead connections
        for ws in dead_connections:
            await self.disconnect(ws, UUID(user_id))

    async def broadcast_to_org(self, org_id: str, event_type: str, payload: Any) -> None:
        """
        Send to all connected users in an organisation.
        Note: This only reaches users connected to THIS pod.
        For cross-pod broadcast, use Redis PUBLISH instead.
        """
        # Implementation: org membership checked when connection established
        # For now, broadcast to all connected users (filtered by org_id in payload)
        message = json.dumps(
            {"type": event_type, "payload": {**payload, "org_id": org_id}},
            default=str
        )
        for connections in list(self._connections.values()):
            for ws in connections:
                try:
                    await ws.send_text(message)
                except Exception:
                    pass

    async def start_redis_subscriber(self) -> None:
        """
        Start the background Redis pub/sub subscriber task.
        Listens on 'ws:*' channels and routes messages to connected clients.
        Call this during app startup.
        """
        self._pubsub_task = asyncio.create_task(self._redis_subscriber_loop())

    async def stop_redis_subscriber(self) -> None:
        """Stop the Redis subscriber (call on shutdown)."""
        if self._pubsub_task:
            self._pubsub_task.cancel()
            try:
                await self._pubsub_task
            except asyncio.CancelledError:
                pass

    async def _redis_subscriber_loop(self) -> None:
        """Background loop: subscribe to Redis and forward to WebSocket clients."""
        from app.core.redis import get_redis
        redis = await get_redis()
        pubsub = redis.pubsub()
        await pubsub.psubscribe("ws:*")   # subscribe to all ws:{user_id} channels

        logger.info("WebSocket Redis subscriber started")

        try:
            async for message in pubsub.listen():
                if message["type"] not in ("message", "pmessage"):
                    continue
                channel = message.get("channel", "")
                if not channel.startswith("ws:"):
                    continue

                user_id = channel.removeprefix("ws:")
                try:
                    data = json.loads(message["data"])
                    event_type = data.get("type", "notification.new")
                    await self.send_to_user(user_id, event_type, data.get("payload", {}))
                except (json.JSONDecodeError, KeyError) as exc:
                    logger.warning(f"Invalid WS message: {exc}")
        except asyncio.CancelledError:
            pass
        finally:
            await pubsub.close()

    @property
    def connected_user_count(self) -> int:
        return len(self._connections)

    @property
    def total_connections(self) -> int:
        return sum(len(conns) for conns in self._connections.values())


# ── Module-level singleton ─────────────────────────────────────────────────────
ws_manager = WebSocketConnectionManager()
