"""
Covers §7's user-owned workflows: any role may author their own reusable
workflow, a private workflow is invisible to other members, only the owner
(or an org admin) may edit it, and the duplicate / enable-disable / delete
operations respect the same boundary.

Exercised through the HTTP API so the route wiring, permission dependencies
and schema shape are all covered — not just the service layer.
"""
from __future__ import annotations

import uuid

import pytest

from conftest import auth_headers


def _stage(user_id, name="Review", order=1, min_approvals=1):
    return {
        "name": name,
        "sequence_order": order,
        "min_approvals_required": min_approvals,
        "approver_rules": [
            {"rule_type": "specific_user", "rule_value": {"user_id": str(user_id)}}
        ],
    }


async def _create(client, token, approver_id, *, name, visibility="private", stages=None):
    return await client.post(
        "/api/v1/workflow-templates",
        headers=auth_headers(token),
        params={"visibility": visibility},
        json={"name": name, "stages": stages or [_stage(approver_id)]},
    )


# ── Authoring (§2.5: "Create and manage own workflows: Yes" for all roles) ──

async def test_every_role_can_create_their_own_workflow(
    client, admin, hr, worker, trainee
):
    """
    A Trainee may not APPROVE, but may still define a workflow for their own
    documents (§2.5) — the approver it routes to just can't be a trainee.

    NOTE: all four actors are requested as explicit fixture parameters
    rather than resolved via request.getfixturevalue() in a parametrize.
    getfixturevalue() does not await async fixtures: it hands back the
    un-awaited coroutine, which surfaces as "This event loop is already
    running" plus a "coroutine was never awaited" warning.
    """
    approver, _ = admin  # a valid, non-trainee approver

    for label, (user, token) in {
        "admin": admin,
        "hr": hr,
        "worker": worker,
        "trainee": trainee,
    }.items():
        resp = await _create(
            client, token, approver.id, name=f"{label} workflow {uuid.uuid4().hex[:4]}"
        )
        assert resp.status_code == 201, f"{label}: {resp.text}"
        body = resp.json()
        assert body["created_by"] == str(user.id), label
        assert body["visibility"] == "private", label
        assert len(body["stages"]) == 1, label


async def test_workflow_defaults_to_private_and_can_be_shared(client, worker, admin):
    worker_user, token = worker
    approver, _ = admin

    private = await _create(client, token, approver.id, name="Mine only")
    assert private.json()["visibility"] == "private"

    shared = await _create(
        client, token, approver.id, name="Team route", visibility="organization"
    )
    assert shared.json()["visibility"] == "organization"


# ── Visibility ──────────────────────────────────────────────────────────────

async def test_private_workflow_is_hidden_from_other_members(
    client, worker, trainee, admin
):
    _worker_user, worker_token = worker
    _trainee_user, trainee_token = trainee
    approver, _ = admin

    created = await _create(client, worker_token, approver.id, name="Worker private")
    template_id = created.json()["id"]

    # The owner sees it.
    mine = await client.get(
        "/api/v1/workflow-templates",
        headers=auth_headers(worker_token),
        params={"active_only": False},
    )
    assert template_id in [t["id"] for t in mine.json()]

    # Another member does not.
    theirs = await client.get(
        "/api/v1/workflow-templates",
        headers=auth_headers(trainee_token),
        params={"active_only": False},
    )
    assert template_id not in [t["id"] for t in theirs.json()]

    # And cannot load it directly — 404, not 403: we don't confirm it exists.
    direct = await client.get(
        f"/api/v1/workflow-templates/{template_id}", headers=auth_headers(trainee_token)
    )
    assert direct.status_code == 404


async def test_shared_workflow_is_visible_to_everyone_in_the_org(
    client, worker, trainee, admin
):
    _w, worker_token = worker
    _t, trainee_token = trainee
    approver, _ = admin

    created = await _create(
        client, worker_token, approver.id, name="Shared route", visibility="organization"
    )
    template_id = created.json()["id"]

    listing = await client.get(
        "/api/v1/workflow-templates",
        headers=auth_headers(trainee_token),
        params={"active_only": False},
    )
    assert template_id in [t["id"] for t in listing.json()]


async def test_org_admin_sees_members_private_workflows(client, worker, admin):
    """§7's sharing restriction explicitly exempts administration permissions."""
    _w, worker_token = worker
    admin_user, admin_token = admin

    created = await _create(client, worker_token, admin_user.id, name="Worker private")
    template_id = created.json()["id"]

    admin_view = await client.get(
        f"/api/v1/workflow-templates/{template_id}", headers=auth_headers(admin_token)
    )
    assert admin_view.status_code == 200


# ── Editing ─────────────────────────────────────────────────────────────────

