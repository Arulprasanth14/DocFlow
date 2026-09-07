/**
 * DocFlow Frontend — Search Page
 * Global search with filter chips, recent searches, grouped results.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, FileText, GitBranch, Users, Clock,
  X, ArrowRight, TrendingUp, Zap, Hash, Command
} from 'lucide-react';

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

type SearchFilter = 'all' | 'documents' | 'workflows' | 'users';

interface SearchResult {
  id: string;
  type: 'document' | 'workflow' | 'user';
  title: string;
  subtitle: string;
  meta: string;
  color: string;
}

const MOCK_RESULTS: SearchResult[] = [
  { id: '1', type: 'document', title: 'Q4 Financial Report 2026', subtitle: 'Finance · PDF · 2.4 MB', meta: 'Updated 2h ago', color: C.primary400 },
  { id: '2', type: 'document', title: 'Product Roadmap H1 2027', subtitle: 'Strategy · DOCX · 890 KB', meta: 'Updated yesterday', color: C.primary400 },
  { id: '3', type: 'document', title: 'AWS Vendor Contract', subtitle: 'Legal · PDF · 1.1 MB', meta: 'Updated 3 days ago', color: C.primary400 },
  { id: '4', type: 'workflow', title: 'Finance Approval Chain', subtitle: 'Active · Step 3/5 — Approve', meta: '6h SLA remaining', color: C.purple },
  { id: '5', type: 'workflow', title: 'Legal Contract Review', subtitle: 'Active · Step 2/5 — Review', meta: '3d SLA remaining', color: C.purple },
  { id: '6', type: 'user', title: 'Sarah Mitchell', subtitle: 'Finance Manager · Finance Dept', meta: 'Last active today', color: C.success },
  { id: '7', type: 'user', title: 'Marcus Lee', subtitle: 'Product Lead · Strategy Dept', meta: 'Last active 2h ago', color: C.success },
  { id: '8', type: 'document', title: 'Remote Work Policy v2.1', subtitle: 'HR · PDF · 450 KB', meta: 'Updated 4 days ago', color: C.primary400 },
];

const POPULAR: string[] = ['Budget report', 'Vendor contract', 'HR policy', 'Product roadmap', 'Security audit'];

const RECENT_KEY = 'docflow_recent_searches';

function getRecentSearches(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 5);
  } catch { return []; }
}

function saveSearch(query: string) {
  try {
    const prev = getRecentSearches();
    const next = [query, ...prev.filter(q => q !== query)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

function removeRecentSearch(query: string) {
  try {
    const next = getRecentSearches().filter(q => q !== query);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

const typeIcon: Record<string, React.ElementType> = {
  document: FileText,
  workflow: GitBranch,
  user: Users,
};

const filterLabels: { key: SearchFilter; label: string; icon: React.ElementType; color: string }[] = [
  { key: 'all', label: 'All', icon: Hash, color: C.primary400 },
  { key: 'documents', label: 'Documents', icon: FileText, color: C.primary400 },
  { key: 'workflows', label: 'Workflows', icon: GitBranch, color: C.purple },
  { key: 'users', label: 'Users', icon: Users, color: C.success },
];

export default function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SearchFilter>('all');
  const [recentSearches, setRecentSearches] = useState<string[]>(getRecentSearches);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (query.trim().length < 2) { setIsSearching(false); return; }
    setIsSearching(true);
    const t = setTimeout(() => setIsSearching(false), 300);
    return () => clearTimeout(t);
  }, [query]);

  const handleSearch = (q: string) => {
    if (!q.trim()) return;
    saveSearch(q.trim());
    setRecentSearches(getRecentSearches());
    setQuery(q);
  };

  const handleRemoveRecent = (q: string) => {
    removeRecentSearch(q);
    setRecentSearches(getRecentSearches());
  };

  const results = MOCK_RESULTS.filter(r => {
    const matchesFilter = filter === 'all' || r.type + 's' === filter || (filter === 'documents' && r.type === 'document') || (filter === 'workflows' && r.type === 'workflow') || (filter === 'users' && r.type === 'user');
    const matchesQuery = query.trim().length < 2 ? false : r.title.toLowerCase().includes(query.toLowerCase()) || r.subtitle.toLowerCase().includes(query.toLowerCase());
    return matchesFilter && matchesQuery;
  });

  const hasQuery = query.trim().length >= 2;

  const grouped = {
    document: results.filter(r => r.type === 'document'),
    workflow: results.filter(r => r.type === 'workflow'),
    user: results.filter(r => r.type === 'user'),
  };

  const groupOrder: (keyof typeof grouped)[] = filter === 'all' ? ['document', 'workflow', 'user'] : [(filter === 'documents' ? 'document' : filter === 'workflows' ? 'workflow' : 'user')];

  return (
    <div style={{ position: 'relative', minHeight: '100%' }}>
      {/* Ambient */}
      <div style={{ position: 'absolute', top: -200, left: '50%', transform: 'translateX(-50%)', width: 800, height: 500, borderRadius: 9999, background: 'radial-gradient(circle, rgba(37,99,235,0.14) 0%, transparent 68%)', filter: 'blur(200px)', zIndex: 1, pointerEvents: 'none' }} />

      <div style={{ position: 'relative', zIndex: 10, padding: '40px 32px', maxWidth: 860, margin: '0 auto' }}>
        {/* Hero Search */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: `color-mix(in srgb, ${C.primary400} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${C.primary400} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Search size={20} color={C.primary400} />
            </div>
            <h1 style={{ fontSize: 28, fontWeight: 800, color: C.heading, margin: 0 }}>Global Search</h1>
          </div>
          <p style={{ color: C.muted, fontSize: 14 }}>Find documents, workflows, and team members instantly</p>
        </div>

        {/* Big search input */}
        <div style={{ position: 'relative', marginBottom: 24 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 18,
            padding: '14px 20px', boxShadow: '0 4px 32px rgba(0,0,0,0.3)',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}
            className="search-box"
          >
            {isSearching ? (
              <div style={{ width: 20, height: 20, border: `2px solid ${C.border}`, borderTopColor: C.primary400, borderRadius: '50%', animation: 'spin 0.7s linear infinite', flexShrink: 0 }} />
            ) : (
              <Search size={20} color={C.muted} style={{ flexShrink: 0 }} />
            )}
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSearch(query); }}
              placeholder="Search documents, workflows, users..."
              style={{
                background: 'none', border: 'none', outline: 'none',
                color: C.heading, fontSize: 16, flex: 1, fontFamily: 'var(--font-sans)',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              {query && (
                <button onClick={() => setQuery('')} style={{ background: C.overlay, border: 'none', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.muted }}>
                  <X size={12} />
                </button>
              )}
              <span style={{ fontSize: 11, color: C.disabled, padding: '3px 7px', borderRadius: 6, border: `1px solid ${C.borderSubtle}`, background: C.overlay, display: 'flex', alignItems: 'center', gap: 3 }}>
                <Command size={10} /> K
              </span>
            </div>
          </div>
        </div>

        {/* Filter chips */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 28, flexWrap: 'wrap' }}>
          {filterLabels.map(f => {
            const Icon = f.icon;
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px',
                  borderRadius: 99, border: `1px solid ${active ? `color-mix(in srgb, ${f.color} 35%, transparent)` : C.borderSubtle}`,
                  background: active ? `color-mix(in srgb, ${f.color} 12%, transparent)` : C.card,
                  color: active ? f.color : C.muted, fontSize: 13, fontWeight: active ? 700 : 500,
                  cursor: 'pointer', transition: 'all 0.2s',
                }}
              >
                <Icon size={13} />
                {f.label}
              </button>
            );
          })}
        </div>

        {/* Results or empty state */}
        {hasQuery ? (
          results.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 32px' }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: `color-mix(in srgb, ${C.muted} 10%, transparent)`, border: `1px solid ${C.borderSubtle}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Search size={24} color={C.muted} />
              </div>
              <div style={{ color: C.heading, fontSize: 18, fontWeight: 700, marginBottom: 8 }}>No results for "{query}"</div>
              <div style={{ color: C.muted, fontSize: 14 }}>Try adjusting your filters or search terms</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              {groupOrder.map(type => {
                const items = grouped[type];
                if (items.length === 0) return null;
                const Icon = typeIcon[type];
                const typeLabel = type === 'document' ? 'Documents' : type === 'workflow' ? 'Workflows' : 'Users';
                const typeColor = type === 'document' ? C.primary400 : type === 'workflow' ? C.purple : C.success;
                return (
                  <div key={type}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <Icon size={14} color={typeColor} />
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: typeColor }}>{typeLabel}</span>
                      <span style={{ fontSize: 11, color: C.disabled, background: C.overlay, padding: '1px 6px', borderRadius: 99, border: `1px solid ${C.borderSubtle}` }}>{items.length}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {items.map(r => {
                        const RIcon = typeIcon[r.type];
                        return (
                          <div key={r.id} className="result-row" style={{
                            display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px',
                            background: C.card, border: `1px solid ${C.border}`, borderRadius: 14,
                            cursor: 'pointer', transition: 'all 0.2s',
                          }}>
                            <div style={{ width: 38, height: 38, borderRadius: 10, background: `color-mix(in srgb, ${r.color} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${r.color} 20%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                              <RIcon size={18} color={r.color} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ color: C.heading, fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div>
                              <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{r.subtitle}</div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                              <span style={{ color: C.disabled, fontSize: 11 }}>{r.meta}</span>
                              <ArrowRight size={14} color={C.disabled} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            {/* Recent Searches */}
            {recentSearches.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <Clock size={14} color={C.muted} />
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: C.muted }}>Recent</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {recentSearches.map(q => (
                    <div key={q} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, cursor: 'pointer', transition: 'all 0.2s' }}
                      className="result-row"
                      onClick={() => setQuery(q)}
                    >
                      <Clock size={14} color={C.disabled} />
                      <span style={{ flex: 1, color: C.body, fontSize: 14 }}>{q}</span>
                      <button onClick={e => { e.stopPropagation(); handleRemoveRecent(q); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.disabled, display: 'flex', padding: 2 }}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Popular Searches */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <TrendingUp size={14} color={C.warning} />
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: C.warning }}>Popular</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {POPULAR.map(p => (
                  <button
                    key={p}
                    onClick={() => setQuery(p)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                      background: C.card, border: `1px solid ${C.border}`, borderRadius: 99,
                      color: C.body, fontSize: 13, cursor: 'pointer', transition: 'all 0.2s',
                    }}
                    className="popular-pill"
                  >
                    <Zap size={12} color={C.warning} />
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Quick Links */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <ArrowRight size={14} color={C.primary400} />
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: C.primary400 }}>Quick Navigate</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                {[
                  { label: 'All Documents', sub: 'Browse your document library', icon: FileText, color: C.primary400, path: '/documents' },
                  { label: 'My Approvals', sub: 'Pending items in your queue', icon: GitBranch, color: C.purple, path: '/approvals' },
                  { label: 'Team Members', sub: 'View org members', icon: Users, color: C.success, path: '/admin/members' },
                ].map(item => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} onClick={() => navigate(item.path)} className="result-row" style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
                      background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, cursor: 'pointer', transition: 'all 0.2s',
                    }}>
                      <div style={{ width: 36, height: 36, borderRadius: 10, background: `color-mix(in srgb, ${item.color} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${item.color} 20%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Icon size={18} color={item.color} />
                      </div>
                      <div>
                        <div style={{ color: C.heading, fontWeight: 600, fontSize: 14 }}>{item.label}</div>
                        <div style={{ color: C.muted, fontSize: 12, marginTop: 1 }}>{item.sub}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .search-box:focus-within {
          border-color: var(--color-primary-500) !important;
          box-shadow: 0 0 0 3px hsla(217, 100%, 50%, 0.15), 0 4px 32px rgba(0,0,0,0.3) !important;
        }
        .result-row:hover {
          border-color: var(--border-strong) !important;
          transform: translateX(3px);
        }
        .popular-pill:hover {
          background: var(--bg-overlay) !important;
          border-color: var(--border-strong) !important;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
