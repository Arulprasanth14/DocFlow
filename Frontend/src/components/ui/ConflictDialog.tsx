/**
 * ConflictDialog — autosave version conflict (spec §24.3). Shown when a draft
 * was changed in another tab/device (server returned 409 VERSION_CONFLICT).
 * "Compare" is a Could-have and omitted for now.
 */
import { AlertTriangle } from 'lucide-react';

export function ConflictDialog({ open, onKeepMine, onLoadLatest, busy }: {
  open: boolean;
  onKeepMine: () => void;
  onLoadLatest: () => void;
  busy?: boolean;
}) {
  if (!open) return null;
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', backdropFilter: 'blur(4px)', zIndex: 300 }} />
      <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '100%', maxWidth: 460, zIndex: 301 }}>
        <div className="glass-card" style={{ padding: 28 }} role="alertdialog" aria-modal="true" aria-labelledby="conflict-title">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{
              width: 36, height: 36, borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--status-pending-bg)', color: 'var(--status-pending)', flexShrink: 0,
            }}><AlertTriangle size={18} /></span>
            <h3 id="conflict-title" style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)', margin: 0 }}>
              This draft changed elsewhere
            </h3>
          </div>
          <p style={{ fontSize: '0.88rem', color: 'var(--muted-foreground)', lineHeight: 1.5, margin: '0 0 20px' }}>
            This draft was changed in another tab or device. Keep your version to overwrite it, or load
            the latest and discard your unsaved changes here.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <button className="btn btn-secondary" onClick={onLoadLatest} disabled={busy}>Load latest</button>
            <button className="btn btn-primary" onClick={onKeepMine} disabled={busy}>Keep my version</button>
          </div>
        </div>
      </div>
    </>
  );
}

export default ConflictDialog;
