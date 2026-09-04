/**
 * DocFlow Frontend — Tab Count Badge
 * Reusable pill badge for displaying counts inside tabs.
 * Prevents text concatenation (e.g. "Pending5" -> "Pending 5") by using a distinct pill.
 */

export default function TabCountBadge({ count, active }: { count: number; active: boolean }) {
  if (count === 0) return null; // Or render a zero if preferred, but usually empty is cleaner

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 20,
        height: 20,
        padding: '0 6px',
        borderRadius: 9999,
        fontSize: '0.75rem',
        fontWeight: 700,
        background: active ? 'var(--color-primary-500)' : 'var(--bg-overlay)',
        color: active ? 'white' : 'var(--text-secondary)',
        marginLeft: 8,
        transition: 'all 150ms ease',
      }}
    >
      {count}
    </span>
  );
}
