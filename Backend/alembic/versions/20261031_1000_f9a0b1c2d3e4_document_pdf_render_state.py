"""document_contents: PDF render state for the frozen snapshot (FR-13.8)

The immutable submission snapshot is rendered to PDF asynchronously, so the
submit request stays fast and a renderer failure can never fail a submission.
That needs somewhere to record how the render went:

  - pdf_status      'pending' | 'ready' | 'failed'  (NULL = never requested,
                    which is the correct state for a draft)
  - pdf_checksum    SHA-256 of the PDF bytes, so the artefact can be shown to
                    be the one that was produced from the frozen snapshot
  - pdf_rendered_at when it finished
  - pdf_error       why it failed, for the Retry affordance in the UI

`pdf_url` and `rendered_snapshot_url` already exist on this table and are
reused unchanged.

ADDITIVE ONLY: four new nullable columns on an existing table. No column is
altered, renamed or dropped, no constraint is added, and no backfill is
required — existing rows read as NULL, i.e. "no PDF has been asked for".

Revision ID: f9a0b1c2d3e4
Revises: e7f8a9b0c1d2
Create Date: 2026-10-31 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'f9a0b1c2d3e4'
down_revision: Union[str, None] = 'e7f8a9b0c1d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('document_contents', sa.Column('pdf_status', sa.String(length=20), nullable=True))
    op.add_column('document_contents', sa.Column('pdf_checksum', sa.String(length=64), nullable=True))
    op.add_column('document_contents', sa.Column('pdf_rendered_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('document_contents', sa.Column('pdf_error', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('document_contents', 'pdf_error')
    op.drop_column('document_contents', 'pdf_rendered_at')
    op.drop_column('document_contents', 'pdf_checksum')
    op.drop_column('document_contents', 'pdf_status')
