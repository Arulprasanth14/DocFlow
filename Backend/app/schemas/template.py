"""
DocFlow Backend — Template Studio Pydantic Schemas (Documents module, Phase 2)

Contracts for the versioned, form-driven templates authored in the Template
Studio (spec §10 API outline, §21.2 field definition). Distinct from the
WorkflowTemplate schemas in `schemas/workflow.py`.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


# ── Field definition (spec §21.2) ─────────────────────────────────────────────

class TemplateFieldSchema(BaseModel):
    key: str = Field(..., min_length=1, max_length=64, description="lower_snake_case field key")
    label: str = Field(..., min_length=1, description="Question shown to the person filling it in")
    type: str = Field(default="text", max_length=30)
    required: bool = False
    help_text: str | None = None
    example: str | None = None
    default_value: Any | None = None
    validation: dict[str, Any] = Field(default_factory=dict)
    format: str | None = None
    options: list[Any] = Field(default_factory=list)
    if_empty_behavior: str = Field(default="keep_blank", description="keep_blank | remove_phrase")
    order_index: int = 0
    section: str | None = None

    model_config = {"extra": "ignore"}


class PlaceholderOccurrenceSchema(BaseModel):
    """One blank in the content; several may share a field_key (spec §21.1)."""
    field_key: str = Field(..., max_length=64)
    node_id: str = Field(..., max_length=64)
    order_no: int = 0

    model_config = {"extra": "ignore"}


# ── Requests ──────────────────────────────────────────────────────────────────

class TemplateCreateRequest(BaseModel):
    name: str = Field(default="Untitled template", min_length=1, max_length=255)
    description: str | None = None
    category: str | None = Field(default=None, max_length=100)
    tags: list[str] = Field(default_factory=list)
    icon: str | None = Field(default=None, max_length=50)
    color: str | None = Field(default=None, max_length=20)
    scope: str = Field(default="user", description="user | system (system requires admin)")

    model_config = {"extra": "ignore"}


class TemplateUpdateRequest(BaseModel):
    """Autosave payload — any subset. Draft data may be partial/invalid (FR-14.4)."""
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    icon: str | None = None
    color: str | None = None
    # Editor document JSON + page setup for the current draft version.
    content: dict[str, Any] | None = None
    page_settings: dict[str, Any] | None = None
    # Full replacement sets when supplied (the editor owns the whole list).
    fields: list[TemplateFieldSchema] | None = None
    placeholders: list[PlaceholderOccurrenceSchema] | None = None

    model_config = {"extra": "ignore"}


class TemplatePublishRequest(BaseModel):
    """Metadata captured at publish time (FR-11.3)."""
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    category: str | None = Field(default=None, max_length=100)
    tags: list[str] | None = None
    icon: str | None = Field(default=None, max_length=50)
    color: str | None = Field(default=None, max_length=20)

    model_config = {"extra": "ignore"}


class SaveAsTemplateRequest(BaseModel):
    """FR-5.4 — turn an existing document into a reusable template."""
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    category: str | None = Field(default=None, max_length=100)

    model_config = {"extra": "ignore"}


# ── Responses ─────────────────────────────────────────────────────────────────

class TemplateSummaryResponse(BaseModel):
    id: UUID
    org_id: UUID
    owner_id: UUID | None
    scope: str
    name: str
    description: str | None
    category: str | None
    tags: list[str]
    icon: str | None
    color: str | None
    status: str
    usage_count: int
    field_count: int = 0
    version_no: int | None = None
    is_owner: bool = False
    is_favourite: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TemplateDetailResponse(TemplateSummaryResponse):
    version_id: UUID | None = None
    content: dict[str, Any] = Field(default_factory=dict)
    page_settings: dict[str, Any] = Field(default_factory=dict)
    fields: list[TemplateFieldSchema] = Field(default_factory=list)
    placeholders: list[PlaceholderOccurrenceSchema] = Field(default_factory=list)


class PublishIssue(BaseModel):
    rule: str
    field_key: str | None = None
    message: str


class TemplateVersionSummary(BaseModel):
    """One entry in a template's version history (FR-14.8)."""

    id: UUID
    version_no: int
    is_published: bool
    #: True for the version new documents are currently pinned to.
    is_current: bool
    field_count: int
    published_at: datetime | None = None
    created_at: datetime


# ── Rule-based blank detection (FR-7.2 / FR-9.3) ──────────────────────────────

class DetectBlanksRequest(BaseModel):
    """The live editor body. Sent rather than read from the row so the author
    can detect blanks in text they have typed but not yet autosaved."""
    content: dict = Field(default_factory=dict)


class SkippedBlank(BaseModel):
    original: str
    reason: str


class DetectedField(BaseModel):
    key: str
    label: str
    type: str


class DetectBlanksResponse(BaseModel):
    """The body rewritten with placeholder nodes in place, plus what was found."""
    content: dict
    found: int
    skipped: list[SkippedBlank] = Field(default_factory=list)
    fields: list[DetectedField] = Field(default_factory=list)
