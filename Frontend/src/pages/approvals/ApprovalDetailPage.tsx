/**
 * Approval details — /approvals/:stageInstanceId
 *
 * Workflow module section 6.3 (AP-DET-01..05), section 8. Task P2-19.
 *
 * Before this there was no per-approval screen at all: the dashboard row
 * linked to /documents/{id}, which is the OWNER's view of the document. An
 * approver had nowhere to see the stage they were deciding, what it
 * required, or what had already been decided ahead of them.
 *
 * What is deliberately NOT here yet. The left pane is where the PDF viewer
 * goes (AP-VWR-01) and the side panel is where the AI summary (AP-SUM-*) and
 * inline comments (AP-ANN-*) go. Those are Phase 3 and Phase 4, and the
 * viewer additionally waits on `pdfjs-dist` being approved. Rather than ship
 * tabs and toolbar buttons that do nothing — which UX-INT-01 forbids
 * outright, and which is the exact defect this module was asked to fix on
 * the dashboard — the panes that are not built yet say so plainly, and no
 * control appears until it works.
 *
 * The action bar is real: it posts through the same hardened decision
 * service as everything else, so every authorization check, the row lock and
 * the signing gate apply identically.
 */
import { lazy, Suspense, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, Check, Clock, FileText, Info, Lock,
  MessageSquare, PenLine, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Group, Panel, Separator } from 'react-resizable-panels';

import {
  useStageInstance, useDecide, useReassignStage, useMessageableMembers,
} from '@/hooks/useApprovals';
import type { StageDecisionSummary } from '@/lib/api/approvals';
import type { AnchorDraft, AnyThread } from '@/lib/api/annotations';
import {
  useCreateAnnotation, useVersionAnnotations, useVersionFile,
} from '@/hooks/useAnnotations';
import { useAuthStore } from '@/store/authStore';
import { CommentsPanel } from '@/components/review/CommentsPanel';
import { SummaryPanel } from '@/components/review/SummaryPanel';
import { VersionDiffPanel } from '@/components/review/VersionDiffPanel';
import type { PdfViewerHandle } from '@/components/review/PdfViewer';
import { ApiClientError } from '@/lib/api/client';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconChip } from '@/components/ui/IconChip';
import { StatusBadge } from '@/components/ui/StatusBadge';

type DecisionKind = 'approved' | 'rejected' | 'changes_requested';

// pdf.js is large; it loads with the viewer, not with the app.
const PdfViewer = lazy(() => import('@/components/review/PdfViewer'));

const paneNote: React.CSSProperties = {
  padding: 32, fontSize: 13, color: 'var(--text-muted)',
};

const C = {
  surface: 'var(--bg-elevated)',
  hover: 'var(--bg-overlay)',
  text: 'var(--text-primary)',
  muted: 'var(--text-muted)',
  border: 'var(--border-subtle)',
  accent: 'var(--accent-primary)',
  danger: 'var(--danger)',
  warning: 'var(--warning)',
};

/** AP-REJ-02, mirrored client-side so the approver is told before a doomed
 *  request goes out. The server validates independently and is the authority. */
const MIN_REASON_CHARS = 10;

function meaningfulLength(text: string): number {
  return text.replace(/[^\p{L}\p{N}]/gu, '').length;
}

/** Hours -> "3h", "2d". Formatting only; the server decided the urgency. */
function humanDelta(hours: number): string {
  const abs = Math.abs(hours);
  if (abs < 1) return `${Math.max(1, Math.round(abs * 60))}m`;
  if (abs < 48) return `${Math.round(abs)}h`;
  return `${Math.round(abs / 24)}d`;
}

function DueBadge({ urgency, hours }: {
  urgency: string;
  hours: number | null;
}) {
  if (urgency === 'none' || hours == null) {
    return <span style={{ fontSize: 13, color: C.muted }}>No deadline</span>;
  }
  const overdue = urgency === 'overdue';
  const soon = urgency === 'due_soon';
  const color = overdue ? C.danger : soon ? C.warning : C.muted;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 13, fontWeight: overdue || soon ? 600 : 500, color,
    }}>
      <Clock size={13} />
      {overdue
        ? `${humanDelta(hours)} overdue`
        : `Due in ${humanDelta(hours)}`}
    </span>
  );
}

