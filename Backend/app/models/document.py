"""DocFlow — Document, DocumentType, DocumentVersion, FileAsset, DocumentAttachment, Comment, Mention ORM Models

Updated per architecture §4:
  - DocumentVersion now tracks binary file versions with storage_key, checksum,
    file_size, mime_type, uploaded_by, uploaded_at, supersedes_version_id
    (form_data snapshots are preserved alongside)
  - Document gains current_version_id and retention_policy
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    CheckConstraint,
    Index,
    text,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, utcnow

# Type-only imports: relationships are resolved by SQLAlchemy from the string
# class names at runtime, so these must not be imported eagerly (circular).
if TYPE_CHECKING:
    from app.models.user import User  # noqa: F401
    from app.models.workflow import WorkflowInstance, WorkflowTemplate  # noqa: F401


class DocumentStatus(str, enum.Enum):
    """
    Document lifecycle states.

    Requirements report §5.5 asks for: Draft, Ready for Submission, In
    Approval, Changes Requested, Approved, Rejected, Revoked/Returned for
    Correction, and Closed/Finalized. Mapping to this enum:
      Draft                        → DRAFT
      Ready for Submission         → READY
      In Approval                  → PENDING (SUBMITTED is the transient
                                      "handed to the workflow engine" state)
      Changes Requested            → SENT_BACK
      Approved                     → APPROVED
      Rejected                     → REJECTED
      Revoked/Returned for Corr.   → REVOKED
      Closed/Finalized             → FINALIZED

    The `status` column is VARCHAR(50) (not a native Postgres enum type —
    see alembic/versions/..._workflow_approvals_phase2_gaps.py's own
    docstring), so adding values here needs no migration.
    """
    DRAFT = "draft"
    # §5.5 "Ready for Submission" — prepared/reviewed but not yet routed
    READY = "ready"
    SUBMITTED = "submitted"
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    SENT_BACK = "sent_back"
    # §6.5 an approval was revoked/recalled and the document is back with its
    # owner for correction — distinct from SENT_BACK (a normal
    # changes-requested round) so revocation is visibly its own path.
    REVOKED = "revoked"
    # §6.2/6.6 explicitly finalized by the authorized final approver. Only
    # reachable from APPROVED, and only via the explicit finalize action.
    FINALIZED = "finalized"
    ARCHIVED = "archived"
    EXPIRED = "expired"
    # Added: WorkflowService.cancel() referenced DocumentStatus.CANCELLED,
    # which didn't exist — every workflow-cancel call raised AttributeError.
    CANCELLED = "cancelled"


class DocumentType(BaseModel):
    __tablename__ = "document_types"
    __table_args__ = (UniqueConstraint("org_id", "code", name="uq_doc_type_org_code"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[str] = mapped_column(String(100), nullable=False)     # 'leave_request', 'purchase_order'
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(100))           # 'HR', 'Finance', 'Legal'
    icon: Mapped[str | None] = mapped_column(String(50))
    color: Mapped[str | None] = mapped_column(String(20))
    form_schema: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    metadata_schema: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    retention_days: Mapped[int | None] = mapped_column(Integer)

    documents: Mapped[list["Document"]] = relationship(
        "Document", back_populates="doc_type", lazy="noload"
    )
    workflow_templates: Mapped[list["WorkflowTemplate"]] = relationship(  # type: ignore[name-defined]
        "WorkflowTemplate", back_populates="doc_type", lazy="noload"
    )
    templates: Mapped[list["DocumentTemplate"]] = relationship(
        "DocumentTemplate", back_populates="doc_type", lazy="noload", cascade="all, delete-orphan"
    )

class DocumentTemplate(BaseModel):
    __tablename__ = "document_templates"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    doc_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("document_types.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    default_field_values: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )

    doc_type: Mapped["DocumentType"] = relationship(
        "DocumentType", back_populates="templates", lazy="noload"
    )
    creator: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", lazy="noload"
    )


class Document(BaseModel):
    __tablename__ = "documents"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    doc_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("document_types.id"), nullable=False, index=True
    )
    dept_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True, index=True
    )
    public_id: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)  # DOC-2024-00001
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[DocumentStatus] = mapped_column(
        Enum(DocumentStatus, name="documentstatus", native_enum=False, create_constraint=False),
        default=DocumentStatus.DRAFT,
        nullable=False,
    )
    priority: Mapped[str] = mapped_column(String(20), default="normal", nullable=False)
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=list, server_default="{}")

    # ── Documents module (spec §9 / FR-13.9 / §24.4) ──────────────────────────
    # How the document was started: TEMPLATE | BLANK | UPLOAD. Lets the
    # submission wizard skip the Form-Fill step for blank/uploaded docs.
    source: Mapped[str] = mapped_column(
        String(20), default="template", server_default="template", nullable=False
    )
    # Public | Internal | Confidential (FR-13.4). Nullable = not yet chosen.
    confidentiality: Mapped[str | None] = mapped_column(String(20))
    # Resume the wizard/editor at the exact step for a draft (FR-1.9 / FR-14.5).
    current_step: Mapped[str | None] = mapped_column(String(30))
    # Pins the document to the exact TemplateVersion it was built from, so a
    # later edit or deletion of the template cannot change or break it
    # (spec C9 / FR-11.5). SET NULL on delete: losing the template must not
    # cascade into the document — the answers and snapshot stay valid.
    # Column added by migration b1c2d3e4f5a6 (applied).
    template_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("template_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Optimistic-locking counter for autosave: the client sends the version it
    # last saw in `If-Match`; a stale value is rejected with 409
    # VERSION_CONFLICT (spec §24.1/§24.4, FR-14.6). Plain counter — not wired to
    # SQLAlchemy's mapper-level version_id_col, so ordinary writes are unaffected.
    version: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1", nullable=False
    )

    # Architecture §4: pointer to the current active version
    # (nullable until first version is uploaded)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("document_versions.id", use_alter=True, name="fk_doc_current_version"),
        nullable=True,
    )

    # Compliance retention (e.g., '7years', 'permanent', 'gdpr_erasable')
    retention_policy: Mapped[str | None] = mapped_column(String(100))

    # Content
    form_data: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    metadata_: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", name="metadata")
    content_text: Mapped[str | None] = mapped_column(Text)                              # plain text for FTS
    search_vector: Mapped[str | None] = mapped_column(TSVECTOR)                        # GIN-indexed FTS vector

    # Ownership — 'submitted_by' kept as alias; architecture calls this 'owner_id'
    submitted_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # SLA
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    # Snapshot (frozen at submit time)
    submitter_snapshot: Mapped[dict | None] = mapped_column(JSONB)

    # ── Submission details (spec FR-13.4) ─────────────────────────────────────
    # Columns added by migration c7d8e9f0a1b2 (applied). All nullable: an
    # existing document reads as "no category, no dates, no reminder", which
    # is exactly its behaviour before the migration.
    #
    # Free text, not a foreign key: the spec treats category as a label, and a
    # lookup table would need an admin screen nobody asked for. The UI offers
    # the org's existing values as suggestions without restricting the input.
    category: Mapped[str | None] = mapped_column(String(100))
    # When the document takes effect, which may be well after approval, and
    # when it stops applying. Independent of due_at (an SLA for the approvers)
    # and of submitted_at.
    effective_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Remind the owner and watchers this many days before `expires_at`.
    # NULL = no reminder wanted.
    reminder_days_before: Mapped[int | None] = mapped_column(Integer)
    # Stamped when that reminder goes out, so the daily sweep cannot send the
    # same reminder twice. Cleared whenever the expiry date or the reminder
    # preference changes, otherwise a rescheduled expiry would never remind.
    reminder_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Relationships
    doc_type: Mapped["DocumentType"] = relationship(
        "DocumentType", back_populates="documents", lazy="noload"
    )
    submitter: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", lazy="noload", foreign_keys=[submitted_by]
    )
    current_version: Mapped["DocumentVersion | None"] = relationship(
        "DocumentVersion",
        foreign_keys=[current_version_id],
        lazy="noload",
        post_update=True,
    )
    versions: Mapped[list["DocumentVersion"]] = relationship(
        "DocumentVersion",
        back_populates="document",
        lazy="noload",
        cascade="all, delete-orphan",
        foreign_keys="DocumentVersion.document_id",
    )
    attachments: Mapped[list["DocumentAttachment"]] = relationship(
        "DocumentAttachment", back_populates="document", lazy="noload", cascade="all, delete-orphan"
    )
    watchers: Mapped[list["DocumentWatcher"]] = relationship(
        "DocumentWatcher", back_populates="document", lazy="noload", cascade="all, delete-orphan"
    )
    comments: Mapped[list["Comment"]] = relationship(
        "Comment", back_populates="document", lazy="noload"
    )
    workflow_instances: Mapped[list["WorkflowInstance"]] = relationship(  # type: ignore[name-defined]
        "WorkflowInstance", back_populates="document", lazy="noload"
    )

    __table_args__ = (
        Index("idx_documents_org_status", "org_id", "status",
              postgresql_where="deleted_at IS NULL"),
        Index("idx_documents_submitted_by", "submitted_by",
              postgresql_where="deleted_at IS NULL"),
        # Documents-module list access paths (FR-1.5): owner + status + recency,
        # and owner + due date.
        Index("idx_documents_owner_status_updated", "submitted_by", "status", "updated_at",
              postgresql_where="deleted_at IS NULL"),
        Index("idx_documents_owner_due", "submitted_by", "due_at",
              postgresql_where="deleted_at IS NULL"),
        Index("idx_documents_fts", "search_vector", postgresql_using="gin"),
        Index("idx_documents_title_trgm", "title",
              postgresql_using="gin",
              postgresql_ops={"title": "gin_trgm_ops"}),
        # The expiry sweep only ever asks for rows that HAVE an expiry date,
        # which is a small minority — hence partial (migration c7d8e9f0a1b2).
        Index("idx_document_expiry_due", "expires_at",
              postgresql_where="expires_at IS NOT NULL AND deleted_at IS NULL"),
    )

    @property
    def owner_id(self) -> uuid.UUID:
        """Architecture alias: owner_id == submitted_by."""
        return self.submitted_by


class DocumentContent(BaseModel):
    """
    The editable body of a document (spec §9 DocumentContent).

    One row per document. `content` holds the rich-text editor JSON used by
    freeform (BLANK) documents; `answers` holds template answers keyed by field
    key. `rendered_snapshot_url` / `pdf_url` are the immutable artefacts written
    at submit time (FR-13.8 — renderer not built yet, so they stay NULL).
    """
    __tablename__ = "document_contents"
    __table_args__ = (UniqueConstraint("document_id", name="uq_document_content_doc"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    content: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    answers: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    rendered_snapshot_url: Mapped[str | None] = mapped_column(Text)
    pdf_url: Mapped[str | None] = mapped_column(Text)


class DocumentVersion(BaseModel):
    """
    Immutable record of a document version.

    Per architecture §4: each version records the binary file reference
    (storage_key, checksum) AND the form-data snapshot at that point in time.
    supersedes_version_id chains revisions together for rollback.

    Rows are IMMUTABLE once written — never updated.
    """
    __tablename__ = "document_versions"
    __table_args__ = (
        UniqueConstraint("document_id", "version_num", name="uq_doc_version"),
        # WF-REV-08: "which version answered this round?", for the owner's
        # feedback view. Partial, because only revisions answer a round and
        # the vast majority of rows are initial uploads.
        Index(
            "idx_dv_responds_to_round", "responds_to_round_id",
            postgresql_where=text("responds_to_round_id IS NOT NULL"),
        ),
        CheckConstraint(
            "rendition_status IS NULL OR rendition_status IN "
            "('pending', 'ready', 'failed', 'not_needed')",
            name="ck_dv_rendition_status",
        ),
        # The rendition worker's only query. Partial, so it stays small as
        # finished rows accumulate.
        Index(
            "idx_dv_rendition_pending", "rendition_status",
            postgresql_where=text("rendition_status = 'pending'"),
        ),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    version_num: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    form_data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")

    # ── Binary file tracking (architecture §4 DocumentVersion fields) ──────────
    # S3/MinIO object key for the binary file (nullable for form-only documents)
    storage_key: Mapped[str | None] = mapped_column(Text)
    # SHA-256 hash of the file bytes — integrity verification
    checksum: Mapped[str | None] = mapped_column(String(64))
    file_size: Mapped[int | None] = mapped_column(BigInteger)   # bytes
    mime_type: Mapped[str | None] = mapped_column(String(100))
    # ── Revision chain ─────────────────────────────────────────────────────────
    # Points to the version this one replaces — enables rollback flow (§8)
    supersedes_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("document_versions.id", use_alter=True, name="fk_dv_supersedes"),
        nullable=True,
    )
    # ── Authorship ─────────────────────────────────────────────────────────────
    # Who uploaded/created this version (architecture: uploaded_by)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False,
    )
    # ── Review pipeline (Workflow module section 6.4.1, 5.10; task P3-2) ──────
    # The PDF the viewer actually renders. An uploaded .docx cannot be shown
    # in a PDF viewer, so section 6.4.1 renders one; this points at it. NULL
    # means "not rendered yet, or not needed" - a document already uploaded as
    # a PDF renders itself.
    rendition_file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        # use_alter: documents -> document_versions -> file_assets ->
        # documents is a cycle, and without this SQLAlchemy cannot sort the
        # tables and silently stops considering FK order for every table in
        # the cycle. Same reason, and same fix, as supersedes_version_id
        # below. The database is unaffected - the migration adds this FK with
        # an ALTER either way.
        ForeignKey("file_assets.id", use_alter=True,
                   name="fk_dv_rendition_file"),
        nullable=True,
    )
    # 'initial' | 'revision'. WF-REV-08 wants a revision distinguishable from
    # a first upload without inferring it from version_num, which breaks as
    # soon as a run is restarted (submit-as-new starts at the current version,
    # not at version 1).
    reason: Mapped[str | None] = mapped_column(String(20))
    # Rendition state (task P3-3). `rendition_file_id` says WHERE the review
    # PDF is; these say what happened producing it. Without a status, "not
    # converted yet" and "conversion failed" are both NULL and the review
    # screen can only spin forever (section 6.4.1 asks for a failure state).
    #   'pending' | 'ready' | 'failed' | 'not_needed'
    # 'not_needed' is a real state, not an absence: a PDF is its own
    # rendition, and recording that stops the worker re-examining it.
    rendition_status: Mapped[str | None] = mapped_column(String(20))
    # The message the owner reads. On the row, not only in a worker log: the
    # person who can fix a password-protected file is the owner, and they will
    # never see a log line.
    rendition_error: Mapped[str | None] = mapped_column(Text)
    rendition_page_count: Mapped[int | None] = mapped_column(Integer)
    # WF-REV-08 / BR-11: the round this version was uploaded to answer, so the
    # feedback an owner was responding to stays attached to what they did
    # about it. NULL for an initial upload, which answers nothing.
    responds_to_round_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        # Also cyclic: review_rounds -> stage_instances -> workflow_instances
        # -> documents -> document_versions -> review_rounds.
        ForeignKey("review_rounds.id", use_alter=True,
                   name="fk_dv_responds_to_round"),
        nullable=True,
    )

    # ── Legacy field (kept for compatibility) ──────────────────────────────────
    changed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    change_reason: Mapped[str | None] = mapped_column(Text)

    document: Mapped["Document"] = relationship(
        "Document",
        back_populates="versions",
        lazy="noload",
        foreign_keys=[document_id],
    )
    supersedes: Mapped["DocumentVersion | None"] = relationship(
        "DocumentVersion",
        foreign_keys=[supersedes_version_id],
        remote_side="DocumentVersion.id",
        lazy="noload",
    )
    uploader: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", foreign_keys=[uploaded_by], lazy="noload",
    )


class FileAsset(BaseModel):
    __tablename__ = "file_assets"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    uploaded_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)          # S3/MinIO object key
    bucket: Mapped[str] = mapped_column(String(100), nullable=False)
    storage_mode: Mapped[str] = mapped_column(String(20), nullable=False)   # 's3' | 'minio'
    checksum: Mapped[str | None] = mapped_column(String(64))               # SHA-256
    is_malware_clean: Mapped[bool | None] = mapped_column(Boolean)         # None = not scanned
    preview_url: Mapped[str | None] = mapped_column(Text)
    ocr_text: Mapped[str | None] = mapped_column(Text)
    metadata_: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", name="metadata")


class DocumentAttachment(BaseModel):
    __tablename__ = "document_attachments"
    __table_args__ = (UniqueConstraint("document_id", "file_asset_id", name="uq_doc_attachment"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    file_asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("file_assets.id"), nullable=False
    )
    label: Mapped[str | None] = mapped_column(String(255))
    attached_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )

    document: Mapped["Document"] = relationship(
        "Document", back_populates="attachments", lazy="noload"
    )
    file_asset: Mapped["FileAsset"] = relationship("FileAsset", lazy="noload")


class DocumentWatcher(BaseModel):
    """
    Someone CC'd on a document (spec FR-13.4 "Watchers/CC").

    A watcher receives the document's notifications but has NO approval step
    and cannot act on it. That distinction matters: a watcher must never be
    mistaken for an approver by the workflow engine, so watchers live in their
    own table and are never read by it.

    A join table rather than an array column on `documents` because each row
    records who added the watcher and when, which the audit trail needs.

    Table added by migration c7d8e9f0a1b2 (applied).
    """
    __tablename__ = "document_watchers"
    __table_args__ = (UniqueConstraint("document_id", "user_id", name="uq_document_watcher"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    added_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )

    document: Mapped["Document"] = relationship(
        "Document", back_populates="watchers", lazy="noload"
    )
    user: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", lazy="noload", foreign_keys=[user_id]
    )


class Comment(BaseModel):
    __tablename__ = "comments"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("comments.id"), nullable=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    author_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    is_internal: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    document: Mapped["Document"] = relationship(
        "Document", back_populates="comments", lazy="noload"
    )
    replies: Mapped[list["Comment"]] = relationship(
        "Comment", back_populates="parent_comment", lazy="noload"
    )
    parent_comment: Mapped["Comment | None"] = relationship(
        "Comment", back_populates="replies", remote_side="Comment.id", lazy="noload"
    )
    mentions: Mapped[list["Mention"]] = relationship(
        "Mention", back_populates="comment", lazy="noload", cascade="all, delete-orphan"
    )


class Mention(BaseModel):
    __tablename__ = "mentions"

    comment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("comments.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )

    comment: Mapped["Comment"] = relationship("Comment", back_populates="mentions", lazy="noload")
