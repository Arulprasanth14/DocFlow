"""
DocFlow — Transactional outbox and durable idempotency keys

Workflow Module §7.1 (X-NOT-01), §7.4 (X-INT-01). Migration e1f2a3b4c5d6,
task P2-1.

Both tables exist for the same reason: a side effect must agree with the
transaction that caused it.

  OutboxEvent    A notification or chat message is enqueued in the SAME
                 transaction as the state change and delivered after commit.
                 X-NOT-01: "a rolled-back change must never notify anyone."
                 The existing EventBus fires in-process and in-line, so a
                 later failure in the same request could leave a notification
                 already sent for an approval that never happened.

  IdempotencyKey The replay record for `Idempotency-Key`, kept in Postgres
                 rather than only in Redis. The existing submit path replays
                 from Redis alone, so a cache flush between a client's first
                 attempt and its retry turns one submission into two — E10 and
                 T26 require exactly one run. Redis stays in front as the
                 fast check; this is the durable backstop.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import BaseModel, utcnow


class OutboxEvent(BaseModel):
    """A side effect committed alongside its cause, delivered afterwards."""
    __tablename__ = "outbox_events"

    # Nullable: a few system events are not scoped to one organization.
    org_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=True,
    )
    topic: Mapped[str] = mapped_column(String(120), nullable=False)
    payload: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", nullable=False,
    )
    # Exactly-once per logical event (§7.1 gives each of N1–N15 its own key
    # shape, e.g. run + stage + round + kind). NULL means "no dedupe", which
    # the partial unique index leaves unconstrained.
    dedupe_key: Mapped[str | None] = mapped_column(String(255))
    # Lets a retry be scheduled with back-off instead of spun on.
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow,
        server_default=text("now()"), nullable=False,
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(
        Integer, default=0, server_default=text("0"), nullable=False,
    )
    last_error: Mapped[str | None] = mapped_column(Text)

    @property
    def is_pending(self) -> bool:
        return self.delivered_at is None

    __table_args__ = (
        CheckConstraint("attempts >= 0", name="ck_outbox_attempts"),
        # The worker's only query: undelivered and due, oldest first. Partial,
        # so the index stays small as delivered rows accumulate.
        Index("idx_outbox_pending", "available_at",
              postgresql_where=text("delivered_at IS NULL")),
        Index("uq_outbox_dedupe", "dedupe_key", unique=True,
              postgresql_where=text("dedupe_key IS NOT NULL")),
    )


class IdempotencyKey(BaseModel):
    """Durable replay record for a state-changing request (X-INT-01)."""
    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(String(255), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )
    endpoint: Mapped[str] = mapped_column(String(255), nullable=False)
    # The same key replayed with a DIFFERENT body is a client bug, not a
    # retry, and must be rejected rather than served the stored response.
    request_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    status_code: Mapped[int | None] = mapped_column(Integer)
    response_snapshot: Mapped[dict | None] = mapped_column(JSONB)

    __table_args__ = (
        UniqueConstraint("key", "user_id", "endpoint", name="uq_idempotency_key"),
        # For the 24h TTL sweep.
        Index("idx_idempotency_created", "created_at"),
    )
