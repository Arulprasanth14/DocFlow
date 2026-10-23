/**
 * DocFlow Frontend — Admin Dashboard Page
 *
 * Route: /admin/dashboard
 * The landing page for the Admin portal.
 *
 * Shows:
 *   - Org stats summary (members, active documents, roles)
 *   - Quick links to the main admin sections
 *   - Role permission summary cards (from the roles catalog)
 * 
 * Uses existing hooks and API clients — no new API calls created here.
 */

import { useAuthStore } from '@/store/authStore';

// ── Accent palette (matches AdminLayout) ─────────────────────────────────────
const A = {
  accent:       'hsl(28, 80%, 54%)',
  accentDim:    'hsla(28, 80%, 54%, 0.1)',
  accentBorder: 'hsla(28, 80%, 54%, 0.25)',
  red:          'hsl(10, 75%, 55%)',
  redDim:       'hsla(10, 75%, 55%, 0.1)',
  redBorder:    'hsla(10, 75%, 55%, 0.25)',
  blue:         'hsl(217, 90%, 60%)',
  blueDim:      'hsla(217, 90%, 60%, 0.1)',
  blueBorder:   'hsla(217, 90%, 60%, 0.2)',
  green:        'hsl(145, 65%, 50%)',
  greenDim:     'hsla(145, 65%, 50%, 0.1)',
  greenBorder:  'hsla(145, 65%, 50%, 0.2)',
  bgCard:       'hsla(222, 24%, 12%, 0.8)',
  border:       'hsla(15, 60%, 40%, 0.18)',
  textPrimary:  'hsl(215, 20%, 92%)',
  textSecondary:'hsl(215, 15%, 62%)',
  textMuted:    'hsl(215, 12%, 42%)',
} as const;

// ── Role summary data (static — matches SYSTEM_ROLES) ────────────────────────
const ROLE_SUMMARY = [
  {
    name: 'Main Admin',
    key: 'admin',
    color: A.red, dimColor: A.redDim, borderColor: A.redBorder,
    description: 'Full organization-wide authority — manage members, roles, workflows, templates, and the Agent knowledge base. The only role that can add an HR user or delete a member.',
    capabilities: ['Manage Members & Org Settings', 'Add HR / Worker / Trainee', 'Manage Roles & Permissions', 'Configure Workflow Templates', 'Manage Agent Legal Knowledge', 'View Audit Log', 'View Analytics', 'Approve & Sign Documents'],
  },
  {
    name: 'HR',
    key: 'hr',
    color: A.blue, dimColor: A.blueDim, borderColor: A.blueBorder,
    description: 'Supports the Main Administrator with day-to-day organization management — can add Workers and Trainees, manage departments and templates.',
    capabilities: ['Add Worker / Trainee', 'Manage Departments', 'Manage Templates', 'View Audit Log', 'View Analytics', 'Approve & Sign Documents'],
    restricted: ['Cannot Add HR', 'Cannot Delete a Member', 'Cannot Manage Roles & Permissions', 'Cannot Manage Agent Legal Knowledge'],
  },
  {
    name: 'Worker',
    key: 'worker',
    color: A.blue, dimColor: A.blueDim, borderColor: A.blueBorder,
    description: 'Document creator and approver — create, submit, and track own documents, and approve/sign documents assigned to them.',
    capabilities: ['Create & Submit Documents', 'Comment & Track', 'Approve & Sign Assigned Documents', 'View Analytics'],
  },
  {
    name: 'Trainee',
    key: 'trainee',
    color: A.green, dimColor: A.greenDim, borderColor: A.greenBorder,
    description: 'Document creator and workflow participant only — never an approver or signer.',
    capabilities: ['Create Documents', 'Submit Documents', 'Comment & Track Own Documents'],
    restricted: ['Cannot Approve/Reject', 'Cannot Sign', 'Not selectable as an approver'],
  },
];

