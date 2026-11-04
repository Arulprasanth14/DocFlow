"""DocFlow — ImportJob ORM model (spec FR-9).

One row per "import an existing document into a template" attempt.

Mapping note: this is a NEW table, not a new column on a hot one. Declaring
the class before migration d1e2f3a4b5c6 is applied cannot affect any existing
query — only a query against `import_jobs` itself would fail, and the import
service checks the table is there first and reports the feature unavailable
rather than raising. That is why this is mapped normally instead of through a
Core table handle like the pdf_* columns were.
"""
from __future__ import annotations

import uuid

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import BaseModel


class ImportStatus:
    """Not an Enum: the column is VARCHAR so new states need no migration."""
    PENDING = "pending"
    EXTRACTING = "extracting"
    DETECTING = "detecting"
    READY = "ready"
    FAILED = "failed"
    CANCELLED = "cancelled"
    APPLIED = "applied"


#: States from which no further work will happen.
TERMINAL = frozenset(
    {ImportStatus.READY, ImportStatus.FAILED, ImportStatus.CANCELLED, ImportStatus.APPLIED}
)


class ImportJob(BaseModel):
    __tablename__ = "import_jobs"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    # Set when the author applies the job and the template is created.
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("templates.id", ondelete="SET NULL"), nullable=True
    )
    file_asset_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("file_assets.id", ondelete="SET NULL"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str | None] = mapped_column(String(255))
    source_kind: Mapped[str] = mapped_column(
        String(20), default="docx", server_default="docx", nullable=False
    )

    status: Mapped[str] = mapped_column(
        String(20), default=ImportStatus.PENDING, server_default="pending", nullable=False
    )
    stage: Mapped[str | None] = mapped_column(String(80))
    progress: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)

    # FALSE unless the author explicitly opted in. Document text is never sent
    # to an external model on the strength of a default.
    use_llm: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )

    page_count: Mapped[int | None] = mapped_column(Integer)
    char_count: Mapped[int | None] = mapped_column(Integer)

    #: Converted editor JSON, already passed through the server sanitizer.
    content: Mapped[dict | None] = mapped_column(JSONB)
    #: SHA-256 of the extracted plain text — the evidence for FR-9.4.
    content_hash: Mapped[str | None] = mapped_column(String(64))
    #: Proposed blanks (FR-9.3).
    detections: Mapped[list | None] = mapped_column(JSONB)
    #: Fidelity warnings for content that could not be represented (FR-9.7).
    warnings: Mapped[list | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
