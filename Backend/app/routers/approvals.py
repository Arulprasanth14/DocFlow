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
  POST /api/v1/approvals/instances/{id}/finalize  — finalize/close a fully-approved workflow
  GET  /api/v1/approvals/instances/{id}/history   — full approval chain of custody

NOTE on route order: FastAPI matches in declaration order, so every literal
single-segment path ("/signing-key", "/recalls") is declared BEFORE the
"/{step_id}" UUID route — otherwise the path param swallows it and 422s.
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import CurrentUser, require_permission
from app.database import get_db
from app.schemas.workflow_instances import (
    ApprovalStepResponse,
    DecisionRequest,
    DelegateRequest,
    MyApprovalsResponse,
    ResolveRecallRequest,
    RevokeRequest,
)
from app.services.approval_service import ApprovalService

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


@router.get(
    "",
    response_model=MyApprovalsResponse,
    status_code=status.HTTP_200_OK,
    summary="List my pending approval steps",
)
async def list_my_approvals(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> MyApprovalsResponse:
    service = ApprovalService(db)
    items = await service.list_my_approvals(
        approver_id=current_user.id,
        org_id=current_user.org_id,
    )
    return MyApprovalsResponse(items=items, total=len(items))


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
