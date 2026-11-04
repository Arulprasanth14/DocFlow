/**
 * DocFlow Frontend — Workflow builder (§7)
 *
 * "Users must be able to define reusable workflows that describe the
 *  approval route for their documents. A user can create multiple
 *  workflows, give each a meaningful name, and choose which people or roles
 *  should receive the document at each step."
 *
 * Available to EVERY role (§2.5 "Create and manage own workflows: Yes" for
 * Main Admin, HR, Worker and Trainee) — not just administrators. Editing is
 * restricted to the owner or an org admin, which the backend enforces.
 *
 * Validation is intentionally NOT duplicated here beyond the obviously
 * local checks: the backend's TemplateService.validate_definition is the
 * authority (missing approvers, unsatisfiable approval gates, approvers who
 * aren't org members, trainees as approvers) and its message is shown
 * verbatim, so the rules can't drift between client and server.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X, Plus, Trash2, GripVertical, AlertCircle, Loader2, Users,
  ShieldCheck, Clock, Info,
} from 'lucide-react';
import {
  workflowsApi,
  type ApproverRuleType,
  type WorkflowStageInput,
  type WorkflowTemplateInput,
} from '@/lib/api/workflows';
import { useMembers } from '@/hooks/useOrg';

const C = {
  card: 'var(--bg-elevated)',
  surface: 'var(--bg-surface)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  disabled: 'var(--text-disabled)',
};

/** Trainees are never selectable as approvers (§2.4) — the backend rejects
 *  it too, this just keeps them out of the picker. */
const APPROVER_ROLES = [
  { value: 'admin', label: 'Main Admin' },
  { value: 'hr', label: 'HR' },
  { value: 'worker', label: 'Worker' },
];

const RULE_LABELS: { value: ApproverRuleType; label: string; hint: string }[] = [
  { value: 'specific_user', label: 'A specific person', hint: 'Always routes to one named member' },
  { value: 'role_in_department', label: 'Anyone with a role', hint: 'First available holder of that role' },
  { value: 'manager_of_requester', label: "The submitter's manager", hint: 'Resolved at submit time' },
];

function emptyStage(order: number): WorkflowStageInput {
  return {
    name: order === 1 ? 'Review' : `Stage ${order}`,
    sequence_order: order,
    stage_type: 'sequential',
    min_approvals_required: 1,
    sla_hours: null,
    reapproval_on_revision: false,
    requires_signature: false,
    approver_rules: [{ rule_type: 'specific_user', rule_value: {} }],
  };
}

