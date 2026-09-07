/**
 * DocFlow Frontend — Analytics Page
 * KPI dashboard with charts: area, bar, donut, leaderboard, top docs table.
 */

import { useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid
} from 'recharts';
import {
  BarChart2, TrendingUp, FileText, CheckCircle, XCircle,
  Clock, Users, ArrowUpRight, ArrowDownRight, Activity,
  Award, Download
} from 'lucide-react';
import { useDashboardStats } from '@/hooks/useAnalytics';

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

// ── Mock Data ─────────────────────────────────────────────────────────────────
const weeklyTrend = [
  { day: 'Mon', submitted: 12, approved: 9, rejected: 1 },
  { day: 'Tue', submitted: 19, approved: 15, rejected: 2 },
  { day: 'Wed', submitted: 16, approved: 11, rejected: 3 },
  { day: 'Thu', submitted: 28, approved: 22, rejected: 2 },
  { day: 'Fri', submitted: 24, approved: 18, rejected: 4 },
  { day: 'Sat', submitted: 8, approved: 6, rejected: 0 },
  { day: 'Sun', submitted: 11, approved: 9, rejected: 1 },
];

const monthlyTrend = [
  { day: 'Sep 1', submitted: 45, approved: 38, rejected: 4 },
  { day: 'Sep 5', submitted: 62, approved: 51, rejected: 7 },
  { day: 'Sep 10', submitted: 55, approved: 44, rejected: 6 },
  { day: 'Sep 15', submitted: 78, approved: 65, rejected: 8 },
  { day: 'Sep 20', submitted: 91, approved: 74, rejected: 10 },
  { day: 'Sep 25', submitted: 84, approved: 70, rejected: 9 },
  { day: 'Sep 30', submitted: 72, approved: 61, rejected: 7 },
];

const deptData = [
  { dept: 'Finance', docs: 34, color: C.primary400 },
  { dept: 'HR', docs: 27, color: C.purple },
  { dept: 'Legal', docs: 18, color: C.warning },
  { dept: 'IT', docs: 22, color: C.success },
  { dept: 'Marketing', docs: 15, color: C.danger },
  { dept: 'Strategy', docs: 12, color: C.body },
];

const statusPie = [
  { name: 'Approved', value: 58, color: C.success },
  { name: 'Pending', value: 24, color: C.warning },
  { name: 'Under Review', value: 12, color: C.purple },
  { name: 'Rejected', value: 6, color: C.danger },
];

const topDocs = [
  { name: 'Q4 Financial Report 2026', dept: 'Finance', views: 84, approvals: 12, progress: 100 },
  { name: 'AWS Vendor Contract', dept: 'Legal', views: 61, approvals: 8, progress: 75 },
  { name: 'Remote Work Policy v2.1', dept: 'HR', views: 55, approvals: 7, progress: 90 },
  { name: 'Product Roadmap H1 2027', dept: 'Strategy', views: 49, approvals: 5, progress: 100 },
  { name: 'Security Audit Report Q3', dept: 'IT', views: 38, approvals: 4, progress: 45 },
];

const leaderboard = [
  { name: 'Sarah Mitchell', dept: 'Finance', approvals: 47, avatar: 'SM', color: C.primary400 },
  { name: 'James Lee', dept: 'Legal', approvals: 38, avatar: 'JL', color: C.purple },
  { name: 'Anika Patel', dept: 'HR', approvals: 31, avatar: 'AP', color: C.success },
  { name: 'Chris Obi', dept: 'IT', approvals: 26, avatar: 'CO', color: C.warning },
  { name: 'Yuki Tanaka', dept: 'Strategy', approvals: 21, avatar: 'YT', color: C.danger },
];

type Period = 'week' | 'month';

// ── Sub-components ─────────────────────────────────────────────────────────────

function KpiCard({ icon: Icon, label, value, change, up, color, sub }: {
  icon: React.ElementType; label: string; value: string; change: string; up: boolean; color: string; sub?: string;
}) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: '20px 22px', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={20} color={color} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: up ? C.success : C.danger, fontSize: 12, fontWeight: 700 }}>
          {up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          {change}
        </div>
      </div>
      <div>
        <div style={{ color: C.heading, fontSize: 30, fontWeight: 800, lineHeight: 1 }}>{value}</div>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 5 }}>{label}</div>
        {sub && <div style={{ color: color, fontSize: 11, marginTop: 3, fontWeight: 600 }}>{sub}</div>}
      </div>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--bg-elevated)', border: `1px solid ${C.border}`, borderRadius: 12, padding: '10px 14px', fontSize: 12 }}>
      <div style={{ color: C.muted, marginBottom: 6, fontWeight: 600 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color }} />
          <span style={{ color: C.body }}>{p.name}: </span>
          <span style={{ color: C.heading, fontWeight: 700 }}>{p.value}</span>
        </div>
      ))}
    </div>
  );
};

