"""templates: add nullable dept_id for team scope (FR-5.6)

Additive migration: adds a nullable, indexed `dept_id` foreign key referencing
`departments.id` on `templates`.

Revision ID: f5a6b7c8d9e0
Revises: e3f4a5b6c7d8
Create Date: 2026-11-05 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'f5a6b7c8d9e0'
down_revision: Union[str, None] = 'e3f4a5b6c7d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'templates',
        sa.Column(
            'dept_id',
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey('departments.id', ondelete='SET NULL'),
            nullable=True,
        ),
    )
    op.create_index('ix_templates_dept_id', 'templates', ['dept_id'])


def downgrade() -> None:
    op.drop_index('ix_templates_dept_id', table_name='templates')
    op.drop_column('templates', 'dept_id')

