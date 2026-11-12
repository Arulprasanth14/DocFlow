"""
Auth hardening — Phase B: deactivation and role changes take effect at once.

Spec section 16.2 rows 4-7, plus suspension and reactivation:

  4. deactivate a user, reuse the old token          -> 401/403
  5. deactivated user attempts login (both paths)    -> 403 ACCOUNT_DEACTIVATED
  6. demote admin -> worker, reuse the old token     -> 401 SESSION_REVOKED
  7. remove a member, reuse the old token            -> 401 / no org access
  +  member suspended, and users.status == suspended -> blocked
  +  reactivation allows a fresh login while the old sessions stay revoked

Before this phase every one of these returned 200: `is_active` was written by
the admin endpoint and read by no auth path, and no admin action revoked a
session.
"""
from __future__ import annotations

import uuid

import pytest
from firebase_admin import auth as fb_auth
from sqlalchemy import select

from app.core import firebase as fb
from app.config import settings
from app.core.security import hash_password
from app.models.organization import OrganizationMember
from app.models.user import Session as UserSession
from app.models.user import User
from conftest import auth_headers

# Not under /api/v1/auth, so these tests never share the tighter auth
# rate-limit bucket.
PROTECTED_URL = "/api/v1/orgs/me"
PASSWORD = "Str0ngPassw0rd"


# ── fakes ─────────────────────────────────────────────────────────────────────

class FakeFirebase:
    """Minimal stand-in for firebase_admin.auth.verify_id_token."""

    def __init__(self) -> None:
        self.identities: dict[str, dict] = {}

    def add(self, token: str, *, uid: str, email: str, verified: bool = True) -> str:
        self.identities[token] = {
            "uid": uid,
            "email": email,
            "email_verified": verified,
            "name": "Test Person",
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


@pytest.fixture
def no_firebase_revocation(monkeypatch):
    """The deactivate endpoint also revokes the Firebase side; record the call
    instead of reaching out to Google."""
    calls: list[tuple[str, bool]] = []

    async def _fake(firebase_uid: str, *, disable_user: bool = False) -> bool:
        calls.append((firebase_uid, disable_user))
        return True

    monkeypatch.setattr("app.routers.admin.revoke_firebase_sessions", _fake)
    return calls


# ── helpers ───────────────────────────────────────────────────────────────────

async def _sessions_of(db_session, user_id) -> list[UserSession]:
    rows = await db_session.execute(
        select(UserSession).where(UserSession.user_id == user_id)
    )
    return list(rows.scalars().all())


async def _revocation_states(db_session, user_id) -> list[bool]:
    """One bool per session row: True when revoked.

    Selects columns rather than ORM objects on purpose. The API commits in its
    own session, so this session's identity map holds stale copies, and
    touching an expired ORM attribute would lazy-load outside the async
    greenlet (MissingGreenlet).
    """
    rows = await db_session.execute(
        select(UserSession.revoked_at).where(UserSession.user_id == user_id)
    )
    return [revoked_at is not None for (revoked_at,) in rows.all()]


async def _membership_of(db_session, user_id) -> OrganizationMember:
    row = await db_session.execute(
        select(OrganizationMember).where(OrganizationMember.user_id == user_id)
    )
    member = row.scalars().first()
    assert member is not None
    return member


async def _deactivate(client, admin_token: str, user_id) -> int:
    response = await client.post(
        f"/api/v1/admin/users/{user_id}/deactivate", headers=auth_headers(admin_token)
    )
    return response.status_code


def _tok() -> str:
    return "tok-" + uuid.uuid4().hex + "x" * 8


# ── Row 4: deactivate, then reuse the old token ──────────────────────────────

async def test_deactivating_a_user_rejects_their_existing_token(
    client, db_session, admin, worker, no_firebase_revocation
):
    _, admin_token = admin
    worker_user, worker_token = worker

    assert (await client.get(PROTECTED_URL, headers=auth_headers(worker_token))).status_code == 200
    assert await _deactivate(client, admin_token, worker_user.id) == 200

    response = await client.get(PROTECTED_URL, headers=auth_headers(worker_token))
    assert response.status_code == 401
    assert response.json().get("code") == "SESSION_REVOKED"


async def test_deactivation_revokes_every_session_row(
    client, db_session, admin, worker, no_firebase_revocation
):
    _, admin_token = admin
    worker_user, _ = worker
    await _deactivate(client, admin_token, worker_user.id)

    states = await _revocation_states(db_session, worker_user.id)
    assert states and all(states)


async def test_deactivation_still_succeeds_when_firebase_fails(
    client, db_session, admin, worker, monkeypatch
):
    """A provider outage must not roll back the DocFlow-side lockout."""
    async def _boom(firebase_uid: str, *, disable_user: bool = False) -> bool:
        return False

    monkeypatch.setattr("app.routers.admin.revoke_firebase_sessions", _boom)
    _, admin_token = admin
    worker_user, worker_token = worker
    worker_user.firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    await db_session.commit()

    assert await _deactivate(client, admin_token, worker_user.id) == 200
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(worker_token))
    ).status_code == 401


