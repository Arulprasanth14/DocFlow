"""
DocFlow — SLAEvent ORM Model

Tracks the SLA lifecycle for each ApprovalStep:
  started → reminder_sent → escalated → breached

This is an append-only audit table for SLA compliance reporting.
Written by the background SLAWorker cron sweep.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class SLAEvent(Base):
    """
    Immutable SLA lifecycle record — no BaseModel (no updated_at, no soft-delete).
    event_type values: 'started' | 'reminder_sent' | 'escalated' | 'breached'
    """
    __tablename__ = "sla_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=func.gen_random_uuid(),
    )
    approval_step_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approval_steps.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # 'started' | 'reminder_sent' | 'escalated' | 'breached'
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    metadata_: Mapped[dict] = mapped_column(
        JSONB, default=dict, server_default="{}", name="metadata",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    approval_step: Mapped["ApprovalStep"] = relationship(  # type: ignore[name-defined]
        "ApprovalStep", back_populates="sla_events", lazy="noload",
    )

    def __repr__(self) -> str:
        return f"<SLAEvent step={self.approval_step_id} type={self.event_type}>"
