/**
 * DocFlow Frontend — Page: WorkflowTemplatesAdminPage (/admin/workflow-templates)
 * Admin workspace for creating and managing workflow templates: ordered
 * stages, each with approver rules (specific user / role in department /
 * manager of requester), SLA hours, and an e-signature requirement toggle.
 *
 * This page did not exist before. The backend has always fully supported
 * workflow-template CRUD (POST/GET/PATCH/DELETE /admin/workflow-templates),
 * but there was no frontend admin UI to use it — admins had no way to build
 * a custom workflow beyond whatever existed in the database already.
 *
 * NOTE: stage composition is immutable after creation (the backend's PATCH
 * only updates template metadata — name/description/active status — not
 * stages; this matches the "template snapshot" design: in-flight workflow
 * instances freeze their template at submit time). So "Edit" here only
 * covers metadata; building a *new* template is the only way to change
 * stages/approvers.
 */

import { useState } from 'react';
import {
  useAdminWorkflowTemplates,
  useAdminWorkflowTemplate,
  useCreateWorkflowTemplate,
  useUpdateWorkflowTemplate,
  useDeleteWorkflowTemplate,
} from '@/hooks/useAdminWorkflows';
import { useDepartments, useMembers } from '@/hooks/useOrg';
import type {
  ApproverRuleType,
  WorkflowStagePayload,
  WorkflowTemplateCreatePayload,
} from '@/lib/api/adminWorkflows';

function emptyStage(sequenceOrder: number): WorkflowStagePayload {
  return {
    name: '',
    sequence_order: sequenceOrder,
    stage_type: 'sequential',
    min_approvals_required: 1,
    requires_signature: false,
    approver_rules: [{ rule_type: 'specific_user', rule_value: { user_id: '' } }],
  };
}

