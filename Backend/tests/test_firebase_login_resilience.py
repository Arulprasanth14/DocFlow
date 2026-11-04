"""
Regression tests for the "SSO login keeps asking me to create an organization"
bug.

Root cause: verify_firebase_token only converted ValueError into a handled
error. Any other failure from the Firebase SDK (network/TLS error, certificate
fetch failure, ...) escaped as an unhandled exception -> HTTP 500 from both
/auth/firebase-login and /users/me/sync. The frontend treated that failure as
"this user has no organization" and routed a returning user to onboarding.

Contract now:
  bad token            -> ValueError           -> 401
  Firebase unreachable -> FirebaseUnavailable  -> 503 (retryable, NOT 500/401)
  revocation check unreachable but signature valid -> login still succeeds
"""
from __future__ import annotations

import pytest
from firebase_admin import auth as fb_auth

from app.core import firebase as fb


@pytest.fixture(autouse=True)
def _firebase_enabled(monkeypatch):
    monkeypatch.setattr(fb, "_firebase_app", object())


def _claims():
    return {"uid": "u1", "email": "a@b.com", "name": "A", "firebase": {"sign_in_provider": "google.com"}}


async def test_invalid_token_is_a_value_error(monkeypatch):
    def boom(*a, **k):
        raise fb_auth.InvalidIdTokenError("bad")

    monkeypatch.setattr(fb_auth, "verify_id_token", boom)
    with pytest.raises(ValueError):
        await fb.verify_firebase_token("x")


async def test_expired_token_is_a_value_error(monkeypatch):
    def boom(*a, **k):
        raise fb_auth.ExpiredIdTokenError("expired", cause=None)

    monkeypatch.setattr(fb_auth, "verify_id_token", boom)
    with pytest.raises(ValueError, match="expired"):
        await fb.verify_firebase_token("x")


@pytest.mark.parametrize(
    "exc",
    [
        ConnectionError("refused"),
        OSError("[SSL: CERTIFICATE_VERIFY_FAILED]"),
        TimeoutError("slow"),
        RuntimeError("anything the SDK throws"),
    ],
)
async def test_network_errors_become_unavailable_not_unhandled(monkeypatch, exc):
    def boom(*a, **k):
        raise exc

    monkeypatch.setattr(fb_auth, "verify_id_token", boom)
    with pytest.raises(fb.FirebaseUnavailableError):
        await fb.verify_firebase_token("x")


async def test_revocation_check_outage_does_not_block_login(monkeypatch):
    calls = []

    def fake(token, check_revoked=False, **k):
        calls.append(check_revoked)
        if check_revoked:
            raise ConnectionError("identitytoolkit unreachable")
        return _claims()

    monkeypatch.setattr(fb_auth, "verify_id_token", fake)
    out = await fb.verify_firebase_token("x")
    assert out["uid"] == "u1"
    assert calls == [False, True]  # signature verified first, revocation best-effort


async def test_revoked_token_is_still_rejected(monkeypatch):
    def fake(token, check_revoked=False, **k):
        if check_revoked:
            raise fb_auth.RevokedIdTokenError("revoked")
        return _claims()

    monkeypatch.setattr(fb_auth, "verify_id_token", fake)
    with pytest.raises(ValueError, match="revoked"):
        await fb.verify_firebase_token("x")


async def test_strict_mode_fails_closed_when_revocation_unreachable(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "FIREBASE_REVOCATION_FAIL_CLOSED", True, raising=False)

    def fake(token, check_revoked=False, **k):
        if check_revoked:
            raise ConnectionError("down")
        return _claims()

    monkeypatch.setattr(fb_auth, "verify_id_token", fake)
    with pytest.raises(fb.FirebaseUnavailableError):
        await fb.verify_firebase_token("x")


async def test_verification_does_not_block_the_event_loop(monkeypatch):
    """The SDK call is blocking network I/O; it must run off the loop."""
    import asyncio
    import threading

    main_thread = threading.get_ident()
    seen = {}

    def fake(token, **k):
        seen["thread"] = threading.get_ident()
        return _claims()

    monkeypatch.setattr(fb_auth, "verify_id_token", fake)
    await fb.verify_firebase_token("x")
    assert seen["thread"] != main_thread


# ── HTTP contract ───────────────────────────────────────────────────────────

async def test_login_endpoint_returns_503_not_500_when_firebase_is_down(client, monkeypatch):
    def boom(*a, **k):
        raise ConnectionError("down")

    monkeypatch.setattr(fb_auth, "verify_id_token", boom)
    resp = await client.post("/api/v1/auth/firebase-login", json={"id_token": "x" * 40})
    assert resp.status_code == 503, resp.text


async def test_login_endpoint_returns_401_for_a_bad_token(client, monkeypatch):
    def boom(*a, **k):
        raise fb_auth.InvalidIdTokenError("bad")

    monkeypatch.setattr(fb_auth, "verify_id_token", boom)
    resp = await client.post("/api/v1/auth/firebase-login", json={"id_token": "x" * 40})
    assert resp.status_code == 401, resp.text


async def test_sync_endpoint_returns_503_not_500_when_firebase_is_down(client, monkeypatch):
    def boom(*a, **k):
        raise ConnectionError("down")

    monkeypatch.setattr(fb_auth, "verify_id_token", boom)
    resp = await client.post(
        "/api/v1/users/me/sync",
        json={"org_name": "Acme"},
        headers={"Authorization": "Bearer abc"},
    )
    assert resp.status_code == 503, resp.text


async def test_returning_user_login_keeps_their_org(client, db_session, org, admin, monkeypatch):
    """A returning SSO user must come back with their existing membership and
    must NOT be asked to create an organization."""
    admin_user, _ = admin
    admin_user.firebase_uid = "fb-returning"
    await db_session.commit()

    monkeypatch.setattr(
        fb_auth,
        "verify_id_token",
        lambda *a, **k: {"uid": "fb-returning", "email": admin_user.email, "name": "Admin User", "firebase": {}},
    )
    resp = await client.post("/api/v1/auth/firebase-login", json={"id_token": "x" * 40})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["org_membership"] is not None
    assert body["org_membership"]["role_name"] == "admin"
    assert body["org_membership"]["org_id"] == str(org.id)
