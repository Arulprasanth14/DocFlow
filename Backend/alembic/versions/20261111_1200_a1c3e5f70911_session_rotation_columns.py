"""session rotation columns (Auth/RBAC Gap #5)

Adds the columns refresh-token rotation needs, plus the org binding the spec's
data model assumed the sessions table already had:

    family_id      all sessions descended from one login
    rotated_at     when this session was replaced (NULL = current)
    replaced_by    the session that replaced it
    revoked_reason logout | deactivate | role_change | removal | theft | admin
    last_used_at   last time this session was presented
    org_id         the organization the token was minted for

All additive and nullable, so the migration is safe to run before the code
that uses them and reversible without data loss.

Backfill: every existing session becomes its own one-row family
(family_id = id), which is exactly what it is - it was issued at a login and
has never been rotated. `org_id` is deliberately left NULL for existing rows:
the organization a live token was minted for cannot be recovered reliably
afterwards (a user's primary membership may have changed since), and binding
on a guessed value would reject legitimate tokens. Sessions created after this
deploy carry it.

Revision ID: a1c3e5f70911
Revises: be00d80b64b3
Create Date: 2026-11-11 12:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a1c3e5f70911"
down_revision: Union[str, None] = "be00d80b64b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("family_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "sessions", sa.Column("rotated_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "sessions",
        sa.Column("replaced_by", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "sessions", sa.Column("revoked_reason", sa.String(length=50), nullable=True)
    )
    op.add_column(
        "sessions", sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True)
    )

    # Existing rows: each is its own family. Done before the index so the
    # index is built once, on populated data.
    op.execute("UPDATE sessions SET family_id = id WHERE family_id IS NULL")

    op.create_index("ix_sessions_family_id", "sessions", ["family_id"])
    # Revocation sweeps and the nightly cleanup both filter on expiry.
    op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"])
    op.create_foreign_key(
        "fk_sessions_org_id", "sessions", "organizations", ["org_id"], ["id"]
    )


def downgrade() -> None:
    op.drop_constraint("fk_sessions_org_id", "sessions", type_="foreignkey")
    op.drop_index("ix_sessions_expires_at", table_name="sessions")
    op.drop_index("ix_sessions_family_id", table_name="sessions")
    op.drop_column("sessions", "last_used_at")
    op.drop_column("sessions", "revoked_reason")
    op.drop_column("sessions", "replaced_by")
    op.drop_column("sessions", "rotated_at")
    op.drop_column("sessions", "org_id")
    op.drop_column("sessions", "family_id")
