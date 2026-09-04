/**
 * DocFlow Frontend — App Layout Shell
 * Sidebar + top header + content area.
 * Navigation scaffold for Milestones 3–8 content.
 */

import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '@/store/authStore';
import { useLogout } from '@/hooks/useAuth';

// ── Nav item type ──────────────────────────────────────────────────────────────
interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  comingSoon?: boolean;
}

// ── Icons ──────────────────────────────────────────────────────────────────────
const navIcons = {
  dashboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  documents: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  ),
  approvals: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 11 12 14 22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  ),
  workflows: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="5" r="3"/><circle cx="19" cy="19" r="3"/><circle cx="5" cy="19" r="3"/>
      <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="12" x2="19" y2="16"/>
      <line x1="12" y1="12" x2="5" y2="16"/>
    </svg>
  ),
  search: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  analytics: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93l-1.41 1.41M5.34 18.66l-1.41 1.41M19.07 19.07l-1.41-1.41M5.34 5.34L3.93 3.93"/>
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>
    </svg>
  ),
  org: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2"/>
      <line x1="9" y1="22" x2="9" y2="22"/>
      <line x1="15" y1="22" x2="15" y2="22"/>
      <line x1="8" y1="6" x2="8.01" y2="6"/>
      <line x1="16" y1="6" x2="16.01" y2="6"/>
      <line x1="8" y1="10" x2="8.01" y2="10"/>
      <line x1="16" y1="10" x2="16.01" y2="10"/>
      <line x1="8" y1="14" x2="8.01" y2="14"/>
      <line x1="16" y1="14" x2="16.01" y2="14"/>
    </svg>
  ),
  depts: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="6" y1="3" x2="6" y2="15"/>
      <circle cx="18" cy="6" r="3"/>
      <circle cx="6" cy="18" r="3"/>
      <path d="M18 9a9 9 0 0 1-9 9"/>
    </svg>
  ),
  roles: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
  members: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  docTypes: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  ),
};

// ── User Avatar ────────────────────────────────────────────────────────────────
function UserAvatar({ name, avatarUrl, size = 32 }: { name: string | null; avatarUrl: string | null; size?: number }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name ?? ''} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }} />;
  }
  const initials = name ? name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?';
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, color: 'white', flexShrink: 0,
    }}>
      {initials}
    </div>
  );
}

