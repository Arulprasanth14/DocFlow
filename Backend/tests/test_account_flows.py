"""
End-to-end account flows through the real HTTP API.

The two (and only two) login situations the product supports:
  Case 1  user has NO organization  -> create one, or request to join one
  Case 2  user ALREADY has one      -> straight to the dashboard, always

Firebase is the one thing faked: verify_id_token returns canned claims for a
token string, so everything behind it (user resolution, state, org creation,
join requests, sessions, JWTs, refresh) is the real code on a real Postgres.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from firebase_admin import auth as fb_auth
from sqlalchemy import func, select

from app.core import firebase as fb
from app.models.organization import Organization, OrganizationMember, Role
from app.models.user import Session as UserSession
from app.models.user import User
from conftest import auth_headers


# ── Fake Firebase ───────────────────────────────────────────────────────────

class FakeFirebase:
    def __init__(self) -> None:
        self.identities: dict[str, dict] = {}

    def add(self, token: str, *, uid: str, email: str, verified: bool = True, name: str = "Test Person"):
        self.identities[token] = {
            "uid": uid,
            "email": email,
            "email_verified": verified,
            "name": name,
            "firebase": {"sign_in_provider": "google.com"},
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


def _tok() -> str:
    return "tok-" + uuid.uuid4().hex + "x" * 8  # >= 10 chars


async def _login(client, token):
    return await client.post("/api/v1/auth/firebase-login", json={"id_token": token})


async def _create_org(client, token, name):
    return await client.post(
        "/api/v1/users/me/sync", json={"org_name": name}, headers={"Authorization": f"Bearer {token}"}
    )


@pytest.fixture
def notify_spy(monkeypatch):
    """Capture notifications instead of writing them, so wording is assertable."""
    from app.services.notification_service import NotificationService

    notify = AsyncMock(return_value=None)
    notify_many = AsyncMock(return_value=None)
    monkeypatch.setattr(NotificationService, "notify", notify)
    monkeypatch.setattr(NotificationService, "notify_many", notify_many)
    return notify, notify_many


# ═══ Case 1a: brand-new user ═════════════════════════════════════════════════

async def test_new_user_login_is_200_with_no_org_state(client, firebase):
    t = firebase.add(_tok(), uid="u-new", email="new@example.com")
    resp = await _login(client, t)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "NO_ORG"
    assert body["org_membership"] is None
    assert body["pending_request"] is None
    assert body["access_token"]


async def test_repeated_and_concurrent_logins_create_exactly_one_user(client, firebase, db_session):
    """Retries, double-click, StrictMode, multiple tabs: all hit login at once."""
    t = firebase.add(_tok(), uid="u-race", email="Race@Example.com")
    results = await asyncio.gather(*[_login(client, t) for _ in range(8)])
    assert [r.status_code for r in results] == [200] * 8, [r.text for r in results if r.status_code != 200]

    count = (
        await db_session.execute(select(func.count()).select_from(User).where(User.firebase_uid == "u-race"))
    ).scalar_one()
    assert count == 1
    # Email normalised to lower case.
    user = (await db_session.execute(select(User).where(User.firebase_uid == "u-race"))).scalar_one()
    assert user.email == "race@example.com"


async def test_login_with_different_email_case_finds_the_same_user(client, firebase, db_session):
    a = firebase.add(_tok(), uid="u-case", email="mixed@example.com")
    first = (await _login(client, a)).json()["user"]["id"]
    # Same person, token now reports the address in a different case + new uid
    # is irrelevant: lookup is by uid first, then lower-cased email.
    b = firebase.add(_tok(), uid="u-case", email="MIXED@EXAMPLE.COM")
    second = (await _login(client, b)).json()["user"]["id"]
    assert first == second


# ═══ Case 1b: create an organization ═════════════════════════════════════════

async def test_create_org_makes_user_admin_and_lands_on_has_org(client, firebase, db_session, notify_spy):
    t = firebase.add(_tok(), uid="u-c1", email="founder@example.com", name="Founder")
    resp = await _create_org(client, t, "Acme Industries")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "HAS_ORG"
    assert body["org_membership"]["role_name"] == "admin"
    assert body["org_membership"]["organization"]["name"] == "Acme Industries"

    # The next login goes straight to the org (Case 2).
    again = (await _login(client, t)).json()
    assert again["state"] == "HAS_ORG"
    assert again["org_membership"]["org_id"] == body["org_membership"]["org_id"]

    # Org + 4 system roles + exactly one admin membership.
    org = (await db_session.execute(select(Organization).where(Organization.name == "Acme Industries"))).scalar_one()
    roles = (await db_session.execute(select(Role.name).where(Role.org_id == org.id))).scalars().all()
    assert set(roles) == {"admin", "hr", "worker", "trainee"}


async def test_creation_email_has_the_required_wording(client, firebase, notify_spy):
    notify, _ = notify_spy
    t = firebase.add(_tok(), uid="u-mail", email="mail@example.com")
    await _create_org(client, t, "Mailco")

    notify.assert_awaited()
    kwargs = notify.await_args.kwargs
    assert "Mailco" in kwargs["title"]
    assert kwargs["body"] == (
        "You created the organization 'Mailco'. You are the admin of this "
        "organization. Thank you for choosing DocFlow."
    )


async def test_org_names_are_unique_case_insensitively(client, firebase, notify_spy):
    t1 = firebase.add(_tok(), uid="u-n1", email="n1@example.com")
    t2 = firebase.add(_tok(), uid="u-n2", email="n2@example.com")
    assert (await _create_org(client, t1, "Globex")).status_code == 200

    for variant in ("globex", "GLOBEX", "  Globex  ", "Glo  bex".replace("  ", "")):
        r = await _create_org(client, t2, variant)
        if variant.strip().lower() == "globex":
            assert r.status_code == 409, (variant, r.text)
            assert "already exists" in r.text
    # t2 never got an org out of those failed attempts.
    assert (await _login(client, t2)).json()["state"] == "NO_ORG"


async def test_availability_endpoint(client, firebase, notify_spy):
    t1 = firebase.add(_tok(), uid="u-a1", email="a1@example.com")
    t2 = firebase.add(_tok(), uid="u-a2", email="a2@example.com")
    await _create_org(client, t1, "Initech")
    token = (await _login(client, t2)).json()["access_token"]

    taken = await client.get("/api/v1/orgs/availability", params={"name": "initech"}, headers=auth_headers(token))
    assert taken.json()["available"] is False
    free = await client.get("/api/v1/orgs/availability", params={"name": "Brand New Name"}, headers=auth_headers(token))
    assert free.json() == {"available": True, "reason": ""}
    short = await client.get("/api/v1/orgs/availability", params={"name": "x"}, headers=auth_headers(token))
    assert short.json()["available"] is False


async def test_create_org_is_idempotent_for_a_user_who_already_has_one(client, firebase, db_session, notify_spy):
    t = firebase.add(_tok(), uid="u-idem", email="idem@example.com")
    first = (await _create_org(client, t, "Idem Corp")).json()
    # A retry / second tab with a DIFFERENT name must not create a 2nd org.
    second = await _create_org(client, t, "Another Name")
    assert second.status_code == 200
    assert second.json()["org_membership"]["org_id"] == first["org_membership"]["org_id"]
    total = (await db_session.execute(select(func.count()).select_from(Organization))).scalar_one()
    assert total == 1


async def test_concurrent_creates_produce_one_org(client, firebase, db_session, notify_spy):
    t = firebase.add(_tok(), uid="u-cc", email="cc@example.com")
    results = await asyncio.gather(*[_create_org(client, t, "Concurrent Co") for _ in range(5)])
    assert all(r.status_code in (200, 409) for r in results), [r.text for r in results]
    assert any(r.status_code == 200 for r in results)
    orgs = (await db_session.execute(select(func.count()).select_from(Organization))).scalar_one()
    assert orgs == 1


async def test_failed_org_creation_leaves_nothing_behind(client, firebase, db_session, monkeypatch, notify_spy):
    """All-or-nothing: a failure mid-creation must not leave an org, roles or
    a membership, and the user must be able to simply try again."""
    from app.repositories.org_repo import OrganizationRepository

    async def boom(self, org_id):
        raise RuntimeError("simulated failure while seeding roles")

    real = OrganizationRepository.create_default_roles
    monkeypatch.setattr(OrganizationRepository, "create_default_roles", boom)
    t = firebase.add(_tok(), uid="u-fail", email="fail@example.com")
    # An UNEXPECTED fault: in production the generic handler turns this into a
    # 500 response; the in-process test client re-raises it instead. Either
    # way what matters is the database state below.
    with pytest.raises(RuntimeError, match="simulated failure"):
        await client.post(
            "/api/v1/users/me/sync", json={"org_name": "Doomed Inc"}, headers={"Authorization": f"Bearer {t}"}
        )

    assert (await db_session.execute(select(func.count()).select_from(Organization))).scalar_one() == 0
    assert (await db_session.execute(select(func.count()).select_from(OrganizationMember))).scalar_one() == 0

    # Recovery: the same user logs in (no 500) and creates the org on retry.
    monkeypatch.setattr(OrganizationRepository, "create_default_roles", real)
    assert (await _login(client, t)).json()["state"] == "NO_ORG"
    ok = await _create_org(client, t, "Doomed Inc")
    assert ok.status_code == 200 and ok.json()["state"] == "HAS_ORG"


async def test_failed_default_seeding_does_not_undo_the_organization(client, firebase, monkeypatch, notify_spy):
    from app.services.template_service import TemplateService

    async def boom(self, *a, **k):
        raise RuntimeError("seed failed")

    monkeypatch.setattr(TemplateService, "create", boom)
    t = firebase.add(_tok(), uid="u-seed", email="seed@example.com")
    resp = await _create_org(client, t, "Seedless Co")
    assert resp.status_code == 200 and resp.json()["state"] == "HAS_ORG"


async def test_email_failure_never_breaks_org_creation(client, firebase, monkeypatch):
    from app.services.notification_service import NotificationService

    monkeypatch.setattr(NotificationService, "notify", AsyncMock(side_effect=RuntimeError("smtp down")))
    t = firebase.add(_tok(), uid="u-smtp", email="smtp@example.com")
    resp = await _create_org(client, t, "Mailless Co")
    assert resp.status_code == 200 and resp.json()["state"] == "HAS_ORG"
    assert (await _login(client, t)).json()["state"] == "HAS_ORG"


async def test_account_with_no_email_gets_a_clean_422_not_a_500(client, firebase):
    t = firebase.add(_tok(), uid="u-noemail", email="")
    resp = await _login(client, t)
    assert resp.status_code == 422, resp.text


# ═══ Case 1c: join an existing organization ══════════════════════════════════

async def _requester(client, firebase, email):
    t = firebase.add(_tok(), uid=f"u-{email}", email=email, name=email.split("@")[0].title())
    body = (await _login(client, t)).json()
    return t, body["access_token"], body["user"]["id"]


async def _role_id(db_session, org, name):
    return (await db_session.execute(select(Role.id).where(Role.org_id == org.id, Role.name == name))).scalar_one()


async def test_join_request_notifies_all_admins_and_hr(client, firebase, org, admin, hr, worker, db_session, notify_spy):
    _, notify_many = notify_spy
    _t, token, _uid = await _requester(client, firebase, "joiner@example.com")

    resp = await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    assert resp.status_code == 201, resp.text

    notify_many.assert_awaited()
    recipients = set(notify_many.await_args.kwargs["user_ids"])
    assert recipients == {admin[0].id, hr[0].id}  # NOT the worker
    assert "joiner" in notify_many.await_args.kwargs["title"].lower()

    # Login now reports PENDING_REQUEST - no error, no create/join screen.
    login = await _login(client, _t)
    assert login.status_code == 200
    j = login.json()
    assert j["state"] == "PENDING_REQUEST"
    assert j["pending_request"]["org_name"] == org.name
    assert j["org_membership"] is None


async def test_duplicate_pending_request_is_rejected(client, firebase, org, admin, notify_spy):
    _t, token, _ = await _requester(client, firebase, "dup@example.com")
    first = await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    assert first.status_code == 201
    second = await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name.upper()}, headers=auth_headers(token))
    assert second.status_code == 409
    assert "pending" in second.text.lower()


async def test_unknown_org_is_a_clean_404(client, firebase, notify_spy):
    _t, token, _ = await _requester(client, firebase, "lost@example.com")
    resp = await client.post("/api/v1/orgs/join-requests", json={"org_name": "No Such Org"}, headers=auth_headers(token))
    assert resp.status_code == 404


async def test_accept_with_chosen_role_admits_user_and_emails_them(client, firebase, org, admin, db_session, notify_spy):
    notify, _ = notify_spy
    admin_user, admin_token = admin
    t, token, uid = await _requester(client, firebase, "accepted@example.com")
    await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))

    pending = (await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(admin_token))).json()
    assert len(pending) == 1 and pending[0]["email"] == "accepted@example.com"

    worker_role = await _role_id(db_session, org, "worker")
    resp = await client.post(
        f"/api/v1/orgs/me/join-requests/{pending[0]['id']}/accept",
        json={"role_id": str(worker_role)},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "worker"

    # The requester now logs in straight into the organization.
    login = (await _login(client, t)).json()
    assert login["state"] == "HAS_ORG"
    assert login["org_membership"]["role_name"] == "worker"

    kw = notify.await_args.kwargs
    assert kw["user_id"].hex == uuid.UUID(uid).hex
    assert kw["body"] == (
        f"You have been admitted to '{org.name}' by {admin_user.name}, with the role worker."
    )

    # Closed for everyone: it no longer appears as pending.
    assert (await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(admin_token))).json() == []


async def test_first_decision_wins_second_reviewer_gets_409(client, firebase, org, admin, hr, db_session, notify_spy):
    _t, token, _ = await _requester(client, firebase, "race@example.com")
    await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    req_id = (await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(admin[1]))).json()[0]["id"]
    worker_role = await _role_id(db_session, org, "worker")
    trainee_role = await _role_id(db_session, org, "trainee")

    first = await client.post(
        f"/api/v1/orgs/me/join-requests/{req_id}/accept", json={"role_id": str(worker_role)}, headers=auth_headers(admin[1])
    )
    second = await client.post(
        f"/api/v1/orgs/me/join-requests/{req_id}/accept", json={"role_id": str(trainee_role)}, headers=auth_headers(hr[1])
    )
    assert first.status_code == 200
    assert second.status_code == 409
    assert "already accepted" in second.text and admin[0].name in second.text


async def test_simultaneous_accepts_exactly_one_wins(client, firebase, org, admin, hr, db_session, notify_spy):
    _t, token, uid = await _requester(client, firebase, "simul@example.com")
    await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    req_id = (await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(admin[1]))).json()[0]["id"]
    worker_role = await _role_id(db_session, org, "worker")
    trainee_role = await _role_id(db_session, org, "trainee")

    results = await asyncio.gather(
        client.post(f"/api/v1/orgs/me/join-requests/{req_id}/accept", json={"role_id": str(worker_role)}, headers=auth_headers(admin[1])),
        client.post(f"/api/v1/orgs/me/join-requests/{req_id}/accept", json={"role_id": str(trainee_role)}, headers=auth_headers(hr[1])),
    )
    assert sorted(r.status_code for r in results) == [200, 409], [r.text for r in results]

    # Exactly one membership, with the role the WINNER chose.
    rows = (await db_session.execute(
        select(Role.name).join(OrganizationMember, OrganizationMember.role_id == Role.id)
        .where(OrganizationMember.user_id == uuid.UUID(uid))
    )).scalars().all()
    winner_role = next(r.json()["role"] for r in results if r.status_code == 200)
    assert rows == [winner_role]


async def test_reject_emails_requester_and_allows_a_new_request(client, firebase, org, admin, db_session, notify_spy):
    notify, _ = notify_spy
    t, token, _ = await _requester(client, firebase, "rejected@example.com")
    await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    req_id = (await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(admin[1]))).json()[0]["id"]

    resp = await client.post(f"/api/v1/orgs/me/join-requests/{req_id}/reject", headers=auth_headers(admin[1]))
    assert resp.status_code == 200 and resp.json()["status"] == "rejected"
    assert "not approved" in notify.await_args.kwargs["title"]

    # Back to NO_ORG (login still 200), and they may ask again - the old
    # membership row is reused instead of violating uq_org_member (a 500).
    assert (await _login(client, t)).json()["state"] == "NO_ORG"
    again = await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    assert again.status_code == 201, again.text
    assert (await _login(client, t)).json()["state"] == "PENDING_REQUEST"


async def test_hr_cannot_grant_hr_and_nobody_can_grant_admin_via_join(client, firebase, org, admin, hr, db_session, notify_spy):
    _t, token, _ = await _requester(client, firebase, "roles@example.com")
    await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    req_id = (await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(admin[1]))).json()[0]["id"]

    hr_role = await _role_id(db_session, org, "hr")
    admin_role = await _role_id(db_session, org, "admin")
    assert (await client.post(f"/api/v1/orgs/me/join-requests/{req_id}/accept", json={"role_id": str(hr_role)}, headers=auth_headers(hr[1]))).status_code == 403
    assert (await client.post(f"/api/v1/orgs/me/join-requests/{req_id}/accept", json={"role_id": str(admin_role)}, headers=auth_headers(admin[1]))).status_code == 403
    # Still pending after the refused attempts.
    assert len((await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(admin[1]))).json()) == 1


async def test_workers_cannot_review_join_requests(client, firebase, org, admin, worker, notify_spy):
    _t, token, _ = await _requester(client, firebase, "snoop@example.com")
    await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    resp = await client.get("/api/v1/orgs/me/join-requests", headers=auth_headers(worker[1]))
    assert resp.status_code == 403


async def test_user_with_an_org_cannot_request_another(client, firebase, org, admin, notify_spy):
    t = firebase.add(_tok(), uid="u-has", email="has@example.com")
    await _create_org(client, t, "Already Mine")
    token = (await _login(client, t)).json()["access_token"]
    resp = await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    assert resp.status_code == 409


async def test_org_search_returns_names_only_and_is_capped(client, firebase, org, notify_spy):
    _t, token, _ = await _requester(client, firebase, "search@example.com")
    resp = await client.get("/api/v1/orgs/search", params={"q": "Test Org"}, headers=auth_headers(token))
    assert resp.status_code == 200 and org.name in resp.json()
    assert all(isinstance(x, str) for x in resp.json())
    assert (await client.get("/api/v1/orgs/search", params={"q": "x"}, headers=auth_headers(token))).json() == []


# ═══ Case 2: existing members ════════════════════════════════════════════════

async def test_existing_member_goes_straight_to_the_org_even_days_later(client, firebase, org, admin, db_session):
    admin_user, _ = admin
    admin_user.firebase_uid = "u-old"
    admin_user.last_seen_at = datetime.now(timezone.utc) - timedelta(days=3)
    await db_session.commit()

    t = firebase.add(_tok(), uid="u-old", email=admin_user.email)
    body = (await _login(client, t)).json()
    assert body["state"] == "HAS_ORG"
    assert body["org_membership"]["role_name"] == "admin"
    assert body["org_membership"]["org_id"] == str(org.id)


async def test_refresh_after_24h_still_resolves_membership(client, firebase, org, admin, db_session):
    """The 2h access token is long expired a day later; the refresh cookie
    (30 days) must mint a new one that still carries the organization."""
    from app.core.security import create_access_token, decode_token

    admin_user, _ = admin
    admin_user.firebase_uid = "u-24h"
    await db_session.commit()
    t = firebase.add(_tok(), uid="u-24h", email=admin_user.email)

    login = await _login(client, t)
    assert login.status_code == 200
    assert "docflow_refresh" in client.cookies or any("docflow_refresh" in c for c in login.headers.get_list("set-cookie"))

    # Age the session 25 hours (still inside its 30-day lifetime).
    sess = (await db_session.execute(
        select(UserSession).where(UserSession.user_id == admin_user.id).order_by(UserSession.created_at.desc())
    )).scalars().first()
    sess.created_at = datetime.now(timezone.utc) - timedelta(hours=25)
    await db_session.commit()

    refreshed = await client.post("/api/v1/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    claims = decode_token(refreshed.json()["access_token"])
    assert claims["org_id"] == str(org.id)
    assert "admin" in claims["roles"]


async def test_removed_member_gets_no_org_and_login_does_not_error(client, firebase, org, worker, db_session):
    worker_user, _ = worker
    worker_user.firebase_uid = "u-removed"
    m = (await db_session.execute(select(OrganizationMember).where(OrganizationMember.user_id == worker_user.id))).scalar_one()
    m.deleted_at = datetime.now(timezone.utc)
    m.status = "inactive"
    await db_session.commit()

    t = firebase.add(_tok(), uid="u-removed", email=worker_user.email)
    resp = await _login(client, t)
    assert resp.status_code == 200
    assert resp.json()["state"] == "NO_ORG"


async def test_only_admin_cannot_be_removed_or_demoted(client, org, admin, hr, db_session):
    admin_user, admin_token = admin
    member_id = (await db_session.execute(select(OrganizationMember.id).where(OrganizationMember.user_id == admin_user.id))).scalar_one()
    resp = await client.delete(f"/api/v1/orgs/me/members/{member_id}", headers=auth_headers(admin_token))
    assert resp.status_code == 409 and "only administrator" in resp.text

    worker_role = await _role_id(db_session, org, "worker")
    demote = await client.patch(
        f"/api/v1/orgs/me/members/{member_id}", json={"role_id": str(worker_role)}, headers=auth_headers(admin_token)
    )
    assert demote.status_code == 409


# ═══ Account linking ═════════════════════════════════════════════════════════

async def test_sso_links_to_existing_password_account_only_when_email_is_verified(client, firebase, db_session):
    existing = User(email="shared@example.com", name="Pw User", password_hash="x", is_active=True, status="active")
    db_session.add(existing)
    await db_session.commit()

    # Unverified Firebase email claiming someone else's address: refused.
    bad = firebase.add(_tok(), uid="u-attacker", email="shared@example.com", verified=False)
    refused = await _login(client, bad)
    assert refused.status_code == 403, refused.text

    # Verified (Google/Microsoft): linked to the SAME account, no duplicate.
    good = firebase.add(_tok(), uid="u-owner", email="shared@example.com", verified=True)
    ok = await _login(client, good)
    assert ok.status_code == 200
    assert ok.json()["user"]["id"] == str(existing.id)
    total = (await db_session.execute(select(func.count()).select_from(User).where(User.email == "shared@example.com"))).scalar_one()
    assert total == 1


# ═══ Broken-account recovery ═════════════════════════════════════════════════

async def test_user_stranded_by_a_failed_org_creation_can_log_in_and_start_over(client, firebase, db_session, notify_spy):
    """The reported incident: a user row exists (created by login), org
    creation failed, nothing else exists. Login must be a clean NO_ORG and
    creation must then succeed."""
    stranded = User(email="stranded@example.com", name="S", firebase_uid="u-stranded", is_active=True, status="active")
    db_session.add(stranded)
    await db_session.commit()

    t = firebase.add(_tok(), uid="u-stranded", email="stranded@example.com")
    for _ in range(3):  # repeated failed-looking retries are harmless
        r = await _login(client, t)
        assert r.status_code == 200 and r.json()["state"] == "NO_ORG"
    ok = await _create_org(client, t, "Second Chance")
    assert ok.status_code == 200 and ok.json()["state"] == "HAS_ORG"


async def test_stale_pending_request_to_a_deleted_org_does_not_trap_the_user(client, firebase, org, db_session, notify_spy):
    t, token, uid = await _requester(client, firebase, "orphan@example.com")
    await client.post("/api/v1/orgs/join-requests", json={"org_name": org.name}, headers=auth_headers(token))
    org_row = (await db_session.execute(select(Organization).where(Organization.id == org.id))).scalar_one()
    org_row.deleted_at = datetime.now(timezone.utc)
    await db_session.commit()

    r = await _login(client, t)
    assert r.status_code == 200 and r.json()["state"] == "NO_ORG"
