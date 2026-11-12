"""
Auth hardening — Phase G: the consistency and honesty items.

Error codes (spec 3.3), idempotent logout, the legacy password endpoints
answering 410, the Origin check on the cookie-only refresh endpoint, member
status validation, and auth events reaching the AuditLog table.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.config import settings
from app.core.security import create_access_token, create_refresh_token, hash_password
from app.models.audit import AuditLog
from app.models.organization import OrganizationMember
from app.models.user import Session as UserSession
from conftest import auth_headers

PROTECTED_URL = "/api/v1/orgs/me"
LOGIN_URL = "/api/v1/auth/login"
REGISTER_URL = "/api/v1/auth/register"
REFRESH_URL = "/api/v1/auth/refresh"
LOGOUT_URL = "/api/v1/auth/logout"


@pytest.fixture
def legacy_on(monkeypatch):
    monkeypatch.setattr(settings, "LEGACY_PASSWORD_AUTH_ENABLED", True)


# ── G9: machine-readable error codes ────────────────────────────────────────

async def test_a_malformed_token_is_invalid_token(client):
    response = await client.get(PROTECTED_URL, headers=auth_headers("not-a-jwt"))
    assert response.status_code == 401
    assert response.json().get("code") == "INVALID_TOKEN"


async def test_a_missing_header_is_invalid_token(client):
    response = await client.get(PROTECTED_URL)
    assert response.status_code == 401
    assert response.json().get("code") == "INVALID_TOKEN"


async def test_an_expired_token_is_token_expired(client, worker, monkeypatch):
    """Distinct from INVALID_TOKEN so the client refreshes once instead of
    signing the user out."""
    monkeypatch.setattr(settings, "ACCESS_TOKEN_EXPIRE_MINUTES", -1)
    worker_user, _ = worker
    expired = create_access_token(
        user_id=worker_user.id, org_id=None, roles=[], permissions=[],
        session_id=str(uuid.uuid4()),
    )
    response = await client.get(PROTECTED_URL, headers=auth_headers(expired))
    assert response.status_code == 401
    assert response.json().get("code") == "TOKEN_EXPIRED"


async def test_a_401_carries_the_www_authenticate_header(client):
    """The handler used to build the body by hand and drop every header the
    raiser set - including Retry-After on a 429."""
    response = await client.get(PROTECTED_URL, headers=auth_headers("not-a-jwt"))
    assert response.headers.get("WWW-Authenticate") == "Bearer"


async def test_a_permission_denial_is_forbidden(client, trainee):
    """A trainee holds documents:read but not admin:users."""
    _, token = trainee
    response = await client.get("/api/v1/orgs/me/members", headers=auth_headers(token))
    assert response.status_code == 403
    assert response.json().get("code") == "FORBIDDEN"


# ── G10: the login form is not an account-existence oracle ──────────────────

async def test_unknown_email_and_wrong_password_are_indistinguishable(
    client, db_session, worker, legacy_on
):
    worker_user, _ = worker
    worker_user.password_hash = hash_password("Str0ngPassw0rd")
    await db_session.commit()

    unknown = await client.post(
        LOGIN_URL,
        json={"email": f"{uuid.uuid4().hex[:10]}@example.com", "password": "Whatever1"},
    )
    wrong = await client.post(
        LOGIN_URL, json={"email": worker_user.email, "password": "Whatever1"}
    )

    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["error"] == wrong.json()["error"]
    assert unknown.json().get("code") == wrong.json().get("code") == "INVALID_CREDENTIALS"


# ── G13: the legacy password endpoints are gone ─────────────────────────────

async def test_legacy_login_answers_410_by_default(client):
    response = await client.post(
        LOGIN_URL, json={"email": "someone@example.com", "password": "Str0ngPassw0rd"}
    )
    assert response.status_code == 410
    assert response.json().get("code") == "ENDPOINT_GONE"


async def test_legacy_register_answers_410_by_default(client):
    response = await client.post(
        REGISTER_URL,
        json={
            "email": f"{uuid.uuid4().hex[:10]}@example.com",
            "name": "New Person",
            "password": "Str0ngPassw0rd",
        },
    )
    assert response.status_code == 410


async def test_the_legacy_endpoints_can_still_be_switched_back_on(client, legacy_on):
    """410 is a deprecation step, not a deletion: one setting brings them back
    if a client turns out to need them."""
    response = await client.post(
        LOGIN_URL, json={"email": "someone@example.com", "password": "Str0ngPassw0rd"}
    )
    assert response.status_code == 401   # reached the handler, failed on merit


# ── G14: logging out always succeeds ────────────────────────────────────────

async def test_logout_is_204_and_idempotent(client, worker):
    _, token = worker
    first = await client.post(LOGOUT_URL, headers=auth_headers(token))
    assert first.status_code == 204

    # Second time: the session is already revoked. Used to be a 401 reported
    # as an error on the way out of the door.
    second = await client.post(LOGOUT_URL, headers=auth_headers(token))
    assert second.status_code == 204


async def test_logout_without_a_token_is_still_204(client):
    assert (await client.post(LOGOUT_URL)).status_code == 204


async def test_logout_actually_revokes_the_session(client, db_session, worker):
    worker_user, token = worker
    await client.post(LOGOUT_URL, headers=auth_headers(token))

    reasons = (
        await db_session.execute(
            select(UserSession.revoked_reason).where(UserSession.user_id == worker_user.id)
        )
    ).scalars().all()
    assert "logout" in reasons
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(token))
    ).status_code == 401


# ── G12: the cookie-only endpoint checks its Origin ─────────────────────────

async def test_refresh_rejects_a_foreign_origin(client, worker):
    response = await client.post(
        REFRESH_URL,
        cookies={"docflow_refresh": "nonsense"},
        headers={"Origin": "https://evil.example.com"},
    )
    assert response.status_code == 403
    assert response.json().get("code") == "FORBIDDEN"


async def test_refresh_allows_a_configured_origin(client):
    response = await client.post(
        REFRESH_URL,
        cookies={"docflow_refresh": "nonsense"},
        headers={"Origin": settings.FRONTEND_URL},
    )
    assert response.status_code == 401   # past the Origin check, bad cookie


async def test_refresh_allows_a_request_with_no_origin(client):
    """curl, the test client and server-side callers send none; a browser
    always sends one on a cross-site POST, which is the case being stopped."""
    response = await client.post(REFRESH_URL, cookies={"docflow_refresh": "nonsense"})
    assert response.status_code == 401


# ── G8: member status is validated ──────────────────────────────────────────

async def test_an_unknown_member_status_is_422(client, db_session, admin, worker):
    _, admin_token = admin
    worker_user, _ = worker
    member = (
        await db_session.execute(
            select(OrganizationMember).where(OrganizationMember.user_id == worker_user.id)
        )
    ).scalars().first()

    response = await client.patch(
        f"/api/v1/orgs/me/members/{member.id}",
        json={"status": "actve"},        # the typo from Gap #13
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 422


async def test_every_real_status_value_is_accepted(client, db_session, admin, worker):
    from app.domain.enums import MemberStatus

    _, admin_token = admin
    worker_user, _ = worker
    member = (
        await db_session.execute(
            select(OrganizationMember).where(OrganizationMember.user_id == worker_user.id)
        )
    ).scalars().first()

    for value in MemberStatus:
        response = await client.patch(
            f"/api/v1/orgs/me/members/{member.id}",
            json={"status": str(value)},
            headers=auth_headers(admin_token),
        )
        assert response.status_code == 200, f"{value}: {response.text}"


# ── G11: auth and RBAC events reach the AuditLog table ──────────────────────

async def test_a_role_change_is_written_to_the_audit_log(
    client, db_session, org, admin, roles, make_member
):
    _, actor_token = admin
    demoted_user, _ = await make_member(roles["admin"], name="Second Admin")
    member = (
        await db_session.execute(
            select(OrganizationMember).where(OrganizationMember.user_id == demoted_user.id)
        )
    ).scalars().first()

    await client.patch(
        f"/api/v1/orgs/me/members/{member.id}",
        json={"role_id": str(roles["worker"].id)},
        headers=auth_headers(actor_token),
    )

    rows = (
        await db_session.execute(
            select(AuditLog).where(
                AuditLog.org_id == org.id, AuditLog.action == "rbac.role.changed"
            )
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].before == {"role": "admin"}
    assert rows[0].after == {"role": "worker"}


async def test_a_member_removal_is_written_to_the_audit_log(
    client, db_session, org, admin, worker
):
    _, admin_token = admin
    worker_user, _ = worker
    member = (
        await db_session.execute(
            select(OrganizationMember).where(OrganizationMember.user_id == worker_user.id)
        )
    ).scalars().first()

    await client.delete(
        f"/api/v1/orgs/me/members/{member.id}", headers=auth_headers(admin_token)
    )

    actions = (
        await db_session.execute(
            select(AuditLog.action).where(AuditLog.org_id == org.id)
        )
    ).scalars().all()
    assert "rbac.member.removed" in actions
