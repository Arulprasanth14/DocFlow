"""
Covers admin.py::_require_admin (previously gated on platform is_superadmin,
locking ordinary org admins out of their own admin endpoints) and the
deactivate_user cross-org isolation fix.
"""
from __future__ import annotations

from conftest import auth_headers


async def test_org_admin_can_access_roles_catalog(client, admin):
    _, token = admin
    resp = await client.get("/api/v1/admin/roles/catalog", headers=auth_headers(token))
    assert resp.status_code == 200
    names = {r["name"] for r in resp.json()}
    assert names == {"admin", "hr", "worker", "trainee"}


async def test_org_admin_can_access_audit_logs(client, admin):
    _, token = admin
    resp = await client.get("/api/v1/admin/audit-logs", headers=auth_headers(token))
    assert resp.status_code == 200


async def test_worker_cannot_access_admin_endpoints(client, worker):
    _, token = worker
    resp = await client.get("/api/v1/admin/roles/catalog", headers=auth_headers(token))
    assert resp.status_code == 403


async def test_trainee_cannot_access_admin_endpoints(client, trainee):
    _, token = trainee
    resp = await client.get("/api/v1/admin/audit-logs", headers=auth_headers(token))
    assert resp.status_code == 403


async def test_admin_cannot_deactivate_user_in_another_org(client, db_session, admin):
    """The cross-tenant bug: deactivate_user used to load any user by ID with
    no org check at all. Set up a second, independent org with its own admin
    member, and confirm the first org's admin cannot deactivate them."""
    from conftest import _make_member
    from app.repositories.org_repo import OrganizationRepository

    _, admin_token = admin

    other_org_repo = OrganizationRepository(db_session)
    other_org = await other_org_repo.create(name="Other Org")
    other_roles = await other_org_repo.create_default_roles(other_org.id)
    await db_session.flush()
    other_user, _ = await _make_member(db_session, other_org, other_roles["worker"])
    await db_session.commit()  # client uses a separate session/connection

    resp = await client.post(
        f"/api/v1/admin/users/{other_user.id}/deactivate",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 404


async def test_admin_can_deactivate_own_org_member(client, admin, worker):
    _, admin_token = admin
    worker_user, _ = worker
    resp = await client.post(
        f"/api/v1/admin/users/{worker_user.id}/deactivate",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200
