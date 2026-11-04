/**
 * DocFlow Frontend — Search Page
 * Global search with filter chips, recent searches, grouped results.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search, FileText, GitBranch, Users, Clock,
  X, ArrowRight, Hash, Command, MessageSquare, AlertCircle
} from 'lucide-react';
import { searchApi, type SearchEntity } from '@/lib/api/search';

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

type SearchFilter = 'all' | 'documents' | 'workflows' | 'members' | 'messages';

/** A display row, mapped from whichever backend entity produced it. */
interface SearchResult {
  id: string;
  type: 'document' | 'workflow' | 'member' | 'message';
  title: string;
  subtitle: string;
  meta: string;
  color: string;
  deepLink: string;
}

const RECENT_KEY = 'docflow_recent_searches';

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

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
  member: Users,
  message: MessageSquare,
};

const filterLabels: { key: SearchFilter; label: string; icon: React.ElementType; color: string }[] = [
  { key: 'all', label: 'All', icon: Hash, color: C.primary400 },
  { key: 'documents', label: 'Documents', icon: FileText, color: C.primary400 },
  { key: 'workflows', label: 'Workflows', icon: GitBranch, color: C.purple },
  { key: 'members', label: 'People', icon: Users, color: C.success },
  { key: 'messages', label: 'Messages', icon: MessageSquare, color: C.warning },
];

const GROUP_LABEL: Record<SearchResult['type'], string> = {
  document: 'Documents',
  workflow: 'Workflows',
  member: 'People',
  message: 'Messages',
};

const GROUP_COLOR: Record<SearchResult['type'], string> = {
  document: C.primary400,
  workflow: C.purple,
  member: C.success,
  message: C.warning,
};

