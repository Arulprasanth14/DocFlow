"""DocFlow — AuditLog ORM Model (Immutable — no updated_at, no soft-delete)

Updated per architecture §4:
  - Added instance_id (nullable FK → workflow_instances) for workflow audit queries
  - Kept all existing fields
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AuditLog(Base):
    """
    Immutable audit log — no BaseModel inheritance.
    No updated_at, no deleted_at by design (compliance requirement).
    Every state-changing operation must log here.

    Enforced append-only at the DB level via trigger or REVOKE UPDATE, DELETE.
    Corrections require a compensating new entry, never an edit.
    """
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=func.gen_random_uuid(),
    )
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    actor_role: Mapped[str | None] = mapped_column(String(100))
    action: Mapped[str] = mapped_column(String(200), nullable=False)        # 'document.submit', etc.
    resource_type: Mapped[str] = mapped_column(String(100), nullable=False)  # 'Document', etc.
    resource_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    # Architecture §4: link audit entries to their workflow instance
    # for compliance queries like "show all events for this approval"
    instance_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_instances.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )

    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    metadata_: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", name="metadata")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    # Relationships (read-only; writes go directly via INSERT)
    workflow_instance: Mapped["WorkflowInstance | None"] = relationship(  # type: ignore[name-defined]
        "WorkflowInstance", back_populates="audit_logs", lazy="noload",
        foreign_keys=[instance_id],
    )

    __table_args__ = (
        Index("idx_audit_log_instance", "instance_id", "created_at"),
        Index("idx_audit_log_actor", "actor_id", "created_at"),
        Index("idx_audit_log_resource", "resource_type", "resource_id"),
    )

    def __repr__(self) -> str:
        return f"<AuditLog action={self.action} actor={self.actor_id} resource={self.resource_id}>"
