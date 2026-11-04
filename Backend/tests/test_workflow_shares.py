"""
Workflow Module §5.1 — per-user sharing of a workflow (WF-OWN-02..11).

The spec insists ownership, visibility and permission-to-use are three
separate things that must never be conflated, and that a share is only real
once the BACKEND has recorded it: "sending a chat message alone grants
nothing" (WF-OWN-02). These tests drive the HTTP API so the route wiring,
the permission checks and the 404-vs-403 rule are all covered.
"""
from __future__ import annotations

import uuid

import pytest
import pytest_asyncio

from conftest import auth_headers

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def member(make_member, roles):
    """A plain Worker to receive shares.

    Deliberately NOT the `hr` fixture: `_is_org_admin` in the public workflow
    router counts both `admin` AND `hr` as organization administrators, so an
    HR user can already read every private workflow in the org and would mask
    exactly what these tests check. That admin-reads-everything behaviour is a
    known deviation from O-10 ("Org Admins: metadata only"), recorded in
    AUDIT/DECISIONS.md and docs/DocFlow_Workflow_Implementation_Plan.md 8.3 -
    it is pre-existing and out of scope here, not something these tests assert.
    """
    return await make_member(roles["worker"], name="Grantee Worker")


def _stage(user_id, name="Review", order=1):
    return {
        "name": name,
        "sequence_order": order,
        "min_approvals_required": 1,
        "approver_rules": [
            {"rule_type": "specific_user", "rule_value": {"user_id": str(user_id)}}
        ],
    }