function HistoryRow({ entry }: { entry: StageDecisionSummary }) {
  const tone =
    entry.decision === 'approved' ? C.accent
      : entry.decision === 'rejected' ? C.danger
        : C.warning;
  return (
    <li style={{
      display: 'flex', gap: 10, padding: '12px 0',
      borderBottom: `1px solid ${C.border}`,
      opacity: entry.is_counted ? 1 : 0.6,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: tone,
        marginTop: 6, flexShrink: 0,
      }} />
      <div style={{ minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13, color: C.text, fontWeight: 600 }}>
          {entry.approver_name ?? 'An approver'}
          {' '}
          <span style={{ fontWeight: 400, color: C.muted }}>
            {entry.decision.replace('_', ' ')}
            {entry.stage_name ? ` · ${entry.stage_name}` : ''}
          </span>
        </p>
        {entry.note && (
          <p style={{ margin: '4px 0 0', fontSize: 13, color: C.muted }}>
            {entry.note}
          </p>
        )}
        <p style={{ margin: '4px 0 0', fontSize: 11, color: C.muted }}>
          {entry.decided_at
            ? new Date(entry.decided_at).toLocaleString()
            : 'Time not recorded'}
          {entry.round_number > 1 ? ` · Round ${entry.round_number}` : ''}
          {/* Section 6.5: a revoked or superseded decision is kept for audit
              but no longer gates the stage, and an approver deciding now has
              to know that. */}
          {!entry.is_counted && ' · no longer counts'}
        </p>
      </div>
    </li>
  );
}

