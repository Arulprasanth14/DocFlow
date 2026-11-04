"""workflow module: immutable definition versions, per-user shares, manager line

Workflow Module §4.4 (DM-01..04), §5.1 (WF-OWN-*), §5.5 (WF-STG-20..24), §8.
Plan: docs/DocFlow_Workflow_Implementation_Plan.md, task P1-1.

WHAT THIS FIXES
  Two Critical findings from the discovery audit (§2.4 of the plan):

  1. DM-02 was violated. `WorkflowService.advance_stage()` read stages from the
     LIVE template, so editing a workflow silently re-routed runs that were
     already in flight from stage 2 onward. There was nowhere to pin a run to,
     because `workflow_templates.version` is a bare integer counter.

  2. The builder's edit mode silently discarded stage edits, and could not do
     otherwise: `approval_steps.stage_id` and
     `workflow_instances.current_stage_id` both reference `workflow_stages.id`
     with no ON DELETE, so rewriting stages in place would either violate
     those foreign keys or orphan the audit trail of approvals already
     recorded against them.

  Both are answered by versioning the definition instead of mutating it:
  every save writes a new immutable `workflow_template_versions` row, and a
  run pins the version it was submitted against.

ADDITIVE ONLY. This migration:
  * creates three new tables,
  * adds five new columns, every one of them either nullable or NOT NULL with
    a server_default so existing rows remain valid without a rewrite,
  * creates indexes and CHECK constraints that apply only to the new tables,
  * and backfills version 1 for templates it can represent exactly.

It does NOT drop, rename, alter the type of, or delete anything. The legacy
`workflow_stages` / `stage_approver_rules` tables are left completely
untouched and are still the execution path until the service layer moves over.
`workflow_templates.is_active` and `.version` are both kept and still written.

DELIBERATELY NOT DONE HERE
  Seeding `departments.requires_signature = true` for Finance (§8 asks for it)
  is a change to existing DATA that makes more stages demand a signature. It is
  left out so that signing behaviour is never altered by a schema migration;
  it is a one-line admin action, to be applied deliberately:

      UPDATE departments SET requires_signature = true
       WHERE lower(name) = 'finance' AND deleted_at IS NULL;

BACKFILL SCOPE
  A version 1 row is created only for a template whose every stage has exactly
  one approver rule of type `specific_user` or `manager_of_requester` — the two
  kinds §5.5 field B offers. Templates using `role_in_department` or multiple
  rules per stage cannot be represented under the new CHECK constraints, so
  they are left with `current_version_id = NULL` and keep running on the
  legacy path rather than being coerced into a shape that would lose
  information. The count of each is printed when the migration runs.

  Legacy `sla_hours` is mapped to `due_within_hours` and clamped into the
  1..720 range the spec allows (O-5); NULL becomes 48 hours, the §5.5 field D
  default of 2 days.

Revision ID: b7c8d9e0f1a2
Revises: f5a6b7c8d9e0
Create Date: 2026-11-06 10:00:00.000000+00:00
"""
from typing import Sequence, Union

