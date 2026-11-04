/**
 * DocFlow — the submitted document as a PDF (spec FR-13.8).
 *
 * Shows the immutable snapshot's render state: Preparing / Download / Retry.
 * The wording is careful about what the artefact is — this is the document as
 * it was submitted, not the document as it stands now, and the checksum is
 * what makes that claim checkable.
 *
 * Absent entirely for a draft (no snapshot) and on a deployment that has not
 * applied the PDF migration, rather than showing a control that cannot work.
 */
import { FileDown, Loader2, RotateCcw, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useDocumentPdf, useRetryDocumentPdf } from '@/hooks/useDocuments';

export function SnapshotPdfCard({ docId }: { docId: string }) {
  const { data, isLoading } = useDocumentPdf(docId);
  const retry = useRetryDocumentPdf();

  // Nothing to say yet, or nothing to say at all.
  if (isLoading || !data) return null;
  if (!data.available || !data.has_snapshot) return null;

  const status = data.status;

  return (
    <section
      aria-label="Submitted PDF"
      style={{
        marginTop: 16, padding: '14px 16px',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        background: 'var(--card-solid)', display: 'grid', gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ShieldCheck size={16} style={{ color: 'var(--status-approved)' }} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: '0.88rem', fontWeight: 700, color: 'var(--foreground)' }}>
          Submitted document
        </h3>
      </div>

      <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
        A fixed copy of this document exactly as it was submitted. Later edits to
        the template it came from cannot change it.
      </p>

      {status === 'pending' && (
        <p style={{
          display: 'flex', alignItems: 'center', gap: 8, margin: 0,
          fontSize: '0.84rem', color: 'var(--muted-foreground)',
        }} aria-live="polite">
          <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} aria-hidden="true" />
          Preparing PDF…
        </p>
      )}

      {status === 'ready' && data.download_url && (
        <>
          <a
            href={data.download_url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
            style={{ justifySelf: 'start' }}
          >
            <FileDown size={14} /> Download PDF
          </a>
          {data.checksum && (
            <p style={{
              margin: 0, fontSize: '0.72rem', color: 'var(--muted-foreground)',
              fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all',
            }}>
              SHA-256 {data.checksum}
            </p>
          )}
        </>
      )}

      {status === 'failed' && (
        <div role="alert" style={{ display: 'grid', gap: 8 }}>
          <p style={{
            display: 'flex', gap: 7, alignItems: 'flex-start', margin: 0,
            fontSize: '0.84rem', color: 'var(--status-rejected-fg)',
          }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <span>
              The PDF couldn&apos;t be prepared.
              {data.error ? ` ${data.error}` : ''}
              {' '}Your submission itself went through normally.
            </span>
          </p>
          <button
            type="button"
            onClick={() => retry.mutate(docId)}
            disabled={retry.isPending}
            className="btn btn-secondary btn-sm"
            style={{ justifySelf: 'start' }}
          >
            {retry.isPending
              ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
              : <RotateCcw size={14} />}
            Try again
          </button>
        </div>
      )}

      {status == null && (
        <button
          type="button"
          onClick={() => retry.mutate(docId)}
          disabled={retry.isPending}
          className="btn btn-secondary btn-sm"
          style={{ justifySelf: 'start' }}
        >
          {retry.isPending
            ? <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
            : <FileDown size={14} />}
          Prepare PDF
        </button>
      )}
    </section>
  );
}

export default SnapshotPdfCard;
