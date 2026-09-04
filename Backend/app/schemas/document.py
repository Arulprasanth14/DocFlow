"""
DocFlow Backend — Document Pydantic Schemas
Request/response contracts for Document Types, Documents, Versions, Comments, and Attachments.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


# ── Form Field Schema ─────────────────────────────────────────────────────────

class FormFieldSchema(BaseModel):
    key: str = Field(..., description="Unique field key in form_data JSONB")
    label: str = Field(..., description="Display label for form rendering")
    type: str = Field(..., description="Field type: 'text', 'number', 'date', 'select', 'textarea', 'checkbox'")
    required: bool = Field(default=False)
    options: list[str] | None = Field(default=None, description="Options for 'select' field type")
    placeholder: str | None = None
    default: Any | None = None


# ── Document Type ─────────────────────────────────────────────────────────────

class DocumentTypeCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    code: str = Field(..., min_length=1, max_length=100)
    description: str | None = None
    category: str | None = Field(default="General", max_length=100)
    icon: str | None = Field(default="file", max_length=50)
    color: str | None = Field(default="blue", max_length=20)
    form_schema: list[FormFieldSchema] = Field(default=[])
    metadata_schema: dict[str, Any] = Field(default={})
    retention_days: int | None = None

    model_config = {"extra": "ignore"}


class DocumentTypeUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    code: str | None = Field(default=None, max_length=100)
    description: str | None = None
    category: str | None = None
    icon: str | None = None
    color: str | None = None
    form_schema: list[FormFieldSchema] | None = None
    metadata_schema: dict[str, Any] | None = None
    is_active: bool | None = None
    retention_days: int | None = None

    model_config = {"extra": "ignore"}


class DocumentTypeResponse(BaseModel):
    id: UUID
    org_id: UUID
    name: str
    code: str
    description: str | None
    category: str | None
    icon: str | None
    color: str | None
    form_schema: list[FormFieldSchema]
    metadata_schema: dict[str, Any]
    is_active: bool
    retention_days: int | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Document Version ──────────────────────────────────────────────────────────

class DocumentVersionResponse(BaseModel):
    id: UUID
    document_id: UUID
    version_num: int
    title: str
    form_data: dict[str, Any]
    changed_by: UUID
    changer_name: str | None = None
    change_reason: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Comments & Mentions ───────────────────────────────────────────────────────

class MentionResponse(BaseModel):
    user_id: UUID
    user_name: str | None = None

    model_config = {"from_attributes": True}


class CommentCreateRequest(BaseModel):
    body: str = Field(..., min_length=1)
    parent_id: UUID | None = None
    is_internal: bool = Field(default=False)
    mention_user_ids: list[UUID] = Field(default=[])

    model_config = {"extra": "ignore"}


class CommentUpdateRequest(BaseModel):
    body: str | None = None
    is_resolved: bool | None = None

    model_config = {"extra": "ignore"}


class CommentResponse(BaseModel):
    id: UUID
    document_id: UUID
    parent_id: UUID | None
    body: str
    author_id: UUID
    author_name: str | None = None
    author_email: str | None = None
    author_avatar: str | None = None
    is_internal: bool
    resolved_at: datetime | None
    created_at: datetime
    updated_at: datetime
    replies: list[CommentResponse] = []
    mentions: list[MentionResponse] = []

    model_config = {"from_attributes": True}


CommentResponse.model_rebuild()


# ── Document Attachments ──────────────────────────────────────────────────────

class AttachmentCreateRequest(BaseModel):
    file_asset_id: UUID
    label: str | None = None


class AttachmentResponse(BaseModel):
    id: UUID
    document_id: UUID
    file_asset_id: UUID
    label: str | None
    attached_by: UUID
    attacher_name: str | None = None
    filename: str
    mime_type: str
    size_bytes: int
    preview_url: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Documents ─────────────────────────────────────────────────────────────────

class DocumentCreateRequest(BaseModel):
    doc_type_id: UUID
    title: str = Field(..., min_length=1, max_length=500)
    priority: str = Field(default="normal", description="low, normal, high, urgent")
    form_data: dict[str, Any] = Field(default={})
    metadata_: dict[str, Any] = Field(default={}, alias="metadata")
    dept_id: UUID | None = None
    due_at: datetime | None = None
    submit_immediately: bool = Field(default=False, description="If true, sets status to submitted instead of draft")

    model_config = {"extra": "ignore", "populate_by_name": True}


class DocumentUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    priority: str | None = None
    form_data: dict[str, Any] | None = None
    metadata_: dict[str, Any] | None = Field(default=None, alias="metadata")
    dept_id: UUID | None = None
    due_at: datetime | None = None
    change_reason: str | None = Field(default=None, description="Reason for version history")

    model_config = {"extra": "ignore", "populate_by_name": True}


class DocumentSubmitRequest(BaseModel):
    change_reason: str | None = Field(default="Submitted document", description="Version reason")


class DocumentResponse(BaseModel):
    id: UUID
    org_id: UUID
    doc_type_id: UUID
    doc_type_name: str
    doc_type_code: str
    dept_id: UUID | None
    public_id: str
    title: str
    status: str
    priority: str
    form_data: dict[str, Any]
    metadata_: dict[str, Any] = Field(..., alias="metadata")
    submitted_by: UUID
    submitter_name: str | None = None
    submitter_email: str | None = None
    submitted_at: datetime | None
    due_at: datetime | None
    created_at: datetime
    updated_at: datetime
    attachment_count: int = 0
    comment_count: int = 0
    version_count: int = 1

    model_config = {"from_attributes": True, "populate_by_name": True}


class PaginatedDocumentsResponse(BaseModel):
    items: list[DocumentResponse]
    total: int
    page: int
    limit: int
    pages: int