async def test_deactivation_asks_firebase_to_disable_the_identity(
    client, db_session, admin, worker, no_firebase_revocation
):
    _, admin_token = admin
    worker_user, _ = worker
    worker_user.firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    await db_session.commit()

    await _deactivate(client, admin_token, worker_user.id)
    assert no_firebase_revocation == [(worker_user.firebase_uid, True)]


# ── Row 5: a deactivated user cannot log in again ───────────────────────────

async def test_a_deactivated_user_cannot_log_in_through_firebase(
    client, db_session, admin, worker, firebase, no_firebase_revocation
):
    _, admin_token = admin
    worker_user, _ = worker
    worker_user.firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    await db_session.commit()
    await _deactivate(client, admin_token, worker_user.id)

    token = firebase.add(_tok(), uid=worker_user.firebase_uid, email=worker_user.email)
    response = await client.post("/api/v1/auth/firebase-login", json={"id_token": token})
    assert response.status_code == 403
    assert response.json().get("code") == "ACCOUNT_DEACTIVATED"


async def test_a_deactivated_user_cannot_log_in_with_a_password(
    client, db_session, admin, worker, no_firebase_revocation, monkeypatch
):
    """The legacy password path answers 410 by default now (G13), so this
    turns it back on - the lockout rule must hold on that path too for as
    long as it exists."""
    monkeypatch.setattr(settings, "LEGACY_PASSWORD_AUTH_ENABLED", True)
    _, admin_token = admin
    worker_user, _ = worker
    worker_user.password_hash = hash_password(PASSWORD)
    await db_session.commit()
    await _deactivate(client, admin_token, worker_user.id)

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": worker_user.email, "password": PASSWORD},
    )
    assert response.status_code == 403
    assert response.json().get("code") == "ACCOUNT_DEACTIVATED"


async def test_a_blocked_login_creates_no_session(
    client, db_session, admin, worker, firebase, no_firebase_revocation
):
    _, admin_token = admin
    worker_user, _ = worker
    worker_user.firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    await db_session.commit()
    await _deactivate(client, admin_token, worker_user.id)
    before = len(await _revocation_states(db_session, worker_user.id))

    token = firebase.add(_tok(), uid=worker_user.firebase_uid, email=worker_user.email)
    await client.post("/api/v1/auth/firebase-login", json={"id_token": token})

    after = await _revocation_states(db_session, worker_user.id)
    assert len(after) == before   # no new session row for a blocked login
    assert all(after)             # and the existing ones are still revoked


# ── Suspension (users.status) ────────────────────────────────────────────────

async def test_a_suspended_account_is_rejected_on_an_existing_token(
    client, db_session, worker
):
    worker_user, worker_token = worker
    worker_user.status = "suspended"
    await db_session.commit()

    response = await client.get(PROTECTED_URL, headers=auth_headers(worker_token))
    assert response.status_code == 403
    assert response.json().get("code") == "ACCOUNT_SUSPENDED"


