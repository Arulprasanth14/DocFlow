/**
 * DocFlow — template version history and restore (spec FR-14.8).
 *
 * Restore COPIES an old version forward into the working draft; it does not
 * rewind. That is worth saying in the UI, because the alternative reading —
 * "this deletes everything since v3" — would make people afraid to use it.
 * Documents already pinned to an older version are unaffected either way.
 */
import { useState } from 'react';
import { History, RotateCcw, Loader2, CheckCircle2, Pin } from 'lucide-react';
import { useTemplateVersions, useRestoreTemplateVersion } from '@/hooks/useTemplates';

export function TemplateVersionHistory({ templateId }: { templateId: string }) {
  const { data: versions = [], isLoading, isError, refetch } = useTemplateVersions(templateId);
  const restore = useRestoreTemplateVersion();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const run = (versionId: string, versionNo: number) => {
    restore.mutate(
      { templateId, versionId },
      {
        onSuccess: () => {
          setConfirming(null);
          setDone(versionNo);
        },
      },
    );
  };

  return (
    <section style={{ display: 'grid', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <History size={15} style={{ color: 'var(--muted-foreground)' }} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: '0.86rem', fontWeight: 700, color: 'var(--foreground)' }}>
          Version history
        </h3>
      </header>

      <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
        Restoring copies that version into your current draft. Nothing is
        deleted, and documents already built from an older version keep working.
      </p>

      {done != null && (
        <p role="status" style={{
          display: 'flex', alignItems: 'center', gap: 7, margin: 0,
          padding: '8px 10px', borderRadius: 'var(--radius-sm)',
          background: 'var(--status-approved-bg)', color: 'var(--status-approved-fg)',
          fontSize: '0.8rem',
        }}>
          <CheckCircle2 size={14} aria-hidden="true" />
          Version {done} is now your draft. Review it, then publish when ready.
        </p>
      )}

      {restore.isError && (
        <p role="alert" style={{ margin: 0, fontSize: '0.8rem', color: 'var(--status-rejected-fg)' }}>
          {restore.error instanceof Error ? restore.error.message : "That restore didn't work."}
        </p>
      )}

      {isLoading && (
        <div style={{ display: 'grid', gap: 6 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 44, borderRadius: 'var(--radius-sm)' }} />
          ))}
        </div>
      )}

      {isError && (
        <div>
          <p style={{ margin: '0 0 8px', fontSize: '0.82rem' }}>
            The history couldn&apos;t be loaded.
          </p>
          <button type="button" onClick={() => void refetch()} className="btn btn-secondary btn-sm">
            <RotateCcw size={13} /> Try again
          </button>
        </div>
      )}

      {!isLoading && !isError && versions.length === 0 && (
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--muted-foreground)' }}>
          No versions yet. Publishing this template creates the first one.
        </p>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {versions.map((v) => {
          const busy = restore.isPending && confirming === v.id;
          return (
            <li
              key={v.id}
              style={{
                padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                border: `1px solid ${v.is_current ? 'var(--primary)' : 'var(--border)'}`,
                background: 'var(--card-solid)', display: 'grid', gap: 7,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.86rem', fontWeight: 700, color: 'var(--foreground)' }}>
                  Version {v.version_no}
                </span>
                {v.is_current && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '1px 7px', borderRadius: 'var(--radius-pill)',
                    background: 'var(--status-approved-bg)', color: 'var(--status-approved-fg)',
                    fontSize: '0.68rem', fontWeight: 600,
                  }}>
                    <Pin size={10} aria-hidden="true" /> In use
                  </span>
                )}
                {!v.is_published && (
                  <span style={{
                    padding: '1px 7px', borderRadius: 'var(--radius-pill)',
                    background: 'var(--secondary)', color: 'var(--muted-foreground)',
                    fontSize: '0.68rem', fontWeight: 600,
                  }}>Draft</span>
                )}
                <span style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)', marginLeft: 'auto' }}>
                  {v.field_count} question{v.field_count === 1 ? '' : 's'}
                  {' · '}
                  {new Date(v.published_at ?? v.created_at).toLocaleDateString()}
                </span>
              </div>

              {confirming === v.id ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--foreground)' }}>
                    Copy version {v.version_no} into your draft?
                  </span>
                  <button type="button" onClick={() => run(v.id, v.version_no)}
                    disabled={busy} className="btn btn-primary btn-sm">
                    {busy
                      ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} />
                      : <RotateCcw size={13} />}
                    Restore
                  </button>
                  <button type="button" onClick={() => setConfirming(null)}
                    disabled={busy} className="btn btn-ghost btn-sm">
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(v.id)}
                  className="btn btn-ghost btn-sm"
                  style={{ justifySelf: 'start', fontSize: '0.76rem' }}
                >
                  <RotateCcw size={13} /> Restore this version
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default TemplateVersionHistory;
