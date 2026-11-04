"""submission details: watchers, reminders, effective/expiry dates, category

Documents module FR-13.4. The submission wizard's Details step is specified
with more fields than the schema can hold today:

  documents.category            Optional grouping, free text chosen from the
                                org's existing values (not a foreign key —
                                the spec treats it as a label, and a lookup
                                table would need its own admin screen).
  documents.effective_from      When the document takes effect. May be after
                                approval, so it is not derivable from dates
                                we already store.
  documents.expires_at          When it stops applying.
  documents.reminder_days_before  Remind watchers and the owner this many days
                                before `expires_at`. NULL = no reminder.
  documents.reminder_sent_at    Set when that reminder goes out, so a daily
                                sweep cannot send it twice.

  document_watchers             People CC'd on a document: they get its
                                notifications but have no approval step and
                                cannot act on it. A join table rather than an
                                array column so each row records WHO added
                                the watcher and when, which the audit trail
                                needs.

ADDITIVE ONLY: five nullable columns on `documents` and one new table. No
existing column is altered, renamed or dropped; no constraint is added to
existing data; no backfill is needed. Every existing document reads as
"no category, no dates, no reminder, no watchers", which is its current
behaviour.

Revision ID: c7d8e9f0a1b2
Revises: f9a0b1c2d3e4
Create Date: 2026-11-01 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'c7d8e9f0a1b2'
down_revision: Union[str, None] = 'f9a0b1c2d3e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('documents', sa.Column('category', sa.String(length=100), nullable=True))
    op.add_column('documents', sa.Column('effective_from', sa.DateTime(timezone=True), nullable=True))
    op.add_column('documents', sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('documents', sa.Column('reminder_days_before', sa.Integer(), nullable=True))
    op.add_column('documents', sa.Column('reminder_sent_at', sa.DateTime(timezone=True), nullable=True))

    # Partial index: the expiry sweep only ever asks for documents that have
    # an expiry date, which is a small minority of rows.
    op.create_index(
        'idx_document_expiry_due',
        'documents',
        ['expires_at'],
        unique=False,
        postgresql_where=sa.text('expires_at IS NOT NULL AND deleted_at IS NULL'),
    )

    op.create_table(
        'document_watchers',
        sa.Column('document_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('added_by', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('id', postgresql.UUID(as_uuid=True), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['added_by'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('document_id', 'user_id', name='uq_document_watcher'),
    )
    op.create_index(op.f('ix_document_watchers_document_id'), 'document_watchers', ['document_id'], unique=False)
    op.create_index(op.f('ix_document_watchers_user_id'), 'document_watchers', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_document_watchers_user_id'), table_name='document_watchers')
    op.drop_index(op.f('ix_document_watchers_document_id'), table_name='document_watchers')
    op.drop_table('document_watchers')
    op.drop_index('idx_document_expiry_due', table_name='documents')
    op.drop_column('documents', 'reminder_sent_at')
    op.drop_column('documents', 'reminder_days_before')
    op.drop_column('documents', 'expires_at')
    op.drop_column('documents', 'effective_from')
    op.drop_column('documents', 'category')
