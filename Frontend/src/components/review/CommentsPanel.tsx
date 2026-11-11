/**
 * Review comments panel — AP-ANN-08/10, AP-ANN-20/21. Task P3-7.
 *
 * The approver's list of comments on the version being reviewed, in step
 * with the viewer: clicking a comment scrolls to its page, clicking a
 * highlight selects its comment.
 *
 * Drafts are edited in place and autosaved (AP-ANN-20). The rule the editor
 * is built around is that typed text is never lost:
 *   - a save is debounced one second after the last keystroke;
 *   - a failed save keeps the text, says so, and retries with back-off;
 *   - the text is also mirrored to browser storage, so a crash or a closed
 *     tab mid-outage still has it on return (AP-ANN-21);
 *   - leaving with an unsaved draft asks first.
 *
 * All text renders as plain text (AP-ANN-11).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCheck, CornerDownRight, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import annotationsApi, { type AnyThread } from '@/lib/api/annotations';
import feedbackApi from '@/lib/api/feedback';
import { ApiClientError } from '@/lib/api/client';
import { annotationKeys } from '@/hooks/useAnnotations';

type Filter = 'all' | 'draft' | 'open' | 'resolved';
type SaveState = 'saved' | 'saving' | 'retrying';

const C = {
  text: 'var(--text-primary)', muted: 'var(--text-muted)',
  border: 'var(--border-subtle)', hover: 'var(--bg-overlay)',
  accent: 'var(--accent-primary)', warning: 'var(--warning)',
};

const storageKey = (id: string) => `docflow.review-draft.${id}`;
const stash = {
  get(id: string): string | null {
    try { return window.localStorage.getItem(storageKey(id)); } catch { return null; }
  },
  set(id: string, value: string) {
    try { window.localStorage.setItem(storageKey(id), value); } catch { /* storage may be blocked */ }
  },
  clear(id: string) {
    try { window.localStorage.removeItem(storageKey(id)); } catch { /* ignore */ }
  },
};

function DraftEditor({
  thread, autoFocus, onDirty, onDiscard,
}: {
  thread: AnyThread;
  autoFocus: boolean;
  onDirty: (id: string, dirty: boolean) => void;
  onDiscard: (id: string) => void;
}) {
  // Text typed during an outage and never saved wins over the server's copy.
  const [text, setText] = useState(() => stash.get(thread.id) ?? thread.comment_text ?? '');
  const [state, setState] = useState<SaveState>('saved');
  const saved = useRef(thread.comment_text ?? '');
  const latest = useRef(text);
  const timer = useRef<number | undefined>(undefined);
  const attempt = useRef(0);
  latest.current = text;

  const save = async () => {
    const value = latest.current;
    if (value === saved.current) { setState('saved'); return; }
    setState((s) => (s === 'retrying' ? s : 'saving'));
    try {
      await annotationsApi.update(thread.id, { comment_text: value });
      saved.current = value;
      attempt.current = 0;
      if (latest.current === value) {
        stash.clear(thread.id);
        setState('saved');
        onDirty(thread.id, false);
      } else {
        timer.current = window.setTimeout(save, 1000);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        // Published from elsewhere: no longer editable, nothing to retry.
        toast.error(err.detail);
        stash.clear(thread.id);
        setState('saved');
        onDirty(thread.id, false);
        return;
      }
      attempt.current += 1;
      setState('retrying');
      const wait = Math.min(30000, 2000 * 2 ** (attempt.current - 1));
      timer.current = window.setTimeout(save, wait);
    }
  };

  useEffect(() => {
    if (text === saved.current) return undefined;
    stash.set(thread.id, text);
    onDirty(thread.id, true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, 1000);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div>
      <textarea
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === 'Enter') {
            window.clearTimeout(timer.current);
            save();
          }
        }}
        rows={3}
        maxLength={2000}
        placeholder="Write your comment…"
        aria-label={`Comment on page ${thread.page_number}`}
        style={{
          width: '100%', boxSizing: 'border-box', padding: '8px 10px',
          background: 'var(--bg-base)', border: `1px solid ${C.border}`,
          borderRadius: 8, color: C.text, fontSize: 13, resize: 'vertical',
          fontFamily: "'Inter', sans-serif",
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span role="status" style={{
          fontSize: 11, color: state === 'retrying' ? C.warning : C.muted,
        }}>
          {state === 'saved' && 'Saved'}
          {state === 'saving' && 'Saving…'}
          {state === 'retrying' && 'Could not save — retrying. Your text is kept.'}
        </span>
        <button
          onClick={() => onDiscard(thread.id)}
          style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center',
            gap: 4, background: 'transparent', border: 'none', color: C.muted,
            cursor: 'pointer', fontSize: 11,
          }}
        >
          <Trash2 size={12} /> Discard
        </button>
      </div>
    </div>
  );
}

