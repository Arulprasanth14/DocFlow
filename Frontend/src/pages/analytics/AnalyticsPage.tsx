/**
 * DocFlow Frontend — Analytics Page (§9)
 *
 * Every figure here comes from GET /api/v1/analytics/report, which computes
 * server-side SQL aggregates over the whole selected period. Nothing is
 * derived from a page of client-side rows, and there are no placeholder
 * numbers: if the period has no activity the page says so.
 *
 * Reporting period defaults to MONTHLY and can be switched to YEARLY, per
 * §9. The response also reports the data `scope` the caller's role allowed
 * (organization / own+department / own), which is shown in the header so
 * org-wide figures are never implied when they weren't granted.
 *
 * Sections previously on this page that the backend has no data for —
 * document "views", an approver leaderboard, a top-documents table — were
 * removed rather than kept as invented numbers. Bottleneck stages (real,
 * and required by §9) take their place.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import {
  BarChart2, FileText, CheckCircle, XCircle, Clock, Activity,
  AlertTriangle, Loader2, Info, Users, GitBranch, RotateCcw,
} from 'lucide-react';
import { analyticsApi, type ReportPeriod } from '@/lib/api/analytics';

const C = {
  card: 'var(--bg-elevated)',
  surface: 'var(--bg-surface)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-500)',
  primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)',
  purple: 'var(--color-accent-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  disabled: 'var(--text-disabled)',
};

const SCOPE_LABEL: Record<string, string> = {
  organization: 'Organization-wide',
  own_and_department: 'Your documents and departments',
  own: 'Your documents only',
  none: 'No organization context',
};

const STATUS_COLOR: Record<string, string> = {
  approved: C.success,
  finalized: C.success,
  rejected: C.danger,
  pending: C.warning,
  submitted: C.warning,
  draft: C.muted,
  ready: C.primary400,
  sent_back: C.warning,
  revoked: C.danger,
  cancelled: C.disabled,
  archived: C.disabled,
  expired: C.disabled,
};

function fmtHours(h: number | null | undefined): string {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function KpiCard({
  icon: Icon, label, value, color, sub,
}: {
  icon: React.ElementType; label: string; value: string; color: string; sub?: string;
}) {
  return (
    <div
      style={{
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 20,
        padding: '20px 22px', flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column', gap: 12,
      }}
    >
      <div
        style={{
          width: 40, height: 40, borderRadius: 12,
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon size={20} color={color} />
      </div>
      <div>
        <div style={{ color: C.heading, fontSize: 30, fontWeight: 800, lineHeight: 1 }}>
          {value}
        </div>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 5 }}>{label}</div>
        {sub && (
          <div style={{ color, fontSize: 11, marginTop: 3, fontWeight: 600 }}>{sub}</div>
        )}
      </div>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: 'var(--bg-elevated)', border: `1px solid ${C.border}`,
        borderRadius: 12, padding: '10px 14px', fontSize: 12,
      }}
    >
      <div style={{ color: C.muted, marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color || p.fill }} />
          <span style={{ color: C.body }}>{p.name}: </span>
          <span style={{ color: C.heading, fontWeight: 700 }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
};

function Panel({
  title, subtitle, children, empty,
}: {
  title: string; subtitle?: string; children: React.ReactNode; empty?: boolean;
}) {
  return (
    <div
      style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 20, padding: '20px 22px', flex: 1, minWidth: 0,
      }}
    >
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.heading }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>{subtitle}</div>
        )}
      </div>
      {empty ? (
        <div style={{ fontSize: 12.5, color: C.disabled, padding: '26px 0', textAlign: 'center' }}>
          No data for this period
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const now = new Date();
  const [period, setPeriod] = useState<ReportPeriod>('monthly');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['analytics', 'report', period, year, month],
    queryFn: () =>
      analyticsApi.getReport(
        period === 'monthly' ? { period, year, month } : { period, year },
      ),
  });

  const docCounts = data?.documents.created_in_period ?? {};

  const kpis = useMemo(() => {
    if (!data) return [];
    const approved = (docCounts.approved ?? 0) + (docCounts.finalized ?? 0);
    const rejected = docCounts.rejected ?? 0;
    const total = data.documents.created_total;
    const rate = total ? ((approved / total) * 100).toFixed(1) : null;
    return [
      {
        icon: FileText,
        label: 'Documents created',
        value: String(total),
        color: C.primary400,
        sub: `in ${data.period_label}`,
      },
      {
        icon: CheckCircle,
        label: 'Approved or finalized',
        value: String(approved),
        color: C.success,
        sub: rate ? `${rate}% of created` : undefined,
      },
      {
        icon: XCircle,
        label: 'Rejected',
        value: String(rejected),
        color: C.danger,
        sub: total ? `${((rejected / total) * 100).toFixed(1)}% of created` : undefined,
      },
      {
        icon: Clock,
        label: 'Avg time to decision',
        value: fmtHours(data.approvals.avg_time_to_decision_hours),
        color: C.warning,
        sub: `${data.approvals.decisions_made} decision${
          data.approvals.decisions_made === 1 ? '' : 's'
        }`,
      },
    ];
  }, [data, docCounts]);

  const monthSeries = useMemo(
    () =>
      (data?.breakdowns.by_month ?? []).map((b) => ({
        label: b.key ?? '',
        created: b.count,
      })),
    [data],
  );

  const statusSeries = useMemo(
    () =>
      (data?.breakdowns.by_status ?? [])
        .filter((b) => b.count > 0)
        .map((b) => ({
          name: (b.key ?? 'unknown').replace(/_/g, ' '),
          value: b.count,
          color: STATUS_COLOR[b.key ?? ''] ?? C.muted,
        })),
    [data],
  );

  const deptSeries = useMemo(
    () =>
      (data?.breakdowns.by_department ?? [])
        .filter((b) => b.count > 0)
        .map((b) => ({ label: b.label ?? 'Unassigned', docs: b.count })),
    [data],
  );

  return (
    <div style={{ position: 'relative', minHeight: '100%', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute', bottom: -200, left: -150, width: 800, height: 800,
          borderRadius: 9999,
          background: 'radial-gradient(circle, rgba(37,99,235,0.16) 0%, transparent 68%)',
          filter: 'blur(240px)', zIndex: 1, pointerEvents: 'none',
        }}
      />

      <div
        style={{
          position: 'relative', zIndex: 10, padding: 32,
          display: 'flex', flexDirection: 'column', gap: 22,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: 16,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div
                style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: `color-mix(in srgb, ${C.primary400} 12%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${C.primary400} 25%, transparent)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <BarChart2 size={18} color={C.primary400} />
              </div>
              <h1 style={{ fontSize: 26, fontWeight: 800, color: C.heading, margin: 0 }}>
                Analytics
              </h1>
              {isFetching && <Loader2 size={15} color={C.muted} className="aspin" />}
            </div>
            <p style={{ color: C.muted, fontSize: 13.5, margin: 0 }}>
              {data
                ? `${SCOPE_LABEL[data.scope] ?? data.scope} · ${data.period_label} · times in ${data.timezone}`
                : 'Document workflow metrics from your organization\'s records'}
            </p>
          </div>

          {/* Period switcher (§9) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div
              style={{
                display: 'flex', background: C.surface,
                border: `1px solid ${C.borderSubtle}`, borderRadius: 12, padding: 4, gap: 2,
              }}
            >
              {(['monthly', 'yearly'] as ReportPeriod[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  style={{
                    padding: '7px 16px', borderRadius: 9, border: 'none', cursor: 'pointer',
                    background: period === p ? C.primary : 'transparent',
                    color: period === p ? '#fff' : C.muted,
                    fontSize: 12.5, fontWeight: period === p ? 700 : 500,
                    textTransform: 'capitalize', transition: 'all 0.15s',
                  }}
                >
                  {p}
                </button>
              ))}
            </div>

            {period === 'monthly' && (
              <select
                className="input"
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                style={{ fontSize: 12.5, width: 'auto', padding: '8px 10px' }}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <option key={m} value={m}>
                    {new Date(2000, m - 1, 1).toLocaleString(undefined, { month: 'long' })}
                  </option>
                ))}
              </select>
            )}

            <select
              className="input"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              style={{ fontSize: 12.5, width: 'auto', padding: '8px 10px' }}
            >
              {Array.from({ length: 6 }, (_, i) => now.getFullYear() - i).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* States */}
        {isLoading ? (
          <div style={{ padding: 60, textAlign: 'center' }}>
            <Loader2 size={24} color={C.muted} className="aspin" />
          </div>
        ) : isError ? (
          <div
            style={{
              background: `color-mix(in srgb, ${C.danger} 8%, transparent)`,
              border: `1px solid color-mix(in srgb, ${C.danger} 25%, transparent)`,
              borderRadius: 16, padding: 22, display: 'flex', gap: 10,
            }}
          >
            <AlertTriangle size={17} color={C.danger} style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.heading }}>
                Couldn't load analytics
              </div>
              <div style={{ fontSize: 12.5, color: C.body, marginTop: 3 }}>
                {(error as Error)?.message || 'Please try again.'}
              </div>
            </div>
          </div>
        ) : !data ? null : !data.has_data ? (
          <div
            style={{
              background: C.card, border: `1px dashed ${C.border}`,
              borderRadius: 18, padding: '52px 30px', textAlign: 'center',
            }}
          >
            <Info size={26} color={C.disabled} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: C.heading, marginBottom: 6 }}>
              No activity in {data.period_label}
            </div>
            <div style={{ fontSize: 13, color: C.muted }}>
              Pick a different period, or submit a document to start building history.
            </div>
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {kpis.map((k) => (
                <KpiCard key={k.label} {...k} />
              ))}
            </div>

            {/* Workflow + approval health */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <KpiCard
                icon={GitBranch}
                label="Workflows started"
                value={String(data.workflows.instances_started)}
                color={C.purple}
                sub={`${data.workflows.currently_open} currently open`}
              />
              <KpiCard
                icon={Activity}
                label="Completion rate"
                value={
                  data.workflows.completion_rate == null
                    ? '—'
                    : `${(data.workflows.completion_rate * 100).toFixed(0)}%`
                }
                color={C.success}
                sub={`avg ${fmtHours(data.workflows.avg_completion_hours)} to complete`}
              />
              <KpiCard
                icon={Clock}
                label="Pending approvals"
                value={String(data.approvals.pending_now)}
                color={C.warning}
                sub={`${data.approvals.overdue_now} overdue`}
              />
              <KpiCard
                icon={RotateCcw}
                label="Approvals revoked"
                value={String(data.approvals.revoked_in_period)}
                color={C.danger}
                sub={`in ${data.period_label}`}
              />
            </div>

            {/* Trend + status mix */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <Panel
                title="Documents created"
                subtitle={`Bucketed on ${data.documents.created_bucketed_on}`}
                empty={monthSeries.every((m) => m.created === 0)}
              >
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={monthSeries}>
                    <defs>
                      <linearGradient id="gCreated" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.primary400} stopOpacity={0.5} />
                        <stop offset="100%" stopColor={C.primary400} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="label" stroke={C.muted} fontSize={11} />
                    <YAxis stroke={C.muted} fontSize={11} allowDecimals={false} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area
                      type="monotone" dataKey="created" name="Created"
                      stroke={C.primary400} strokeWidth={2} fill="url(#gCreated)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </Panel>

              <div style={{ flex: '0 0 320px', minWidth: 280 }}>
                <Panel
                  title="Document status mix"
                  subtitle={`Created in ${data.period_label}`}
                  empty={statusSeries.length === 0}
                >
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={statusSeries} dataKey="value" nameKey="name"
                        cx="50%" cy="50%" innerRadius={48} outerRadius={78} paddingAngle={3}
                      >
                        {statusSeries.map((s) => (
                          <Cell key={s.name} fill={s.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                    {statusSeries.map((s) => (
                      <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }} />
                        <span style={{ color: C.body, textTransform: 'capitalize', flex: 1 }}>
                          {s.name}
                        </span>
                        <span style={{ color: C.heading, fontWeight: 700 }}>{s.value}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            </div>

            {/* Breakdowns */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <Panel
                title="By department"
                subtitle="Documents created in this period"
                empty={deptSeries.length === 0}
              >
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={deptSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                    <XAxis dataKey="label" stroke={C.muted} fontSize={11} />
                    <YAxis stroke={C.muted} fontSize={11} allowDecimals={false} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="docs" name="Documents" fill={C.primary400} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Panel>

              <Panel
                title="By document type"
                subtitle="Documents created in this period"
                empty={(data.breakdowns.by_document_type ?? []).length === 0}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {data.breakdowns.by_document_type.map((b) => (
                    <div key={b.key ?? b.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12.5, color: C.body, flex: 1 }}>{b.label}</span>
                      <span style={{ fontSize: 12.5, color: C.heading, fontWeight: 700 }}>
                        {b.count}
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel
                title="By workflow"
                subtitle="Workflow instances started"
                empty={(data.breakdowns.by_workflow ?? []).length === 0}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                  {data.breakdowns.by_workflow.map((b) => (
                    <div key={b.key ?? b.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 12.5, color: C.body, flex: 1 }}>{b.label}</span>
                      <span style={{ fontSize: 12.5, color: C.heading, fontWeight: 700 }}>
                        {b.count}
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            </div>

            {/* Bottlenecks (§9) */}
            <Panel
              title="Bottleneck stages"
              subtitle="Slowest stages by average time to decision, with what's still waiting there"
              empty={data.bottlenecks.length === 0}
            >
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: C.muted }}>
                      <th style={{ padding: '7px 10px', fontWeight: 600 }}>Stage</th>
                      <th style={{ padding: '7px 10px', fontWeight: 600 }}>Avg decision time</th>
                      <th style={{ padding: '7px 10px', fontWeight: 600 }}>Decisions</th>
                      <th style={{ padding: '7px 10px', fontWeight: 600 }}>Pending</th>
                      <th style={{ padding: '7px 10px', fontWeight: 600 }}>Overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bottlenecks.map((b) => (
                      <tr key={b.stage_id} style={{ borderTop: `1px solid ${C.borderSubtle}` }}>
                        <td style={{ padding: '9px 10px', color: C.heading, fontWeight: 600 }}>
                          {b.stage_name}
                        </td>
                        <td style={{ padding: '9px 10px', color: C.body }}>
                          {fmtHours(b.avg_time_to_decision_hours)}
                        </td>
                        <td style={{ padding: '9px 10px', color: C.body }}>
                          {b.decisions_in_period}
                        </td>
                        <td style={{ padding: '9px 10px', color: b.pending_now ? C.warning : C.body }}>
                          {b.pending_now}
                        </td>
                        <td style={{ padding: '9px 10px', color: b.overdue_now ? C.danger : C.body }}>
                          {b.overdue_now}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <div
              style={{
                fontSize: 11, color: C.disabled, display: 'flex',
                alignItems: 'center', gap: 6,
              }}
            >
              <Users size={11} />
              {SCOPE_LABEL[data.scope] ?? data.scope} — figures reflect only the
              records your role permits. Generated{' '}
              {new Date(data.generated_at).toLocaleString()}.
            </div>
          </>
        )}
      </div>

      <style>{`
        .aspin { animation: aspin 0.9s linear infinite; }
        @keyframes aspin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
