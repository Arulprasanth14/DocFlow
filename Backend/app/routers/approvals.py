"""
DocFlow Backend — Router: Approvals
Endpoints:
  GET  /api/v1/approvals              — list pending approvals for current user
  POST /api/v1/approvals/{id}/decision — approve / reject / request changes
  POST /api/v1/approvals/{id}/delegate — delegate approval step to another user
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import CurrentUser
from app.database import get_db
from app.schemas.workflow_instances import (
    ApprovalStepResponse,
    DecisionRequest,
    DelegateRequest,
    MyApprovalsResponse,
)
from app.services.approval_service import ApprovalService

router = APIRouter(prefix="/approvals", tags=["Approvals"])


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
