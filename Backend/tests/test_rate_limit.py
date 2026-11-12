"""
Auth hardening — Phase C: per-route auth rate limits (Gap #4).

The suite disables rate limiting globally (conftest), so every test here
turns it back on deliberately and clears its own Redis keys first - the whole
suite calls from one address, so a leftover counter would fail the next test.

Needs the local Redis that the limiter uses; the fail-open and fail-closed
tests simulate an outage by making get_redis raise.
"""
from __future__ import annotations

import uuid

import pytest
from firebase_admin import auth as fb_auth

from app.config import settings
from app.core import rate_limit
from app.core.rate_limit import client_ip, email_key, parse_limit

LOGIN_URL = "/api/v1/auth/login"
REGISTER_URL = "/api/v1/auth/register"
FIREBASE_LOGIN_URL = "/api/v1/auth/firebase-login"
REFRESH_URL = "/api/v1/auth/refresh"


@pytest.fixture
def limiter_on(monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", True)
    monkeypatch.setattr(settings, "LEGACY_PASSWORD_AUTH_ENABLED", True)


@pytest.fixture(autouse=True)
def fresh_redis_client(monkeypatch):
    """Force a new Redis client per test.

    app.core.redis caches one client in a module global, and a redis-py
    asyncio client is bound to the event loop that created it. pytest-asyncio
    gives every test its own loop, so the cached client from the previous test
    raises "Event loop is closed" here - exactly the reason conftest builds a
    fresh DB engine per test.
    """
    monkeypatch.setattr("app.core.redis._redis_pool", None)


@pytest.fixture
async def clean_keys():
    """Drop this test's limiter keys before and after, so run order cannot
    decide the outcome. Uses its own client, created in THIS test's loop."""
    import redis.asyncio as aioredis

    async def _flush():
        redis_client = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            for pattern in ("rl:login:*", "rl:register:*", "rl:fblogin:*", "rl:refresh:*"):
                keys = [k async for k in redis_client.scan_iter(match=pattern)]
                if keys:
                    await redis_client.delete(*keys)
        finally:
            await redis_client.aclose()

    await _flush()
    yield
    await _flush()


@pytest.fixture
def redis_down(monkeypatch):
    """Simulate a cache outage at the point the limiter reaches for it."""
    async def _boom():
        raise ConnectionError("redis is down")

    monkeypatch.setattr("app.core.redis.get_redis", _boom)


def _password_payload(email: str) -> dict:
    return {"email": email, "password": "WrongPassw0rd"}


# ── the window itself ────────────────────────────────────────────────────────

async def test_one_persons_typos_do_not_lock_out_a_shared_address(
    client, db_session, worker, limiter_on, clean_keys, monkeypatch
):
    """The per-email budget is small; the per-address one is not. A second
    person behind the same NAT must still be able to sign in."""
    from app.core.security import hash_password

    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES", "2/15m")
    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES_PER_IP", "50/15m")
    worker_user, _ = worker
    worker_user.password_hash = hash_password("Str0ngPassw0rd")
    await db_session.commit()

    unlucky = f"{uuid.uuid4().hex[:10]}@example.com"
    for _ in range(2):
        await client.post(LOGIN_URL, json=_password_payload(unlucky))
    assert (await client.post(LOGIN_URL, json=_password_payload(unlucky))).status_code == 429

    colleague = await client.post(
        LOGIN_URL, json={"email": worker_user.email, "password": "Str0ngPassw0rd"}
    )
    assert colleague.status_code == 200


def test_limit_settings_parse_to_sliding_windows():
    assert parse_limit("5/15m") == rate_limit.Limit(5, 900)
    assert parse_limit("20/1m") == rate_limit.Limit(20, 60)
    assert parse_limit("5/1h") == rate_limit.Limit(5, 3600)


def test_an_email_is_never_used_as_a_key():
    key = email_key("Person@Example.com")
    assert "person" not in key and "@" not in key
    assert key == email_key(" person@example.com ")   # normalised


def test_forwarded_headers_are_ignored_unless_the_peer_is_trusted(monkeypatch):
    class _Req:
        def __init__(self):
            self.headers = {"X-Forwarded-For": "9.9.9.9"}
            self.client = type("C", (), {"host": "10.0.0.1"})()

    monkeypatch.setattr(settings, "TRUSTED_PROXIES", [])
    assert client_ip(_Req()) == "10.0.0.1"
    monkeypatch.setattr(settings, "TRUSTED_PROXIES", ["10.0.0.1"])
    assert client_ip(_Req()) == "9.9.9.9"


# ── /auth/login counts FAILURES ──────────────────────────────────────────────

async def test_failed_logins_are_limited_and_answer_429(
    client, limiter_on, clean_keys, monkeypatch
):
    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES", "3/15m")
    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES_PER_IP", "100/15m")
    email = f"{uuid.uuid4().hex[:10]}@example.com"

    for _ in range(3):
        response = await client.post(LOGIN_URL, json=_password_payload(email))
        assert response.status_code == 401

    blocked = await client.post(LOGIN_URL, json=_password_payload(email))
    assert blocked.status_code == 429
    assert blocked.json().get("code") == "RATE_LIMITED"
    assert int(blocked.headers["Retry-After"]) > 0


async def test_a_correct_password_is_not_charged_against_the_limit(
    client, db_session, worker, limiter_on, clean_keys, monkeypatch
):
    """Only failures count, so someone signing in repeatedly is never locked
    out of their own account."""
    from app.core.security import hash_password

    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES", "2/15m")
    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES_PER_IP", "100/15m")
    worker_user, _ = worker
    worker_user.password_hash = hash_password("Str0ngPassw0rd")
    await db_session.commit()

    for _ in range(4):
        response = await client.post(
            LOGIN_URL, json={"email": worker_user.email, "password": "Str0ngPassw0rd"}
        )
        assert response.status_code == 200


async def test_a_successful_login_clears_the_email_counter(
    client, db_session, worker, limiter_on, clean_keys, monkeypatch
):
    from app.core.security import hash_password

    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES", "3/15m")
    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES_PER_IP", "100/15m")
    worker_user, _ = worker
    worker_user.password_hash = hash_password("Str0ngPassw0rd")
    await db_session.commit()

    for _ in range(2):
        await client.post(LOGIN_URL, json=_password_payload(worker_user.email))
    ok = await client.post(
        LOGIN_URL, json={"email": worker_user.email, "password": "Str0ngPassw0rd"}
    )
    assert ok.status_code == 200

    # Budget restored for this email: two more failures are allowed again.
    for _ in range(2):
        again = await client.post(LOGIN_URL, json=_password_payload(worker_user.email))
        assert again.status_code == 401


async def test_the_limit_is_read_from_settings_not_hard_coded(
    client, limiter_on, clean_keys, monkeypatch
):
    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES", "1/15m")
    monkeypatch.setattr(settings, "RATE_LIMIT_LOGIN_FAILURES_PER_IP", "100/15m")
    email = f"{uuid.uuid4().hex[:10]}@example.com"
    assert (await client.post(LOGIN_URL, json=_password_payload(email))).status_code == 401
    assert (await client.post(LOGIN_URL, json=_password_payload(email))).status_code == 429


# ── the other three routes ───────────────────────────────────────────────────

async def test_register_is_limited_per_ip(client, limiter_on, clean_keys, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_REGISTER", "1/1h")
    body = {
        "email": f"{uuid.uuid4().hex[:10]}@example.com",
        "name": "New Person",
        "password": "Str0ngPassw0rd",
    }
    first = await client.post(REGISTER_URL, json=body)
    assert first.status_code in (201, 409)

    body["email"] = f"{uuid.uuid4().hex[:10]}@example.com"
    second = await client.post(REGISTER_URL, json=body)
    assert second.status_code == 429


async def test_firebase_login_is_limited_per_ip(
    client, limiter_on, clean_keys, monkeypatch
):
    monkeypatch.setattr(settings, "RATE_LIMIT_FIREBASE_LOGIN", "1/1m")
    body = {"id_token": "not-a-real-token"}
    first = await client.post(FIREBASE_LOGIN_URL, json=body)
    assert first.status_code in (401, 503)
    second = await client.post(FIREBASE_LOGIN_URL, json=body)
    assert second.status_code == 429


async def test_refresh_is_limited_per_ip(client, limiter_on, clean_keys, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_REFRESH", "1/1m")
    first = await client.post(REFRESH_URL, cookies={"docflow_refresh": "nonsense"})
    assert first.status_code == 401
    second = await client.post(REFRESH_URL, cookies={"docflow_refresh": "nonsense"})
    assert second.status_code == 429


# ── Redis outage: closed where guessing matters, open where it would hurt ────

async def test_login_fails_closed_when_redis_is_down(
    client, limiter_on, redis_down
):
    response = await client.post(
        LOGIN_URL, json=_password_payload("someone@example.com")
    )
    assert response.status_code == 503
    assert response.json().get("code") == "RATE_LIMITER_UNAVAILABLE"


async def test_register_fails_closed_when_redis_is_down(client, limiter_on, redis_down):
    response = await client.post(
        REGISTER_URL,
        json={
            "email": f"{uuid.uuid4().hex[:10]}@example.com",
            "name": "New Person",
            "password": "Str0ngPassw0rd",
        },
    )
    assert response.status_code == 503


async def test_firebase_login_fails_open_when_redis_is_down(
    client, limiter_on, redis_down, monkeypatch
):
    """Availability wins here: a cache outage must not stop everyone signing
    in. The request proceeds and fails on its own merits."""
    response = await client.post(FIREBASE_LOGIN_URL, json={"id_token": "not-a-real-token"})
    assert response.status_code in (401, 503)
    assert response.json().get("code") != "RATE_LIMITER_UNAVAILABLE"


async def test_refresh_fails_open_when_redis_is_down(client, limiter_on, redis_down):
    response = await client.post(REFRESH_URL, cookies={"docflow_refresh": "nonsense"})
    assert response.status_code == 401   # not 503: the limiter stepped aside


# ── /auth/me is exempt ───────────────────────────────────────────────────────

async def test_auth_me_is_not_rate_limited(client, worker, limiter_on, clean_keys):
    """It is read on every page load and carries no abuse value; it used to
    share the sign-in allowance."""
    from conftest import auth_headers

    _, token = worker
    for _ in range(12):
        response = await client.get("/api/v1/auth/me", headers=auth_headers(token))
        assert response.status_code == 200
