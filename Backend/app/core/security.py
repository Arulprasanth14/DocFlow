"""
DocFlow Backend — Core: Security
JWT encode/decode (RS256), password hashing (bcrypt rounds=12),
token refresh, session management helpers.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from jose import JWTError, jwt
import bcrypt

from app.config import settings
from app.core.exceptions import UnauthorizedException


def hash_password(password: str) -> str:
    """Hash a plaintext password using bcrypt."""
    pw_bytes = password.encode("utf-8")[:72]
    return bcrypt.hashpw(pw_bytes, bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plaintext password against its bcrypt hash."""
    try:
        pw_bytes = plain_password.encode("utf-8")[:72]
        return bcrypt.checkpw(pw_bytes, hashed_password.encode("utf-8"))
    except Exception:
        return False


# ── JWT ────────────────────────────────────────────────────────────────────────

def _get_private_key() -> str:
    """
    Get the JWT signing private key.
    In development without a real RSA key, falls back to HS256 with SECRET_KEY.
    """
    key = settings.JWT_PRIVATE_KEY
    if not key or "PLACEHOLDER" in key:
        return settings.SECRET_KEY   # dev fallback
    return key


def _get_public_key() -> str:
    """Get the JWT verification public key (or SECRET_KEY for dev HS256 fallback)."""
    key = settings.JWT_PUBLIC_KEY
    if not key or "PLACEHOLDER" in key:
        return settings.SECRET_KEY   # dev fallback
    return key


def _get_algorithm() -> str:
    """RS256 if real keys configured, HS256 as dev fallback."""
    if "PLACEHOLDER" in (settings.JWT_PRIVATE_KEY or "PLACEHOLDER"):
        return "HS256"
    return settings.JWT_ALGORITHM


def create_access_token(
    user_id: UUID,
    org_id: UUID | None,
    roles: list[str],
    permissions: list[str],
    session_id: str,
) -> str:
    """
    Issue a short-lived access token (2 hours).
    Claims: sub, org_id, roles, permissions, jti (session_id), exp, iat, iss
    """
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "org_id": str(org_id) if org_id else None,
        "roles": roles,
        "permissions": permissions,
        "jti": session_id,      # used for session revocation check
        "exp": now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
        "iat": now,
        "iss": "docflow",
        "type": "access",
    }
    return jwt.encode(payload, _get_private_key(), algorithm=_get_algorithm())


def create_refresh_token(user_id: UUID, session_id: str) -> str:
    """
    Issue a long-lived refresh token (30 days).
    Stored in HttpOnly, SameSite=Strict cookie.
    """
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "jti": session_id,
        "exp": now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        "iat": now,
        "iss": "docflow",
        "type": "refresh",
    }
    return jwt.encode(payload, _get_private_key(), algorithm=_get_algorithm())


def decode_token(token: str) -> dict[str, Any]:
    """
    Decode and verify a JWT token.
    Raises UnauthorizedException on invalid/expired token.
    """
    try:
        payload = jwt.decode(
            token,
            _get_public_key(),
            algorithms=[_get_algorithm(), "HS256"],   # accept both during transition
            options={"require": ["sub", "exp", "iss"]},
        )
        if payload.get("iss") != "docflow":
            raise UnauthorizedException("Invalid token issuer")
        return payload
    except JWTError as exc:
        raise UnauthorizedException(f"Token validation failed: {exc}") from exc


verify_jwt = decode_token


def generate_session_id() -> str:
    """Generate a cryptographically secure session ID (UUID4)."""
    return str(uuid4())


def generate_invite_token() -> str:
    """Generate a secure random invite token (URL-safe, 32 bytes)."""
    return secrets.token_urlsafe(32)


def generate_csrf_token() -> str:
    """Generate a CSRF token for the double-submit cookie pattern."""
    return secrets.token_urlsafe(32)