from alembic import context, op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = 'b7c8d9e0f1a2'
down_revision: Union[str, None] = 'f5a6b7c8d9e0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Reporting line: users.manager_id (WF-STG-23/24, decision D1) ──────
    # NULL means "not set", and resolution then falls back to the department
    # head, which is exactly what the code did before this column existed — so
    # no organization changes behaviour on the day this lands.
    op.add_column('users', sa.Column('manager_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key('fk_user_manager', 'users', 'users', ['manager_id'], ['id'])
    op.create_index('ix_users_manager_id', 'users', ['manager_id'])

    # ── 2. Signing rule: departments.requires_signature (WF-STG-20, BR-08) ──
    # NOT NULL with a server_default, so every existing department reads as
    # "no signature required", which is today's behaviour. Nothing is seeded;
    # see DELIBERATELY NOT DONE HERE above.
    op.add_column(
        'departments',
        sa.Column('requires_signature', sa.Boolean(), nullable=False,
                  server_default=sa.text('false')),
    )

    # ── 3. Template lifecycle + version pointer (DM-01..04, WF-LC-03) ───────
    op.add_column(
        'workflow_templates',
        sa.Column('status', sa.String(length=20), nullable=False,
                  server_default='active'),
    )
    op.add_column(
        'workflow_templates',
        sa.Column('require_full_reapproval', sa.Boolean(), nullable=False,
                  server_default=sa.text('false')),
    )
    op.add_column(
        'workflow_templates',
        sa.Column('current_version_id', postgresql.UUID(as_uuid=True), nullable=True),
    )

    # ── 4. Immutable definition versions (DM-01) ────────────────────────────
    op.create_table(
        'workflow_template_versions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('template_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('version_number', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('require_full_reapproval', sa.Boolean(), nullable=False,
                  server_default=sa.text('false')),
        sa.Column('created_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('stages_snapshot', postgresql.JSONB(astext_type=sa.Text()),
                  nullable=False, server_default='[]'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['template_id'], ['workflow_templates.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id']),
        sa.UniqueConstraint('template_id', 'version_number',
                            name='uq_wf_version_template_number'),
    )
    op.create_index('ix_workflow_template_versions_template_id',
                    'workflow_template_versions', ['template_id'])

    # Added only now that the target table exists (the two tables reference
    # each other, which is why the model declares this FK with use_alter).
    op.create_foreign_key(
        'fk_wft_current_version', 'workflow_templates',
        'workflow_template_versions', ['current_version_id'], ['id'],
    )

    # ── 5. Versioned stages (§5.5, §8) ──────────────────────────────────────
    op.create_table(
        'workflow_version_stages',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('approver_type', sa.String(length=30), nullable=False),
        sa.Column('approver_user_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('department_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('due_within_value', sa.Integer(), nullable=False),
        sa.Column('due_within_unit', sa.String(length=10), nullable=False,
                  server_default='days'),
        sa.Column('due_within_hours', sa.Integer(), nullable=False),
        sa.Column('require_signing', sa.Boolean(), nullable=False,
                  server_default=sa.text('false')),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['version_id'], ['workflow_template_versions.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['approver_user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id']),
        sa.UniqueConstraint('version_id', 'position', name='uq_wf_vstage_position'),
        sa.CheckConstraint('due_within_hours >= 1 AND due_within_hours <= 720',
                           name='ck_wf_vstage_due_within_hours'),
        sa.CheckConstraint(
            "approver_type IN ('specific_user', 'submitter_manager')",
            name='ck_wf_vstage_approver_type'),
        sa.CheckConstraint(
            "(approver_type = 'specific_user' AND approver_user_id IS NOT NULL)"
            " OR (approver_type = 'submitter_manager' AND approver_user_id IS NULL)",
            name='ck_wf_vstage_approver_presence'),
        sa.CheckConstraint("due_within_unit IN ('hours', 'days')",
                           name='ck_wf_vstage_due_within_unit'),
    )
    op.create_index('ix_workflow_version_stages_version_id',
                    'workflow_version_stages', ['version_id'])

    # ── 6. Per-user shares (§5.1, WF-OWN-*) ─────────────────────────────────
    op.create_table(
        'workflow_shares',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()'), nullable=False),
        sa.Column('template_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('grantee_user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('permission', sa.String(length=20), nullable=False,
                  server_default='USE'),
        sa.Column('granted_by', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('granted_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('revoked_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('chat_message_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['template_id'], ['workflow_templates.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['grantee_user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['granted_by'], ['users.id']),
        sa.ForeignKeyConstraint(['revoked_by'], ['users.id']),
        sa.ForeignKeyConstraint(['chat_message_id'], ['chat_messages.id'],
                                ondelete='SET NULL'),
    )
    op.create_index('ix_workflow_shares_template_id', 'workflow_shares', ['template_id'])
    op.create_index('ix_workflow_shares_grantee_user_id', 'workflow_shares',
                    ['grantee_user_id'])
    # Partial unique: at most one LIVE share per (workflow, user), while
    # revoked rows are kept for audit and never block a re-share. This makes
    # WF-OWN-07 ("sharing is idempotent") a database guarantee rather than a
    # check-then-insert race.
    op.create_index(
        'uq_workflow_share_active', 'workflow_shares',
        ['template_id', 'grantee_user_id'], unique=True,
        postgresql_where=sa.text('revoked_at IS NULL'),
    )
    op.create_index(
        'idx_workflow_share_grantee_active', 'workflow_shares', ['grantee_user_id'],
        postgresql_where=sa.text('revoked_at IS NULL'),
    )

    # ── 7. Backfill version 1 (see BACKFILL SCOPE above) ────────────────────
    _backfill_version_one()


def _backfill_version_one() -> None:
    """Give every representable existing template an immutable version 1.

    Reads the legacy tables and writes the new ones; it never modifies or
    deletes a legacy row. A template that cannot be represented exactly is
    skipped (left with current_version_id NULL) rather than approximated.
    """
    import json

    # --sql / offline mode emits DDL without a connection, so a data backfill
    # cannot be expressed there. The DDL above is complete on its own; the
    # backfill is a no-op until the migration is run against a real database.
    if context.is_offline_mode():
        print("[b7c8d9e0f1a2] offline mode: skipping the version-1 backfill")
        return

    conn = op.get_bind()

    templates = conn.execute(sa.text(
        "SELECT id, name, description, created_by"
        "  FROM workflow_templates"
        " WHERE deleted_at IS NULL"
    )).mappings().all()

    done = 0
    skipped: list[str] = []

    for tmpl in templates:
        stages = conn.execute(sa.text(
            "SELECT id, name, sequence_order, sla_hours, requires_signature"
            "  FROM workflow_stages"
            " WHERE template_id = :tid AND deleted_at IS NULL"
            " ORDER BY sequence_order"
        ), {"tid": tmpl["id"]}).mappings().all()

        if not stages:
            skipped.append("%s (no stages)" % tmpl["name"])
            continue

        rows = []
        representable = True
        for position, stage in enumerate(stages, start=1):
            rules = conn.execute(sa.text(
                "SELECT rule_type, rule_value FROM stage_approver_rules"
                " WHERE stage_id = :sid AND deleted_at IS NULL"
            ), {"sid": stage["id"]}).mappings().all()

            if len(rules) != 1:
                representable = False
                break
            rule_type = rules[0]["rule_type"]
            rule_value = rules[0]["rule_value"] or {}

            if rule_type == "specific_user":
                approver_type = "specific_user"
                approver_user_id = rule_value.get("user_id")
                if not approver_user_id:
                    representable = False
                    break
            elif rule_type == "manager_of_requester":
                approver_type = "submitter_manager"
                approver_user_id = None
            else:
                # role_in_department / dynamic_by_amount_threshold have no
                # equivalent in the two types §5.5 field B offers.
                representable = False
                break

            # Clamp the legacy SLA into the 1..720 hour range (O-5); NULL
            # becomes the §5.5 field D default of 2 days.
            hours = stage["sla_hours"] or 48
            hours = max(1, min(720, int(hours)))
            if hours % 24 == 0:
                value, unit = hours // 24, "days"
            else:
                value, unit = hours, "hours"

            rows.append({
                "position": position,
                "name": stage["name"],
                "approver_type": approver_type,
                "approver_user_id": approver_user_id,
                "due_within_value": value,
                "due_within_unit": unit,
                "due_within_hours": hours,
                "require_signing": bool(stage["requires_signature"]),
            })

        if not representable:
            skipped.append("%s (approver rule not representable)" % tmpl["name"])
            continue

        version_id = conn.execute(sa.text(
            "INSERT INTO workflow_template_versions"
            " (template_id, version_number, name, description, created_by,"
            "  stages_snapshot)"
            " VALUES (:tid, 1, :name, :descr, :cby, CAST(:snap AS jsonb))"
            " RETURNING id"
        ), {
            "tid": tmpl["id"],
            "name": tmpl["name"],
            "descr": tmpl["description"],
            "cby": tmpl["created_by"],
            "snap": json.dumps(rows, default=str),
        }).scalar_one()

        for row in rows:
            conn.execute(sa.text(
                "INSERT INTO workflow_version_stages"
                " (version_id, position, name, approver_type, approver_user_id,"
                "  due_within_value, due_within_unit, due_within_hours,"
                "  require_signing)"
                " VALUES (:vid, :pos, :name, :atype, CAST(:auid AS uuid),"
                "         :dval, :dunit, :dhours, :sign)"
            ), {
                "vid": version_id,
                "pos": row["position"],
                "name": row["name"],
                "atype": row["approver_type"],
                "auid": row["approver_user_id"],
                "dval": row["due_within_value"],
                "dunit": row["due_within_unit"],
                "dhours": row["due_within_hours"],
                "sign": row["require_signing"],
            })

        conn.execute(sa.text(
            "UPDATE workflow_templates SET current_version_id = :vid WHERE id = :tid"
        ), {"vid": version_id, "tid": tmpl["id"]})
        done += 1

    print("[b7c8d9e0f1a2] backfilled version 1 for %d template(s)" % done)
    if skipped:
        print("[b7c8d9e0f1a2] left on the legacy path (current_version_id NULL): %d"
              % len(skipped))
        for s in skipped:
            print("    - %s" % s)


def downgrade() -> None:
    # Drops only what upgrade() created. No pre-existing object is touched,
    # so a downgrade returns the schema exactly to revision f5a6b7c8d9e0.
    op.drop_constraint('fk_wft_current_version', 'workflow_templates',
                       type_='foreignkey')

    op.drop_index('idx_workflow_share_grantee_active', table_name='workflow_shares')
    op.drop_index('uq_workflow_share_active', table_name='workflow_shares')
    op.drop_index('ix_workflow_shares_grantee_user_id', table_name='workflow_shares')
    op.drop_index('ix_workflow_shares_template_id', table_name='workflow_shares')
    op.drop_table('workflow_shares')

    op.drop_index('ix_workflow_version_stages_version_id',
                  table_name='workflow_version_stages')
    op.drop_table('workflow_version_stages')

    op.drop_index('ix_workflow_template_versions_template_id',
                  table_name='workflow_template_versions')
    op.drop_table('workflow_template_versions')

    op.drop_column('workflow_templates', 'current_version_id')
    op.drop_column('workflow_templates', 'require_full_reapproval')
    op.drop_column('workflow_templates', 'status')

    op.drop_column('departments', 'requires_signature')

    op.drop_index('ix_users_manager_id', table_name='users')
    op.drop_constraint('fk_user_manager', 'users', type_='foreignkey')
    op.drop_column('users', 'manager_id')
