"""
DocFlow Backend — Router: AI assistance (Documents module, Phase 3)

    GET  /ai/availability                 is AI usable for me, and how much is left
    POST /ai/suggest-field                FR-8.4  propose a question for a blank
    POST /ai/detect-blanks                FR-9.3  find fillable gaps in imported text
    POST /ai/rewrite                      FR-10.1 improve a selected passage
    POST /ai/review                       FR-10.4 pre-submission review
    POST /ai/interactions/{id}/decision   record accept / reject

Every endpoint is governed in the service: provider key stays server-side,
per-user daily quota, org and user off-switches, a hard timeout, and an
`ai_interactions` row per call. `AIUnavailable` becomes a 503 with a reason
the UI shows as-is — a feature that is off or out of quota must read as a
calm explanation, never as a crash.
"""
from __future__ import annotations

from uuid import UUID

import structlog
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse

from app.core.exceptions import ForbiddenException, NotFoundException
from app.dependencies import CurrentUser, DatabaseDep
from app.schemas.ai_assist import (
    AIAvailabilityResponse,
    AIDecisionRequest,
    AIOrgSettingsRequest,
    AIUserSettingsRequest,
    BlankDetectRequest,
    BlankDetectResponse,
    CompleteRequest,
    CompleteResponse,
    DraftRequest,
    DraftResponse,
    FieldSuggestRequest,
    FieldSuggestResponse,
    ReviewRequest,
    ReviewResponse,
    RewriteRequest,
    RewriteResponse,
    SubmissionDetailsRequest,
    SubmissionDetailsResponse,
)
from app.schemas.org import MessageResponse
from app.services.ai_assist_service import AIAssistService, AIUnavailable

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/ai", tags=["ai-assist"])


def _svc(db: DatabaseDep, current_user: CurrentUser) -> AIAssistService:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    return AIAssistService(db)


def _unavailable(exc: AIUnavailable) -> HTTPException:
    """
    503 rather than 500: the request was fine, the capability is not.

    `detail` is a plain string because the app's error handler surfaces it to
    the client as `error` — a dict there would reach the UI as "[object
    Object]". The machine-readable code stays in the log and in
    GET /ai/availability, which is what the client polls to decide whether to
    hide the feature or offer a retry.
    """
    logger.info("ai_unavailable", code=exc.code)
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=exc.message,
    )


def _uuid_or_none(raw: str | None) -> UUID | None:
    if not raw:
        return None
    try:
        return UUID(raw)
    except ValueError:
        return None


@router.get("/availability", response_model=AIAvailabilityResponse)
async def ai_availability(db: DatabaseDep, current_user: CurrentUser) -> AIAvailabilityResponse:
    return AIAvailabilityResponse(**await _svc(db, current_user).availability(current_user))


@router.post("/suggest-field", response_model=FieldSuggestResponse)
async def suggest_field(
    req: FieldSuggestRequest, db: DatabaseDep, current_user: CurrentUser
) -> FieldSuggestResponse:
    try:
        return FieldSuggestResponse(
            **await _svc(db, current_user).suggest_field(
                current_user,
                before=req.before,
                after=req.after,
                existing_keys=req.existing_keys,
                template_id=_uuid_or_none(req.template_id),
            )
        )
    except AIUnavailable as exc:
        raise _unavailable(exc) from exc


@router.post("/detect-blanks", response_model=BlankDetectResponse)
async def detect_blanks(
    req: BlankDetectRequest, db: DatabaseDep, current_user: CurrentUser
) -> BlankDetectResponse:
    try:
        return BlankDetectResponse(
            **await _svc(db, current_user).detect_blanks(
                current_user,
                document_text=req.document_text,
                template_id=_uuid_or_none(req.template_id),
            )
        )
    except AIUnavailable as exc:
        raise _unavailable(exc) from exc


@router.post("/rewrite", response_model=RewriteResponse)
async def rewrite(
    req: RewriteRequest, db: DatabaseDep, current_user: CurrentUser
) -> RewriteResponse:
    try:
        return RewriteResponse(
            **await _svc(db, current_user).rewrite(
                current_user,
                passage=req.passage,
                instruction=req.instruction,
                document_id=_uuid_or_none(req.document_id),
            )
        )
    except AIUnavailable as exc:
        raise _unavailable(exc) from exc