// ── NavItem component ──────────────────────────────────────────────────────────
function SidebarItem({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <NavLink
      to={item.to}
      title={collapsed ? item.label : undefined}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: collapsed ? '10px 18px' : '10px 14px',
        borderRadius: '12px',
        textDecoration: 'none',
        fontSize: '0.875rem',
        fontWeight: isActive ? 600 : 500,
        color: isActive ? 'var(--color-primary-400)' : isHovered ? 'var(--text-primary)' : 'var(--text-secondary)',
        background: isActive ? 'hsla(217, 100%, 50%, 0.12)' : isHovered ? 'var(--bg-elevated)' : 'transparent',
        border: `1px solid ${isActive ? 'hsla(217, 100%, 50%, 0.25)' : isHovered ? 'var(--border-subtle)' : 'transparent'}`,
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        position: 'relative',
        justifyContent: collapsed ? 'center' : 'flex-start',
        overflow: 'hidden',
      })}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.div
              layoutId="activeSidebarTab"
              style={{
                position: 'absolute',
                left: 0,
                top: '20%',
                bottom: '20%',
                width: '3px',
                background: 'var(--color-primary-500)',
                borderRadius: '0 4px 4px 0',
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            />
          )}
          
          <motion.span
            animate={{ 
              scale: isHovered ? 1.15 : (isActive ? 1.08 : 1), 
              rotate: isHovered ? -4 : 0 
            }}
            whileTap={{ scale: 0.92 }}
            style={{ 
              flexShrink: 0, 
              display: 'flex', 
              color: isActive ? 'var(--color-primary-400)' : isHovered ? 'var(--text-primary)' : 'currentColor',
              transition: 'color 0.25s',
            }}
          >
            {item.icon}
          </motion.span>
          
          {!collapsed && (
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.label}
            </span>
          )}
          
          {!collapsed && item.badge !== undefined && item.badge > 0 && (
            <motion.span 
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              style={{
                minWidth: '18px', height: '18px', borderRadius: '9px',
                background: 'var(--color-primary-500)', color: 'white',
                fontSize: '0.7rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 4px',
                boxShadow: '0 0 10px hsla(217, 100%, 50%, 0.4)'
              }}
            >
              {item.badge}
            </motion.span>
          )}
          
          {!collapsed && item.comingSoon && (
            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-disabled)', background: 'var(--bg-overlay)', padding: '2px 6px', borderRadius: 'var(--radius-full)' }}>
              Soon
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

// ── App Layout ─────────────────────────────────────────────────────────────────
export default function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const orgMembership = useAuthStore((s) => s.orgMembership);
  const logout = useLogout();
  const navigate = useNavigate();

  const navItemsMain: NavItem[] = [
    { to: '/dashboard', label: 'Dashboard', icon: navIcons.dashboard },
    { to: '/documents', label: 'Documents', icon: navIcons.documents },
    { to: '/approvals', label: 'Approvals', icon: navIcons.approvals },
    { to: '/workflows', label: 'Workflows', icon: navIcons.workflows, comingSoon: true },
    { to: '/search', label: 'Search', icon: navIcons.search, comingSoon: true },
    { to: '/reports', label: 'Analytics', icon: navIcons.analytics, comingSoon: true },
  ];

  const navItemsAdmin: NavItem[] = [
    { to: '/admin/organization', label: 'Organization', icon: navIcons.org },
    { to: '/admin/departments', label: 'Departments', icon: navIcons.depts },
    { to: '/admin/roles', label: 'Roles & Perms', icon: navIcons.roles },
    { to: '/admin/members', label: 'Members', icon: navIcons.members },
    { to: '/admin/doc-types', label: 'Doc Types', icon: navIcons.docTypes },
    { to: '/settings', label: 'Settings', icon: navIcons.settings },
  ];

  const sidebarW = sidebarCollapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-width)';

  return (
    <div className="app-layout">
      {/* Mobile Overlay */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{
              position: 'fixed', inset: 0,
              background: 'hsla(220, 50%, 5%, 0.7)',
              backdropFilter: 'blur(4px)',
              zIndex: 90,
            }}
            onClick={() => setMobileMenuOpen(false)}
            className="mobile-overlay"
          />
        )}
      </AnimatePresence>

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside 
        className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${mobileMenuOpen ? 'mobile-open' : ''}`}
        style={{
          position: 'fixed',
          top: 0, left: 0, bottom: 0,
          width: sidebarW,
          background: 'var(--bg-surface)',
          borderRight: '1px solid var(--border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          transition: 'transform var(--transition-base), width var(--transition-base)',
          zIndex: 100,
          overflow: 'hidden',
        }}>
        {/* Logo */}
        <div style={{
          height: 'var(--header-height)',
          display: 'flex',
          alignItems: 'center',
          padding: sidebarCollapsed ? '0 18px' : '0 20px',
          borderBottom: '1px solid var(--border-subtle)',
          gap: '10px',
          flexShrink: 0,
        }}>
          <div style={{
            width: '32px', height: '32px', borderRadius: '8px',
            background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </div>
          {!sidebarCollapsed && (
            <span style={{ color: 'white', fontSize: '1.125rem', fontWeight: 800, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
              DocFlow
            </span>
          )}
        </div>

        {/* Org name */}
        {!sidebarCollapsed && orgMembership && (
          <div style={{ padding: '12px 16px 0', flexShrink: 0 }}>
            <p style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-disabled)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>
              Workspace
            </p>
            <p style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {orgMembership.organization.name}
            </p>
          </div>
        )}

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '12px 8px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {navItemsMain.map((item) => (
            <div key={item.to} onClick={() => setMobileMenuOpen(false)}>
              <SidebarItem item={item} collapsed={sidebarCollapsed} />
            </div>
          ))}

          <div style={{ margin: '16px 12px 8px', borderTop: '1px solid var(--border-subtle)' }} />
          
          {!sidebarCollapsed && (
            <div style={{ padding: '4px 12px 8px', fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-disabled)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              ADMINISTRATION
            </div>
          )}
          {navItemsAdmin.map((item) => (
            <div key={item.to} onClick={() => setMobileMenuOpen(false)}>
              <SidebarItem item={item} collapsed={sidebarCollapsed} />
            </div>
          ))}
        </nav>

        {/* User Profile Sidebar Bottom */}
        <div style={{ padding: '12px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '12px',
            padding: '8px', borderRadius: 'var(--radius-md)',
            cursor: 'pointer', transition: 'background var(--transition-fast)',
            background: 'transparent'
          }} onClick={() => setUserMenuOpen(!userMenuOpen)}>
            <UserAvatar name={user?.name ?? 'Alex Johnson'} avatarUrl={user?.avatar_url ?? null} size={36} />
            {!sidebarCollapsed && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{user?.name ?? 'Alex Johnson'}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>Senior Manager</div>
              </div>
            )}
            {!sidebarCollapsed && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main Content ─────────────────────────────────────────────────── */}
      <main
        className={`main-content ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        style={{ marginLeft: sidebarW, transition: 'margin-left var(--transition-base)' }}
      >
        {/* Top Header */}
        <header style={{
          height: 'var(--header-height)',
          position: 'sticky',
          top: 0,
          background: 'hsla(222, 40%, 9%, 0.9)',
          backdropFilter: 'blur(16px)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          gap: '16px',
          zIndex: 50,
        }}>
          {/* Hamburger (Mobile) */}
          <button
            className="mobile-menu-btn"
            onClick={() => setMobileMenuOpen(true)}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', padding: '8px', marginLeft: '-12px' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>

          {/* Search bar placeholder */}
          <div style={{
            flex: 1,
            maxWidth: '480px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            padding: '8px 14px',
            cursor: 'pointer',
          }}
            onClick={() => navigate('/search')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <span style={{ color: 'var(--text-disabled)', fontSize: '0.875rem' }}>Search...</span>
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-disabled)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border-subtle)', background: 'var(--bg-overlay)' }}>⌘K</span>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {/* Notification bell */}
            <div style={{ position: 'relative' }}>
              <button
                id="btn-notifications"
                className="btn btn-ghost btn-icon"
                style={{ position: 'relative', color: 'var(--text-secondary)' }}
                onClick={() => setNotifOpen(!notifOpen)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                {/* Unread Badge */}
                <span style={{
                  position: 'absolute', top: 4, right: 6, width: 8, height: 8,
                  background: 'var(--color-primary-500)', borderRadius: '50%',
                  border: '2px solid var(--bg-surface)'
                }} />
              </button>

              {/* Notification Dropdown Placeholder */}
              <AnimatePresence>
                {notifOpen && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setNotifOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                      style={{
                        position: 'absolute', right: 0, top: 'calc(100% + 8px)',
                        minWidth: '280px', zIndex: 50,
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-default)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: 'var(--shadow-lg)',
                        padding: '16px',
                      }}
                    >
                      <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '12px' }}>Notifications</h4>
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>No new notifications.</p>
                    </motion.div>
                  </>
                )}
              </AnimatePresence>
            </div>

            {/* User menu */}
            <div style={{ position: 'relative' }}>
              <button
                id="btn-user-menu"
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                style={{
                  background: 'none', border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-full)', padding: '3px',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
                  paddingRight: '10px', transition: 'all var(--transition-fast)',
                }}
              >
                <UserAvatar name={user?.name ?? 'Alex Johnson'} avatarUrl={user?.avatar_url ?? null} size={30} />
                <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user?.name ?? 'Alex Johnson'}
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>

              {/* Dropdown menu */}
              <AnimatePresence>
                {userMenuOpen && (
                  <>
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 49 }}
                      onClick={() => setUserMenuOpen(false)}
                    />
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                      style={{
                        position: 'absolute', right: 0, top: 'calc(100% + 8px)',
                        minWidth: '200px', zIndex: 50,
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-default)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: 'var(--shadow-lg)',
                        overflow: 'hidden',
                      }}
                    >
                      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                        <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>{user?.name}</p>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{user?.email}</p>
                      </div>
                      <div style={{ padding: '6px' }}>
                        <button
                          id="menu-profile"
                          onClick={() => { setUserMenuOpen(false); navigate('/profile'); }}
                          className="btn btn-ghost"
                          style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.875rem', gap: '10px' }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                          </svg>
                          Profile & Settings
                        </button>
                        <button
                          id="menu-logout"
                          onClick={() => { setUserMenuOpen(false); logout.mutate(); }}
                          className="btn btn-ghost"
                          style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.875rem', color: 'var(--color-error-400)', gap: '10px' }}
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
          </div>
        </header>

        {/* Page content */}
        <Outlet />
      </main>
    </div>
  );
}
