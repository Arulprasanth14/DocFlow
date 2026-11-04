"""import jobs: AI-assisted conversion of an uploaded document into a template

Documents module FR-9. Importing a DOCX/PDF is a multi-step background job
(extract -> sanitize -> rule detection -> optional LLM detection), so it needs
somewhere to live while it runs and somewhere to hold the result until the
author has reviewed it.

  import_jobs.status        pending | extracting | detecting | ready | failed
                            | cancelled | applied
  import_jobs.stage         the human-readable step the UI shows
                            ("Reading document", "Finding blanks", ...)
  import_jobs.content       the converted editor JSON, already sanitized
  import_jobs.content_hash  SHA-256 of the extracted PLAIN TEXT. FR-9.4
                            requires proof that the AI did not rewrite the
                            document: detections are applied as span
                            replacements and the text outside those spans is
                            re-hashed and compared against this value.
  import_jobs.detections    proposed blanks, each with offsets, key, label,
                            type, confidence and reason (FR-9.3)
  import_jobs.warnings      fidelity warnings for content that could not be
                            represented (text boxes, shapes, ...) (FR-9.7)
  import_jobs.use_llm       whether the author opted in to the LLM pass.
                            FALSE by default: document text is never sent to
                            an external model unless this is explicitly set.

ADDITIVE ONLY: one new table. No existing table, column, index or constraint
is touched, and nothing needs backfilling. Until this migration is applied the
import feature reports itself unavailable; every other feature is unaffected.

Revision ID: d1e2f3a4b5c6
Revises: c7d8e9f0a1b2
Create Date: 2026-11-03 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'd1e2f3a4b5c6'
down_revision: Union[str, None] = 'c7d8e9f0a1b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'import_jobs',
        sa.Column('id', postgresql.UUID(as_uuid=True), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=False),
        # Set once the author applies the job and a template is created.
        sa.Column('template_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('file_asset_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('filename', sa.String(length=500), nullable=False),
        sa.Column('mime_type', sa.String(length=255), nullable=True),
        sa.Column('source_kind', sa.String(length=20), nullable=False, server_default='docx'),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='pending'),
        sa.Column('stage', sa.String(length=80), nullable=True),
        sa.Column('progress', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('use_llm', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('page_count', sa.Integer(), nullable=True),
        sa.Column('char_count', sa.Integer(), nullable=True),
        sa.Column('content', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('content_hash', sa.String(length=64), nullable=True),
        sa.Column('detections', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('warnings', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
        sa.ForeignKeyConstraint(['template_id'], ['templates.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['file_asset_id'], ['file_assets.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    # The only access path: "my imports in this org, newest first".
    op.create_index(
        'idx_import_job_owner',
        'import_jobs',
        ['org_id', 'created_by', 'created_at'],
        unique=False,
        postgresql_where=sa.text('deleted_at IS NULL'),
    )


def downgrade() -> None:
    op.drop_index('idx_import_job_owner', table_name='import_jobs')
    op.drop_table('import_jobs')
