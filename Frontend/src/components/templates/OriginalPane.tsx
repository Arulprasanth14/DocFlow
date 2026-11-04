/**
 * OriginalPane — the uploaded file, shown beside what the import made of it
 * (FR-9.7).
 *
 * The point of this panel is to let someone check fidelity, which means it has
 * to be honest about what it is showing:
 *
 *   PDF   The real file, in the browser's own PDF viewer. What you see is the
 *         document, so a missing table or a dropped heading is visible.
 *   Other A DOCX, ODT or RTF cannot be rendered by a browser, and converting
 *         it a second time in JavaScript would only show the same conversion
 *         twice — which is worth nothing as a check. So the extracted text is
 *         shown, labelled as extracted text, with a download for the file
 *         itself. Overstating this ("Original") would be the dishonest option.
 *
 * The file is fetched through a short-lived presigned URL requested on open,
 * never a URL stored in the document — the same rule the editor's images
 * follow.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Download, ExternalLink, FileText, Loader2 } from 'lucide-react';
import filesApi from '@/lib/api/files';

export interface OriginalPaneProps {
  /** FileAsset id of the uploaded original; null for a job that predates it. */
  fileAssetId: string | null | undefined;
  filename: string;
  /** 'pdf' | 'docx' | 'odt' | 'rtf' | 'txt' — what the importer read it as. */
  sourceKind: string;
  /** The extracted plain text, used for every format a browser cannot render. */
  text: string;
}

export function OriginalPane({ fileAssetId, filename, sourceKind, text }: OriginalPaneProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /** Only a PDF is worth embedding; everything else uses the link. */
  const embeddable = sourceKind === 'pdf';

  useEffect(() => {
    if (!fileAssetId) return;
    let alive = true;
    setLoading(true);
    setError('');
    filesApi
      .assetDownloadUrl(fileAssetId)
      .then((res) => { if (alive) setUrl(res.download_url); })
      .catch(() => { if (alive) setError('The original could not be opened.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [fileAssetId]);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%',
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--card-solid)', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid var(--border)', background: 'var(--muted)',
      }}>
        <FileText size={14} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
        <span style={{
          fontSize: '0.8rem', fontWeight: 600, color: 'var(--foreground)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{filename}</span>
        {url && (
          <a
            href={url} target="_blank" rel="noreferrer"
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 'auto', fontSize: '0.75rem', padding: '2px 8px' }}
          >
            {embeddable ? <ExternalLink size={12} /> : <Download size={12} />}
            {embeddable ? 'Open' : 'Download'}
          </a>
        )}
      </div>

      {!fileAssetId ? (
        <p style={{ margin: 0, padding: '14px 12px', fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
          This import did not keep a copy of the original.
        </p>
      ) : loading ? (
        <p style={{
          display: 'flex', alignItems: 'center', gap: 8, margin: 0, padding: '14px 12px',
          fontSize: '0.8rem', color: 'var(--muted-foreground)',
        }}>
          <Loader2 size={13} className="spin" /> Opening the original&hellip;
        </p>
      ) : error ? (
        <p style={{
          display: 'flex', alignItems: 'center', gap: 8, margin: 0, padding: '14px 12px',
          fontSize: '0.8rem', color: 'var(--status-rejected)',
        }}>
          <AlertTriangle size={13} /> {error}
        </p>
      ) : embeddable && url ? (
        <iframe
          src={url}
          title={`Original: ${filename}`}
          style={{ flex: 1, minHeight: 420, width: '100%', border: 'none', background: 'var(--muted)' }}
        />
      ) : (
        <>
          <p style={{
            display: 'flex', gap: 8, margin: 0, padding: '10px 12px',
            borderBottom: '1px solid var(--border)',
            fontSize: '0.76rem', color: 'var(--muted-foreground)',
          }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, color: 'var(--status-pending)' }} />
            {/* Say what this is, not what we wish it were. */}
            This is the text extracted from the file, not the file itself &mdash;
            a browser cannot display a Word or OpenDocument file. Download it to
            compare the formatting.
          </p>
          <pre style={{
            flex: 1, minHeight: 320, margin: 0, padding: '12px',
            overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontFamily: 'var(--font-mono)', fontSize: '0.76rem', lineHeight: 1.65,
            color: 'var(--foreground)', background: 'var(--card-solid)',
          }}>{text || 'No text was extracted.'}</pre>
        </>
      )}
    </div>
  );
}

export default OriginalPane;
