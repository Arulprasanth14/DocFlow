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
      <div style={{ display: 'grid', gap: 12 }}>
        <Skeleton style={{ height: 70, borderRadius: 14 }} />
        <Skeleton style={{ height: 220, borderRadius: 14 }} />
      </div>
    );
  }

  if (error || !wf) {
    return (
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
    );
  }

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
        // The detail payload carries ids, not names; the preview falls back to
        // a neutral label rather than inventing a person (DESIGN.md: real data
        // only). Resolving names here would need the member list and is not
        // worth a second request on a read-only page.
        approverName: isManager ? null : 'Assigned approver',
        departmentName: null,
        dueWithinValue: useDays ? hours / 24 : hours,
        dueWithinUnit: useDays ? 'days' : 'hours',
        requireSigning: s.requires_signature,
      };
    });

  return (
    <div>
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

      <WorkflowPreview
        name={wf.name}
        description={wf.description}
        stages={stages}
        requireFullReapproval={
          !!(wf as { require_full_reapproval?: boolean }).require_full_reapproval
        }
      />

      {/* Version history — owner only (WF-LC-05, DM-04) */}
      {isOwner && versions && versions.length > 0 ? (
        <section style={{ maxWidth: 760, margin: '26px auto 0' }}>
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
