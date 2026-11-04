"""DocFlow Backend — AI Models (embeddings, chat sessions, processing logs)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import BaseModel


class DocumentEmbedding(BaseModel):
    """Vector embedding of a document, for semantic search and RAG."""

    __tablename__ = "document_embeddings"
    __table_args__ = (UniqueConstraint("document_id", "model", name="uq_doc_embedding"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    model: Mapped[str] = mapped_column(String(100), nullable=False)
    embedding: Mapped[dict | None] = mapped_column(JSONB)
    content_hash: Mapped[str | None] = mapped_column(String(64))


class AIChatSession(BaseModel):
    """A conversation with the assistant, with its context and message history."""

    __tablename__ = "ai_chat_sessions"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    title: Mapped[str | None] = mapped_column(String(500))
    context: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", nullable=False)
    history: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]", nullable=False)


class AIProcessingLog(BaseModel):
    """Record of an AI processing task: cost, latency and outcome."""

    __tablename__ = "ai_processing_logs"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id"), nullable=True, index=True
    )
    task_type: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(50), nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_microcents: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    result: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AIInteraction(BaseModel):
    """
    One AI request/response cycle in the Documents module (spec §23, FR-10.6).

    Separate from AIProcessingLog, which records backend processing jobs. This
    table records SUGGESTIONS MADE TO A PERSON, and carries three jobs the
    Documents spec asks for:

      - AUDIT: who asked for what, which model answered, and whether the
        suggestion was then accepted or rejected. A suggestion nobody took is
        as interesting as one they did.
      - QUOTA: the per-user daily cap is a COUNT over this table, so the quota
        and the audit trail can never disagree.
      - COST/LATENCY: token counts where the provider reports them.

    What is NOT stored: the document text sent to the model. The prompt is
    recorded as a digest only. Documents are confidential, often more so than
    the AI feature is useful, and an audit table is the wrong place to copy
    them to.
    """

    __tablename__ = "ai_interactions"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    #: 'field_suggest' | 'blank_detect' | 'rewrite' | 'review'
    feature: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_type: Mapped[str | None] = mapped_column(String(50))
    resource_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

    provider: Mapped[str | None] = mapped_column(String(40))
    model: Mapped[str | None] = mapped_column(String(100))
    #: SHA-256 of the prompt — recognises a repeat request without storing text.
    prompt_digest: Mapped[str | None] = mapped_column(String(64))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    latency_ms: Mapped[int | None] = mapped_column(Integer)

    #: 'ok' | 'error' | 'timeout' | 'blocked'
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ok")
    error: Mapped[str | None] = mapped_column(Text)

    #: Nothing an AI produces is applied on its own (FR-10.4). This records
    #: what the human then did: NULL = no decision yet, true = accepted,
    #: false = rejected. NULL is a real state and must not read as a rejection.
    accepted: Mapped[bool | None] = mapped_column()
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    #: Counts and confidence bands — never the content itself.
    metadata_: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", name="metadata"
    )

    __table_args__ = (
        # The quota query: "how many calls has this user made today?"
        Index("idx_ai_interaction_user_day", "user_id", "created_at"),
        Index("idx_ai_interaction_org_feature", "org_id", "feature", "created_at"),
    )