// ── Quick action cards ────────────────────────────────────────────────────────
// `mainAdminOnly` entries are hidden for HR — Roles & Perms management is
// reserved for the Main Administrator per requirements §13.4.
const QUICK_ACTIONS = [
  { label: 'Manage Members', description: 'Add, remove, or update user roles', href: '/admin/members', emoji: '👥' },
  { label: 'Roles & Permissions', description: 'Configure what each role can do', href: '/admin/roles', emoji: '🛡️', mainAdminOnly: true },
  { label: 'Organization Settings', description: 'Update org name, logo, and plan', href: '/admin/organization', emoji: '🏢' },
  { label: 'Departments', description: 'Create and manage departments', href: '/admin/departments', emoji: '🗂️' },
  { label: 'Document Types', description: 'Define custom document templates', href: '/admin/document-types', emoji: '📋' },
  { label: 'Workflow Templates', description: 'Configure approval workflow templates', href: '/admin/workflow-templates', emoji: '🔀' },
];

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({
  label, value, subtext, color, dimColor, borderColor, icon,
}: {
  label: string; value: string; subtext?: string;
  color: string; dimColor: string; borderColor: string;
  icon: React.ReactNode;
}) {
  return (
    <div style={{
      background: A.bgCard, border: `1px solid ${borderColor}`,
      borderRadius: '16px', padding: '24px',
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
        <div style={{
          width: '44px', height: '44px', borderRadius: '12px',
          background: dimColor, border: `1px solid ${borderColor}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color,
        }}>
          {icon}
        </div>
      </div>
      <div style={{ fontSize: '2rem', fontWeight: 800, color: A.textPrimary, lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: '0.875rem', fontWeight: 600, color: A.textSecondary, marginTop: '6px' }}>
        {label}
      </div>
      {subtext && (
        <div style={{ fontSize: '0.78rem', color: A.textMuted, marginTop: '4px' }}>
          {subtext}
        </div>
      )}
    </div>
  );
}

// ── Role card ─────────────────────────────────────────────────────────────────
function RoleCard({ role }: { role: typeof ROLE_SUMMARY[0] }) {
  return (
    <div style={{
      background: A.bgCard, border: `1px solid ${role.borderColor}`,
      borderRadius: '16px', padding: '20px',
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <div style={{
          width: '10px', height: '10px', borderRadius: '50%',
          background: role.color, boxShadow: `0 0 8px ${role.color}`,
        }} />
        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: role.color }}>
          {role.name}
        </span>
      </div>
      <p style={{ fontSize: '0.825rem', color: A.textSecondary, marginBottom: '14px', lineHeight: 1.5 }}>
        {role.description}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {role.capabilities.map(cap => (
          <div key={cap} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '0.8rem', color: A.textSecondary }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={role.color} strokeWidth="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            {cap}
          </div>
        ))}
        {role.restricted?.map(cap => (
          <div key={cap} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '0.8rem', color: A.textMuted }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={A.textMuted} strokeWidth="3">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            {cap}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AdminDashboardPage() {
  const user = useAuthStore(s => s.user);
  const orgMembership = useAuthStore(s => s.orgMembership);
  const hasRole = useAuthStore(s => s.hasRole);
  const isMainAdmin = user?.is_superadmin || hasRole('admin');
  const orgName = orgMembership?.organization?.name ?? 'Your Organization';
  const visibleActions = QUICK_ACTIONS.filter(a => !a.mainAdminOnly || isMainAdmin);

  const now = new Date();
  const timeGreeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div>
      {/* Page header */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <span style={{
            fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em',
            color: A.accent, padding: '3px 10px',
            border: `1px solid ${A.accentBorder}`,
            borderRadius: '20px', background: A.accentDim,
            textTransform: 'uppercase',
          }}>
            Admin Dashboard
          </span>
        </div>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: A.textPrimary, marginBottom: '4px' }}>
          {timeGreeting}, {user?.name?.split(' ')[0] ?? 'Admin'} 👋
        </h1>
        <p style={{ fontSize: '0.9rem', color: A.textSecondary }}>
          Managing <strong style={{ color: A.textPrimary }}>{orgName}</strong> · {isMainAdmin ? 'Full administrative access' : 'HR administrative access'}
        </p>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '32px' }}>
        <StatCard
          label="Total Members" value="—"
          subtext="Across all departments"
          color={A.blue} dimColor={A.blueDim} borderColor={A.blueBorder}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          }
        />
        <StatCard
          label="System Roles" value={`${ROLE_SUMMARY.length}`}
          subtext="Main Admin, HR, Worker, Trainee"
          color={A.red} dimColor={A.redDim} borderColor={A.redBorder}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          }
        />
        <StatCard
          label="Organization Plan" value={orgMembership?.organization ? 'Active' : '—'}
          subtext="Enterprise Document Platform"
          color={A.green} dimColor={A.greenDim} borderColor={A.greenBorder}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          }
        />
        <StatCard
          label="RBAC Status" value="Active"
          subtext="4-tier permission model"
          color={A.accent} dimColor={A.accentDim} borderColor={A.accentBorder}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          }
        />
      </div>

      {/* Quick actions */}
      <div style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: A.textPrimary, marginBottom: '16px' }}>
          Quick Actions
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' }}>
          {visibleActions.map(action => (
            <a
              key={action.href}
              href={action.href}
              style={{
                textDecoration: 'none',
                background: A.bgCard,
                border: `1px solid ${A.border}`,
                borderRadius: '14px',
                padding: '16px',
                display: 'flex', flexDirection: 'column', gap: '6px',
                transition: 'all 0.2s',
                cursor: 'pointer',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.borderColor = A.accentBorder;
                (e.currentTarget as HTMLElement).style.background = 'hsla(28,80%,54%,0.06)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.borderColor = A.border;
                (e.currentTarget as HTMLElement).style.background = A.bgCard;
              }}
            >
              <span style={{ fontSize: '1.25rem' }}>{action.emoji}</span>
              <div style={{ fontSize: '0.875rem', fontWeight: 700, color: A.textPrimary }}>{action.label}</div>
              <div style={{ fontSize: '0.78rem', color: A.textSecondary }}>{action.description}</div>
            </a>
          ))}
        </div>
      </div>

      {/* Role permission summary */}
      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: A.textPrimary, marginBottom: '6px' }}>
          Role Permission Model
        </h2>
        <p style={{ fontSize: '0.85rem', color: A.textSecondary, marginBottom: '16px' }}>
          DocFlow uses a 3-tier role model. All roles are enforced at both the backend API and the frontend UI layers.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
          {ROLE_SUMMARY.map(role => <RoleCard key={role.key} role={role} />)}
        </div>
      </div>
    </div>
  );
}
