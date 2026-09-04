"""
DocFlow Backend — Router: Workflow Submission & Instance Management
Endppoints:
  POST /api/v1/documents/{id}/submit            — submit document for approval
  POST /api/v1/documents/{id}/revise-and-resume — resume workflow at flagged stage after revision
  GET  /api/v1/workflow-instances/{id}          — get instance details
  GET  /api/v1/workflow-instances/{id}/stream   — SSE live status stream
  POST /api/v1/workflow-instances/{id}/cancel   — cancel running workflow
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import CurrentUser, get_current_user
from app.database import get_db
from app.schemas.workflow_instances import (
    CancelWorkflowRequest,
    ReviseAndResumeRequest,
    SubmitDocumentRequest,
    WorkflowInstanceResponse,
)
from app.services.workflow_service import WorkflowService

router = APIRouter(tags=["Workflows"])


@router.post(
    "/documents/{document_id}/submit",
    response_model=WorkflowInstanceResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a document for workflow approval",
)
async def submit_document(
    document_id: Annotated[uuid.UUID, Path(...)],
    req: SubmitDocumentRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowInstanceResponse:
    service = WorkflowService(db)
    return await service.submit(
        org_id=current_user.org_id,
        document_id=document_id,
        requester_id=current_user.id,
        req=req,
    )


@router.post(
    "/documents/{document_id}/revise-and-resume",
    response_model=WorkflowInstanceResponse,
    status_code=status.HTTP_200_OK,
    summary="Submit revised document and resume workflow at flagged stage",
)
async def revise_and_resume(
    document_id: Annotated[uuid.UUID, Path(...)],
    req: ReviseAndResumeRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowInstanceResponse:
    service = WorkflowService(db)
    return await service.resume(
        org_id=current_user.org_id,
        document_id=document_id,
        requester_id=current_user.id,
        req=req,
    )


@router.get(
    "/workflow-instances/{instance_id}",
    response_model=WorkflowInstanceResponse,
    status_code=status.HTTP_200_OK,
    summary="Get workflow instance details",
)
async def get_instance(
    instance_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowInstanceResponse:
    service = WorkflowService(db)
    return await service.get_instance(instance_id, current_user.org_id)


@router.get(
    "/workflow-instances/{instance_id}/stream",
    summary="Server-Sent Events (SSE) live stream of workflow status",
)
async def stream_instance(
    instance_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    service = WorkflowService(db)
    generator = service.stream_status(instance_id, current_user.org_id)
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/workflow-instances/{instance_id}/cancel",
    response_model=WorkflowInstanceResponse,
    status_code=status.HTTP_200_OK,
    summary="Cancel a running workflow instance",
)
async def cancel_instance(
    instance_id: Annotated[uuid.UUID, Path(...)],
    req: CancelWorkflowRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> WorkflowInstanceResponse:
    service = WorkflowService(db)
    return await service.cancel(
        org_id=current_user.org_id,
        instance_id=instance_id,
        requester_id=current_user.id,
        req=req,
    )
