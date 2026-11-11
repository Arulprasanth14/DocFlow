"""
DocFlow Backend — Router: Approvals
Endpoints:
  GET  /api/v1/approvals                          — list pending approvals for current user
  GET  /api/v1/approvals/signing-key              — public key for independent signature verification
  GET  /api/v1/approvals/recalls                  — list recall requests
  POST /api/v1/approvals/recalls/{id}/resolve     — approve/deny a recall (admin/HR)
  POST /api/v1/approvals/{id}/decision            — approve / reject / request changes
  POST /api/v1/approvals/{id}/delegate            — delegate approval step to another user
  POST /api/v1/approvals/{id}/revoke              — revoke/recall own recorded decision
  GET  /api/v1/approvals/{id}/signature/verify    — verify a step's cryptographic signature
  GET  /api/v1/approvals/stage-instances/{id}     — the approval screen's data (404 not 403)
  GET  /api/v1/approvals/document-versions/{id}/file — inline, <=5min viewer URL
  GET  /api/v1/approvals/documents/{id}/feedback  — the owner's review comments
  GET  /api/v1/approvals/audit/export            — audit log as CSV (Org Admin)
  POST /api/v1/approvals/annotations/{id}/replies — reply to a comment
  PATCH /api/v1/approvals/annotations/{id}/status — mark addressed / resolved
  GET  /api/v1/approvals/document-versions/{id}/annotations — published + my drafts
  POST /api/v1/approvals/annotations          — anchor a new draft comment
  PATCH /api/v1/approvals/annotations/{id}    — edit a draft (the autosave)
  DELETE /api/v1/approvals/annotations/{id}   — discard a draft
  POST /api/v1/approvals/stage-instances/{id}/reassign — admin reassigns a stage's approver
  POST /api/v1/approvals/instances/{id}/finalize  — finalize/close a fully-approved workflow
  GET  /api/v1/approvals/instances/{id}/history   — full approval chain of custody

NOTE on route order: FastAPI matches in declaration order, so every literal
single-segment path ("/signing-key", "/recalls") is declared BEFORE the
"/{step_id}" UUID route — otherwise the path param swallows it and 422s.
"""
from __future__ import annotations

import uuid
from typing import Annotated

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Path, Query, Request, status
from fastapi.responses import StreamingResponse

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenException, NotFoundException
from app.dependencies import CurrentUser, require_permission
from app.database import get_db
from app.schemas.workflow_instances import (
    ApprovalStepResponse,
    DecisionRequest,
    DelegateRequest,
    DocumentProgressResponse,
    MyApprovalsResponse,
    ReassignStageRequest,
    ResolveRecallRequest,
    RevokeRequest,
    StageInstanceDetailResponse,
    VersionFileResponse,
)
from app.schemas.annotations import (
    AnnotationCreate,
    AnnotationReplyCreate,
    AnnotationReplyResponse,
    AnnotationStatusUpdate,
    AnnotationThread,
    AnnotationUpdate,
    DocumentFeedbackResponse,
    SummaryResponse,
    VersionAnnotationsResponse,
    VersionDiffResponse,
)
from app.services.annotation_service import AnnotationService
from app.services.approval_service import ApprovalService
from app.services.workflow_service import WorkflowService


def require_review_layer() -> None:
    """P4-10 / section 11 — the review layer's off switch.

    404, not 503: when the flag is off these endpoints should behave exactly
    as they did before they existed, so a client that polls them stops
    rather than retrying a service it thinks is temporarily down.

    Applied to the review surface only - the viewer, annotations, summaries
    and comparison. Decisions, notifications and the SLA sweep are NOT gated:
    turning review off must never strand a document already in flight.
    """
    from app.config import settings

    if not settings.WORKFLOW_MODULE_V2_ENABLED:
        raise NotFoundException("Not found")

