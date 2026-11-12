/**
 * DocFlow Frontend — Workflow detail, read-only (Workflow module §5.7, WF-LC-05)
 *
 * Available to the owner and to anyone it is shared with. Shows the same
 * preview timeline the builder and the upload selector use (WF-PRV-09), plus
 * two owner-only panels: the version history (DM-04) and "Shared with"
 * (WF-OWN-06).
 *
 * The share panel lives in ShareWorkflowDialog so there is one implementation
 * of granting and revoking rather than two that can drift.
 */
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, History, Pencil, Share2 } from 'lucide-react';

import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import WorkflowPreview, { type PreviewStage } from '@/components/workflows/WorkflowPreview';
import ShareWorkflowDialog from '@/components/workflows/ShareWorkflowDialog';
import { ApiClientError } from '@/lib/api/client';
import { useWorkflowDetail, useWorkflowVersions } from '@/hooks/useWorkflows';
import { useAuthStore } from '@/store/authStore';

const C = {
  card: 'var(--bg-elevated)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
};

export default function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const myUserId = useAuthStore((s) => s.user?.id) ?? null;
  const [sharing, setSharing] = useState(false);

  const { data: wf, isLoading, error } = useWorkflowDetail(id);
  const isOwner = !!wf && wf.created_by === myUserId;
  // Owner-only, so it is only requested for the owner (the server returns 403
  // otherwise and there is no reason to provoke it).
  const { data: versions } = useWorkflowVersions(isOwner ? id : undefined);

  if (isLoading) {
    return (
      <Shell>
        <div style={{ display: 'grid', gap: 12 }}>
          <Skeleton style={{ height: 70, borderRadius: 14 }} />
          <Skeleton style={{ height: 220, borderRadius: 14 }} />
        </div>
      </Shell>
    );
  }

  if (error || !wf) {
    return (
      <Shell>
      <EmptyState
        art="search"
        title="Workflow not found"
        description={
          error instanceof ApiClientError && error.status === 404
            ? 'It may have been deleted, or it is private to someone else.'
            : 'Could not load this workflow.'
        }
        action={
          <button type="button" onClick={() => navigate('/workflows')} style={btn}>
            Back to workflows
          </button>
        }
      />
      </Shell>
    );
  }

  // The API now resolves the approver's name and the stage's department
  // server-side (a Worker or Trainee cannot read the member list themselves),
  // so this page shows the real route instead of the placeholder
  // "Assigned approver" it used to print for every stage. The id-based
  // fallbacks keep a pre-versioning workflow readable rather than blank.
  const stages: PreviewStage[] = [...wf.stages]
    .sort((a, b) => a.sequence_order - b.sequence_order)
    .map((s) => {
      const rule = s.approver_rules[0];
      const isManager = rule?.rule_type === 'manager_of_requester';
      const hours = s.sla_hours ?? 48;
      const useDays = hours % 24 === 0;
      return {
        name: s.name,
        approverType: isManager ? 'submitter_manager' : 'specific_user',
        approverName: isManager ? null : s.approver_name,
        departmentName: s.department_name,
        dueWithinValue: s.due_within_value ?? (useDays ? hours / 24 : hours),
        dueWithinUnit: s.due_within_unit ?? (useDays ? 'days' : 'hours'),
        requireSigning: s.requires_signature,
      };
    });

  return (
    <Shell>
      <PageHeader
        title={wf.name}
        description={wf.description ?? undefined}
        breadcrumbs={[{ label: 'Workflows', to: '/workflows' }]}
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => navigate('/workflows')} style={btn}>
              <ArrowLeft size={14} aria-hidden /> Back
            </button>
            {isOwner ? (
              <>
                <button type="button" onClick={() => setSharing(true)} style={btn}>
                  <Share2 size={14} aria-hidden /> Share
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/workflows/${wf.id}/edit`)}
                  style={{
                    ...btn,
                    background: C.primary,
                    border: 'none',
                    color: 'var(--color-primary-foreground, #fff)',
                  }}
                >
                  <Pencil size={14} aria-hidden /> Edit
                </button>
              </>
            ) : null}
          </div>
        }
      />

      <div style={{ marginTop: 20 }}>
        <WorkflowPreview
          name={wf.name}
          description={wf.description}
          stages={stages}
          requireFullReapproval={wf.require_full_reapproval}
          showTitle={false}
        />
      </div>

      {/* Version history — owner only (WF-LC-05, DM-04) */}
      {isOwner && versions && versions.length > 0 ? (
        <section style={{ marginTop: 26 }}>
          <h2
            style={{
              margin: '0 0 10px',
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
              color: C.muted,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <History size={13} aria-hidden /> Version history
          </h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 7 }}>
            {versions.map((v) => (
              <li
                key={v.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  background: C.card,
                  border: `1px solid ${v.is_current ? C.primary : C.borderSubtle}`,
                  borderRadius: 10,
                  padding: '10px 12px',
                }}
              >
                <span style={{ fontSize: 13, color: C.heading, fontWeight: 600 }}>
                  Version {v.version_number}
                  {v.is_current ? (
                    <span style={{ color: C.primary, fontWeight: 700 }}> · current</span>
                  ) : null}
                </span>
                <span style={{ fontSize: 11.5, color: C.muted }}>
                  {v.stage_count} {v.stage_count === 1 ? 'stage' : 'stages'} ·{' '}
                  {new Date(v.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 11.5, color: C.muted, marginTop: 9 }}>
            Each saved edit creates a new version. Documents already in approval keep
            running on the version they were submitted with.
          </p>
        </section>
      ) : null}

      {sharing ? (
        <ShareWorkflowDialog
          templateId={wf.id}
          workflowName={wf.name}
          ownerId={wf.created_by}
          onClose={() => setSharing(false)}
        />
      ) : null}
    </Shell>
  );
}

/**
 * The page shell. `page-content` carries the app's standard gutters, which
 * this page was missing entirely, and the 760 column is WorkflowPreview's own
 * width — so the header, the timeline and the version history share one axis
 * instead of the header running full width over a centred timeline.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="page-content"
      style={{ paddingTop: 24, maxWidth: 760, margin: '0 auto', width: '100%' }}
    >
      {children}
    </div>
  );
}

const btn: React.CSSProperties = {
  minHeight: 44,
  padding: '0 14px',
  borderRadius: 10,
  background: 'var(--bg-overlay)',
  border: '1px solid var(--border-default)',
  color: 'var(--text-primary)',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
};
