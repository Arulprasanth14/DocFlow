"""
DocFlow — AI Agent / RAG ORM models (requirements report §12).

Four concerns, kept as separate tables rather than conflated (§16):

  AgentKnowledgeSource — an uploaded legal/policy document that forms the
                         Agent's knowledge base, with its ingestion
                         lifecycle and extraction/indexing state.
  AgentChunk           — one retrievable passage of a source, with its
                         embedding AND the identity of the embedding space
                         that vector belongs to.
  AgentConversation    — a user's chat thread with the Agent.
  AgentMessage         — one turn, with the sources cited for an answer.

Tenant isolation (§12.4): every one of these carries org_id and every query
filters on it. Retrieval is scoped to the organization BEFORE similarity
search runs — the LLM is never relied upon to keep tenants apart.

Embedding storage: vectors are stored as a plain float array rather than a
pgvector column so the schema works on any Postgres (the local dev instance
here has no pgvector, while docker-compose uses pgvector/pgvector:pg16).
`embedding_model` + `embedding_dim` are stored per chunk because cosine
similarity between vectors from different models is meaningless even at
equal dimension — retrieval filters on an exact (model, dim) match and
anything else is reported as needing re-embedding.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, utcnow


class IngestionStatus:
    """Lifecycle of a knowledge source (§12.2: 'Show processing state,
    extraction errors, index status…'). Plain constants, not an Enum, to
    match this schema's VARCHAR-status convention elsewhere."""

    PENDING = "pending"            # stored, not yet processed
    EXTRACTING = "extracting"      # pulling text out of the file
    CHUNKING = "chunking"
    EMBEDDING = "embedding"        # calling the embedding provider
    READY = "ready"                # retrievable
    FAILED = "failed"              # see extraction_error
    ARCHIVED = "archived"          # withdrawn; never retrieved
    NEEDS_REEMBEDDING = "needs_reembedding"  # embedding model/dim changed

    ALL = (
        PENDING, EXTRACTING, CHUNKING, EMBEDDING, READY, FAILED, ARCHIVED,
        NEEDS_REEMBEDDING,
    )
    # Only sources in these states contribute to an answer.
    RETRIEVABLE = (READY,)


class AgentKnowledgeSource(BaseModel):
    """
    A legal/policy document the Main Administrator has made available to the
    Agent. Deliberately separate from `documents` (§13.6: "Do not confuse
    general document upload in Documents with uploading trusted legal
    knowledge into the Agent. These are separate workflows with different
    authorization and ingestion rules.")
    """
    __tablename__ = "agent_knowledge_sources"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    category: Mapped[str | None] = mapped_column(String(100))
    # Document version as the ORGANIZATION understands it (e.g. "v2.1"),
    # distinct from `revision`, which counts replacements in DocFlow.
    version_label: Mapped[str | None] = mapped_column(String(50))
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    effective_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    uploaded_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )

    # ── File ────────────────────────────────────────────────────────────────
    filename: Mapped[str | None] = mapped_column(String(500))
    mime_type: Mapped[str | None] = mapped_column(String(100))
    size_bytes: Mapped[int | None] = mapped_column(BigInteger)
    storage_key: Mapped[str | None] = mapped_column(Text)
    checksum: Mapped[str | None] = mapped_column(String(64))

    # ── Ingestion state (§12.2) ─────────────────────────────────────────────
    status: Mapped[str] = mapped_column(
        String(30), default=IngestionStatus.PENDING,
        server_default=IngestionStatus.PENDING, nullable=False, index=True,
    )
    # Populated on FAILED — surfaced in the admin UI instead of silently
    # indexing empty content ("report extraction problems instead of
    # silently indexing empty content").
    extraction_error: Mapped[str | None] = mapped_column(Text)
    extracted_chars: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Which embedding space this source's chunks currently live in.
    embedding_model: Mapped[str | None] = mapped_column(String(100))
    embedding_dim: Mapped[int | None] = mapped_column(Integer)
    embedding_provider: Mapped[str | None] = mapped_column(String(50))
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Full extracted text, kept so a source can be re-chunked/re-embedded
    # after a model switch without re-reading the original file.
    extracted_text: Mapped[str | None] = mapped_column(Text)

    chunks: Mapped[list["AgentChunk"]] = relationship(
        "AgentChunk", back_populates="source",
        lazy="noload", cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("idx_agent_source_org_status", "org_id", "status"),
    )

    @property
    def is_retrievable(self) -> bool:
        return self.status in IngestionStatus.RETRIEVABLE and self.archived_at is None


