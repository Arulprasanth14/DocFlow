"""DocFlow — Document, DocumentType, DocumentVersion, FileAsset, DocumentAttachment, Comment, Mention ORM Models

Updated per architecture §4:
  - DocumentVersion now tracks binary file versions with storage_key, checksum,
    file_size, mime_type, uploaded_by, uploaded_at, supersedes_version_id
    (form_data snapshots are preserved alongside)
  - Document gains current_version_id and retention_policy
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, utcnow


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
    status: Mapped[str] = mapped_column(String(50), default="draft", nullable=False)
    priority: Mapped[str] = mapped_column(String(20), default="normal", nullable=False)

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
        Index("idx_documents_fts", "search_vector", postgresql_using="gin"),
        Index("idx_documents_title_trgm", "title",
              postgresql_using="gin",
              postgresql_ops={"title": "gin_trgm_ops"}),
    )

    @property
    def owner_id(self) -> uuid.UUID:
        """Architecture alias: owner_id == submitted_by."""
        return self.submitted_by


class DocumentVersion(BaseModel):
    """
    Immutable record of a document version.

    Per architecture §4: each version records the binary file reference
    (storage_key, checksum) AND the form-data snapshot at that point in time.
    supersedes_version_id chains revisions together for rollback.

    Rows are IMMUTABLE once written — never updated.
    """
    __tablename__ = "document_versions"
    __table_args__ = (UniqueConstraint("document_id", "version_num", name="uq_doc_version"),)

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