async def test_a_suspended_account_cannot_log_in(client, db_session, worker, firebase):
    worker_user, _ = worker
    worker_user.status = "suspended"
    worker_user.firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    await db_session.commit()

    token = firebase.add(_tok(), uid=worker_user.firebase_uid, email=worker_user.email)
    response = await client.post("/api/v1/auth/firebase-login", json={"id_token": token})
    assert response.status_code == 403
    assert response.json().get("code") == "ACCOUNT_SUSPENDED"


async def test_an_unknown_status_value_is_blocked_fail_closed(
    client, db_session, worker
):
    worker_user, worker_token = worker
    worker_user.status = "actve"   # the typo from Gap #13
    await db_session.commit()

    response = await client.get(PROTECTED_URL, headers=auth_headers(worker_token))
    assert response.status_code == 403
    assert response.json().get("code") == "ACCOUNT_DEACTIVATED"


# ── Row 6: demotion revokes the old token ───────────────────────────────────

async def test_demoting_an_admin_revokes_their_sessions(
    client, db_session, admin, roles, make_member
):
    """A second admin exists, so the demotion is not blocked as last-admin."""
    _, actor_token = admin
    demoted_user, demoted_token = await make_member(roles["admin"], name="Second Admin")
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(demoted_token))
    ).status_code == 200

    member = await _membership_of(db_session, demoted_user.id)
    response = await client.patch(
        f"/api/v1/orgs/me/members/{member.id}",
        json={"role_id": str(roles["worker"].id)},
        headers=auth_headers(actor_token),
    )
    assert response.status_code == 200

    after = await client.get(PROTECTED_URL, headers=auth_headers(demoted_token))
    assert after.status_code == 401
    assert after.json().get("code") == "SESSION_REVOKED"


async def test_a_fresh_login_after_demotion_carries_only_worker_permissions(
    client, db_session, admin, roles, make_member, firebase
):
    _, actor_token = admin
    demoted_user, _ = await make_member(roles["admin"], name="Second Admin")
    demoted_user.firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    await db_session.commit()

    member = await _membership_of(db_session, demoted_user.id)
    await client.patch(
        f"/api/v1/orgs/me/members/{member.id}",
        json={"role_id": str(roles["worker"].id)},
        headers=auth_headers(actor_token),
    )

    token = firebase.add(_tok(), uid=demoted_user.firebase_uid, email=demoted_user.email)
    response = await client.post("/api/v1/auth/firebase-login", json={"id_token": token})
    assert response.status_code == 200
    membership = response.json()["org_membership"]
    assert membership["role_name"] == "worker"
    assert "admin:users" not in membership["permissions"]


async def test_suspending_a_member_revokes_their_sessions(
    client, db_session, admin, worker
):
    _, admin_token = admin
    worker_user, worker_token = worker
    member = await _membership_of(db_session, worker_user.id)

    response = await client.patch(
        f"/api/v1/orgs/me/members/{member.id}",
        json={"status": "suspended"},
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(worker_token))
    ).status_code == 401


async def test_an_unrelated_member_edit_does_not_revoke_sessions(
    client, db_session, admin, worker
):
    """Only role and status changes revoke — a dept move must not log anyone out."""
    _, admin_token = admin
    worker_user, worker_token = worker
    member = await _membership_of(db_session, worker_user.id)

    response = await client.patch(
        f"/api/v1/orgs/me/members/{member.id}",
        json={"team_id": None, "dept_id": None},
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(worker_token))
    ).status_code == 200


# ── Row 7: removal revokes the old token ────────────────────────────────────

async def test_removing_a_member_revokes_their_sessions(
    client, db_session, admin, worker
):
    _, admin_token = admin
    worker_user, worker_token = worker
    member = await _membership_of(db_session, worker_user.id)

    response = await client.delete(
        f"/api/v1/orgs/me/members/{member.id}", headers=auth_headers(admin_token)
    )
    assert response.status_code == 200

    after = await client.get(PROTECTED_URL, headers=auth_headers(worker_token))
    assert after.status_code == 401
    assert after.json().get("code") == "SESSION_REVOKED"


