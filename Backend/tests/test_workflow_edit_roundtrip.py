"""
The workflow edit form must get back exactly what it saved.

`workflow_stages` predates the Workflow module and has no column for a
stage's department or for the due-within wording the owner chose (section 5.5
fields C and D); `workflow_template_versions` / `workflow_version_stages` do.
The template read served the legacy rows only, so three things were lost or
silently reverted the moment anyone opened a workflow in the editor:

  * `require_full_reapproval` (WF-BLD-07 / BR-06) was never serialized at
    all, so the edit form read `undefined`, rendered the toggle OFF and then
    saved that OFF back - turning off full re-approval for any workflow that
    had it on;
  * every stage's `department_id` came back empty, which also drops the
    department-mandated signing lock (WF-STG-20); and
  * a department-only edit compared equal to what was stored, because
    `_stages_differ()` fingerprinted the legacy rows and those cannot carry a
    department - so no new version was written, nothing was saved, and the UI
    reported success.

These are read-path and change-detection tests. Nothing here changes the
schema: the data was always being written, just never served back.
"""
from __future__ import annotations

import uuid

import pytest_asyncio

from app.models.organization import Department
from conftest import auth_headers


@pytest_asyncio.fixture
async def finance(db_session, org) -> Department:
    """A department that forces signing on (WF-STG-20)."""
    dept = Department(
        org_id=org.id,
        name="Finance",
        code=f"fin-{uuid.uuid4().hex[:6]}",
        requires_signature=True,
    )
    db_session.add(dept)
    await db_session.commit()
    return dept


@pytest_asyncio.fixture
async def ops(db_session, org) -> Department:
    dept = Department(
        org_id=org.id, name="Operations", code=f"ops-{uuid.uuid4().hex[:6]}"
    )
    db_session.add(dept)
    await db_session.commit()
    return dept


def _stage(user_id, name="Review", order=1, department_id=None, **extra):
    stage = {
        "name": name,
        "sequence_order": order,
        "min_approvals_required": 1,
        "approver_rules": [
            {"rule_type": "specific_user", "rule_value": {"user_id": str(user_id)}}
        ],
        **extra,
    }
    if department_id is not None:
        stage["department_id"] = str(department_id)
    return stage


def _manager_stage(name="Manager sign-off", order=1, department_id=None, **extra):
    """A submitter-manager stage pins no user, so its department is whatever
    was chosen - there is no approver to inherit one from."""
    stage = {
        "name": name,
        "sequence_order": order,
        "min_approvals_required": 1,
        "approver_rules": [{"rule_type": "manager_of_requester", "rule_value": {}}],
        **extra,
    }
    if department_id is not None:
        stage["department_id"] = str(department_id)
    return stage


