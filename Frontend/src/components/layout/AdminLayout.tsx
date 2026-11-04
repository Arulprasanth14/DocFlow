/**
 * DocFlow Frontend — Admin Layout Shell
 *
 * Structurally and visually SEPARATE from AppLayout (the employee shell).
 * Used exclusively for the /admin/* route tree.
 *
 * Design language: deep slate + amber/red accent, Shield branding,
 * "ADMIN PORTAL" header badge — distinct at a glance.
 *
 * Nav structure:
 *   Overview: Dashboard
 *   People:   Members, Roles & Permissions
 *   Config:   Organization, Departments, Document Types, Workflow Templates
 *   System:   Audit Logs
 */

import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '@/store/authStore';
import { useLogout } from '@/hooks/useAuth';
import { LivingBackground } from '@/components/ui/LivingBackground';
import PageTransition from '@/components/layout/PageTransition';

// ── Admin accent tokens — Ice base + a distinct AMBER accent so the admin
//    portal reads as "elevated/privileged" while staying theme-aware (light/dark).
const A = {
  bgBase:       'var(--background)',
  bgSurface:    'var(--sidebar)',
  bgElevated:   'var(--popover)',
  border:       'var(--border)',
  borderStrong: 'var(--border)',
  accent:       'var(--chart-4)',
  accentDim:    'color-mix(in srgb, var(--chart-4) 14%, transparent)',
  red:          'var(--destructive)',
  textPrimary:  'var(--foreground)',
  textSecondary:'var(--muted-foreground)',
  textMuted:    'var(--muted-foreground)',
  textDisabled: 'var(--muted-foreground)',
} as const;

// ── Nav items ─────────────────────────────────────────────────────────────────
interface AdminNavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

const Icons = {
  dashboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  members: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  roles: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  org: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  ),
  depts: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
      <path d="M18 9a9 9 0 0 1-9 9"/>
    </svg>
  ),
  docTypes: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
    </svg>
  ),
  workflows: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><circle cx="5" cy="19" r="3"/>
      <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="12" x2="19" y2="16"/>
      <line x1="12" y1="12" x2="5" y2="16"/>
    </svg>
  ),
  audit: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>
  ),
  shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
};

// ── Sidebar nav item ──────────────────────────────────────────────────────────
function AdminSidebarItem({ item, collapsed }: { item: AdminNavItem; collapsed: boolean }) {
  const [hovered, setHovered] = useState(false);
  return (
    <NavLink
      to={item.to}
      end={item.to.endsWith('/dashboard')}
      title={collapsed ? item.label : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: collapsed ? '10px 18px' : '10px 14px',
        borderRadius: '10px',
        textDecoration: 'none',
        fontSize: '0.875rem',
        fontWeight: isActive ? 600 : 500,
        color: isActive ? A.accent : hovered ? A.textPrimary : A.textSecondary,
        background: isActive ? A.accentDim : hovered ? 'color-mix(in srgb, var(--muted-foreground) 10%, transparent)' : 'transparent',
        border: `1px solid ${isActive ? 'color-mix(in srgb, var(--chart-4) 30%, transparent)' : hovered ? A.border : 'transparent'}`,
        transition: 'all 0.2s ease',
        justifyContent: collapsed ? 'center' : 'flex-start',
        position: 'relative',
        overflow: 'hidden',
      })}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.div
              layoutId="adminActiveSidebarTab"
              style={{
                position: 'absolute', left: 0, top: '20%', bottom: '20%',
                width: '3px',
                background: `linear-gradient(180deg, ${A.red}, ${A.accent})`,
                borderRadius: '0 4px 4px 0',
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            />
          )}
          <motion.span
            animate={{ scale: hovered ? 1.12 : isActive ? 1.05 : 1 }}
            style={{
              flexShrink: 0, display: 'flex',
              color: isActive ? A.accent : hovered ? A.textPrimary : 'currentColor',
            }}
          >
            {item.icon}
          </motion.span>
          {!collapsed && (
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.label}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

// ── User avatar ───────────────────────────────────────────────────────────────
function AdminAvatar({ name, size = 32 }: { name: string | null; size?: number }) {
  const initials = name ? name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase() : 'A';
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'linear-gradient(135deg, var(--destructive), var(--chart-4))',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, color: 'white', flexShrink: 0,
    }}>
      {initials}
    </div>
  );
}

