"""document_template_version_pin — pin a document to the template version it used

Documents module, Phase 2 (Form Fill). Spec conflict C9 / FR-11.5: a document
created from a template must stay bound to the exact TemplateVersion it was
built from, so later edits to the template never silently change it.

ADDITIVE ONLY: one nullable FK column on `documents` plus a partial index.
Existing rows get NULL (they predate templates) and are unaffected.

Revision ID: b1c2d3e4f5a6
Revises: a7b8c9d0e1f2
Create Date: 2026-10-28 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, None] = 'a7b8c9d0e1f2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'documents',
        sa.Column('template_version_id', postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        'fk_documents_template_version',
        'documents', 'template_versions',
        ['template_version_id'], ['id'],
        ondelete='SET NULL',
    )
    op.create_index(
        'idx_documents_template_version',
        'documents',
        ['template_version_id'],
        unique=False,
        postgresql_where=sa.text('template_version_id IS NOT NULL'),
    )


def downgrade() -> None:
    op.drop_index('idx_documents_template_version', table_name='documents')
    op.drop_constraint('fk_documents_template_version', 'documents', type_='foreignkey')
    op.drop_column('documents', 'template_version_id')
