/**
 * DocFlow — AI rewrite, shown as an accept/reject diff (spec FR-10.1-10.4).
 *
 * The hard rule this component exists to honour: AI NEVER APPLIES ITSELF.
 * The author sees their own text and the proposal side by side, with the
 * changes marked, and the document is not touched until they press Accept.
 * Rejecting is recorded too — a suggestion nobody took is the useful signal.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, RotateCcw, Loader2, AlertTriangle } from 'lucide-react';
import { ConfidenceBadge, AIBadge } from './ConfidenceBadge';
import type { RewriteSuggestion } from '@/lib/api/ai';

/**
 * Word-level diff via longest common subsequence.
 *
 * Hand-rolled rather than added as a dependency: rewrites are at most a few
 * thousand characters, so the quadratic table is tiny, and this keeps the
 * approved dependency list where it is.
 */
type Piece = { text: string; kind: 'same' | 'add' | 'del' };

function diffWords(before: string, after: string): Piece[] {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: Piece[] = [];
  const push = (text: string, kind: Piece['kind']) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(a[i], 'same'); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push(a[i], 'del'); i += 1; }
    else { push(b[j], 'add'); j += 1; }
  }
  while (i < n) { push(a[i], 'del'); i += 1; }
  while (j < m) { push(b[j], 'add'); j += 1; }
  return out;
}

export interface AIRewriteDialogProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  suggestion: RewriteSuggestion | null;
  /** Called with the text to insert. Only fires on Accept. */
  onAccept: (text: string) => void;
  onReject: () => void;
  onRetry: () => void;
}

export function AIRewriteDialog({
  open, loading, error, suggestion, onAccept, onReject, onRetry,
}: AIRewriteDialogProps) {
  const [view, setView] = useState<'diff' | 'result'>('diff');
  const panel = useRef<HTMLDivElement>(null);

  const pieces = useMemo(
    () => (suggestion ? diffWords(suggestion.original, suggestion.suggestion) : []),
    [suggestion],
  );

  // Escape closes; focus moves into the dialog so keyboard users aren't
  // stranded behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onReject(); };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onReject]);

  useEffect(() => { if (open) setView('diff'); }, [open, suggestion]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onReject}
          style={{
            position: 'fixed', inset: 0, zIndex: 70, background: 'var(--overlay-scrim)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
        >
          <motion.div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="AI rewrite suggestion"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}
            className="glass-card"
            style={{
              width: 'min(760px, 100%)', maxHeight: '86vh', display: 'flex',
              flexDirection: 'column', padding: 0, outline: 'none',
            }}
          >
            <header style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <AIBadge>Suggested rewrite</AIBadge>
                {suggestion && <ConfidenceBadge level={suggestion.confidence} />}
              </div>
              <button type="button" onClick={onReject} className="btn btn-ghost btn-sm" aria-label="Close">
                <X size={15} />
              </button>
            </header>

            <div style={{ padding: 18, overflowY: 'auto', flex: 1 }}>
              {loading && (
                <p style={{
                  display: 'flex', alignItems: 'center', gap: 8, margin: 0,
                  color: 'var(--muted-foreground)', fontSize: '0.9rem',
                }}>
                  <Loader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} />
                  Writing a suggestion…
                </p>
              )}

              {!loading && error && (
                <div role="alert">
                  <p style={{ margin: '0 0 12px', fontSize: '0.9rem', color: 'var(--foreground)' }}>
                    {error}
                  </p>
                  <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm">
                    <RotateCcw size={14} /> Try again
                  </button>
                </div>
              )}

              {!error && suggestion && (Boolean(suggestion.suggestion) || !loading) && (
                <>
                  {suggestion.warning && (
                    <p role="alert" style={{
                      display: 'flex', gap: 8, alignItems: 'flex-start',
                      margin: '0 0 14px', padding: '10px 12px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--status-rejected-bg)',
                      color: 'var(--status-rejected-fg)', fontSize: '0.84rem',
                    }}>
                      <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span>{suggestion.warning}</span>
                    </p>
                  )}

                  <div role="tablist" aria-label="View" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                    {(['diff', 'result'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="tab"
                        aria-selected={view === v}
                        onClick={() => setView(v)}
                        className={view === v ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm'}
                      >
                        {v === 'diff' ? 'Changes' : 'New version'}
                      </button>
                    ))}
                  </div>

                  <div style={{
                    padding: 14, borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)', background: 'var(--card-solid)',
                    fontSize: '0.92rem', lineHeight: 1.65, whiteSpace: 'pre-wrap',
                    color: 'var(--foreground)',
                  }}>
                    {view === 'result'
                      ? suggestion.suggestion
                      : pieces.map((p, idx) => (
                          <span
                            key={idx}
                            style={
                              p.kind === 'add'
                                ? { background: 'var(--status-approved-bg)', color: 'var(--status-approved-fg)' }
                                : p.kind === 'del'
                                  ? { background: 'var(--status-rejected-bg)', color: 'var(--status-rejected-fg)', textDecoration: 'line-through' }
                                  : undefined
                            }
                          >{p.text}</span>
                        ))}
                  </div>

                  {suggestion.note && (
                    <p style={{
                      margin: '12px 0 0', fontSize: '0.82rem', color: 'var(--muted-foreground)',
                    }}>{suggestion.note}</p>
                  )}
                </>
              )}
            </div>

            <footer style={{
              display: 'flex', justifyContent: 'flex-end', gap: 8,
              padding: '12px 18px', borderTop: '1px solid var(--border)',
            }}>
              <button type="button" onClick={onReject} className="btn btn-ghost">
                Keep mine
              </button>
              <button
                type="button"
                onClick={() => suggestion && onAccept(suggestion.suggestion)}
                // FR-10.5: a rewrite that changed the blanks is shown but
                // never applied. Regenerate is the way forward, not Accept.
                disabled={!suggestion || loading || !!suggestion.blocked}
                title={suggestion?.blocked
                  ? 'This rewrite changed the blanks, so it can\u2019t be applied.'
                  : undefined}
                className="btn btn-primary"
              >
                <Check size={15} /> Use this
              </button>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default AIRewriteDialog;
