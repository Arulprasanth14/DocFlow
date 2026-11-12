"""
Auth hardening — Phase E: the role x endpoint matrix.

Two snapshots, both committed, both derived from CURRENT behaviour (not from
the spec - the spec's table is diffed separately and its three disagreements
are a decision, not a bug):

  1. `role_permissions.json` - what a freshly created organization actually
     seeds per role. The spec's section 5.3 table can no longer drift from the
     database without this test going red.
  2. `route_matrix.json` - the status every actor gets from every
     parameterless GET route. This is the regression net for Phases A-D and
     for anything later that touches a guard.

Regenerate deliberately, never casually:

    REGEN_RBAC=1 python -m pytest tests/test_rbac_matrix.py

A diff in CI means somebody changed who can reach what. That is sometimes
correct - then the regenerated fixture IS the review artefact.

Scope limits, stated so nobody over-trusts this file: only GET routes with no
path parameters are exercised, because driving every mutating route for every
actor needs per-route fixtures and would not be a snapshot any more. /api/v1/ai
and /api/v1/agent are skipped - they reach external providers.
"""
from __future__ import annotations

import json
import os
import pathlib

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import select

from app.domain.enums import SYSTEM_ROLES
from app.main import app
from app.models.organization import Role, RolePermission
from app.repositories.org_repo import OrganizationRepository
from conftest import _make_member, auth_headers

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
REGEN = os.environ.get("REGEN_RBAC") == "1"

SKIP_PREFIXES = ("/api/v1/ai", "/api/v1/agent", "/health", "/metrics")


def _load(name: str) -> dict:
    path = FIXTURES / name
    if not path.exists():
        pytest.fail(
            f"{path} is missing. Create it deliberately with "
            f"REGEN_RBAC=1 python -m pytest tests/test_rbac_matrix.py"
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _save(name: str, payload: dict) -> None:
    FIXTURES.mkdir(exist_ok=True)
    (FIXTURES / name).write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _probe_routes() -> list[str]:
    paths = set()
    for route in app.routes:
        if not isinstance(route, APIRoute) or "GET" not in (route.methods or set()):
            continue
        if "{" in route.path or route.path.startswith(SKIP_PREFIXES):
            continue
        paths.add(route.path)
    return sorted(paths)


# ── 1. what the four roles really get ───────────────────────────────────────

async def test_role_permission_seed_matches_the_committed_matrix(db_session, org):
    """Reads the DB, not SYSTEM_ROLES: the seed is the runtime source of truth
    and changing the constant does not change an existing organization."""
    rows = await db_session.execute(
        select(Role.name, RolePermission.permission_code)
        .join(RolePermission, RolePermission.role_id == Role.id)
        .where(Role.org_id == org.id)
    )
    actual: dict[str, list[str]] = {}
    for role_name, code in rows.all():
        actual.setdefault(role_name, []).append(code)
    actual = {role: sorted(codes) for role, codes in sorted(actual.items())}

    if REGEN:
        _save("role_permissions.json", actual)
        pytest.skip("regenerated role_permissions.json")

    assert actual == _load("role_permissions.json"), (
        "The seeded role -> permission matrix changed. If that was intended, "
        "regenerate the fixture and make the diff part of the review."
    )


def test_the_seed_constant_and_the_four_roles_still_agree():
    assert set(SYSTEM_ROLES) == {"admin", "hr", "worker", "trainee"}


# ── 2. actor x endpoint ─────────────────────────────────────────────────────

async def test_route_matrix_matches_the_committed_snapshot(
    client, db_session, org, roles, admin, hr, worker, trainee
):
    other_org = await OrganizationRepository(db_session).create(
        name=f"Other Org {org.id.hex[:6]}"
    )
    await OrganizationRepository(db_session).create_default_roles(other_org.id)
    await db_session.commit()
    other_roles = (
        await db_session.execute(select(Role).where(Role.org_id == other_org.id))
    ).scalars().all()
    other_admin_role = next(r for r in other_roles if r.name == "admin")
    _, other_admin_token = await _make_member(
        db_session, other_org, other_admin_role, name="Other Org Admin"
    )

    actors: dict[str, str | None] = {
        "unauthenticated": None,
        "trainee": trainee[1],
        "worker": worker[1],
        "hr": hr[1],
        "admin": admin[1],
        "other_org_admin": other_admin_token,
    }

    actual: dict[str, dict[str, int]] = {}
    for path in _probe_routes():
        actual[path] = {}
        for actor, token in actors.items():
            headers = auth_headers(token) if token else {}
            response = await client.get(path, headers=headers)
            actual[path][actor] = response.status_code

    if REGEN:
        _save("route_matrix.json", actual)
        pytest.skip("regenerated route_matrix.json")

    expected = _load("route_matrix.json")

    missing = sorted(set(actual) - set(expected))
    assert not missing, (
        "New GET route(s) with no matrix entry: " + ", ".join(missing) +
        ". Regenerate the fixture so the expected statuses are reviewed."
    )
    removed = sorted(set(expected) - set(actual))
    assert not removed, "Route(s) in the matrix no longer registered: " + ", ".join(removed)

    drift = [
        f"{path} {actor}: {expected[path][actor]} -> {status}"
        for path, by_actor in actual.items()
        for actor, status in by_actor.items()
        if expected[path].get(actor) != status
    ]
    assert not drift, "Authorization behaviour changed:\n  " + "\n  ".join(drift)


async def test_unauthenticated_callers_are_rejected_everywhere(client):
    """Independent of the snapshot: a 200 here is a hole, whatever the
    fixture happens to record."""
    public = {"/api/v1/auth/refresh", "/api/v1/auth/logout"}
    leaks = []
    for path in _probe_routes():
        if path in public:
            continue
        response = await client.get(path)
        if response.status_code == 200:
            leaks.append(path)
    assert not leaks, "Reachable without a token: " + ", ".join(leaks)
