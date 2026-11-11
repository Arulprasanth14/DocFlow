"""workflow module runtime: stage instances, rounds, decisions, idempotency, outbox

Workflow Module §4.3 D (stage instance states), §4.5 (BR-01), §7.1 (X-NOT-01),
§7.4 (X-INT-01/02/06), §8. Plan: docs/DocFlow_Workflow_Implementation_Plan.md,
task P2-1.

WHAT THIS IS FOR

  P1-1 gave a workflow DEFINITION an immutable version to be pinned to. This
  migration gives a RUN somewhere to record what actually happened, which is
  the precondition for fixing the last Critical finding (defect 1, task P2-2):

      WorkflowService.advance_stage() reads the LIVE template
      (`stage_repo.list_for_template(instance.template_id)`), never the
      version the run was submitted against.

  That is worse in practice than the discovery audit recorded, because P1-3
  now makes a saved edit actually rewrite the legacy stage rows. Re-reading
  the code after Phase 1 landed, the live sequence is:

    1. an owner saves an edit; `_replace_legacy_stages()` soft-deletes the
       stage rows an in-flight run references and inserts the new definition;
    2. `advance_stage()` calls `list_for_template()`, which filters
       soft-deleted rows out, so `stages` is the NEW definition;
    3. `current_stage` is loaded with `db.get()`, which does NOT filter
       soft-deleted rows, so it is still the OLD row;
    4. the next stage is chosen by comparing the old row's `sequence_order`
       against the new definition's.

  So an in-flight run is routed into whatever now occupies the next position,
  and — the case that matters most — if the edit left FEWER stages than the
  run had already passed, `next_stage` is None and the run is marked APPROVED
  and the document APPROVED, with the remaining approvals never collected.
  Editing a workflow can therefore approve someone else's in-flight document.
  Nothing in the schema could prevent it: there was no per-run record of which
  stages a run is supposed to visit.

  `stage_instances` is that record. A run's stages are created once, from the
  pinned version, and are never re-derived from the template again.

ADDITIVE ONLY. This migration:
  * creates five new tables,
  * adds six new columns, every one nullable or NOT NULL with a
    server_default, so existing rows stay valid with no rewrite,
  * creates indexes and CHECK constraints that bind only the new tables and
    the new columns,
  * backfills stage instances only where it can do so EXACTLY (see below).

It does NOT drop, rename, alter the type of, or delete anything. `ApprovalStep`
keeps every column it has and stays the per-approver decision + signature
record; `stage_instances` owns stage status and timing. The link between them
is the new nullable `approval_steps.stage_instance_id`, so existing rows and
the existing queries keep working untouched.

ONE DEVIATION FROM THE PLAN'S §4 TABLE, with its reason

  The plan specifies `stage_instances` unique on `(instance_id, position)`.
  That cannot hold together with WF-REV-13: `require_full_reapproval` resets a
  run to stage 1 and the earlier stage instances become Superseded and are
  RETAINED for audit, which needs a second row at position 1. A `cycle`
  column is therefore added and the constraint is
  `(instance_id, cycle, position)`. Cycle 1 is the original pass; a full
  re-approval reset opens cycle 2. This preserves the plan's intent (one live
  row per position) without having to delete the audit trail it asks to keep.

ON THE BR-01 UNIQUE INDEX

  §4.5 BR-01 allows one non-terminal run per document, and the plan asks for a
  partial unique index to enforce it. An index like that FAILS to build if the
  data already violates it. This migration therefore checks first and, if it
  finds a document with two or more live runs, raises with the offending
  document ids instead of either failing with an opaque Postgres error or
  silently skipping a safety constraint. Resolving duplicates is a data
  decision for an admin, not something a migration should do unprompted.

Revision ID: e1f2a3b4c5d6
Revises: b7c8d9e0f1a2
Create Date: 2026-11-06 12:00:00.000000
"""
from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'e1f2a3b4c5d6'
down_revision = 'b7c8d9e0f1a2'
branch_labels = None
depends_on = None


# §4.3 C. A run in one of these states is finished and no longer occupies the
# document; anything else counts as live for BR-01. Kept as literal strings so
# the index predicate is stable even if the enum gains members later.
TERMINAL_RUN_STATUSES = (
    'approved', 'rejected', 'cancelled', 'finalized', 'completed',
)

