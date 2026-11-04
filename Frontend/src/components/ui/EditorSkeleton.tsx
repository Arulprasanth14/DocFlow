/**
 * DocFlow — the editor frame, before there is anything to put in it.
 *
 * Shown the instant someone chooses "Blank document" or "Create from
 * scratch", while the draft is created and the editor chunk downloads. It is
 * deliberately the SHAPE of the editor — title field, toolbar, page — rather
 * than a spinner or a "Preparing…" message, so the screen the author lands on
 * is the one they asked for and nothing jumps when the real editor replaces
 * it.
 */
import { prefersReducedMotion } from '@/lib/motion/prefersReducedMotion';

const LINES = [92, 74, 86, 60, 0, 88, 70, 81, 46];

export function EditorSkeleton({ label = 'Opening the editor' }: { label?: string }) {
  const reduced = prefersReducedMotion();
  return (
    <div
      className="page-content"
      style={{ paddingTop: 24, maxWidth: 1000, margin: '0 auto' }}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {/* Breadcrumb + heading */}
      <div className="skeleton" style={{ width: 140, height: 14, borderRadius: 'var(--radius-pill)', marginBottom: 14 }} />
      <div className="skeleton" style={{ width: 260, height: 26, borderRadius: 'var(--radius)', marginBottom: 20 }} />

      {/* Title input */}
      <div className="skeleton" style={{ width: '100%', maxWidth: 520, height: 40, borderRadius: 'var(--radius)', marginBottom: 12 }} />

      {/* Toolbar */}
      <div style={{
        display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 10px', marginBottom: 14,
        border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--card-solid)',
      }}>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="skeleton" style={{ width: 28, height: 28, borderRadius: 'var(--radius)' }} />
        ))}
      </div>

      {/* The page */}
      <div style={{
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        background: 'var(--card-solid)', boxShadow: 'var(--shadow-sm)',
        padding: '44px 52px', display: 'grid', gap: 14,
      }}>
        {LINES.map((w, i) => (
          w === 0
            ? <div key={i} style={{ height: 6 }} />
            : (
              <div
                key={i}
                className="skeleton"
                style={{
                  width: `${w}%`, height: 13, borderRadius: 'var(--radius-pill)',
                  // Staggering reads as "loading" rather than "broken grid";
                  // with reduced motion the shimmer is off anyway, so the
                  // delay would only hold back a static bar.
                  animationDelay: reduced ? undefined : `${i * 70}ms`,
                }}
              />
            )
        ))}
      </div>

      <span className="sr-only">{label}…</span>
    </div>
  );
}

export default EditorSkeleton;
