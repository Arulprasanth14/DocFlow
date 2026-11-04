"""documents: a full-text index that is actually used (FR-1.5)

Document search was `title ILIKE '%term%'` plus the same on `public_id`.
What was actually missing — checked against the live database, not assumed:

  * `idx_documents_title_trgm` (GIN, gin_trgm_ops) already covers the title
    ILIKE branch, so title substring search was never a sequential scan.
  * The `public_id` ILIKE branch has no trigram index and still scans. It is
    a short column on a small set of rows, so this is left alone.
  * `documents.search_vector` and its GIN index `idx_documents_fts` have
    existed since the table was created and are **dead**: the column is NULL
    on every row (27 of 27 at the time of writing). Nothing has ever written
    to it, so the index matches nothing.
  * Nothing indexed, or even searched, the document *body*.

So the real gap in FR-1.5 ("appropriate indexes, including full-text") is a
working full-text index with data in it, over the body as well as the title.

Why a new index and not the existing one
----------------------------------------
`documents` already carries a `search_vector TSVECTOR` column and a GIN index
on it (`idx_documents_fts`, created with the table). Nothing has ever written
to that column: it is NULL on every row, so the index is empty and matches
nothing. Making it work would mean a trigger (or a generated column, which
cannot be retrofitted onto an existing column) plus a backfill — a write-path
change for every document insert and update.

An expression index needs neither, stays purely additive, and indexes the
document body as well as its title:

    to_tsvector('english', coalesce(title, '') || ' '
                           || left(coalesce(content_text, ''), 100000))

`content_text` is the plain-text projection of the body and is already
maintained (document_service writes it whenever content is saved) — unlike
`search_vector`, which is why this indexes the former and not the latter.

The expression is written exactly as the repository emits it, because Postgres
only uses an expression index when the query's expression matches it verbatim
after constant folding. `coalesce`, `||` and `left` are IMMUTABLE and so is
`to_tsvector` with an explicit configuration; `concat_ws` is only STABLE and
cannot be indexed, which is why it is spelled out with `||`.

The `left(..., 100000)` cap is not cosmetic: a tsvector is limited to ~1 MB,
and a long enough document would make every INSERT fail once the index exists.

`search_vector` and `idx_documents_fts` are left exactly as they are — unused.
Dropping them is a separate, non-additive decision.

The repository keeps the two ILIKE branches alongside the new full-text branch
(`OR`), so this migration can only ever *add* matches: a substring or prefix
search that worked before still works, and no existing result disappears.

ADDITIVE ONLY: one new index. No table, column, constraint or existing index
is touched, nothing is backfilled, and no application code requires it — until
it is applied, search returns exactly the same rows by sequential scan.

Note on CONCURRENTLY: Alembic runs migrations inside a transaction and
CREATE INDEX CONCURRENTLY cannot run in one. A plain CREATE INDEX takes a
SHARE lock on `documents` (reads fine, writes blocked) while it builds. On a
table of this size that is well under a second. For a large production table,
build it by hand outside Alembic instead:

    CREATE INDEX CONCURRENTLY idx_documents_fts_expr ON documents
      USING gin (to_tsvector('english', coalesce(title, '') || ' '
                 || left(coalesce(content_text, ''), 100000)));

Revision ID: e3f4a5b6c7d8
Revises: d1e2f3a4b5c6
Create Date: 2026-11-04 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import op

revision: str = 'e3f4a5b6c7d8'
down_revision: Union[str, None] = 'd1e2f3a4b5c6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX_NAME = "idx_documents_fts_expr"


def upgrade() -> None:
    op.execute(
        f"""
        CREATE INDEX IF NOT EXISTS {INDEX_NAME} ON documents
          USING gin (to_tsvector('english', coalesce(title, '') || ' '
                     || left(coalesce(content_text, ''), 100000)))
        """
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {INDEX_NAME}")
