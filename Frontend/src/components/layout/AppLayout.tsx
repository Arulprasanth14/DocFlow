/**
 * DocFlow — App shell v2 ("Ice Pearl / Midnight Aurora").
 * Persistent layer (never re-animates on navigation): LivingBackground + glass sidebar + glass topbar.
 * Only the routed content transitions (PageTransition wraps the Outlet).
 * All data / role-gating / notification / logout wiring is unchanged from v1.
 */

import { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, FileText, CheckSquare, Workflow, Search, BarChart3,
  MessageSquare, FilePen, Bot, Settings, Building2, Network, ShieldCheck,
  Users, FileType, BookOpen, Bell, ChevronDown, ChevronsUpDown, Menu,
  Moon, Sun, LogOut, User,
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useLogout } from '@/hooks/useAuth';
import { useNotifications, useUnreadCount, useMarkAllRead } from '@/hooks/useNotifications';
import { useNotificationWebSocket } from '@/hooks/useNotificationWebSocket';
import { useMyApprovalQueue } from '@/hooks/useApprovals';
import { useUIStore } from '@/store/uiStore';
import { useQuery } from '@tanstack/react-query';
import chatApi from '@/lib/api/chat';
import { Toaster } from '@/components/ui/Toaster';
import { LivingBackground } from '@/components/ui/LivingBackground';
import { CommandPalette } from '@/components/ui/CommandPalette';
import PageTransition from '@/components/layout/PageTransition';
import { fmTransition } from '@/lib/motion/tokens';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

const ICON_SIZE = 18;
const COLLAPSE_KEY = 'docflow.sidebarCollapsed';

// ── User Avatar ────────────────────────────────────────────────────────────────
function UserAvatar({ name, avatarUrl, size = 32 }: { name: string | null; avatarUrl: string | null; size?: number }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name ?? ''} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }} />;
  }
  const initials = name ? name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?';
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'var(--gradient-brand)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, color: '#fff', flexShrink: 0,
      fontFamily: 'var(--font-heading)',
    }}>
      {initials}
    </div>
  );
}

