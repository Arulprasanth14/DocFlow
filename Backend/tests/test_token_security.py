"""
Auth hardening — Phase A: token forgery and session binding.

Scenarios #1, #2 and #3 of the Auth/RBAC spec section 16.2, plus the happy
paths that must keep working:

  1. an HS256 token signed with the RSA PUBLIC key is rejected under RS256
  2. a token with alg=none is rejected
  3. a token carrying a real session id but another user's `sub` is rejected

Each forged token is assembled by hand with stdlib HMAC rather than with
python-jose, because jose refuses to use PEM key material as an HMAC secret
— and that refusal is ours, not an attacker's: they build the token outside
our process.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwt
from sqlalchemy import select

from app.config import settings
from app.core.exceptions import UnauthorizedException
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    validate_jwt_config,
)
from app.models.user import Session as UserSession
from conftest import auth_headers

# A route that needs CurrentUser but is NOT under /api/v1/auth, so these
# tests never share the tighter auth rate-limit bucket.
PROTECTED_URL = "/api/v1/orgs/me"


# ── helpers ───────────────────────────────────────────────────────────────────

def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _signing_input(header: dict, payload: dict) -> bytes:
    return (
        _b64(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64(json.dumps(payload, separators=(",", ":")).encode())
    ).encode("ascii")


def _forge_hs256(payload: dict, secret: bytes) -> str:
    """Sign with HS256 using `secret` — the algorithm-confusion attack."""
    signing_input = _signing_input({"alg": "HS256", "typ": "JWT"}, payload)
    signature = hmac.new(secret, signing_input, hashlib.sha256).digest()
    return signing_input.decode("ascii") + "." + _b64(signature)


def _forge_alg_none(payload: dict) -> str:
    return _signing_input({"alg": "none", "typ": "JWT"}, payload).decode("ascii") + "."


def _claims(**overrides) -> dict:
    """The claims an attacker would want: superadmin, on some real-looking org."""
    claims = {
        "sub": str(uuid.uuid4()),
        "org_id": str(uuid.uuid4()),
        "roles": ["admin"],
        "permissions": ["admin:users"],
        "is_superadmin": True,
        "jti": str(uuid.uuid4()),
        "exp": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp()),
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "iss": "docflow",
        "type": "access",
    }
    claims.update(overrides)
    return claims


@pytest.fixture
def rsa_configured(monkeypatch):
    """Put the process into the RS256 configuration; hand back the key pair."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    monkeypatch.setattr(settings, "JWT_PRIVATE_KEY", private_pem, raising=False)
    monkeypatch.setattr(settings, "JWT_PUBLIC_KEY", public_pem, raising=False)
    monkeypatch.setattr(settings, "JWT_ALGORITHM", "RS256", raising=False)
    return private_pem, public_pem


@pytest.fixture
def hs256_configured(monkeypatch):
    """Force the HS256 development fallback; hand back the shared secret."""
    secret = "t" * 48
    monkeypatch.setattr(settings, "JWT_PRIVATE_KEY", "PLACEHOLDER", raising=False)
    monkeypatch.setattr(settings, "JWT_PUBLIC_KEY", "PLACEHOLDER", raising=False)
    monkeypatch.setattr(settings, "SECRET_KEY", secret, raising=False)
    return secret


# ── Scenario 1: HS256 signed with the RSA public key (Gap #1) ────────────────

def test_hs256_token_signed_with_the_rsa_public_key_is_rejected(rsa_configured):
    _, public_pem = rsa_configured
    forged = _forge_hs256(_claims(), public_pem.encode())
    with pytest.raises(UnauthorizedException):
        decode_token(forged, expected_type="access")


def test_hs256_forgery_is_rejected_for_every_public_key_encoding(rsa_configured):
    """The public key is not secret, so try the shapes an attacker would try."""
    _, public_pem = rsa_configured
    for secret in (
        public_pem.encode(),
        public_pem.strip().encode(),
        public_pem.replace("\n", "").encode(),
        public_pem.encode().replace(b"\r\n", b"\n"),
    ):
        with pytest.raises(UnauthorizedException):
            decode_token(_forge_hs256(_claims(), secret), expected_type="access")


# ── Scenario 2: alg=none ─────────────────────────────────────────────────────

def test_alg_none_token_is_rejected_under_rs256(rsa_configured):
    with pytest.raises(UnauthorizedException):
        decode_token(_forge_alg_none(_claims()), expected_type="access")


def test_alg_none_token_is_rejected_under_hs256(hs256_configured):
    with pytest.raises(UnauthorizedException):
        decode_token(_forge_alg_none(_claims()), expected_type="access")


# ── Happy path and token kind ────────────────────────────────────────────────

def test_a_normally_issued_access_token_still_validates():
    user_id, session_id = uuid.uuid4(), str(uuid.uuid4())
    token = create_access_token(
        user_id=user_id,
        org_id=uuid.uuid4(),
        roles=["worker"],
        permissions=["documents:read"],
        session_id=session_id,
    )
    payload = decode_token(token, expected_type="access")
    assert payload["sub"] == str(user_id)
    assert payload["jti"] == session_id
    assert payload["type"] == "access"


