"""migrate_legacy_roles_to_four_roles

Organizations created before the 4-role model (admin / hr / worker / trainee)
were seeded with the old vocabulary (super_admin, org_admin, dept_manager,
approver, submitter, viewer, employee, intern). Backend and frontend now
authorize purely on the new names, so without this an existing organization's
administrator is no longer recognised as an admin and silently loses every
admin screen and endpoint.

For every organization this migration:
  1. ensures the global permission catalog contains every current code,
  2. ensures the 4 system roles exist with EXACTLY the current permission set
     (re-syncing a pre-existing `admin` role that still carries the old set),
  3. remaps every member of a legacy role onto the closest new role,
  4. removes the now-empty legacy roles.

Mapping (least-privilege where the old role has no exact equivalent):
  super_admin, org_admin, admin  -> admin
  dept_manager                   -> hr
  approver, submitter, employee,
  any custom role                -> worker
  viewer, intern                 -> trainee

Idempotent: re-running it on already-migrated data changes nothing.

Revision ID: d4a1f0c2b7e9
Revises: c178a1367a9b
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4a1f0c2b7e9"
down_revision: Union[str, None] = "c178a1367a9b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

LEGACY_TO_NEW = {
    "super_admin": "admin",
    "org_admin": "admin",
    "admin": "admin",
    "dept_manager": "hr",
    "approver": "worker",
    "submitter": "worker",
    "employee": "worker",
    "viewer": "trainee",
    "intern": "trainee",
}
NEW_ROLES = ("admin", "hr", "worker", "trainee")


def upgrade() -> None:
    from app.domain.enums import SYSTEM_ROLES

    bind = op.get_bind()

    # 1. Permission catalog
    codes = {str(p) for r in SYSTEM_ROLES.values() for p in r["permissions"]}
    for code in sorted(codes):
        bind.execute(
            sa.text(
                "INSERT INTO permissions (code, category) VALUES (:c, :cat) "
                "ON CONFLICT (code) DO NOTHING"
            ),
            {"c": code, "cat": code.split(":")[0]},
        )

    org_ids = [r[0] for r in bind.execute(sa.text("SELECT id FROM organizations"))]
    for org_id in org_ids:
        # 2. Ensure the 4 system roles and their exact permission sets.
        role_ids: dict[str, object] = {}
        for name in NEW_ROLES:
            definition = SYSTEM_ROLES[name]
            row = bind.execute(
                sa.text(
                    "SELECT id FROM roles WHERE org_id = :o AND name = :n "
                    "AND deleted_at IS NULL"
                ),
                {"o": org_id, "n": name},
            ).first()
            if row:
                rid = row[0]
                bind.execute(
                    sa.text(
                        "UPDATE roles SET is_system = true, description = :d WHERE id = :r"
                    ),
                    {"d": definition["description"], "r": rid},
                )
            else:
                rid = bind.execute(
                    sa.text(
                        "INSERT INTO roles (org_id, name, description, is_system) "
                        "VALUES (:o, :n, :d, true) RETURNING id"
                    ),
                    {"o": org_id, "n": name, "d": definition["description"]},
                ).scalar_one()
            role_ids[name] = rid

            want = {str(p) for p in definition["permissions"]}
            have = {
                r[0]
                for r in bind.execute(
                    sa.text("SELECT permission_code FROM role_permissions WHERE role_id = :r"),
                    {"r": rid},
                )
            }
            for code in sorted(want - have):
                bind.execute(
                    sa.text(
                        "INSERT INTO role_permissions (role_id, permission_code) VALUES (:r, :c)"
                    ),
                    {"r": rid, "c": code},
                )
            for code in sorted(have - want):
                bind.execute(
                    sa.text(
                        "DELETE FROM role_permissions WHERE role_id = :r AND permission_code = :c"
                    ),
                    {"r": rid, "c": code},
                )

        # 3. Remap members of every non-new role, then 4. drop those roles.
        legacy = bind.execute(
            sa.text(
                "SELECT id, name FROM roles WHERE org_id = :o AND deleted_at IS NULL "
                "AND name <> ALL(:keep)"
            ),
            {"o": org_id, "keep": list(NEW_ROLES)},
        ).all()
        for legacy_id, legacy_name in legacy:
            target = role_ids[LEGACY_TO_NEW.get(legacy_name, "worker")]
            bind.execute(
                sa.text("UPDATE organization_members SET role_id = :t WHERE role_id = :l"),
                {"t": target, "l": legacy_id},
            )
            bind.execute(sa.text("DELETE FROM roles WHERE id = :l"), {"l": legacy_id})


def downgrade() -> None:
    # Irreversible by design: the legacy role vocabulary no longer exists in
    # code, and the old role of each remapped member is not recorded.
    pass
