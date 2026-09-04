"""
DocFlow Backend — Router: Authentication
Thin HTTP adapter layer — all logic delegates to AuthService.

Endpoints:
  POST   /auth/firebase-login    — Google / Microsoft / Firebase Email login
  POST   /auth/login             — Direct email + password login
  POST   /auth/register          — Create new account
  POST   /auth/refresh           — Refresh access token (reads HttpOnly cookie)
  POST   /auth/logout            — Revoke current session
  POST   /auth/logout-all        — Revoke all sessions (sign out all devices)
  GET    /auth/me                — Current user profile + membership + sessions
  PATCH  /auth/me                — Update profile (name, avatar_url)
  PUT    /auth/password          — Change password
  GET    /auth/sessions          — List active sessions
  DELETE /auth/sessions/{id}     — Revoke a specific session
"""
from __future__ import annotations

from uuid import UUID

import structlog
from fastapi import APIRouter, Cookie, Request, Response
from fastapi.responses import JSONResponse

from app.config import settings
from app.core.exceptions import UnauthorizedException
from app.dependencies import CurrentUser, DatabaseDep
from app.schemas.auth import (
    ChangePasswordRequest,
    EmailLoginRequest,
    FirebaseLoginRequest,
    LoginResponse,
    MeResponse,
    MessageResponse,
    RegisterRequest,
    SessionInfo,
    TokenRefreshResponse,
    UpdateProfileRequest,
    UserResponse,
)
from app.services.auth_service import AuthService

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["auth"])

_REFRESH_COOKIE = "docflow_refresh"
_COOKIE_MAX_AGE = settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600  # seconds


def _set_refresh_cookie(response: Response, token: str) -> None:
    """Set the HttpOnly refresh token cookie (SameSite=Strict, Secure in prod)."""
    response.set_cookie(
        key=_REFRESH_COOKIE,
        value=token,
        httponly=True,
        secure=settings.is_production,
        samesite="strict",
        max_age=_COOKIE_MAX_AGE,
        path="/api/v1/auth",   # only sent to auth endpoints
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(key=_REFRESH_COOKIE, path="/api/v1/auth")


# ── Firebase Login (Google / Microsoft / Firebase Email) ──────────────────────

@router.post("/firebase-login", response_model=LoginResponse)
async def firebase_login(
    body: FirebaseLoginRequest,
    request: Request,
    response: Response,
    db: DatabaseDep,
) -> LoginResponse:
    """
    Exchange a Firebase ID token for DocFlow access + refresh tokens.
    Supports: Google OAuth, Microsoft OAuth, Firebase Email/Password.
    """
    from app.core.security import create_refresh_token

    svc = AuthService(db)
    result = await svc.firebase_login(
        id_token=body.id_token,
        device_info=body.device_info.model_dump() if body.device_info else None,
        ip_address=request.client.host if request.client else None,
    )

    # Set refresh token in HttpOnly cookie
    # We need to get the session_id from the access_token to build the refresh token
    from app.core.security import decode_token
    payload = decode_token(result.access_token)
    session_id = payload["jti"]
    from uuid import UUID
    refresh_token = create_refresh_token(UUID(payload["sub"]), session_id)
    _set_refresh_cookie(response, refresh_token)

    return result


# ── Direct Email/Password Login ───────────────────────────────────────────────

@router.post("/login", response_model=LoginResponse)
async def email_login(
    body: EmailLoginRequest,
    request: Request,
    response: Response,
    db: DatabaseDep,
) -> LoginResponse:
    """
    Authenticate with email + password (direct bcrypt, no Firebase).
    Primary use: accounts created via /auth/register.
    """
    from app.core.security import create_refresh_token, decode_token

    svc = AuthService(db)
    result = await svc.email_login(
        email=body.email,
        password=body.password,
        device_info=body.device_info.model_dump() if body.device_info else None,
        ip_address=request.client.host if request.client else None,
    )

    payload = decode_token(result.access_token)
    session_id = payload["jti"]
    refresh_token = create_refresh_token(UUID(payload["sub"]), session_id)
    _set_refresh_cookie(response, refresh_token)

    return result


# ── Register ──────────────────────────────────────────────────────────────────

@router.post("/register", response_model=LoginResponse, status_code=201)
async def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    db: DatabaseDep,
) -> LoginResponse:
    """
    Create a new account with email + password.
    Optionally provide org_name to also create an organization.
    """
    from app.core.security import create_refresh_token, decode_token

    svc = AuthService(db)
    result = await svc.register(
        email=body.email,
        name=body.name,
        password=body.password,
        org_name=body.org_name,
        device_info=body.device_info.model_dump() if body.device_info else None,
        ip_address=request.client.host if request.client else None,
    )

    payload = decode_token(result.access_token)
    session_id = payload["jti"]
    refresh_token = create_refresh_token(UUID(payload["sub"]), session_id)
    _set_refresh_cookie(response, refresh_token)

    return result


