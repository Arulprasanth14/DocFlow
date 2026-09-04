"""DocFlow — Notification ORM Model

Updated per architecture §4 §7:
  - Added instance_id (nullable FK → workflow_instances) for workflow notifications
  - deep_link field (renamed from link) for frontend navigation
  - type enum aligned to architecture: assigned, approved, rejected,
    changes_requested, sla_breach_warning, escalated, new_message
"""
from __future__ import annotations

import uuid

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, utcnow
from datetime import datetime


class Notification(BaseModel):
    __tablename__ = "notifications"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    # Optional FK to the workflow instance that triggered this notification
    # NULL for general chat notifications and system notifications
    instance_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_instances.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    # Architecture §4 type values:
    # 'assigned' | 'approved' | 'rejected' | 'changes_requested' |
    # 'sla_breach_warning' | 'escalated' | 'new_message'
    # Also supported: 'delegated', 'mention', 'system'
    type: Mapped[str] = mapped_column(String(100), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    # deep_link: frontend route to navigate to on click (architecture §4)
    deep_link: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", name="metadata")
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Relationships
    workflow_instance: Mapped["WorkflowInstance | None"] = relationship(  # type: ignore[name-defined]
        "WorkflowInstance", back_populates="notifications", lazy="noload",
        foreign_keys=[instance_id],
    )

    def mark_read(self) -> None:
        self.read_at = utcnow()

    @property
    def is_read(self) -> bool:
        return self.read_at is not None
