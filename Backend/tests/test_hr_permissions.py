"""
Covers the HR role's permission boundaries per the Organization Dashboard &
Role-Based Access Requirements report §2.1/2.2/13.3/13.4: HR shares
day-to-day admin access with the Main Administrator (workflow templates,
audit logs, inviting Worker/Trainee members) but must never add an HR user,
delete/deactivate a member, or reach Main-Administrator-only endpoints
(roles catalog, user deactivation).
"""
from __future__ import annotations

import uuid

import pytest

from conftest import auth_headers


@pytest.fixture
def fake_firebase(monkeypatch):
    """
    MemberService.invite_member creates a Firebase identity for brand-new
    accounts, and Firebase is deliberately not initialized in this suite
    (see conftest's `client` docstring). Stub it so the tests exercise the
    ROLE-ASSIGNMENT authorization rules rather than failing on missing
    Firebase credentials. Note the permission checks under test run BEFORE
    this is ever reached, so the 403 cases don't need this fixture.
    """
    monkeypatch.setattr(
        "app.core.firebase.create_firebase_user",
        lambda email, password, name=None: f"fb-test-{uuid.uuid4().hex[:10]}",
    )


async def test_hr_can_access_workflow_templates(client, hr):
    _, token = hr
    resp = await client.get("/api/v1/admin/workflow-templates", headers=auth_headers(token))
    assert resp.status_code == 200


async def test_hr_can_access_audit_logs(client, hr):
    _, token = hr
    resp = await client.get("/api/v1/admin/audit-logs", headers=auth_headers(token))
    assert resp.status_code == 200


async def test_hr_cannot_access_roles_catalog(client, hr):
    _, token = hr
    resp = await client.get("/api/v1/admin/roles/catalog", headers=auth_headers(token))
    assert resp.status_code == 403


async def test_hr_cannot_deactivate_a_user(client, hr, worker):
    _, hr_token = hr
    worker_user, _ = worker
    resp = await client.post(
        f"/api/v1/admin/users/{worker_user.id}/deactivate",
        headers=auth_headers(hr_token),
    )
    assert resp.status_code == 403


async def test_hr_can_invite_a_worker(client, hr, roles, fake_firebase):
    _, hr_token = hr
    resp = await client.post(
        "/api/v1/orgs/me/members/invite",
        headers=auth_headers(hr_token),
        json={
            "email": "new.worker@example.com",
            "name": "New Worker",
            "role_id": str(roles["worker"].id),
            "password": "supersecret1",
        },
    )
    assert resp.status_code == 201


async def test_hr_cannot_invite_an_hr_user(client, hr, roles):
    _, hr_token = hr
    resp = await client.post(
        "/api/v1/orgs/me/members/invite",
        headers=auth_headers(hr_token),
        json={
            "email": "new.hr@example.com",
            "name": "New HR",
            "role_id": str(roles["hr"].id),
            "password": "supersecret1",
        },
    )
    assert resp.status_code == 403


async def test_admin_can_invite_an_hr_user(client, admin, roles, fake_firebase):
    _, admin_token = admin
    resp = await client.post(
        "/api/v1/orgs/me/members/invite",
        headers=auth_headers(admin_token),
        json={
            "email": "new.hr2@example.com",
            "name": "New HR Two",
            "role_id": str(roles["hr"].id),
            "password": "supersecret1",
        },
    )
    assert resp.status_code == 201


async def test_nobody_can_invite_an_admin_via_invite_endpoint(client, admin, roles):
    _, admin_token = admin
    resp = await client.post(
        "/api/v1/orgs/me/members/invite",
        headers=auth_headers(admin_token),
        json={
            "email": "new.admin@example.com",
            "name": "New Admin",
            "role_id": str(roles["admin"].id),
            "password": "supersecret1",
        },
    )
    assert resp.status_code == 403


async def test_hr_cannot_remove_an_active_member(client, hr, worker):
    _, hr_token = hr
    worker_user, _ = worker

    resp = await client.get("/api/v1/orgs/me/members", headers=auth_headers(hr_token))
    assert resp.status_code == 200
    member_id = next(
        m["id"] for m in resp.json()["items"] if m["user_id"] == str(worker_user.id)
    )
    resp = await client.delete(
        f"/api/v1/orgs/me/members/{member_id}", headers=auth_headers(hr_token)
    )
    assert resp.status_code == 403


async def test_hr_cannot_promote_a_member_to_admin(client, hr, worker, roles):
    _, hr_token = hr
    worker_user, _ = worker

    resp = await client.get("/api/v1/orgs/me/members", headers=auth_headers(hr_token))
    member_id = next(
        m["id"] for m in resp.json()["items"] if m["user_id"] == str(worker_user.id)
    )
    resp = await client.patch(
        f"/api/v1/orgs/me/members/{member_id}",
        headers=auth_headers(hr_token),
        json={"role_id": str(roles["admin"].id)},
    )
    assert resp.status_code == 403
