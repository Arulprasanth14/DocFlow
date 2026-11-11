"""
DocFlow — Document summary ORM model

Workflow module section 6.4.3 (AP-SUM-01..13). Task P4-1.

Keyed on the SHA-256 of the extracted text rather than on the version id, so
a summary can never be served for content it was not generated from: if the
rendition is rebuilt and the text changes, the hash changes and the old row
stops matching. AP-SUM-07 caching comes free from the same key.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import BaseModel

#: 'unavailable' is distinct from 'failed': the organization has summaries
#: switched off (AP-SUM-10), which is a setting rather than an error, and the
#: panel says so rather than showing a failure the approver cannot act on.
SUMMARY_STATUSES = ("pending", "ready", "failed", "unavailable")


class DocumentSummary(BaseModel):
    __tablename__ = "document_summaries"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False,
    )
    document_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("document_versions.id", ondelete="CASCADE"),
        nullable=False,
    )
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="pending",
    )
    # The validated, grounded blocks. JSONB so the UI can render page
    # citations as links and show which claims failed grounding, rather than
    # receiving a wall of prose it cannot inspect.
    content: Mapped[dict | None] = mapped_column(JSONB)
    model: Mapped[str | None] = mapped_column(String(120))
    provider: Mapped[str | None] = mapped_column(String(40))
    page_count: Mapped[int | None] = mapped_column(Integer)
    generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # A short machine code plus one sentence for the approver. Never the
    # provider's raw error, and never any document text (AP-SUM-13).
    error_code: Mapped[str | None] = mapped_column(String(40))
    error_message: Mapped[str | None] = mapped_column(Text)

    @property
    def is_ready(self) -> bool:
        return self.status == "ready" and bool(self.content)

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'ready', 'failed', 'unavailable')",
            name="ck_summary_status",
        ),
        # Scoped by org as well as hash: two organizations submitting
        # identical content must never share a row, because a cache hit
        # across a tenant boundary is a leak (BR-12).
        Index("uq_summary_sha_org", "org_id", "sha256", unique=True,
              postgresql_where=text("deleted_at IS NULL")),
        Index("idx_summary_version", "document_version_id"),
    )
