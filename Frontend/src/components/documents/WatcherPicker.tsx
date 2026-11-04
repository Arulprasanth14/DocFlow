/**
 * DocFlow — watchers / CC on a document (spec FR-13.4).
 *
 * A watcher gets the document's notifications. They do NOT get an approval
 * step, and being CC'd does not grant access to a document someone could not
 * already open — the server's access rules are untouched by this list. The
 * helper text says so, because "CC" in an email client does imply access and
 * that assumption would be wrong here.
 *
 * Candidates come from a dedicated endpoint that returns only name and email,
 * and only on request: this is org-member data, so it is not fetched until
 * the picker is actually opened.
 */
import { useEffect, useRef, useState } from 'react';
import { Users, X, Plus, Loader2, Search, AlertCircle } from 'lucide-react';
import {
  useWatchers,
  useWatcherCandidates,
  useAddWatcher,
  useRemoveWatcher,
} from '@/hooks/useDocuments';

export interface WatcherPickerProps {
  docId: string;
  /** Locked once the document is no longer editable. */
  disabled?: boolean;
}

export function WatcherPicker({ docId, disabled = false }: WatcherPickerProps) {
  const { data: watchers = [], isLoading } = useWatchers(docId);
  const addWatcher = useAddWatcher();
  const removeWatcher = useRemoveWatcher();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Debounced so typing a name is not one request per keystroke (FR-1.3's
  // 250-300ms rule, applied to the same kind of lookup).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 280);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => { if (open) searchRef.current?.focus(); }, [open]);

  const { data: candidates = [], isLoading: candidatesLoading } =
    useWatcherCandidates(docId, debounced, open && !disabled);

  const add = async (userId: string) => {
    setPending(userId);
    setError('');
    try {
      await addWatcher.mutateAsync({ docId, userId });
      setQuery('');
    } catch (err) {
      setError(err instanceof Error ? err.message : "That person couldn't be added.");
    } finally {
      setPending(null);
    }
  };

  const drop = async (userId: string) => {
    setPending(userId);
    setError('');
    try {
      await removeWatcher.mutateAsync({ docId, userId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That person couldn't be removed.");
    } finally {
      setPending(null);
    }
  };

  return (
    <section style={{ display: 'grid', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Users size={14} style={{ color: 'var(--muted-foreground)' }} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: 'var(--foreground)' }}>
          Watchers
        </h3>
        <span style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>
          Optional
        </span>
      </header>

      <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--muted-foreground)', lineHeight: 1.45 }}>
        Watchers are kept informed about this document. They are not approvers
        and can&apos;t act on it, and being added doesn&apos;t give anyone
        access they don&apos;t already have.
      </p>

      {isLoading && (
        <div className="skeleton" style={{ height: 32, borderRadius: 'var(--radius-pill)' }} />
      )}

      {!isLoading && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {watchers.map((w) => (
            <span
              key={w.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '4px 6px 4px 10px', borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--border)', background: 'var(--secondary)',
                fontSize: '0.78rem', color: 'var(--foreground)', maxWidth: 260,
              }}
              title={w.email ?? undefined}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {w.name || w.email || 'Unknown person'}
              </span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => void drop(w.user_id)}
                  disabled={pending === w.user_id}
                  aria-label={`Remove ${w.name || w.email || 'this watcher'}`}
                  style={{
                    display: 'inline-flex', border: 'none', background: 'transparent',
                    cursor: 'pointer', color: 'var(--muted-foreground)', padding: 2,
                  }}
                >
                  {pending === w.user_id
                    ? <Loader2 size={12} style={{ animation: 'spin 0.8s linear infinite' }} />
                    : <X size={12} />}
                </button>
              )}
            </span>
          ))}

          {watchers.length === 0 && (
            <span style={{ fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
              Nobody is being kept informed yet.
            </span>
          )}

          {!disabled && !open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="btn btn-ghost btn-sm"
              style={{ fontSize: '0.76rem' }}
            >
              <Plus size={13} /> Add someone
            </button>
          )}
        </div>
      )}

      {open && !disabled && (
        <div style={{
          display: 'grid', gap: 8, padding: 10,
          borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          background: 'var(--card-solid)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Search size={14} style={{ color: 'var(--muted-foreground)' }} aria-hidden="true" />
            <input
              ref={searchRef}
              className="input"
              value={query}
              placeholder="Search by name or email"
              aria-label="Search colleagues"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setQuery(''); } }}
              style={{ flex: 1, fontSize: '0.82rem' }}
            />
            <button
              type="button"
              onClick={() => { setOpen(false); setQuery(''); }}
              className="btn btn-ghost btn-sm"
              aria-label="Close the watcher picker"
              style={{ padding: '3px 6px' }}
            >
              <X size={14} />
            </button>
          </div>

          {candidatesLoading && (
            <div style={{ display: 'grid', gap: 4 }}>
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton" style={{ height: 34, borderRadius: 'var(--radius-sm)' }} />
              ))}
            </div>
          )}

          {!candidatesLoading && candidates.length === 0 && (
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
              {debounced
                ? `Nobody matching “${debounced}”.`
                : 'Everyone in your organisation is already watching this document.'}
            </p>
          )}

          {!candidatesLoading && candidates.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
              {candidates.map((c) => (
                <li key={c.user_id}>
                  <button
                    type="button"
                    onClick={() => void add(c.user_id)}
                    disabled={pending === c.user_id}
                    className="glass-interactive"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 9, width: '100%',
                      padding: '7px 9px', borderRadius: 'var(--radius-sm)',
                      border: 'none', background: 'transparent', cursor: 'pointer',
                      textAlign: 'left', color: 'var(--foreground)',
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{
                        display: 'block', fontSize: '0.82rem', fontWeight: 600,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {c.name || c.email || 'Unknown person'}
                      </span>
                      {c.name && c.email && (
                        <span style={{
                          display: 'block', fontSize: '0.72rem', color: 'var(--muted-foreground)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {c.email}
                        </span>
                      )}
                    </span>
                    {pending === c.user_id
                      ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                      : <Plus size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: 6, margin: 0,
          fontSize: '0.78rem', color: 'var(--status-rejected-fg)',
        }}>
          <AlertCircle size={13} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
          {error}
        </p>
      )}
    </section>
  );
}

export default WatcherPicker;
