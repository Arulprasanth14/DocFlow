"""
Auth hardening — Phase F: refresh-token rotation and reuse detection (Gap #5).

Rotation ships behind REFRESH_ROTATION_ENABLED, default OFF, so every test
here turns it on explicitly - and one test asserts that with the flag off the
old behaviour is still exactly what it was.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from firebase_admin import auth as fb_auth
from sqlalchemy import select

from app.config import settings
from app.core import firebase as fb
from app.models.user import Session as UserSession
from conftest import auth_headers

REFRESH_URL = "/api/v1/auth/refresh"
LOGIN_URL = "/api/v1/auth/firebase-login"
PROTECTED_URL = "/api/v1/orgs/me"
COOKIE = "docflow_refresh"


class FakeFirebase:
    def __init__(self) -> None:
        self.identities: dict[str, dict] = {}

    def add(self, token: str, *, uid: str, email: str) -> str:
        self.identities[token] = {
            "uid": uid, "email": email, "email_verified": True,
            "name": "Rotation Tester", "firebase": {"sign_in_provider": "google.com"},
        }
        return token

    def __call__(self, token, **kwargs):
        if token not in self.identities:
            raise fb_auth.InvalidIdTokenError("unknown token")
        return self.identities[token]


@pytest.fixture
def firebase(monkeypatch):
    monkeypatch.setattr(fb, "_firebase_app", object())
    fake = FakeFirebase()
    monkeypatch.setattr(fb_auth, "verify_id_token", fake)
    return fake


@pytest.fixture
def rotation_on(monkeypatch):
    monkeypatch.setattr(settings, "REFRESH_ROTATION_ENABLED", True)
    monkeypatch.setattr(settings, "REFRESH_REUSE_GRACE_SECONDS", 10)


async def _session_for(db_session, cookie: str) -> UserSession:
    """The session row a refresh cookie names.

    Resolved through the cookie's own `jti` rather than "the newest row for
    this user": the `worker` fixture already creates a session of its own, so
    picking by user would sometimes operate on the wrong one (and did).
    """
    from app.core.security import decode_token

    jti = decode_token(cookie, expected_type="refresh")["jti"]
    row = (
        await db_session.execute(
            select(UserSession).where(UserSession.session_token == jti)
        )
    ).scalars().first()
    assert row is not None
    return row


async def _family_rows(db_session, cookie: str):
    """Every row in the family the cookie belongs to, oldest first."""
    session = await _session_for(db_session, cookie)
    return (
        await db_session.execute(
            select(UserSession.family_id, UserSession.rotated_at, UserSession.replaced_by,
                   UserSession.expires_at)
            .where(UserSession.family_id == session.family_id)
            .order_by(UserSession.created_at)
        )
    ).all()


async def _login(client, firebase, db_session, worker) -> str:
    """Sign the worker in through the Firebase path; return the refresh cookie."""
    worker_user, _ = worker
    worker_user.firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    await db_session.commit()
    token = firebase.add(
        "tok-" + uuid.uuid4().hex, uid=worker_user.firebase_uid, email=worker_user.email
    )
    response = await client.post(LOGIN_URL, json={"id_token": token})
    assert response.status_code == 200, response.text
    cookie = client.cookies.get(COOKIE)
    assert cookie
    return cookie


# ── the happy path ───────────────────────────────────────────────────────────

async def test_refresh_rotates_the_cookie_and_the_session(
    client, db_session, worker, firebase, rotation_on
):
    first = await _login(client, firebase, db_session, worker)

    response = await client.post(REFRESH_URL, cookies={COOKIE: first})
    assert response.status_code == 200
    second = response.cookies.get(COOKIE)
    assert second and second != first

    # The new access token works.
    new_access = response.json()["access_token"]
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(new_access))
    ).status_code == 200


async def test_the_successor_stays_in_the_same_family(
    client, db_session, worker, firebase, rotation_on
):
    first = await _login(client, firebase, db_session, worker)
    await client.post(REFRESH_URL, cookies={COOKIE: first})

    rows = await _family_rows(db_session, first)
    assert len(rows) == 2
    assert rows[0].family_id == rows[1].family_id       # one family
    assert rows[0].rotated_at is not None               # the original is spent
    assert rows[0].replaced_by is not None              # and points at its heir
    assert rows[1].rotated_at is None                   # the heir is current


async def test_rotation_does_not_extend_the_family_lifetime(
    client, db_session, worker, firebase, rotation_on
):
    """The 30-day cap is absolute from login: rotating must not slide it."""
    first = await _login(client, firebase, db_session, worker)
    original_expiry = (await _session_for(db_session, first)).expires_at

    await client.post(REFRESH_URL, cookies={COOKIE: first})

    rows = await _family_rows(db_session, first)
    assert len(rows) == 2
    assert all(row.expires_at == original_expiry for row in rows)


# ── reuse: theft vs. a parallel tab ─────────────────────────────────────────

async def test_replaying_a_rotated_token_outside_the_grace_window_kills_the_family(
    client, db_session, worker, firebase, rotation_on, monkeypatch
):
    monkeypatch.setattr(settings, "REFRESH_REUSE_GRACE_SECONDS", 0)
    first = await _login(client, firebase, db_session, worker)
    rotated = await client.post(REFRESH_URL, cookies={COOKIE: first})
    second = rotated.cookies.get(COOKIE)

    replay = await client.post(REFRESH_URL, cookies={COOKIE: first})
    assert replay.status_code == 401
    assert replay.json().get("code") == "SESSION_REVOKED"

    # The legitimate holder is cut off too: there is no way to tell which of
    # the two presenters was the thief.
    after = await client.post(REFRESH_URL, cookies={COOKIE: second})
    assert after.status_code == 401

    session = await _session_for(db_session, first)
    reasons = (
        await db_session.execute(
            select(UserSession.revoked_reason)
            .where(UserSession.family_id == session.family_id)
        )
    ).scalars().all()
    assert "theft" in reasons


async def test_replaying_inside_the_grace_window_is_a_retry_not_a_theft(
    client, db_session, worker, firebase, rotation_on
):
    """Two tabs refreshing at once must not log the user out."""
    first = await _login(client, firebase, db_session, worker)
    rotated = await client.post(REFRESH_URL, cookies={COOKIE: first})
    second = rotated.cookies.get(COOKIE)

    replay = await client.post(REFRESH_URL, cookies={COOKIE: first})
    assert replay.status_code == 401
    assert replay.json().get("code") == "RETRY_REFRESH"

    # ...and the real successor still works.
    assert (await client.post(REFRESH_URL, cookies={COOKIE: second})).status_code == 200


async def test_two_parallel_refreshes_do_not_log_the_user_out(
    client, db_session, worker, firebase, rotation_on
):
    first = await _login(client, firebase, db_session, worker)

    results = await asyncio.gather(
        client.post(REFRESH_URL, cookies={COOKIE: first}),
        client.post(REFRESH_URL, cookies={COOKIE: first}),
    )
    statuses = sorted(r.status_code for r in results)
    assert statuses == [200, 401], statuses
    loser = next(r for r in results if r.status_code == 401)
    assert loser.json().get("code") == "RETRY_REFRESH"

    winner = next(r for r in results if r.status_code == 200)
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(winner.json()["access_token"]))
    ).status_code == 200


async def test_an_expired_family_cannot_be_refreshed(
    client, db_session, worker, firebase, rotation_on
):
    first = await _login(client, firebase, db_session, worker)
    session = await _session_for(db_session, first)
    session.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    response = await client.post(REFRESH_URL, cookies={COOKIE: first})
    assert response.status_code == 401


async def test_a_revoked_session_cannot_be_refreshed(
    client, db_session, worker, firebase, rotation_on
):
    first = await _login(client, firebase, db_session, worker)
    session = await _session_for(db_session, first)
    session.revoke(reason="admin")
    await db_session.commit()

    response = await client.post(REFRESH_URL, cookies={COOKIE: first})
    assert response.status_code == 401
    assert response.json().get("code") == "SESSION_REVOKED"


# ── flag off: nothing changed ───────────────────────────────────────────────

async def test_with_rotation_off_the_cookie_is_left_alone(
    client, db_session, worker, firebase, monkeypatch
):
    monkeypatch.setattr(settings, "REFRESH_ROTATION_ENABLED", False)
    first = await _login(client, firebase, db_session, worker)

    response = await client.post(REFRESH_URL, cookies={COOKIE: first})
    assert response.status_code == 200
    assert response.cookies.get(COOKIE) is None      # no new cookie issued

    # The same token keeps working, exactly as before this phase.
    assert (await client.post(REFRESH_URL, cookies={COOKIE: first})).status_code == 200