# Requirements §2.4/6.1: "Trainees must not see the Approvals navigation item,
# approval notifications, or approval APIs." Gating the WHOLE router on
# `approvals:decide` — a permission the trainee role deliberately does not
# hold (domain/enums.py::SYSTEM_ROLES) — makes that an API-level guarantee
# rather than a hidden-nav-item one, for the queue and single-step reads too,
# not just the decision endpoints.
router = APIRouter(
    prefix="/approvals",
    tags=["Approvals"],
    dependencies=[require_permission("approvals:decide")],
)


@router.get(
    "/signing-key",
    status_code=status.HTTP_200_OK,
    summary="Get the public key used to verify DocFlow approval signatures",
)
async def get_signing_public_key() -> dict:
    """
    The PUBLIC half of the document-signing keypair, PEM-encoded, plus its
    fingerprint and algorithm — enough for an auditor to independently
    verify any approval signature offline (§6.4). The private key never
    leaves the server process and is never exposed by any endpoint.

    Declared BEFORE "/{step_id}" on purpose: FastAPI matches in declaration
    order, so a literal single-segment path registered after the UUID path
    param would be swallowed by it and 422 on parse.
    """
    from app.core.signing import ALGORITHM, key_id, public_key_pem

    return {
        "algorithm": ALGORITHM,
        "key_id": key_id(),
        "public_key_pem": public_key_pem(),
    }


