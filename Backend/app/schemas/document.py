"""
DocFlow Backend — Document Pydantic Schemas
Request/response contracts for Document Types, Documents, Versions, Comments, and Attachments.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field

from app.models.document import DocumentStatus

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


# ── Document Templates ────────────────────────────────────────────────────────

class WatcherResponse(BaseModel):
    """Someone CC'd on a document (FR-13.4)."""
    id: UUID
    user_id: UUID
    name: str | None = None
    email: str | None = None
    added_by: UUID
    added_by_name: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class WatcherAddRequest(BaseModel):
    user_id: UUID


class WatcherCandidateResponse(BaseModel):
    """
    A colleague who can be added as a watcher.

    Deliberately only id/name/email: this endpoint is open to any member who
    can open the document, so it must not become a way to read the org's
    roles, departments or activity.
    """
    user_id: UUID
    name: str | None = None
    email: str | None = None


class DocumentTemplateCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    default_field_values: dict[str, Any] = Field(default={})

    model_config = {"extra": "ignore"}


class DocumentTemplateResponse(BaseModel):
    id: UUID
    org_id: UUID
    doc_type_id: UUID
    name: str
    default_field_values: dict[str, Any]
    created_by: UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Documents ─────────────────────────────────────────────────────────────────

class DocumentCreateRequest(BaseModel):
    doc_type_id: UUID
    title: str = Field(..., min_length=1, max_length=500)
    priority: str = Field(default="normal", description="low, normal, high, urgent")
    tags: list[str] = Field(default=[])
    form_data: dict[str, Any] = Field(default={})
    metadata_: dict[str, Any] = Field(default={}, alias="metadata")
    dept_id: UUID | None = None
    due_at: datetime | None = None
    submit_immediately: bool = Field(default=False, description="If true, sets status to submitted instead of draft")
    # Documents module: how the draft was started (TEMPLATE | BLANK | UPLOAD).
    source: str | None = Field(default=None, description="template | blank | upload")
    confidentiality: str | None = Field(default=None, description="public | internal | confidential")
    current_step: str | None = Field(default=None, description="Wizard/editor step to resume at")
    # Start from a Template Studio template: the server pins the template's
    # CURRENT PUBLISHED version so a later edit can't change this document
    # (spec C9 / FR-11.5). The client sends the template id, never a version id.
    template_id: UUID | None = Field(default=None, description="Template Studio template to fill")

    model_config = {"extra": "ignore", "populate_by_name": True}


class DocumentUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    priority: str | None = None
    tags: list[str] | None = None
    form_data: dict[str, Any] | None = None
    metadata_: dict[str, Any] | None = Field(default=None, alias="metadata")
    dept_id: UUID | None = None
    due_at: datetime | None = None
    confidentiality: str | None = None
    current_step: str | None = None
    change_reason: str | None = Field(default=None, description="Reason for version history")
    # ── Submission details (FR-13.4) ──────────────────────────────────────
    # `None` means "not supplied, leave alone". Clearing a date therefore
    # needs an explicit sentinel, which the UI sends as the empty string —
    # see DocumentService.update_document.
    category: str | None = Field(default=None, max_length=100)
    effective_from: datetime | None = None
    expires_at: datetime | None = None
    reminder_days_before: int | None = Field(default=None, ge=0, le=365)
    # Explicitly clear a date or the reminder (the UI's "no expiry" choice),
    # because a null above is indistinguishable from "unchanged".
    clear_fields: list[str] | None = Field(
        default=None,
        description="Detail fields to null out: effective_from, expires_at, reminder_days_before, category",
    )

    model_config = {"extra": "ignore", "populate_by_name": True}


class DocumentContentResponse(BaseModel):
    """Editable body of a document (spec §9 DocumentContent)."""
    document_id: UUID
    content: dict[str, Any] = Field(default_factory=dict)
    answers: dict[str, Any] = Field(default_factory=dict)
    rendered_snapshot_url: str | None = None
    pdf_url: str | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class DocumentContentUpdateRequest(BaseModel):
    """Autosave for the freeform editor / template answers. Partial is fine."""
    content: dict[str, Any] | None = None
    answers: dict[str, Any] | None = None

    model_config = {"extra": "ignore"}


class DocumentFillFieldSchema(BaseModel):
    """One question in the pinned template version (spec §21.2)."""
    key: str
    label: str
    type: str = "text"
    required: bool = False
    help_text: str | None = None
    example: str | None = None
    default_value: Any | None = None
    validation: dict[str, Any] = Field(default_factory=dict)
    format: str | None = None
    options: list[Any] = Field(default_factory=list)
    if_empty_behavior: str = "keep_blank"
    order_index: int = 0
    section: str | None = None


