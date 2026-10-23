"""org_extended_profile

Add industry, timezone, branding_primary_color, branding_accent_color, and
notification_defaults to the organizations table.

Revision ID: a1b2c3d4e5f6
Revises: 9b2764c55695
Create Date: 2026-09-26 18:00:00.000000+00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "9b2764c55695"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "organizations",
        sa.Column("industry", sa.String(length=100), nullable=True),
    )
    op.add_column(
        "organizations",
        sa.Column(
            "timezone",
            sa.String(length=100),
            nullable=True,
            server_default="UTC",
        ),
    )
    op.add_column(
        "organizations",
        sa.Column("branding_primary_color", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "organizations",
        sa.Column("branding_accent_color", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "organizations",
        sa.Column("notification_defaults", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("organizations", "notification_defaults")
    op.drop_column("organizations", "branding_accent_color")
    op.drop_column("organizations", "branding_primary_color")
    op.drop_column("organizations", "timezone")
    op.drop_column("organizations", "industry")
