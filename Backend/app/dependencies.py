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

import structlog

from app.core.exceptions import ForbiddenException, UnauthorizedException
from app.core.security import decode_token
from app.database import get_db
from app.domain.enums import Permission
from app.domain.permissions import AuthUser, assert_can_authenticate


logger = structlog.get_logger(__name__)

# ── Database ──────────────────────────────────────────────────────────────────
DatabaseDep = Annotated[AsyncSession, Depends(get_db)]


# ── Auth ──────────────────────────────────────────────────────────────────────

async def _get_token_from_request(request: Request) -> str:
    """Extract Bearer token from Authorization header."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise UnauthorizedException(
            "Missing or invalid Authorization header", code="INVALID_TOKEN"
        )
    return auth_header[7:]


async def authenticate_token(db: AsyncSession, token: str) -> AuthUser:
    """
    Validate a DocFlow access token and return the AuthUser it stands for.

    THE single implementation of per-request authentication (spec section 6.2
    steps 2-4), so HTTP requests and WebSocket connections cannot drift apart:

    2. Decode + verify the JWT (pinned algorithm, `type` must be access)
    3. The session must exist FOR THIS USER and not be revoked or expired
    4. The account must still be allowed to authenticate

    Raises UnauthorizedException (401) or ForbiddenException (403); callers
    decide how to surface that - HTTP returns the status, WebSockets close
    with 1008.
    """
    payload = decode_token(token, expected_type="access")

    user_id = UUID(payload["sub"])
    org_id = UUID(payload["org_id"]) if payload.get("org_id") else None
    session_id = payload.get("jti", "")
    roles = payload.get("roles", [])
    permissions = payload.get("permissions", [])
    is_superadmin = payload.get("is_superadmin", False)

    # Session + user state in ONE query (the spec's per-request budget).
    #
    # Bound to the user, not just to the session id: without the user_id
    # predicate a token only needs SOME live `jti` to pass this check, so an
    # attacker who can mint a signature could take their own session id and
    # claim any `sub` (any user, any org, superadmin).
    #
    # The users join is what makes deactivation take effect immediately: the
    # flag used to be written and never read, so a deactivated user kept
    # working until their session expired (up to 30 days).
    from sqlalchemy import select
    from app.models.user import Session, User

    result = await db.execute(
        select(Session, User.is_active, User.status)
        .join(User, User.id == Session.user_id)
        .where(
            Session.session_token == session_id,
            Session.user_id == user_id,
            Session.revoked_at.is_(None),
            User.deleted_at.is_(None),
        )
    )
    row = result.first()
    if row is None:
        raise UnauthorizedException(
            "Session expired or revoked. Please log in again.",
            code="SESSION_REVOKED",
        )
    session, is_active, status = row
    if not session.is_valid:
        raise UnauthorizedException(
            "Session expired or revoked. Please log in again.",
            code="SESSION_REVOKED",
        )
    assert_can_authenticate(is_active=is_active, status=status)

    return AuthUser(
        id=user_id,
        org_id=org_id,
        roles=roles,
        permissions=permissions,
        is_superadmin=is_superadmin,
        session_id=session_id,
    )


async def get_current_user(request: Request, db: DatabaseDep) -> AuthUser:
    """FastAPI dependency: the Bearer token's AuthUser."""
    token = await _get_token_from_request(request)
    return await authenticate_token(db, token)


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
    email_verified: bool = False


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
    from app.core.exceptions import ServiceUnavailableException
    from app.core.firebase import FirebaseUnavailableError, verify_firebase_token

    token = await _get_token_from_request(request)
    try:
        claims = await verify_firebase_token(token)
    except ValueError as exc:
        raise UnauthorizedException(
            f"Invalid Firebase token: {exc}", code="INVALID_TOKEN"
        ) from exc
    except FirebaseUnavailableError as exc:
        # 503, not 500/401: the credential isn't bad, the auth provider just
        # couldn't be reached. The client should retry, not sign out or
        # treat the user as new.
        raise ServiceUnavailableException(
            "Sign-in", code="AUTH_PROVIDER_UNAVAILABLE"
        ) from exc

    return FirebaseAuthUser(
        firebase_uid=claims["uid"],
        email=claims.get("email", ""),
        name=claims.get("name"),
        avatar_url=claims.get("picture"),
        email_verified=bool(claims.get("email_verified", False)),
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
            # Sampling/aggregation is the caller's problem: one line per
            # denial is fine at this volume, and a denial is exactly what an
            # investigation looks for.
            logger.info(
                "rbac.permission.denied",
                user_id=str(user.id), required=str(permission),
            )
            raise ForbiddenException(
                f"You need the '{permission}' permission to perform this action",
                code="FORBIDDEN",
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


def require_main_admin(user: AuthUser) -> None:
    """Strictly the Main Administrator org role (or a platform superadmin).

    Per the requirements report section 2.1/13.3 only the Main Administrator
    may add an HR user, delete or deactivate a member, or manage roles and
    permissions - HR support staff must NOT pass this gate even though they
    pass `require_admin_or_hr` for day-to-day admin screens.

    Lives here, next to the other guards, rather than inside a router: it is
    not a routing concern, and the spec's component map expected it here.
    """
    if not user.is_org_admin():
        raise ForbiddenException("Only the Main Administrator can perform this action")


def require_admin_or_hr(user: AuthUser) -> None:
    """Org-level day-to-day admin access: Main Administrator OR HR."""
    if not user.is_admin_or_hr():
        raise ForbiddenException("Only organization administrators can perform this action")


def require_role(*allowed_roles: str):
    """
    FastAPI dependency factory: require the caller to have one of the given org roles.

    Usage:
        @router.get("/admin/dashboard")
        async def admin_dashboard(
            user: AuthUser = require_role("admin"),
        ):
            ...

    Rules:
    - Superadmin (is_superadmin=True) always passes — bypasses role check.
    - Role names are matched against user.roles (list of role name strings
      from the JWT claim, populated from OrganizationMember.role.name).
    - Raises 403 ForbiddenException if none of the user's roles are in allowed_roles.
    """
    async def check(user: CurrentUser) -> AuthUser:
        if user.is_superadmin:
            return user  # superadmin bypasses all role checks
        if not any(r in allowed_roles for r in user.roles):
            raise ForbiddenException(
                f"This action requires one of these roles: {list(allowed_roles)}"
            )
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