# §4.3 D.
STAGE_INSTANCE_STATUSES = (
    'pending', 'active', 'awaiting_signature', 'changes_requested',
    'approved', 'rejected', 'blocked', 'superseded',
)

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
    # ── 1. Stage instances (§4.3 D) ─────────────────────────────────────────
    op.create_table(
        'stage_instances',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('instance_id', postgresql.UUID(as_uuid=True), nullable=False),
        # Where this stage's definition came from. version_stage_id is the
        # authoritative source once a run is pinned; legacy_stage_id is kept so
        # an ApprovalStep (whose stage_id is NOT NULL and references
        # workflow_stages) can still be created for the same stage.
        sa.Column('version_stage_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('legacy_stage_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('cycle', sa.Integer(), nullable=False, server_default=sa.text('1')),
        sa.Column('position', sa.Integer(), nullable=False),
        # Snapshot, so the timeline reads correctly even if the definition
        # changes later (DM-02).
        sa.Column('stage_name', sa.String(length=255), nullable=False),
        sa.Column('approver_type', sa.String(length=40), nullable=False,
                  server_default='specific_user'),
        # Resolved ONCE at activation and authoritative from then on, even if
        # the org chart changes afterwards (WF-STG-23, E5).
        sa.Column('resolved_approver_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('department_id', postgresql.UUID(as_uuid=True), nullable=True),
        # WF-STG-20/21: may be forced on at activation even when the
        # definition said off, so the reason is recorded alongside.
        sa.Column('signing_required', sa.Boolean(), nullable=False,
                  server_default=sa.text('false')),
        sa.Column('signing_reason', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(length=40), nullable=False,
                  server_default='pending'),
        sa.Column('due_within_hours', sa.Integer(), nullable=True),
        # Server-computed and stored; the UI never computes a due date
        # (AP-SLA-07, BR-13).
        sa.Column('due_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('activated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        # §6.10: the timer stops while Changes Requested or Blocked.
        sa.Column('timer_paused_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('round_count', sa.Integer(), nullable=False, server_default=sa.text('1')),
        sa.Column('blocked_reason', sa.String(length=255), nullable=True),
        # X-INT-02 optimistic locking.
        sa.Column('row_version', sa.Integer(), nullable=False, server_default=sa.text('1')),
        *_base_cols(),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['instance_id'], ['workflow_instances.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['version_stage_id'], ['workflow_version_stages.id']),
        sa.ForeignKeyConstraint(['legacy_stage_id'], ['workflow_stages.id']),
        sa.ForeignKeyConstraint(['resolved_approver_id'], ['users.id']),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id']),
        sa.UniqueConstraint('instance_id', 'cycle', 'position',
                            name='uq_stage_instance_position'),
        sa.CheckConstraint('position >= 1', name='ck_stage_instance_position'),
        sa.CheckConstraint('cycle >= 1', name='ck_stage_instance_cycle'),
        sa.CheckConstraint('round_count >= 1', name='ck_stage_instance_rounds'),
        sa.CheckConstraint(
            "status IN ('" + "', '".join(STAGE_INSTANCE_STATUSES) + "')",
            name='ck_stage_instance_status',
        ),
        sa.CheckConstraint(
            'due_within_hours IS NULL OR (due_within_hours >= 1 AND due_within_hours <= 720)',
            name='ck_stage_instance_due_within',
        ),
    )
    op.create_index('ix_stage_instances_instance_id', 'stage_instances',
                    ['instance_id'])
    # The approvals dashboard's main query (AP-DSH-*) and the SLA sweep
    # (AP-SLA-01, every minute) both read exactly this.
    op.create_index('idx_stage_instance_queue', 'stage_instances',
                    ['resolved_approver_id', 'status', 'due_at'])
    op.create_index('idx_stage_instance_org_status', 'stage_instances',
                    ['org_id', 'status'])

    # ── 2. Review rounds (§6.5.2, BR-06) ────────────────────────────────────
    op.create_table(
        'review_rounds',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('stage_instance_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('round_number', sa.Integer(), nullable=False),
        # The exact version under review in this round (DM-02, WF-REV-08).
        sa.Column('document_version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('opened_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('closed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('outcome', sa.String(length=40), nullable=True),
        *_base_cols(),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['stage_instance_id'], ['stage_instances.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['document_version_id'], ['document_versions.id']),
        sa.UniqueConstraint('stage_instance_id', 'round_number',
                            name='uq_review_round_number'),
        sa.CheckConstraint('round_number >= 1', name='ck_review_round_number'),
        sa.CheckConstraint(
            "outcome IS NULL OR outcome IN "
            "('approved', 'rejected', 'changes_requested', 'withdrawn', 'superseded')",
            name='ck_review_round_outcome',
        ),
    )
    op.create_index('ix_review_rounds_stage_instance_id', 'review_rounds',
                    ['stage_instance_id'])

    # ── 3. Decisions (AP-APR-06, BR-09 — immutable once written) ────────────
    op.create_table(
        'decisions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('stage_instance_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('review_round_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('actor_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('decision', sa.String(length=40), nullable=False),
        sa.Column('comment', sa.Text(), nullable=True),
        # AP-APR-06 wants the version id AND its hash, so a decision stays
        # verifiable even if the version row is later moved or re-pointed.
        sa.Column('document_version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('document_version_hash', sa.String(length=128), nullable=True),
        sa.Column('esignature_id', postgresql.UUID(as_uuid=True), nullable=True),
        # Bridge to the existing per-approver record, so the two never drift.
        sa.Column('approval_step_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        *_base_cols(),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['stage_instance_id'], ['stage_instances.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['review_round_id'], ['review_rounds.id']),
        sa.ForeignKeyConstraint(['actor_id'], ['users.id']),
        sa.ForeignKeyConstraint(['document_version_id'], ['document_versions.id']),
        sa.ForeignKeyConstraint(['esignature_id'], ['esignatures.id']),
        sa.ForeignKeyConstraint(['approval_step_id'], ['approval_steps.id']),
        sa.CheckConstraint(
            "decision IN ('approved', 'rejected', 'changes_requested')",
            name='ck_decision_value',
        ),
    )
    op.create_index('ix_decisions_stage_instance_id', 'decisions',
                    ['stage_instance_id'])
    op.create_index('idx_decision_actor', 'decisions', ['actor_id', 'decided_at'])

    # ── 4. Idempotency keys (X-INT-01) ──────────────────────────────────────
    # Durable, so a Redis flush cannot turn a retry into a second submission
    # (E10, T26). The existing Redis path stays as the fast check in front.
    op.create_table(
        'idempotency_keys',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('key', sa.String(length=255), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('endpoint', sa.String(length=255), nullable=False),
        # Same key replayed with a DIFFERENT body is a client bug, not a
        # retry, and must be rejected rather than served the old response.
        sa.Column('request_hash', sa.String(length=128), nullable=False),
        sa.Column('status_code', sa.Integer(), nullable=True),
        sa.Column('response_snapshot', postgresql.JSONB(astext_type=sa.Text()),
                  nullable=True),
        *_base_cols(),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.UniqueConstraint('key', 'user_id', 'endpoint', name='uq_idempotency_key'),
    )
    # For the 24h TTL sweep.
    op.create_index('idx_idempotency_created', 'idempotency_keys', ['created_at'])

    # ── 5. Transactional outbox (X-NOT-01) ──────────────────────────────────
    # Enqueued in the SAME transaction as the state change, delivered after
    # commit, so a rolled-back change can never notify anyone.
    op.create_table(
        'outbox_events',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('org_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('topic', sa.String(length=120), nullable=False),
        sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()),
                  nullable=False, server_default='{}'),
        sa.Column('dedupe_key', sa.String(length=255), nullable=True),
        sa.Column('available_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default=sa.text('0')),
        sa.Column('last_error', sa.Text(), nullable=True),
        *_base_cols(),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.CheckConstraint('attempts >= 0', name='ck_outbox_attempts'),
    )
    # The worker's only query: undelivered and due, oldest first.
    op.create_index(
        'idx_outbox_pending', 'outbox_events', ['available_at'],
        postgresql_where=sa.text('delivered_at IS NULL'),
    )
    # Exactly-once per logical event. Partial, so rows without a dedupe key
    # are unconstrained.
    op.create_index(
        'uq_outbox_dedupe', 'outbox_events', ['dedupe_key'], unique=True,
        postgresql_where=sa.text('dedupe_key IS NOT NULL'),
    )

    # ── 6. Notification dedupe (§7.1, N1–N15) ───────────────────────────────
    op.add_column(
        'notifications',
        sa.Column('dedupe_key', sa.String(length=255), nullable=True),
    )
    op.create_index(
        'uq_notification_dedupe', 'notifications', ['dedupe_key'], unique=True,
        postgresql_where=sa.text('dedupe_key IS NOT NULL AND deleted_at IS NULL'),
    )

    # ── 7. Run columns ──────────────────────────────────────────────────────
    # The pinned definition. THIS is what fixes defect 1 — see P2-2.
    op.add_column(
        'workflow_instances',
        sa.Column('version_id', postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        'fk_wi_version', 'workflow_instances',
        'workflow_template_versions', ['version_id'], ['id'],
    )
    op.create_index('ix_workflow_instances_version_id', 'workflow_instances',
                    ['version_id'])
    # AP-REJ-04 / WF-SUB-06: Submit as New links the fresh run to the one it
    # replaces, instead of reopening a terminal run (BR-07, BR-14).
    op.add_column(
        'workflow_instances',
        sa.Column('previous_run_id', postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        'fk_wi_previous_run', 'workflow_instances',
        'workflow_instances', ['previous_run_id'], ['id'],
    )
    op.add_column(
        'workflow_instances',
        sa.Column('row_version', sa.Integer(), nullable=False,
                  server_default=sa.text('1')),
    )
    op.add_column(
        'workflow_instances',
        sa.Column('idempotency_key', sa.String(length=255), nullable=True),
    )
    # Full re-approval (WF-REV-13) opens a new cycle; the run records which
    # one is live so stage lookups stay unambiguous.
    op.add_column(
        'workflow_instances',
        sa.Column('current_cycle', sa.Integer(), nullable=False,
                  server_default=sa.text('1')),
    )

    # ── 8. Link the per-approver record to its stage instance ───────────────
    # Nullable: every existing row keeps working, and `stage_id` is untouched.
    op.add_column(
        'approval_steps',
        sa.Column('stage_instance_id', postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        'fk_as_stage_instance', 'approval_steps',
        'stage_instances', ['stage_instance_id'], ['id'],
    )
    op.create_index('ix_approval_steps_stage_instance_id', 'approval_steps',
                    ['stage_instance_id'])

    # ── 9. BR-01: one live run per document (X-INT-06) ──────────────────────
    _create_single_run_index()

    # ── 10. Backfill ────────────────────────────────────────────────────────
    _backfill()


def _terminal_sql() -> str:
    return "'" + "', '".join(TERMINAL_RUN_STATUSES) + "'"


def _create_single_run_index() -> None:
    """Build the BR-01 partial unique index, refusing loudly on bad data."""
    predicate = (
        f"status NOT IN ({_terminal_sql()}) AND deleted_at IS NULL"
    )

    if not context.is_offline_mode():
        bind = op.get_bind()
        dupes = bind.execute(sa.text(
            "SELECT document_id, count(*) AS n FROM workflow_instances"
            f" WHERE {predicate}"
            " GROUP BY document_id HAVING count(*) > 1"
        )).fetchall()
        if dupes:
            listed = ', '.join(f"{r[0]} ({r[1]} runs)" for r in dupes[:20])
            raise RuntimeError(
                "Cannot enforce BR-01 (one non-terminal workflow run per "
                "document): the data already violates it.\n"
                f"  Documents with more than one live run: {listed}\n"
                "Nothing has been changed. Decide which run is authoritative "
                "for each document and terminate the others "
                "(status 'cancelled'), then re-run this migration. Inspect "
                "with:\n"
                "  SELECT document_id, id, status, submitted_at "
                "FROM workflow_instances\n"
                f"   WHERE {predicate} ORDER BY document_id, submitted_at;"
            )

    op.create_index(
        'uq_wi_single_live_run', 'workflow_instances', ['document_id'],
        unique=True, postgresql_where=sa.text(predicate),
    )


def _backfill() -> None:
    """Pin existing runs to a version and give them stage instances.

    Deliberately conservative. A stage instance is created only when the
    pinned version's stages map EXACTLY onto the legacy stages the run was
    actually using — same count, and sequence orders that form 1..N. Anything
    else is left without stage instances rather than guessed at, and P2-2's
    legacy path handles those runs by refusing to advance them rather than
    routing them somewhere plausible-looking. Guessing here would reroute a
    live approval, which is the very bug this migration exists to fix.
    """
    if context.is_offline_mode():
        print(
            "  -- offline mode: backfill skipped. Run `alembic upgrade head` "
            "against the database to pin existing runs."
        )
        return

    bind = op.get_bind()

    # 1. Pin each run to version 1 of its template. Version 1 was backfilled
    #    by b7c8d9e0f1a2 FROM the then-live stages, so for any run that
    #    existed before that migration it is by construction the definition
    #    that was live at submission. Runs created after it already carry the
    #    version the service pinned.
    pinned = bind.execute(sa.text(
        "UPDATE workflow_instances wi"
        "   SET version_id = v.id"
        "  FROM workflow_template_versions v"
        " WHERE v.template_id = wi.template_id"
        "   AND v.version_number = 1"
        "   AND wi.version_id IS NULL"
        "   AND wi.template_id IS NOT NULL"
        " RETURNING wi.id"
    )).fetchall()
    print(f"  -- pinned {len(pinned)} run(s) to version 1")

    # 2. Stage instances for live runs only. A finished run has nothing left
    #    to route, and fabricating history for it would put rows in the audit
    #    trail that describe approvals no one performed.
    live = bind.execute(sa.text(
        "SELECT wi.id, wi.org_id, wi.template_id, wi.version_id, wi.status,"
        "       wi.current_stage_id"
        "  FROM workflow_instances wi"
        f" WHERE wi.status NOT IN ({_terminal_sql()})"
        "   AND wi.deleted_at IS NULL"
        "   AND wi.version_id IS NOT NULL"
    )).fetchall()

    made = skipped = 0
    for run in live:
        vstages = bind.execute(sa.text(
            "SELECT id, position, name, approver_type, approver_user_id,"
            "       department_id, due_within_hours, require_signing"
            "  FROM workflow_version_stages"
            " WHERE version_id = :vid AND deleted_at IS NULL"
            " ORDER BY position"
        ), {"vid": run.version_id}).fetchall()

        lstages = bind.execute(sa.text(
            "SELECT id, sequence_order FROM workflow_stages"
            " WHERE template_id = :tid AND deleted_at IS NULL"
            " ORDER BY sequence_order"
        ), {"tid": run.template_id}).fetchall()

        # Legacy `sequence_order` is 0-based in existing data while version
        # `position` is 1-based, so the two are matched by RANK, exactly as
        # b7c8d9e0f1a2 built the version rows (enumerate over ORDER BY
        # sequence_order). Comparing the raw numbers would skip every run.
        legacy_by_position = {
            rank: s.id for rank, s in enumerate(lstages, start=1)
        }
        positions = [s.position for s in vstages]
        exact = (
            bool(vstages)
            and len(vstages) == len(lstages)
            and positions == list(range(1, len(vstages) + 1))
        )
        if not exact:
            skipped += 1
            continue

        # The run's position is the rank of the stage it points at. A run
        # whose current stage was soft-deleted by a Phase 1 edit is NOT in
        # this map; that is precisely the corrupted case defect 1 creates, so
        # it is skipped rather than assigned a plausible-looking position.
        rank_by_stage_id = {
            s.id: rank for rank, s in enumerate(lstages, start=1)
        }
        cur = rank_by_stage_id.get(run.current_stage_id)
        if run.current_stage_id is not None and cur is None:
            skipped += 1
            continue
        for vs in vstages:
            if cur is None:
                status = 'pending'
            elif vs.position < cur:
                status = 'approved'
            elif vs.position == cur:
                status = ('changes_requested'
                          if run.status == 'changes_requested' else 'active')
            else:
                status = 'pending'

            si_id = bind.execute(sa.text(
                "INSERT INTO stage_instances"
                " (org_id, instance_id, version_stage_id, legacy_stage_id,"
                "  cycle, position, stage_name, approver_type,"
                "  resolved_approver_id, department_id, signing_required,"
                "  status, due_within_hours)"
                " VALUES"
                " (:org, :inst, :vsid, :lsid, 1, :pos, :nm, :atype,"
                "  :appr, :dept, :sign, :st, :due)"
                " RETURNING id"
            ), {
                "org": run.org_id, "inst": run.id, "vsid": vs.id,
                "lsid": legacy_by_position.get(vs.position),
                "pos": vs.position, "nm": vs.name,
                "atype": vs.approver_type,
                # Only a specific_user is known without re-resolving the org
                # chart; a manager rule is resolved at activation (WF-STG-23).
                "appr": vs.approver_user_id,
                "dept": vs.department_id,
                "sign": vs.require_signing,
                "st": status, "due": vs.due_within_hours,
            }).scalar()

            # Attach the approval steps already recorded at this stage.
            bind.execute(sa.text(
                "UPDATE approval_steps SET stage_instance_id = :si"
                " WHERE instance_id = :inst AND stage_id = :lsid"
                "   AND stage_instance_id IS NULL"
            ), {
                "si": si_id, "inst": run.id,
                "lsid": legacy_by_position.get(vs.position),
            })
        made += 1

    print(f"  -- created stage instances for {made} live run(s)")

    # A live run whose template has no representable version (P1-1 left those
    # at current_version_id NULL) cannot be pinned at all. Reported because
    # P2-2 will refuse to advance it, so an operator needs to know it exists.
    unpinned = bind.execute(sa.text(
        "SELECT count(*) FROM workflow_instances"
        f" WHERE status NOT IN ({_terminal_sql()})"
        "   AND deleted_at IS NULL AND version_id IS NULL"
    )).scalar()
    if unpinned:
        print(
            f"  -- {unpinned} live run(s) have NO pinned version (their "
            "template could not be represented as a version by "
            "b7c8d9e0f1a2). They keep running on the legacy path."
        )

    if skipped:
        print(
            f"  -- {skipped} live run(s) left WITHOUT stage instances because "
            "their pinned version does not map exactly onto their legacy "
            "stages. These keep running on the legacy path and will not be "
            "auto-advanced; see P2-2."
        )


def downgrade() -> None:
    op.drop_index('ix_approval_steps_stage_instance_id', table_name='approval_steps')
    op.drop_constraint('fk_as_stage_instance', 'approval_steps', type_='foreignkey')
    op.drop_column('approval_steps', 'stage_instance_id')

    op.drop_index('uq_wi_single_live_run', table_name='workflow_instances')
    op.drop_column('workflow_instances', 'current_cycle')
    op.drop_column('workflow_instances', 'idempotency_key')
    op.drop_column('workflow_instances', 'row_version')
    op.drop_constraint('fk_wi_previous_run', 'workflow_instances', type_='foreignkey')
    op.drop_column('workflow_instances', 'previous_run_id')
    op.drop_index('ix_workflow_instances_version_id', table_name='workflow_instances')
    op.drop_constraint('fk_wi_version', 'workflow_instances', type_='foreignkey')
    op.drop_column('workflow_instances', 'version_id')

    op.drop_index('uq_notification_dedupe', table_name='notifications')
    op.drop_column('notifications', 'dedupe_key')

    op.drop_index('uq_outbox_dedupe', table_name='outbox_events')
    op.drop_index('idx_outbox_pending', table_name='outbox_events')
    op.drop_table('outbox_events')

    op.drop_index('idx_idempotency_created', table_name='idempotency_keys')
    op.drop_table('idempotency_keys')

    op.drop_index('idx_decision_actor', table_name='decisions')
    op.drop_index('ix_decisions_stage_instance_id', table_name='decisions')
    op.drop_table('decisions')

    op.drop_index('ix_review_rounds_stage_instance_id', table_name='review_rounds')
    op.drop_table('review_rounds')

    op.drop_index('idx_stage_instance_org_status', table_name='stage_instances')
    op.drop_index('idx_stage_instance_queue', table_name='stage_instances')
    op.drop_index('ix_stage_instances_instance_id', table_name='stage_instances')
    op.drop_table('stage_instances')
