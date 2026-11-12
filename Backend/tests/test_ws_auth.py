"""
Auth hardening — Phase D: WebSockets enforce the same rules as HTTP.

Spec section 16.2 scenario 11: a revoked session, another user's session id
and an expired token must all be refused. Before Phase D the handlers only
verified the JWT signature, so a revoked session kept a live socket and a
refresh token was accepted as a credential.

Mechanics worth knowing:

* Starlette's sync TestClient is used because httpx + ASGITransport cannot
  open a WebSocket. The app closes before `accept()` on a rejection, which
  the test client surfaces as WebSocketDisconnect carrying the close code.
* The handlers build their own DB session (`async_session_factory`) rather
  than taking the `get_db` dependency, so overriding the dependency would not
  redirect them. The fixture patches the factory in both router modules to one
  that points at the disposable test database - without it these tests would
  talk to whatever DATABASE_URL is configured.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.core.security import create_access_token, create_refresh_token
from app.main import app
from app.models.user import Session as UserSession
from conftest import TestSessionFactory

NOTIFICATIONS_URL = "/ws/notifications"
CHAT_URL = f"/ws/chat/{uuid.uuid4()}"
POLICY_VIOLATION = 1008


@pytest.fixture
def ws_db(monkeypatch):
    """Point the WebSocket handlers' own sessions at the test database.

    Reuses conftest's TestSessionFactory (NullPool, so a connection is opened
    and closed per session) rather than building an engine per call: a
    per-call engine that outlived the request kept a connection open, and
    conftest's TRUNCATE then deadlocked against it - which showed up as the
    NEXT test finding an organization with no roles.
    """
    monkeypatch.setattr(
        "app.routers.ws_notifications.async_session_factory", TestSessionFactory
    )
    monkeypatch.setattr(
        "app.routers.ws_chat.async_session_factory", TestSessionFactory
    )


@pytest.fixture(autouse=True)
async def _release_db_before_truncate(db_session):
    """Commit and CLOSE the test session before conftest truncates.

    These tests write with the shared session and then let the WebSocket
    handler read on another connection. If the shared session still holds an
    open transaction when conftest's TRUNCATE runs, the two deadlock - which
    surfaced as "ERROR at teardown" and then wrecked the next test's setup.
    This fixture is torn down before conftest's, so the connection is gone by
    then.
    """
    yield
    await db_session.commit()
    await db_session.close()


@pytest.fixture
def ws_client(ws_db):
    # No `with`: the app lifespan is not needed and would reach for Firebase.
    return TestClient(app)


def _assert_rejected(client: TestClient, url: str, token: str, code: int = POLICY_VIOLATION):
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(f"{url}?token={token}"):
            pass
    assert exc_info.value.code == code, f"closed with {exc_info.value.code}, expected {code}"


async def _session_token_of(db_session, user_id) -> str:
    return (
        await db_session.execute(
            select(UserSession.session_token).where(UserSession.user_id == user_id)
        )
    ).scalars().first()


# ── scenario 11 ─────────────────────────────────────────────────────────────

async def test_a_revoked_session_cannot_open_a_notifications_socket(
    ws_client, db_session, worker
):
    worker_user, token = worker
    session = (
        await db_session.execute(
            select(UserSession).where(UserSession.user_id == worker_user.id)
        )
    ).scalars().first()
    session.revoke(reason="admin")
    await db_session.commit()

    _assert_rejected(ws_client, NOTIFICATIONS_URL, token)


async def test_a_revoked_session_cannot_open_a_chat_socket(
    ws_client, db_session, worker
):
    """Auth runs before the participant check, so the conversation id does not
    even have to exist for this to be the right answer."""
    worker_user, token = worker
    session = (
        await db_session.execute(
            select(UserSession).where(UserSession.user_id == worker_user.id)
        )
    ).scalars().first()
    session.revoke(reason="admin")
    await db_session.commit()

    _assert_rejected(ws_client, CHAT_URL, token)


async def test_another_users_session_id_cannot_open_a_socket(
    ws_client, db_session, admin, worker
):
    """Signed with the real key: only the session-user binding can stop it."""
    admin_user, _ = admin
    worker_user, _ = worker
    forged = create_access_token(
        user_id=admin_user.id,
        org_id=None,
        roles=["admin"],
        permissions=["admin:users"],
        session_id=await _session_token_of(db_session, worker_user.id),
        is_superadmin=True,
    )
    _assert_rejected(ws_client, NOTIFICATIONS_URL, forged)
    _assert_rejected(ws_client, CHAT_URL, forged)


async def test_an_expired_token_cannot_open_a_socket(
    ws_client, db_session, worker, monkeypatch
):
    monkeypatch.setattr(settings, "ACCESS_TOKEN_EXPIRE_MINUTES", -1)
    worker_user, _ = worker
    expired = create_access_token(
        user_id=worker_user.id,
        org_id=None,
        roles=["worker"],
        permissions=[],
        session_id=await _session_token_of(db_session, worker_user.id),
    )
    _assert_rejected(ws_client, NOTIFICATIONS_URL, expired)


async def test_a_refresh_token_cannot_open_a_socket(ws_client, db_session, worker):
    """It carries sub/jti/iss and used to be accepted here."""
    worker_user, _ = worker
    refresh = create_refresh_token(
        worker_user.id, await _session_token_of(db_session, worker_user.id)
    )
    _assert_rejected(ws_client, NOTIFICATIONS_URL, refresh)


async def test_a_deactivated_account_cannot_open_a_socket(
    ws_client, db_session, worker
):
    worker_user, token = worker
    worker_user.is_active = False
    worker_user.status = "inactive"
    await db_session.commit()

    _assert_rejected(ws_client, NOTIFICATIONS_URL, token)


async def test_a_garbage_token_cannot_open_a_socket(ws_client, worker):
    _assert_rejected(ws_client, NOTIFICATIONS_URL, "not-a-jwt")


async def test_an_unknown_session_id_cannot_open_a_socket(ws_client, worker):
    """A perfectly signed token whose jti has no row: there is no session."""
    worker_user, _ = worker
    orphan = create_access_token(
        user_id=worker_user.id,
        org_id=None,
        roles=["worker"],
        permissions=[],
        session_id=str(uuid.uuid4()),
    )
    _assert_rejected(ws_client, NOTIFICATIONS_URL, orphan)


# ── the happy path, so the tests above cannot pass by rejecting everything ──

async def test_a_live_session_can_open_a_notifications_socket(
    ws_client, db_session, worker
):
    redis = pytest.importorskip("redis.asyncio")
    import asyncio

    async def _redis_up() -> bool:
        client = redis.from_url(settings.REDIS_URL)
        try:
            await client.ping()
            return True
        except Exception:
            return False
        finally:
            await client.aclose()

    if not await _redis_up():
        pytest.skip("Redis is not running; the socket needs it after accept()")

    _, token = worker
    with ws_client.websocket_connect(f"{NOTIFICATIONS_URL}?token={token}") as ws:
        ws.send_text('{"type":"ping"}')
        assert ws.receive_text() == '{"type":"pong"}'