export default function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<SearchFilter>('all');
  const [recentSearches, setRecentSearches] = useState<string[]>(getRecentSearches);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const hasQuery = debounced.length >= 2;
  const entities: SearchEntity[] | undefined =
    filter === 'all' ? undefined : [filter as SearchEntity];

  const {
    data,
    isFetching,
    isError,
    error,
  } = useQuery({
    queryKey: ['search', debounced, filter],
    queryFn: () => searchApi.search({ q: debounced, entities, limit: 10 }),
    enabled: hasQuery,
    staleTime: 15_000,
  });

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

  // Map the backend's per-entity groups onto display rows. Every field
  // shown comes from the API — nothing is synthesized client-side.
  const groups = data?.groups;
  const grouped: Record<SearchResult['type'], SearchResult[]> = {
    document: (groups?.documents?.items ?? []).map(d => ({
      id: d.id,
      type: 'document' as const,
      title: d.title,
      subtitle: [d.public_id, d.document_type, d.status].filter(Boolean).join(' · '),
      meta: d.updated_at ? `Updated ${formatWhen(d.updated_at)}` : '',
      color: C.primary400,
      deepLink: d.deep_link,
    })),
    workflow: (groups?.workflows?.items ?? []).map(w => ({
      id: w.id,
      type: 'workflow' as const,
      title: w.title,
      subtitle: [
        w.is_active ? 'Active' : 'Disabled',
        w.owned_by_me ? 'Mine' : w.visibility === 'private' ? 'Private' : 'Shared',
        `v${w.version}`,
      ].join(' · '),
      meta: w.description ?? '',
      color: C.purple,
      deepLink: w.deep_link,
    })),
    member: (groups?.members?.items ?? []).map(m => ({
      id: m.id,
      type: 'member' as const,
      title: m.title,
      subtitle: [m.role, m.department].filter(Boolean).join(' · ') || m.email,
      meta: m.email,
      color: C.success,
      deepLink: m.deep_link,
    })),
    message: (groups?.messages?.items ?? []).map(m => ({
      id: m.id,
      type: 'message' as const,
      title: m.title ?? '',
      subtitle: [m.sender_name, m.conversation_title].filter(Boolean).join(' · '),
      meta: formatWhen(m.created_at),
      color: C.warning,
      deepLink: m.deep_link,
    })),
  };

  const groupOrder: SearchResult['type'][] =
    filter === 'all'
      ? ['document', 'workflow', 'member', 'message']
      : [
          filter === 'documents'
            ? 'document'
            : filter === 'workflows'
              ? 'workflow'
              : filter === 'members'
                ? 'member'
                : 'message',
        ];

  const results = groupOrder.flatMap(t => grouped[t]);
  const isSearching = isFetching;

  return (
    <div style={{ position: 'relative', minHeight: '100%' }}>
      {/* Ambient */}
      <div style={{ position: 'absolute', top: -200, left: '50%', transform: 'translateX(-50%)', width: 800, height: 500, borderRadius: 9999, background: 'radial-gradient(circle, color-mix(in srgb, var(--primary) 14%, transparent) 0%, transparent 68%)', filter: 'blur(200px)', zIndex: 1, pointerEvents: 'none' }} />

      <div style={{ position: 'relative', zIndex: 10, padding: '40px 32px', maxWidth: 860, margin: '0 auto' }}>
        {/* Hero Search */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: `color-mix(in srgb, ${C.primary400} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${C.primary400} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Search size={20} color={C.primary400} />
            </div>
            <h1 data-page-title className="font-display" style={{ fontSize: '2rem', fontWeight: 400, lineHeight: 1.1, color: 'var(--foreground)', margin: 0 }}>Global Search</h1>
          </div>
          <p style={{ color: C.muted, fontSize: 14 }}>Find documents, workflows, and team members instantly</p>
        </div>

        {/* Big search input */}
        <div style={{ position: 'relative', marginBottom: 24 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            background: C.card, border: `1.5px solid ${C.border}`, borderRadius: 18,
            padding: '14px 20px', boxShadow: 'var(--shadow-lg)',
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

        {/* Results, loading, error, or empty state */}
        {hasQuery ? (
          isError ? (
            <div style={{ textAlign: 'center', padding: '60px 32px' }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: `color-mix(in srgb, ${C.danger} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${C.danger} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <AlertCircle size={24} color={C.danger} />
              </div>
              <div style={{ color: C.heading, fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Search failed</div>
              <div style={{ color: C.muted, fontSize: 14 }}>
                {(error as Error)?.message || 'Something went wrong. Please try again.'}
              </div>
            </div>
          ) : isFetching && !data ? (
            <div style={{ textAlign: 'center', padding: '60px 32px' }}>
              <div style={{ width: 28, height: 28, border: `3px solid ${C.border}`, borderTopColor: C.primary400, borderRadius: '50%', animation: 'spin 0.7s linear infinite', margin: '0 auto 14px' }} />
              <div style={{ color: C.muted, fontSize: 14 }}>Searching…</div>
            </div>
          ) : results.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 32px' }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: `color-mix(in srgb, ${C.muted} 10%, transparent)`, border: `1px solid ${C.borderSubtle}`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Search size={24} color={C.muted} />
              </div>
              <div style={{ color: C.heading, fontSize: 18, fontWeight: 700, marginBottom: 8 }}>No results for "{debounced}"</div>
              <div style={{ color: C.muted, fontSize: 14 }}>Try adjusting your filters or search terms</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
              {groupOrder.map(type => {
                const items = grouped[type];
                if (items.length === 0) return null;
                const Icon = typeIcon[type];
                const typeLabel = GROUP_LABEL[type];
                const typeColor = GROUP_COLOR[type];
                // Total from the server, not items.length — the list is
                // capped at the page limit, so showing the array length
                // would under-report how many matches actually exist.
                const groupTotal =
                  type === 'document' ? groups?.documents?.total
                  : type === 'workflow' ? groups?.workflows?.total
                  : type === 'member' ? groups?.members?.total
                  : groups?.messages?.total;
                return (
                  <div key={type}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <Icon size={14} color={typeColor} />
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: typeColor }}>{typeLabel}</span>
                      <span style={{ fontSize: 11, color: C.disabled, background: C.overlay, padding: '1px 6px', borderRadius: 99, border: `1px solid ${C.borderSubtle}` }}>{groupTotal ?? items.length}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {items.map(r => {
                        const RIcon = typeIcon[r.type];
                        return (
                          <div key={r.id} className="result-row" onClick={() => navigate(r.deepLink)} style={{
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

            {/* NOTE: the previous "Popular" chips were hardcoded fake
                document names ("Budget report", "Vendor contract", …) which
                read as real org content. Removed rather than faked — the
                backend has no search-popularity tracking to source them
                from. Recent searches above are real (per-browser). */}

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
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 15%, transparent), var(--shadow-lg) !important;
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
