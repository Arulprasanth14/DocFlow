/**
 * DocFlow Frontend — Component: SubmitWorkflowModal
 *
 * The "configure and review the approval workflow before submitting" step.
 * Requirements this satisfies:
 *  - Pick which workflow template (approvers + their sequence) governs this
 *    document — WorkflowTemplate stages are admin-authored and ordered, so
 *    "configure the approval sequence" here means selecting the template
 *    that encodes the sequence you want, not building one ad hoc per
 *    document (there is no per-document approver override in this system).
 *  - Review the resulting approvers/sequence and the final deadline before
 *    being allowed to submit.
 *  - Require an explicit confirmation checkbox before the Submit button
 *    enables, to prevent accidental submission.
 */

import { useEffect, useState } from 'react';
import { useWorkflowTemplates, useWorkflowTemplateReview } from '@/hooks/useWorkflows';

interface SubmitWorkflowModalProps {
  open: boolean;
  documentTitle: string;
  initialDueAt?: string | null;
  onCancel: () => void;
  onConfirm: (params: { workflowTemplateId: string; dueAt: string | null }) => Promise<void>;
  isSubmitting: boolean;
}

export default function SubmitWorkflowModal({
  open,
  documentTitle,
  initialDueAt,
  onCancel,
  onConfirm,
  isSubmitting,
}: SubmitWorkflowModalProps) {
  const [templateId, setTemplateId] = useState('');
  const [dueAt, setDueAt] = useState(initialDueAt ? initialDueAt.slice(0, 10) : '');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: templates = [], isLoading: templatesLoading } = useWorkflowTemplates({ active_only: true });
  const { data: review, isLoading: reviewLoading } = useWorkflowTemplateReview(templateId || undefined);

  // Re-require confirmation whenever the selected template (and therefore
  // the workflow being reviewed) changes.
  useEffect(() => {
    setConfirmed(false);
  }, [templateId]);

  useEffect(() => {
    if (open) {
      setError(null);
      setTemplateId('');
      setConfirmed(false);
      setDueAt(initialDueAt ? initialDueAt.slice(0, 10) : '');
    }
  }, [open, initialDueAt]);

  if (!open) return null;

  const canSubmit = !!templateId && confirmed && !isSubmitting && !reviewLoading;

  const handleConfirmClick = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      await onConfirm({ workflowTemplateId: templateId, dueAt: dueAt ? new Date(dueAt).toISOString() : null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit document.');
    }
  };

  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, background: 'hsla(220, 50%, 5%, 0.7)', backdropFilter: 'blur(4px)', zIndex: 200 }}
        onClick={onCancel}
      />
      <div
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: '100%', maxWidth: '560px', maxHeight: '88vh', overflowY: 'auto', zIndex: 201,
        }}
      >
        <div className="glass-card" style={{ padding: '28px' }} role="dialog" aria-modal="true">
          <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
            Configure &amp; Review Approval Workflow
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '20px' }}>
            "{documentTitle}"
          </p>

          {/* Template picker */}
          <div style={{ marginBottom: '18px' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
              Approval Workflow <span style={{ color: 'var(--color-error-400)' }}>*</span>
            </label>
            {templatesLoading ? (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Loading workflows...</div>
            ) : templates.length === 0 ? (
              <div style={{
                padding: '12px 14px', borderRadius: 'var(--radius-md)',
                background: 'hsla(38, 92%, 50%, 0.1)', border: '1px solid hsla(38, 92%, 50%, 0.25)',
                color: 'var(--color-warning-400)', fontSize: '0.85rem',
              }}>
                No approval workflows exist in your organization yet. Ask an admin to
                create one under Admin → Workflow Templates before you can submit.
              </div>
            ) : (
              <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">— Select a workflow —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Review panel */}
          {templateId && (
            <div style={{ marginBottom: '18px' }}>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                Approval Sequence
              </label>
              {reviewLoading ? (
                <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Loading approvers...</div>
              ) : review ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {review.stages.map((stage, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: '10px',
                        padding: '10px 12px', borderRadius: 'var(--radius-md)',
                        background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)',
                      }}
                    >
                      <span style={{
                        flexShrink: 0, width: '22px', height: '22px', borderRadius: '50%',
                        background: 'var(--color-primary-500)', color: 'white',
                        fontSize: '0.75rem', fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {i + 1}
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-primary)' }}>
                          {stage.name}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                          Approver: {stage.approver_summary}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                          {stage.sla_hours ? `SLA: ${stage.sla_hours}h` : 'No SLA set'}
                          {stage.requires_signature ? ' · Requires e-signature' : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                  {review.stages.length === 0 && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--color-warning-400)' }}>
                      This workflow has no stages configured — it cannot be used to approve documents.
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {/* Deadline */}
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
              Final Deadline (Optional)
            </label>
            <input
              type="date"
              className="input"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </div>

          {/* Confirmation checkbox */}
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '20px',
            padding: '12px 14px', borderRadius: 'var(--radius-md)',
            background: confirmed ? 'hsla(145, 70%, 45%, 0.08)' : 'var(--bg-overlay)',
            border: `1px solid ${confirmed ? 'hsla(145, 70%, 45%, 0.3)' : 'var(--border-subtle)'}`,
            cursor: templateId ? 'pointer' : 'not-allowed', opacity: templateId ? 1 : 0.5,
          }}>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!templateId}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: '2px' }}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>
              I confirm that the document and its approval workflow details are correct,
              and I want to submit this document.
            </span>
          </label>

          {error && (
            <div style={{
              marginBottom: '16px', padding: '12px 16px', borderRadius: 'var(--radius-md)',
              background: 'hsla(0, 82%, 55%, 0.1)', border: '1px solid hsla(0, 82%, 55%, 0.25)',
              color: 'var(--color-error-400)', fontSize: '0.875rem',
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={handleConfirmClick} disabled={!canSubmit}>
              {isSubmitting ? 'Submitting...' : 'Submit for Approval'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
