/**
 * DocFlow — confidence and severity labels for AI output (spec §23).
 *
 * Every AI suggestion in the product is labelled High / Medium / Low, in
 * words as well as colour, so the label survives colour-blindness and
 * greyscale. The wording is fixed here rather than at each call site: a
 * "Low confidence" suggestion must never be presented as anything else.
 */
import { Sparkles } from 'lucide-react';

export type Confidence = 'high' | 'medium' | 'low';

const CONFIDENCE_STYLE: Record<Confidence, { label: string; fg: string; bg: string }> = {
  high: { label: 'High confidence', fg: 'var(--status-approved)', bg: 'var(--status-approved-bg)' },
  medium: { label: 'Medium confidence', fg: 'var(--status-pending)', bg: 'var(--status-pending-bg)' },
  low: { label: 'Low confidence', fg: 'var(--muted-foreground)', bg: 'var(--secondary)' },
};

export function ConfidenceBadge({ level, compact }: { level: Confidence; compact?: boolean }) {
  const s = CONFIDENCE_STYLE[level] ?? CONFIDENCE_STYLE.low;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: compact ? '1px 6px' : '2px 8px',
        borderRadius: 'var(--radius-pill)',
        fontSize: compact ? '0.68rem' : '0.72rem',
        fontWeight: 600, color: s.fg, background: s.bg, whiteSpace: 'nowrap',
      }}
    >
      {compact ? s.label.replace(' confidence', '') : s.label}
    </span>
  );
}

const SEVERITY_STYLE: Record<Confidence, { label: string; fg: string; bg: string }> = {
  high: { label: 'Likely to be rejected', fg: 'var(--status-rejected)', bg: 'var(--status-rejected-bg)' },
  medium: { label: 'Should fix', fg: 'var(--status-pending)', bg: 'var(--status-pending-bg)' },
  low: { label: 'Worth a look', fg: 'var(--muted-foreground)', bg: 'var(--secondary)' },
};

export function SeverityBadge({ level }: { level: Confidence }) {
  const s = SEVERITY_STYLE[level] ?? SEVERITY_STYLE.low;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '2px 8px', borderRadius: 'var(--radius-pill)',
      fontSize: '0.72rem', fontWeight: 600, color: s.fg, background: s.bg,
      whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

/**
 * Marks a surface as AI-produced. The spec requires AI content to be
 * distinguishable from the author's own (§5.4), and a consistent mark is how
 * that stays true as these features spread across pages.
 */
export function AIBadge({ children }: { children?: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: '0.72rem', fontWeight: 600, color: 'var(--accent-violet)',
    }}>
      <Sparkles size={13} aria-hidden="true" />
      {children ?? 'AI suggestion'}
    </span>
  );
}

export default ConfidenceBadge;
