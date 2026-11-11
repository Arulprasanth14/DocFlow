/**
 * Owner's approval progress — WF-REV-01/02, BR-15. Task P3-14.
 *
 * Where the document is, step by step, and who has it. Every value comes
 * from the server's stage instances: the stored approver, the status, the
 * due time. Nothing here computes a deadline or decides what is late
 * (BR-13, AP-SLA-07).
 *
 * The lock notice states BR-15 in words — the file cannot be changed while
 * it is under review — so the owner reads it here rather than discovering it
 * from a refused save.
 */
import { AlertTriangle, Check, Clock, Lock, MessageSquare, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { apiClient } from '@/lib/api/client';
import { useAuthStore } from '@/store/authStore';

interface ProgressStage {
  position: number;
  stage_name: string;
  status: string;
  approver_name: string | null;
  due_at: string | null;
  completed_at: string | null;
  round_count: number;
  signing_required: boolean;
  blocked_reason: string | null;
  is_current: boolean;
}

interface DocumentProgress {
  document_id: string;
  instance_id: string | null;
  run_status: string | null;
  workflow_name: string | null;
  cycle: number;
  stages: ProgressStage[];
  locked: boolean;
  locked_reason: string | null;
}

const LOOK: Record<string, { label: string; color: string }> = {
  pending: { label: 'Waiting', color: 'var(--text-muted)' },
  active: { label: 'In review', color: 'var(--accent-primary)' },
  awaiting_signature: { label: 'Awaiting signature', color: 'var(--accent-primary)' },
  changes_requested: { label: 'Changes requested', color: 'var(--warning)' },
  approved: { label: 'Approved', color: 'var(--success, #16a34a)' },
  rejected: { label: 'Rejected', color: 'var(--danger)' },
  blocked: { label: 'Blocked — needs reassignment', color: 'var(--warning)' },
};

function Glyph({ status }: { status: string }) {
  if (status === 'approved') return <Check size={12} />;
  if (status === 'rejected') return <X size={12} />;
  if (status === 'changes_requested') return <MessageSquare size={12} />;
  if (status === 'blocked') return <AlertTriangle size={12} />;
  if (status === 'active' || status === 'awaiting_signature') return <Clock size={12} />;
  return null;
}

export function ProgressTimeline({ documentId }: { documentId: string }) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  const progressQ = useQuery({
    queryKey: ['documents', 'progress', documentId] as const,
    queryFn: () =>
      apiClient.get<DocumentProgress>(`/approvals/documents/${documentId}/progress`),
    enabled: isAuthenticated && !!documentId,
    staleTime: 1000 * 20,
    retry: false,
  });

  const data = progressQ.data;
  // No run, or a run from before stage instances existed: nothing to draw,
  // and an empty card would be a control that leads nowhere.
  if (!data || data.stages.length === 0) return null;

  return (
    <div className="glass-card" style={{ padding: '20px 24px', marginBottom: 20 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
        Approval progress
      </h3>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--text-muted)' }}>
        {data.workflow_name ?? 'Workflow'}
        {data.cycle > 1 ? ` · re-approval cycle ${data.cycle}` : ''}
      </p>

      {data.locked && (
        <p style={{
          display: 'flex', gap: 8, alignItems: 'center', margin: '0 0 14px',
          padding: '9px 12px', borderRadius: 10, fontSize: 12.5,
          background: 'var(--bg-overlay)', color: 'var(--text-muted)',
        }}>
          <Lock size={13} style={{ flexShrink: 0 }} /> {data.locked_reason}
        </p>
      )}

      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {data.stages.map((s, i) => {
          const look = LOOK[s.status] ?? LOOK.pending;
          const last = i === data.stages.length - 1;
          return (
            <li key={s.position} style={{ display: 'flex', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{
                  width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: `2px solid ${look.color}`, color: look.color,
                  fontSize: 11, fontWeight: 700,
                  background: s.is_current ? 'var(--bg-overlay)' : 'transparent',
                }}>
                  <Glyph status={s.status} />
                  {s.status === 'pending' && s.position}
                </span>
                {!last && (
                  <span style={{ flex: 1, width: 2, minHeight: 18, background: 'var(--border-subtle)' }} />
                )}
              </div>
              <div style={{ paddingBottom: last ? 0 : 14, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {s.stage_name}
                  <span style={{ marginLeft: 8, fontSize: 11.5, fontWeight: 600, color: look.color }}>
                    {look.label}
                  </span>
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                  {s.approver_name ?? 'Approver is set when this step starts'}
                  {s.signing_required ? ' · signature required' : ''}
                  {s.round_count > 1 ? ` · round ${s.round_count}` : ''}
                  {s.is_current && s.due_at
                    ? ` · due ${new Date(s.due_at).toLocaleString()}` : ''}
                  {s.status === 'approved' && s.completed_at
                    ? ` · ${new Date(s.completed_at).toLocaleDateString()}` : ''}
                </p>
                {s.status === 'blocked' && s.blocked_reason && (
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--warning)' }}>
                    {s.blocked_reason}. An administrator has been notified.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default ProgressTimeline;
