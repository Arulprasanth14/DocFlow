"""workflow_approvals_phase2_gaps

Phase 2 gap-close migration for Workflows & Approvals module:

1. DocumentStatus enum consolidation (models/document.py is canonical):
   - The `documents.status` column already uses a VARCHAR(50), not a native PG enum,
     so no ALTER TYPE is needed. We simply UPDATE rows with legacy values to the
     canonical values per the decision table.
   - Legacy → Canonical mapping:
       in_review          → pending
       changes_requested  → sent_back
       revision_requested → sent_back
       pending_approval   → pending

2. Add `requires_signature` BOOLEAN column to `workflow_stages` (default FALSE).
   Existing stages are unaffected (they get FALSE).

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-09-26 22:30:00.000000+00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "55ea278edeb1"
branch_labels: Union[Sequence[str], None] = None
depends_on: Union[Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. DocumentStatus value migration ──────────────────────────────────────
    # The documents.status column is VARCHAR(50) — no native PG enum to alter.
    # Remap legacy values to their canonical equivalents.
    conn = op.get_bind()

    # Remap 'in_review' → 'pending'
    conn.execute(
        sa.text("UPDATE documents SET status = 'pending' WHERE status = 'in_review'")
    )

    # Remap 'changes_requested' → 'sent_back' (canonical SENT_BACK from models/document.py)
    conn.execute(
        sa.text("UPDATE documents SET status = 'sent_back' WHERE status = 'changes_requested'")
    )

    # Remap 'revision_requested' → 'sent_back'
    conn.execute(
        sa.text("UPDATE documents SET status = 'sent_back' WHERE status = 'revision_requested'")
    )

    # Remap 'pending_approval' → 'pending'
    conn.execute(
        sa.text("UPDATE documents SET status = 'pending' WHERE status = 'pending_approval'")
    )

    # ── 2. Add requires_signature to workflow_stages ───────────────────────────
    op.add_column(
        "workflow_stages",
        sa.Column(
            "requires_signature",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("FALSE"),
        ),
    )


def downgrade() -> None:
    # ── 2. Remove requires_signature ──────────────────────────────────────────
    op.drop_column("workflow_stages", "requires_signature")

    # ── 1. Reverse DocumentStatus remapping ───────────────────────────────────
    # NOTE: We reverse only what's deterministic. 'sent_back' had two sources
    # (changes_requested + revision_requested); we restore them all as
    # 'changes_requested' (the most recent canonical value before this migration).
    # 'pending' had two sources too (in_review + pending_approval); restore as
    # 'in_review'.
    conn = op.get_bind()
    conn.execute(
        sa.text("UPDATE documents SET status = 'in_review' WHERE status = 'pending'")
    )
    conn.execute(
        sa.text("UPDATE documents SET status = 'changes_requested' WHERE status = 'sent_back'")
    )