async def _create(client, token, approver_id, *, name, visibility="private"):
    resp = await client.post(
        "/api/v1/workflow-templates",
        headers=auth_headers(token),
        params={"visibility": visibility},
        json={"name": name, "stages": [_stage(approver_id)]},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _share(client, token, template_id, user_id):
    return await client.post(
        f"/api/v1/workflow-templates/{template_id}/shares",
        headers=auth_headers(token),
        json={"user_id": str(user_id)},
    )


# ── Granting ────────────────────────────────────────────────────────────────

async def test_share_makes_a_private_workflow_usable_by_the_grantee(
    client, worker, member, admin
):
    """WF-OWN-01 + WF-OWN-09: private by default, and a share is what puts it
    in the recipient's "Shared with me" tab."""
    _w, owner_token = worker
    grantee, grantee_token = member
    approver, _ = admin
    wf = await _create(client, owner_token, approver.id, name="Shared route")

    # Before the share the grantee cannot even see that it exists (404, not
    # 403 — WF-OWN-10 is explicit that existence must not leak).
    before = await client.get(
        f"/api/v1/workflow-templates/{wf['id']}",
        headers=auth_headers(grantee_token),
    )
    assert before.status_code == 404, before.text

    resp = await _share(client, owner_token, wf["id"], grantee.id)
    assert resp.status_code == 201, resp.text
    assert resp.json()["created"] is True
    assert resp.json()["share"]["permission"] == "USE"
    assert resp.json()["share"]["grantee_user_id"] == str(grantee.id)

    # Now readable...
    after = await client.get(
        f"/api/v1/workflow-templates/{wf['id']}",
        headers=auth_headers(grantee_token),
    )
    assert after.status_code == 200, after.text

    # ...and listed under "Shared with me", but NOT under "My Workflows".
    shared = await client.get(
        "/api/v1/workflow-templates",
        headers=auth_headers(grantee_token),
        params={"scope": "shared", "active_only": False},
    )
    assert [w["id"] for w in shared.json()] == [wf["id"]]

    mine = await client.get(
        "/api/v1/workflow-templates",
        headers=auth_headers(grantee_token),
        params={"scope": "mine", "active_only": False},
    )
    assert wf["id"] not in [w["id"] for w in mine.json()]


async def test_sharing_twice_is_idempotent(client, worker, hr, admin):
    """WF-OWN-07: no duplicate row, and the caller can tell that no second
    chat message should be sent."""
    _w, owner_token = worker
    grantee, _ = hr
    approver, _ = admin
    wf = await _create(client, owner_token, approver.id, name="Idempotent")

    first = await _share(client, owner_token, wf["id"], grantee.id)
    second = await _share(client, owner_token, wf["id"], grantee.id)

    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["created"] is True
    assert second.json()["created"] is False
    assert first.json()["share"]["id"] == second.json()["share"]["id"]

    panel = await client.get(
        f"/api/v1/workflow-templates/{wf['id']}/shares",
        headers=auth_headers(owner_token),
    )
    assert len(panel.json()) == 1


async def test_sharing_with_yourself_is_rejected(client, worker, admin):
    """WF-OWN-08."""
    owner, owner_token = worker
    approver, _ = admin
    wf = await _create(client, owner_token, approver.id, name="Self share")

    resp = await _share(client, owner_token, wf["id"], owner.id)
    assert resp.status_code == 422, resp.text


async def test_sharing_with_a_non_member_is_rejected(client, worker, admin):
    """WF-OWN-08: a user outside the organization is refused by the SERVER,
    not merely absent from the picker."""
    _w, owner_token = worker
    approver, _ = admin
    wf = await _create(client, owner_token, approver.id, name="Outsider share")

    resp = await _share(client, owner_token, wf["id"], uuid.uuid4())
    assert resp.status_code == 422, resp.text


async def test_a_grantee_cannot_re_share_or_edit(client, worker, member, admin):
    """WF-OWN-05: USE only — no edit, no re-share, no delete."""
    _w, owner_token = worker
    grantee, grantee_token = member
    approver, _ = admin
    wf = await _create(client, owner_token, approver.id, name="Use only")
    await _share(client, owner_token, wf["id"], grantee.id)

    # cannot re-share
    resh = await _share(client, grantee_token, wf["id"], approver.id)
    assert resh.status_code == 403, resh.text

    # cannot edit
    edit = await client.patch(
        f"/api/v1/workflow-templates/{wf['id']}",
        headers=auth_headers(grantee_token),
        json={"name": "Hijacked"},
    )
    assert edit.status_code == 403, edit.text

    # cannot delete
    dele = await client.delete(
        f"/api/v1/workflow-templates/{wf['id']}",
        headers=auth_headers(grantee_token),
    )
    assert dele.status_code == 403, dele.text

    # cannot see the share panel
    panel = await client.get(
        f"/api/v1/workflow-templates/{wf['id']}/shares",
        headers=auth_headers(grantee_token),
    )
    assert panel.status_code == 403, panel.text


async def test_only_the_owner_can_share(client, worker, hr, trainee, admin):
    """An unrelated member gets 404 (existence hidden), not 403."""
    _w, owner_token = worker
    _t, outsider_token = trainee
    approver, _ = admin
    other, _ = hr
    wf = await _create(client, owner_token, approver.id, name="Owner only")

    resp = await _share(client, outsider_token, wf["id"], other.id)
    assert resp.status_code == 404, resp.text


async def test_sharing_an_unknown_workflow_is_404(client, worker, hr):
    _w, owner_token = worker
    grantee, _ = hr
    resp = await _share(client, owner_token, uuid.uuid4(), grantee.id)
    assert resp.status_code == 404, resp.text


# ── Revoking ────────────────────────────────────────────────────────────────

async def test_revoke_removes_it_from_the_grantee_immediately(
    client, worker, member, admin
):
    """WF-OWN-06."""
    _w, owner_token = worker
    grantee, grantee_token = member
    approver, _ = admin
    wf = await _create(client, owner_token, approver.id, name="Revoke me")
    await _share(client, owner_token, wf["id"], grantee.id)

    resp = await client.delete(
        f"/api/v1/workflow-templates/{wf['id']}/shares/{grantee.id}",
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 204, resp.text

    gone = await client.get(
        f"/api/v1/workflow-templates/{wf['id']}",
        headers=auth_headers(grantee_token),
    )
    assert gone.status_code == 404

    shared = await client.get(
        "/api/v1/workflow-templates",
        headers=auth_headers(grantee_token),
        params={"scope": "shared", "active_only": False},
    )
    assert shared.json() == []


async def test_revoke_is_idempotent_and_reshare_works(client, worker, hr, admin):
    """WF-LC-06 (lifecycle actions are idempotent), and a revoked row must not
    block a later re-share — which is why the unique index is partial."""
    _w, owner_token = worker
    grantee, _ = hr
    approver, _ = admin
    wf = await _create(client, owner_token, approver.id, name="Re-share")
    await _share(client, owner_token, wf["id"], grantee.id)

    for _ in range(2):
        resp = await client.delete(
            f"/api/v1/workflow-templates/{wf['id']}/shares/{grantee.id}",
            headers=auth_headers(owner_token),
        )
        assert resp.status_code == 204, resp.text

    again = await _share(client, owner_token, wf["id"], grantee.id)
    assert again.status_code == 201, again.text
    assert again.json()["created"] is True


# ── Archive / restore and the delete guard ─────────────────────────────────

async def test_archive_hides_from_pickers_and_restore_brings_it_back(
    client, worker, admin
):
    """WF-LC-03."""
    _w, token = worker
    approver, _ = admin
    wf = await _create(client, worker[1], approver.id, name="Archive me")

    arch = await client.post(
        f"/api/v1/workflow-templates/{wf['id']}/archive",
        headers=auth_headers(token),
    )
    assert arch.status_code == 200, arch.text
    assert arch.json()["is_active"] is False

    # Gone from the default (active-only) picker...
    active = await client.get(
        "/api/v1/workflow-templates", headers=auth_headers(token),
    )
    assert wf["id"] not in [w["id"] for w in active.json()]

    rest = await client.post(
        f"/api/v1/workflow-templates/{wf['id']}/restore",
        headers=auth_headers(token),
    )
    assert rest.status_code == 200, rest.text
    assert rest.json()["is_active"] is True

    active2 = await client.get(
        "/api/v1/workflow-templates", headers=auth_headers(token),
    )
    assert wf["id"] in [w["id"] for w in active2.json()]


async def test_deleting_a_workflow_revokes_its_shares(client, worker, member, admin):
    """WF-LC-04: a grantee must not keep a dangling entry."""
    _w, owner_token = worker
    grantee, grantee_token = member
    approver, _ = admin
    wf = await _create(client, owner_token, approver.id, name="Delete with shares")
    await _share(client, owner_token, wf["id"], grantee.id)

    resp = await client.delete(
        f"/api/v1/workflow-templates/{wf['id']}",
        headers=auth_headers(owner_token),
    )
    assert resp.status_code == 204, resp.text

    shared = await client.get(
        "/api/v1/workflow-templates",
        headers=auth_headers(grantee_token),
        params={"scope": "shared", "active_only": False},
    )
    assert shared.json() == []