export default function WorkflowTemplatesAdminPage() {
  const { data: templates = [], isLoading } = useAdminWorkflowTemplates({ active_only: false });
  const createTemplate = useCreateWorkflowTemplate();
  const updateTemplate = useUpdateWorkflowTemplate();
  const deleteTemplate = useDeleteWorkflowTemplate();
  // Approver-eligible members only — Trainees must never appear in an
  // approver picker (they have no approval/signing authority; the backend
  // rejects a specific_user rule targeting a trainee anyway, but filtering
  // here keeps the admin from picking one in the first place). Uses the
  // admin-only GET /orgs/me/members (unlike the lightweight /chat/members
  // DM picker) specifically because it includes each member's role.
  const { data: membersPage } = useMembers({ limit: 100 });
  const members = (membersPage?.items ?? []).filter((m) => m.role?.name !== 'trainee');
  const { data: departments = [] } = useDepartments(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const { data: viewingTemplate } = useAdminWorkflowTemplate(viewingId ?? undefined);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stages, setStages] = useState<WorkflowStagePayload[]>([emptyStage(1)]);
  const [error, setError] = useState('');

  const openNewModal = () => {
    setName('');
    setDescription('');
    setStages([emptyStage(1)]);
    setError('');
    setModalOpen(true);
  };

  const addStage = () => {
    setStages((prev) => [...prev, emptyStage(prev.length + 1)]);
  };

  const removeStage = (index: number) => {
    setStages((prev) =>
      prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, sequence_order: i + 1 })),
    );
  };

  const updateStage = (index: number, changes: Partial<WorkflowStagePayload>) => {
    setStages((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...changes };
      return next;
    });
  };

  const updateRule = (stageIndex: number, ruleType: ApproverRuleType, userId: string, roleName: string, deptId: string) => {
    const rule_value: Record<string, string | undefined> =
      ruleType === 'specific_user'
        ? { user_id: userId }
        : ruleType === 'role_in_department'
          ? { role_name: roleName, dept_id: deptId || undefined }
          : {};
    updateStage(stageIndex, {
      approver_rules: [{ rule_type: ruleType, rule_value }],
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Template name is required.');
      return;
    }
    for (const [i, stage] of stages.entries()) {
      if (!stage.name.trim()) {
        setError(`Stage ${i + 1} needs a name.`);
        return;
      }
      const rule = stage.approver_rules[0];
      if (rule.rule_type === 'specific_user' && !rule.rule_value.user_id) {
        setError(`Stage ${i + 1}: pick who approves this stage.`);
        return;
      }
      if (rule.rule_type === 'role_in_department' && !rule.rule_value.role_name) {
        setError(`Stage ${i + 1}: enter a role name (e.g. "manager").`);
        return;
      }
    }

    const payload: WorkflowTemplateCreatePayload = {
      name: name.trim(),
      description: description.trim() || undefined,
      is_active: true,
      stages,
    };

    try {
      await createTemplate.mutateAsync(payload);
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow template.');
    }
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    await updateTemplate.mutateAsync({ id, data: { is_active: !isActive } });
  };

  const handleDelete = async (id: string, templateName: string) => {
    if (window.confirm(`Delete workflow template "${templateName}"? This cannot be undone.`)) {
      await deleteTemplate.mutateAsync(id);
    }
  };

  return (
    <div style={{ padding: '32px', maxWidth: '1280px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h1 data-page-title className="font-display" style={{ fontSize: 'clamp(1.75rem, 1.2rem + 2vw, 2.4rem)', fontWeight: 400, lineHeight: 1.1, color: 'var(--foreground)', marginBottom: '6px' }}>
            Workflow Templates
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
            Define approval stages and who approves each one. Documents pick a template at submit time.
          </p>
        </div>
        <button onClick={openNewModal} className="btn btn-primary" style={{ padding: '10px 22px' }}>
          + New Workflow Template
        </button>
      </div>

      <div className="glass-card" style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '700px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-overlay)', color: 'var(--text-secondary)', fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <th style={{ padding: '14px 20px' }}>Name</th>
                <th style={{ padding: '14px 20px' }}>Version</th>
                <th style={{ padding: '14px 20px' }}>Status</th>
                <th style={{ padding: '14px 20px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={4} style={{ padding: '64px', textAlign: 'center' }}><div className="spinner" style={{ width: '32px', height: '32px', margin: '0 auto' }} /></td></tr>
              ) : templates.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: '64px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  No workflow templates yet. Click "+ New Workflow Template" to define one.
                </td></tr>
              ) : (
                templates.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '16px 20px', fontWeight: 700, color: 'var(--text-primary)' }}>{t.name}</td>
                    <td style={{ padding: '16px 20px', color: 'var(--text-secondary)' }}>v{t.version}</td>
                    <td style={{ padding: '16px 20px' }}>
                      <button
                        onClick={() => handleToggleActive(t.id, t.is_active)}
                        style={{
                          padding: '4px 10px', borderRadius: 'var(--radius-full)', fontSize: '0.75rem', fontWeight: 700,
                          cursor: 'pointer', border: 'none',
                          background: t.is_active ? 'color-mix(in srgb, var(--status-approved) 15%, transparent)' : 'color-mix(in srgb, var(--muted-foreground) 15%, transparent)',
                          color: t.is_active ? 'var(--color-success-400)' : 'var(--text-muted)',
                        }}
                      >
                        {t.is_active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td style={{ padding: '16px 20px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        <button onClick={() => setViewingId(t.id)} className="btn btn-ghost btn-sm" style={{ fontSize: '0.78rem' }}>
                          View Stages
                        </button>
                        <button onClick={() => handleDelete(t.id, t.name)} className="btn btn-ghost btn-sm" style={{ fontSize: '0.78rem', color: 'var(--color-error-400)' }}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* View Stages Modal (read-only — stages are immutable after creation) */}
      {viewingId && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={() => setViewingId(null)} style={{ position: 'absolute', inset: 0, background: 'var(--overlay-scrim)', backdropFilter: 'blur(6px)' }} />
          <div className="glass-card" style={{ position: 'relative', width: '94%', maxWidth: 640, maxHeight: '80vh', overflowY: 'auto', padding: 28, borderRadius: 'var(--radius-xl)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>
                {viewingTemplate?.name ?? 'Loading...'}
              </h2>
              <button onClick={() => setViewingId(null)} style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%' }}>✕</button>
            </div>
            {viewingTemplate?.description && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', marginBottom: 20 }}>{viewingTemplate.description}</p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {(viewingTemplate?.stages ?? []).sort((a, b) => a.sequence_order - b.sequence_order).map((s) => (
                <div key={s.id} style={{ padding: '14px 16px', background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)' }}>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.92rem' }}>
                    {s.sequence_order}. {s.name}
                    {s.requires_signature && <span style={{ marginLeft: 8, fontSize: '0.7rem', color: 'var(--color-warning-400)' }}>✍️ Signature required</span>}
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>
                    {s.min_approvals_required} approval(s) needed{s.sla_hours ? ` · SLA ${s.sla_hours}h` : ''}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 6 }}>
                    {s.approver_rules.map((r, i) => (
                      <div key={i}>
                        {r.rule_type === 'specific_user' && `Approver: ${members.find((m) => m.user_id === r.rule_value.user_id)?.user?.name ?? r.rule_value.user_id}`}
                        {r.rule_type === 'role_in_department' && `Approver: anyone with role "${r.rule_value.role_name}"${r.rule_value.dept_id ? ' in department' : ''}`}
                        {r.rule_type === 'manager_of_requester' && 'Approver: the submitter\'s manager'}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {modalOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={() => setModalOpen(false)} style={{ position: 'absolute', inset: 0, background: 'var(--overlay-scrim)', backdropFilter: 'blur(6px)' }} />
          <div className="glass-card" style={{ position: 'relative', width: '94%', maxWidth: 760, maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderRadius: 'var(--radius-xl)', overflow: 'hidden' }}>
            <div style={{ padding: '20px 28px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--text-primary)' }}>New Workflow Template</h2>
              <button onClick={() => setModalOpen(false)} style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%' }}>✕</button>
            </div>

            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
              <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
                {error && (
                  <div style={{ padding: '12px 16px', background: 'color-mix(in srgb, var(--destructive) 12%, transparent)', border: '1px solid var(--color-error-400)', borderRadius: 'var(--radius-md)', color: 'var(--color-error-400)', fontSize: '0.85rem', fontWeight: 600 }}>
                    ⚠️ {error}
                  </div>
                )}

                <div>
                  <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Template Name <span style={{ color: 'var(--color-error-400)' }}>*</span>
                  </label>
                  <input type="text" className="input" placeholder="e.g. Purchase Order Approval" value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                    Description
                  </label>
                  <input type="text" className="input" placeholder="When should this template be used?" value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--border-subtle)' }}>
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 800, color: 'var(--text-primary)' }}>Stages ({stages.length})</h3>
                    <button type="button" onClick={addStage} className="btn btn-secondary btn-sm">+ Add Stage</button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {stages.map((stage, i) => (
                      <div key={i} style={{ padding: '16px 18px', background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <div style={{ flex: '1 1 200px' }}>
                            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Stage {i + 1} Name</label>
                            <input type="text" className="input" placeholder="e.g. Manager Approval" value={stage.name} onChange={(e) => updateStage(i, { name: e.target.value })} style={{ fontSize: '0.85rem' }} />
                          </div>
                          <div style={{ width: 130 }}>
                            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>SLA (hours)</label>
                            <input type="number" className="input" placeholder="Optional" value={stage.sla_hours ?? ''} onChange={(e) => updateStage(i, { sla_hours: e.target.value ? Number(e.target.value) : undefined })} style={{ fontSize: '0.85rem' }} />
                          </div>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', fontWeight: 600, paddingBottom: 8, whiteSpace: 'nowrap' }}>
                            <input type="checkbox" checked={!!stage.requires_signature} onChange={(e) => updateStage(i, { requires_signature: e.target.checked })} />
                            Requires signature
                          </label>
                          {stages.length > 1 && (
                            <button type="button" onClick={() => removeStage(i)} className="btn btn-ghost btn-sm" style={{ color: 'var(--color-error-400)' }}>✕ Remove</button>
                          )}
                        </div>

                        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
                          <div style={{ width: 200 }}>
                            <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Approver Rule</label>
                            <select
                              className="input"
                              value={stage.approver_rules[0].rule_type}
                              onChange={(e) => updateRule(i, e.target.value as ApproverRuleType, '', '', '')}
                              style={{ fontSize: '0.85rem' }}
                            >
                              <option value="specific_user">Specific person</option>
                              <option value="role_in_department">Anyone with a role</option>
                              <option value="manager_of_requester">Submitter's manager</option>
                            </select>
                          </div>

                          {stage.approver_rules[0].rule_type === 'specific_user' && (
                            <div style={{ flex: '1 1 220px' }}>
                              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Approver</label>
                              <select
                                className="input"
                                value={stage.approver_rules[0].rule_value.user_id ?? ''}
                                onChange={(e) => updateRule(i, 'specific_user', e.target.value, '', '')}
                                style={{ fontSize: '0.85rem' }}
                              >
                                <option value="">Select a person...</option>
                                {members.map((m) => (
                                  <option key={m.user_id} value={m.user_id}>{m.user?.name ?? m.user?.email} ({m.user?.email})</option>
                                ))}
                              </select>
                            </div>
                          )}

                          {stage.approver_rules[0].rule_type === 'role_in_department' && (
                            <>
                              <div style={{ flex: '1 1 150px' }}>
                                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Role</label>
                                <select
                                  className="input"
                                  value={stage.approver_rules[0].rule_value.role_name ?? ''}
                                  onChange={(e) => updateRule(i, 'role_in_department', '', e.target.value, stage.approver_rules[0].rule_value.dept_id ?? '')}
                                  style={{ fontSize: '0.85rem' }}
                                >
                                  <option value="">Select a role...</option>
                                  <option value="admin">Main Admin</option>
                                  <option value="hr">HR</option>
                                  <option value="worker">Worker</option>
                                  {/* Trainee intentionally omitted — never a valid approver role. */}
                                </select>
                              </div>
                              <div style={{ width: 180 }}>
                                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>Department (optional)</label>
                                <select
                                  className="input"
                                  value={stage.approver_rules[0].rule_value.dept_id ?? ''}
                                  onChange={(e) => updateRule(i, 'role_in_department', '', stage.approver_rules[0].rule_value.role_name ?? '', e.target.value)}
                                  style={{ fontSize: '0.85rem' }}
                                >
                                  <option value="">Any department</option>
                                  {departments.map((d) => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                  ))}
                                </select>
                              </div>
                            </>
                          )}

                          {stage.approver_rules[0].rule_type === 'manager_of_requester' && (
                            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', paddingBottom: 8 }}>
                              Routes to whoever is set as the submitter's manager (department head).
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ padding: '16px 28px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-card)', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={createTemplate.isPending} style={{ padding: '10px 24px', fontWeight: 700 }}>
                  {createTemplate.isPending ? 'Creating...' : 'Create Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
