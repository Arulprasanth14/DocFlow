"""
DocFlow Backend — Router: Notifications
Endpoints:
  GET  /api/v1/notifications           — list notifications for current user
  POST /api/v1/notifications/{id}/read — mark a single notification read
  POST /api/v1/notifications/read-all  — mark all notifications read
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import CurrentUser
from app.database import get_db
from app.repositories.notification_repo import NotificationRepository

router = APIRouter(prefix="/notifications", tags=["Notifications"])


class NotificationResponse(BaseModel):
    id: uuid.UUID
    type: str
    title: str
    body: str | None
    deep_link: str | None
    instance_id: uuid.UUID | None
    is_read: bool
    created_at: str

    model_config = {"from_attributes": True}


class NotificationListResponse(BaseModel):
    items: list[dict]
    total: int
    unread_count: int


@router.get(
    "",
    response_model=NotificationListResponse,
    status_code=status.HTTP_200_OK,
    summary="List notifications for current user",
)
async def list_notifications(
    current_user: CurrentUser,
    unread_only: Annotated[bool, Query()] = False,
    page: Annotated[int, Query(ge=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    db: AsyncSession = Depends(get_db),
) -> NotificationListResponse:
    repo = NotificationRepository(db)
    items, total = await repo.get_for_user(current_user.id, unread_only, page, limit)
    unread_count = await repo.unread_count(current_user.id)

    formatted = [
        {
            "id": str(n.id),
            "type": n.type,
            "title": n.title,
            "body": n.body,
            "deep_link": n.deep_link,
            "instance_id": str(n.instance_id) if n.instance_id else None,
            "is_read": n.is_read,
            "created_at": n.created_at.isoformat() if n.created_at else "",
        }
        for n in items
    ]
    return NotificationListResponse(
        items=formatted, total=total, unread_count=unread_count
    )


@router.post(
    "/{notification_id}/read",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
    summary="Mark a notification as read",
)
async def mark_read(
    notification_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> None:
    repo = NotificationRepository(db)
    await repo.mark_read(notification_id, current_user.id)
    await db.commit()


@router.post(
    "/read-all",
    status_code=status.HTTP_200_OK,
    summary="Mark all notifications as read",
)
async def mark_all_read(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
) -> dict:
    repo = NotificationRepository(db)
    count = await repo.mark_all_read(current_user.id)
    await db.commit()
    return {"updated": count}