@router.get(
    "/recalls",
    status_code=status.HTTP_200_OK,
    summary="List approval recall requests for the organization",
)
async def list_recalls(
    current_user: CurrentUser,
    instance_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Declared before "/{step_id}" — a literal single-segment path after it
    would be captured by the UUID path param and 422."""
    service = ApprovalService(db)
    return await service.list_recalls(org_id=current_user.org_id, instance_id=instance_id)


# The decisions a step can carry, for the `status` filter below. Kept
# explicit rather than derived from the enum so an unrelated enum addition
# cannot silently widen what this endpoint will return.
@router.get(
    "",
    response_model=MyApprovalsResponse,
    status_code=status.HTTP_200_OK,
    summary="My approvals dashboard: filtered, sorted and paged",
)
async def list_my_approvals(
    current_user: CurrentUser,
    status_filter: str = Query(
        "pending",
        alias="status",
        description=(
            "Which tab: 'pending' | 'approved' | 'rejected' | "
            "'changes_requested' | 'all'. Defaults to pending, the work "
            "still to do."
        ),
    ),
    q: str | None = Query(
        None, max_length=200,
        description="Free text over document title and document ID.",
    ),
    template_id: uuid.UUID | None = Query(
        None, description="Only steps on runs of this workflow."
    ),
    department_id: uuid.UUID | None = Query(
        None, description="Only steps on documents from this department."
    ),
    sort: str | None = Query(
        None,
        description=(
            "'due_at' | '-due_at' | 'submitted_at' | '-submitted_at' | "
            "'title' | '-title'. Defaults to soonest-due for the pending "
            "tab and newest-first for the decided ones."
        ),
    ),
    page: int = Query(1, ge=1),
    limit: int = Query(25, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
) -> MyApprovalsResponse:
    """AP-DSH-01..08 — the approver's queue.

    Every filter, the sort and the paging are applied in the database. The
    page used to download every pending step and then filter the array in
    the browser, which meant the search box searched only what had already
    arrived, "page 2" paged over data the server had already sent in full,
    and the tab counts could not be computed at all because the client held
    one tab's worth of rows.

    The response also carries `counts` (one per tab, honouring the active
    filters so a badge never promises rows the filter hides) and `summary`
    (the unfiltered overdue / due-today strip).
    """
    return await ApprovalService(db).approval_dashboard(
        approver_id=current_user.id,
        org_id=current_user.org_id,
        tab=status_filter,
        q=q,
        template_id=template_id,
        department_id=department_id,
        sort=sort,
        page=page,
        limit=limit,
    )


@router.get(
    "/{step_id}",
    response_model=ApprovalStepResponse,
    status_code=status.HTTP_200_OK,
    summary="Get a single approval step",
)
async def get_approval_step(
    step_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ApprovalStepResponse:
    service = ApprovalService(db)
    return await service.get_step(step_id=step_id, user=current_user)


@router.post(
    "/{step_id}/decision",
    response_model=ApprovalStepResponse,
    status_code=status.HTTP_200_OK,
    summary="Submit decision on an approval step ('approved' | 'rejected' | 'changes_requested')",
)
async def submit_decision(
    step_id: Annotated[uuid.UUID, Path(...)],
    req: DecisionRequest,
    request: Request,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ApprovalStepResponse:
    service = ApprovalService(db)
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")
    return await service.decide(
        step_id=step_id,
        actor_id=current_user.id,
        org_id=current_user.org_id,
        req=req,
        ip_address=ip_address,
        user_agent=user_agent,
    )


@router.post(
    "/{step_id}/delegate",
    response_model=ApprovalStepResponse,
    status_code=status.HTTP_200_OK,
    summary="Delegate an approval step to another user",
)
async def delegate_approval(
    step_id: Annotated[uuid.UUID, Path(...)],
    req: DelegateRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ApprovalStepResponse:
    service = ApprovalService(db)
    return await service.delegate(
        step_id=step_id,
        delegator_id=current_user.id,
        org_id=current_user.org_id,
        req=req,
    )


@router.post(
    "/{step_id}/revoke",
    status_code=status.HTTP_200_OK,
    summary="Revoke/recall a decision you already recorded on this step",
)
async def revoke_decision(
    step_id: Annotated[uuid.UUID, Path(...)],
    req: RevokeRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    §6.5. If nothing downstream has happened, the revocation applies
    immediately and the document returns to its owner for correction. If the
    document already moved to a later approver, a controlled recall REQUEST
    is recorded instead (the workflow stays open, affected participants are
    notified, and an administrator resolves it) — an earlier approver can
    never silently roll back or close a workflow. The original approval
    record is always preserved.
    """
    service = ApprovalService(db)
    return await service.revoke_decision(
        step_id=step_id,
        actor_id=current_user.id,
        org_id=current_user.org_id,
        reason=req.reason,
    )


@router.post(
    "/recalls/{revocation_id}/resolve",
    status_code=status.HTTP_200_OK,
    summary="Approve or deny an outstanding approval recall request (admin/HR only)",
)
async def resolve_recall(
    revocation_id: Annotated[uuid.UUID, Path(...)],
    req: ResolveRecallRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    service = ApprovalService(db)
    return await service.resolve_recall(
        revocation_id=revocation_id,
        actor_id=current_user.id,
        org_id=current_user.org_id,
        approve=req.approve,
        note=req.note,
        actor_roles=current_user.roles,
        actor_is_superadmin=current_user.is_superadmin,
    )


@router.get(
    "/document-versions/{version_id}/annotations",
    response_model=VersionAnnotationsResponse,
    dependencies=[Depends(require_review_layer)],
    status_code=status.HTTP_200_OK,
    summary="Annotations on a version: the published set plus my own drafts",
)
async def list_version_annotations(
    version_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> VersionAnnotationsResponse:
    """AP-ANN-05/08 — what the review screen draws.

    Returns published comments plus the caller's **own** drafts. Somebody
    else's drafts are absent, and there is no count of them either: their
    existence is not the caller's business, and a "3 hidden drafts" badge
    would leak exactly what the rule protects.
    """
    return await AnnotationService(db).list_for_version(
        version_id=version_id, actor=current_user,
    )


@router.post(
    "/annotations",
    response_model=AnnotationThread,
    dependencies=[Depends(require_review_layer)],
    status_code=status.HTTP_201_CREATED,
    summary="Anchor a new draft comment",
)
async def create_annotation(
    req: AnnotationCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> AnnotationThread:
    """AP-ANN-01/02/20 — always created as a DRAFT.

    There is no way to create one already published: a single mis-click would
    otherwise send criticism the approver was still drafting. Drafts become
    visible to the owner only when the approver requests changes (AP-CHG-01).

    Called as soon as a highlight is drawn, before any text is typed, which
    is what makes the autosave able to survive a refresh (AP-ANN-20, E12).
    """
    thread = await AnnotationService(db).create_draft(
        req=req, actor=current_user,
    )
    await db.commit()
    return thread


@router.patch(
    "/annotations/{annotation_id}",
    response_model=AnnotationThread,
    dependencies=[Depends(require_review_layer)],
    status_code=status.HTTP_200_OK,
    summary="Edit a draft comment (the autosave endpoint)",
)
async def update_annotation(
    annotation_id: Annotated[uuid.UUID, Path(...)],
    req: AnnotationUpdate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> AnnotationThread:
    """AP-ANN-20 — the debounced autosave lands here.

    Every field is optional, so a keystroke sends `comment_text` alone.

    Refuses a published comment with **409, not 403**: the caller had every
    right to edit it up until they published it themselves (AP-ANN-09,
    BR-09). Only the author may edit, including for an admin — nobody edits
    somebody else's words.
    """
    thread = await AnnotationService(db).update_draft(
        annotation_id=annotation_id, req=req, actor=current_user,
    )
    await db.commit()
    return thread


@router.delete(
    "/annotations/{annotation_id}",
    status_code=status.HTTP_200_OK,
    summary="Discard a draft comment",
)
async def delete_annotation(
    annotation_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Soft-deleted, not removed.

    An approver who discards a draft by accident mid-review has lost work
    that AP-ANN-20 says must not be losable; a row with `deleted_at` set can
    still be recovered by an operator. It stops appearing immediately either
    way. A published comment cannot be discarded at all — it is part of the
    record (BR-09).
    """
    await AnnotationService(db).delete_draft(
        annotation_id=annotation_id, actor=current_user,
    )
    await db.commit()
    return {"status": "discarded", "id": str(annotation_id)}


@router.get(
    "/audit/export",
    status_code=status.HTTP_200_OK,
    summary="Export the organization's audit log as CSV (Org Admin only)",
)
async def export_audit_log(
    current_user: CurrentUser,
    instance_id: uuid.UUID | None = Query(
        None, description="Only events for this workflow run."
    ),
    resource_id: uuid.UUID | None = Query(
        None, description="Only events about this resource."
    ),
    since: datetime | None = Query(None, description="Events at or after this time."),
    until: datetime | None = Query(None, description="Events at or before this time."),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """X-AUD-04.

    Streamed, not assembled: the audit log is append-only and grows forever,
    so a year of it must not have to fit in memory before the first byte
    reaches the browser.

    Always scoped to the caller's own organization (BR-12). The scope comes
    from the authenticated user, never from a parameter, so there is no
    parameter to tamper with.
    """
    from app.services.audit_export import stream_audit_csv

    if not current_user.org_id:
        raise ForbiddenException("No organization context")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        stream_audit_csv(
            db, current_user, org_id=current_user.org_id,
            instance_id=instance_id, resource_id=resource_id,
            since=since, until=until,
        ),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition":
                f'attachment; filename="docflow-audit-{stamp}.csv"',
            # The log changes constantly; a cached export is a wrong export.
            "Cache-Control": "no-store",
        },
    )


@router.get(
    "/documents/{document_id}/progress",
    response_model=DocumentProgressResponse,
    status_code=status.HTTP_200_OK,
    summary="The owner's step-by-step approval progress",
)
async def get_document_progress(
    document_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> DocumentProgressResponse:
    """WF-REV-01/02, BR-15. 404 (not 403) for anyone not entitled."""
    return await ApprovalService(db).document_progress(
        document_id=document_id, actor=current_user,
    )


@router.get(
    "/documents/{document_id}/feedback",
    response_model=DocumentFeedbackResponse,
    status_code=status.HTTP_200_OK,
    summary="Review comments on a document, grouped by version and page",
)
async def get_document_feedback(
    document_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> DocumentFeedbackResponse:
    """WF-REV-03 / WF-REV-04 — what the owner reads before revising.

    Grouped by version and then by page, because that is how the work gets
    done: open the page, fix what is on it, move on. A flat list ordered by
    time would make the owner jump between pages.

    **Drafts are excluded in the query itself** (AP-ANN-05). An approver
    annotates while deciding and publishes the set when they request
    changes; a draft reaching the owner would show them half-formed
    criticism the approver had not chosen to send, and might never send.

    Earlier versions are included and flagged `is_current: false` — the
    owner needs to see what was asked on v1 while revising v2, and WF-REV-12
    keeps those rounds intact rather than carrying them forward.
    """
    return await AnnotationService(db).document_feedback(
        document_id=document_id, actor=current_user,
    )


@router.post(
    "/annotations/{annotation_id}/replies",
    response_model=AnnotationReplyResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Reply to a review comment",
)
async def reply_to_annotation(
    annotation_id: Annotated[uuid.UUID, Path(...)],
    req: AnnotationReplyCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> AnnotationReplyResponse:
    """WF-REV-05, N15. Append-only: there is no edit and no delete.

    A published comment is never rewritten (AP-ANN-09, BR-09) — after
    publication the only things that may happen to it are replies and status
    changes. That is what makes the trail worth keeping: nobody can go back
    and soften what they said once the other side has answered it.
    """
    reply = await AnnotationService(db).add_reply(
        annotation_id=annotation_id, actor=current_user, body=req.body,
    )
    await db.commit()
    return reply


@router.patch(
    "/annotations/{annotation_id}/status",
    response_model=AnnotationThread,
    status_code=status.HTTP_200_OK,
    summary="Mark a review comment addressed, resolved or reopened",
)
async def set_annotation_status(
    annotation_id: Annotated[uuid.UUID, Path(...)],
    req: AnnotationStatusUpdate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> AnnotationThread:
    """WF-REV-06.

    The owner marks a comment **addressed** ("I have dealt with this") and
    can take that back. Only the comment's author marks it **resolved** ("I
    accept that you have"), or reopens it. The owner deliberately cannot
    resolve: that would let them close their own feedback, which is
    approving their own corrections by the back door.
    """
    thread = await AnnotationService(db).set_status(
        annotation_id=annotation_id, actor=current_user, status=req.status,
    )
    await db.commit()
    return thread


def _summary_payload(version_id: uuid.UUID, row) -> SummaryResponse:
    from app.services.summary_service import POLL_TIMEOUT_SECONDS

    if row is None:
        return SummaryResponse(
            document_version_id=version_id, status="none",
            poll_timeout_seconds=POLL_TIMEOUT_SECONDS,
        )
    return SummaryResponse(
        document_version_id=version_id,
        status=row.status,
        content=row.content if row.status == "ready" else None,
        model=row.model, provider=row.provider, page_count=row.page_count,
        generated_at=row.generated_at, error_code=row.error_code,
        message=row.error_message,
        poll_timeout_seconds=POLL_TIMEOUT_SECONDS,
    )


@router.get(
    "/document-versions/{from_version_id}/compare/{to_version_id}",
    response_model=VersionDiffResponse,
    dependencies=[Depends(require_review_layer)],
    status_code=status.HTTP_200_OK,
    summary="What changed between two versions of a document",
)
async def compare_versions(
    from_version_id: Annotated[uuid.UUID, Path(...)],
    to_version_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> VersionDiffResponse:
    """AP-RES-03, T18 - the approver's "what actually changed?".

    Page-aware rather than whole-document: a document-wide diff of a
    re-flowed PDF is mostly noise, because inserting a sentence on page 2
    makes every later line look moved, and an approver cannot act on noise.

    Both versions must belong to the SAME document, and the caller must be
    able to read it. 404, not 403, for anyone who cannot - the comparison
    endpoint must not become a way to confirm a version exists.
    """
    return await ApprovalService(db).compare_versions(
        from_version_id=from_version_id,
        to_version_id=to_version_id,
        actor=current_user,
    )


@router.get(
    "/document-versions/{version_id}/summary",
    response_model=SummaryResponse,
    dependencies=[Depends(require_review_layer)],
    status_code=status.HTTP_200_OK,
    summary="The grounded AI summary for a version (approvers only)",
)
async def get_version_summary(
    version_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> SummaryResponse:
    """AP-SUM-01..08, AP-SUM-12.

    **Never shown to the document's owner.** The summary is a reviewing aid
    carrying the model's unverified guesses; showing it to the author would
    turn decision support into feedback they would argue with. The owner gets
    403 rather than 404 here - they know their own document exists, so there
    is nothing to conceal, and what they need is to be told this is not part
    of what they see.

    Requesting it also queues generation when nothing has been requested yet,
    so opening the approval screen is what starts it.
    """
    from app.services.summary_service import (
        SummaryService,
        queue_summary,
    )

    svc = SummaryService(db)
    row = await svc.for_version(version_id, current_user)
    if row is None:
        if not await svc.summaries_enabled(current_user.org_id):
            return SummaryResponse(
                document_version_id=version_id, status="unavailable",
                message="AI summaries are switched off for this organization.",
            )
        row = await svc.request(version_id, current_user)
        await db.commit()
        if row is not None:
            await queue_summary(version_id)
    return _summary_payload(version_id, row)


@router.post(
    "/document-versions/{version_id}/summary/regenerate",
    response_model=SummaryResponse,
    dependencies=[Depends(require_review_layer)],
    status_code=status.HTTP_202_ACCEPTED,
    summary="Regenerate the summary for a version (approvers only)",
)
async def regenerate_version_summary(
    version_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> SummaryResponse:
    """AP-SUM-08 - throttled, because each call is a paid model request over
    a whole document and the button sits right next to the approver.

    The throttle is a cooldown in the service rather than a route
    dependency: this project has rate-limit values in config but no
    middleware that reads them, so a `RateLimiter(...)` here would have been
    decoration. Returns 409 while one is already generating and 429 while a
    fresh one is still warm.
    """
    from app.services.summary_service import SummaryService, queue_summary

    row = await SummaryService(db).request(version_id, current_user, force=True)
    await db.commit()
    if row is None:
        return SummaryResponse(
            document_version_id=version_id, status="unavailable",
            message="AI summaries are switched off for this organization.",
        )
    await queue_summary(version_id)
    return _summary_payload(version_id, row)


@router.get(
    "/document-versions/{version_id}/file",
    response_model=VersionFileResponse,
    dependencies=[Depends(require_review_layer)],
    status_code=status.HTTP_200_OK,
    summary="A short-lived inline URL for the review viewer",
)
async def get_version_file(
    version_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> VersionFileResponse:
    """AP-VWR-04 / defect 11 — the bytes the approval viewer renders.

    Distinct from the attachment download, which hands out a one-hour URL
    with `Content-Disposition: attachment`. Both halves of that are wrong
    here: `attachment` makes the browser download the file instead of
    rendering it, so a viewer cannot use the URL at all, and an hour is far
    too long for a link granting unauthenticated read access to a document
    under review.

    Minted fresh on every request and capped at five minutes — a cap only
    means something if the URL is not stored and reused.

    **404, not 403**, for anyone not entitled to the document, matching
    `GET /approvals/stage-instances/{id}`: the file endpoint must not become
    the way to confirm that a document exists.

    Also carries the rendition state, so the viewer can show "preparing your
    review copy" or the reason it could not be prepared, instead of a broken
    frame (UX-INT-01).
    """
    return await ApprovalService(db).version_file_for_viewer(
        version_id=version_id, actor=current_user,
    )


@router.get(
    "/stage-instances/{stage_instance_id}",
    response_model=StageInstanceDetailResponse,
    status_code=status.HTTP_200_OK,
    summary="The approval screen's data for one stage of one run",
)
async def get_stage_instance_detail(
    stage_instance_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> StageInstanceDetailResponse:
    """AP-DET-01..05, T17, T39.

    **Returns 404, not 403, to anyone not entitled to it** (section 9.4,
    E28). A 403 would confirm the id names a real stage, and the difference
    between "no such thing" and "not yours" is itself information about
    another department's documents.

    Visible to the stage's stored approver, the document's owner, and
    admin/HR. `can_act` is computed from stored server state only (section
    7.3 CRITICAL), and `cannot_act_reason` is filled in whenever it is false
    so the screen can say why rather than show a disabled button with no
    explanation (UX-INT-01).
    """
    return await ApprovalService(db).stage_instance_detail(
        stage_instance_id=stage_instance_id,
        actor=current_user,
    )


@router.post(
    "/stage-instances/{stage_instance_id}/reassign",
    status_code=status.HTTP_200_OK,
    summary="Reassign a blocked or stuck approval stage (Org Admin only)",
)
async def reassign_stage(
    stage_instance_id: Annotated[uuid.UUID, Path(...)],
    req: ReassignStageRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """AP-SLA-05 / AP-SLA-06, N13, task P2-17.

    The only supported way to change an active stage's approver in v1.
    Delegation is out of scope per section 2.1 and is left untouched.

    A stage blocks when its approver cannot be resolved at activation - the
    person was deactivated or deleted after the workflow was built, or a
    manager link went away. Its clock is paused, so nothing will time out to
    raise the alarm; the submitter and the Org Admins are notified instead,
    and this is what they act on.

    The new approver gets a FULL deadline window, not what was left of the
    old one: they did not have the document for the part already elapsed.
    """
    si = await WorkflowService(db).reassign_stage_instance(
        org_id=current_user.org_id,
        stage_instance_id=stage_instance_id,
        new_approver_id=req.new_approver_id,
        reason=req.reason,
        actor=current_user,
    )
    await db.commit()
    return {
        "id": str(si.id),
        "status": si.status,
        "position": si.position,
        "stage_name": si.stage_name,
        "resolved_approver_id": str(si.resolved_approver_id)
        if si.resolved_approver_id else None,
        "due_at": si.due_at.isoformat() if si.due_at else None,
        "row_version": si.row_version,
    }


@router.post(
    "/instances/{instance_id}/finalize",
    status_code=status.HTTP_200_OK,
    summary="Finalize/close a fully-approved workflow (final approver or admin only)",
)
async def finalize_workflow(
    instance_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    §6.2/6.6. Blocked unless every required approval is complete, no recall
    is outstanding, and every recorded signature still verifies.
    """
    service = ApprovalService(db)
    return await service.finalize_workflow(
        instance_id=instance_id,
        actor_id=current_user.id,
        org_id=current_user.org_id,
        actor_roles=current_user.roles,
        actor_is_superadmin=current_user.is_superadmin,
    )


@router.get(
    "/instances/{instance_id}/history",
    status_code=status.HTTP_200_OK,
    summary="Full approval chain of custody for a workflow instance",
)
async def get_approval_history(
    instance_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    §6.6: who approved before whom, with step, decision, timestamp,
    comments, the document version each decision was made against, and each
    signature's current verification state.
    """
    service = ApprovalService(db)
    return await service.get_approval_history(
        instance_id=instance_id,
        org_id=current_user.org_id,
        user=current_user,
    )


@router.get(
    "/{step_id}/signature/verify",
    status_code=status.HTTP_200_OK,
    summary="Verify the cryptographic signature recorded for an approval step",
)
async def verify_step_signature(
    step_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Re-verifies the stored RSA-PSS-SHA256 signature for this step and
    reports three independent checks (§6.4): the stored payload is
    untampered, the signature verifies against the public key, and the
    document version's content hash still matches what was signed. The
    verification result, key id, and timestamp are written to the audit
    trail on every call.
    """
    service = ApprovalService(db)
    return await service.verify_step_signature(
        step_id=step_id,
        org_id=current_user.org_id,
        actor_id=current_user.id,
    )
