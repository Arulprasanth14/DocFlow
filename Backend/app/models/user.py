"""DocFlow — User and Session ORM Models

Updated per architecture §4:
  - Added coarse `role` column: 'member' | 'department_admin' | 'super_admin'
    This is the system-access role used in JWT claims and route guards.
    It does NOT distinguish requester vs. approver — that's per workflow instance.
  - Kept existing is_superadmin and RBAC system intact (OrganizationMember + Role)
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, utcnow


class User(BaseModel):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    name: Mapped[str | None] = mapped_column(String(255))
    avatar_url: Mapped[str | None] = mapped_column(Text)
    firebase_uid: Mapped[str | None] = mapped_column(String(128), unique=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(Text)

    # ── Architecture §4: coarse system-access role ─────────────────────────────
    # 'member' | 'department_admin' | 'super_admin'
    # This does NOT determine who is a requester vs. approver on a workflow —
    # that is per-instance, determined by WorkflowStage.StageApproverRule.
    role: Mapped[str] = mapped_column(String(50), default="member", nullable=False, index=True)

    # Legacy — kept for backward compatibility; superseded by `role`
    is_superadmin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # User lifecycle
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="active", nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notification_prefs: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    # Optional: which department this user belongs to (matches architecture §4)
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id", use_alter=True, name="fk_user_department"), nullable=True, index=True,
    )

    # Relationships
    sessions: Mapped[list["Session"]] = relationship(
        "Session", back_populates="user", lazy="noload", cascade="all, delete-orphan"
    )
    memberships: Mapped[list["OrganizationMember"]] = relationship(  # type: ignore[name-defined]
        "OrganizationMember", back_populates="user", lazy="noload"
    )


class Session(BaseModel):
    """
    DocFlow session — each row represents one device/browser login.

    The `session_token` (sid) is embedded in the JWT as the `sid` claim.
    Revoking a session (setting revoked_at) invalidates all JWTs with
    that sid — including open WebSocket connections.
    """
    __tablename__ = "sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # This IS the `sid` JWT claim — used for instant revocation
    session_token: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    device_info: Mapped[dict | None] = mapped_column(JSONB)
    ip_address: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(Text)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    user: Mapped["User"] = relationship("User", back_populates="sessions", lazy="noload")

    @property
    def is_valid(self) -> bool:
        """Check if session is still valid (not revoked, not expired)."""
        from datetime import timezone
        now = datetime.now(timezone.utc)
        return self.revoked_at is None and self.expires_at > now

    def revoke(self) -> None:
        self.revoked_at = utcnow()
