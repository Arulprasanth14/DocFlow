"""template_studio_tables — Template / TemplateVersion / TemplateField / PlaceholderOccurrence

Documents module Phase 2 (Template Studio). ADDITIVE ONLY: creates four new tables
and their indexes/constraints. No existing table is altered. Safe to apply on a
populated database — nothing backfills and nothing else references these yet.

Revision ID: a7b8c9d0e1f2
Revises: f1a2b3c4d5e6
Create Date: 2026-10-27 16:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'a7b8c9d0e1f2'
down_revision: Union[str, None] = 'f1a2b3c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _base_cols() -> list[sa.Column]:
    """Standard BaseModel columns (id / timestamps / soft-delete)."""
    return [
        sa.Column('id', postgresql.UUID(as_uuid=True), server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    ]


def upgrade() -> None:
    # ── templates ──────────────────────────────────────────────────────────────
    op.create_table(
        'templates',
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('owner_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('scope', sa.String(length=20), server_default='user', nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('category', sa.String(length=100), nullable=True),
        sa.Column('tags', postgresql.ARRAY(sa.String()), server_default='{}', nullable=True),
        sa.Column('icon', sa.String(length=50), nullable=True),
        sa.Column('color', sa.String(length=20), nullable=True),
        sa.Column('status', sa.String(length=20), server_default='draft', nullable=False),
        sa.Column('usage_count', sa.Integer(), server_default='0', nullable=False),
        # FK to template_versions added after that table exists (circular ref).
        sa.Column('current_version_id', postgresql.UUID(as_uuid=True), nullable=True),
        *_base_cols(),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_templates_org_id', 'templates', ['org_id'])
    op.create_index('ix_templates_owner_id', 'templates', ['owner_id'])

    # ── template_versions ──────────────────────────────────────────────────────
    op.create_table(
        'template_versions',
        sa.Column('template_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('version_no', sa.Integer(), nullable=False),
        sa.Column('content', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=True),
        sa.Column('page_settings', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=True),
        sa.Column('thumbnail_url', sa.Text(), nullable=True),
        sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('source_file_id', postgresql.UUID(as_uuid=True), nullable=True),
        *_base_cols(),
        sa.ForeignKeyConstraint(['template_id'], ['templates.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['source_file_id'], ['file_assets.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('template_id', 'version_no', name='uq_template_version'),
    )
    op.create_index('ix_template_versions_template_id', 'template_versions', ['template_id'])

    # Now wire templates.current_version_id → template_versions.id
    op.create_foreign_key(
        'fk_template_current_version', 'templates', 'template_versions',
        ['current_version_id'], ['id'],
    )

    # ── template_fields ────────────────────────────────────────────────────────
    op.create_table(
        'template_fields',
        sa.Column('template_version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('key', sa.String(length=64), nullable=False),
        sa.Column('label', sa.Text(), nullable=False),
        sa.Column('type', sa.String(length=30), nullable=False),
        sa.Column('required', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('help_text', sa.Text(), nullable=True),
        sa.Column('example', sa.Text(), nullable=True),
        sa.Column('default_value', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('validation', postgresql.JSONB(astext_type=sa.Text()), server_default='{}', nullable=True),
        sa.Column('format', sa.String(length=50), nullable=True),
        sa.Column('options', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=True),
        sa.Column('if_empty_behavior', sa.String(length=20), server_default='keep_blank', nullable=False),
        sa.Column('order_index', sa.Integer(), server_default='0', nullable=False),
        sa.Column('section', sa.String(length=120), nullable=True),
        *_base_cols(),
        sa.ForeignKeyConstraint(['template_version_id'], ['template_versions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('template_version_id', 'key', name='uq_template_field_key'),
    )
    op.create_index('ix_template_fields_version', 'template_fields', ['template_version_id'])

    # ── placeholder_occurrences ────────────────────────────────────────────────
    op.create_table(
        'placeholder_occurrences',
        sa.Column('template_version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('field_key', sa.String(length=64), nullable=False),
        sa.Column('node_id', sa.String(length=64), nullable=False),
        sa.Column('order_no', sa.Integer(), server_default='0', nullable=False),
        *_base_cols(),
        sa.ForeignKeyConstraint(['template_version_id'], ['template_versions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_placeholder_occurrences_version', 'placeholder_occurrences', ['template_version_id'])


def downgrade() -> None:
    op.drop_index('ix_placeholder_occurrences_version', table_name='placeholder_occurrences')
    op.drop_table('placeholder_occurrences')
    op.drop_index('ix_template_fields_version', table_name='template_fields')
    op.drop_table('template_fields')
    op.drop_constraint('fk_template_current_version', 'templates', type_='foreignkey')
    op.drop_index('ix_template_versions_template_id', table_name='template_versions')
    op.drop_table('template_versions')
    op.drop_index('ix_templates_owner_id', table_name='templates')
    op.drop_index('ix_templates_org_id', table_name='templates')
    op.drop_table('templates')