export default function WorkflowBuilderModal({
  templateId,
  onClose,
}: {
  /** Omit to create a new workflow; pass an id to edit an existing one. */
  templateId?: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!templateId;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'organization'>('private');
  const [stages, setStages] = useState<WorkflowStageInput[]>([emptyStage(1)]);
  const [error, setError] = useState<string | null>(null);

  // Members for the "specific person" picker, minus trainees.
  const { data: membersData } = useMembers({ page: 1, limit: 100 });
  const approverCandidates = useMemo(
    () => (membersData?.items ?? []).filter((m) => m.role?.name !== 'trainee'),
    [membersData],
  );

  // Load the existing definition when editing, so the form is prefilled
  // with the real stages/rules rather than starting blank.
  const { data: existing, isLoading: loadingExisting } = useQuery({
    queryKey: ['workflow-template', 'detail', templateId],
    queryFn: () => workflowsApi.getWorkflow(templateId as string),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? '');
    setVisibility(existing.visibility === 'private' ? 'private' : 'organization');
    setStages(
      [...existing.stages]
        .sort((a, b) => a.sequence_order - b.sequence_order)
        .map((s) => ({
          name: s.name,
          sequence_order: s.sequence_order,
          stage_type: (s.stage_type as WorkflowStageInput['stage_type']) ?? 'sequential',
          min_approvals_required: s.min_approvals_required,
          sla_hours: s.sla_hours,
          reapproval_on_revision: s.reapproval_on_revision,
          requires_signature: s.requires_signature,
          approver_rules: s.approver_rules.length
            ? s.approver_rules.map((r) => ({
                rule_type: r.rule_type as ApproverRuleType,
                rule_value: r.rule_value ?? {},
              }))
            : [{ rule_type: 'specific_user' as ApproverRuleType, rule_value: {} }],
        })),
    );
  }, [existing]);

  const saveM = useMutation({
    mutationFn: () => {
      const payload: WorkflowTemplateInput = {
        name: name.trim(),
        description: description.trim() || null,
        stages: stages.map((s, i) => ({ ...s, sequence_order: i + 1 })),
      };
      return isEdit
        ? workflowsApi.updateWorkflow(templateId as string, payload)
        : workflowsApi.createWorkflow(payload, visibility);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflowTemplates'] });
      queryClient.invalidateQueries({ queryKey: ['workflow-templates'] });
      onClose();
    },
    // Surface the backend's validation message verbatim — it names the
    // exact stage and problem.
    onError: (e: Error) => setError(e.message),
  });

  const updateStage = (idx: number, patch: Partial<WorkflowStageInput>) =>
    setStages((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  const updateRule = (
    stageIdx: number,
    ruleIdx: number,
    rule_type: ApproverRuleType,
    rule_value: Record<string, unknown>,
  ) =>
    setStages((prev) =>
      prev.map((s, i) =>
        i !== stageIdx
          ? s
          : {
              ...s,
              approver_rules: s.approver_rules.map((r, j) =>
                j === ruleIdx ? { rule_type, rule_value } : r,
              ),
            },
      ),
    );

  const addRule = (stageIdx: number) =>
    setStages((prev) =>
      prev.map((s, i) =>
        i !== stageIdx
          ? s
          : {
              ...s,
              approver_rules: [
                ...s.approver_rules,
                { rule_type: 'specific_user' as ApproverRuleType, rule_value: {} },
              ],
            },
      ),
    );

  const removeRule = (stageIdx: number, ruleIdx: number) =>
    setStages((prev) =>
      prev.map((s, i) =>
        i !== stageIdx
          ? s
          : { ...s, approver_rules: s.approver_rules.filter((_, j) => j !== ruleIdx) },
      ),
    );

  const localProblem = useMemo(() => {
    if (!name.trim()) return 'Give the workflow a name.';
    if (!stages.length) return 'Add at least one stage.';
    for (const [i, s] of stages.entries()) {
      if (!s.name.trim()) return `Stage ${i + 1} needs a name.`;
      if (!s.approver_rules.length) return `“${s.name}” has no approvers.`;
      for (const r of s.approver_rules) {
        if (r.rule_type === 'specific_user' && !r.rule_value.user_id)
          return `“${s.name}” has a person rule with nobody selected.`;
        if (r.rule_type === 'role_in_department' && !r.rule_value.role_name)
          return `“${s.name}” has a role rule with no role selected.`;
      }
      if ((s.min_approvals_required ?? 1) > s.approver_rules.length)
        return `“${s.name}” needs ${s.min_approvals_required} approvals but has only ${s.approver_rules.length} approver rule(s).`;
    }
    return null;
  }, [name, stages]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'var(--overlay-scrim)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)', maxHeight: '90vh', overflowY: 'auto',
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 18, padding: 24,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
          <div>
            <h2 style={{ fontSize: 19, fontWeight: 800, color: C.heading, margin: 0 }}>
              {isEdit ? 'Edit workflow' : 'New workflow'}
            </h2>
            <p style={{ fontSize: 12.5, color: C.muted, marginTop: 4, marginBottom: 0 }}>
              Define the ordered approval route. You can reuse this workflow
              whenever you submit a document.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: C.overlay, border: `1px solid ${C.borderSubtle}`,
              borderRadius: 8, width: 30, height: 30, cursor: 'pointer',
              color: C.muted, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexShrink: 0,
            }}
          >
            <X size={15} />
          </button>
        </div>

        {isEdit && loadingExisting && (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Loader2 size={18} color={C.muted} className="wbspin" />
          </div>
        )}

        {isEdit && (
          <div
            style={{
              marginBottom: 16, padding: '10px 12px', borderRadius: 10,
              background: `color-mix(in srgb, ${C.primary400} 8%, transparent)`,
              border: `1px solid color-mix(in srgb, ${C.primary400} 25%, transparent)`,
              fontSize: 12, color: C.body, display: 'flex', gap: 8,
            }}
          >
            <Info size={13} color={C.primary400} style={{ flexShrink: 0, marginTop: 1 }} />
            Saving creates a new version of this workflow. Documents already in
            flight keep running against the version they were submitted with.
          </div>
        )}

        {/* Basics */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
          <label>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
              Workflow name *
            </span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Purchase approval over 5k"
            />
          </label>
          <label>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
              Who can use it
            </span>
            <select
              className="input"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as 'private' | 'organization')}
              disabled={isEdit}
            >
              <option value="private">Only me (private)</option>
              <option value="organization">Everyone in my organization</option>
            </select>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            <span style={{ display: 'block', fontSize: 11.5, color: C.muted, marginBottom: 5 }}>
              Description
            </span>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this route for?"
            />
          </label>
        </div>

        {/* Stages */}
        <div
          style={{
            fontSize: 10.5, fontWeight: 700, letterSpacing: 0.7,
            textTransform: 'uppercase', color: C.muted, marginBottom: 8,
          }}
        >
          Approval stages — in order
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }}>
          {stages.map((stage, idx) => (
            <div
              key={idx}
              style={{
                background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: '13px 15px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11 }}>
                <GripVertical size={14} color={C.disabled} />
                <span
                  style={{
                    fontSize: 10.5, fontWeight: 800, color: C.primary400,
                    background: `color-mix(in srgb, ${C.primary400} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${C.primary400} 28%, transparent)`,
                    borderRadius: 6, padding: '2px 7px',
                  }}
                >
                  STEP {idx + 1}
                </span>
                <input
                  className="input"
                  value={stage.name}
                  onChange={(e) => updateStage(idx, { name: e.target.value })}
                  placeholder="Stage name"
                  style={{ flex: 1, fontSize: 13 }}
                />
                {stages.length > 1 && (
                  <button
                    onClick={() => setStages((p) => p.filter((_, i) => i !== idx))}
                    className="btn btn-ghost btn-sm"
                    style={{ color: C.danger, padding: 6 }}
                    title="Remove stage"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {/* Approver rules */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {stage.approver_rules.map((rule, rIdx) => (
                  <div key={rIdx} style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                    <select
                      className="input"
                      value={rule.rule_type}
                      onChange={(e) =>
                        updateRule(idx, rIdx, e.target.value as ApproverRuleType, {})
                      }
                      style={{ fontSize: 12.5, flex: '0 0 190px' }}
                    >
                      {RULE_LABELS.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>

                    {rule.rule_type === 'specific_user' && (
                      <select
                        className="input"
                        value={(rule.rule_value.user_id as string) ?? ''}
                        onChange={(e) =>
                          updateRule(idx, rIdx, 'specific_user', { user_id: e.target.value })
                        }
                        style={{ fontSize: 12.5, flex: 1 }}
                      >
                        <option value="">Select a person…</option>
                        {approverCandidates.map((m) => (
                          <option key={m.user_id} value={m.user_id}>
                            {m.user?.name ?? m.user?.email} ({m.role?.name})
                          </option>
                        ))}
                      </select>
                    )}

                    {rule.rule_type === 'role_in_department' && (
                      <select
                        className="input"
                        value={(rule.rule_value.role_name as string) ?? ''}
                        onChange={(e) =>
                          updateRule(idx, rIdx, 'role_in_department', {
                            role_name: e.target.value,
                          })
                        }
                        style={{ fontSize: 12.5, flex: 1 }}
                      >
                        <option value="">Select a role…</option>
                        {APPROVER_ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    )}

                    {rule.rule_type === 'manager_of_requester' && (
                      <span style={{ flex: 1, fontSize: 12, color: C.muted }}>
                        Resolved from the submitter's department at submit time
                      </span>
                    )}

                    {stage.approver_rules.length > 1 && (
                      <button
                        onClick={() => removeRule(idx, rIdx)}
                        className="btn btn-ghost btn-sm"
                        style={{ color: C.danger, padding: 5 }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <button
                onClick={() => addRule(idx)}
                className="btn btn-ghost btn-sm"
                style={{ fontSize: 11.5, gap: 5, marginTop: 8 }}
              >
                <Plus size={11} /> Add another approver
              </button>

              {/* Stage options */}
              <div
                style={{
                  display: 'flex', gap: 16, marginTop: 12, paddingTop: 11,
                  borderTop: `1px solid ${C.borderSubtle}`, flexWrap: 'wrap',
                }}
              >
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.body }}>
                  <Users size={12} color={C.muted} />
                  Approvals needed
                  <input
                    type="number"
                    min={1}
                    max={stage.approver_rules.length}
                    value={stage.min_approvals_required ?? 1}
                    onChange={(e) =>
                      updateStage(idx, { min_approvals_required: Number(e.target.value) })
                    }
                    className="input"
                    style={{ width: 58, fontSize: 12, padding: '4px 7px' }}
                  />
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.body }}>
                  <Clock size={12} color={C.muted} />
                  Due within (hours)
                  <input
                    type="number"
                    min={1}
                    value={stage.sla_hours ?? ''}
                    onChange={(e) =>
                      updateStage(idx, {
                        sla_hours: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    className="input"
                    placeholder="—"
                    style={{ width: 70, fontSize: 12, padding: '4px 7px' }}
                  />
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.body }}>
                  <input
                    type="checkbox"
                    checked={!!stage.requires_signature}
                    onChange={(e) => updateStage(idx, { requires_signature: e.target.checked })}
                  />
                  <ShieldCheck size={12} color={C.muted} />
                  Require a signing step
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.body }}>
                  <input
                    type="checkbox"
                    checked={!!stage.reapproval_on_revision}
                    onChange={(e) =>
                      updateStage(idx, { reapproval_on_revision: e.target.checked })
                    }
                  />
                  Re-approve after a revision
                </label>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => setStages((p) => [...p, emptyStage(p.length + 1)])}
          className="btn btn-ghost btn-sm"
          style={{ gap: 6, fontSize: 12.5, marginBottom: 18 }}
        >
          <Plus size={13} /> Add stage
        </button>

        {(error || localProblem) && (
          <div
            style={{
              marginBottom: 14, padding: '11px 13px', borderRadius: 10,
              background: `color-mix(in srgb, ${error ? C.danger : C.warning} 9%, transparent)`,
              border: `1px solid color-mix(in srgb, ${error ? C.danger : C.warning} 28%, transparent)`,
              fontSize: 12.5, color: C.body, display: 'flex', gap: 8,
            }}
          >
            <AlertCircle
              size={14}
              color={error ? C.danger : C.warning}
              style={{ flexShrink: 0, marginTop: 1 }}
            />
            {error || localProblem}
          </div>
        )}

        <div style={{ display: 'flex', gap: 9, justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="btn btn-ghost btn-sm">
            Cancel
          </button>
          <button
            onClick={() => {
              setError(null);
              saveM.mutate();
            }}
            disabled={!!localProblem || saveM.isPending}
            className="btn btn-primary btn-sm"
            style={{ gap: 7 }}
          >
            {saveM.isPending && <Loader2 size={13} className="wbspin" />}
            {isEdit ? 'Save new version' : 'Create workflow'}
          </button>
        </div>

        <style>{`
          .wbspin { animation: wbspin 0.9s linear infinite; }
          @keyframes wbspin { to { transform: rotate(360deg); } }
        `}</style>
      </div>
    </div>
  );
}
