"""documents_foundation — autosave/optimistic-lock + wizard fields + list indexes

Adds the Documents-module Phase 1 (Foundation) columns to `documents`:
  - source          how the doc was started (TEMPLATE | BLANK | UPLOAD)
  - confidentiality Public | Internal | Confidential (nullable)
  - current_step    resume the wizard/editor at the saved step (nullable)
  - version         optimistic-locking counter for autosave (If-Match / 409)

All four are non-destructive (nullable or server-default), so existing rows
backfill automatically. Also adds two composite indexes for the premium
documents list's common access paths (owner + status + recency; owner + due).

Revision ID: f1a2b3c4d5e6
Revises: e5b2a9d1c3f7
Create Date: 2026-10-27 12:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, None] = 'e5b2a9d1c3f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'documents',
        sa.Column('source', sa.String(length=20), server_default='template', nullable=False),
    )
    op.add_column(
        'documents',
        sa.Column('confidentiality', sa.String(length=20), nullable=True),
    )
    op.add_column(
        'documents',
        sa.Column('current_step', sa.String(length=30), nullable=True),
    )
    op.add_column(
        'documents',
        sa.Column('version', sa.Integer(), server_default='1', nullable=False),
    )

    op.create_index(
        'idx_documents_owner_status_updated',
        'documents',
        ['submitted_by', 'status', 'updated_at'],
        unique=False,
        postgresql_where=sa.text('deleted_at IS NULL'),
    )
    op.create_index(
        'idx_documents_owner_due',
        'documents',
        ['submitted_by', 'due_at'],
        unique=False,
        postgresql_where=sa.text('deleted_at IS NULL'),
    )


def downgrade() -> None:
    op.drop_index('idx_documents_owner_due', table_name='documents')
    op.drop_index('idx_documents_owner_status_updated', table_name='documents')
    op.drop_column('documents', 'version')
    op.drop_column('documents', 'current_step')
    op.drop_column('documents', 'confidentiality')
    op.drop_column('documents', 'source')