interface Props {
  versionId: string;
  annotations: AnyThread[];
  activeId: string | null;
  currentUserId: string;
  onSelect: (thread: AnyThread) => void;
}

export function CommentsPanel({
  versionId, annotations, activeId, currentUserId, onSelect,
}: Props) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [reply, setReply] = useState<{ id: string; text: string } | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: annotationKeys.version(versionId) });

  // AP-ANN-21: do not let an unsaved draft leave with the tab.
  useEffect(() => {
    if (dirty.size === 0) return undefined;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  const counts = useMemo(() => ({
    all: annotations.length,
    draft: annotations.filter((a) => a.status === 'draft').length,
    open: annotations.filter((a) => a.status === 'open' || a.status === 'addressed').length,
    resolved: annotations.filter((a) => a.status === 'resolved').length,
  }), [annotations]);

  const pages = useMemo(() => {
    const shown = annotations.filter((a) => {
      if (filter === 'all') return true;
      if (filter === 'open') return a.status === 'open' || a.status === 'addressed';
      return a.status === filter;
    });
    const map = new Map<number, AnyThread[]>();
    for (const a of shown) map.set(a.page_number, [...(map.get(a.page_number) ?? []), a]);
    return [...map.entries()].sort((x, y) => x[0] - y[0]);
  }, [annotations, filter]);

  const markDirty = (id: string, isDirty: boolean) =>
    setDirty((prev) => {
      if (prev.has(id) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(id); else next.delete(id);
      return next;
    });

  async function discard(id: string) {
    try {
      await annotationsApi.discard(id);
      stash.clear(id);
      markDirty(id, false);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.detail : 'Could not discard this comment.');
    }
  }

  async function setStatus(id: string, status: 'open' | 'resolved') {
    try {
      await feedbackApi.setStatus(id, status);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.detail : 'Could not update this comment.');
    }
  }

  async function sendReply() {
    if (!reply || !reply.text.trim()) return;
    try {
      await feedbackApi.reply(reply.id, reply.text.trim());
      setReply(null);
      refresh();
    } catch (err) {
      // The text stays in the box on failure.
      toast.error(err instanceof ApiClientError ? err.detail : 'Could not send your reply.');
    }
  }

  const tab = (key: Filter, label: string) => (
    <button
      key={key}
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      style={{
        padding: '5px 10px', borderRadius: 999, fontSize: 11.5, cursor: 'pointer',
        border: `1px solid ${filter === key ? C.accent : C.border}`,
        background: filter === key ? C.hover : 'transparent',
        color: filter === key ? C.text : C.muted, fontWeight: 600,
      }}
    >
      {label} {counts[key]}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {tab('all', 'All')}{tab('draft', 'Drafts')}{tab('open', 'Open')}{tab('resolved', 'Resolved')}
      </div>

      {annotations.length === 0 && (
        <p style={{ fontSize: 13, color: C.muted, margin: 0, lineHeight: 1.6 }}>
          No comments yet. Select text in the document and choose Comment, or
          use Area comment for a scanned page.
        </p>
      )}
      {annotations.length > 0 && pages.length === 0 && (
        <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>Nothing matches this filter.</p>
      )}

      {pages.map(([page, items]) => (
        <section key={page} style={{ marginBottom: 12 }}>
          <h5 style={{
            margin: '0 0 6px', fontSize: 11, fontWeight: 700, color: C.muted,
            letterSpacing: '0.05em', textTransform: 'uppercase',
          }}>
            Page {page} · {items.length}
          </h5>
          <ul style={{ margin: 0, padding: 0 }}>
            {items.map((a) => {
              const mine = a.author_id === currentUserId;
              const active = a.id === activeId;
              return (
                <li
                  key={a.id}
                  ref={active ? activeRef : undefined}
                  style={{
                    listStyle: 'none', padding: '10px 12px', marginBottom: 6,
                    borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${active ? C.accent : C.border}`,
                    background: active ? C.hover : 'transparent',
                    // AP-ANN-10 / E24: off-screen items skip layout and
                    // paint, so 500+ comments do not freeze the panel.
                    contentVisibility: 'auto', containIntrinsicSize: 'auto 90px',
                  }}
                  onClick={() => onSelect(a)}
                  // Keyboard users reach a comment the same way a click does.
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.target === e.currentTarget) onSelect(a);
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 12.5, color: C.text }}>
                      {mine ? 'You' : (a.author_name ?? 'An approver')}
                    </strong>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, textTransform: 'uppercase' }}>
                      {a.status === 'draft' ? 'Draft — only you can see this' : a.status}
                    </span>
                    {a.carried_from_id && (
                      <span style={{ fontSize: 10.5, color: C.muted }}>from an earlier version</span>
                    )}
                    {a.relocated === false && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: C.warning }}>
                        <AlertTriangle size={10} /> Location changed
                      </span>
                    )}
                  </div>
                  {a.selected_text && (
                    <p style={{
                      margin: '0 0 6px', paddingLeft: 8, fontSize: 12, color: C.muted,
                      borderLeft: `2px solid ${C.border}`, fontStyle: 'italic',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      “{a.selected_text}”
                    </p>
                  )}

                  {a.status === 'draft' && mine ? (
                    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <DraftEditor
                        thread={a}
                        autoFocus={active}
                        onDirty={markDirty}
                        onDiscard={discard}
                      />
                    </div>
                  ) : (
                    <p style={{ margin: 0, fontSize: 13, color: C.text, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                      {a.comment_text}
                    </p>
                  )}

                  {a.replies.map((r) => (
                    <div key={r.id} style={{ display: 'flex', gap: 6, marginTop: 6, paddingLeft: 6 }}>
                      <CornerDownRight size={12} style={{ color: C.muted, flexShrink: 0, marginTop: 3 }} />
                      <p style={{ margin: 0, fontSize: 12.5, color: C.text, whiteSpace: 'pre-wrap' }}>
                        <strong>{r.author_name ?? 'Someone'}:</strong> {r.body}
                      </p>
                    </div>
                  ))}

                  {a.status !== 'draft' && (
                    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                    <div
                      style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {reply?.id === a.id ? (
                        <div style={{ width: '100%' }}>
                          <textarea
                            value={reply.text}
                            autoFocus
                            rows={2}
                            maxLength={2000}
                            onChange={(e) => setReply({ id: a.id, text: e.target.value })}
                            aria-label="Reply"
                            style={{
                              width: '100%', boxSizing: 'border-box', padding: '6px 8px',
                              background: 'var(--bg-base)', border: `1px solid ${C.border}`,
                              borderRadius: 8, color: C.text, fontSize: 12.5,
                            }}
                          />
                          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                            <button className="btn btn-primary" onClick={sendReply}>Reply</button>
                            <button className="btn btn-secondary" onClick={() => setReply(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <button className="btn btn-secondary" onClick={() => setReply({ id: a.id, text: '' })}>
                          Reply
                        </button>
                      )}
                      {/* Only the author resolves; the server enforces it. */}
                      {mine && a.status !== 'resolved' && (
                        <button className="btn btn-secondary" onClick={() => setStatus(a.id, 'resolved')}>
                          <CheckCheck size={13} /> Resolve
                        </button>
                      )}
                      {mine && a.status === 'resolved' && (
                        <button className="btn btn-secondary" onClick={() => setStatus(a.id, 'open')}>
                          <Undo2 size={13} /> Reopen
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default CommentsPanel;