export default function ApprovalDetailPage() {
  const { stageInstanceId } = useParams<{ stageInstanceId: string }>();
  const navigate = useNavigate();

  const detailQ = useStageInstance(stageInstanceId);
  const decideM = useDecide();
  const reassignM = useReassignStage();
  const membersQ = useMessageableMembers();

  const currentUserId = useAuthStore((s) => s.user?.id) ?? '';
  const versionId = detailQ.data?.document_version_id ?? null;
  const fileQ = useVersionFile(versionId);
  const annotationsQ = useVersionAnnotations(versionId);
  const createM = useCreateAnnotation(versionId);
  const viewerRef = useRef<PdfViewerHandle>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  type SideTab = 'summary' | 'comments' | 'changes' | 'details';
  const [sideTab, setSideTab] = useState<SideTab>('summary');
  const annotations: AnyThread[] = annotationsQ.data?.annotations ?? [];
  const sideTabs: SideTab[] = detailQ.data?.previous_version_id
    ? ['summary', 'comments', 'changes', 'details']
    : ['summary', 'comments', 'details'];
  const writtenDrafts = annotations.filter(
    (a) => a.status === 'draft' && (a.comment_text ?? '').trim().length > 0,
  ).length;

  const [kind, setKind] = useState<DecisionKind | null>(null);
  const [note, setNote] = useState('');
  const [signatureName, setSignatureName] = useState('');
  const [reassignOpen, setReassignOpen] = useState(false);
  const [newApproverId, setNewApproverId] = useState('');
  const [reassignReason, setReassignReason] = useState('');

  if (detailQ.isLoading) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton style={{ height: 80, marginBottom: 16 }} />
        <Skeleton style={{ height: 420 }} />
      </div>
    );
  }

  // AP-DET-03 / E28: the server answers 404 both for "no such stage" and for
  // "not yours", on purpose. So there is ONE state here — telling the two
  // apart in the UI would leak exactly what the status code is hiding.
  if (detailQ.isError || !detailQ.data) {
    const status = detailQ.error instanceof ApiClientError
      ? detailQ.error.status
      : undefined;
    return (
      <div style={{ padding: 24 }}>
        <EmptyState
          title={status === 404 ? 'Approval not found' : 'Could not load this approval'}
          description={
            status === 404
              ? 'This approval either does not exist or is not assigned to you.'
              : 'Something went wrong loading this approval. Try again in a moment.'
          }
          action={
            <button className="btn btn-secondary" onClick={() => navigate('/approvals')}>
              <ArrowLeft size={15} /> Back to approvals
            </button>
          }
        />
      </div>
    );
  }

  const d = detailQ.data;
  const needsSignature = d.signing_required;
  const rejecting = kind === 'rejected';
  const changing = kind === 'changes_requested';

  async function submitDecision() {
    if (!kind || !d.my_step_id) return;

    // AP-REJ-02: a rejection is terminal, so it carries a real reason.
    if (rejecting && meaningfulLength(note) < MIN_REASON_CHARS) {
      toast.error(
        `Give a reason of at least ${MIN_REASON_CHARS} characters so the owner knows what to fix.`,
      );
      return;
    }
    // AP-CHG-02: changes must say what to change. Inline comments arrive in
    // Phase 3; until then the overall note is the only channel, so it is
    // required rather than optional.
    if (changing && note.trim().length === 0 && writtenDrafts === 0) {
      toast.error('Add at least one comment on the document, or write an overall note.');
      return;
    }
    // BR-08 / WF-STG-20: the server refuses an unsigned approval on a
    // signing stage whatever the client sends. Asking here saves a 422.
    if (kind === 'approved' && needsSignature && !signatureName.trim()) {
      toast.error('This stage requires your signature to approve.');
      return;
    }

    try {
      await decideM.mutateAsync({
        stepId: d.my_step_id,
        payload: {
          decision: kind,
          note: note.trim() || undefined,
          ...(kind === 'approved' && needsSignature
            ? {
              signature: {
                signature_method: 'typed' as const,
                // The server re-derives and verifies what it signs — it binds
                // the approver, the stage and the document-version hash
                // itself (AP-APR-03), so this is the ceremony, not the proof.
                signed_hash: d.document_version_id ?? '',
              },
            }
            : {}),
        },
      });
      toast.success(
        kind === 'approved' ? 'Approved'
          : kind === 'rejected' ? 'Rejected'
            : 'Sent back for changes',
      );
      setKind(null);
      setNote('');
      setSignatureName('');
      navigate('/approvals');
    } catch (err) {
      const msg = err instanceof ApiClientError
        ? err.detail
        : 'Could not record your decision.';
      // X-INT-02 / AP-CHG-05: on a 409 the world moved under us. Nothing the
      // approver typed is discarded — the dialog stays open with their note.
      toast.error(msg, { duration: 8000 });
      detailQ.refetch();
    }
  }

  // AP-ANN-20: the draft is created on the server the moment the anchor is
  // drawn, before any text is typed, so a refresh cannot lose it.
  async function createFromAnchor(anchor: AnchorDraft) {
    try {
      const created = await createM.mutateAsync(anchor);
      setActiveId(created.id);
      setSideTab('comments');
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.detail : 'Could not add that comment.',
      );
    }
  }

  async function submitReassign() {
    if (!stageInstanceId || !newApproverId) return;
    if (reassignReason.trim().length < 5) {
      toast.error('Give a reason — it is recorded in the audit trail and shown to both approvers.');
      return;
    }
    try {
      await reassignM.mutateAsync({
        stageInstanceId,
        payload: { new_approver_id: newApproverId, reason: reassignReason.trim() },
      });
      toast.success('Stage reassigned. The new approver has been notified.');
      setReassignOpen(false);
      setNewApproverId('');
      setReassignReason('');
      detailQ.refetch();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.detail : 'Could not reassign this stage.',
        { duration: 8000 },
      );
    }
  }

  return (
    <div style={{ padding: '24px 24px 0', display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <button
        onClick={() => navigate('/approvals')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'transparent', border: 'none', color: C.muted,
          cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 12,
          fontFamily: "'Inter', sans-serif",
        }}
      >
        <ArrowLeft size={14} /> All approvals
      </button>

      {/* ── Header (AP-DET-01) ── */}
      <PageHeader
        title={d.document_title ?? 'Untitled document'}
        description={
          [
            d.document_public_id,
            d.workflow_name,
            `Step ${d.position} of ${d.total_stages}: ${d.stage_name}`,
            d.document_version_num ? `Version ${d.document_version_num}` : null,
          ].filter(Boolean).join(' · ')
        }
        actions={<DueBadge urgency={d.urgency} hours={d.hours_until_due} />}
      />

      {/* Section 6.10: a paused clock is said out loud, so an approver does
          not read "no deadline" as "no deadline was ever set". */}
      {d.timer_paused_at && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', marginTop: 12,
          borderRadius: 10, background: C.hover, color: C.muted, fontSize: 13,
        }}>
          <Info size={14} /> The deadline for this step is paused.
        </div>
      )}

      {/* AP-SLA-05: blocked, and only an admin can clear it. */}
      {d.status === 'blocked' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '12px 14px', marginTop: 12, borderRadius: 10,
          background: 'var(--warning-subtle, rgba(217,119,6,0.12))',
          color: C.warning, fontSize: 13, fontWeight: 500,
        }}>
          <AlertTriangle size={15} />
          <span>
            This step is blocked and needs reassigning
            {d.blocked_reason ? ` — ${d.blocked_reason}` : ''}.
          </span>
          <button
            className="btn btn-secondary"
            style={{ marginLeft: 'auto' }}
            onClick={() => setReassignOpen(true)}
          >
            Reassign approver
          </button>
        </div>
      )}

      <div style={{ height: 16 }} />

      {/* ── Split: document on the left, context on the right ── */}
      {/* AP-DET-04 — resizable, and the side panel can be collapsed out of
          the way. Sizes are strings: this library reads a bare number as
          pixels and a bare string as a percentage. */}
      <Group orientation="horizontal" style={{ flex: 1, minHeight: 440 }}>
        <Panel defaultSize="65" minSize="35">
          <div className="glass-card" style={{ height: '100%', overflow: 'hidden' }}>
            {/* AP-VWR-01. The file endpoint reports a STATE, so a review copy
                that is still being prepared, or could not be, is said in
                words instead of showing a broken frame (UX-INT-01). */}
            {fileQ.data?.status === 'ready' && fileQ.data.url ? (
              <Suspense fallback={<p style={paneNote}>Loading viewer…</p>}>
                <PdfViewer
                  ref={viewerRef}
                  fileUrl={fileQ.data.url}
                  annotations={annotations}
                  activeId={activeId}
                  canAnnotate={d.can_act}
                  onSelectAnnotation={(annId) => { setActiveId(annId); setSideTab('comments'); }}
                  onCreateAnchor={createFromAnchor}
                />
              </Suspense>
            ) : (
              <div style={{ ...paneNote, textAlign: 'center' }}>
                <IconChip tone="primary" size={48}><FileText size={20} /></IconChip>
                <p style={{ margin: '14px auto 0', maxWidth: 420, lineHeight: 1.6 }}>
                  {fileQ.isLoading && 'Loading document…'}
                  {fileQ.data?.status === 'pending'
                    && 'A review copy of this document is being prepared. This page will update when it is ready.'}
                  {fileQ.data?.status === 'failed'
                    && (fileQ.data.message ?? 'A review copy of this document could not be prepared.')}
                  {fileQ.isError && 'This document could not be loaded.'}
                </p>
                {d.document_id && (fileQ.data?.status === 'failed' || fileQ.isError) && (
                  <button
                    className="btn btn-secondary"
                    style={{ marginTop: 16 }}
                    onClick={() => navigate(`/documents/${d.document_id}`)}
                  >
                    <FileText size={15} /> Open document
                  </button>
                )}
              </div>
            )}
          </div>
        </Panel>

        <Separator style={{ width: 12, cursor: 'col-resize' }} />

        <Panel defaultSize="35" minSize="25" collapsible collapsedSize="0">
          <div className="glass-card" style={{ height: '100%', overflow: 'auto', padding: 20 }}>
            <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
              {/* 'changes' only appears when there IS a previous version to
                  compare against - a tab that leads nowhere is the defect
                  UX-INT-01 forbids. */}
              {sideTabs.map((key) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={sideTab === key}
                  onClick={() => setSideTab(key)}
                  style={{
                    padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                    fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
                    border: `1px solid ${sideTab === key ? C.accent : C.border}`,
                    background: sideTab === key ? C.hover : 'transparent',
                    color: sideTab === key ? C.text : C.muted,
                  }}
                >
                  {key}{key === 'comments' && annotations.length > 0 ? ` (${annotations.length})` : ''}
                </button>
              ))}
            </div>

            {sideTab === 'summary' && versionId && (
              <SummaryPanel versionId={versionId} />
            )}

            {sideTab === 'changes' && versionId && d.previous_version_id && (
              <VersionDiffPanel
                fromVersionId={d.previous_version_id}
                toVersionId={versionId}
                onGoToPage={(page) => viewerRef.current?.scrollToPage(page)}
              />
            )}

            {sideTab === 'comments' && versionId && (
              <CommentsPanel
                versionId={versionId}
                annotations={annotations}
                activeId={activeId}
                currentUserId={currentUserId}
                onSelect={(a) => {
                  setActiveId(a.id);
                  viewerRef.current?.scrollToPage(a.page_number);
                }}
              />
            )}

            {sideTab === 'details' && (<>

            <dl style={{ margin: 0, display: 'grid', gap: 12 }}>
              <Detail label="Submitted by" value={d.submitter_name ?? '—'} />
              <Detail
                label="Submitted"
                value={d.submitted_at ? new Date(d.submitted_at).toLocaleString() : '—'}
              />
              <Detail label="Workflow" value={d.workflow_name ?? '—'} />
              <Detail label="This step" value={`${d.stage_name} (${d.position} of ${d.total_stages})`} />
              <Detail label="Approver" value={d.resolved_approver_name ?? 'Not yet assigned'} />
              <Detail
                label="Status"
                value={<StatusBadge status={d.status} />}
              />
              {d.round_count > 1 && (
                <Detail label="Review round" value={String(d.round_count)} />
              )}
            </dl>

            {/* WF-STG-20/21: say that a signature is required, and why. The
                reason matters when signing was forced on at runtime because
                the resolved approver's department requires it — the stage
                definition alone does not explain it. */}
            {needsSignature && (
              <div style={{
                display: 'flex', gap: 8, marginTop: 16, padding: '10px 12px',
                borderRadius: 10, background: C.hover, fontSize: 12.5, color: C.text,
              }}>
                <Lock size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>
                  <strong>A signature is required to approve this step.</strong>
                  {d.signing_reason ? ` ${d.signing_reason}.` : ''}
                </span>
              </div>
            )}

            {/* AP-DET-02 — what was decided before this approver. */}
            <h4 style={{
              margin: '24px 0 4px', fontSize: 11, fontWeight: 700,
              letterSpacing: '0.06em', textTransform: 'uppercase', color: C.muted,
            }}>
              Decisions so far
            </h4>
            {d.history.length === 0 ? (
              <p style={{ fontSize: 13, color: C.muted, margin: '8px 0 0' }}>
                Nothing has been decided on this document yet — this is the
                first step.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {d.history.map(h => <HistoryRow key={h.step_id} entry={h} />)}
              </ul>
            )}
            </>)}
          </div>
        </Panel>
      </Group>

      {/* ── Action bar ── */}
      <div style={{
        position: 'sticky', bottom: 0, marginTop: 16,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '14px 18px',
        background: C.surface,
        borderTop: `1px solid ${C.border}`,
      }}>
        {d.can_act ? (
          <>
            <button className="btn btn-primary" onClick={() => { setKind('approved'); setNote(''); }}>
              <Check size={15} /> Approve
            </button>
            <button className="btn btn-secondary" onClick={() => { setKind('changes_requested'); setNote(''); }}>
              <MessageSquare size={15} /> Request changes
            </button>
            <button
              className="btn btn-secondary"
              style={{ color: C.danger, borderColor: C.danger }}
              onClick={() => { setKind('rejected'); setNote(''); }}
            >
              <X size={15} /> Reject
            </button>
            {needsSignature && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                marginLeft: 'auto', fontSize: 12, color: C.muted,
              }}>
                <Lock size={13} /> Signature required to approve
              </span>
            )}
          </>
        ) : (
          /* UX-INT-01: no disabled buttons with nothing to explain them. The
             server always sends a reason when it says you cannot act, and
             this is where it goes. */
          <p style={{
            margin: 0, display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 13, color: C.muted,
          }}>
            <Info size={14} />
            {d.cannot_act_reason ?? 'This step is not awaiting a decision from you.'}
          </p>
        )}
      </div>

      {/* ── Decision dialog ── */}
      {kind && (
        <Modal
          title={
            kind === 'approved' ? 'Approve this step'
              : kind === 'rejected' ? 'Reject this document'
                : 'Send back for corrections'
          }
          subtitle={
            kind === 'rejected'
              /* AP-REJ-05 / AP-CHG-07: rejection and "changes" must not read
                 the same. One ends the run, the other returns it. */
              ? 'Rejection is final. The document cannot be resubmitted through this run.'
              : kind === 'changes_requested'
                ? 'The document goes back to its owner and can be resubmitted to this same step.'
                : undefined
          }
          onClose={() => setKind(null)}
          onConfirm={submitDecision}
          confirmLabel={
            kind === 'approved' ? 'Approve'
              : kind === 'rejected' ? 'Reject' : 'Send back'
          }
          danger={rejecting}
          busy={decideM.isPending}
        >
          <label style={labelStyle}>
            {rejecting
              ? 'Reason (required, at least 10 characters)'
              : changing
                ? (writtenDrafts > 0
                  ? `Overall note (optional — ${writtenDrafts} comment${writtenDrafts === 1 ? '' : 's'} will be sent)`
                  : 'What needs changing (required)')
                : 'Comment (optional)'}
          </label>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={4}
            maxLength={2000}
            autoFocus
            placeholder={
              rejecting
                ? 'Explain what is wrong, so the owner knows where they stand.'
                : changing
                  ? 'Describe what the owner should change before resubmitting.'
                  : 'Anything worth recording with your approval.'
            }
            style={inputStyle}
          />
          {rejecting && (
            <p style={{
              margin: '6px 0 0', fontSize: 12,
              color: meaningfulLength(note) >= MIN_REASON_CHARS ? C.muted : C.danger,
            }}>
              {meaningfulLength(note)}/{MIN_REASON_CHARS} characters
            </p>
          )}

          {kind === 'approved' && needsSignature && (
            <>
              <label style={{ ...labelStyle, marginTop: 14 }}>
                <PenLine size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                Type your full name to sign
              </label>
              <input
                value={signatureName}
                onChange={e => setSignatureName(e.target.value)}
                placeholder="Your full name"
                style={inputStyle}
              />
              <p style={{ margin: '6px 0 0', fontSize: 12, color: C.muted }}>
                {/* WF-STG-21 / BR-08: the server builds and verifies the
                    signature over the approver, the stage and the document
                    version hash. The typed name is the ceremony, never the
                    proof, and it is never matched against your account name. */}
                Your signature is generated and verified by the server against
                this exact document version.
              </p>
            </>
          )}
        </Modal>
      )}

      {/* ── Reassign dialog (AP-SLA-06) ── */}
      {reassignOpen && (
        <Modal
          title="Reassign this step"
          subtitle="This overrides the approver the workflow's owner defined, so the reason is recorded in the audit trail and shown to both approvers."
          onClose={() => setReassignOpen(false)}
          onConfirm={submitReassign}
          confirmLabel="Reassign"
          busy={reassignM.isPending}
        >
          <label style={labelStyle}>New approver</label>
          <select
            value={newApproverId}
            onChange={e => setNewApproverId(e.target.value)}
            style={inputStyle}
          >
            <option value="">Choose someone…</option>
            {(membersQ.data ?? [])
              /* The submitter can never be made the approver (BR-05); the
                 server refuses it too, this just keeps it off the list. */
              .filter(m => m.id !== d.submitted_by && m.id !== d.resolved_approver_id)
              .map(m => (
                <option key={m.id} value={m.id}>{m.display_name || m.email}</option>
              ))}
          </select>

          <label style={{ ...labelStyle, marginTop: 14 }}>Reason (required)</label>
          <textarea
            value={reassignReason}
            onChange={e => setReassignReason(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Why is this step being reassigned?"
            style={inputStyle}
          />
        </Modal>
      )}
    </div>
  );
}

// ─── Small local pieces ───────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: 'var(--text-primary)', marginBottom: 6,
  fontFamily: "'Inter', sans-serif",
};

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '10px 12px',
  background: 'var(--bg-overlay)', border: '1px solid var(--border-subtle)',
  borderRadius: 10, color: 'var(--text-primary)',
  fontSize: 14, fontFamily: "'Inter', sans-serif", outline: 'none',
  resize: 'vertical',
};

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 13.5, color: C.text }}>{value}</dd>
    </div>
  );
}

function Modal({
  title, subtitle, children, onClose, onConfirm, confirmLabel,
  danger = false, busy = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, background: 'rgba(0,0,0,0.45)',
      }}
      onClick={onClose}
    >
      <div
        className="glass-card"
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 520, padding: 22 }}
      >
        <h3 style={{ margin: '0 0 4px', fontSize: 17, color: C.text }}>{title}</h3>
        {subtitle && (
          <p style={{ margin: '0 0 16px', fontSize: 13, color: C.muted, lineHeight: 1.55 }}>
            {subtitle}
          </p>
        )}
        {children}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={danger ? 'btn btn-secondary' : 'btn btn-primary'}
            style={danger ? { color: C.danger, borderColor: C.danger } : undefined}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
