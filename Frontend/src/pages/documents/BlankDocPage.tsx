/**
 * DocFlow — /documents/new/blank
 *
 * A redirect, not a destination. The hub's "Blank document" card creates the
 * draft itself and puts the editor frame up straight away, so nobody reaches
 * this route by clicking; it exists for bookmarks and old links, and does the
 * same thing — editor skeleton immediately, draft created behind it, then
 * replace the history entry with /documents/:id/edit.
 *
 * The previous version of this page showed a "Preparing your blank
 * document…" card for most of a second. There was nothing for the author to
 * do on it, so it was a wait dressed up as a screen.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, RotateCw } from 'lucide-react';

import { EditorSkeleton } from '@/components/ui/EditorSkeleton';
import { useStartBlankDocument } from '@/hooks/useStartDraft';

export default function BlankDocPage() {
  const navigate = useNavigate();
  const { start, error, blocked } = useStartBlankDocument();

  useEffect(() => { start(); }, [start]);

  if (blocked) {
    return (
      <div className="page-content" style={{ paddingTop: 48, maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <p style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--foreground)' }}>
          Blank documents aren&rsquo;t available yet
        </p>
        <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', marginBottom: 20 }}>{blocked}</p>
        <button className="btn btn-secondary" onClick={() => navigate('/documents/new')}>Back to hub</button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-content" style={{ paddingTop: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <span style={{
          width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)',
        }}><AlertTriangle size={22} /></span>
        <p role="alert" style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--status-rejected)', margin: 0 }}>{error}</p>
        <button className="btn btn-secondary btn-sm" onClick={start}><RotateCw size={13} /> Try again</button>
      </div>
    );
  }

  return <EditorSkeleton label="Opening your blank document" />;
}