// ── Nav item ─────────────────────────────────────────────────────────────────────
function SidebarItem({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate: () => void }) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <NavLink
      to={item.to}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={({ isActive }) => ({
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: collapsed ? '10px' : '10px 12px',
        borderRadius: 'var(--radius-md)',
        textDecoration: 'none',
        fontFamily: 'var(--font-heading)',
        fontSize: '0.875rem',
        fontWeight: isActive ? 600 : 500,
        color: isActive
          ? 'var(--sidebar-accent-foreground)'
          : isHovered ? 'var(--sidebar-foreground)' : 'var(--muted-foreground)',
        background: !isActive && isHovered
          ? 'color-mix(in srgb, var(--muted-foreground) 10%, transparent)'
          : 'transparent',
        transition: 'color 0.2s, background 0.2s',
        justifyContent: collapsed ? 'center' : 'flex-start',
        overflow: 'hidden',
      })}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.div
              layoutId="activeNavPill"
              style={{
                position: 'absolute',
                inset: 0,
                background: 'var(--sidebar-accent)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'inset 0 1px 0 color-mix(in srgb, #fff 30%, transparent)',
              }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            >
              {/* left glow indicator */}
              <span style={{ position: 'absolute', left: 0, top: '22%', bottom: '22%', width: 3, borderRadius: 3, background: 'var(--primary)', boxShadow: '0 0 8px var(--primary)' }} />
            </motion.div>
          )}

          <motion.span
            animate={{ scale: isHovered ? 1.12 : 1, rotate: isHovered ? -4 : 0 }}
            whileTap={{ scale: 0.92 }}
            style={{ position: 'relative', zIndex: 1, flexShrink: 0, display: 'flex', color: 'inherit' }}
          >
            {item.icon}
          </motion.span>

          {!collapsed && (
            <span style={{ position: 'relative', zIndex: 1, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {item.label}
            </span>
          )}

          {!collapsed && item.badge !== undefined && item.badge > 0 && (
            <span className="tabular" style={{
              position: 'relative', zIndex: 1,
              minWidth: '18px', height: '18px', borderRadius: '9px',
              background: 'var(--destructive)', color: 'var(--destructive-foreground)',
              fontSize: '0.7rem', fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 5px',
            }}>
              {item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

// ── App Layout ─────────────────────────────────────────────────────────────────
export default function AppLayout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const user = useAuthStore((s) => s.user);
  const orgMembership = useAuthStore((s) => s.orgMembership);
  const hasRole = useAuthStore((s) => s.hasRole);
  const isAdmin = hasRole('admin');
  const isHr = hasRole('hr');
  const canApprove = hasRole('admin', 'hr', 'worker');
  const canSeeAdminNav = isAdmin || isHr;
  const logout = useLogout();
  const navigate = useNavigate();
  const { theme, toggleTheme } = useUIStore();
  const isLight = theme === 'light';

  const { data: unreadCountData } = useUnreadCount();
  const unreadCount = unreadCountData?.count || 0;
  const { data: notificationsData } = useNotifications({ limit: 5 });
  const markAllReadM = useMarkAllRead();
  const notifications = notificationsData?.items || [];

  const isAuthenticated = useAuthStore((s) => !!s.user);
  useNotificationWebSocket(isAuthenticated);

  // Approvals count badge — real data, same endpoint the Approvals page uses (read-only).
  const { data: approvalQueue } = useMyApprovalQueue();
  const approvalsCount = canApprove ? (approvalQueue?.total ?? approvalQueue?.items?.length ?? 0) : 0;

  const { data: chatConvs } = useQuery({
    queryKey: ['chat', 'conversations', 'unread-total'],
    queryFn: () => chatApi.listConversations({ limit: 100 }),
    refetchInterval: 30_000,
    staleTime: 1000 * 10,
    select: (data) => data.items.reduce((sum, c) => sum + (c.unread_count ?? 0), 0),
  });
  const chatUnreadTotal = chatConvs ?? 0;

  // Persist collapse state.
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, sidebarCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [sidebarCollapsed]);

  // ⌘K / Ctrl+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navItemsMain: NavItem[] = [
    { to: '/dashboard', label: 'Dashboard', icon: <LayoutDashboard size={ICON_SIZE} /> },
    { to: '/documents', label: 'Documents', icon: <FileText size={ICON_SIZE} /> },
    ...(canApprove ? [{ to: '/approvals', label: 'Approvals', icon: <CheckSquare size={ICON_SIZE} />, badge: approvalsCount || undefined }] : []),
    { to: '/workflows', label: 'Workflows', icon: <Workflow size={ICON_SIZE} /> },
    { to: '/search', label: 'Search', icon: <Search size={ICON_SIZE} /> },
    { to: '/analytics', label: 'Analytics', icon: <BarChart3 size={ICON_SIZE} /> },
    { to: '/chat', label: 'Messages', icon: <MessageSquare size={ICON_SIZE} />, badge: chatUnreadTotal || undefined },
    { to: '/drafts', label: 'Drafts', icon: <FilePen size={ICON_SIZE} /> },
    { to: '/agent', label: 'Agent', icon: <Bot size={ICON_SIZE} /> },
    { to: '/settings', label: 'Settings', icon: <Settings size={ICON_SIZE} /> },
  ];

  const navItemsAdmin: NavItem[] = canSeeAdminNav ? [
    { to: '/admin/organization', label: 'Organization', icon: <Building2 size={ICON_SIZE} /> },
    { to: '/admin/departments', label: 'Departments', icon: <Network size={ICON_SIZE} /> },
    ...(isAdmin ? [{ to: '/admin/roles', label: 'Roles & Perms', icon: <ShieldCheck size={ICON_SIZE} /> }] : []),
    { to: '/admin/members', label: 'Members', icon: <Users size={ICON_SIZE} /> },
    { to: '/admin/document-types', label: 'Doc Types', icon: <FileType size={ICON_SIZE} /> },
    { to: '/admin/workflow-templates', label: 'Workflow Templates', icon: <Workflow size={ICON_SIZE} /> },
    ...(isAdmin ? [{ to: '/admin/agent-knowledge', label: 'Agent Knowledge', icon: <BookOpen size={ICON_SIZE} /> }] : []),
  ] : [];

  const sidebarW = sidebarCollapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-width)';
  const closeMobile = () => setMobileMenuOpen(false);
  const sectionLabel = (text: string) => (
    <div className="label-caps" style={{ padding: '4px 12px 8px' }}>{text}</div>
  );

  return (
    <div className="app-layout">
      {/* Persistent living background — one layer, never remounts on navigation */}
      <LivingBackground />

      {/* Command palette (⌘K) */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} showAdmin={canSeeAdminNav} />

      {/* Mobile Overlay */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', backdropFilter: 'blur(4px)', zIndex: 90 }}
            onClick={closeMobile}
            className="mobile-overlay"
          />
        )}
      </AnimatePresence>

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside
        className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${mobileMenuOpen ? 'mobile-open' : ''}`}
        style={{
          position: 'fixed', top: 0, left: 0, bottom: 0, width: sidebarW,
          background: 'var(--sidebar)',
          backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
          WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
          borderRight: '1px solid var(--sidebar-border)',
          display: 'flex', flexDirection: 'column',
          transition: 'transform var(--transition-base), width var(--transition-base)',
          zIndex: 100, overflow: 'hidden',
        }}>
        {/* Logo (click = collapse) */}
        <div
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            height: 'var(--header-height)', display: 'flex', alignItems: 'center',
            padding: sidebarCollapsed ? '0 18px' : '0 20px',
            borderBottom: '1px solid var(--sidebar-border)', gap: '10px', flexShrink: 0, cursor: 'pointer',
          }}>
          <div style={{
            width: '34px', height: '34px', borderRadius: '10px',
            background: 'var(--gradient-brand)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#fff',
            boxShadow: 'var(--shadow-glow)',
          }}>
            <FileText size={18} strokeWidth={2.5} />
          </div>
          {!sidebarCollapsed && (
            <span style={{ color: 'var(--sidebar-foreground)', fontFamily: 'var(--font-heading)', fontSize: '1.2rem', fontWeight: 800, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
              DocFlow
            </span>
          )}
        </div>

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '12px 8px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {!sidebarCollapsed && sectionLabel('Workspace')}
          {navItemsMain.map((item) => (
            <SidebarItem key={item.to} item={item} collapsed={sidebarCollapsed} onNavigate={closeMobile} />
          ))}

          {navItemsAdmin.length > 0 && (
            <>
              <hr className="hairline" style={{ margin: '16px 12px 10px' }} />
              {!sidebarCollapsed && sectionLabel('Administration')}
              {navItemsAdmin.map((item) => (
                <SidebarItem key={item.to} item={item} collapsed={sidebarCollapsed} onNavigate={closeMobile} />
              ))}
            </>
          )}
        </nav>

        {/* Workspace switcher (bottom) */}
        <div style={{ padding: '12px', borderTop: '1px solid var(--sidebar-border)', flexShrink: 0 }}>
          <div className="glass-solid" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', borderRadius: 'var(--radius-md)', boxShadow: 'none' }}>
            <div style={{
              width: '32px', height: '32px', borderRadius: '9px',
              background: 'var(--secondary)', color: 'var(--secondary-foreground)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <Building2 size={16} />
            </div>
            {!sidebarCollapsed && (
              <>
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div className="label-caps" style={{ padding: 0 }}>Workspace</div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--sidebar-foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {orgMembership?.organization.name ?? '—'}
                  </div>
                </div>
                <ChevronsUpDown size={15} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
              </>
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
          height: 'var(--header-height)', position: 'sticky', top: 0,
          background: 'var(--sidebar)',
          backdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
          WebkitBackdropFilter: 'blur(var(--glass-blur)) saturate(var(--glass-saturate))',
          borderBottom: '1px solid var(--sidebar-border)',
          display: 'flex', alignItems: 'center', padding: '0 24px', gap: '16px', zIndex: 50,
        }}>
          <button
            className="mobile-menu-btn"
            onClick={() => setMobileMenuOpen(true)}
            style={{ background: 'transparent', border: 'none', color: 'var(--foreground)', cursor: 'pointer', padding: '8px', marginLeft: '-12px' }}
          >
            <Menu size={24} />
          </button>

          {/* Search → command palette */}
          <button
            onClick={() => setPaletteOpen(true)}
            style={{
              flex: 1, maxWidth: '520px', display: 'flex', alignItems: 'center', gap: '8px',
              background: 'var(--input)', border: '1px solid var(--input-border)',
              borderRadius: 'var(--radius-md)', padding: '9px 14px', cursor: 'pointer', textAlign: 'left',
            }}
          >
            <Search size={16} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
            <span style={{ color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>Search documents, workflows, or users…</span>
            <span className="font-mono" style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--muted-foreground)', padding: '2px 6px', borderRadius: '5px', border: '1px solid var(--border)', background: 'var(--muted)' }}>⌘K</span>
          </button>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {/* Theme toggle (rotating morph) */}
            <button
              id="btn-theme-toggle"
              onClick={toggleTheme}
              title={isLight ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '36px', height: '36px', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                background: isLight ? 'var(--secondary)' : 'color-mix(in srgb, var(--muted-foreground) 12%, transparent)',
                color: isLight ? 'var(--secondary-foreground)' : 'var(--primary)',
                cursor: 'pointer', flexShrink: 0, overflow: 'hidden',
              }}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={isLight ? 'moon' : 'sun'}
                  initial={{ rotate: -90, opacity: 0, scale: 0.6 }}
                  animate={{ rotate: 0, opacity: 1, scale: 1 }}
                  exit={{ rotate: 90, opacity: 0, scale: 0.6 }}
                  transition={fmTransition.micro}
                  style={{ display: 'flex' }}
                >
                  {isLight ? <Moon size={16} /> : <Sun size={16} />}
                </motion.span>
              </AnimatePresence>
            </button>

            {/* Notification bell */}
            <div style={{ position: 'relative' }}>
              <button
                id="btn-notifications"
                className="btn btn-ghost btn-icon"
                style={{ position: 'relative', color: 'var(--muted-foreground)' }}
                onClick={() => setNotifOpen(!notifOpen)}
              >
                <Bell size={20} />
                {unreadCount > 0 && (
                  <span style={{
                    position: 'absolute', top: 4, right: 6, width: 8, height: 8,
                    background: 'var(--destructive)', borderRadius: '50%', border: '2px solid var(--sidebar)',
                  }} />
                )}
              </button>

              <AnimatePresence>
                {notifOpen && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setNotifOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      transition={fmTransition.micro}
                      className="glass-card"
                      style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', minWidth: '320px', zIndex: 50, padding: '16px' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <h4 style={{ fontFamily: 'var(--font-heading)', fontSize: '0.9rem', fontWeight: 700, color: 'var(--foreground)', margin: 0 }}>Notifications</h4>
                        {unreadCount > 0 && (
                          <button onClick={() => markAllReadM.mutate()} style={{ background: 'none', border: 'none', fontSize: '0.75rem', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}>Mark all read</button>
                        )}
                      </div>
                      {notifications.length === 0 ? (
                        <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>No new notifications.</p>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '300px', overflowY: 'auto' }}>
                          {notifications.map(n => (
                            <div key={n.id} style={{ display: 'flex', gap: '8px', opacity: n.read_at ? 0.7 : 1 }}>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.8125rem', color: 'var(--foreground)', fontWeight: n.read_at ? 400 : 600 }}>{n.title}</div>
                                {n.body && <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', marginTop: '2px' }}>{n.body}</div>}
                                <div style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', marginTop: '4px' }}>{new Date(n.created_at).toLocaleString()}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
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
                  background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-full)',
                  padding: '3px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px',
                  paddingRight: '10px', transition: 'all var(--transition-fast)',
                }}
              >
                <UserAvatar name={user?.name ?? 'User'} avatarUrl={user?.avatar_url ?? null} size={30} />
                <span style={{ fontFamily: 'var(--font-heading)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--foreground)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user?.name ?? 'User'}
                </span>
                <ChevronDown size={14} style={{ color: 'var(--muted-foreground)' }} />
              </button>

              <AnimatePresence>
                {userMenuOpen && (
                  <>
                    <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setUserMenuOpen(false)} />
                    <motion.div
                      initial={{ opacity: 0, y: 8, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.97 }}
                      transition={fmTransition.micro}
                      className="glass-card"
                      style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', minWidth: '210px', zIndex: 50, overflow: 'hidden', padding: 0 }}
                    >
                      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                        <p style={{ fontFamily: 'var(--font-heading)', fontSize: '0.875rem', fontWeight: 600, color: 'var(--foreground)' }}>{user?.name}</p>
                        <p style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>{user?.email}</p>
                      </div>
                      <div style={{ padding: '6px' }}>
                        <button
                          id="menu-profile"
                          onClick={() => { setUserMenuOpen(false); navigate('/profile'); }}
                          className="btn btn-ghost"
                          style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.875rem', gap: '10px' }}
                        >
                          <User size={15} />
                          Profile & Settings
                        </button>
                        <button
                          id="menu-logout"
                          onClick={() => { setUserMenuOpen(false); logout.mutate(); }}
                          className="btn btn-ghost"
                          style={{ width: '100%', justifyContent: 'flex-start', fontSize: '0.875rem', color: 'var(--destructive)', gap: '10px' }}
                        >
                          <LogOut size={15} />
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

        {/* Page content — only this transitions on navigation */}
        <div style={{ maxWidth: 1440, margin: '0 auto', width: '100%' }}>
          <PageTransition>
            <Outlet />
          </PageTransition>
        </div>
      </main>

      {/* Global toasts (sonner, themed) */}
      <Toaster />
    </div>
  );
}
