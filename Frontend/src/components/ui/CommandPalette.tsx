/**
 * CommandPalette — glass ⌘K palette (cmdk, already a dependency).
 * Grouped quick-navigation + "Search documents for …" that routes to the real Search page.
 * Uses only existing routes/data — invents no results. Opened from the topbar search or ⌘K.
 */

import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard, FileText, CheckSquare, Workflow, Search, BarChart3,
  MessageSquare, FilePen, Bot, Settings, User, Building2, Users, Network,
  ShieldCheck, FileType, Search as SearchIcon,
} from 'lucide-react';
import { fmTransition } from '@/lib/motion/tokens';

interface Cmd {
  icon: React.ReactNode;
  label: string;
  to: string;
  keywords?: string;
}

export function CommandPalette({
  open,
  onOpenChange,
  showAdmin,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  showAdmin: boolean;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const go = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  const nav: Cmd[] = [
    { icon: <LayoutDashboard size={16} />, label: 'Dashboard', to: '/dashboard' },
    { icon: <FileText size={16} />, label: 'Documents', to: '/documents' },
    { icon: <CheckSquare size={16} />, label: 'Approvals', to: '/approvals' },
    { icon: <Workflow size={16} />, label: 'Workflows', to: '/workflows' },
    { icon: <Search size={16} />, label: 'Search', to: '/search' },
    { icon: <BarChart3 size={16} />, label: 'Analytics', to: '/analytics' },
    { icon: <MessageSquare size={16} />, label: 'Messages', to: '/chat' },
    { icon: <FilePen size={16} />, label: 'Drafts', to: '/drafts' },
    { icon: <Bot size={16} />, label: 'Agent', to: '/agent' },
    { icon: <Settings size={16} />, label: 'Settings', to: '/settings' },
    { icon: <User size={16} />, label: 'Profile', to: '/profile' },
  ];
  const admin: Cmd[] = [
    { icon: <Building2 size={16} />, label: 'Organization', to: '/admin/organization' },
    { icon: <Network size={16} />, label: 'Departments', to: '/admin/departments' },
    { icon: <ShieldCheck size={16} />, label: 'Roles & Perms', to: '/admin/roles' },
    { icon: <Users size={16} />, label: 'Members', to: '/admin/members' },
    { icon: <FileType size={16} />, label: 'Doc Types', to: '/admin/document-types' },
  ];

  const itemStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '9px 12px',
    borderRadius: 'var(--radius-md)',
    fontSize: '0.875rem',
    color: 'var(--foreground)',
    cursor: 'pointer',
  } as const;

  return (
    <AnimatePresence>
      {open && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 16px 16px' }}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fmTransition.micro}
            onClick={() => onOpenChange(false)}
            style={{ position: 'absolute', inset: 0, background: 'var(--overlay-scrim)', backdropFilter: 'blur(4px)' }}
          />
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={fmTransition.base}
            className="glass-card"
            style={{ position: 'relative', width: '100%', maxWidth: 560, overflow: 'hidden', boxShadow: 'var(--shadow-lg), var(--glass-inner)' }}
          >
            <Command label="Command palette" shouldFilter>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
                <SearchIcon size={18} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                <Command.Input
                  autoFocus
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search documents, workflows, or jump to…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && query.trim()) {
                      // defer to cmdk's own selection first; only route to Search if nothing matched
                    }
                  }}
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--foreground)', fontSize: '0.95rem', fontFamily: 'var(--font-sans)' }}
                />
                <span style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)' }}>ESC</span>
              </div>
              <Command.List style={{ maxHeight: 360, overflowY: 'auto', padding: 8 }}>
                <Command.Empty style={{ padding: '20px 12px', fontSize: '0.85rem', color: 'var(--muted-foreground)', textAlign: 'center' }}>
                  No quick matches.
                </Command.Empty>

                {query.trim() && (
                  <Command.Group>
                    <Command.Item value={`search ${query}`} onSelect={() => go('/search')} style={itemStyle}>
                      <Search size={16} style={{ color: 'var(--primary)' }} />
                      <span>Search documents for “<strong>{query}</strong>”</span>
                    </Command.Item>
                  </Command.Group>
                )}

                <Command.Group heading="Navigate" className="cmdk-group">
                  {nav.map((c) => (
                    <Command.Item key={c.to} value={c.label} onSelect={() => go(c.to)} style={itemStyle}>
                      <span style={{ color: 'var(--muted-foreground)', display: 'flex' }}>{c.icon}</span>
                      {c.label}
                    </Command.Item>
                  ))}
                </Command.Group>

                {showAdmin && (
                  <Command.Group heading="Administration" className="cmdk-group">
                    {admin.map((c) => (
                      <Command.Item key={c.to} value={`admin ${c.label}`} onSelect={() => go(c.to)} style={itemStyle}>
                        <span style={{ color: 'var(--accent-amber)', display: 'flex' }}>{c.icon}</span>
                        {c.label}
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
              </Command.List>
            </Command>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export default CommandPalette;