class AgentChunk(BaseModel):
    """
    One retrievable passage. `embedding` is NULL until the embedding step
    succeeds, so a half-ingested source never pollutes retrieval.
    """
    __tablename__ = "agent_chunks"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_knowledge_sources.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    char_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Best-effort locator for citations ("cite the source document and
    # relevant section/page where available").
    page_number: Mapped[int | None] = mapped_column(Integer)
    section_label: Mapped[str | None] = mapped_column(String(255))

    # ── Vector + its space ──────────────────────────────────────────────────
    embedding: Mapped[list[float] | None] = mapped_column(ARRAY(Float))
    embedding_model: Mapped[str | None] = mapped_column(String(100))
    embedding_dim: Mapped[int | None] = mapped_column(Integer)
    embedding_provider: Mapped[str | None] = mapped_column(String(50))
    embedded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    source: Mapped["AgentKnowledgeSource"] = relationship(
        "AgentKnowledgeSource", back_populates="chunks", lazy="noload",
    )

    __table_args__ = (
        UniqueConstraint("source_id", "chunk_index", name="uq_agent_chunk_source_index"),
        Index("idx_agent_chunk_org_model", "org_id", "embedding_model"),
    )


class AgentConversation(BaseModel):
    """
    A user's Agent thread. Private to its owner by default (§12.4: "Avoid
    exposing one user's private conversations to other members unless
    explicitly designed and authorized").
    """
    __tablename__ = "agent_conversations"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    title: Mapped[str | None] = mapped_column(String(500))
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    messages: Mapped[list["AgentMessage"]] = relationship(
        "AgentMessage", back_populates="conversation",
        lazy="noload", cascade="all, delete-orphan",
        order_by="AgentMessage.created_at",
    )

    __table_args__ = (
        Index("idx_agent_conv_org_user", "org_id", "user_id"),
    )


class AgentMessage(BaseModel):
    """
    One turn. For assistant turns, `citations` records exactly which chunks
    grounded the answer (§12.5 "Display source citations or references
    beside answers so users can verify the underlying policy or legal
    text"), and `confidence` records whether the evidence was sufficient so
    the UI can mark an uncertain answer as such.
    """
    __tablename__ = "agent_messages"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agent_conversations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # 'user' | 'assistant'
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)

    # [{source_id, source_title, chunk_id, chunk_index, page_number,
    #   section_label, similarity, excerpt}]
    citations: Mapped[list] = mapped_column(
        JSONB, default=list, server_default="[]", nullable=False,
    )
    # 'grounded' | 'insufficient_evidence' | 'clarification_needed' | 'error'
    answer_state: Mapped[str | None] = mapped_column(String(40))
    model: Mapped[str | None] = mapped_column(String(100))
    provider: Mapped[str | None] = mapped_column(String(50))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    # Retrieval diagnostics (§12.5 "log enough diagnostic information to
    # improve retrieval without unnecessarily logging confidential content")
    # — similarity scores and counts, not document text.
    retrieval_debug: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", nullable=False,
    )
    # §12.5 feedback controls
    feedback: Mapped[str | None] = mapped_column(String(20))   # 'up' | 'down'
    feedback_note: Mapped[str | None] = mapped_column(Text)

    conversation: Mapped["AgentConversation"] = relationship(
        "AgentConversation", back_populates="messages", lazy="noload",
    )

    __table_args__ = (
        Index("idx_agent_msg_conv_created", "conversation_id", "created_at"),
    )
