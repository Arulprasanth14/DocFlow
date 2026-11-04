"""DocFlow — Template Studio ORM models (Documents module, Phase 2).

Spec §9 data model. These are the versioned, form-driven templates authored in the
Template Studio — distinct from the lightweight `DocumentTemplate` (name + default
field values) that already exists. A Template has many TemplateVersions; the current
published version carries the editor content, its TemplateFields (one per unique
placeholder key) and PlaceholderOccurrences (each blank's stable node id in the content).

ADDITIVE ONLY — new tables, no changes to existing ones. Scope/status are stored as
VARCHAR (not native PG enums) to match the DocumentStatus convention and keep future
value additions migration-free.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel


class TemplateScope(str, enum.Enum):
    SYSTEM = "system"   # admin-authored, visible org-wide
    USER = "user"       # private to its owner
    TEAM = "team"       # Phase 4 — shared with a team


class TemplateStatus(str, enum.Enum):
    DRAFT = "draft"
    PUBLISHED = "published"
    ARCHIVED = "archived"


class Template(BaseModel):
    __tablename__ = "templates"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Null for SYSTEM templates; set for USER (and later TEAM) templates.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True
    )
    scope: Mapped[str] = mapped_column(String(20), default="user", server_default="user", nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(100))
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=list, server_default="{}")
    icon: Mapped[str | None] = mapped_column(String(50))
    color: Mapped[str | None] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="draft", server_default="draft", nullable=False)
    usage_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("template_versions.id", use_alter=True, name="fk_template_current_version"),
        nullable=True,
    )

    versions: Mapped[list["TemplateVersion"]] = relationship(
        "TemplateVersion",
        back_populates="template",
        lazy="noload",
        cascade="all, delete-orphan",
        foreign_keys="TemplateVersion.template_id",
    )


class TemplateVersion(BaseModel):
    __tablename__ = "template_versions"
    __table_args__ = (UniqueConstraint("template_id", "version_no", name="uq_template_version"),)

    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("templates.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    # Editor document JSON (TipTap/ProseMirror doc with structured placeholder nodes).
    content: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    # Page size / orientation / margins for the print-layout canvas.
    page_settings: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    thumbnail_url: Mapped[str | None] = mapped_column(Text)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # If imported from an uploaded file, the source FileAsset (retained for audit).
    source_file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("file_assets.id", ondelete="SET NULL"), nullable=True
    )

    template: Mapped["Template"] = relationship(
        "Template", back_populates="versions", lazy="noload", foreign_keys=[template_id]
    )
    fields: Mapped[list["TemplateField"]] = relationship(
        "TemplateField", back_populates="version", lazy="noload", cascade="all, delete-orphan"
    )
    occurrences: Mapped[list["PlaceholderOccurrence"]] = relationship(
        "PlaceholderOccurrence", back_populates="version", lazy="noload", cascade="all, delete-orphan"
    )


class TemplateField(BaseModel):
    """One question per unique placeholder key in a template version (spec §21.2)."""
    __tablename__ = "template_fields"
    __table_args__ = (UniqueConstraint("template_version_id", "key", name="uq_template_field_key"),)

    template_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("template_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    key: Mapped[str] = mapped_column(String(64), nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(String(30), nullable=False, default="text")
    required: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    help_text: Mapped[str | None] = mapped_column(Text)
    example: Mapped[str | None] = mapped_column(Text)
    default_value: Mapped[dict | None] = mapped_column(JSONB)
    validation: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    format: Mapped[str | None] = mapped_column(String(50))
    options: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    if_empty_behavior: Mapped[str] = mapped_column(String(20), default="keep_blank", server_default="keep_blank", nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    section: Mapped[str | None] = mapped_column(String(120))

    version: Mapped["TemplateVersion"] = relationship(
        "TemplateVersion", back_populates="fields", lazy="noload"
    )


class PlaceholderOccurrence(BaseModel):
    """Each individual blank in the content; many may share one field_key (spec §21.1)."""
    __tablename__ = "placeholder_occurrences"

    template_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("template_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    field_key: Mapped[str] = mapped_column(String(64), nullable=False)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)  # stable id in content JSON
    order_no: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)

    version: Mapped["TemplateVersion"] = relationship(
        "TemplateVersion", back_populates="occurrences", lazy="noload"
    )


class TemplateFavourite(BaseModel):
    """
    A per-user favourite (FR-5.3, and the gallery's Favourites tab FR-2.3).

    Server-side rather than localStorage: a favourite has to follow the user
    across devices and browsers, and the gallery filters on it in-query.
    """
    __tablename__ = "template_favourites"
    __table_args__ = (UniqueConstraint("user_id", "template_id", name="uq_template_favourite"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("templates.id", ondelete="CASCADE"), nullable=False, index=True
    )