# ── Token Refresh ─────────────────────────────────────────────────────────────

@router.post("/refresh", response_model=TokenRefreshResponse)
async def refresh_token(
    db: DatabaseDep,
    docflow_refresh: str | None = Cookie(default=None, alias=_REFRESH_COOKIE),
) -> TokenRefreshResponse:
    """
    Refresh access token using the HttpOnly refresh cookie.
    Called automatically by the frontend API client on 401.
    """
    if not docflow_refresh:
        raise UnauthorizedException("No refresh token cookie present")

    svc = AuthService(db)
    return await svc.refresh_token(docflow_refresh)


# ── Logout ────────────────────────────────────────────────────────────────────

@router.post("/logout", response_model=MessageResponse)
async def logout(
    response: Response,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Revoke current session. Clears the refresh cookie."""
    svc = AuthService(db)
    await svc.logout(current_user.session_id)
    _clear_refresh_cookie(response)
    return MessageResponse(message="Logged out successfully")


@router.post("/logout-all", response_model=MessageResponse)
async def logout_all(
    response: Response,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Revoke all sessions for the current user (sign out all devices)."""
    svc = AuthService(db)
    await svc.logout_all(current_user.id)
    _clear_refresh_cookie(response)
    return MessageResponse(message="Signed out from all devices")


# ── Me (Current User) ─────────────────────────────────────────────────────────

@router.get("/me", response_model=MeResponse)
async def get_me(
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MeResponse:
    """Return current user's profile, org membership, and active sessions."""
    svc = AuthService(db)
    return await svc.get_me(current_user.id, current_user.session_id)


@router.patch("/me", response_model=UserResponse)
async def update_profile(
    body: UpdateProfileRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> UserResponse:
    """Update own profile: name, avatar_url, notification_prefs."""
    svc = AuthService(db)
    return await svc.update_profile(
        user_id=current_user.id,
        name=body.name,
        avatar_url=body.avatar_url,
        notification_prefs=body.notification_prefs,
    )


# ── Password Management ────────────────────────────────────────────────────────

@router.put("/password", response_model=MessageResponse)
async def change_password(
    body: ChangePasswordRequest,
    response: Response,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """
    Change password. Revokes all sessions — user must re-login.
    Only available for email/password accounts.
    """
    svc = AuthService(db)
    await svc.change_password(
        user_id=current_user.id,
        current_password=body.current_password,
        new_password=body.new_password,
    )
    _clear_refresh_cookie(response)
    return MessageResponse(message="Password changed. Please log in again.")


# ── Session Management ─────────────────────────────────────────────────────────

@router.get("/sessions", response_model=list[SessionInfo])
async def list_sessions(
    current_user: CurrentUser,
    db: DatabaseDep,
) -> list[SessionInfo]:
    """List all active sessions for the current user."""
    from app.repositories.user_repo import SessionRepository
    repo = SessionRepository(db)
    sessions = await repo.list_active(current_user.id)
    return [
        SessionInfo(
            id=s.id,
            device_info=s.device_info,
            ip_address=str(s.ip_address) if s.ip_address else None,
            created_at=s.created_at,
            expires_at=s.expires_at,
            is_current=(s.session_token == current_user.session_id),
        )
        for s in sessions
    ]


@router.delete("/sessions/{session_id}", response_model=MessageResponse)
async def revoke_session(
    session_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    """Revoke a specific session (must belong to current user)."""
    svc = AuthService(db)
    await svc.revoke_session(session_id, current_user.id)
    return MessageResponse(message="Session revoked")
