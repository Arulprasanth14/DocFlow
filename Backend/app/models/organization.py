"""DocFlow — Organization, Department, Team, Role, Permission ORM Models"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, utcnow


class Organization(BaseModel):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    logo_url: Mapped[str | None] = mapped_column(Text)
    settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    plan: Mapped[str] = mapped_column(String(50), nullable=False, default="trial")
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="active")

    # Relationships
    departments: Mapped[list["Department"]] = relationship(
        "Department", back_populates="organization", lazy="noload"
    )
    roles: Mapped[list["Role"]] = relationship(
        "Role", back_populates="organization", lazy="noload"
    )
    members: Mapped[list["OrganizationMember"]] = relationship(
        "OrganizationMember", back_populates="organization", lazy="noload"
    )


class Department(BaseModel):
    __tablename__ = "departments"
    __table_args__ = (UniqueConstraint("org_id", "code", name="uq_dept_org_code"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    head_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", use_alter=True, name="fk_department_head"), nullable=True
    )

    organization: Mapped["Organization"] = relationship(
        "Organization", back_populates="departments", lazy="noload"
    )
    children: Mapped[list["Department"]] = relationship(
        "Department", back_populates="parent", lazy="noload"
    )
    parent: Mapped["Department | None"] = relationship(
        "Department", back_populates="children", remote_side="Department.id", lazy="noload"
    )


class Team(BaseModel):
    __tablename__ = "teams"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    dept_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)


class Role(BaseModel):
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("org_id", "name", name="uq_role_org_name"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    organization: Mapped["Organization"] = relationship(
        "Organization", back_populates="roles", lazy="noload"
    )
    permissions: Mapped[list["RolePermission"]] = relationship(
        "RolePermission", back_populates="role", lazy="noload", cascade="all, delete-orphan"
    )
    members: Mapped[list["OrganizationMember"]] = relationship(
        "OrganizationMember", back_populates="role", lazy="noload"
    )


class Permission(BaseModel):
    __tablename__ = "permissions"

    code: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(50))  # 'documents', 'workflows', 'admin'


class RolePermission(BaseModel):
    __tablename__ = "role_permissions"

    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("roles.id", ondelete="CASCADE"), nullable=False
    )
    permission_code: Mapped[str] = mapped_column(
        String(100), ForeignKey("permissions.code", ondelete="CASCADE"), nullable=False
    )

    role: Mapped["Role"] = relationship("Role", back_populates="permissions", lazy="noload")


class OrganizationMember(BaseModel):
    __tablename__ = "organization_members"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_org_member"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("roles.id"), nullable=False
    )
    dept_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True
    )
    team_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("teams.id"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="active")
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    organization: Mapped["Organization"] = relationship(
        "Organization", back_populates="members", lazy="noload"
    )
    role: Mapped["Role"] = relationship("Role", back_populates="members", lazy="noload")
    user: Mapped["User"] = relationship("User", back_populates="memberships", lazy="noload")
