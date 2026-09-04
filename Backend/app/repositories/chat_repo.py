"""
DocFlow Backend — Repositories: Chat
Provides data-access for Conversation, ConversationParticipant, ChatMessage.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Sequence

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.chat import ChatMessage, Conversation, ConversationParticipant


class ConversationRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        kind: str,
        created_by: uuid.UUID,
        workflow_instance_id: uuid.UUID | None = None,
        approval_step_id: uuid.UUID | None = None,
        title: str | None = None,
    ) -> Conversation:
        conv = Conversation(
            kind=kind,
            created_by=created_by,
            workflow_instance_id=workflow_instance_id,
            approval_step_id=approval_step_id,
            title=title,
        )
        self.db.add(conv)
        await self.db.flush()
        return conv

    async def get_by_id(self, conversation_id: uuid.UUID) -> Conversation | None:
        return await self.db.get(Conversation, conversation_id)

    async def get_by_approval_step(self, approval_step_id: uuid.UUID) -> Conversation | None:
        """Get the workflow-context conversation for a specific approval step."""
        result = await self.db.execute(
            select(Conversation).where(
                Conversation.approval_step_id == approval_step_id
            )
        )
        return result.scalar_one_or_none()

    async def list_for_user(
        self,
        user_id: uuid.UUID,
        kind: str | None = None,
        page: int = 1,
        limit: int = 20,
    ) -> tuple[Sequence[Conversation], int]:
        """List conversations where user is a participant."""
        from sqlalchemy import func
        base_q = (
            select(Conversation)
            .join(
                ConversationParticipant,
                ConversationParticipant.conversation_id == Conversation.id,
            )
            .where(ConversationParticipant.user_id == user_id)
        )
        if kind:
            base_q = base_q.where(Conversation.kind == kind)

        count_q = select(func.count()).select_from(base_q.subquery())
        total = (await self.db.execute(count_q)).scalar_one()
        items = (await self.db.execute(
            base_q.order_by(Conversation.created_at.desc())
                  .offset((page - 1) * limit).limit(limit)
        )).scalars().all()
        return items, total

    async def add_participant(
        self,
        conversation_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> ConversationParticipant:
        # Check if already a participant
        existing = await self.db.execute(
            select(ConversationParticipant).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.user_id == user_id,
            )
        )
        existing_part = existing.scalar_one_or_none()
        if existing_part:
            return existing_part

        part = ConversationParticipant(
            conversation_id=conversation_id,
            user_id=user_id,
        )
        self.db.add(part)
        await self.db.flush()
        return part

    async def is_participant(self, conversation_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        result = await self.db.execute(
            select(ConversationParticipant).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.user_id == user_id,
            )
        )
        return result.scalar_one_or_none() is not None

    async def update_last_read(self, conversation_id: uuid.UUID, user_id: uuid.UUID) -> None:
        result = await self.db.execute(
            select(ConversationParticipant).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.user_id == user_id,
            )
        )
        part = result.scalar_one_or_none()
        if part:
            part.last_read_at = datetime.now(timezone.utc)
            await self.db.flush()


class ChatMessageRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def create(
        self,
        conversation_id: uuid.UUID,
        sender_id: uuid.UUID,
        body: str,
        attachment_ids: list | None = None,
    ) -> ChatMessage:
        msg = ChatMessage(
            conversation_id=conversation_id,
            sender_id=sender_id,
            body=body,
            attachment_ids=attachment_ids or [],
        )
        self.db.add(msg)
        await self.db.flush()
        return msg

    async def list_for_conversation(
        self,
        conversation_id: uuid.UUID,
        before_id: uuid.UUID | None = None,
        limit: int = 50,
    ) -> Sequence[ChatMessage]:
        """
        Paginate messages in a conversation.
        If before_id is provided, return messages before that message (cursor pagination).
        """
        q = select(ChatMessage).where(
            ChatMessage.conversation_id == conversation_id,
            ChatMessage.deleted_at.is_(None),
        )
        if before_id:
            # Cursor: fetch messages older than `before_id`
            ref_msg = await self.db.get(ChatMessage, before_id)
            if ref_msg:
                q = q.where(ChatMessage.created_at < ref_msg.created_at)

        result = await self.db.execute(
            q.order_by(ChatMessage.created_at.desc()).limit(limit)
        )
        # Return in chronological order
        return list(reversed(result.scalars().all()))

    async def get_by_id(self, message_id: uuid.UUID) -> ChatMessage | None:
        return await self.db.get(ChatMessage, message_id)

    async def soft_delete(self, message_id: uuid.UUID, sender_id: uuid.UUID) -> bool:
        msg = await self.db.get(ChatMessage, message_id)
        if not msg or msg.sender_id != sender_id:
            return False
        msg.deleted_at = datetime.now(timezone.utc)
        await self.db.flush()
        return True

    async def update_body(
        self,
        message_id: uuid.UUID,
        sender_id: uuid.UUID,
        new_body: str,
    ) -> ChatMessage | None:
        msg = await self.db.get(ChatMessage, message_id)
        if not msg or msg.sender_id != sender_id:
            return None
        msg.body = new_body
        msg.edited_at = datetime.now(timezone.utc)
        await self.db.flush()
        return msg

    async def unread_count(self, conversation_id: uuid.UUID, user_id: uuid.UUID) -> int:
        """Count messages after the user's last_read_at."""
        from sqlalchemy import func
        # Get user's last_read_at
        part_result = await self.db.execute(
            select(ConversationParticipant).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.user_id == user_id,
            )
        )
        part = part_result.scalar_one_or_none()
        if not part or not part.last_read_at:
            # Never read — count all messages not from this user
            count = await self.db.execute(
                select(func.count()).where(
                    ChatMessage.conversation_id == conversation_id,
                    ChatMessage.sender_id != user_id,
                    ChatMessage.deleted_at.is_(None),
                )
            )
        else:
            count = await self.db.execute(
                select(func.count()).where(
                    ChatMessage.conversation_id == conversation_id,
                    ChatMessage.sender_id != user_id,
                    ChatMessage.created_at > part.last_read_at,
                    ChatMessage.deleted_at.is_(None),
                )
            )
        return count.scalar_one()
