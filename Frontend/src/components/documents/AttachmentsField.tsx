/**
 * DocFlow — supporting attachments on a draft (spec FR-13.4).
 *
 * Self-contained: it uploads the file, links it to the document, lists what is
 * already there and removes one. The wizard's Details step mounts it so a
 * submitter can attach evidence before submitting rather than having to
 * submit first and attach afterwards.
 *
 * The upload is two steps server-side (presign, then confirm + scan), and the
 * confirm step is where the file is actually checked. That is why nothing is
 * linked to the document until the upload has fully resolved: a rejected file
 * must leave no attachment row behind.
 */
import { useRef, useState } from 'react';
import { Paperclip, Upload, X, Loader2, FileText, AlertCircle } from 'lucide-react';
import {
  useDocumentAttachments,
  useAddDocumentAttachment,
  useRemoveDocumentAttachment,
  useUploadFile,
} from '@/hooks/useDocuments';

/** Matches Backend/app/core/storage.py MAX_FILE_SIZE_BYTES. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Mirrors the server's allow-list. Checking here is a courtesy that saves a
 * doomed upload — the server checks magic bytes and is the real gate, so this
 * list being wrong can only ever be a worse error message, never a bypass.
 */
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
  'text/plain',
  'text/csv',
]);

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.tiff,.webp,.txt,.csv';

function prettySize(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface AttachmentsFieldProps {
  docId: string;
  /** Locked once the document is no longer a draft. */
  disabled?: boolean;
}

export function AttachmentsField({ docId, disabled = false }: AttachmentsFieldProps) {
  const { data: attachments = [], isLoading } = useDocumentAttachments(docId);
  const addAtt = useAddDocumentAttachment();
  const removeAtt = useRemoveDocumentAttachment();
  const uploadFile = useUploadFile();

  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (picked: File | null) => {
    setError('');
    if (!picked) { setFile(null); return; }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setError(`That file is ${prettySize(picked.size)}. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
      setFile(null);
      return;
    }
    if (!ALLOWED_MIME_TYPES.has(picked.type)) {
      setError(`${picked.type || 'That file type'} can't be attached.`);
      setFile(null);
      return;
    }
    setFile(picked);
  };

  const attach = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const fileAssetId = await uploadFile.mutateAsync(file);
      await addAtt.mutateAsync({
        docId,
        data: { file_asset_id: fileAssetId, label: label.trim() || undefined },
      });
      setFile(null);
      setLabel('');
      // The hidden input keeps the old selection otherwise, so picking the
      // same file again would not fire a change event.
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file couldn't be attached.");
    } finally {
      setBusy(false);
    }
  };

  const drop = async (id: string) => {
    setRemoving(id);
    setError('');
    try {
      await removeAtt.mutateAsync({ docId, attId: id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That attachment couldn't be removed.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section style={{ display: 'grid', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Paperclip size={14} style={{ color: 'var(--muted-foreground)' }} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: 'var(--foreground)' }}>
          Supporting attachments
        </h3>
        <span style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>
          Optional
        </span>
      </header>

      {isLoading && (
        <div className="skeleton" style={{ height: 40, borderRadius: 'var(--radius-sm)' }} />
      )}

      {!isLoading && attachments.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {attachments.map((att) => (
            <li
              key={att.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)', background: 'var(--card-solid)',
              }}
            >
              <FileText size={15} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} aria-hidden="true" />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{
                  display: 'block', fontSize: '0.82rem', fontWeight: 600,
                  color: 'var(--foreground)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {att.label || att.filename || 'Attached file'}
                </span>
                <span style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>
                  {[att.mime_type, prettySize(att.size_bytes)].filter(Boolean).join(' · ')}
                </span>
              </span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => void drop(att.id)}
                  disabled={removing === att.id}
                  className="btn btn-ghost btn-sm"
                  aria-label={`Remove ${att.label || att.filename || 'attachment'}`}
                  style={{ padding: '3px 6px', flexShrink: 0 }}
                >
                  {removing === att.id
                    ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} />
                    : <X size={13} />}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!isLoading && attachments.length === 0 && (
        <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
          Nothing attached yet.
        </p>
      )}

      {!disabled && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label
            style={{
              display: 'flex', alignItems: 'center', gap: 9,
              padding: file ? '9px 11px' : '14px 11px',
              borderRadius: 'var(--radius)',
              border: `1px ${file ? 'solid' : 'dashed'} var(--border)`,
              background: file ? 'var(--card-solid)' : 'transparent',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {/* The raw input is visually hidden: "Choose File / No file chosen"
                is unstyleable and ignores the design system. */}
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              disabled={busy}
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
              style={{
                position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
                overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
              }}
            />
            <Upload size={15} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} aria-hidden="true" />
            <span style={{ fontSize: '0.82rem', color: file ? 'var(--foreground)' : 'var(--muted-foreground)' }}>
              {file ? file.name : 'Choose a file to attach'}
            </span>
            {file && (
              <span style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)', marginLeft: 'auto' }}>
                {prettySize(file.size)}
              </span>
            )}
          </label>

          {file && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input"
                value={label}
                placeholder="Label (optional)"
                aria-label="Attachment label"
                onChange={(e) => setLabel(e.target.value)}
                style={{ flex: 1, minWidth: 140, fontSize: '0.82rem' }}
              />
              <button
                type="button"
                onClick={() => void attach()}
                disabled={busy}
                className="btn btn-secondary btn-sm"
              >
                {busy
                  ? <><Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> Uploading…</>
                  : <>Attach</>}
              </button>
              <button
                type="button"
                onClick={() => { setFile(null); setLabel(''); if (inputRef.current) inputRef.current.value = ''; }}
                disabled={busy}
                className="btn btn-ghost btn-sm"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: 6, margin: 0,
          fontSize: '0.78rem', color: 'var(--status-rejected-fg)',
        }}>
          <AlertCircle size={13} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
          {error}
        </p>
      )}
    </section>
  );
}

export default AttachmentsField;
