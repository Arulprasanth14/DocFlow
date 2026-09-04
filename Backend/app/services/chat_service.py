"""
DocFlow Backend — Service: Chat & Messaging

Implements §5 of DocFlow-System-Architecture.md:
  - start_direct(): create Conversation(kind=direct) between users
  - send(): write ChatMessage to PostgreSQL first, then publish to Redis for
            real-time WebSocket delivery to online participants
  - list_conversations(): paginated conversations for a user
  - list_messages(): cursor-paginated messages for a conversation
  - mark_read(): update ConversationParticipant.last_read_at

Architecture rule (§5):
  PostgreSQL is the authoritative store. Messages are written to DB first.
  Redis is used ONLY for Pub/Sub fan-out and short-TTL presence/typing keys.
  If Redis is down, messages are still saved; offline participants see them on next load.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenException, NotFoundException
from app.domain.enums import ConversationKind, NotificationType
from app.models.chat import Conversation
from app.repositories.chat_repo import ChatMessageRepository, ConversationRepository
from app.schemas.chat import (
    ChatMessageResponse,
    ConversationResponse,
    SendMessageRequest,
    StartDirectConversationRequest,
)
from app.services.notification_service import NotificationService

logger = structlog.get_logger(__name__)


class ChatService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.conv_repo = ConversationRepository(db)
        self.msg_repo = ChatMessageRepository(db)
        self.notif_svc = NotificationService(db)

    # ── Start Direct Conversation ──────────────────────────────────────────────

    async def start_direct(
        self,
        creator_id: uuid.UUID,
        org_id: uuid.UUID,
        req: StartDirectConversationRequest,
    ) -> ConversationResponse:
        """Start a direct (DM) conversation with another user."""
        conv = await self.conv_repo.create(
            kind=ConversationKind.DIRECT,
            created_by=creator_id,
            title=req.title,
        )
        await self.conv_repo.add_participant(conv.id, creator_id)
        await self.conv_repo.add_participant(conv.id, req.participant_user_id)

        if req.initial_message:
            await self.send(
                conversation_id=conv.id,
                sender_id=creator_id,
                org_id=org_id,
                req=SendMessageRequest(body=req.initial_message),
            )

        await self.db.commit()
        conv = await self.conv_repo.get_by_id(conv.id)
        return await self._enrich_conversation(conv, creator_id)

    # ── Send Message ───────────────────────────────────────────────────────────

    async def send(
        self,
        conversation_id: uuid.UUID,
        sender_id: uuid.UUID,
        org_id: uuid.UUID,
        req: SendMessageRequest,
    ) -> ChatMessageResponse:
        """
        Send a chat message.
        1. Verify sender is a participant
        2. Save ChatMessage to PostgreSQL (authoritative store)
        3. Publish to Redis Pub/Sub for WebSocket fan-out to online participants
        4. Send offline notifications to participants who are offline
        """
        is_part = await self.conv_repo.is_participant(conversation_id, sender_id)
        if not is_part:
            raise ForbiddenException("You are not a participant in this conversation")

        msg = await self.msg_repo.create(
            conversation_id=conversation_id,
            sender_id=sender_id,
            body=req.body,
            attachment_ids=[str(a) for a in req.attachment_ids],
        )
        await self.db.commit()

        # Reload message with sender details
        msg = await self.msg_repo.get_by_id(msg.id)
        resp = ChatMessageResponse.model_validate(msg)

        # Real-time fan-out via Redis
        await self._publish_to_redis(conversation_id, resp)

        # Notify other participants who are offline
        conv = await self.conv_repo.get_by_id(conversation_id)
        if conv:
            other_ids = [p.user_id for p in conv.participants if p.user_id != sender_id]
            if other_ids:
                await self.notif_svc.notify_many(
                    org_id=org_id,
                    user_ids=other_ids,
                    type=NotificationType.NEW_MESSAGE,
                    title="New message in conversation",
                    body=f"{req.body[:100]}...",
                    deep_link=f"/chat/{conversation_id}",
                    metadata={"conversation_id": str(conversation_id), "message_id": str(msg.id)},
                )

        logger.info("chat_message_sent", message_id=str(msg.id), conv_id=str(conversation_id))
        return resp

    # ── List Conversations ─────────────────────────────────────────────────────

    async def list_conversations(
        self,
        user_id: uuid.UUID,
        kind: str | None = None,
        page: int = 1,
        limit: int = 20,
    ) -> tuple[list[ConversationResponse], int]:
        items, total = await self.conv_repo.list_for_user(user_id, kind, page, limit)
        enriched = [await self._enrich_conversation(c, user_id) for c in items]
        return enriched, total

    # ── List Messages ──────────────────────────────────────────────────────────

    async def list_messages(
        self,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
        before_id: uuid.UUID | None = None,
        limit: int = 50,
    ) -> list[ChatMessageResponse]:
        """Paginate messages in a conversation. User must be a participant."""
        if not await self.conv_repo.is_participant(conversation_id, user_id):
            raise ForbiddenException("You are not a participant in this conversation")

        messages = await self.msg_repo.list_for_conversation(conversation_id, before_id, limit)
        return [ChatMessageResponse.model_validate(m) for m in messages]

    # ── Mark Read ──────────────────────────────────────────────────────────────

    async def mark_read(
        self,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> None:
        if not await self.conv_repo.is_participant(conversation_id, user_id):
            raise ForbiddenException("You are not a participant in this conversation")
        await self.conv_repo.update_last_read(conversation_id, user_id)
        await self.db.commit()

    # ── Private Helpers ────────────────────────────────────────────────────────

    async def _enrich_conversation(
        self, conv: Conversation | None, user_id: uuid.UUID
    ) -> ConversationResponse:
        if not conv:
            raise NotFoundException("Conversation not found")

        unread_count = await self.msg_repo.unread_count(conv.id, user_id)
        last_msg = None
        if conv.messages:
            last_msg = conv.messages[-1]

        resp = ConversationResponse.model_validate(conv)
        resp.unread_count = unread_count
        if last_msg:
            resp.last_message_body = last_msg.body
            resp.last_message_at = last_msg.created_at
        return resp

    async def _publish_to_redis(
        self, conversation_id: uuid.UUID, msg_resp: ChatMessageResponse
    ) -> None:
        """Publish chat message to Redis channel for WebSocket delivery."""
        try:
            from app.core.redis import get_redis
            redis = await get_redis()
            payload = json.dumps({
                "type": "message.new",
                "payload": msg_resp.model_dump(mode="json"),
            })
            # Publish to conversation channel — all online participants subscribe to ws:chat:{conv_id}
            await redis.publish(f"ws:chat:{conversation_id}", payload)
        except Exception as exc:
            logger.warning("chat_redis_publish_failed", conv_id=str(conversation_id), error=str(exc))