class DocumentFillSchemaResponse(BaseModel):
    """
    Everything Form Fill needs, read from the version the document is PINNED to
    (FR-12.x / C9) rather than from the template's current state — so editing,
    archiving or deleting the template cannot change a document being filled.
    """
    #: None when the questions were read from a template rather than a
    #: document — the FR-12.1 case, where no draft exists yet.
    document_id: UUID | None = None
    template_id: UUID | None = None
    template_version_id: UUID | None = None
    template_name: str | None = None
    version_no: int | None = None
    content: dict[str, Any] = Field(default_factory=dict)
    fields: list[DocumentFillFieldSchema] = Field(default_factory=list)
    answers: dict[str, Any] = Field(default_factory=dict)
    # True when the template this was pinned to has since been deleted; the
    # document still fills correctly from its pinned snapshot.
    template_deleted: bool = False


class DocumentSubmitRequest(BaseModel):
    change_reason: str | None = Field(default="Submitted document", description="Version reason")
    workflow_template_id: UUID | None = Field(
        default=None,
        description=(
            "Which WorkflowTemplate to start. If omitted, the DocumentType's default "
            "template is used. If neither is configured, submit returns 422."
        ),
    )


class DocumentResponse(BaseModel):
    id: UUID
    org_id: UUID
    doc_type_id: UUID
    doc_type_name: str
    doc_type_code: str
    dept_id: UUID | None
    public_id: str
    title: str
    status: DocumentStatus
    priority: str
    tags: list[str]
    form_data: dict[str, Any]
    metadata_: dict[str, Any] = Field(..., alias="metadata")
    submitted_by: UUID
    submitter_name: str | None = None
    submitter_email: str | None = None
    submitted_at: datetime | None
    due_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # Documents module (Phase 1): wizard/autosave fields.
    source: str = "template"
    confidentiality: str | None = None
    current_step: str | None = None
    template_version_id: UUID | None = None
    version: int = 1
    # Submission details (FR-13.4).
    category: str | None = None
    effective_from: datetime | None = None
    expires_at: datetime | None = None
    reminder_days_before: int | None = None
    reminder_sent_at: datetime | None = None
    watcher_count: int = 0
    attachment_count: int = 0
    comment_count: int = 0
    version_count: int = 1
    # The most recent ApprovalStep for this document's latest workflow instance,
    # if any — lets the frontend open WorkflowChatPanel (pinned to a step id)
    # without a separate document->instance->step lookup round-trip.
    current_approval_step_id: UUID | None = None
    # Lets the frontend call POST /workflow-instances/{id}/cancel without a
    # separate lookup — useCancelWorkflow() existed and worked against the
    # backend, but no page could call it without this.
    current_workflow_instance_id: UUID | None = None

    model_config = {"from_attributes": True, "populate_by_name": True}


class PaginatedDocumentsResponse(BaseModel):
    """
    FR-1.4 / spec §25.1 — keyset (cursor) pagination.

    `next_cursor` is the forward-only cursor; null means "no more rows".
    `total` is a count of the whole filtered set and is only computed for a
    request with no cursor, because counting on every page of a 100k-row
    table is exactly the cost keyset pagination exists to avoid. On a
    cursor request it is echoed back as -1, meaning "not counted".
    """
    items: list[DocumentResponse]
    total: int
    page: int
    limit: int
    pages: int
    next_cursor: str | None = None


class DocumentPDFStateResponse(BaseModel):
    """
    FR-13.8 — state of the frozen snapshot's PDF.

    `status`: None (never requested) | 'pending' | 'ready' | 'failed'.
    `download_url` is a short-lived presigned URL, present only when ready.
    `checksum` is the SHA-256 of the PDF bytes; because rendering is
    deterministic, re-rendering the same snapshot reproduces it, so the
    artefact can be proven to match what was submitted.
    `available` is False when the deployment has not applied the migration
    that adds these columns, letting the UI stay silent rather than show a
    control that cannot work.
    """

    status: str | None = None
    checksum: str | None = None
    rendered_at: datetime | None = None
    error: str | None = None
    download_url: str | None = None
    available: bool = True
    has_snapshot: bool = False


# ── Submission pre-flight (spec FR-13, §25.4) ─────────────────────────────────

class FieldProblemSchema(BaseModel):
    """One blocked (or flagged) field, in the shape the UI points at."""
    field: str
    code: str
    message: str


class SubmitCheckRequest(BaseModel):
    """
    Ask whether a draft may move past `stage`.

    'write' checks the document body only; each later stage includes the ones
    before it, so 'confirm' is the whole submission. The workflow id is the
    one currently selected in the wizard, which may not be saved yet.
    """
    stage: str = Field(default="confirm", description="write | workflow | details | confirm")
    workflow_template_id: UUID | None = None


class SubmitCheckResponse(BaseModel):
    """`ok` is false when anything blocks. Warnings never block."""
    ok: bool
    errors: list[FieldProblemSchema] = Field(default_factory=list)
    warnings: list[FieldProblemSchema] = Field(default_factory=list)
