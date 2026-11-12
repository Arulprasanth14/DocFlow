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
from jose.exceptions import ExpiredSignatureError
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
    is_superadmin: bool = False,
) -> str:
    """
    Issue a short-lived access token (2 hours).
    Claims: sub, org_id, roles, permissions, is_superadmin, jti (session_id), exp, iat, iss
    """
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "org_id": str(org_id) if org_id else None,
        "roles": roles,
        "permissions": permissions,
        "is_superadmin": is_superadmin,
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


#: Every algorithm this deployment is allowed to be configured with. `none`,
#: an empty value and typos are therefore rejected at startup rather than
#: being handed to the decoder at request time.
JWT_ALGORITHM_ALLOWLIST: tuple[str, ...] = (
    "HS256", "HS384", "HS512", "RS256", "RS384", "RS512",
)

#: Claims that must be present on every DocFlow token. python-jose IGNORES
#: `options={"require": [...]}` (verified: a token with no `type` decodes
#: fine with it set), so the check has to happen here or not at all.
_REQUIRED_CLAIMS: tuple[str, ...] = ("sub", "exp", "iss", "type")


def validate_jwt_config() -> None:
    """
    Fail fast on a JWT configuration that cannot be verified safely.

    Called from the application lifespan. Three failure modes:

      * `JWT_ALGORITHM` is not on the allowlist — including `none`, which is
        the algorithm an attacker asks for.
      * RS* is in force but `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` are not PEM key
        material, so signing or verifying would fail at the first request.
      * HS* is in force with a secret too short to be the whole security
        boundary. In production that is fatal (`validate_production` asserts
        it too); outside production it is a warning, because the default
        development secret is deliberately short and must not block boot.

    Signing and verifying both resolve the algorithm through
    `_get_algorithm()`, so this validates the one value both use.
    """
    configured = (settings.JWT_ALGORITHM or "").strip()
    if configured not in JWT_ALGORITHM_ALLOWLIST:
        raise RuntimeError(
            f"JWT_ALGORITHM={configured!r} is not supported. Allowed: "
            f"{', '.join(JWT_ALGORITHM_ALLOWLIST)}."
        )

    algorithm = _get_algorithm()
    if algorithm not in JWT_ALGORITHM_ALLOWLIST:
        raise RuntimeError(
            f"Resolved JWT algorithm {algorithm!r} is not supported. Allowed: "
            f"{', '.join(JWT_ALGORITHM_ALLOWLIST)}."
        )

    if algorithm.startswith("RS"):
        if "BEGIN" not in _get_private_key() or "BEGIN" not in _get_public_key():
            raise RuntimeError(
                f"JWT algorithm {algorithm} is configured, but JWT_PRIVATE_KEY / "
                "JWT_PUBLIC_KEY do not contain PEM key material."
            )
    elif len(settings.SECRET_KEY) < 32:
        message = (
            f"JWT algorithm {algorithm} is in force (no RSA key configured) but "
            "SECRET_KEY is shorter than 32 characters."
        )
        if settings.is_production:
            raise RuntimeError(message)
        import warnings

        warnings.warn(message, RuntimeWarning, stacklevel=2)


def decode_token(token: str, *, expected_type: str | None = None) -> dict[str, Any]:
    """
    Decode and verify a JWT token.
    Raises UnauthorizedException on an invalid, expired or wrong-kind token.

    The algorithm is PINNED to the single algorithm this deployment signs
    with. The decoder used to also accept "HS256" alongside the configured
    one, which is the classic algorithm-confusion setup: under RS256 the
    verification key is the RSA PUBLIC key, which by definition is not
    secret, so a forger signs `alg: HS256` using those key bytes as the HMAC
    secret and the signature verifies.

    Measured behaviour of the old two-algorithm decoder, so nobody has to
    re-derive it: with a PEM-formatted public key python-jose happened to
    refuse the HMAC construction and raised `JWKError`, which is NOT a
    `JWTError` and so escaped the handler below as an unhandled 500 rather
    than a 401. With a public key carrying no PEM markers (base64 DER, a
    JWKS blob) the forged token was accepted outright, `is_superadmin: true`
    included. Pinning removes the dependency on that library accident and
    turns every variant into a clean 401.

    `expected_type` rejects a token of the wrong kind, so a refresh token
    cannot be presented as an access token or vice versa. Callers that
    legitimately accept either kind pass None.
    """
    try:
        payload = jwt.decode(
            token,
            _get_public_key(),
            algorithms=[_get_algorithm()],
        )
    except ExpiredSignatureError as exc:
        # Distinct from a malformed token: the client should refresh once,
        # not sign the user out (spec section 3.3).
        raise UnauthorizedException(
            f"Token validation failed: {exc}", code="TOKEN_EXPIRED"
        ) from exc
    except JWTError as exc:
        raise UnauthorizedException(
            f"Token validation failed: {exc}", code="INVALID_TOKEN"
        ) from exc

    missing = [claim for claim in _REQUIRED_CLAIMS if payload.get(claim) is None]
    if missing:
        raise UnauthorizedException(
            f"Token validation failed: missing claim(s) {', '.join(missing)}",
            code="INVALID_TOKEN",
        )
    if payload.get("iss") != "docflow":
        raise UnauthorizedException("Invalid token issuer", code="INVALID_TOKEN")
    if expected_type is not None and payload.get("type") != expected_type:
        raise UnauthorizedException(
            "Token is not valid for this operation", code="INVALID_TOKEN"
        )
    return payload


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
