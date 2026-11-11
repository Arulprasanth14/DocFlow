"""annotations, annotation replies, and document-version rendition/revision columns

Workflow module section 6.5 (AP-ANN-01..11, 20..23), section 6.4.1,
section 5.10 (WF-REV-08). Task P3-2.

Additive only. Two new tables, three new nullable columns on
`document_versions`, and their indexes. Nothing is dropped, renamed or
rewritten, and no existing row changes: every new column is NULL for every
row that already exists, which is the correct reading for all of them (a
version uploaded before this migration answered no review round, and its
rendition had not been built).

Revision ID: 31df6df708f0
Revises: e1f2a3b4c5d6
Create Date: 2026-11-06 18:00:00
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = '31df6df708f0'
down_revision = 'e1f2a3b4c5d6'
branch_labels = None
depends_on = None


# Section 6.5.2 / 6.11. Kept as literal strings in the CHECK constraints so a
# later addition to the Python tuple cannot silently diverge from what the
# database enforces - the constraint is the guarantee, the tuple is a
# convenience.
ANCHOR_TYPES = ('text', 'area')
ANNOTATION_STATUSES = ('draft', 'open', 'addressed', 'resolved')


def _sql_list(values) -> str:
    """Render a tuple as a SQL IN list.

    Not `repr(tuple)`: a one-element tuple reprs with a trailing comma, which
    is a syntax error in SQL.
    """
    return ", ".join(f"'{v}'" for v in values)


def _base_cols():
    """The BaseModel timestamp columns.

    Built fresh on each call rather than held in a module constant: a Column
    object binds to the first table it is given to, so reusing one instance
    across create_table() calls fails.
    """
    return [
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    ]


def upgrade() -> None:
    # ── 1. Annotations (section 6.5.2) ──────────────────────────────────────
    op.create_table(
        'annotations',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        # Nullable: a draft can exist before the round it will be published in
        # is opened, and a carried-over annotation belongs to the round it was
        # MADE in. The service requires a round before publishing.
        sa.Column('review_round_id', postgresql.UUID(as_uuid=True), nullable=True),
        # The anchor target is always a VERSION, never the document: versions
        # are immutable, so an anchor to one cannot drift onto text that is no
        # longer there.
        sa.Column('document_version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('author_id', postgresql.UUID(as_uuid=True), nullable=False),

        sa.Column('anchor_type', sa.String(length=10), nullable=False,
                  server_default='text'),
        # 1-based, matching the viewer and every page label in the UI.
        sa.Column('page_number', sa.Integer(), nullable=False),
        # A list of {x, y, w, h}, each 0..1 of the UNROTATED page. Fractions
        # rather than pixels so an anchor survives zoom, rotation and a
        # different screen; a list rather than one rect because a selection
        # spanning lines is several rectangles, and highlighting the bounding
        # box would cover text the approver did not select.
        sa.Column('rects', postgresql.JSONB(), nullable=False,
                  server_default=sa.text("'[]'::jsonb")),

        # The quote plus its surrounding context. This is what makes
        # carry-over to a later version possible at all (AP-ANN-22): without
        # the context, a phrase occurring twice on a page cannot be placed.
        sa.Column('selected_text', sa.String(length=1000), nullable=True),
        sa.Column('text_prefix', sa.String(length=30), nullable=True),
        sa.Column('text_suffix', sa.String(length=30), nullable=True),

        sa.Column('color', sa.String(length=20), nullable=True),
        sa.Column('category', sa.String(length=40), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False,
                  server_default='draft'),
        sa.Column('comment_text', sa.Text(), nullable=True),
        # Set once, when the approver requests changes. Until then the row is
        # a draft and only its author can see it (AP-ANN-05).
        sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),

        # AP-ANN-22 / E17 / E30. `relocated = false` is what the UI shows as
        # "Location changed", which section 6.5.2 treats as a correct outcome
        # rather than a failure.
        sa.Column('carried_from_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('relocated', sa.Boolean(), nullable=True),

        *_base_cols(),

        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['review_round_id'], ['review_rounds.id']),
        sa.ForeignKeyConstraint(['document_version_id'], ['document_versions.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['author_id'], ['users.id']),
        sa.ForeignKeyConstraint(['carried_from_id'], ['annotations.id']),

        sa.CheckConstraint(f"anchor_type IN ({_sql_list(ANCHOR_TYPES)})",
                           name='ck_annotation_anchor_type'),
        sa.CheckConstraint(f"status IN ({_sql_list(ANNOTATION_STATUSES)})",
                           name='ck_annotation_status'),
        sa.CheckConstraint('page_number >= 1', name='ck_annotation_page'),
        # A published annotation must say something; a draft need not, because
        # the approver may anchor first and type afterwards.
        sa.CheckConstraint("status = 'draft' OR comment_text IS NOT NULL",
                           name='ck_annotation_published_has_text'),
    )
    # The comments panel's only query: everything on this version, by page.
    # Has to stay fast at 500+ comments (AP-ANN-10, E24).
    op.create_index('idx_annotation_version_page', 'annotations',
                    ['document_version_id', 'page_number'])
    op.create_index('idx_annotation_round', 'annotations', ['review_round_id'])
    # Partial: an approver's own unpublished drafts — the lookup on every
    # autosave and every load of the review screen.
    op.create_index(
        'idx_annotation_author_drafts', 'annotations',
        ['author_id', 'document_version_id'],
        postgresql_where=sa.text("status = 'draft' AND deleted_at IS NULL"),
    )

    # ── 2. Annotation replies (AP-ANN-09, BR-09) ────────────────────────────
    op.create_table(
        'annotation_replies',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('annotation_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('author_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        *_base_cols(),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['annotation_id'], ['annotations.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['author_id'], ['users.id']),
        # A blank reply is not a reply. Checked here as well as in the service
        # because this table is append-only and a blank row could never be
        # tidied up afterwards.
        sa.CheckConstraint('length(btrim(body)) > 0', name='ck_reply_not_blank'),
    )
    op.create_index('idx_reply_annotation_created', 'annotation_replies',
                    ['annotation_id', 'created_at'])

    # ── 3. document_versions: rendition and revision context ────────────────
    #
    # All three are nullable, and NULL is the correct reading for every
    # existing row: a version uploaded before this migration answered no
    # review round, and its PDF rendition had not been built.
    op.add_column('document_versions',
                  sa.Column('rendition_file_id', postgresql.UUID(as_uuid=True),
                            nullable=True))
    op.add_column('document_versions',
                  sa.Column('reason', sa.String(length=20), nullable=True))
    op.add_column('document_versions',
                  sa.Column('responds_to_round_id', postgresql.UUID(as_uuid=True),
                            nullable=True))
    op.create_foreign_key('fk_dv_rendition_file', 'document_versions',
                          'file_assets', ['rendition_file_id'], ['id'])
    op.create_foreign_key('fk_dv_responds_to_round', 'document_versions',
                          'review_rounds', ['responds_to_round_id'], ['id'])
    # The owner's feedback view asks "which version answered this round?".
    op.create_index('idx_dv_responds_to_round', 'document_versions',
                    ['responds_to_round_id'],
                    postgresql_where=sa.text('responds_to_round_id IS NOT NULL'))


def downgrade() -> None:
    op.drop_index('idx_dv_responds_to_round', table_name='document_versions')
    op.drop_constraint('fk_dv_responds_to_round', 'document_versions',
                       type_='foreignkey')
    op.drop_constraint('fk_dv_rendition_file', 'document_versions',
                       type_='foreignkey')
    op.drop_column('document_versions', 'responds_to_round_id')
    op.drop_column('document_versions', 'reason')
    op.drop_column('document_versions', 'rendition_file_id')

    op.drop_index('idx_reply_annotation_created', table_name='annotation_replies')
    op.drop_table('annotation_replies')

    op.drop_index('idx_annotation_author_drafts', table_name='annotations')
    op.drop_index('idx_annotation_round', table_name='annotations')
    op.drop_index('idx_annotation_version_page', table_name='annotations')
    op.drop_table('annotations')