def test_a_normally_issued_token_validates_under_rs256(rsa_configured):
    token = create_access_token(
        user_id=uuid.uuid4(),
        org_id=None,
        roles=[],
        permissions=[],
        session_id=str(uuid.uuid4()),
    )
    assert decode_token(token, expected_type="access")["type"] == "access"


def test_a_refresh_token_is_not_accepted_as_an_access_token():
    token = create_refresh_token(uuid.uuid4(), str(uuid.uuid4()))
    with pytest.raises(UnauthorizedException):
        decode_token(token, expected_type="access")
    # ...but is still valid as the kind of token it actually is.
    assert decode_token(token, expected_type="refresh")["type"] == "refresh"


def test_a_token_without_a_type_claim_is_rejected(hs256_configured):
    """python-jose ignores options={"require": [...]}, so this is our check."""
    claims = _claims()
    claims.pop("type")
    token = jwt.encode(claims, hs256_configured, algorithm="HS256")
    with pytest.raises(UnauthorizedException):
        decode_token(token, expected_type="access")


def test_a_token_from_another_issuer_is_rejected(hs256_configured):
    token = jwt.encode(_claims(iss="evil"), hs256_configured, algorithm="HS256")
    with pytest.raises(UnauthorizedException):
        decode_token(token, expected_type="access")


def test_an_expired_token_is_rejected(hs256_configured):
    expired = _claims(
        exp=int((datetime.now(timezone.utc) - timedelta(minutes=1)).timestamp())
    )
    token = jwt.encode(expired, hs256_configured, algorithm="HS256")
    with pytest.raises(UnauthorizedException):
        decode_token(token, expected_type="access")


# ── Scenario 3: real session id, different sub (Gap #6) ──────────────────────

async def test_a_real_session_id_with_another_users_sub_is_rejected(
    client, db_session, admin, worker
):
    """Signed with the real key, so only the session-user binding can stop it."""
    admin_user, _ = admin
    worker_user, _ = worker
    worker_session = (
        await db_session.execute(
            select(UserSession).where(UserSession.user_id == worker_user.id)
        )
    ).scalars().first()
    assert worker_session is not None

    forged = create_access_token(
        user_id=admin_user.id,                      # claims to be the admin...
        org_id=None,
        roles=["admin"],
        permissions=["admin:users"],
        session_id=worker_session.session_token,    # ...on the worker's session
        is_superadmin=True,
    )
    response = await client.get(PROTECTED_URL, headers=auth_headers(forged))
    assert response.status_code == 401


async def test_a_token_on_its_own_session_still_works(client, worker):
    _, token = worker
    response = await client.get(PROTECTED_URL, headers=auth_headers(token))
    assert response.status_code == 200


async def test_a_revoked_session_is_rejected(client, db_session, worker):
    worker_user, token = worker
    session = (
        await db_session.execute(
            select(UserSession).where(UserSession.user_id == worker_user.id)
        )
    ).scalars().first()
    session.revoke()
    await db_session.commit()

    response = await client.get(PROTECTED_URL, headers=auth_headers(token))
    assert response.status_code == 401


async def test_refresh_rejects_a_session_belonging_to_another_user(
    client, db_session, admin, worker
):
    """Same binding on /auth/refresh: another user's session id must not work."""
    admin_user, _ = admin
    worker_user, _ = worker
    worker_session = (
        await db_session.execute(
            select(UserSession).where(UserSession.user_id == worker_user.id)
        )
    ).scalars().first()

    forged_refresh = create_refresh_token(admin_user.id, worker_session.session_token)
    response = await client.post(
        "/api/v1/auth/refresh", cookies={"docflow_refresh": forged_refresh}
    )
    assert response.status_code == 401


# ── Startup configuration validation ────────────────────────────────────────

def test_startup_refuses_the_none_algorithm(monkeypatch):
    monkeypatch.setattr(settings, "JWT_ALGORITHM", "none", raising=False)
    with pytest.raises(RuntimeError, match="not supported"):
        validate_jwt_config()


def test_startup_refuses_an_empty_algorithm(monkeypatch):
    monkeypatch.setattr(settings, "JWT_ALGORITHM", "", raising=False)
    with pytest.raises(RuntimeError, match="not supported"):
        validate_jwt_config()


def test_startup_refuses_an_unknown_algorithm(monkeypatch):
    monkeypatch.setattr(settings, "JWT_ALGORITHM", "RS257", raising=False)
    with pytest.raises(RuntimeError, match="not supported"):
        validate_jwt_config()


def test_startup_refuses_rs256_without_pem_keys(monkeypatch):
    monkeypatch.setattr(settings, "JWT_ALGORITHM", "RS256", raising=False)
    monkeypatch.setattr(settings, "JWT_PRIVATE_KEY", "not-a-pem-key", raising=False)
    monkeypatch.setattr(settings, "JWT_PUBLIC_KEY", "not-a-pem-key", raising=False)
    with pytest.raises(RuntimeError, match="PEM key material"):
        validate_jwt_config()


def test_startup_accepts_a_valid_rs256_setup(rsa_configured):
    validate_jwt_config()


def test_startup_accepts_the_hs256_development_fallback(hs256_configured):
    # JWT_ALGORITHM still says RS256, but no real key is configured, so the
    # resolved algorithm is HS256 with a long enough secret.
    monkeypatch_free = settings.JWT_ALGORITHM
    assert monkeypatch_free in ("RS256", "HS256")
    validate_jwt_config()
