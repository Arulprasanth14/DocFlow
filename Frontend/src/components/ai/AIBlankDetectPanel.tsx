/**
 * DocFlow — AI blank detection for an imported document (spec FR-9.3/9.4).
 *
 * Shows every gap the model thinks a person is meant to fill in, each with a
 * confidence band, and converts NOTHING until the author ticks it and presses
 * Apply. High-confidence items start ticked because that is the common case;
 * Medium and Low start unticked, so a guess is never applied by inertia.
 *
 * Anything whose snippet is not literally present in the document was already
 * dropped server-side, so every row here points at real text.
 */
import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Loader2, RotateCcw, X } from 'lucide-react';
import { ConfidenceBadge } from './ConfidenceBadge';
import type { DetectedBlank, Confidence } from '@/lib/api/ai';

export interface AIBlankDetectPanelProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  blanks: DetectedBlank[];
  truncated: boolean;
  onApply: (chosen: DetectedBlank[]) => void;
  onDismiss: () => void;
  onRetry: () => void;
}

const ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

export function AIBlankDetectPanel({
  open, loading, error, blanks, truncated, onApply, onDismiss, onRetry,
}: AIBlankDetectPanelProps) {
  const sorted = useMemo(
    () => [...blanks].sort((a, b) => ORDER[a.confidence] - ORDER[b.confidence]),
    [blanks],
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Only "high" is pre-selected. A medium or low guess the author never
    // looked at must not end up in their template.
    setPicked(new Set(blanks.filter((b) => b.confidence === 'high').map((b) => b.key)));
  }, [blanks]);

  if (!open) return null;

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const chosen = sorted.filter((b) => picked.has(b.key));

  return (
    <section
      aria-label="Blanks found by AI"
      style={{
        marginTop: 14, border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', background: 'var(--card-solid)', overflow: 'hidden',
      }}
    >
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          fontSize: '0.84rem', fontWeight: 700, color: 'var(--foreground)',
        }}>
          <Sparkles size={15} style={{ color: 'var(--accent-violet)' }} aria-hidden="true" />
          Blanks found by AI
        </span>
        <button type="button" onClick={onDismiss} className="btn btn-ghost btn-sm" aria-label="Close">
          <X size={14} />
        </button>
      </header>

      <div style={{ padding: 14 }}>
        {loading && (
          <p style={{
            display: 'flex', alignItems: 'center', gap: 8, margin: 0,
            fontSize: '0.86rem', color: 'var(--muted-foreground)',
          }}>
            <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
            Reading the document…
          </p>
        )}

        {!loading && error && (
          <div role="alert">
            <p style={{ margin: '0 0 10px', fontSize: '0.86rem' }}>{error}</p>
            <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm">
              <RotateCcw size={13} /> Try again
            </button>
          </div>
        )}

        {!loading && !error && sorted.length === 0 && (
          <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--muted-foreground)' }}>
            No obvious blanks were found. Add them yourself with{' '}
            <strong>Insert blank</strong>, or by typing <code>___</code>.
          </p>
        )}

        {!loading && !error && sorted.length > 0 && (
          <>
            {truncated && (
              <p style={{
                margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--muted-foreground)',
              }}>
                This document was too long to read in full — only the beginning was scanned.
              </p>
            )}

            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {sorted.map((b) => (
                <li key={b.key}>
                  <label
                    // The visible text sits in children further down, so
                    // the accessible name is stated here rather than left
                    // to whatever renders first.
                    aria-label={`Use the blank ${b.label || b.key}`}
                    style={{
                    display: 'flex', gap: 10, alignItems: 'flex-start',
                    padding: '9px 11px', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)', cursor: 'pointer',
                    background: picked.has(b.key) ? 'var(--secondary)' : 'transparent',
                  }}>
                    <input
                      type="checkbox"
                      checked={picked.has(b.key)}
                      onChange={() => toggle(b.key)}
                      style={{ marginTop: 3 }}
                    />
                    <span style={{ display: 'grid', gap: 3, minWidth: 0, flex: 1 }}>
                      <span style={{
                        display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
                      }}>
                        <span style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--foreground)' }}>
                          {b.label}
                        </span>
                        <ConfidenceBadge level={b.confidence} compact />
                      </span>
                      <span style={{
                        fontSize: '0.76rem', color: 'var(--muted-foreground)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        Replaces: <code>{b.snippet}</code>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>

            <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => onApply(chosen)}
                disabled={chosen.length === 0}
                className="btn btn-primary btn-sm"
              >
                Add {chosen.length} blank{chosen.length === 1 ? '' : 's'}
              </button>
              <button type="button" onClick={onDismiss} className="btn btn-ghost btn-sm">
                Not now
              </button>
              <span style={{
                marginLeft: 'auto', fontSize: '0.74rem', color: 'var(--muted-foreground)',
              }}>
                Nothing changes until you add them.
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default AIBlankDetectPanel;
