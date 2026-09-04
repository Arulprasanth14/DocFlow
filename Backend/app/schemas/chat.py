"""
DocFlow Backend — Pydantic Schemas: Chat & Messaging

Covers:
  - Conversation creation (direct or workflow-context)
  - Message sending and retrieval
  - Presence/typing indicator WebSocket message shapes
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


# ── Conversation ───────────────────────────────────────────────────────────────

class StartDirectConversationRequest(BaseModel):
    """POST /chat/conversations — start a direct conversation with another user."""
    participant_user_id: uuid.UUID = Field(..., description="The other user to start a DM with")
    title: str | None = Field(None, max_length=500)
    # Optional first message to send immediately
    initial_message: str | None = None


class ConversationParticipantResponse(BaseModel):
    user_id: uuid.UUID
    joined_at: datetime
    last_read_at: datetime | None = None
    # Populated from user join
    user_name: str | None = None
    user_email: str | None = None
    user_avatar_url: str | None = None

    model_config = {"from_attributes": True}


class ConversationResponse(BaseModel):
    id: uuid.UUID
    kind: str  # 'workflow_context' | 'direct'
    title: str | None
    workflow_instance_id: uuid.UUID | None
    approval_step_id: uuid.UUID | None
    created_by: uuid.UUID
    created_at: datetime
    participants: list[ConversationParticipantResponse] = []
    # Convenience field: latest message preview
    last_message_body: str | None = None
    last_message_at: datetime | None = None
    unread_count: int = 0

    model_config = {"from_attributes": True}


class ConversationListResponse(BaseModel):
    items: list[ConversationResponse]
    total: int
    page: int
    limit: int


# ── Messages ───────────────────────────────────────────────────────────────────

class SendMessageRequest(BaseModel):
    """REST fallback for sending a message (WebSocket is the primary path)."""
    body: str = Field(..., min_length=1)
    attachment_ids: list[uuid.UUID] = Field(default_factory=list)


class ChatMessageResponse(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    sender_id: uuid.UUID
    body: str
    attachment_ids: list[Any] = []
    created_at: datetime
    edited_at: datetime | None = None
    # Populated from user join
    sender_name: str | None = None
    sender_avatar_url: str | None = None

    model_config = {"from_attributes": True}


class MessageListResponse(BaseModel):
    items: list[ChatMessageResponse]
    has_more: bool = False
    oldest_message_id: uuid.UUID | None = None


# ── WebSocket Message Shapes ───────────────────────────────────────────────────

class WSMessageIn(BaseModel):
    """Inbound WebSocket frame from client → server."""
    type: str  # 'message' | 'typing' | 'read' | 'ping'
    payload: dict[str, Any] = Field(default_factory=dict)


class WSMessageOut(BaseModel):
    """Outbound WebSocket frame from server → client."""
    type: str  # 'message.new' | 'typing' | 'presence' | 'error' | 'pong'
    payload: dict[str, Any] = Field(default_factory=dict)


class TypingIndicatorPayload(BaseModel):
    """Ephemeral — sent via Redis, never persisted to PostgreSQL."""
    conversation_id: str
    user_id: str
    user_name: str | None = None
    is_typing: bool = True


class PresencePayload(BaseModel):
    """Ephemeral — Redis only."""
    user_id: str
    is_online: bool
    last_seen_at: str | None = None
