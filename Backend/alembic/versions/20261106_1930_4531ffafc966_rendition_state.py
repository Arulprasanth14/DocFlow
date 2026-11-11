"""document_versions: rendition state for the review viewer

Workflow module section 6.4.1, WF-REV-09, E15. Task P3-3.

The viewer renders PDF and nothing else (AP-VWR-01), so a .docx has to be
converted once and the PDF kept. `rendition_file_id` (migration
31df6df708f0) says WHERE that PDF is; these columns say what happened while
producing it.

Without a status column, "not converted yet" and "conversion failed" are
both NULL, and the review screen can only show a spinner forever. Section
6.4.1 asks for a conversion-failure state precisely so a failure is
reportable: an approver should be told the file could not be prepared, and by
whom it can be fixed, rather than waiting on something that is never coming.

Additive only: three new nullable columns and one partial index. Nothing is
dropped, renamed, or made NOT NULL, and NULL is the correct reading for every
existing row - no rendition has ever been attempted for any of them.

Revision ID: 4531ffafc966
Revises: 31df6df708f0
Create Date: 2026-11-06 19:30:00
"""
from alembic import op
import sqlalchemy as sa


revision = '4531ffafc966'
down_revision = '31df6df708f0'
branch_labels = None
depends_on = None


# 'not_needed' is a real state, not an absence: a document uploaded as a PDF
# is its own rendition, and recording that explicitly stops the worker
# re-examining it on every sweep.
RENDITION_STATUSES = ('pending', 'ready', 'failed', 'not_needed')


def _sql_list(values) -> str:
    return ", ".join(f"'{v}'" for v in values)


def upgrade() -> None:
    op.add_column('document_versions',
                  sa.Column('rendition_status', sa.String(length=20),
                            nullable=True))
    # The message an approver and the owner actually read. Kept on the row
    # rather than only in logs: the person who can fix a password-protected
    # file is the owner, and they will never see a worker log line.
    op.add_column('document_versions',
                  sa.Column('rendition_error', sa.Text(), nullable=True))
    # The viewer needs the count to virtualise pages before it has parsed the
    # file, and AP-SUM-08 caps summarisation at 300 pages.
    op.add_column('document_versions',
                  sa.Column('rendition_page_count', sa.Integer(), nullable=True))

    op.create_check_constraint(
        'ck_dv_rendition_status',
        'document_versions',
        f"rendition_status IS NULL OR rendition_status IN "
        f"({_sql_list(RENDITION_STATUSES)})",
    )
    # The worker's only query: versions still waiting to be rendered. Partial,
    # so it stays small as finished rows accumulate.
    op.create_index(
        'idx_dv_rendition_pending', 'document_versions', ['rendition_status'],
        postgresql_where=sa.text("rendition_status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index('idx_dv_rendition_pending', table_name='document_versions')
    op.drop_constraint('ck_dv_rendition_status', 'document_versions',
                       type_='check')
    op.drop_column('document_versions', 'rendition_page_count')
    op.drop_column('document_versions', 'rendition_error')
    op.drop_column('document_versions', 'rendition_status')
