"""document_contents — editable body for freeform (blank) documents

Documents module. Spec §9 defines a DocumentContent entity; until now a document
had nowhere to keep rich-text body content, so the "Blank document" flow had no
authoring surface to save into (conflict C12: a blank document opens the
Word-like editor in freeform mode).

ADDITIVE ONLY: one new table. Nothing existing is altered; documents without a
row simply have no body yet.

Revision ID: c3d4e5f6a7b8
Revises: b1c2d3e4f5a6
Create Date: 2026-10-28 14:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'document_contents',
        sa.Column('document_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('content', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=True),
        sa.Column('answers', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=True),
        sa.Column('rendered_snapshot_url', sa.Text(), nullable=True),
        sa.Column('pdf_url', sa.Text(), nullable=True),
        sa.Column('id', postgresql.UUID(as_uuid=True), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('document_id', name='uq_document_content_doc'),
    )
    op.create_index('ix_document_contents_document_id', 'document_contents', ['document_id'])


def downgrade() -> None:
    op.drop_index('ix_document_contents_document_id', table_name='document_contents')
    op.drop_table('document_contents')