function ProgressBar({ value, color = C.primary400 }: { value: number; color?: string }) {
  return (
    <div style={{ background: C.overlay, borderRadius: 99, height: 5, overflow: 'hidden', flex: 1 }}>
      <div style={{ width: `${value}%`, height: '100%', background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 65%, transparent))`, borderRadius: 99 }} />
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const [period, setPeriod] = useState<Period>('week');
  const { data: stats } = useDashboardStats();

  const trendData = period === 'week' ? weeklyTrend : monthlyTrend;

  const kpis = [
    { icon: FileText, label: 'Documents Submitted', value: stats?.documents_submitted?.toString() || '148', change: '+12%', up: true, color: C.primary400, sub: 'This month' },
    { icon: CheckCircle, label: 'Approved', value: stats?.documents_approved?.toString() || '112', change: '+8%', up: true, color: C.success, sub: '75.7% approval rate' },
    { icon: XCircle, label: 'Rejected', value: '14', change: '+2', up: false, color: C.danger, sub: '9.4% rejection rate' },
    { icon: Clock, label: 'Avg Approval Time', value: '1.8d', change: '-12%', up: true, color: C.warning, sub: 'vs 2.1d last month' },
  ];

  return (
    <div style={{ position: 'relative', minHeight: '100%', overflow: 'hidden' }}>
      {/* Ambient */}
      <div style={{ position: 'absolute', bottom: -200, left: -150, width: 800, height: 800, borderRadius: 9999, background: 'radial-gradient(circle, rgba(37,99,235,0.16) 0%, transparent 68%)', filter: 'blur(240px)', zIndex: 1, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: -150, right: -150, width: 700, height: 700, borderRadius: 9999, background: 'radial-gradient(circle, rgba(124,58,237,0.14) 0%, transparent 65%)', filter: 'blur(220px)', zIndex: 1, pointerEvents: 'none' }} />

      <div style={{ position: 'relative', zIndex: 10, padding: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: `color-mix(in srgb, ${C.primary400} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${C.primary400} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <BarChart2 size={18} color={C.primary400} />
              </div>
              <h1 style={{ fontSize: 26, fontWeight: 800, color: C.heading, margin: 0 }}>Analytics</h1>
            </div>
            <p style={{ color: C.muted, fontSize: 14, margin: 0 }}>Document workflow metrics and performance insights</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Period Selector */}
            <div style={{ display: 'flex', background: C.surface, border: `1px solid ${C.borderSubtle}`, borderRadius: 12, padding: 4, gap: 2 }}>
              {(['week', 'month'] as Period[]).map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  style={{
                    padding: '6px 16px', borderRadius: 9, border: 'none', cursor: 'pointer',
                    fontSize: 13, fontWeight: 600, transition: 'all 0.2s',
                    background: period === p ? C.card : 'transparent',
                    color: period === p ? C.primary400 : C.muted,
                    boxShadow: period === p ? '0 2px 8px rgba(0,0,0,0.3)' : 'none',
                  }}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
            <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, color: C.body, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <Download size={14} /> Export
            </button>
          </div>
        </div>

        {/* KPI Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          {kpis.map(k => <KpiCard key={k.label} {...k} />)}
        </div>

        {/* Charts Row 1: Trend + Status Pie */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20 }}>
          {/* Area Chart */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: '22px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div>
                <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Document Submission Trend</h3>
                <p style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Submitted, Approved, and Rejected over time</p>
              </div>
              <Activity size={16} color={C.muted} />
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={trendData}>
                <defs>
                  <linearGradient id="gradSubmit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.primary400} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={C.primary400} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradApprove" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.success} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={C.success} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={`color-mix(in srgb, ${C.border} 50%, transparent)`} vertical={false} />
                <XAxis dataKey="day" tick={{ fill: C.disabled, fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.disabled, fontSize: 11 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="submitted" name="Submitted" stroke={C.primary400} strokeWidth={2} fill="url(#gradSubmit)" dot={false} />
                <Area type="monotone" dataKey="approved" name="Approved" stroke={C.success} strokeWidth={2} fill="url(#gradApprove)" dot={false} />
                <Area type="monotone" dataKey="rejected" name="Rejected" stroke={C.danger} strokeWidth={1.5} fill="none" dot={false} strokeDasharray="4 3" />
              </AreaChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 20, marginTop: 12 }}>
              {[{ label: 'Submitted', color: C.primary400 }, { label: 'Approved', color: C.success }, { label: 'Rejected', color: C.danger }].map(l => (
                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ width: 10, height: 3, background: l.color, borderRadius: 99 }} />
                  <span style={{ color: C.muted, fontSize: 12 }}>{l.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Donut Chart */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: '22px 24px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Status Distribution</h3>
              <p style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Current document statuses</p>
            </div>
            <div style={{ position: 'relative', flex: 1 }}>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={statusPie} cx="50%" cy="50%" innerRadius={48} outerRadius={72} paddingAngle={3} dataKey="value" stroke="none">
                    {statusPie.map((entry, i) => (
                      <Cell key={i} fill={entry.color} fillOpacity={0.85} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(val: any, name: any) => [`${val}%`, name]} contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              {/* Center label */}
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ color: C.heading, fontWeight: 800, fontSize: 20, lineHeight: 1 }}>100%</div>
                <div style={{ color: C.muted, fontSize: 10 }}>Total</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {statusPie.map(s => (
                <div key={s.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.color }} />
                    <span style={{ color: C.body, fontSize: 12 }}>{s.name}</span>
                  </div>
                  <span style={{ color: s.color, fontSize: 12, fontWeight: 700 }}>{s.value}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Charts Row 2: Dept Bar + Top Docs + Leaderboard */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {/* Bar Chart */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: '22px 24px' }}>
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Documents by Department</h3>
              <p style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Volume breakdown across teams</p>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={deptData} barSize={20}>
                <CartesianGrid strokeDasharray="3 3" stroke={`color-mix(in srgb, ${C.border} 50%, transparent)`} vertical={false} />
                <XAxis dataKey="dept" tick={{ fill: C.disabled, fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: C.disabled, fontSize: 11 }} axisLine={false} tickLine={false} width={28} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 12 }} />
                <Bar dataKey="docs" name="Documents" radius={[6, 6, 0, 0]}>
                  {deptData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Leaderboard */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: '22px 24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Top Approvers</h3>
                <p style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Most active this {period}</p>
              </div>
              <Award size={16} color={C.warning} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {leaderboard.map((person, i) => (
                <div key={person.name} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 22, color: i === 0 ? C.warning : C.disabled, fontSize: 13, fontWeight: 800, textAlign: 'center' }}>
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}
                  </div>
                  <div style={{ width: 34, height: 34, borderRadius: '50%', background: `color-mix(in srgb, ${person.color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${person.color} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span style={{ fontSize: 12, color: person.color, fontWeight: 700 }}>{person.avatar}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: C.heading, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{person.name}</div>
                    <div style={{ color: C.muted, fontSize: 11 }}>{person.dept}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <CheckCircle size={13} color={C.success} />
                    <span style={{ color: C.success, fontSize: 13, fontWeight: 700 }}>{person.approvals}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Top Documents Table */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 20, padding: '22px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Most Processed Documents</h3>
              <p style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Highest activity documents this {period}</p>
            </div>
            <TrendingUp size={16} color={C.success} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 120px 80px 80px 180px', gap: 16, padding: '8px 12px', marginBottom: 4 }}>
              {['Document', 'Department', 'Views', 'Approvals', 'Completion'].map(h => (
                <div key={h} style={{ color: C.disabled, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</div>
              ))}
            </div>
            {topDocs.map((doc, i) => (
              <div key={doc.name} style={{ display: 'grid', gridTemplateColumns: '2fr 120px 80px 80px 180px', gap: 16, padding: '12px', borderRadius: 12, alignItems: 'center', transition: 'background 0.15s', cursor: 'pointer' }}
                className="table-row"
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span style={{ color: C.disabled, fontSize: 12, fontWeight: 700, width: 20, flexShrink: 0 }}>{i + 1}</span>
                  <FileText size={14} color={C.primary400} style={{ flexShrink: 0 }} />
                  <span style={{ color: C.heading, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.name}</span>
                </div>
                <span style={{ fontSize: 11, padding: '3px 8px', background: C.overlay, border: `1px solid ${C.borderSubtle}`, borderRadius: 6, color: C.muted, width: 'fit-content' }}>{doc.dept}</span>
                <span style={{ color: C.body, fontSize: 13, fontWeight: 600 }}>{doc.views}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle size={12} color={C.success} />
                  <span style={{ color: C.success, fontSize: 13, fontWeight: 600 }}>{doc.approvals}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ProgressBar value={doc.progress} color={doc.progress === 100 ? C.success : C.primary400} />
                  <span style={{ color: doc.progress === 100 ? C.success : C.primary400, fontSize: 12, fontWeight: 700, width: 36, textAlign: 'right' }}>{doc.progress}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        .table-row:hover { background: var(--bg-overlay) !important; }
      `}</style>
    </div>
  );
}
