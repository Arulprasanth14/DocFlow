/**
 * DocFlow — what is blocking this step, and where to fix it (spec §25.4).
 *
 * A blocked Continue used to be a disabled button: correct, but silent about
 * which of a dozen fields was wrong. This lists every problem the server
 * named and gives each one a link that focuses the field it belongs to, so
 * "fix this" is one keystroke rather than a hunt.
 *
 * Field names come from the server ("title", "expires_at", "answer:salary").
 * The caller supplies the map from name to element id; anything unmapped
 * still shows its message, just without a link — a new server-side rule can
 * never produce a dead link.
 */
import { AlertTriangle, Info } from 'lucide-react';
import type { FieldProblem } from '@/types';

export interface ValidationSummaryProps {
  errors: FieldProblem[];
  /** Shown in a calmer tone; these never block. */
  warnings?: FieldProblem[];
  /** field name → the id of the control to focus. */
  fieldIds?: Record<string, string>;
  title?: string;
}

function focusField(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Focus after the scroll starts; focusing first makes the browser jump.
  setTimeout(() => {
    (el as HTMLElement).focus({ preventScroll: true });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
  }, 120);
}

export function ValidationSummary({
  errors, warnings = [], fieldIds = {}, title,
}: ValidationSummaryProps) {
  if (errors.length === 0 && warnings.length === 0) return null;

  const heading = title
    ?? (errors.length === 1
      ? 'One thing to fix before you continue'
      : `${errors.length} things to fix before you continue`);

  return (
    <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
      {errors.length > 0 && (
        <div role="alert" style={{
          padding: '12px 14px', borderRadius: 'var(--radius)',
          background: 'var(--status-rejected-bg)',
          border: '1px solid color-mix(in srgb, var(--status-rejected) 28%, transparent)',
        }}>
          <p style={{
            margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8,
            fontSize: '0.84rem', fontWeight: 700, color: 'var(--status-rejected)',
          }}>
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            {heading}
          </p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
            {errors.map((e) => {
              const targetId = fieldIds[e.field];
              return (
                <li key={`${e.field}-${e.code}`} style={{
                  display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8,
                  fontSize: '0.82rem', color: 'var(--foreground)',
                }}>
                  <span>{e.message}</span>
                  {targetId && (
                    <button
                      type="button"
                      onClick={() => focusField(targetId)}
                      style={{
                        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                        fontFamily: 'var(--font-sans)', fontSize: '0.8rem', fontWeight: 700,
                        color: 'var(--status-rejected)', textDecoration: 'underline',
                      }}
                    >
                      Fix this
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div role="status" style={{
          padding: '10px 14px', borderRadius: 'var(--radius)',
          background: 'var(--status-pending-bg)',
          border: '1px solid color-mix(in srgb, var(--status-pending) 25%, transparent)',
        }}>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
            {warnings.map((w) => (
              <li key={`${w.field}-${w.code}`} style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                fontSize: '0.82rem', color: 'var(--status-pending-fg)',
              }}>
                <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{w.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Pull the per-field breakdown out of a thrown ApiClientError. */
export function fieldProblemsOf(err: unknown): FieldProblem[] {
  const fields = (err as { fields?: FieldProblem[] } | null)?.fields;
  return Array.isArray(fields) ? fields : [];
}

export default ValidationSummary;