# ── Reactivation ────────────────────────────────────────────────────────────

async def test_reactivation_allows_a_fresh_login_but_old_sessions_stay_revoked(
    client, db_session, admin, worker, firebase, no_firebase_revocation
):
    _, admin_token = admin
    worker_user, old_token = worker
    worker_user.firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    await db_session.commit()
    await _deactivate(client, admin_token, worker_user.id)

    # Reactivate the way an operator would: both flags back to active.
    # refresh() first, because the deactivation was committed by the request's
    # own session — without it this session still believes is_active is True
    # and would issue no UPDATE at all.
    await db_session.refresh(worker_user)
    worker_user.is_active = True
    worker_user.status = "active"
    await db_session.commit()

    token = firebase.add(_tok(), uid=worker_user.firebase_uid, email=worker_user.email)
    fresh = await client.post("/api/v1/auth/firebase-login", json={"id_token": token})
    assert fresh.status_code == 200

    # The old token's session was revoked and stays that way.
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(old_token))
    ).status_code == 401
    # ...while the new one works.
    new_token = fresh.json()["access_token"]
    assert (
        await client.get(PROTECTED_URL, headers=auth_headers(new_token))
    ).status_code == 200


# ── Refresh must not mint a token for a locked-out account ──────────────────

async def test_refresh_is_refused_for_a_deactivated_account(
    client, db_session, admin, worker, no_firebase_revocation
):
    from app.core.security import create_refresh_token

    _, admin_token = admin
    worker_user, _ = worker
    session = (await _sessions_of(db_session, worker_user.id))[0]
    refresh = create_refresh_token(worker_user.id, session.session_token)

    await _deactivate(client, admin_token, worker_user.id)

    response = await client.post(
        "/api/v1/auth/refresh", cookies={"docflow_refresh": refresh}
    )
    assert response.status_code == 401


# ── Spec 16.2 scenario 16: unverified-email account linking ─────────────────

async def test_linking_an_existing_account_needs_a_verified_email(
    client, db_session, firebase
):
    """Without this check, anyone could register a victim's address with an
    identity provider, leave it unverified, and be handed the victim's
    DocFlow account."""
    email = f"{uuid.uuid4().hex[:10]}@example.com"
    victim = User(email=email, name="Existing Person", is_active=True, status="active")
    db_session.add(victim)
    await db_session.commit()

    token = firebase.add(
        _tok(), uid=f"uid-{uuid.uuid4().hex[:8]}", email=email, verified=False
    )
    response = await client.post("/api/v1/auth/firebase-login", json={"id_token": token})

    assert response.status_code == 403
    assert response.json().get("code") == "EMAIL_NOT_VERIFIED"

    await db_session.refresh(victim)
    assert victim.firebase_uid is None, "the account was linked to an unverified identity"
    assert await _revocation_states(db_session, victim.id) == [], "a session was created"


async def test_linking_proceeds_when_the_provider_reports_the_email_verified(
    client, db_session, firebase
):
    email = f"{uuid.uuid4().hex[:10]}@example.com"
    existing = User(email=email, name="Existing Person", is_active=True, status="active")
    db_session.add(existing)
    await db_session.commit()

    firebase_uid = f"uid-{uuid.uuid4().hex[:8]}"
    token = firebase.add(_tok(), uid=firebase_uid, email=email, verified=True)
    response = await client.post("/api/v1/auth/firebase-login", json={"id_token": token})

    assert response.status_code == 200
    await db_session.refresh(existing)
    assert existing.firebase_uid == firebase_uid


async def test_an_unverified_brand_new_identity_can_still_sign_up(client, firebase):
    """The check is about LINKING to an existing account, not about refusing
    unverified identities outright - a new user has nothing to take over."""
    token = firebase.add(
        _tok(), uid=f"uid-{uuid.uuid4().hex[:8]}",
        email=f"{uuid.uuid4().hex[:10]}@example.com", verified=False,
    )
    response = await client.post("/api/v1/auth/firebase-login", json={"id_token": token})
    assert response.status_code == 200
    assert response.json()["state"] == "NO_ORG"
