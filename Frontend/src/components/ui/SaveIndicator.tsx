/**
 * SaveIndicator — passive autosave status (spec §24.2). There is never a manual
 * "Save" button; this just reflects the current `SaveState` from `useAutosave`.
 */
import { Check, Loader2, Cloud, CloudOff, AlertTriangle, Dot } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import type { SaveState } from '@/hooks/useAutosave';

export function SaveIndicator({ state, lastSavedAt, onRetry }: {
  state: SaveState;
  lastSavedAt?: Date | null;
  onRetry?: () => void;
}) {
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    fontSize: '0.78rem', fontWeight: 600, color: 'var(--muted-foreground)',
  };

  if (state === 'saving') return <span style={base} aria-live="polite"><Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> Saving…</span>;
  if (state === 'offline') return <span style={{ ...base, color: 'var(--status-pending)' }} aria-live="polite"><CloudOff size={13} /> Offline — will sync</span>;
  if (state === 'error') return (
    <span style={{ ...base, color: 'var(--status-rejected)' }} aria-live="assertive">
      <AlertTriangle size={13} /> Couldn't save.
      {onRetry && <button onClick={onRetry} style={{ background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', padding: 0 }}>Retry</button>}
    </span>
  );
  if (state === 'unsaved') return <span style={base}><Dot size={16} style={{ margin: -4 }} /> Unsaved changes</span>;
  if (state === 'saved') return (
    <span style={{ ...base, color: 'var(--status-approved)' }} aria-live="polite">
      <Check size={13} /> Saved{lastSavedAt ? ` ${formatDistanceToNowStrict(lastSavedAt, { addSuffix: true })}` : ' just now'}
    </span>
  );
  return <span style={base}><Cloud size={13} /> All changes saved</span>;
}

export default SaveIndicator;
