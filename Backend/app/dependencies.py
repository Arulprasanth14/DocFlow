"""
DocFlow Backend — FastAPI Dependencies
DI functions injected into route handlers.
These are the entry points for: DB sessions, auth, permissions.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenException, UnauthorizedException
from app.core.security import decode_token
from app.database import get_db
from app.domain.enums import Permission
from app.domain.permissions import AuthUser


# ── Database ──────────────────────────────────────────────────────────────────
DatabaseDep = Annotated[AsyncSession, Depends(get_db)]


# ── Auth ──────────────────────────────────────────────────────────────────────

async def _get_token_from_request(request: Request) -> str:
    """Extract Bearer token from Authorization header."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise UnauthorizedException("Missing or invalid Authorization header")
    return auth_header[7:]


async def get_current_user(
    request: Request,
    db: DatabaseDep,
) -> AuthUser:
    """
    FastAPI dependency: validate JWT + session, return AuthUser.

    Steps:
    1. Extract Bearer token from Authorization header
    2. Decode + verify JWT signature
    3. Check session is not revoked in DB
    4. Return AuthUser with resolved permissions
    """
    token = await _get_token_from_request(request)
    payload = decode_token(token)

    user_id = UUID(payload["sub"])
    org_id = UUID(payload["org_id"]) if payload.get("org_id") else None
    session_id = payload.get("jti", "")
    roles = payload.get("roles", [])
    permissions = payload.get("permissions", [])
    is_superadmin = payload.get("is_superadmin", False)

    # Check session has not been revoked
    from sqlalchemy import select
    from app.models.user import Session

    result = await db.execute(
        select(Session).where(
            Session.session_token == session_id,
            Session.revoked_at.is_(None),
        )
    )
    session = result.scalar_one_or_none()
    if not session or not session.is_valid:
        raise UnauthorizedException("Session expired or revoked. Please log in again.")

    return AuthUser(
        id=user_id,
        email=payload.get("email", ""),
        org_id=org_id,
        roles=roles,
        permissions=permissions,
        is_superadmin=is_superadmin,
        session_id=session_id,
    )


CurrentUser = Annotated[AuthUser, Depends(get_current_user)]


async def get_optional_user(request: Request, db: DatabaseDep) -> AuthUser | None:
    """Like get_current_user but returns None for unauthenticated requests."""
    try:
        return await get_current_user(request, db)
    except UnauthorizedException:
        return None


OptionalUser = Annotated[AuthUser | None, Depends(get_optional_user)]


# ── Firebase-Native Auth Dependency ──────────────────────────────────────────
# This dependency verifies Firebase ID tokens directly (no DocFlow JWT/session).
# Used by POST /users/me/sync and any new Firebase-first endpoints.
# The frontend sends a fresh Firebase ID token as the Bearer token.
# ──────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FirebaseAuthUser:
    """
    Minimal auth context derived from a verified Firebase ID token.
    Does NOT require a DocFlow session row in the DB.
    """
    firebase_uid: str
    email: str
    name: str | None
    avatar_url: str | None


async def get_current_firebase_user(
    request: Request,
    db: DatabaseDep,
) -> FirebaseAuthUser:
    """
    FastAPI dependency: verify a Firebase ID token from the Authorization header.

    The frontend sends:
        Authorization: Bearer <Firebase ID token>

    Steps:
    1. Extract Bearer token from Authorization header.
    2. Call verify_firebase_token() — uses firebase-admin SDK.
    3. Return FirebaseAuthUser with decoded claims.

    Raises UnauthorizedException (401) on invalid / expired tokens.
    """
    from app.core.firebase import verify_firebase_token

    token = await _get_token_from_request(request)
    try:
        claims = await verify_firebase_token(token)
    except ValueError as exc:
        raise UnauthorizedException(f"Invalid Firebase token: {exc}") from exc

    return FirebaseAuthUser(
        firebase_uid=claims["uid"],
        email=claims.get("email", ""),
        name=claims.get("name"),
        avatar_url=claims.get("picture"),
    )


FirebaseCurrentUser = Annotated[FirebaseAuthUser, Depends(get_current_firebase_user)]


# ── Permission Guards ──────────────────────────────────────────────────────────

def require_permission(permission: Permission | str):
    """
    FastAPI dependency factory: require a specific permission.

    Usage:
        @router.post("/documents")
        async def create_document(
            user: User = Depends(require_permission("documents:create")),
        )
    """
    async def check_permission(
        user: CurrentUser,
    ) -> AuthUser:
        if not user.has_permission(permission):
            raise ForbiddenException(
                f"You need the '{permission}' permission to perform this action"
            )
        return user

    return Depends(check_permission)


def require_any_permission(*permissions: Permission | str):
    """Require at least one of the given permissions."""
    async def check(user: CurrentUser) -> AuthUser:
        if not user.has_any_permission(*permissions):
            raise ForbiddenException(
                f"You need one of these permissions: {list(permissions)}"
            )
        return user
    return Depends(check)


def require_superadmin():
    """Require platform superadmin."""
    async def check(user: CurrentUser) -> AuthUser:
        if not user.is_superadmin:
            raise ForbiddenException("Superadmin access required")
        return user
    return Depends(check)


# ── Pagination ────────────────────────────────────────────────────────────────

from pydantic import BaseModel as PydanticModel


class PaginationParams(PydanticModel):
    page: int = 1
    limit: int = 20

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.limit

    model_config = {"extra": "ignore"}


async def get_pagination(page: int = 1, limit: int = 20) -> PaginationParams:
    limit = min(limit, 100)  # cap at 100
    page = max(page, 1)      # minimum page 1
    return PaginationParams(page=page, limit=limit)


Pagination = Annotated[PaginationParams, Depends(get_pagination)]