async def _create(client, token, *, name, stages, require_full_reapproval=False):
    resp = await client.post(
        "/api/v1/workflow-templates",
        headers=auth_headers(token),
        params={"visibility": "private"},
        json={
            "name": name,
            "stages": stages,
            "require_full_reapproval": require_full_reapproval,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _get(client, token, template_id):
    resp = await client.get(
        f"/api/v1/workflow-templates/{template_id}", headers=auth_headers(token)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _versions(client, token, template_id):
    resp = await client.get(
        f"/api/v1/workflow-templates/{template_id}/versions",
        headers=auth_headers(token),
    )
    # The endpoint returns newest first (a history list); these tests care
    # only about WHICH versions exist, so compare them sorted.
    return sorted(v["version_number"] for v in resp.json())


# -- require_full_reapproval (WF-BLD-07 / BR-06) ----------------------------

async def test_require_full_reapproval_is_returned_by_the_read(client, worker, admin):
    _w, token = worker
    approver, _ = admin
    created = await _create(
        client,
        token,
        name=f"Full reapproval {uuid.uuid4().hex[:4]}",
        stages=[_stage(approver.id)],
        require_full_reapproval=True,
    )
    assert created["require_full_reapproval"] is True, (
        "the create response must carry the flag the request set"
    )

    fetched = await _get(client, token, created["id"])
    assert fetched["require_full_reapproval"] is True, (
        "the edit form reads this endpoint; when it was missing the toggle "
        "rendered OFF and the next save persisted OFF"
    )


async def test_editing_a_workflow_does_not_turn_off_full_reapproval(
    client, worker, admin
):
    """The regression this exists for: load, change the name, save."""
    _w, token = worker
    approver, _ = admin
    created = await _create(
        client,
        token,
        name=f"Keep it on {uuid.uuid4().hex[:4]}",
        stages=[_stage(approver.id)],
        require_full_reapproval=True,
    )
    loaded = await _get(client, token, created["id"])

    # Exactly what the builder sends: the flag as it was read back, plus the
    # stage list re-sent unchanged.
    resp = await client.patch(
        f"/api/v1/workflow-templates/{created['id']}",
        headers=auth_headers(token),
        json={
            "name": "Renamed but still strict",
            "require_full_reapproval": loaded["require_full_reapproval"],
            "stages": [
                _stage(
                    approver.id,
                    name=loaded["stages"][0]["name"],
                    order=loaded["stages"][0]["sequence_order"],
                    department_id=loaded["stages"][0]["department_id"],
                )
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["require_full_reapproval"] is True
    assert (await _get(client, token, created["id"]))["require_full_reapproval"] is True


# -- Per-stage department and due-within (section 5.5 fields C and D) -------

async def test_read_returns_the_stage_department_and_due_within_wording(
    client, worker, admin, ops
):
    _w, token = worker
    created = await _create(
        client,
        token,
        name=f"Dept route {uuid.uuid4().hex[:4]}",
        stages=[
            _manager_stage(
                name="Ops review",
                order=1,
                department_id=ops.id,
                due_within_value=6,
                due_within_unit="hours",
            )
        ],
    )
    stage = (await _get(client, token, created["id"]))["stages"][0]

    assert stage["department_id"] == str(ops.id), (
        "without this the edit form reopened the stage with no department, and "
        "saving dropped it"
    )
    assert stage["department_name"] == "Operations", (
        "resolved server-side because a Worker cannot read the department "
        "list to resolve it itself"
    )
    # The owner typed "6 hours"; the engine stores 6. Returning 'days' here
    # would show them something they never chose.
    assert stage["due_within_value"] == 6
    assert stage["due_within_unit"] == "hours"
    assert stage["sla_hours"] == 6


async def test_read_resolves_the_approver_name(client, worker, admin):
    """The detail page printed the literal string "Assigned approver" for
    every stage, because the payload carried ids only."""
    _w, token = worker
    approver, _ = admin
    created = await _create(
        client,
        token,
        name=f"Named approver {uuid.uuid4().hex[:4]}",
        stages=[_stage(approver.id)],
    )
    stage = (await _get(client, token, created["id"]))["stages"][0]
    assert stage["approver_user_id"] == str(approver.id)
    assert stage["approver_name"] == approver.name


async def test_department_signing_lock_survives_the_round_trip(
    client, worker, finance
):
    """WF-STG-20: the server forces signing on for a Finance stage. If the
    department is lost on read, the next save loses the lock with it."""
    _w, token = worker
    created = await _create(
        client,
        token,
        name=f"Finance route {uuid.uuid4().hex[:4]}",
        stages=[
            _manager_stage(
                name="Finance sign-off",
                order=1,
                department_id=finance.id,
                requires_signature=False,  # the server must override this
            )
        ],
    )
    stage = (await _get(client, token, created["id"]))["stages"][0]
    assert stage["department_id"] == str(finance.id)
    assert stage["requires_signature"] is True, "forced on by the department"


# -- Change detection (the edit that was silently discarded) ----------------

async def test_changing_only_the_department_mints_a_new_version(
    client, worker, ops, finance
):
    """The core bug: `_stages_differ()` compared against `workflow_stages`,
    which has no department column, so this edit looked like a no-op and was
    dropped without a word."""
    _w, token = worker
    created = await _create(
        client,
        token,
        name=f"Move department {uuid.uuid4().hex[:4]}",
        stages=[_manager_stage(name="Review", order=1, department_id=ops.id)],
    )
    template_id = created["id"]
    assert await _versions(client, token, template_id) == [1]

    resp = await client.patch(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(token),
        json={
            "stages": [
                _manager_stage(name="Review", order=1, department_id=finance.id)
            ]
        },
    )
    assert resp.status_code == 200, resp.text

    assert await _versions(client, token, template_id) == [1, 2], (
        "a department change is a definition change and must be versioned"
    )
    stage = (await _get(client, token, template_id))["stages"][0]
    assert stage["department_id"] == str(finance.id), "the change must persist"
    assert stage["requires_signature"] is True, (
        "and moving the stage to Finance must pull the signing lock with it"
    )


async def test_changing_only_the_due_within_unit_mints_a_new_version(
    client, worker, ops
):
    """48 hours and 2 days are the same SLA but not the same definition: the
    owner chose words, and `sla_hours` alone cannot tell the two apart."""
    _w, token = worker
    created = await _create(
        client,
        token,
        name=f"Reword deadline {uuid.uuid4().hex[:4]}",
        stages=[
            _manager_stage(
                name="Review",
                order=1,
                department_id=ops.id,
                due_within_value=48,
                due_within_unit="hours",
            )
        ],
    )
    template_id = created["id"]

    resp = await client.patch(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(token),
        json={
            "stages": [
                _manager_stage(
                    name="Review",
                    order=1,
                    department_id=ops.id,
                    due_within_value=2,
                    due_within_unit="days",
                )
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    assert await _versions(client, token, template_id) == [1, 2]

    stage = (await _get(client, token, template_id))["stages"][0]
    assert stage["due_within_value"] == 2
    assert stage["due_within_unit"] == "days"
    assert stage["sla_hours"] == 48


async def test_resending_an_identical_definition_is_still_a_no_op(
    client, worker, ops
):
    """The guard that must not regress: the builder re-sends `stages` on every
    save, so a typo fix in the name must not mint a version (DM-01). This is
    why the comparison normalizes BOTH sides before comparing rather than
    diffing the raw request."""
    _w, token = worker
    created = await _create(
        client,
        token,
        name=f"No churn {uuid.uuid4().hex[:4]}",
        stages=[
            _manager_stage(
                name="Review",
                order=1,
                department_id=ops.id,
                due_within_value=3,
                due_within_unit="days",
            )
        ],
    )
    template_id = created["id"]
    loaded = (await _get(client, token, template_id))["stages"][0]

    # Round-trip exactly what the read returned, which is what the builder does.
    resp = await client.patch(
        f"/api/v1/workflow-templates/{template_id}",
        headers=auth_headers(token),
        json={
            "name": "No churn, renamed",
            "stages": [
                _manager_stage(
                    name=loaded["name"],
                    order=loaded["sequence_order"],
                    department_id=loaded["department_id"],
                    due_within_value=loaded["due_within_value"],
                    due_within_unit=loaded["due_within_unit"],
                )
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "No churn, renamed"
    assert await _versions(client, token, template_id) == [1], (
        "re-sending the definition unchanged must not create a version"
    )


async def test_omitting_the_department_still_adopts_the_approvers_own(
    client, worker, admin, ops, db_session
):
    """WF-STG-22 / O-7: a specific-user stage with no department given takes
    the approver's own. The read must show that resolved value, not a blank -
    otherwise the builder would offer to save it away again."""
    _w, token = worker
    approver, _ = admin
    approver.department_id = ops.id
    db_session.add(approver)
    await db_session.commit()

    created = await _create(
        client,
        token,
        name=f"Inherit dept {uuid.uuid4().hex[:4]}",
        stages=[_stage(approver.id, name="Review", order=1)],
    )
    stage = (await _get(client, token, created["id"]))["stages"][0]
    assert stage["department_id"] == str(ops.id)
    assert stage["department_name"] == "Operations"
