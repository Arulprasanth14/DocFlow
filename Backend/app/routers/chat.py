"""
DocFlow Backend — Router: Chat (REST fallback & conversation queries)

Step 0 hardening applied:
  0.1: workflow_context conversation creation gated by can_user_access_document()
  0.9: workflow_context creation is NOW idempotent — same approval_step_id returns
       the existing conversation rather than creating a duplicate (409-free)
  Added: GET /chat/conversations/{id} — get single conversation
  Added: GET /chat/members — org member picker for DM "new conversation" flow
         (lighter endpoint, no admin:users gate — any org member can see peers)

Endpoints:
  POST /api/v1/chat/conversations                — start DM OR workflow_context conversation
  GET  /api/v1/chat/conversations                — list my conversations (with unread counts)
  GET  /api/v1/chat/conversations/{id}           — get single conversation
  GET  /api/v1/chat/conversations/{id}/messages  — get paginated messages
  POST /api/v1/chat/conversations/{id}/messages  — REST message send fallback
  POST /api/v1/chat/conversations/{id}/read      — mark conversation read
  GET  /api/v1/chat/members                      — list org members for DM picker
"""
from __future__ import annotations

import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import CurrentUser
from app.database import get_db
from app.core.exceptions import ForbiddenException, NotFoundException
from app.schemas.chat import (
    ChatMessageResponse,
    ConversationListResponse,
    ConversationResponse,
    SendMessageRequest,
    StartConversationRequest,
)
from app.services.chat_service import ChatService

router = APIRouter(prefix="/chat", tags=["Chat"])


@router.post(
    "/conversations",
    response_model=ConversationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Start a conversation (direct DM or workflow context)",
)
async def start_conversation(
    req: StartConversationRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ConversationResponse:
    """
    Start a conversation.

    For kind='direct': creates a DM thread with participant_user_id.
    For kind='workflow_context': idempotent — returns the existing conversation
    if one already exists for this approval_step_id, or creates one.
    The caller must have access to the underlying document (enforced via
    can_user_access_document()) — returns 403 if not.
    """
    service = ChatService(db)
    return await service.start_conversation(
        creator_id=current_user.id,
        org_id=current_user.org_id,
        req=req,
    )


@router.get(
    "/conversations",
    response_model=ConversationListResponse,
    status_code=status.HTTP_200_OK,
    summary="List my conversations (with unread counts)",
)
async def list_conversations(
    current_user: CurrentUser,
    kind: Annotated[Optional[str], Query(description="Filter by 'workflow_context' | 'direct'")] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    db: AsyncSession = Depends(get_db),
) -> ConversationListResponse:
    service = ChatService(db)
    items, total = await service.list_conversations(
        user_id=current_user.id,
        kind=kind,
        page=page,
        limit=limit,
        org_id=current_user.org_id,
    )
    return ConversationListResponse(items=items, total=total, page=page, limit=limit)


@router.get(
    "/conversations/{conversation_id}",
    response_model=ConversationResponse,
    status_code=status.HTTP_200_OK,
    summary="Get a single conversation by ID",
)
async def get_conversation(
    conversation_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ConversationResponse:
    service = ChatService(db)
    return await service.get_conversation(
        conversation_id, current_user.id, org_id=current_user.org_id
    )


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=list[ChatMessageResponse],
    status_code=status.HTTP_200_OK,
    summary="List messages in a conversation (cursor pagination)",
)
async def list_messages(
    conversation_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    before_id: Annotated[Optional[uuid.UUID], Query(description="Cursor: get messages before this message ID")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    db: AsyncSession = Depends(get_db),
) -> list[ChatMessageResponse]:
    service = ChatService(db)
    return await service.list_messages(
        conversation_id=conversation_id,
        user_id=current_user.id,
        before_id=before_id,
        limit=limit,
    )


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=ChatMessageResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Send a chat message (REST fallback; WebSocket preferred)",
)
async def send_message(
    conversation_id: Annotated[uuid.UUID, Path(...)],
    req: SendMessageRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ChatMessageResponse:
    service = ChatService(db)
    return await service.send(
        conversation_id=conversation_id,
        sender_id=current_user.id,
        org_id=current_user.org_id,
        req=req,
    )


@router.post(
    "/conversations/{conversation_id}/read",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    summary="Mark conversation as read (updates last_read_at for unread count)",
)
async def mark_read(
    conversation_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    service = ChatService(db)
    await service.mark_read(conversation_id, current_user.id)


@router.get(
    "/members",
    status_code=status.HTTP_200_OK,
    summary="List org members for DM picker (no admin gate — any member can query peers)",
)
async def list_messageable_members(
    current_user: CurrentUser,
    search: Annotated[Optional[str], Query(description="Search by name or email")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """
    Lightweight member list for the 'New Direct Message' picker.
    Returns: id, display_name, email, avatar_url, department_name.
    Excludes the caller themselves.
    No admin:users permission required — any authenticated org member can
    discover colleagues for DM purposes.
    """
    from sqlalchemy import select, or_
    from app.models.organization import OrganizationMember
    from app.models.user import User

    q = (
        select(User, OrganizationMember)
        .join(OrganizationMember, OrganizationMember.user_id == User.id)
        .where(
            OrganizationMember.org_id == current_user.org_id,
            OrganizationMember.status == "active",
            User.id != current_user.id,
        )
    )
    if search:
        pattern = f"%{search}%"
        q = q.where(
            or_(
                User.name.ilike(pattern),
                User.email.ilike(pattern),
            )
        )
    q = q.limit(limit)
    rows = (await db.execute(q)).all()
    return [
        {
            "id": str(row.User.id),
            "display_name": row.User.name or row.User.email,
            "email": row.User.email,
            "avatar_url": getattr(row.User, "avatar_url", None),
        }
        for row in rows
    ]
