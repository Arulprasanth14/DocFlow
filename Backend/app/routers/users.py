"""
DocFlow Backend — Router: Users
Lightweight user-profile endpoints backed by Firebase identity.

Endpoints:
  POST   /users/me/sync   — Create or update the DocFlow user profile for the
                             currently signed-in Firebase user. Called once by
                             the frontend after every successful Firebase sign-in
                             (email/password, Google, Microsoft).
"""
from __future__ import annotations

import structlog
from fastapi import APIRouter, Request

from app.dependencies import DatabaseDep, FirebaseCurrentUser
from app.schemas.users import SyncUserRequest, SyncUserResponse
from app.services.user_sync_service import UserSyncService

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["users"])


@router.post("/users/me/sync", response_model=SyncUserResponse)
async def sync_user(
    body: SyncUserRequest,
    firebase_user: FirebaseCurrentUser,
    db: DatabaseDep,
    request: Request,
) -> SyncUserResponse:
    """
    Sync a Firebase-authenticated user's profile to the DocFlow database.

    Called by the frontend immediately after any successful Firebase sign-in.
    This is idempotent — safe to call multiple times.

    - If the user exists (by firebase_uid or email), updates stale profile fields.
    - If the user does not exist, creates a new DocFlow user record.
    - If org_name is provided and the user has no organisation, creates one.

    Authentication: Firebase ID token (Authorization: Bearer <idToken>).
    No DocFlow session/cookie required.
    """
    svc = UserSyncService(db)
    result = await svc.sync(
        firebase_uid=firebase_user.firebase_uid,
        email=firebase_user.email,
        name=body.name or firebase_user.name,
        avatar_url=body.avatar_url or firebase_user.avatar_url,
        org_name=body.org_name,
    )

    logger.info(
        "user_sync",
        firebase_uid=firebase_user.firebase_uid,
        email=firebase_user.email,
        user_id=str(result.user.id),
        has_org=result.org_membership is not None,
    )

    return result
