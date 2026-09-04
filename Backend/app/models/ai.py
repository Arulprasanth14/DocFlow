"""DocFlow — AI Processing Models (DocumentEmbedding, AIChatSession, AIProcessingLog)"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import BaseModel, utcnow

try:
    from pgvector.sqlalchemy import Vector
    VECTOR_AVAILABLE = True
except ImportError:
    # pgvector not installed — use JSON fallback for dev without the extension
    Vector = None
    VECTOR_AVAILABLE = False


class DocumentEmbedding(BaseModel):
    __tablename__ = "document_embeddings"
    __table_args__ = (UniqueConstraint("document_id", "model", name="uq_doc_embedding"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    model: Mapped[str] = mapped_column(String(100), nullable=False)  # 'text-embedding-3-small'
    # pgvector column — 1536 dimensions for OpenAI text-embedding-3-small
    embedding: Mapped[list[float] | None] = mapped_column(
        Vector(1536) if VECTOR_AVAILABLE else JSONB,
        nullable=True,
    )
    content_hash: Mapped[str | None] = mapped_column(String(64))     # SHA-256 to detect stale embeddings


class AIChatSession(BaseModel):
    __tablename__ = "ai_chat_sessions"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    title: Mapped[str | None] = mapped_column(String(500))
    context: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    history: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")


class AIProcessingLog(BaseModel):
    __tablename__ = "ai_processing_logs"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id"), nullable=True, index=True
    )
    task_type: Mapped[str] = mapped_column(String(100), nullable=False)  # 'ocr', 'classify', 'embed'
    model: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_microcents: Mapped[int | None] = mapped_column(Integer)   # cost tracking (1/1,000,000 of a cent)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    result: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
