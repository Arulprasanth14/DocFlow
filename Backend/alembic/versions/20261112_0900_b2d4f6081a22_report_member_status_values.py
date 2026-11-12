"""report organization_members.status values outside the known set (Gap #13)

REPORT ONLY. This migration changes nothing: no UPDATE, no CHECK constraint,
no enum type. It prints what is there so a human decides what to do about it.

Why report instead of constrain: `organization_members.status` is a VARCHAR
that accepted any string for as long as the API has existed, so production may
hold typos ("actve") that make a member invisible to every status-filtered
query. A CHECK constraint added blind would fail the migration on exactly the
data it was meant to find, during a deploy. Validation now happens in the
service layer (422 on an unknown value), and this tells you whether anything
needs cleaning up first.

Known set: active, pending, inactive, rejected, suspended
(app.domain.enums.MemberStatus).

Revision ID: b2d4f6081a22
Revises: a1c3e5f70911
Create Date: 2026-11-12 09:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b2d4f6081a22"
down_revision: Union[str, None] = "a1c3e5f70911"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: Kept as a literal rather than imported from app.domain.enums: a migration
#: must describe the schema at ITS point in history, not follow a constant
#: that may change later.
KNOWN_STATUSES = ("active", "pending", "inactive", "rejected", "suspended")


def upgrade() -> None:
    bind = op.get_bind()

    summary = bind.execute(
        sa.text(
            """
            SELECT status, COUNT(*) AS rows
            FROM organization_members
            GROUP BY status
            ORDER BY rows DESC
            """
        )
    ).fetchall()

    print("\n[member-status report] value distribution:")
    for row in summary:
        known = "known" if row.status in KNOWN_STATUSES else "UNKNOWN"
        print(f"  {str(row.status)!r:<16} {row.rows:>8}  ({known})")

    offenders = bind.execute(
        sa.text(
            """
            SELECT m.id, m.org_id, m.user_id, m.status, m.joined_at
            FROM organization_members m
            WHERE m.status IS NULL OR m.status <> ALL(:known)
            ORDER BY m.joined_at
            """
        ),
        {"known": list(KNOWN_STATUSES)},
    ).fetchall()

    if not offenders:
        print("[member-status report] no rows outside the known set. Nothing to do.\n")
        return

    print(f"\n[member-status report] {len(offenders)} row(s) OUTSIDE the known set:")
    print("  member_id                             org_id                                status")
    for row in offenders:
        print(f"  {row.id}  {row.org_id}  {str(row.status)!r}")
    print(
        "\n[member-status report] Nothing was changed. These members are "
        "invisible to status-filtered queries. Decide a target value for each "
        "and apply it deliberately.\n"
    )


def downgrade() -> None:
    """Nothing to undo: this migration only read and printed."""
