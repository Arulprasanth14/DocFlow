/**
 * DocFlow Frontend — Workflows Page
 * Full workflow management UI: pipeline visualization, stats, filters, workflow cards.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GitBranch, Plus, Clock, CheckCircle, XCircle,
  ArrowRight, Filter, Search, AlertCircle,
  TrendingUp, Zap, MoreVertical, ChevronRight,
  FileText, Users, BarChart2
} from 'lucide-react';

// ── Design tokens (matching DashboardPage) ───────────────────────────────────
const C = {
  bg: 'var(--bg-base)',
  card: 'var(--bg-elevated)',
  surface: 'var(--bg-surface)',
  overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)',
  borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-500)',
  primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)',
  danger: 'var(--color-error-400)',
  warning: 'var(--color-warning-400)',
  purple: 'var(--color-accent-400)',
  heading: 'var(--text-primary)',
  body: 'var(--text-secondary)',
  muted: 'var(--text-muted)',
  disabled: 'var(--text-disabled)',
};

// ── Types ─────────────────────────────────────────────────────────────────────
type WFStatus = 'active' | 'completed' | 'archived' | 'paused';

interface WorkflowStep {
  label: string;
  status: 'done' | 'active' | 'pending';
  color: string;
}

interface Workflow {
  id: string;
  name: string;
  document: string;
  docType: string;
  status: WFStatus;
  steps: WorkflowStep[];
  currentStep: string;
  progress: number;
  assignees: string[];
  createdAt: string;
  sla: 'on-time' | 'warning' | 'breached';
  slaText: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
}

// ── Mock Data ─────────────────────────────────────────────────────────────────
const mockWorkflows: Workflow[] = [
  {
    id: 'wf-001', name: 'Finance Approval Chain', document: 'Q4 Budget Report 2026',
    docType: 'Finance', status: 'active',
    steps: [
      { label: 'Draft', status: 'done', color: C.muted },
      { label: 'Review', status: 'done', color: C.primary400 },
      { label: 'Approve', status: 'active', color: C.warning },
      { label: 'Sign', status: 'pending', color: C.purple },
      { label: 'Archive', status: 'pending', color: C.success },
    ],
    currentStep: 'Approval', progress: 60, assignees: ['SM', 'JL', 'AP'],
    createdAt: '2 days ago', sla: 'warning', slaText: '6h left', priority: 'high',
  },
  {
    id: 'wf-002', name: 'Legal Contract Review', document: 'AWS Vendor Contract 2026',
    docType: 'Legal', status: 'active',
    steps: [
      { label: 'Draft', status: 'done', color: C.muted },
      { label: 'Review', status: 'active', color: C.primary400 },
      { label: 'Approve', status: 'pending', color: C.warning },
      { label: 'Sign', status: 'pending', color: C.purple },
      { label: 'Archive', status: 'pending', color: C.success },
    ],
    currentStep: 'Legal Review', progress: 35, assignees: ['KP', 'MW'],
    createdAt: '1 day ago', sla: 'on-time', slaText: '3d left', priority: 'normal',
  },
  {
    id: 'wf-003', name: 'HR Policy Update', document: 'Remote Work Policy v2.1',
    docType: 'HR', status: 'active',
    steps: [
      { label: 'Draft', status: 'done', color: C.muted },
      { label: 'Review', status: 'done', color: C.primary400 },
      { label: 'Approve', status: 'done', color: C.warning },
      { label: 'Sign', status: 'active', color: C.purple },
      { label: 'Archive', status: 'pending', color: C.success },
    ],
    currentStep: 'Digital Signing', progress: 80, assignees: ['LR', 'CO'],
    createdAt: '4 days ago', sla: 'on-time', slaText: '1d left', priority: 'urgent',
  },
  {
    id: 'wf-004', name: 'Product Roadmap Sign-off', document: 'Product Roadmap H1 2027',
    docType: 'Strategy', status: 'completed',
    steps: [
      { label: 'Draft', status: 'done', color: C.muted },
      { label: 'Review', status: 'done', color: C.primary400 },
      { label: 'Approve', status: 'done', color: C.warning },
      { label: 'Sign', status: 'done', color: C.purple },
      { label: 'Archive', status: 'done', color: C.success },
    ],
    currentStep: 'Archived', progress: 100, assignees: ['YT', 'DK', 'SR'],
    createdAt: '1 week ago', sla: 'on-time', slaText: 'Completed', priority: 'normal',
  },
  {
    id: 'wf-005', name: 'IT Security Audit', document: 'Security Audit Report Q3',
    docType: 'IT', status: 'paused',
    steps: [
      { label: 'Draft', status: 'done', color: C.muted },
      { label: 'Review', status: 'active', color: C.primary400 },
      { label: 'Approve', status: 'pending', color: C.warning },
      { label: 'Sign', status: 'pending', color: C.purple },
      { label: 'Archive', status: 'pending', color: C.success },
    ],
    currentStep: 'Paused — awaiting IT', progress: 25, assignees: ['CB'],
    createdAt: '3 days ago', sla: 'breached', slaText: 'Overdue 1d', priority: 'urgent',
  },
  {
    id: 'wf-006', name: 'Marketing Campaign Brief', document: 'Q1 2027 Campaign Brief',
    docType: 'Marketing', status: 'active',
    steps: [
      { label: 'Draft', status: 'done', color: C.muted },
      { label: 'Review', status: 'active', color: C.primary400 },
      { label: 'Approve', status: 'pending', color: C.warning },
      { label: 'Sign', status: 'pending', color: C.purple },
      { label: 'Archive', status: 'pending', color: C.success },
    ],
    currentStep: 'Creative Review', progress: 40, assignees: ['NA', 'PQ', 'RS'],
    createdAt: 'Today', sla: 'on-time', slaText: '5d left', priority: 'low',
  },
];

const tabFilters: { key: 'all' | WFStatus; label: string; color: string }[] = [
  { key: 'all', label: 'All', color: C.primary400 },
  { key: 'active', label: 'Active', color: C.warning },
  { key: 'completed', label: 'Completed', color: C.success },
  { key: 'paused', label: 'Paused', color: C.muted },
  { key: 'archived', label: 'Archived', color: C.disabled },
];

const priorityColor: Record<string, string> = {
  low: C.muted, normal: C.body, high: C.warning, urgent: C.danger,
};

const slaColor: Record<string, string> = {
  'on-time': C.success, warning: C.warning, breached: C.danger,
};

// ── Sub-components ────────────────────────────────────────────────────────────

function Avatar({ initials, size = 28, color = C.primary400 }: { initials: string; size?: number; color?: string }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <span style={{ fontSize: size * 0.34, color, fontWeight: 700 }}>{initials}</span>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string; sub: string; color: string;
}) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 20,
      padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 12,
      flex: 1, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ width: 40, height: 40, background: `color-mix(in srgb, ${color} 12%, transparent)`, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={20} color={color} />
        </div>
        <TrendingUp size={14} color={C.success} />
      </div>
      <div>
        <div style={{ color: C.heading, fontSize: 28, fontWeight: 700, lineHeight: 1 }}>{value}</div>
        <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{label}</div>
        <div style={{ color: C.success, fontSize: 11, marginTop: 2, fontWeight: 600 }}>{sub}</div>
      </div>
    </div>
  );
}

function PipelineMini({ steps }: { steps: WorkflowStep[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, width: '100%' }}>
      {steps.map((step, i) => (
        <div key={step.label} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: step.status === 'pending' ? `color-mix(in srgb, ${step.color} 5%, transparent)` : `color-mix(in srgb, ${step.color} 15%, transparent)`,
              border: `${step.status === 'active' ? 2 : 1}px solid ${step.status === 'pending' ? `color-mix(in srgb, ${step.color} 15%, transparent)` : `color-mix(in srgb, ${step.color} 40%, transparent)`}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              position: 'relative',
            }}>
              {step.status === 'done' && <CheckCircle size={14} color={step.color} />}
              {step.status === 'active' && (
                <>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: step.color, boxShadow: `0 0 6px ${step.color}` }} />
                  <div style={{ position: 'absolute', inset: -4, borderRadius: 12, border: `2px solid color-mix(in srgb, ${step.color} 30%, transparent)`, animation: 'pulse-ring 2s ease infinite' }} />
                </>
              )}
              {step.status === 'pending' && <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.disabled }} />}
            </div>
            <span style={{ fontSize: 9, color: step.status === 'pending' ? C.disabled : step.color, fontWeight: step.status === 'active' ? 700 : 500, whiteSpace: 'nowrap' }}>
              {step.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div style={{ width: 16, height: 1, background: C.borderSubtle, flexShrink: 0, margin: '0 -8px', marginBottom: 12 }} />
          )}
        </div>
      ))}
    </div>
  );
}

function ProgressBar({ value, color = C.primary400 }: { value: number; color?: string }) {
  return (
    <div style={{ background: C.overlay, borderRadius: 99, height: 5, overflow: 'hidden' }}>
      <div style={{ width: `${value}%`, height: '100%', background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 60%, transparent))`, borderRadius: 99, transition: 'width 0.7s ease' }} />
    </div>
  );
}

function WorkflowCard({ wf, onView }: { wf: Workflow; onView: (id: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);

  const statusColors: Record<WFStatus, string> = {
    active: C.primary400, completed: C.success, archived: C.disabled, paused: C.warning,
  };
  const statusBgs: Record<WFStatus, string> = {
    active: `color-mix(in srgb, ${C.primary400} 10%, transparent)`,
    completed: `color-mix(in srgb, ${C.success} 10%, transparent)`,
    archived: `color-mix(in srgb, ${C.disabled} 10%, transparent)`,
    paused: `color-mix(in srgb, ${C.warning} 10%, transparent)`,
  };

  return (
    <div
      className="wf-card"
      style={{
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 20,
        padding: 22, display: 'flex', flexDirection: 'column', gap: 16,
        transition: 'all 0.2s',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: statusBgs[wf.status], color: statusColors[wf.status], border: `1px solid color-mix(in srgb, ${statusColors[wf.status]} 20%, transparent)`, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {wf.status}
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: priorityColor[wf.priority] }}>
              ● {wf.priority}
            </span>
          </div>
          <div style={{ color: C.heading, fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {wf.name}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <FileText size={12} color={C.muted} />
            <span style={{ color: C.muted, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{wf.document}</span>
            <span style={{ fontSize: 11, padding: '1px 6px', background: C.overlay, border: `1px solid ${C.borderSubtle}`, borderRadius: 4, color: C.disabled, flexShrink: 0 }}>{wf.docType}</span>
          </div>
        </div>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            style={{ background: 'transparent', border: 'none', color: C.muted, cursor: 'pointer', padding: 4, borderRadius: 8, display: 'flex' }}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 10 }} onClick={() => setMenuOpen(false)} />
              <div style={{
                position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 20,
                background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)', minWidth: 140, overflow: 'hidden',
              }}>
                {['View Details', 'Edit Workflow', 'Pause', 'Archive'].map(action => (
                  <button key={action} onClick={() => setMenuOpen(false)} style={{ width: '100%', background: 'none', border: 'none', padding: '9px 14px', color: action === 'Archive' ? C.danger : C.body, fontSize: 13, cursor: 'pointer', textAlign: 'left', transition: 'background 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = C.overlay)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                  >
                    {action}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Pipeline */}
      <PipelineMini steps={wf.steps} />

      {/* Progress */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: C.muted, fontSize: 12 }}>Current: <span style={{ color: C.body, fontWeight: 600 }}>{wf.currentStep}</span></span>
          <span style={{ color: wf.progress === 100 ? C.success : C.primary400, fontSize: 12, fontWeight: 700 }}>{wf.progress}%</span>
        </div>
        <ProgressBar value={wf.progress} color={wf.progress === 100 ? C.success : C.primary400} />
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex' }}>
            {wf.assignees.map((a, i) => (
              <div key={a} style={{ marginLeft: i > 0 ? -8 : 0, zIndex: wf.assignees.length - i }}>
                <Avatar initials={a} size={24} color={C.primary400} />
              </div>
            ))}
          </div>
          <span style={{ color: C.disabled, fontSize: 11 }}>{wf.createdAt}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Clock size={11} color={slaColor[wf.sla]} />
            <span style={{ color: slaColor[wf.sla], fontSize: 11, fontWeight: 600 }}>{wf.slaText}</span>
          </div>
          <button
            onClick={() => onView(wf.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px',
              background: `color-mix(in srgb, ${C.primary400} 10%, transparent)`,
              border: `1px solid color-mix(in srgb, ${C.primary400} 20%, transparent)`,
              borderRadius: 8, color: C.primary400, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            View <ChevronRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function WorkflowsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'all' | WFStatus>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filtered = mockWorkflows.filter(wf => {
    const matchesTab = activeTab === 'all' || wf.status === activeTab;
    const matchesSearch = wf.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      wf.document.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const stats = {
    total: mockWorkflows.length,
    active: mockWorkflows.filter(w => w.status === 'active').length,
    completed: mockWorkflows.filter(w => w.status === 'completed').length,
    breached: mockWorkflows.filter(w => w.sla === 'breached').length,
  };

  return (
    <div style={{ position: 'relative', minHeight: '100%', overflow: 'hidden' }}>
      {/* Ambient glows */}
      <div style={{ position: 'absolute', bottom: -180, left: -160, width: 750, height: 750, borderRadius: 9999, background: 'radial-gradient(circle, rgba(37,99,235,0.18) 0%, transparent 68%)', filter: 'blur(240px)', zIndex: 1, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: -160, right: -160, width: 700, height: 700, borderRadius: 9999, background: 'radial-gradient(circle, rgba(124,58,237,0.15) 0%, transparent 65%)', filter: 'blur(220px)', zIndex: 1, pointerEvents: 'none' }} />

      <div style={{ position: 'relative', zIndex: 10, padding: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Page Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: `color-mix(in srgb, ${C.purple} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${C.purple} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <GitBranch size={18} color={C.purple} />
              </div>
              <h1 style={{ fontSize: 26, fontWeight: 800, color: C.heading, margin: 0 }}>Workflows</h1>
            </div>
            <p style={{ color: C.muted, fontSize: 14, margin: 0 }}>Manage and track document approval pipelines across your organization</p>
          </div>
          <button
            onClick={() => navigate('/documents/new')}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
              background: `linear-gradient(135deg, ${C.primary}, var(--color-primary-600))`,
              border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
              boxShadow: '0 0 20px hsla(217, 100%, 50%, 0.3)', transition: 'all 0.2s',
            }}
            className="new-wf-btn"
          >
            <Plus size={16} /> New Workflow
          </button>
        </div>

        {/* Stats Row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
          <StatCard icon={GitBranch} label="Total Workflows" value={stats.total.toString()} sub="+3 this month" color={C.primary400} />
          <StatCard icon={Zap} label="Active" value={stats.active.toString()} sub="Currently in progress" color={C.warning} />
          <StatCard icon={CheckCircle} label="Completed" value={stats.completed.toString()} sub="This month" color={C.success} />
          <StatCard icon={AlertCircle} label="SLA Breached" value={stats.breached.toString()} sub="Needs attention" color={C.danger} />
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Tabs */}
          <div style={{ display: 'flex', background: C.surface, border: `1px solid ${C.borderSubtle}`, borderRadius: 12, padding: 4, gap: 2 }}>
            {tabFilters.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: '6px 14px', borderRadius: 9, border: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600, transition: 'all 0.2s',
                  background: activeTab === tab.key ? C.card : 'transparent',
                  color: activeTab === tab.key ? tab.color : C.muted,
                  boxShadow: activeTab === tab.key ? '0 2px 8px rgba(0,0,0,0.3)' : 'none',
                }}
              >
                {tab.label}
                {tab.key !== 'all' && (
                  <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>
                    {tab.key === 'active' ? stats.active : tab.key === 'completed' ? stats.completed : ''}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Search */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '8px 14px', flex: 1, maxWidth: 320 }}>
            <Search size={14} color={C.muted} />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search workflows..."
              style={{ background: 'none', border: 'none', outline: 'none', color: C.heading, fontSize: 13, flex: 1 }}
            />
          </div>

          <button style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, color: C.body, fontSize: 13, cursor: 'pointer' }}>
            <Filter size={14} /> Filters
          </button>
        </div>

        {/* Workflow Grid */}
        {filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 32px', gap: 16 }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, background: `color-mix(in srgb, ${C.purple} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${C.purple} 20%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <GitBranch size={28} color={C.purple} />
            </div>
            <div style={{ color: C.heading, fontSize: 18, fontWeight: 700 }}>No workflows found</div>
            <div style={{ color: C.muted, fontSize: 14, textAlign: 'center', maxWidth: 320 }}>
              {searchQuery ? 'Try adjusting your search query' : 'Start by creating a new workflow to automate your document approvals'}
            </div>
            <button
              onClick={() => navigate('/documents/new')}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: C.primary, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              <Plus size={16} /> Create Workflow
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
            {filtered.map(wf => (
              <WorkflowCard key={wf.id} wf={wf} onView={(id) => console.log('View', id)} />
            ))}
          </div>
        )}
      </div>

      <style>{`
        .wf-card:hover {
          transform: translateY(-3px);
          border-color: var(--border-strong) !important;
          box-shadow: 0 20px 60px rgba(0,0,0,0.4);
        }
        .new-wf-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 0 32px hsla(217, 100%, 50%, 0.5) !important;
        }
        @keyframes pulse-ring {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 0.2; transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