@router.post("/rewrite/stream")
async def rewrite_stream(
    req: RewriteRequest,
    db: DatabaseDep,
    current_user: CurrentUser,
) -> StreamingResponse:
    """
    FR-10.3 — stream rewrite deltas over Server-Sent Events.

    POST, not GET. The passage is document text: in a query string it
    lands in every access log and reverse-proxy log on the way, and long
    selections hit the URL length ceiling. The client reads this with
    fetch (lib/api/eventStream.ts), which posts a body perfectly well —
    only EventSource would have forced GET, and that cannot send an
    Authorization header anyway.
    """
    svc = _svc(db, current_user)
    return StreamingResponse(
        svc.stream_rewrite(
            current_user,
            passage=req.passage,
            instruction=req.instruction,
            document_id=_uuid_or_none(req.document_id),
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/draft", response_model=DraftResponse)
async def draft(
    req: DraftRequest, db: DatabaseDep, current_user: CurrentUser
) -> DraftResponse:
    """
    FR-10.1 — write a passage from the author's instruction.

    Nothing is applied: the client shows the result with Insert / Discard.
    """
    try:
        return DraftResponse(
            **await _svc(db, current_user).draft(
                current_user,
                instruction=req.instruction,
                context=req.context,
                template_id=_uuid_or_none(req.template_id),
                document_id=_uuid_or_none(req.document_id),
            )
        )
    except AIUnavailable as exc:
        raise _unavailable(exc) from exc


@router.post("/complete", response_model=CompleteResponse)
async def complete(
    req: CompleteRequest, db: DatabaseDep, current_user: CurrentUser
) -> CompleteResponse:
    """
    FR-10.1 — a short continuation for inline ghost text.

    Nothing is applied: the client draws the suggestion in grey and the author
    presses Tab to take it. Subject to the same org switch, per-user opt-out,
    daily quota and audit record as every other AI feature, and the client only
    calls it when the author has turned the suggestions on.
    """
    try:
        return CompleteResponse(
            **await _svc(db, current_user).complete(
                current_user,
                before=req.before,
                template_id=_uuid_or_none(req.template_id),
                document_id=_uuid_or_none(req.document_id),
            )
        )
    except AIUnavailable as exc:
        raise _unavailable(exc) from exc


@router.post("/review", response_model=ReviewResponse)
async def review(
    req: ReviewRequest, db: DatabaseDep, current_user: CurrentUser
) -> ReviewResponse:
    """
    Review a draft before submission.

    When `document_text` is omitted the server reads the document's own stored
    text, which is both less to send and the only version that is certainly
    what will be submitted. Access is checked through the normal document
    permission path, so this cannot be used to read someone else's document.
    """
    doc_id = _uuid_or_none(req.document_id)
    text = req.document_text

    if text is None:
        if doc_id is None:
            raise HTTPException(status_code=400, detail="Provide document_id or document_text.")
        from app.services.document_service import DocumentService

        doc_svc = DocumentService(db)
        content = await doc_svc.get_content(doc_id, current_user)  # raises 403/404 as appropriate
        from app.services.content_sanitizer import content_to_text

        text = content_to_text(content.content)
        if not (text or "").strip():
            doc = await doc_svc.get_document(doc_id, current_user)
            text = doc.content_text or ""

    try:
        return ReviewResponse(
            **await _svc(db, current_user).review_document(
                current_user, document_text=text, document_id=doc_id
            )
        )
    except AIUnavailable as exc:
        raise _unavailable(exc) from exc


@router.post("/suggest-details", response_model=SubmissionDetailsResponse)
async def suggest_details(
    req: SubmissionDetailsRequest, db: DatabaseDep, current_user: CurrentUser
) -> SubmissionDetailsResponse:
    """
    FR-13.5 — suggest a title, description and priority for a document.

    Takes only the document id: the server reads the stored text itself, so a
    confidential body is never shipped up from the browser just to be sent
    back down. Access goes through the normal document permission path.
    """
    from app.services.content_sanitizer import content_to_text
    from app.services.document_service import DocumentService

    doc_svc = DocumentService(db)
    content = await doc_svc.get_content(req.document_id, current_user)
    text = content_to_text(content.content)
    if not (text or "").strip():
        doc = await doc_svc.get_document(req.document_id, current_user)
        text = doc.content_text or doc.title or ""

    try:
        return SubmissionDetailsResponse(
            **await _svc(db, current_user).suggest_submission_details(
                current_user, document_text=text, document_id=req.document_id
            )
        )
    except AIUnavailable as exc:
        raise _unavailable(exc) from exc


@router.post("/interactions/{interaction_id}/decision", response_model=MessageResponse)
async def record_decision(
    interaction_id: UUID,
    req: AIDecisionRequest,
    db: DatabaseDep,
    current_user: CurrentUser,
) -> MessageResponse:
    """
    FR-10.4: record whether the person took the suggestion. The client calls
    this on both accept and reject — a rejection is the more useful signal of
    the two, and leaving it unrecorded would make the audit trail read as if
    every suggestion were taken.
    """
    try:
        await _svc(db, current_user).record_decision(interaction_id, current_user, req.accepted)
    except NotFoundException:
        raise
    return MessageResponse(message="Recorded")


@router.put("/settings", response_model=AIAvailabilityResponse)
async def set_my_ai_settings(
    req: AIUserSettingsRequest, db: DatabaseDep, current_user: CurrentUser
) -> AIAvailabilityResponse:
    """Turn AI assistance on or off for myself (spec §23)."""
    svc = _svc(db, current_user)
    try:
        await svc.set_user_opt_out(current_user, req.ai_opt_out)
    except AIUnavailable as exc:
        raise _unavailable(exc) from exc
    return AIAvailabilityResponse(**await svc.availability(current_user))


@router.put("/org-settings", response_model=AIAvailabilityResponse)
async def set_org_ai_settings(
    req: AIOrgSettingsRequest, db: DatabaseDep, current_user: CurrentUser
) -> AIAvailabilityResponse:
    """
    Turn AI assistance on or off for the whole organisation. Admin only —
    this decides the feature for everyone, including people who wanted it.
    """
    if "admin" not in current_user.roles:
        raise ForbiddenException("Only an administrator can change this setting")
    svc = _svc(db, current_user)
    await svc.set_org_enabled(current_user, req.ai_enabled)
    return AIAvailabilityResponse(**await svc.availability(current_user))
