"""document summaries, and an org-level switch for them

Workflow module section 6.4.3 (AP-SUM-01..13), section 6.4.4. Tasks P4-1..P4-3.

Additive only: one new table, one new column with a safe default, and their
indexes. Nothing is dropped, renamed or made NOT NULL.

Keyed on the SHA-256 of the rendered text, not on the version id. Two things
fall out of that, both wanted:

  * AP-SUM-07 caching is free. Re-submitting the same bytes, or a second
    approver opening the same version, reuses one summary instead of paying
    for another generation.
  * A summary can never be served for content it was not generated from. If
    the rendition is rebuilt and the text changes, the hash changes and the
    old row simply stops matching.

Revision ID: be00d80b64b3
Revises: 4531ffafc966
Create Date: 2026-11-10 12:00:00
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = 'be00d80b64b3'
down_revision = '4531ffafc966'
branch_labels = None
depends_on = None


SUMMARY_STATUSES = ('pending', 'ready', 'failed', 'unavailable')


def _sql_list(values) -> str:
    return ", ".join(f"'{v}'" for v in values)


def upgrade() -> None:
    op.create_table(
        'document_summaries',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        # The version that caused this summary. Kept for audit and for the
        # approver's view; the HASH is what makes it reusable.
        sa.Column('document_version_id', postgresql.UUID(as_uuid=True),
                  nullable=False),
        # SHA-256 of the extracted text the summary was generated from.
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False,
                  server_default='pending'),
        # The validated, grounded blocks (AP-SUM-02a..e). JSONB rather than
        # prose so the UI can render page citations as links and show which
        # claims failed grounding.
        sa.Column('content', postgresql.JSONB(), nullable=True),
        sa.Column('model', sa.String(length=120), nullable=True),
        sa.Column('provider', sa.String(length=40), nullable=True),
        sa.Column('page_count', sa.Integer(), nullable=True),
        sa.Column('generated_at', sa.DateTime(timezone=True), nullable=True),
        # A short machine code plus a sentence for the approver. Never the
        # provider's raw error and never any document text (AP-SUM-13).
        sa.Column('error_code', sa.String(length=40), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['document_version_id'],
                                ['document_versions.id'], ondelete='CASCADE'),
        sa.CheckConstraint(f"status IN ({_sql_list(SUMMARY_STATUSES)})",
                           name='ck_summary_status'),
    )
    # One summary per distinct text, per org. Scoped by org as well as hash so
    # two organizations that happen to submit identical content never share a
    # row - BR-12, and a cache hit across a tenant boundary would be a leak.
    op.create_index('uq_summary_sha_org', 'document_summaries',
                    ['org_id', 'sha256'], unique=True,
                    postgresql_where=sa.text('deleted_at IS NULL'))
    op.create_index('idx_summary_version', 'document_summaries',
                    ['document_version_id'])

    # AP-SUM-10 / E29: an organization can turn summaries off entirely.
    # Defaults to TRUE so behaviour does not change silently for anyone
    # already using the module; an org that wants it off sets it off.
    op.add_column(
        'organizations',
        sa.Column('ai_summaries_enabled', sa.Boolean(), nullable=False,
                  server_default=sa.text('true')),
    )


def downgrade() -> None:
    op.drop_column('organizations', 'ai_summaries_enabled')
    op.drop_index('idx_summary_version', table_name='document_summaries')
    op.drop_index('uq_summary_sha_org', table_name='document_summaries')
    op.drop_table('document_summaries')
