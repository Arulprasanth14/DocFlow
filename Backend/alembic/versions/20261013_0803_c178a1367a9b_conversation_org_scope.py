"""conversation_org_scope

Revision ID: c178a1367a9b
Revises: 6997c3894928
Create Date: 2026-10-13 08:03:09.591363+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c178a1367a9b'
down_revision: Union[str, None] = '6997c3894928'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('conversations', sa.Column('org_id', sa.UUID(), nullable=True))

    # ── Backfill existing rows ──────────────────────────────────────────────
    # Conversations predate this column, so without a backfill every old row
    # would stay NULL and permanently bypass the new tenant filter (which
    # treats NULL as "legacy, fall back to participation"). Two reliable
    # sources, in order of confidence:
    #
    #   1. workflow_context conversations: the workflow instance they are
    #      pinned to already carries the authoritative org_id.
    #   2. direct conversations: the creator's active org membership. Where
    #      a creator somehow belongs to more than one org, the row is left
    #      NULL rather than guessed at — participation still gates access.
    op.execute(
        """
        UPDATE conversations c
           SET org_id = wi.org_id
          FROM workflow_instances wi
         WHERE c.workflow_instance_id = wi.id
           AND c.org_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE conversations c
           SET org_id = m.org_id
          FROM (
                SELECT user_id, MIN(org_id::text)::uuid AS org_id
                  FROM organization_members
                 WHERE deleted_at IS NULL
                 GROUP BY user_id
                HAVING COUNT(DISTINCT org_id) = 1
               ) m
         WHERE c.created_by = m.user_id
           AND c.org_id IS NULL
        """
    )

    op.create_index(op.f('ix_conversations_org_id'), 'conversations', ['org_id'], unique=False)
    op.create_foreign_key(
        'fk_conversations_org_id', 'conversations', 'organizations',
        ['org_id'], ['id'], ondelete='CASCADE',
    )


def downgrade() -> None:
    op.drop_constraint('fk_conversations_org_id', 'conversations', type_='foreignkey')
    op.drop_index(op.f('ix_conversations_org_id'), table_name='conversations')
    op.drop_column('conversations', 'org_id')