// ── Admin Layout ──────────────────────────────────────────────────────────────
export default function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const user = useAuthStore(s => s.user);
  const orgMembership = useAuthStore(s => s.orgMembership);
  const logout = useLogout();
  const navigate = useNavigate();

  const sidebarW = collapsed ? '64px' : '240px';

  const navOverview: AdminNavItem[] = [
    { to: '/admin/dashboard', label: 'Dashboard', icon: Icons.dashboard },
  ];

  const navPeople: AdminNavItem[] = [
    { to: '/admin/members', label: 'Members', icon: Icons.members },
    { to: '/admin/roles', label: 'Roles & Permissions', icon: Icons.roles },
  ];

  const navConfig: AdminNavItem[] = [
    { to: '/admin/organization', label: 'Organization', icon: Icons.org },
    { to: '/admin/departments', label: 'Departments', icon: Icons.depts },
    { to: '/admin/document-types', label: 'Document Types', icon: Icons.docTypes },
    { to: '/admin/workflow-templates', label: 'Workflow Templates', icon: Icons.workflows },
  ];

  const navSystem: AdminNavItem[] = [
    { to: '/admin/audit-logs', label: 'Audit Logs', icon: Icons.audit },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh', position: 'relative' }}>
      {/* Living background (shared system) — amber accent lives in the chrome, not the aura */}
      <LivingBackground />

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside style={{
        position: 'fixed', top: 0, left: 0, bottom: 0,
        width: sidebarW,
        background: A.bgSurface,
        backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
        WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
        borderRight: `1px solid ${A.border}`,
        display: 'flex', flexDirection: 'column',
        transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        zIndex: 100, overflow: 'hidden',
      }}>
        {/* Logo + collapse toggle */}
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{
            height: '64px', display: 'flex', alignItems: 'center',
            padding: collapsed ? '0 18px' : '0 18px',
            borderBottom: `1px solid ${A.border}`,
            gap: '10px', flexShrink: 0, cursor: 'pointer',
          }}
        >
          {/* Shield icon */}
          <div style={{
            width: '34px', height: '34px', borderRadius: '10px', flexShrink: 0,
            background: 'linear-gradient(135deg, var(--destructive), var(--chart-4))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 10px color-mix(in srgb, var(--destructive) 40%, transparent)',
            color: 'white',
          }}>
            {Icons.shield}
          </div>
          {!collapsed && (
            <div>
              <div style={{
                fontSize: '1rem', fontWeight: 800, letterSpacing: '-0.02em',
                background: `linear-gradient(135deg, ${A.red}, ${A.accent})`,
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                whiteSpace: 'nowrap',
              }}>
                DocFlow Admin
              </div>
            </div>
          )}
        </div>

        {/* Org badge */}
        {!collapsed && orgMembership && (
          <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
            <p style={{ fontSize: '0.68rem', fontWeight: 700, color: A.textDisabled, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '2px' }}>
              Organization
            </p>
            <p style={{ fontSize: '0.8rem', fontWeight: 600, color: A.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {orgMembership.organization?.name ?? 'DocFlow'}
            </p>
          </div>
        )}

        {/* Navigation */}
        <nav style={{ flex: 1, padding: '12px 8px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>

          {navOverview.map(item => <AdminSidebarItem key={item.to} item={item} collapsed={collapsed} />)}

          {/* People section */}
          <div style={{ margin: '14px 10px 6px', borderTop: `1px solid ${A.border}` }} />
          {!collapsed && (
            <div style={{ padding: '0 10px 6px', fontSize: '0.65rem', fontWeight: 700, color: A.textDisabled, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              People
            </div>
          )}
          {navPeople.map(item => <AdminSidebarItem key={item.to} item={item} collapsed={collapsed} />)}

          {/* Config section */}
          <div style={{ margin: '14px 10px 6px', borderTop: `1px solid ${A.border}` }} />
          {!collapsed && (
            <div style={{ padding: '0 10px 6px', fontSize: '0.65rem', fontWeight: 700, color: A.textDisabled, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              Configuration
            </div>
          )}
          {navConfig.map(item => <AdminSidebarItem key={item.to} item={item} collapsed={collapsed} />)}

          {/* System section */}
          <div style={{ margin: '14px 10px 6px', borderTop: `1px solid ${A.border}` }} />
          {!collapsed && (
            <div style={{ padding: '0 10px 6px', fontSize: '0.65rem', fontWeight: 700, color: A.textDisabled, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              System
            </div>
          )}
          {navSystem.map(item => <AdminSidebarItem key={item.to} item={item} collapsed={collapsed} />)}
        </nav>

        {/* User section at bottom */}
        <div style={{ padding: '12px', borderTop: `1px solid ${A.border}`, flexShrink: 0 }}>
          <div
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '8px', borderRadius: '10px', cursor: 'pointer',
              transition: 'background 0.2s',
              justifyContent: collapsed ? 'center' : 'flex-start',
            }}
          >
            <AdminAvatar name={user?.name ?? 'Admin'} size={34} />
            {!collapsed && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: A.textPrimary, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {user?.name ?? 'Admin'}
                </div>
                <div style={{ fontSize: '0.7rem', color: A.accent, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Administrator
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <main style={{
        marginLeft: sidebarW, flex: 1,
        transition: 'margin-left 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex', flexDirection: 'column', minHeight: '100vh',
      }}>
        {/* Top bar */}
        <header style={{
          height: '64px', position: 'sticky', top: 0,
          background: A.bgSurface,
          backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
          WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
          borderBottom: `1px solid ${A.border}`,
          display: 'flex', alignItems: 'center',
          padding: '0 24px', gap: '16px', zIndex: 50,
        }}>
          {/* Admin badge */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '4px 12px',
            background: 'color-mix(in srgb, var(--destructive) 12%, transparent)',
            border: `1px solid ${A.borderStrong}`,
            borderRadius: '20px',
          }}>
            <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: A.red, boxShadow: `0 0 6px ${A.red}` }} />
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: A.accent, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Admin Portal
            </span>
          </div>

          <div style={{ flex: 1 }} />

          {/* Switch to Employee view link */}
          <button
            onClick={() => navigate('/dashboard')}
            style={{
              background: 'none', border: `1px solid ${A.border}`,
              borderRadius: '8px', padding: '6px 14px',
              color: A.textSecondary, fontSize: '0.8rem', cursor: 'pointer',
              fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px',
              transition: 'all 0.2s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = A.borderStrong; e.currentTarget.style.color = A.textPrimary; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = A.border; e.currentTarget.style.color = A.textSecondary; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
            Employee View
          </button>

          {/* User menu */}
          <div style={{ position: 'relative' }}>
            <button
              id="admin-btn-user-menu"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              style={{
                background: 'none', border: `1px solid ${A.border}`,
                borderRadius: '20px', padding: '4px 10px 4px 4px',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
                transition: 'all 0.2s',
              }}
            >
              <AdminAvatar name={user?.name ?? 'Admin'} size={28} />
              <span style={{ fontSize: '0.875rem', fontWeight: 600, color: A.textPrimary, maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user?.name ?? 'Admin'}
              </span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: A.textMuted }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            <AnimatePresence>
              {userMenuOpen && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setUserMenuOpen(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.97 }}
                    transition={{ duration: 0.15 }}
                    style={{
                      position: 'absolute', right: 0, top: 'calc(100% + 8px)',
                      minWidth: '200px', zIndex: 50,
                      background: A.bgElevated,
                      border: `1px solid ${A.border}`,
                      borderRadius: '12px',
                      boxShadow: 'var(--shadow-lg)',
                      overflow: 'hidden',
                    }}
                  >
                    <div style={{ padding: '12px 16px', borderBottom: `1px solid ${A.border}` }}>
                      <p style={{ fontSize: '0.875rem', fontWeight: 600, color: A.textPrimary }}>{user?.name}</p>
                      <p style={{ fontSize: '0.78rem', color: A.textMuted }}>{user?.email}</p>
                    </div>
                    <div style={{ padding: '6px' }}>
                      <button
                        id="admin-menu-logout"
                        onClick={() => { setUserMenuOpen(false); logout.mutate(); }}
                        style={{
                          width: '100%', textAlign: 'left',
                          background: 'none', border: 'none', cursor: 'pointer',
                          padding: '8px 12px', borderRadius: '8px',
                          display: 'flex', alignItems: 'center', gap: '10px',
                          fontSize: '0.875rem', color: A.red, fontWeight: 500,
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.background = 'color-mix(in srgb, var(--destructive) 10%, transparent)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'none'}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                          <polyline points="16 17 21 12 16 7"/>
                          <line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                        Sign Out
                      </button>
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </header>

        {/* Page content — only this transitions on navigation */}
        <div style={{ flex: 1, padding: '24px', color: A.textPrimary }}>
          <PageTransition>
            <Outlet />
          </PageTransition>
        </div>
      </main>
    </div>
  );
}
