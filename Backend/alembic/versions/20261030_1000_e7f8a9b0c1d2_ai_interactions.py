"""ai_interactions + per-user AI opt-out

Documents module Phase 3 (AI). Spec §23 governance and FR-10.6:

  - `ai_interactions` records every AI suggestion made to a person, what the
    person then did with it (accepted / rejected / no decision), and the
    model, latency and token counts. It is also the quota source: the daily
    per-user cap is a COUNT over this table, so the quota and the audit
    trail can never drift apart. The document text is NOT stored — only a
    SHA-256 digest of the prompt.
  - `users.ai_opt_out` is the per-user off-switch. The org-level switch lives
    in `organizations.settings->>'ai_enabled'`, which is an existing JSONB
    column and needs no schema change.

ADDITIVE ONLY:
  - one new table (`ai_interactions`) with its indexes;
  - one new nullable-with-default boolean column on `users`.
Nothing existing is altered or dropped. Existing users default to ai_opt_out
= false, i.e. unchanged behaviour.

Revision ID: e7f8a9b0c1d2
Revises: d5e6f7a8b9c0
Create Date: 2026-10-30 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'e7f8a9b0c1d2'
down_revision: Union[str, None] = 'd5e6f7a8b9c0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ai_interactions',
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('feature', sa.String(length=40), nullable=False),
        sa.Column('resource_type', sa.String(length=50), nullable=True),
        sa.Column('resource_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('provider', sa.String(length=40), nullable=True),
        sa.Column('model', sa.String(length=100), nullable=True),
        sa.Column('prompt_digest', sa.String(length=64), nullable=True),
        sa.Column('input_tokens', sa.Integer(), nullable=True),
        sa.Column('output_tokens', sa.Integer(), nullable=True),
        sa.Column('latency_ms', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        # Nullable on purpose: NULL = the person has not decided yet, which is
        # a different thing from a rejection.
        sa.Column('accepted', sa.Boolean(), nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('metadata', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=False),
        sa.Column('id', postgresql.UUID(as_uuid=True), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_ai_interactions_org_id'), 'ai_interactions', ['org_id'], unique=False)
    op.create_index(op.f('ix_ai_interactions_user_id'), 'ai_interactions', ['user_id'], unique=False)
    # The quota lookup: calls by this user since midnight.
    op.create_index('idx_ai_interaction_user_day', 'ai_interactions', ['user_id', 'created_at'], unique=False)
    op.create_index('idx_ai_interaction_org_feature', 'ai_interactions', ['org_id', 'feature', 'created_at'], unique=False)

    # server_default so the column is populated for existing rows without a
    # backfill pass and without a NOT NULL violation mid-deploy.
    op.add_column(
        'users',
        sa.Column('ai_opt_out', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    )


def downgrade() -> None:
    op.drop_column('users', 'ai_opt_out')
    op.drop_index('idx_ai_interaction_org_feature', table_name='ai_interactions')
    op.drop_index('idx_ai_interaction_user_day', table_name='ai_interactions')
    op.drop_index(op.f('ix_ai_interactions_user_id'), table_name='ai_interactions')
    op.drop_index(op.f('ix_ai_interactions_org_id'), table_name='ai_interactions')
    op.drop_table('ai_interactions')
