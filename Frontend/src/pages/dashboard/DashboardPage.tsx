/**
 * Dashboard v3 — content / information-architecture fix.
 *
 * INFORMATION OWNERSHIP: every fact appears exactly once; all counts come from the single shared
 * `useDashboardData` hook so two widgets can never disagree (see AUDIT/docs/DASHBOARD_V3_PLAN.md).
 * Status counts live ONLY in StatusPipeline; "needs me" lives ONLY in Needs-your-action; period metrics
 * live ONLY in the KPI row; etc. Real data / existing endpoints only — never fake numbers.
 * Each widget owns its skeleton + retry; one failing query never blanks the page.
 */

import { useState } from 'react';
import {
  FileText, CheckCircle2, Upload, ArrowRight, Check, X, Activity, Plus,
  Eye, AlertCircle, GitBranch, UserPlus, Timer, AlertTriangle, TrendingUp,
  FilePlus2, RotateCcw,
} from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useDecide } from '@/hooks/useApprovals';
import { usePageTransition, useCountUp } from '@/lib/motion';
import { fmTransition } from '@/lib/motion/tokens';
import { GlassCard } from '@/components/ui/GlassCard';
import { IconChip } from '@/components/ui/IconChip';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageHeader } from '@/components/ui/PageHeader';
import { Section } from '@/components/ui/Section';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import type { ApprovalStep } from '@/lib/api/approvals';
import type { Document } from '@/types';

