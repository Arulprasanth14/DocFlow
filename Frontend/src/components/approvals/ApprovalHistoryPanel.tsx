/**
 * DocFlow Frontend — Approval chain of custody, revoke, and finalize (§6.2/6.5/6.6)
 *
 * One panel covering the three interfaces the requirements call for:
 *
 *  §6.6  Chain of custody — who approved before whom, at which step, with
 *        what decision, when, against which document version, and whether
 *        the cryptographic signature still verifies.
 *  §6.5  Revoke/recall — revoke your own recorded decision. If the document
 *        has already moved on, the backend records a recall REQUEST instead
 *        and an administrator resolves it; this panel surfaces both paths
 *        and never implies a silent rollback happened.
 *  §6.2  Finalize — explicit close, only offered when the backend says
 *        `can_finalize`, and the backend re-verifies every signature before
 *        allowing it.
 *
 * All state comes from GET /approvals/instances/{id}/history.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2, XCircle, RotateCcw, ShieldCheck, ShieldAlert, Clock,
  AlertCircle, Loader2, Lock, X, FileText, Undo2,
} from 'lucide-react';
import {
  approvalsApi,
  type ApprovalHistoryEntry,
  type RecallRequest,
} from '@/lib/api/approvals';
import { useAuthStore } from '@/store/authStore';

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

const DECISION_STYLE: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  approved: { label: 'Approved', color: C.success, icon: CheckCircle2 },
  rejected: { label: 'Rejected', color: C.danger, icon: XCircle },
  changes_requested: { label: 'Changes requested', color: C.warning, icon: RotateCcw },
  returned: { label: 'Returned', color: C.warning, icon: RotateCcw },
  delegated: { label: 'Delegated', color: C.primary400, icon: Undo2 },
  abstained: { label: 'Abstained', color: C.muted, icon: Clock },
  pending: { label: 'Pending', color: C.muted, icon: Clock },
};

function fmt(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function SignatureBadge({ entry }: { entry: ApprovalHistoryEntry }) {
  const [result, setResult] = useState<string | null>(null);
  const verifyM = useMutation({
    mutationFn: () => approvalsApi.verifySignature(entry.step_id),
    onSuccess: (r) => {
      if (!r.signed) return setResult('No signature recorded');
      if (r.valid) return setResult('Signature valid · document unchanged');
      const why = [
        r.payload_intact === false && 'the approval record was altered',
        r.document_intact === false && 'the document changed after signing',
        r.signature_valid === false && 'the signature does not verify',
      ]
        .filter(Boolean)
        .join('; ');
      setResult(`INVALID — ${why || r.reason || 'verification failed'}`);
    },
    onError: (e: Error) => setResult(e.message),
  });

  if (!entry.signature) {
    return (
      <span style={{ fontSize: 11, color: C.disabled, display: 'inline-flex', gap: 4 }}>
        <ShieldAlert size={11} /> No signature
      </span>
    );
  }

  const bad = result?.startsWith('INVALID');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <button
        onClick={() => verifyM.mutate()}
        disabled={verifyM.isPending}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none',
          border: 'none', padding: 0, cursor: 'pointer',
          color: bad ? C.danger : C.success, fontSize: 11, fontWeight: 600,
        }}
        title={`${entry.signature.algorithm} · key ${entry.signature.key_id}`}
      >
        {verifyM.isPending ? (
          <Loader2 size={11} className="hspin" />
        ) : bad ? (
          <ShieldAlert size={11} />
        ) : (
          <ShieldCheck size={11} />
        )}
        {entry.signature.algorithm ?? 'Signed'} — verify
      </button>
      {result && (
        <span style={{ fontSize: 10.5, color: bad ? C.danger : C.muted }}>{result}</span>
      )}
    </div>
  );
}

function RecallRow({
  recall,
  canResolve,
  onResolved,
}: {
  recall: RecallRequest;
  canResolve: boolean;
  onResolved: () => void;
}) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const resolveM = useMutation({
    mutationFn: (approve: boolean) =>
      approvalsApi.resolveRecall(recall.id, approve, note || undefined),
    onSuccess: () => {
      setErr(null);
      onResolved();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const open = recall.status === 'requested';
  return (
    <div
      style={{
        background: open ? `color-mix(in srgb, ${C.warning} 8%, transparent)` : C.overlay,
        border: `1px solid ${
          open ? `color-mix(in srgb, ${C.warning} 28%, transparent)` : C.borderSubtle
        }`,
        borderRadius: 10, padding: '11px 13px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
        <RotateCcw size={12} color={open ? C.warning : C.muted} />
        <span style={{ fontSize: 12, fontWeight: 700, color: C.heading }}>
          Recall {recall.status}
        </span>
        <span style={{ fontSize: 11, color: C.muted }}>{fmt(recall.created_at)}</span>
      </div>
      <div style={{ fontSize: 12, color: C.body }}>Reason: {recall.reason}</div>
      {recall.affected_step_ids.length > 0 && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
          Affects {recall.affected_step_ids.length} downstream approval
          {recall.affected_step_ids.length === 1 ? '' : 's'}
        </div>
      )}
      {recall.resolution_note && (
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
          Resolution: {recall.resolution_note}
        </div>
      )}

      {open && canResolve && (
        <div style={{ marginTop: 9 }}>
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Resolution note (optional)"
            style={{ fontSize: 12, marginBottom: 7 }}
          />
          <div style={{ display: 'flex', gap: 7 }}>
            <button
              onClick={() => resolveM.mutate(true)}
              disabled={resolveM.isPending}
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 11.5, color: C.success, gap: 5 }}
              title="Invalidate the recalled approval and affected downstream approvals, and return the document for correction"
            >
              <CheckCircle2 size={12} /> Approve recall
            </button>
            <button
              onClick={() => resolveM.mutate(false)}
              disabled={resolveM.isPending}
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 11.5, color: C.danger, gap: 5 }}
              title="Leave all approvals standing and continue the workflow"
            >
              <XCircle size={12} /> Deny
            </button>
          </div>
        </div>
      )}
      {open && !canResolve && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6, display: 'flex', gap: 5 }}>
          <Lock size={11} style={{ marginTop: 1 }} />
          An organization administrator must resolve this recall.
        </div>
      )}
      {err && (
        <div style={{ fontSize: 11.5, color: C.danger, marginTop: 6 }}>{err}</div>
      )}
    </div>
  );
}

export default function ApprovalHistoryPanel({
  instanceId,
  onClose,
}: {
  instanceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const myId = useAuthStore((s) => s.user?.id);
  const hasRole = useAuthStore((s) => s.hasRole);
  const isOrgAdmin = hasRole('admin', 'hr');

  const [revokeFor, setRevokeFor] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [banner, setBanner] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['approvals', 'history', instanceId],
    queryFn: () => approvalsApi.getHistory(instanceId),
  });

  const refresh = () => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ['approvals'] });
    queryClient.invalidateQueries({ queryKey: ['documents'] });
  };

  const revokeM = useMutation({
    mutationFn: ({ stepId, reason }: { stepId: string; reason: string }) =>
      approvalsApi.revoke(stepId, reason),
    onSuccess: (r) => {
      setRevokeFor(null);
      setRevokeReason('');
      setBanner({
        kind: r.status === 'applied' ? 'ok' : 'warn',
        text: r.detail,
      });
      refresh();
    },
    onError: (e: Error) => setBanner({ kind: 'err', text: e.message }),
  });

  const finalizeM = useMutation({
    mutationFn: () => approvalsApi.finalize(instanceId),
    onSuccess: (r) =>
      setBanner({
        kind: 'ok',
        text: `Workflow finalized. ${r.signatures_verified} signature${
          r.signatures_verified === 1 ? '' : 's'
        } verified.`,
      }),
    onError: (e: Error) => setBanner({ kind: 'err', text: e.message }),
    onSettled: refresh,
  });

  const bannerColor =
    banner?.kind === 'ok' ? C.success : banner?.kind === 'warn' ? C.warning : C.danger;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 1000, display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(620px, 100%)', height: '100%', background: C.surface,
          borderLeft: `1px solid ${C.border}`, overflowY: 'auto', padding: 24,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: C.heading, margin: 0 }}>
              Approval history
            </h2>
            {data && (
              <div style={{ fontSize: 12.5, color: C.muted, marginTop: 4 }}>
                {data.document_title} · {data.document_status} · workflow{' '}
                {data.instance_status}
              </div>
            )}
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

        {banner && (
          <div
            style={{
              marginBottom: 16, padding: '11px 13px', borderRadius: 10,
              background: `color-mix(in srgb, ${bannerColor} 9%, transparent)`,
              border: `1px solid color-mix(in srgb, ${bannerColor} 28%, transparent)`,
              fontSize: 12.5, color: C.body, display: 'flex', gap: 8,
            }}
          >
            <AlertCircle size={14} color={bannerColor} style={{ flexShrink: 0, marginTop: 1 }} />
            {banner.text}
          </div>
        )}

        {isLoading ? (
          <div style={{ padding: 30, textAlign: 'center' }}>
            <Loader2 size={20} color={C.muted} className="hspin" />
          </div>
        ) : isError ? (
          <div style={{ fontSize: 13, color: C.danger }}>
            {(error as Error)?.message || 'Could not load approval history.'}
          </div>
        ) : !data ? null : (
          <>
            {/* Current state */}
            <div
              style={{
                background: C.card, border: `1px solid ${C.border}`,
                borderRadius: 12, padding: '13px 15px', marginBottom: 18,
              }}
            >
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.8 }}>
                <div>
                  Current stage: <strong style={{ color: C.heading }}>
                    {data.current_stage_name ?? '—'}
                  </strong>
                </div>
                <div>Submitted: {fmt(data.submitted_at)}</div>
                {data.completed_at && <div>Completed: {fmt(data.completed_at)}</div>}
                {data.outstanding_steps.length > 0 && (
                  <div style={{ color: C.warning }}>
                    {data.outstanding_steps.length} step
                    {data.outstanding_steps.length === 1 ? '' : 's'} still awaiting a decision
                  </div>
                )}
              </div>

              <button
                onClick={() => finalizeM.mutate()}
                disabled={!data.can_finalize || finalizeM.isPending}
                className={data.can_finalize ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                style={{ marginTop: 12, gap: 7, fontSize: 12.5 }}
                title={
                  data.can_finalize
                    ? 'Verify all signatures and close this workflow'
                    : 'Finalizing is blocked until every required approval is complete and no recall is outstanding'
                }
              >
                {finalizeM.isPending ? (
                  <Loader2 size={13} className="hspin" />
                ) : (
                  <Lock size={13} />
                )}
                Finalize workflow
              </button>
              {!data.can_finalize && (
                <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                  Available once all required approvals are in and any recall is resolved.
                </div>
              )}
            </div>

            {/* Recalls */}
            {data.recalls.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div
                  style={{
                    fontSize: 10.5, fontWeight: 700, letterSpacing: 0.7,
                    textTransform: 'uppercase', color: C.muted, marginBottom: 8,
                  }}
                >
                  Recall requests
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.recalls.map((r) => (
                    <RecallRow
                      key={r.id}
                      recall={r}
                      canResolve={isOrgAdmin}
                      onResolved={refresh}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Chain of custody */}
            <div
              style={{
                fontSize: 10.5, fontWeight: 700, letterSpacing: 0.7,
                textTransform: 'uppercase', color: C.muted, marginBottom: 8,
              }}
            >
              Decisions ({data.history.length})
            </div>

            {data.history.length === 0 ? (
              <div style={{ fontSize: 13, color: C.muted }}>
                No decisions recorded yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {data.history.map((h) => {
                  const st = DECISION_STYLE[h.decision] ?? DECISION_STYLE.pending;
                  const DIcon = st.icon;
                  const mine = h.approver_id === myId;
                  const canRevoke =
                    mine && h.decision !== 'pending' && !h.revoked_at;
                  return (
                    <div
                      key={h.step_id}
                      style={{
                        background: C.card,
                        border: `1px solid ${h.counts_toward_approval ? C.border : C.borderSubtle}`,
                        borderRadius: 12, padding: '13px 15px',
                        opacity: h.counts_toward_approval ? 1 : 0.7,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            <DIcon size={13} color={st.color} />
                            <span style={{ fontSize: 13, fontWeight: 700, color: st.color }}>
                              {st.label}
                            </span>
                            <span style={{ fontSize: 12, color: C.heading }}>
                              {h.approver_name || h.approver_email || 'Unknown approver'}
                              {mine && ' (you)'}
                            </span>
                            {!h.counts_toward_approval && (
                              <span
                                style={{
                                  fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase',
                                  letterSpacing: 0.5, color: C.muted,
                                  background: C.overlay,
                                  border: `1px solid ${C.borderSubtle}`,
                                  borderRadius: 20, padding: '1px 7px',
                                }}
                              >
                                {h.revoked_at ? 'Revoked' : 'Superseded'}
                              </span>
                            )}
                          </div>

                          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, lineHeight: 1.7 }}>
                            <div>
                              {h.stage_name ?? 'Stage'}
                              {h.stage_order != null ? ` (step ${h.stage_order})` : ''} · round{' '}
                              {h.round_number} · {fmt(h.decided_at)}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <FileText size={10} />
                              version {h.document_version_id.slice(0, 8)}
                            </div>
                          </div>

                          {h.decision_note && (
                            <div
                              style={{
                                fontSize: 12, color: C.body, marginTop: 7,
                                background: C.overlay, borderRadius: 8, padding: '7px 9px',
                              }}
                            >
                              “{h.decision_note}”
                            </div>
                          )}

                          {h.revocation_reason && (
                            <div style={{ fontSize: 11.5, color: C.warning, marginTop: 6 }}>
                              Revoked {fmt(h.revoked_at)}: {h.revocation_reason}
                            </div>
                          )}

                          <div style={{ marginTop: 8 }}>
                            <SignatureBadge entry={h} />
                          </div>
                        </div>

                        {canRevoke && (
                          <button
                            onClick={() => {
                              setRevokeFor(h.step_id);
                              setRevokeReason('');
                            }}
                            className="btn btn-ghost btn-sm"
                            style={{ fontSize: 11.5, gap: 5, color: C.warning, flexShrink: 0 }}
                            title="Revoke this decision"
                          >
                            <RotateCcw size={12} /> Revoke
                          </button>
                        )}
                      </div>

                      {revokeFor === h.step_id && (
                        <div
                          style={{
                            marginTop: 11, paddingTop: 11,
                            borderTop: `1px solid ${C.borderSubtle}`,
                          }}
                        >
                          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 7 }}>
                            A reason is required — the revocation is kept as a
                            permanent audit record. If the document has already
                            moved to a later approver, this becomes a recall
                            request for an administrator to resolve rather than
                            an immediate rollback.
                          </div>
                          <textarea
                            className="input"
                            rows={2}
                            value={revokeReason}
                            onChange={(e) => setRevokeReason(e.target.value)}
                            placeholder="Why are you revoking this decision?"
                            style={{ fontSize: 12, resize: 'vertical' }}
                          />
                          <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
                            <button
                              onClick={() =>
                                revokeM.mutate({ stepId: h.step_id, reason: revokeReason.trim() })
                              }
                              disabled={revokeReason.trim().length < 3 || revokeM.isPending}
                              className="btn btn-primary btn-sm"
                              style={{ fontSize: 12 }}
                            >
                              {revokeM.isPending ? 'Revoking…' : 'Confirm revoke'}
                            </button>
                            <button
                              onClick={() => setRevokeFor(null)}
                              className="btn btn-ghost btn-sm"
                              style={{ fontSize: 12 }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        <style>{`
          .hspin { animation: hspin 0.9s linear infinite; }
          @keyframes hspin { to { transform: rotate(360deg); } }
        `}</style>
      </div>
    </div>
  );
}
