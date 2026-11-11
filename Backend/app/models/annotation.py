"""
DocFlow — Annotation ORM models

Workflow module section 6.5 (AP-ANN-01..11, 20..23), section 4 data model.
Task P3-2.

An annotation is an approver's comment anchored to a place in a document
version. Three things about the shape of it are load-bearing:

**Anchors are normalized, not pixels.** `rects` holds fractions of the page
(0..1) measured against the UNROTATED page, so the same annotation lands in
the right place at any zoom, on any screen size, and after the viewer rotates
the page. Storing viewport pixels would make every anchor wrong the moment
somebody resized a window.

**The anchor is to a VERSION, never to the document.** A document gains new
versions (WF-REV-07) and the old ones are immutable. An annotation that
pointed at "the document" would silently start describing text that is no
longer there. Carry-over to a later version is a separate, best-effort
re-match (AP-ANN-22) that keeps the original anchor intact.

**`selected_text` plus `text_prefix`/`text_suffix` is what makes carry-over
possible at all.** Re-anchoring on a new version searches for the quoted text
with its surrounding context; without the context, a phrase that occurs twice
on a page cannot be placed. AP-ANN-23 accepts that this is best-effort - a
"Location changed" badge is a specified outcome, not a bug.

Plain text only, everywhere (AP-ANN-11, section 11 Security): no HTML, no
Markdown, and never rendered with `dangerouslySetInnerHTML`. Comment bodies
are attacker-controlled text written by one user and read by another.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel

# AP-ANN-01. 'text' anchors quote a selection from the text layer; 'area' is a
# dragged rectangle, which is the only option on a scanned page with no text
# layer (AP-ANN-02, E14).
ANCHOR_TYPES = ("text", "area")

# Section 6.11 status flow:
#   draft     - author only; not visible to anyone else, not even the owner
#   open      - published when the approver requests changes (AP-CHG-01)
#   addressed - the document owner says they have dealt with it
#   resolved  - the approver accepts that; they may also reopen it
ANNOTATION_STATUSES = ("draft", "open", "addressed", "resolved")

# Lengths from section 6.5.2. The prefix/suffix are context for re-matching,
# not content, so 30 characters each is deliberate: long enough to
# disambiguate a repeated phrase, short enough not to become a second copy of
# the document.
MAX_SELECTED_TEXT = 1000
MAX_CONTEXT = 30
MAX_COMMENT = 2000


def _sql_list(values: tuple[str, ...]) -> str:
    """Render a tuple as a SQL IN list.

    Not `repr(tuple)`: a one-element tuple reprs as `('x',)`, and the trailing
    comma is a syntax error in SQL. Cheap insurance against a future edit
    leaving one value behind.
    """
    return ", ".join(f"'{v}'" for v in values)


class Annotation(BaseModel):
    """One anchored comment on one document version."""

    __tablename__ = "annotations"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False,
    )
    # Nullable: a draft can exist before the round it will be published in is
    # opened, and an annotation carried over from an earlier version belongs
    # to the round it was MADE in, not the one being reviewed now. The service
    # layer requires a round before publishing (AP-CHG-01).
    review_round_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("review_rounds.id"), nullable=True,
    )
    # The anchor target. Not nullable and never the document: see the module
    # docstring.
    document_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("document_versions.id", ondelete="CASCADE"),
        nullable=False,
    )
    author_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )

    anchor_type: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default="text",
    )
    # 1-based, matching how the viewer and the UI both count pages. The
    # extracted-text pipeline is 0-based internally; converting at the
    # boundary is cheaper than explaining an off-by-one in every page label.
    page_number: Mapped[int] = mapped_column(Integer, nullable=False)
    # A list of {x, y, w, h}, each 0..1 of the unrotated page. A list rather
    # than one rect because a text selection spanning lines is several
    # rectangles, and highlighting only the bounding box would cover text the
    # approver did not select.
    rects: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]",
    )

    selected_text: Mapped[str | None] = mapped_column(String(MAX_SELECTED_TEXT))
    text_prefix: Mapped[str | None] = mapped_column(String(MAX_CONTEXT))
    text_suffix: Mapped[str | None] = mapped_column(String(MAX_CONTEXT))

    color: Mapped[str | None] = mapped_column(String(20))
    category: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="draft",
    )
    comment_text: Mapped[str | None] = mapped_column(Text)
    # Set once, when the approver requests changes. Until then the row is a
    # draft and only its author can see it (AP-ANN-05).
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # AP-ANN-22 / E17 / E30. When an annotation is carried onto a later
    # version, the copy records where it came from, and whether the re-match
    # actually found the text. `relocated = false` is what the UI shows as
    # "Location changed", which section 6.5.2 treats as a correct outcome.
    carried_from_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("annotations.id"), nullable=True,
    )
    relocated: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    replies: Mapped[list["AnnotationReply"]] = relationship(
        "AnnotationReply", back_populates="annotation",
        lazy="noload", cascade="all, delete-orphan",
    )

    @property
    def is_draft(self) -> bool:
        return self.status == "draft"

    @property
    def is_open(self) -> bool:
        """Still awaiting the owner — what AP-APR-01 counts when it warns
        "N comments are still open. Approve anyway?"."""
        return self.status in ("open", "addressed")

    __table_args__ = (
        CheckConstraint(
            f"anchor_type IN ({_sql_list(ANCHOR_TYPES)})",
            name="ck_annotation_anchor_type",
        ),
        CheckConstraint(
            f"status IN ({_sql_list(ANNOTATION_STATUSES)})",
            name="ck_annotation_status",
        ),
        CheckConstraint("page_number >= 1", name="ck_annotation_page"),
        # A published annotation must have a body; a draft need not, because
        # the approver may anchor first and type afterwards (AP-ANN-20
        # autosaves either way).
        CheckConstraint(
            "status = 'draft' OR comment_text IS NOT NULL",
            name="ck_annotation_published_has_text",
        ),
        # The comments panel's only query: everything on this version, by
        # page (AP-ANN-08). Must stay fast with 500+ comments (AP-ANN-10, E24).
        Index("idx_annotation_version_page", "document_version_id", "page_number"),
        Index("idx_annotation_round", "review_round_id"),
        # Partial: an approver's own unpublished drafts, which is the lookup
        # on every autosave and every page load of the review screen.
        Index(
            "idx_annotation_author_drafts", "author_id", "document_version_id",
            postgresql_where=text("status = 'draft' AND deleted_at IS NULL"),
        ),
    )


class AnnotationReply(BaseModel):
    """A reply on a published annotation. Append-only (AP-ANN-09, BR-09).

    The owner answers a comment and the approver answers back; neither edits
    the other's words, and nobody edits a published annotation. After
    publication the only changes are replies and status transitions - that is
    what makes the review trail worth anything.
    """

    __tablename__ = "annotation_replies"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False,
    )
    annotation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("annotations.id", ondelete="CASCADE"),
        nullable=False,
    )
    author_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)

    annotation: Mapped["Annotation"] = relationship(
        "Annotation", back_populates="replies", lazy="noload",
    )

    __table_args__ = (
        CheckConstraint("length(btrim(body)) > 0", name="ck_reply_not_blank"),
        # Oldest first is how a thread reads.
        Index("idx_reply_annotation_created", "annotation_id", "created_at"),
    )
