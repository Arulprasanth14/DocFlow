"""template_favourites — per-user favourite templates

Documents module Phase 2. FR-5.3 lists "favourite" as a My Templates action and
FR-2.3 requires a Favourites tab in the hub gallery. Favourites were held in
localStorage, which does not follow the user to another device or browser and
cannot be filtered on in-query.

ADDITIVE ONLY: one new table. Nothing existing is altered; a user with no rows
simply has no favourites.

Revision ID: d5e6f7a8b9c0
Revises: c3d4e5f6a7b8
Create Date: 2026-10-29 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'd5e6f7a8b9c0'
down_revision: Union[str, None] = 'c3d4e5f6a7b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'template_favourites',
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('template_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('id', postgresql.UUID(as_uuid=True), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['template_id'], ['templates.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'template_id', name='uq_template_favourite'),
    )
    op.create_index(op.f('ix_template_favourites_user_id'), 'template_favourites', ['user_id'], unique=False)
    op.create_index(op.f('ix_template_favourites_template_id'), 'template_favourites', ['template_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_template_favourites_template_id'), table_name='template_favourites')
    op.drop_index(op.f('ix_template_favourites_user_id'), table_name='template_favourites')
    op.drop_table('template_favourites')