// ── helpers ────────────────────────────────────────────────────────────────────
function relTime(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
const SCOPE_LABEL: Record<string, string> = {
  own: 'mine', own_and_department: 'my team', organization: 'workspace', none: '',
};
function fmtHours(h: number | null): string {
  if (h === null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// ── tiny shared bits ─────────────────────────────────────────────────────────────
function WidgetError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center" style={{ gap: 10, padding: 28, color: 'var(--muted-foreground)' }}>
      <AlertCircle size={20} style={{ color: 'var(--destructive)' }} />
      <span style={{ fontSize: '0.85rem' }}>Couldn't load this.</span>
      <button className="btn btn-secondary btn-sm" onClick={onRetry}>Retry</button>
    </div>
  );
}
function Metric({ value, suffix }: { value: number | null; suffix?: string }) {
  const ref = useCountUp(value ?? 0, { suffix });
  if (value === null) return <span className="tabular">—</span>;
  return <span ref={ref} className="tabular">{`0${suffix ?? ''}`}</span>;
}
function ScopeChip({ scope }: { scope: string | null }) {
  const label = scope ? SCOPE_LABEL[scope] : '';
  if (!label) return null;
  return <span className="label-caps" style={{ padding: 0, fontSize: '0.62rem' }}>{label}</span>;
}

// ── Needs your action ────────────────────────────────────────────────────────────
function NeedsYourAction({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const navigate = useNavigate();
  const decide = useDecide();
  const [dialog, setDialog] = useState<{ step: ApprovalStep; kind: 'approved' | 'rejected' } | null>(null);
  const [note, setNote] = useState('');

  const items = (d.queue.data?.items ?? []).slice(0, 5);

  const submit = async () => {
    if (!dialog) return;
    const { step, kind } = dialog;
    try {
      await decide.mutateAsync({ stepId: step.id, payload: { decision: kind, note: note || undefined } });
      toast.success(kind === 'approved' ? 'Approved' : 'Rejected');
      setDialog(null); setNote('');
    } catch (e) {
      const msg = (e as Error).message || 'Could not record the decision';
      if (/signature/i.test(msg)) {
        toast.error('This approval needs a signature — opening it in Approvals.');
        setDialog(null); setNote('');
        navigate('/approvals');
      } else {
        toast.error(msg);
      }
    }
  };

  return (
    <GlassCard variant="elevated" style={{ padding: 22 }}>
      <Section
        title="Needs your action"
        action={d.totalQueue > 0 ? <span className="status-badge status-pending tabular">{d.totalQueue}</span> : undefined}
        noStagger
      >
        {d.queue.isLoading ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} style={{ height: 56 }} />)}</div>
        ) : d.queue.isError ? (
          <WidgetError onRetry={() => d.queue.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState art="checklist" compact title="All caught up" description="Nothing is waiting on your approval right now." />
        ) : (
          <>
            <div className="flex flex-col" style={{ gap: 4 }}>
              {items.map((step) => {
                const overdue = step.due_at ? new Date(step.due_at).getTime() < Date.now() : false;
                return (
                  <div key={step.id} className="flex items-center gap-3" style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                    <IconChip tone={overdue ? 'danger' : 'primary'} size={36}><FileText size={16} /></IconChip>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {step.document_title || 'Untitled document'}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span>{step.submitter_name ? `from ${step.submitter_name}` : 'Awaiting review'}</span>
                        <span>· waiting {relTime(step.created_at)}</span>
                        {overdue && <span className="status-badge status-rejected" style={{ padding: '1px 7px' }}><Timer size={10} /> Overdue</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button aria-label="Approve" title="Approve" onClick={() => { setNote(''); setDialog({ step, kind: 'approved' }); }}
                        style={{ width: 32, height: 32, borderRadius: 9, border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)', background: 'color-mix(in srgb, var(--success) 14%, transparent)', color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                        <Check size={16} />
                      </button>
                      <button aria-label="Reject" title="Reject" onClick={() => { setNote(''); setDialog({ step, kind: 'rejected' }); }}
                        style={{ width: 32, height: 32, borderRadius: 9, border: '1px solid color-mix(in srgb, var(--destructive) 30%, transparent)', background: 'var(--destructive-soft)', color: 'var(--destructive)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                        <X size={16} />
                      </button>
                      <button aria-label="View" title="View" onClick={() => step.document_id && navigate(`/documents/${step.document_id}`)}
                        className="btn btn-ghost btn-icon" style={{ width: 32, height: 32, padding: 0 }}>
                        <Eye size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {d.totalQueue > items.length && (
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => navigate('/approvals')}>
                View all {d.totalQueue} <ArrowRight size={14} />
              </button>
            )}
          </>
        )}
      </Section>

      <ConfirmDialog
        open={!!dialog}
        title={dialog?.kind === 'approved' ? 'Approve document' : 'Reject document'}
        message={dialog?.kind === 'approved' ? 'Record your approval for this document.' : 'This sends the document back to the submitter as rejected.'}
        confirmLabel={dialog?.kind === 'approved' ? 'Approve' : 'Reject'}
        confirmDisabled={decide.isPending}
        onCancel={() => { setDialog(null); setNote(''); }}
        onConfirm={submit}
      >
        <textarea
          className="input"
          placeholder={dialog?.kind === 'approved' ? 'Add a note (optional)' : 'Reason (optional)'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ minHeight: 72, resize: 'vertical' }}
        />
      </ConfirmDialog>
    </GlassCard>
  );
}

// ── Returned to you (trainee / non-approver view) ────────────────────────────────
function ReturnedToYou({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const navigate = useNavigate();
  const items = d.returned.slice(0, 5);
  return (
    <GlassCard variant="elevated" style={{ padding: 22 }}>
      <Section title="Returned to you" action={items.length ? <span className="status-badge status-pending tabular">{d.returned.length}</span> : undefined} noStagger>
        {d.mine.isLoading ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} style={{ height: 52 }} />)}</div>
        ) : d.mine.isError ? (
          <WidgetError onRetry={() => d.mine.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState art="checklist" compact title="Nothing needs changes" description="Documents sent back to you for edits will show up here." />
        ) : (
          <div className="flex flex-col">
            {items.map((doc) => (
              <button key={doc.id} onClick={() => navigate(`/documents/${doc.id}`)} className="flex items-center gap-3"
                style={{ padding: '11px 0', borderTop: '1px solid var(--border)', background: 'none', border: 'none', borderTopStyle: 'solid', borderTopWidth: 1, borderTopColor: 'var(--border)', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                <IconChip tone="danger" size={34}><RotateCcw size={15} /></IconChip>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.title}</div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>{doc.doc_type_name || 'Document'} · {relTime(doc.updated_at)}</div>
                </div>
                <StatusBadge status={doc.status} />
              </button>
            ))}
          </div>
        )}
      </Section>
    </GlassCard>
  );
}

// ── My documents in progress ─────────────────────────────────────────────────────
function MyInProgress({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const navigate = useNavigate();
  const inflight = d.inProgress.slice(0, 5);
  const drafts = d.drafts.slice(0, 3);
  const empty = inflight.length === 0 && drafts.length === 0;
  return (
    <GlassCard style={{ padding: 22 }}>
      <Section title="My documents in progress" noStagger>
        {d.mine.isLoading ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} style={{ height: 48 }} />)}</div>
        ) : d.mine.isError ? (
          <WidgetError onRetry={() => d.mine.refetch()} />
        ) : empty ? (
          <EmptyState art="documents" compact title="Nothing in flight" description="Documents you submit will track here until they're decided."
            action={<button className="btn btn-primary btn-sm" onClick={() => navigate('/documents/new')}><FileText size={14} /> New Document</button>} />
        ) : (
          <div className="flex flex-col" style={{ gap: 2 }}>
            {inflight.map((doc) => (
              <button key={doc.id} onClick={() => navigate(`/documents/${doc.id}`)} className="flex items-center gap-3"
                style={{ padding: '10px 0', borderTop: '1px solid var(--border)', background: 'none', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.title}</div>
                  <div style={{ fontSize: '0.73rem', color: 'var(--muted-foreground)' }}>{relTime(doc.updated_at)}</div>
                </div>
                <StatusBadge status={doc.status} />
              </button>
            ))}
            {drafts.length > 0 && (
              <>
                <div className="label-caps" style={{ padding: '12px 0 4px' }}>Resume a draft</div>
                {drafts.map((doc) => (
                  <button key={doc.id} onClick={() => navigate(`/documents/${doc.id}`)} className="flex items-center gap-3"
                    style={{ padding: '8px 0', background: 'none', cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                    <IconChip tone="muted" size={30}><FilePlus2 size={14} /></IconChip>
                    <div style={{ flex: 1, minWidth: 0, fontSize: '0.82rem', color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.title}</div>
                    <ArrowRight size={14} style={{ color: 'var(--muted-foreground)' }} />
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </Section>
    </GlassCard>
  );
}

// ── KPI row ──────────────────────────────────────────────────────────────────────
function KpiRow({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const navigate = useNavigate();
  const k = d.kpis;
  const scope = k.scope;
  const canManage = d.roles.canNewWorkflow || d.roles.canInvite; // managers/admins see the bottleneck
  const cards: { label: string; value: number | null; suffix?: string; display?: string; icon: React.ReactNode; tone: 'primary' | 'cyan' | 'amber' | 'success' | 'danger'; to: string; tip: string }[] = [
    { label: 'Approval rate', value: k.approvalRate, suffix: '%', icon: <CheckCircle2 size={18} />, tone: 'success', to: '/documents?status=approved', tip: 'Approved ÷ (Approved + Rejected). "—" when nothing has been decided yet.' },
    { label: 'Avg turnaround', value: null, display: fmtHours(k.avgTurnaroundHours), icon: <Timer size={18} />, tone: 'cyan', to: '/analytics', tip: 'Average time from submission to a decision.' },
    { label: 'Overdue items', value: k.overdueCount, icon: <AlertTriangle size={18} />, tone: 'amber', to: '/approvals', tip: 'Approval steps currently past their due date.' },
    { label: 'Documents processed', value: k.processed, icon: <TrendingUp size={18} />, tone: 'primary', to: '/documents', tip: 'Documents that reached a decision (approved or rejected).' },
  ];
  const bottleneck = canManage && d.bottleneck;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(210px, 1fr))`, gap: 16 }}>
      {d.stats.isError ? (
        <GlassCard style={{ padding: 20, gridColumn: '1 / -1' }}><WidgetError onRetry={() => { d.stats.refetch(); d.report.refetch(); }} /></GlassCard>
      ) : (
        <>
          {cards.map((c) => (
            <GlassCard key={c.label} variant="interactive" as="button" onClick={() => navigate(c.to)} title={c.tip}
              style={{ padding: 18, textAlign: 'left', width: '100%' }}>
              <div className="flex items-start justify-between" style={{ marginBottom: 12 }}>
                <div className="flex items-center gap-2">
                  <span className="label-caps" style={{ padding: 0 }}>{c.label}</span>
                  <ScopeChip scope={scope} />
                </div>
                <IconChip tone={c.tone} size={34}>{c.icon}</IconChip>
              </div>
              <div className="font-heading tabular" style={{ fontSize: '2rem', fontWeight: 800, lineHeight: 1, color: 'var(--foreground)', letterSpacing: '-0.02em' }}>
                {d.stats.isLoading ? <Skeleton style={{ height: 28, width: 70 }} /> : c.display !== undefined ? c.display : <Metric value={c.value} suffix={c.suffix} />}
              </div>
            </GlassCard>
          ))}
          {bottleneck && (
            <GlassCard variant="interactive" as="button" onClick={() => navigate('/analytics')} title="Stage with the longest average time to a decision."
              style={{ padding: 18, textAlign: 'left', width: '100%' }}>
              <div className="flex items-start justify-between" style={{ marginBottom: 12 }}>
                <span className="label-caps" style={{ padding: 0 }}>Slowest stage · workspace</span>
                <IconChip tone="danger" size={34}><Timer size={18} /></IconChip>
              </div>
              <div className="font-heading" style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {bottleneck.stage_name}
              </div>
              <div className="tabular" style={{ fontSize: '0.78rem', color: 'var(--muted-foreground)', marginTop: 2 }}>{fmtHours(bottleneck.avg_time_to_decision_hours)} avg</div>
            </GlassCard>
          )}
        </>
      )}
    </div>
  );
}

// ── Status pipeline (flow with a branch) ─────────────────────────────────────────
function PipelineNode({ label, count, tone, to, active }: { label: string; count: number; tone: string; to: string; active: boolean }) {
  return (
    <Link to={to} className="flex flex-col items-center" style={{ gap: 8, textDecoration: 'none', userSelect: 'none', flex: 1, minWidth: 72 }} title={`${count} ${label.toLowerCase()}`}>
      <div className="font-heading tabular" style={{
        width: 52, height: 52, borderRadius: 15, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1.15rem', fontWeight: 800, color: tone,
        background: `color-mix(in srgb, ${tone} ${active ? 18 : 10}%, transparent)`,
        border: `1.5px solid color-mix(in srgb, ${tone} ${active ? 50 : 24}%, transparent)`,
      }}>{count}</div>
      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--foreground)', userSelect: 'none' }}>{label}</span>
    </Link>
  );
}
function Connector({ filled }: { filled: boolean }) {
  return (
    <div style={{ flex: '0 0 32px', height: 2, marginBottom: 26, borderRadius: 2,
      background: filled ? 'linear-gradient(90deg, var(--chart-1), var(--chart-2))' : 'var(--border-strong)',
      opacity: filled ? 0.8 : 0.4 }} />
  );
}
function StatusPipeline({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const c = d.statusCounts;
  const main = [
    { key: 'draft', label: 'Draft', count: c.draft, tone: 'var(--status-draft)' },
    { key: 'submitted', label: 'Submitted', count: c.submitted, tone: 'var(--chart-2)' },
    { key: 'pending', label: 'In review', count: c.pending, tone: 'var(--chart-4)' },
    { key: 'approved', label: 'Approved', count: c.approved, tone: 'var(--chart-5)' },
  ];
  const branch = [
    { key: 'rejected', label: 'Rejected', count: c.rejected, tone: 'var(--destructive)' },
    { key: 'sent_back', label: 'Returned', count: c.sent_back, tone: 'var(--status-revoked)' },
  ];
  return (
    <GlassCard data-section style={{ padding: 22 }}>
      <Section title="Document pipeline" description="A current snapshot of where every document sits" noStagger>
        {d.report.isLoading ? (
          <Skeleton style={{ height: 96, borderRadius: 'var(--radius-lg)' }} />
        ) : d.report.isError ? (
          <WidgetError onRetry={() => d.report.refetch()} />
        ) : (
          <div className="pipeline-wrap" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* main track */}
            <div className="pipeline-track flex items-center" style={{ gap: 0 }}>
              {main.map((n, i) => (
                <div key={n.key} className="flex items-center" style={{ flex: 1 }}>
                  <PipelineNode label={n.label} count={n.count} tone={n.tone} to={`/documents?status=${n.key}`} active={n.count > 0} />
                  {i < main.length - 1 && <Connector filled={main.slice(i + 1).some((m) => m.count > 0) || n.count > 0} />}
                </div>
              ))}
            </div>
            {/* branch outcomes */}
            <div className="flex items-center" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span className="label-caps" style={{ padding: 0 }}>Alternate outcomes</span>
              <span style={{ color: 'var(--muted-foreground)' }}><GitBranch size={14} /></span>
              {branch.map((b) => (
                <Link key={b.key} to={`/documents?status=${b.key}`} className="flex items-center gap-2" style={{ textDecoration: 'none', userSelect: 'none', padding: '6px 12px', borderRadius: 'var(--radius-pill)', border: `1px solid color-mix(in srgb, ${b.tone} 28%, transparent)`, background: `color-mix(in srgb, ${b.tone} ${b.count > 0 ? 14 : 7}%, transparent)` }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: b.tone }} />
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--foreground)' }}>{b.label}</span>
                  <span className="tabular" style={{ fontSize: '0.8rem', fontWeight: 800, color: b.tone }}>{b.count}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </Section>
    </GlassCard>
  );
}

// ── Trend + Activity + Recent documents ──────────────────────────────────────────
function TrendCard({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const data = d.trend;
  return (
    <GlassCard style={{ padding: 22 }}>
      <Section title="Documents trend" description="Volume over time" noStagger>
        {d.stats.isLoading ? (
          <Skeleton style={{ height: 200 }} />
        ) : d.stats.isError ? (
          <WidgetError onRetry={() => d.stats.refetch()} />
        ) : data.length < 2 ? (
          <EmptyState art="chart" compact title="No trend yet" description="Trends appear once documents are processed." />
        ) : (
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={data} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ stroke: 'var(--primary)', strokeDasharray: '4 4' }}
                contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12, color: 'var(--popover-foreground)', boxShadow: 'var(--shadow-md)' }} />
              <Area type="monotone" dataKey="count" name="Documents" stroke="var(--chart-1)" strokeWidth={2.25} fill="url(#trendGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Section>
    </GlassCard>
  );
}
function ActivityCard({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const items = (d.activity.data?.items ?? []).slice(0, 6);
  return (
    <GlassCard style={{ padding: 22 }}>
      <Section title="Recent activity" noStagger>
        {d.activity.isLoading ? (
          <div className="flex flex-col gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} style={{ height: 36 }} />)}</div>
        ) : d.activity.isError ? (
          <WidgetError onRetry={() => d.activity.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState art="inbox" compact title="Nothing yet" description="Updates across your workspace will appear here." />
        ) : (
          <div className="flex flex-col">
            {items.map((n, i) => {
              const tone = n.type === 'rejected' ? 'var(--destructive)' : n.type === 'approved' ? 'var(--chart-5)' : 'var(--primary)';
              return (
                <div key={n.id} className="flex gap-3" style={{ paddingBottom: i < items.length - 1 ? 16 : 0, position: 'relative' }}>
                  {i < items.length - 1 && <div style={{ position: 'absolute', left: 13, top: 26, bottom: 0, width: 1.5, background: 'var(--border)' }} />}
                  <span style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: `color-mix(in srgb, ${tone} 16%, transparent)`, border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)`, color: tone, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Activity size={13} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.82rem', color: 'var(--foreground)', fontWeight: 600 }}>{n.title}</div>
                    {n.body && <div style={{ fontSize: '0.76rem', color: 'var(--muted-foreground)' }}>{n.body}</div>}
                    <div style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', marginTop: 2 }}>{relTime(n.created_at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </GlassCard>
  );
}
function RecentDocuments({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const navigate = useNavigate();
  const items: Document[] = d.recent.data?.items ?? [];
  return (
    <GlassCard style={{ padding: 22 }}>
      <Section title="Recent documents" action={<button className="btn btn-ghost btn-sm" onClick={() => navigate('/documents')}>View all <ArrowRight size={14} /></button>} noStagger>
        {d.recent.isLoading ? (
          <div className="flex flex-col gap-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} style={{ height: 40 }} />)}</div>
        ) : d.recent.isError ? (
          <WidgetError onRetry={() => d.recent.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState art="documents" compact title="No documents yet" description="Create your first document to get started."
            action={<button className="btn btn-primary btn-sm" onClick={() => navigate('/documents/new')}><FileText size={14} /> New Document</button>} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  {['Name', 'Type', 'Owner', 'Status', 'Updated'].map((h) => <th key={h} className="label-caps" style={{ padding: '0 8px 10px' }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {items.map((doc) => (
                  <tr key={doc.id} className="dash-row" onClick={() => navigate(`/documents/${doc.id}`)} style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '11px 8px', fontWeight: 600, color: 'var(--foreground)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className="flex items-center gap-2"><FileText size={15} style={{ color: 'var(--primary)', flexShrink: 0 }} />{doc.title}</span>
                    </td>
                    <td style={{ padding: '11px 8px', color: 'var(--muted-foreground)' }}>{doc.doc_type_name || 'Document'}</td>
                    <td style={{ padding: '11px 8px', color: 'var(--muted-foreground)' }}>{doc.submitter_name || '—'}</td>
                    <td style={{ padding: '11px 8px' }}><StatusBadge status={doc.status} /></td>
                    <td style={{ padding: '11px 8px', color: 'var(--muted-foreground)' }} className="tabular">{relTime(doc.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </GlassCard>
  );
}

// ── Get-started (fresh workspace) ────────────────────────────────────────────────
function GetStarted({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const navigate = useNavigate();
  const g = d.getStarted;
  const steps = [
    { label: 'Create your first document', done: g.hasDocuments, cta: () => navigate('/documents/new'), ctaLabel: 'Create', show: true },
    { label: 'Set up a workflow', done: g.hasWorkflow, cta: () => navigate('/workflows'), ctaLabel: 'Set up', show: d.roles.canNewWorkflow, hint: 'Ask an admin to set up an approval workflow.' },
    { label: 'Invite your team', done: g.hasTeam === true, cta: () => navigate('/admin/members'), ctaLabel: 'Invite', show: d.roles.canInvite, hint: 'An admin can invite teammates.' },
  ];
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  const pct = Math.round((done / total) * 100);
  const r = 26, circ = 2 * Math.PI * r, off = circ - (pct / 100) * circ;

  return (
    <GlassCard variant="elevated" style={{ padding: 28, maxWidth: 720, margin: '0 auto' }}>
      <div className="flex items-center gap-5" style={{ flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 72, height: 72, flexShrink: 0 }}>
          <svg width="72" height="72" viewBox="0 0 72 72" style={{ transform: 'rotate(-90deg)' }}>
            <circle cx="36" cy="36" r={r} fill="none" stroke="color-mix(in srgb, var(--muted-foreground) 20%, transparent)" strokeWidth="6" />
            <circle cx="36" cy="36" r={r} fill="none" stroke="var(--primary)" strokeWidth="6" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={off} style={{ transition: 'stroke-dashoffset 0.8s var(--ease-standard)' }} />
          </svg>
          <div className="tabular" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontFamily: 'var(--font-heading)', color: 'var(--foreground)' }}>{done}/{total}</div>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', fontWeight: 800, color: 'var(--foreground)', margin: 0 }}>Let's get your workspace set up</h2>
          <p style={{ fontSize: '0.88rem', color: 'var(--muted-foreground)', marginTop: 4 }}>A few steps and DocFlow is ready for your team.</p>
        </div>
      </div>

      <div className="flex flex-col" style={{ gap: 2, marginTop: 20 }}>
        {steps.map((s) => (
          <div key={s.label} className="flex items-center gap-3" style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
            <span style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.done ? 'color-mix(in srgb, var(--success) 16%, transparent)' : 'var(--muted)', border: `1px solid ${s.done ? 'color-mix(in srgb, var(--success) 40%, transparent)' : 'var(--border)'}`, color: s.done ? 'var(--success)' : 'var(--muted-foreground)' }}>
              {s.done ? <Check size={14} /> : <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--muted-foreground)' }} />}
            </span>
            <span style={{ flex: 1, fontSize: '0.9rem', fontWeight: 600, color: s.done ? 'var(--muted-foreground)' : 'var(--foreground)', textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</span>
            {!s.done && (s.show ? (
              <button className="btn btn-secondary btn-sm" onClick={s.cta}>{s.ctaLabel} <ArrowRight size={13} /></button>
            ) : s.hint ? (
              <span style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>{s.hint}</span>
            ) : null)}
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

// ── Create "+" menu (role-gated extras) ──────────────────────────────────────────
function CreateMenu({ d }: { d: ReturnType<typeof useDashboardData> }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const extras = [
    d.roles.canNewWorkflow && { icon: <GitBranch size={15} />, label: 'New Workflow', to: '/workflows' },
    d.roles.canInvite && { icon: <UserPlus size={15} />, label: 'Invite Team', to: '/admin/members' },
  ].filter(Boolean) as { icon: React.ReactNode; label: string; to: string }[];
  if (extras.length === 0) return null;
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn btn-secondary btn-icon" aria-label="More create actions" onClick={() => setOpen((v) => !v)}>
        <Plus size={16} />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setOpen(false)} />
            <motion.div initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.97 }} transition={fmTransition.micro}
              className="glass-card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', minWidth: 180, zIndex: 50, padding: 6 }}>
              {extras.map((x) => (
                <button key={x.to} className="btn btn-ghost" style={{ width: '100%', justifyContent: 'flex-start', gap: 10, fontSize: '0.86rem' }} onClick={() => { setOpen(false); navigate(x.to); }}>
                  {x.icon} {x.label}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const navigate = useNavigate();
  const pageRef = usePageTransition<HTMLDivElement>();
  const d = useDashboardData();

  const firstName = (d.user?.name ?? 'there').split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div ref={pageRef} className="page-content" style={{ paddingTop: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader
        title={<>{greeting}, <span className="gradient-text">{firstName}</span></>}
        description="Here's your workspace at a glance."
        actions={
          <>
            <CreateMenu d={d} />
            <button className="btn btn-secondary" onClick={() => navigate('/documents/new')}><Upload size={16} /> Upload</button>
            <button className="btn btn-primary" onClick={() => navigate('/documents/new')}><FileText size={16} /> New Document</button>
          </>
        }
      />

      {d.isFresh ? (
        <div data-section><GetStarted d={d} /></div>
      ) : (
        <>
          {/* Row A — Needs your action (hero) + My documents in progress */}
          <div data-section className="dash-rowA" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 20 }}>
            {d.roles.canApprove ? <NeedsYourAction d={d} /> : <ReturnedToYou d={d} />}
            <MyInProgress d={d} />
          </div>

          {/* Row B — KPI period metrics */}
          <div data-section><KpiRow d={d} /></div>

          {/* Row C — Status pipeline (ONLY place for status counts) */}
          <StatusPipeline d={d} />

          {/* Row D — Trend + Activity */}
          <div data-section className="dash-rowD" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 20 }}>
            <TrendCard d={d} />
            <ActivityCard d={d} />
          </div>

          {/* Row E — Recent documents */}
          <div data-section><RecentDocuments d={d} /></div>
        </>
      )}

      <style>{`
        .dash-row:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
        @media (max-width: 1024px) { .dash-rowA, .dash-rowD { grid-template-columns: 1fr !important; } }
        @media (max-width: 640px) { .pipeline-track { flex-direction: column !important; align-items: stretch !important; } .pipeline-track > div { flex-direction: row !important; justify-content: space-between; } }
      `}</style>
    </div>
  );
}
