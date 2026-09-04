"""
DocFlow — Chat & Messaging ORM Models

Implements §5 of DocFlow-System-Architecture.md:
  Conversation + ConversationParticipant + ChatMessage

One unified schema serves TWO scenarios, differentiated only by `kind`:
  - 'workflow_context': pinned to a specific ApprovalStep (change-request chat)
  - 'direct': free-form direct messaging between members

Both types are persisted in PostgreSQL (source of truth) and delivered in
real-time via WebSocket + Redis Pub/Sub fan-out (no Firestore).

Presence & typing indicators live ONLY in Redis (short-TTL keys) — never here.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, utcnow


class Conversation(BaseModel):
    """
    A chat thread — either workflow-context or general direct messaging.

    kind = 'workflow_context': automatically created when an approver submits
        a 'changes_requested' decision. Pinned to workflow_instance_id and
        approval_step_id so auditors can open the exact conversation that
        produced a given change request.

    kind = 'direct': created explicitly by whoever starts the conversation.
        workflow_instance_id and approval_step_id are NULL.
    """
    __tablename__ = "conversations"

    # 'workflow_context' | 'direct'
    kind: Mapped[str] = mapped_column(String(50), nullable=False, index=True)

    # Set only for workflow_context conversations
    workflow_instance_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_instances.id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    # Pins the chat to the EXACT step/round that raised the issue
    approval_step_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approval_steps.id"),
        nullable=True, unique=True,  # one conversation per approval step max
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )
    title: Mapped[str | None] = mapped_column(String(500))

    # Relationships
    workflow_instance: Mapped["WorkflowInstance | None"] = relationship(  # type: ignore[name-defined]
        "WorkflowInstance", back_populates="conversations", lazy="noload",
        foreign_keys=[workflow_instance_id],
    )
    approval_step: Mapped["ApprovalStep | None"] = relationship(  # type: ignore[name-defined]
        "ApprovalStep", back_populates="conversation", lazy="noload",
        foreign_keys=[approval_step_id],
    )
    creator: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", foreign_keys=[created_by], lazy="noload",
    )
    participants: Mapped[list["ConversationParticipant"]] = relationship(
        "ConversationParticipant", back_populates="conversation",
        lazy="noload", cascade="all, delete-orphan",
    )
    messages: Mapped[list["ChatMessage"]] = relationship(
        "ChatMessage", back_populates="conversation",
        lazy="noload", cascade="all, delete-orphan",
        order_by="ChatMessage.created_at",
    )

    __table_args__ = (
        Index("idx_conversation_instance", "workflow_instance_id", "kind"),
    )


class ConversationParticipant(BaseModel):
    """
    A user's membership in a conversation.

    For workflow_context conversations: auto-populated with the requester
    and the deciding approver when 'changes_requested' is recorded.

    For direct conversations: explicitly added by the conversation creator.

    last_read_at is used to calculate unread message counts.
    """
    __tablename__ = "conversation_participants"
    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_conv_participant"),
    )

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False,
    )
    # Updated when the user reads messages — used for unread count
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    conversation: Mapped["Conversation"] = relationship(
        "Conversation", back_populates="participants", lazy="noload",
    )
    user: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", lazy="noload",
    )


class ChatMessage(BaseModel):
    """
    A single chat message within a Conversation.

    PostgreSQL is the authoritative store — messages are written here FIRST,
    then published to Redis for WebSocket fan-out to online participants.
    If Redis is unavailable, messages are never lost — only real-time delivery
    is affected; offline participants will see messages on next load.

    attachment_ids: JSONB array of DocumentVersion UUIDs — lets participants
    attach revised document files directly in-chat.
    """
    __tablename__ = "chat_messages"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    sender_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # JSONB array of DocumentVersion or FileAsset UUIDs
    attachment_ids: Mapped[list] = mapped_column(
        JSONB, default=list, server_default="[]", nullable=False,
    )
    # Set when message is edited; NULL = never edited
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Soft-delete: set when message is "deleted" by sender
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    sender: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", lazy="noload",
    )
    conversation: Mapped["Conversation"] = relationship(
        "Conversation", back_populates="messages", lazy="noload",
    )

    __table_args__ = (
        Index("idx_chat_message_conv_created", "conversation_id", "created_at"),
    )
