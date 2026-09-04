"""
DocFlow Backend — Router: Chat (REST fallback & conversation queries)
Endpoints:
  POST /api/v1/chat/conversations                — start DM conversation
  GET  /api/v1/chat/conversations                — list my conversations
  GET  /api/v1/chat/conversations/{id}/messages  — get paginated messages
  POST /api/v1/chat/conversations/{id}/messages  — REST message send fallback
  POST /api/v1/chat/conversations/{id}/read      — mark conversation read
"""
from __future__ import annotations

import uuid
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import CurrentUser
from app.database import get_db
from app.schemas.chat import (
    ChatMessageResponse,
    ConversationListResponse,
    ConversationResponse,
    SendMessageRequest,
    StartDirectConversationRequest,
)
from app.services.chat_service import ChatService

router = APIRouter(prefix="/chat", tags=["Chat"])


@router.post(
    "/conversations",
    response_model=ConversationResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Start a direct (DM) conversation",
)
async def start_conversation(
    req: StartDirectConversationRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> ConversationResponse:
    service = ChatService(db)
    return await service.start_direct(
        creator_id=current_user.id,
        org_id=current_user.org_id,
        req=req,
    )


@router.get(
    "/conversations",
    response_model=ConversationListResponse,
    status_code=status.HTTP_200_OK,
    summary="List my conversations",
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
    )
    return ConversationListResponse(items=items, total=total, page=page, limit=limit)


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=list[ChatMessageResponse],
    status_code=status.HTTP_200_OK,
    summary="List messages in a conversation (cursor pagination)",
)
async def list_messages(
    conversation_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    before_id: Annotated[Optional[uuid.UUID], Query(description="Cursor: get messages before this ID")] = None,
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
    summary="Mark conversation as read",
)
async def mark_read(
    conversation_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    service = ChatService(db)
    await service.mark_read(conversation_id, current_user.id)