async def test_owner_can_edit_and_version_is_bumped(client, worker, admin):
    _w, token = worker
    approver, _ = admin
    created = await _create(client, token, approver.id, name="Before")
    template_id = created.json()["id"]
    assert created.json()["version"] == 1

    updated = await client.patch(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(token),
        json={"name": "After"},
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "After"
    # In-flight instances keep their own snapshot; the template versions up.
    assert updated.json()["version"] == 2


async def test_another_member_cannot_edit_my_workflow(client, worker, trainee, admin):
    """§7: "Prevent unauthorized users from editing another user's private
    workflow unless sharing or administration permissions allow it." """
    _w, worker_token = worker
    _t, trainee_token = trainee
    approver, _ = admin

    created = await _create(client, worker_token, approver.id, name="Hands off")
    template_id = created.json()["id"]

    resp = await client.patch(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(trainee_token),
        json={"name": "Hijacked"},
    )
    assert resp.status_code in (403, 404)

    # Even a SHARED workflow is editable only by its owner or an admin.
    shared = await _create(
        client, worker_token, approver.id, name="Shared", visibility="organization"
    )
    shared_id = shared.json()["id"]
    resp2 = await client.patch(
        f"/api/v1/workflow-templates/{shared_id}",
        headers=auth_headers(trainee_token),
        json={"name": "Hijacked"},
    )
    assert resp2.status_code == 403


async def test_org_admin_can_edit_a_members_workflow(client, worker, admin):
    _w, worker_token = worker
    admin_user, admin_token = admin
    created = await _create(client, worker_token, admin_user.id, name="Members")
    template_id = created.json()["id"]

    resp = await client.patch(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(admin_token),
        json={"description": "Adjusted by admin"},
    )
    assert resp.status_code == 200


# ── Duplicate / enable-disable / delete ─────────────────────────────────────

async def test_duplicate_creates_a_private_copy_owned_by_the_caller(
    client, worker, trainee, admin
):
    _w, worker_token = worker
    trainee_user, trainee_token = trainee
    approver, _ = admin

    original = await _create(
        client, worker_token, approver.id, name="Team route", visibility="organization"
    )
    original_id = original.json()["id"]

    copy = await client.post(
        f"/api/v1/workflow-templates/{original_id}/duplicate",
        headers=auth_headers(trainee_token),
        params={"new_name": "My variant"},
    )
    assert copy.status_code == 201
    body = copy.json()
    assert body["id"] != original_id
    assert body["name"] == "My variant"
    assert body["created_by"] == str(trainee_user.id)
    # Duplicating someone else's shared workflow must not silently publish a
    # variant of it.
    assert body["visibility"] == "private"
    assert len(body["stages"]) == len(original.json()["stages"])


async def test_enable_disable_round_trip(client, worker, admin):
    _w, token = worker
    approver, _ = admin
    created = await _create(client, token, approver.id, name="Toggle me")
    template_id = created.json()["id"]

    off = await client.post(
        f"/api/v1/workflow-templates/{template_id}/active",
        headers=auth_headers(token),
        params={"is_active": False},
    )
    assert off.status_code == 200 and off.json()["is_active"] is False

    on = await client.post(
        f"/api/v1/workflow-templates/{template_id}/active",
        headers=auth_headers(token),
        params={"is_active": True},
    )
    assert on.json()["is_active"] is True


async def test_owner_can_delete_but_others_cannot(client, worker, trainee, admin):
    _w, worker_token = worker
    _t, trainee_token = trainee
    approver, _ = admin

    created = await _create(client, worker_token, approver.id, name="Doomed")
    template_id = created.json()["id"]

    denied = await client.delete(
        f"/api/v1/workflow-templates/{template_id}", headers=auth_headers(trainee_token)
    )
    assert denied.status_code in (403, 404)

    ok = await client.delete(
        f"/api/v1/workflow-templates/{template_id}", headers=auth_headers(worker_token)
    )
    assert ok.status_code == 204

    gone = await client.get(
        f"/api/v1/workflow-templates/{template_id}", headers=auth_headers(worker_token)
    )
    assert gone.status_code == 404


# ── Validation surfaced through the API (§7) ────────────────────────────────

async def test_api_rejects_a_stage_with_no_approvers(client, worker):
    _w, token = worker
    resp = await client.post(
        "/api/v1/workflow-templates",
        headers=auth_headers(token),
        json={
            "name": "Broken",
            "stages": [{"name": "Nobody", "sequence_order": 1, "approver_rules": []}],
        },
    )
    assert resp.status_code == 409
    assert "no approvers" in resp.text.lower()


async def test_api_rejects_a_trainee_as_approver(client, worker, trainee):
    trainee_user, _ = trainee
    _w, token = worker
    resp = await client.post(
        "/api/v1/workflow-templates",
        headers=auth_headers(token),
        json={"name": "Trainee approver", "stages": [_stage(trainee_user.id)]},
    )
    assert resp.status_code == 403
    assert "trainee" in resp.text.lower()


async def test_api_rejects_duplicate_stage_order(client, worker, admin):
    _w, token = worker
    approver, _ = admin
    resp = await client.post(
        "/api/v1/workflow-templates",
        headers=auth_headers(token),
        json={
            "name": "Ambiguous order",
            "stages": [
                _stage(approver.id, name="A", order=1),
                _stage(approver.id, name="B", order=1),
            ],
        },
    )
    assert resp.status_code == 409
    assert "unique" in resp.text.lower()


async def test_api_rejects_workflow_with_no_stages(client, worker):
    _w, token = worker
    resp = await client.post(
        "/api/v1/workflow-templates",
        headers=auth_headers(token),
        json={"name": "Empty", "stages": []},
    )
    assert resp.status_code == 409
    assert "at least one" in resp.text.lower()


# ── Cross-org isolation ─────────────────────────────────────────────────────

async def test_cannot_read_a_workflow_from_another_org(client, db_session, worker, admin):
    _w, worker_token = worker
    approver, _ = admin
    created = await _create(client, worker_token, approver.id, name="Org A route")
    template_id = created.json()["id"]

    from conftest import _make_member
    from app.repositories.org_repo import OrganizationRepository

    repo = OrganizationRepository(db_session)
    other_org = await repo.create(name=f"Other {uuid.uuid4().hex[:6]}")
    other_roles = await repo.create_default_roles(other_org.id)
    await db_session.flush()
    _outsider, outsider_token = await _make_member(
        db_session, other_org, other_roles["admin"]
    )
    await db_session.commit()

    resp = await client.get(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(outsider_token),
    )
    assert resp.status_code == 404


# ── Defect 2, and the versioning that resolves it ──────────────────────────
# `WorkflowTemplateUpdate` had no `stages` field, so Pydantic dropped the stage
# list the builder sends on every save: the server wrote none of it and still
# returned 200, while the UI told the user a new version had been created.
#
# The fix is versioning (DM-01): a changed stage list now writes a NEW
# immutable version and leaves the old one alone, so nothing has to be
# destructively rewritten and the approvals already recorded against the old
# stages keep their definition.

async def test_editing_stages_creates_a_new_version_and_keeps_the_old_one(
    client, worker, admin
):
    _w, token = worker
    approver, _ = admin
    created = await _create(client, token, approver.id, name="Versioned")
    template_id = created.json()["id"]

    first = await client.get(
        f"/api/v1/workflow-templates/{template_id}/versions",
        headers=auth_headers(token),
    )
    assert first.status_code == 200, first.text
    assert [v["version_number"] for v in first.json()] == [1]
    assert first.json()[0]["stage_count"] == 1
    assert first.json()[0]["is_current"] is True

    # Genuinely different definition: a second stage.
    resp = await client.patch(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(token),
        json={
            "stages": [
                _stage(approver.id, name="Review", order=1),
                _stage(approver.id, name="Second opinion", order=2),
            ]
        },
    )
    assert resp.status_code == 200, resp.text

    versions = await client.get(
        f"/api/v1/workflow-templates/{template_id}/versions",
        headers=auth_headers(token),
    )
    numbers = [v["version_number"] for v in versions.json()]
    assert numbers == [2, 1], numbers
    by_number = {v["version_number"]: v for v in versions.json()}
    # DM-01: version 1 is IMMUTABLE — it still describes one stage.
    assert by_number[1]["stage_count"] == 1
    assert by_number[1]["is_current"] is False
    assert by_number[2]["stage_count"] == 2
    assert by_number[2]["is_current"] is True

    # ...and the live definition really did change (the old bug was that it
    # silently did not).
    detail = await client.get(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(token),
    )
    assert len(detail.json()["stages"]) == 2


async def test_resending_identical_stages_does_not_mint_a_version(
    client, worker, admin
):
    """The builder re-sends `stages` on every save, even when only the name
    changed. Treating that as an edit would mint a new version for a typo
    fix, so an identical list must be recognised as a no-op."""
    _w, token = worker
    approver, _ = admin
    created = await _create(client, token, approver.id, name="Rename me")
    template_id = created.json()["id"]
    stage = created.json()["stages"][0]

    resp = await client.patch(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(token),
        json={
            "name": "Renamed",
            "stages": [
                _stage(approver.id, name=stage["name"], order=stage["sequence_order"])
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Renamed"

    versions = await client.get(
        f"/api/v1/workflow-templates/{template_id}/versions",
        headers=auth_headers(token),
    )
    assert [v["version_number"] for v in versions.json()] == [1]


async def test_version_history_is_owner_only(client, worker, trainee, admin):
    """§7.3: a grantee may read the current definition, but the history of how
    it got there is the owner's."""
    _w, owner_token = worker
    _t, other_token = trainee
    approver, _ = admin
    created = await _create(client, owner_token, approver.id, name="Private history")
    template_id = created.json()["id"]

    resp = await client.get(
        f"/api/v1/workflow-templates/{template_id}/versions",
        headers=auth_headers(other_token),
    )
    # 404, not 403: a private workflow must not confirm its own existence
    # (WF-OWN-10, E28).
    assert resp.status_code == 404, resp.text
