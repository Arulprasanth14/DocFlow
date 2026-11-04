/**
 * DocFlow — export a document as PDF or DOCX (spec FR-6.7).
 *
 * A submitted document exports its frozen snapshot; a draft exports what is
 * currently written and the PDF is watermarked DRAFT. That distinction is
 * made on the server — this menu only asks for a format.
 */
import { useEffect, useRef, useState } from 'react';
import { Download, FileText, FileType, Loader2 } from 'lucide-react';
import { documentsApi } from '@/lib/api/documents';
import { saveBlob } from '@/lib/api/client';

type Format = 'pdf' | 'docx';

export function ExportMenu({ docId, disabled }: { docId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = async (format: Format) => {
    setBusy(format);
    setError(null);
    try {
      const { blob, filename } = await documentsApi.exportDocument(docId, format);
      saveBlob(blob, filename);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That export didn't work.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={wrap} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busy
          ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
          : <Download size={14} />}
        Export
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 20,
            minWidth: 190, padding: 6, borderRadius: 'var(--radius)',
            border: '1px solid var(--border)', background: 'var(--card-solid)',
            boxShadow: 'var(--shadow-lg)', display: 'grid', gap: 2,
          }}
        >
          <MenuItem icon={<FileText size={14} />} label="PDF" hint="Best for sharing and printing"
            busy={busy === 'pdf'} onClick={() => void run('pdf')} />
          <MenuItem icon={<FileType size={14} />} label="Word (.docx)" hint="Editable in Word"
            busy={busy === 'docx'} onClick={() => void run('docx')} />
        </div>
      )}

      {error && (
        <p role="alert" style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 21,
          margin: 0, padding: '8px 10px', minWidth: 200,
          borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
          background: 'var(--card-solid)', fontSize: '0.78rem',
          color: 'var(--status-rejected-fg)',
        }}>{error}</p>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint, busy, onClick }: {
  icon: React.ReactNode; label: string; hint: string; busy: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={busy}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%',
        padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: 'none',
        background: 'transparent', cursor: busy ? 'default' : 'pointer',
        textAlign: 'left', color: 'var(--foreground)',
      }}
      className="glass-interactive"
    >
      <span style={{ marginTop: 2, color: 'var(--muted-foreground)' }}>
        {busy ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} /> : icon}
      </span>
      <span style={{ display: 'grid', gap: 1 }}>
        <span style={{ fontSize: '0.84rem', fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>{hint}</span>
      </span>
    </button>
  );
}

export default ExportMenu;
