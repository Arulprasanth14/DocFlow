"""
DocFlow Backend — Schemas: AI assistance (Documents module Phase 3).

Every suggestion response carries `interaction_id` and a `confidence` band.
The id exists because nothing is applied automatically (FR-10.4): the client
sends back whether the person accepted it, which is what makes the audit
trail meaningful rather than a log of requests nobody read.
"""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

ConfidenceBand = Literal["high", "medium", "low"]
Severity = Literal["high", "medium", "low"]


class AIAvailabilityResponse(BaseModel):
    """Asked once; when `enabled` is false the UI hides AI entirely."""

    enabled: bool
    reason_code: str | None = None
    reason: str | None = None
    used_today: int
    daily_quota: int


class AIDecisionRequest(BaseModel):
    accepted: bool


# ── field suggestion ──────────────────────────────────────────────────────────


class FieldSuggestRequest(BaseModel):
    before: str = Field(default="", max_length=4000, description="Text before the blank")
    after: str = Field(default="", max_length=4000, description="Text after the blank")
    existing_keys: list[str] = Field(default_factory=list, max_length=500)
    template_id: str | None = None


class FieldSuggestResponse(BaseModel):
    interaction_id: str
    label: str
    key: str
    type: str
    confidence: ConfidenceBand


# ── blank detection ───────────────────────────────────────────────────────────


class DetectedBlank(BaseModel):
    #: Exact text from the document, verified to be present server-side so the
    #: client can locate it. A snippet the model invented is dropped.
    snippet: str
    label: str
    key: str
    type: str
    confidence: ConfidenceBand


class BlankDetectRequest(BaseModel):
    document_text: str = Field(..., min_length=1, max_length=200_000)
    template_id: str | None = None


class BlankDetectResponse(BaseModel):
    interaction_id: str
    blanks: list[DetectedBlank]
    #: True when the document was longer than the budget sent to the model, so
    #: the UI can say the later pages weren't scanned instead of implying
    #: the whole document was.
    truncated: bool


# ── rewrite ───────────────────────────────────────────────────────────────────


class RewriteRequest(BaseModel):
    passage: str = Field(..., min_length=1, max_length=8000)
    instruction: str | None = Field(default=None, max_length=300)
    document_id: str | None = None


class RewriteResponse(BaseModel):
    interaction_id: str
    #: Both sides, so the client can render a diff and apply nothing until
    #: the author accepts.
    original: str
    suggestion: str
    note: str | None = None
    confidence: ConfidenceBand
    #: Set when the rewrite would drop placeholders — accepting it would
    #: delete those questions, so the UI must say so before it is applied.
    warning: str | None = None


# ── review ────────────────────────────────────────────────────────────────────


class ReviewFinding(BaseModel):
    severity: Severity
    message: str
    quote: str | None = None
    confidence: ConfidenceBand


class ReviewRequest(BaseModel):
    document_id: str | None = None
    #: Optional: when omitted the server reads the document's own stored text,
    #: so the browser never has to ship a confidential body back up.
    document_text: str | None = Field(default=None, max_length=200_000)


class ReviewResponse(BaseModel):
    interaction_id: str
    findings: list[ReviewFinding]
    truncated: bool


# ── governance switches ───────────────────────────────────────────────────────


class AIUserSettingsRequest(BaseModel):
    """The person's own off-switch. True = don't offer me AI."""

    ai_opt_out: bool


class AIOrgSettingsRequest(BaseModel):
    """
    The organisation-wide switch, admin only. Absent in storage means OFF:
    AI stays dark until an administrator deliberately turns it on.
    """

    ai_enabled: bool


class SubmissionDetailsRequest(BaseModel):
    """FR-13.5 — ask for a title/description/priority for a document."""
    document_id: UUID


class SubmissionDetailsResponse(BaseModel):
    interaction_id: str
    title: str | None = None
    description: str | None = None
    priority: str | None = None
    reason: str | None = None
    confidence: str = "low"


# ── Write with AI (FR-10.1) ───────────────────────────────────────────────────

class DraftRequest(BaseModel):
    """
    `instruction` is the author's own words. `context` is the paragraph before
    the cursor and nothing more — the body is never sent.
    """
    instruction: str = Field(..., min_length=1, max_length=1000)
    context: str = Field(default="", max_length=4000)
    template_id: str | None = None
    document_id: str | None = None


class CompleteRequest(BaseModel):
    """
    `before` is the text immediately in front of the cursor and nothing else:
    not the paragraph after it, and never the whole body.
    """
    before: str = Field(..., min_length=1, max_length=2000)
    template_id: str | None = None
    document_id: str | None = None


class CompleteResponse(BaseModel):
    interaction_id: str
    #: May be empty: "nothing useful to add" is a valid answer and the client
    #: shows no ghost text for it.
    text: str


class DraftResponse(BaseModel):
    interaction_id: str
    text: str
    note: str | None = None
    confidence: str
