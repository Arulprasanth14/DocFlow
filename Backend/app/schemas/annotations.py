"""
DocFlow — Schemas: review annotations (section 6.5, section 5.10)

Task P3-10. The owner-facing shapes: a comment with its replies, grouped by
version and page.

`rects` is passed through as-is: a list of `{x, y, w, h}`, each 0..1 of the
unrotated page. Validated at the write path (P3-6), not here — these are read
shapes, and re-validating stored geometry on the way out would turn a bad row
into an error page instead of a visible comment.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AnnotationReplyResponse(BaseModel):
    id: uuid.UUID
    annotation_id: uuid.UUID
    author_id: uuid.UUID
    author_name: str | None = None
    body: str
    created_at: datetime


class AnnotationThread(BaseModel):
    """One published comment and everything said in answer to it."""

    id: uuid.UUID
    document_version_id: uuid.UUID
    page_number: int
    anchor_type: str
    rects: list[dict[str, Any]] = Field(default_factory=list)
    selected_text: str | None = None
    comment_text: str | None = None
    category: str | None = None
    color: str | None = None
    status: str
    # Derived, so the client is not reimplementing "which statuses count as
    # outstanding" — the same question AP-APR-01 asks when it warns an
    # approver that comments are still open.
    is_open: bool
    author_id: uuid.UUID
    author_name: str | None = None
    published_at: datetime | None = None
    created_at: datetime
    # AP-ANN-22: present when this comment was carried onto a later version.
    # `relocated is False` is what the UI shows as "Location changed" — the
    # text could not be found again, which section 6.5.2 treats as a correct
    # outcome rather than a failure.
    carried_from_id: uuid.UUID | None = None
    relocated: bool | None = None
    replies: list[AnnotationReplyResponse] = Field(default_factory=list)


class FeedbackPageGroup(BaseModel):
    page_number: int
    comments: list[AnnotationThread] = Field(default_factory=list)


class FeedbackVersionGroup(BaseModel):
    document_version_id: uuid.UUID
    version_num: int
    # Only the current version's comments are actionable. Earlier ones are
    # history: replying about text that has since been rewritten helps
    # nobody, and WF-REV-12 keeps those rounds as they were.
    is_current: bool
    pages: list[FeedbackPageGroup] = Field(default_factory=list)


class DocumentFeedbackResponse(BaseModel):
    """WF-REV-03/04 — what the owner reads before revising."""

    document_id: uuid.UUID
    document_title: str | None = None
    versions: list[FeedbackVersionGroup] = Field(default_factory=list)
    # Outstanding across every version, for the resubmit step's warning and
    # the badge on the feedback tab.
    open_count: int = 0
    total_count: int = 0


class AnnotationRect(BaseModel):
    """One highlighted rectangle, as a fraction of the unrotated page."""

    x: float
    y: float
    w: float
    h: float


class AnnotationCreate(BaseModel):
    """AP-ANN-01/02. Created as a DRAFT, always.

    A comment becomes visible to the owner only when the approver requests
    changes (AP-CHG-01). There is deliberately no way to create one already
    published: that would let a single mis-click send criticism the approver
    was still drafting.
    """

    document_version_id: uuid.UUID
    anchor_type: str = Field(default="text", pattern="^(text|area)$")
    page_number: int = Field(ge=1)
    rects: list[AnnotationRect] = Field(min_length=1)
    # Context for carrying the anchor onto a later version (AP-ANN-22).
    selected_text: str | None = Field(default=None, max_length=1000)
    text_prefix: str | None = Field(default=None, max_length=30)
    text_suffix: str | None = Field(default=None, max_length=30)
    color: str | None = Field(default=None, max_length=20)
    category: str | None = Field(default=None, max_length=40)
    # Optional at creation: AP-ANN-20 autosaves an anchor the moment it is
    # drawn, before the approver has typed anything.
    comment_text: str | None = Field(default=None, max_length=2000)
    review_round_id: uuid.UUID | None = None


class AnnotationUpdate(BaseModel):
    """AP-ANN-09 — only ever applied to a draft.

    Every field is optional because this doubles as the autosave endpoint: a
    keystroke sends `comment_text` alone, and re-dragging a highlight sends
    the geometry alone.
    """

    anchor_type: str | None = Field(default=None, pattern="^(text|area)$")
    page_number: int | None = Field(default=None, ge=1)
    rects: list[AnnotationRect] | None = None
    selected_text: str | None = Field(default=None, max_length=1000)
    text_prefix: str | None = Field(default=None, max_length=30)
    text_suffix: str | None = Field(default=None, max_length=30)
    color: str | None = Field(default=None, max_length=20)
    category: str | None = Field(default=None, max_length=40)
    comment_text: str | None = Field(default=None, max_length=2000)


class VersionAnnotationsResponse(BaseModel):
    """What the review screen loads: the published set plus MY drafts.

    Somebody else's drafts are absent and there is no flag for them — their
    existence is not the caller's business (AP-ANN-05).
    """

    document_version_id: uuid.UUID
    annotations: list[AnnotationThread] = Field(default_factory=list)
    draft_count: int = 0
    open_count: int = 0


class SummaryResponse(BaseModel):
    """AP-SUM-03/04/05 — what the summary panel renders.

    `status` is what the client switches on:
      'pending'     generating; poll
      'ready'       `content` holds the grounded blocks
      'failed'      `message` says why, in words the approver can act on
      'unavailable' switched off for this organization, or not configured -
                    a setting, not an error, and the panel says so
      'none'        nothing requested yet
    """

    document_version_id: uuid.UUID
    status: str
    content: dict[str, Any] | None = None
    model: str | None = None
    provider: str | None = None
    page_count: int | None = None
    generated_at: datetime | None = None
    error_code: str | None = None
    message: str | None = None
    #: Seconds the client should keep polling before giving up (AP-SUM-05).
    poll_timeout_seconds: int = 90


class PageDiffResponse(BaseModel):
    page_number: int
    #: 'unchanged' | 'changed' | 'rewritten' | 'added' | 'removed'
    status: str
    added: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)
    similarity: float = 1.0
    #: True when the page was too long, or too heavily edited, to list every
    #: line. The page is still reported as changed.
    truncated: bool = False


class VersionDiffResponse(BaseModel):
    """AP-RES-03 - what changed between two versions, page by page.

    `available: false` with a `reason` is the specified fallback, not an
    error: a scanned revision has no text layer, so there is nothing to
    compare, and an empty diff would read as "no changes".
    """

    from_version_id: uuid.UUID
    to_version_id: uuid.UUID
    from_version_num: int | None = None
    to_version_num: int | None = None
    available: bool
    reason: str | None = None
    changed_pages: list[int] = Field(default_factory=list)
    added_pages: list[int] = Field(default_factory=list)
    removed_pages: list[int] = Field(default_factory=list)
    pages: list[PageDiffResponse] = Field(default_factory=list)


class AnnotationReplyCreate(BaseModel):
    body: str = Field(min_length=1, max_length=2000)


class AnnotationStatusUpdate(BaseModel):
    """WF-REV-06.

    'addressed' is the owner's claim that they have dealt with a comment;
    'resolved' is the approver accepting it; 'open' reopens. Which of these
    a given caller may set is decided server-side, not here.
    """

    status: str = Field(pattern="^(open|addressed|resolved)$")
