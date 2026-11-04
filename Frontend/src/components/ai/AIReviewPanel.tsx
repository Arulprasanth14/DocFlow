/**
 * DocFlow — AI pre-submission review (spec FR-10.4 / FR-13.6).
 *
 * Advisory only, and the wording says so. Findings never block submission and
 * nothing is changed automatically: this is a second pair of eyes before the
 * document goes to an approver, not a gate.
 *
 * The author's verdict is recorded once, when they dismiss the panel or
 * submit past it, so the audit trail distinguishes "read and acted on" from
 * "read and disagreed".
 */
import { Sparkles, Loader2, RotateCcw, X, CheckCircle2 } from 'lucide-react';
import { SeverityBadge, ConfidenceBadge } from './ConfidenceBadge';
import type { ReviewFinding } from '@/lib/api/ai';

export interface AIReviewPanelProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  findings: ReviewFinding[];
  truncated: boolean;
  /** True once a result has arrived, so "no problems" isn't shown while idle. */
  hasResult: boolean;
  onDismiss: () => void;
  onRetry: () => void;
}

const ORDER = { high: 0, medium: 1, low: 2 } as const;

export function AIReviewPanel({
  open, loading, error, findings, truncated, hasResult, onDismiss, onRetry,
}: AIReviewPanelProps) {
  if (!open) return null;
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

  return (
    <section
      aria-label="AI review"
      aria-live="polite"
      style={{
        marginTop: 18, border: '1px solid var(--border)',
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
          AI review
        </span>
        <button type="button" onClick={onDismiss} className="btn btn-ghost btn-sm" aria-label="Close review">
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
            Reading your document…
          </p>
        )}

        {!loading && error && (
          <div role="alert">
            <p style={{ margin: '0 0 10px', fontSize: '0.86rem' }}>{error}</p>
            <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm">
              <RotateCcw size={13} /> Try again
            </button>
            <p style={{ margin: '10px 0 0', fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
              You can still submit — this review is optional.
            </p>
          </div>
        )}

        {!loading && !error && hasResult && sorted.length === 0 && (
          <p style={{
            display: 'flex', alignItems: 'center', gap: 8, margin: 0,
            fontSize: '0.86rem', color: 'var(--foreground)',
          }}>
            <CheckCircle2 size={16} style={{ color: 'var(--status-approved)' }} aria-hidden="true" />
            Nothing stood out. Check it yourself before submitting.
          </p>
        )}

        {!loading && !error && sorted.length > 0 && (
          <>
            {truncated && (
              <p style={{ margin: '0 0 10px', fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
                This document was too long to read in full — only the beginning was reviewed.
              </p>
            )}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
              {sorted.map((f, i) => (
                <li key={i} style={{
                  padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                }}>
                  <div style={{
                    display: 'flex', gap: 8, alignItems: 'center',
                    flexWrap: 'wrap', marginBottom: 6,
                  }}>
                    <SeverityBadge level={f.severity} />
                    <ConfidenceBadge level={f.confidence} compact />
                  </div>
                  <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--foreground)' }}>
                    {f.message}
                  </p>
                  {f.quote && (
                    <p style={{
                      margin: '6px 0 0', fontSize: '0.78rem', color: 'var(--muted-foreground)',
                      borderLeft: '2px solid var(--border)', paddingLeft: 8,
                    }}>“{f.quote}”</p>
                  )}
                </li>
              ))}
            </ul>
            <p style={{ margin: '12px 0 0', fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
              These are suggestions, not checks. Nothing here stops you submitting.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export default AIReviewPanel;
