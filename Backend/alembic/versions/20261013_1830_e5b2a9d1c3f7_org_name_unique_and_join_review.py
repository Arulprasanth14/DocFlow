"""org_name_unique_and_join_review

1. Organization names become unique case-insensitively among live
   organizations (partial unique index on lower(name)). Before this nothing
   stopped two organizations sharing a name, which made "join an existing
   organization by name" ambiguous.
   Existing duplicates (none in the dev database at the time of writing) would
   make the index creation fail, so they are renamed first - deterministically,
   keeping the OLDEST organization's name and suffixing the others.

2. organization_members gains reviewed_by / reviewed_at, recording who
   accepted or rejected a join request and when.

Revision ID: e5b2a9d1c3f7
Revises: d4a1f0c2b7e9
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5b2a9d1c3f7"
down_revision: Union[str, None] = "d4a1f0c2b7e9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()

    # De-duplicate names (case-insensitive) so the unique index can be built.
    dupes = bind.execute(
        sa.text(
            "SELECT lower(name) FROM organizations WHERE deleted_at IS NULL "
            "GROUP BY lower(name) HAVING count(*) > 1"
        )
    ).all()
    for (lname,) in dupes:
        rows = bind.execute(
            sa.text(
                "SELECT id, name FROM organizations WHERE deleted_at IS NULL "
                "AND lower(name) = :n ORDER BY created_at, id"
            ),
            {"n": lname},
        ).all()
        for i, (oid, name) in enumerate(rows[1:], start=2):
            bind.execute(
                sa.text("UPDATE organizations SET name = :new WHERE id = :id"),
                {"new": f"{name} ({i})", "id": oid},
            )

    op.create_index(
        "uq_organizations_name_lower",
        "organizations",
        [sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )

    op.add_column(
        "organization_members",
        sa.Column("reviewed_by", sa.UUID(), nullable=True),
    )
    op.add_column(
        "organization_members",
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_org_members_reviewed_by", "organization_members", "users",
        ["reviewed_by"], ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_org_members_reviewed_by", "organization_members", type_="foreignkey")
    op.drop_column("organization_members", "reviewed_at")
    op.drop_column("organization_members", "reviewed_by")
    op.drop_index("uq_organizations_name_lower", table_name="organizations")
