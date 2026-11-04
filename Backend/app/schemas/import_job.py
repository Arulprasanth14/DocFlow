"""DocFlow — schemas for document import (spec FR-9)."""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class ImportCreateRequest(BaseModel):
    """Start an import from a file that has already been uploaded and scanned."""
    file_asset_id: UUID
    filename: str = Field(..., min_length=1, max_length=500)
    mime_type: str | None = None
    #: FR-9.8 / org policy: document text is only sent to the model when the
    #: author explicitly turns this on for this import. Default off.
    use_llm: bool = False


class DetectionOut(BaseModel):
    """One proposed blank (FR-9.3)."""
    start: int
    end: int
    original: str
    key: str
    label: str
    type: str
    confidence: str          # high | medium | low
    reason: str
    source: str              # rule | ai


class AcceptedDetection(BaseModel):
    """
    What the author accepted.

    `start`/`end` identify WHICH stored detection this is; they are matched
    against the server's own copy and a span that was never proposed is
    ignored. Only the label, key and type may be edited in review.
    """
    start: int
    end: int
    key: str | None = None
    label: str | None = None
    type: str | None = None


class ImportApplyRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    accepted: list[AcceptedDetection]


class ImportJobResponse(BaseModel):
    id: UUID
    filename: str
    source_kind: str
    #: FR-9.7 — the stored original, so the review screen can show it
    #: beside the conversion. Resolved to a short-lived URL by
    #: GET /files/asset/{id}/download-url; never a URL itself.
    file_asset_id: UUID | None = None
    status: str
    stage: str | None = None
    progress: int = 0
    use_llm: bool = False
    page_count: int | None = None
    char_count: int | None = None
    content: dict[str, Any] | None = None
    #: The extracted plain text, exactly as detection offsets index it. Sent
    #: so the review screen can show the document and so "Make blank" can
    #: produce a span the server will recognise.
    text: str = ""
    detections: list[DetectionOut] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    template_id: UUID | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
