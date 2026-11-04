/**
 * UploadDropzone — animated upload with a full state machine (spec §8.3 FR-3.1/3.2,
 * §18 point 3): idle · drag-over · validating · uploading (real byte progress) ·
 * processing · success · error. Cancel is available until processing starts.
 *
 * The bytes go straight to object storage via the presigned PUT URL (XHR, so we
 * get progress events); on confirm the FileAsset row is created and its id is
 * handed back. AV scan / magic-byte checks are server-side.
 */
import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UploadCloud, FileText, X, Check, Pause, RotateCw, AlertTriangle } from 'lucide-react';
import filesApi from '@/lib/api/files';
import {
  RESUMABLE_MIN_BYTES,
  discardResumable,
  hasResumableSession,
  uploadResumable,
} from '@/lib/upload/resumableUpload';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'text/plain', 'text/csv',
]);

type State =
  | 'idle' | 'dragover' | 'validating' | 'uploading'
  /** FR-3.2 — parts already in storage, waiting for the user to continue. */
  | 'paused'
  | 'processing' | 'success' | 'error';

function putWithProgress(url: string, file: File, onProgress: (p: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

export function UploadDropzone({ onUploaded, onBusyChange }: {
  onUploaded: (fileAssetId: string, file: File) => void;
  /** Fires true while a file is uploading/processing (so a host dialog can
   *  guard click-outside / close). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [state, setState] = useState<State>('idle');
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  /** The server's own verdict on the file — never paraphrased here. */
  const [scan, setScan] = useState<{ label: string; detail: string | null; strong: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** FR-3.2 — part plan for a resumable upload, and the file it belongs to,
   *  kept so Resume can continue without the user picking the file again. */
  const [parts, setParts] = useState<{ total: number; already: number } | null>(null);
  const fileRef = useRef<File | null>(null);
  const resumedRef = useRef(false);

  const reset = () => {
    setState('idle'); setProgress(0); setFile(null); setError(''); setScan(null);
    setParts(null); fileRef.current = null; resumedRef.current = false;
    abortRef.current = null; onBusyChange?.(false);
  };

  const fail = (msg: string) => { setError(msg); setState('error'); onBusyChange?.(false); };

  /**
   * FR-3.2 — a file at or above RESUMABLE_MIN_BYTES is uploaded in parts, so a
   * dropped connection, a pause or a reload costs one part instead of the whole
   * file. It ends at the same /files/multipart/complete → confirm pass, so the
   * antivirus verdict and the FileAsset row are identical to a single PUT.
   */
  const runResumable = async (f: File) => {
    const ac = new AbortController();
    abortRef.current = ac;
    setFile(f); fileRef.current = f; setError(''); setState('uploading');
    onBusyChange?.(true);
    try {
      const confirmed = await uploadResumable(f, {
        signal: ac.signal,
        onProgress: (fraction) => {
          setProgress(fraction);
          // All parts are in; what is left is the server assembling and
          // checking them, which is the "processing" state the UI already has.
          if (fraction >= 1) setState('processing');
        },
        onParts: (info) => setParts({ total: info.total, already: info.alreadyUploaded }),
      });
      setScan({
        label: confirmed.scan_label,
        detail: confirmed.macros_removed
          ? 'Macros were removed from this file.'
          : confirmed.scan_detail ?? null,
        strong: confirmed.scan_status === 'clean',
      });
      setState('success');
      onBusyChange?.(false);
      setTimeout(() => onUploaded(confirmed.file_asset_id, f), 450);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Paused, not cancelled: the parts stay in storage and the session
        // stays on disk, so Resume continues from here.
        setState('paused');
        onBusyChange?.(false);
        return;
      }
      fail(err instanceof Error ? err.message : 'Upload failed.');
    }
  };

  /** Throw away a paused upload: discard the parts server-side, then reset. */
  const discardPaused = async () => {
    const f = fileRef.current;
    reset();
    if (f) await discardResumable(f);
  };

  const handleFile = async (f: File) => {
    setFile(f); setError(''); setState('validating'); onBusyChange?.(true);
    if (f.size > MAX_UPLOAD_BYTES) return fail(`This file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Upload a smaller file.`);
    if (f.size === 0) return fail('This file is empty.');
    if (!ALLOWED_MIME.has(f.type)) return fail("This file type isn't supported. Upload a DOCX or PDF.");

    // FR-3.2 — big files take the resumable path. Small ones keep the
    // single presigned PUT below: it is one round trip and there is
    // nothing worth resuming.
    if (f.size >= RESUMABLE_MIN_BYTES) {
      resumedRef.current = hasResumableSession(f);
      await runResumable(f);
      return;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const { upload_url, storage_key, bucket } = await filesApi.getUploadUrl(f.name, f.type, f.size);
      setState('uploading'); setProgress(0);
      await putWithProgress(upload_url, f, setProgress, ac.signal);
      setState('processing');
      const confirmed = await filesApi.confirmUpload({
        storage_key, bucket, filename: f.name, mime_type: f.type, size_bytes: f.size,
      });
      const { file_asset_id } = confirmed;
      setScan({
        label: confirmed.scan_label,
        detail: confirmed.macros_removed
          ? 'Macros were removed from this file.'
          // Optional in the OpenAPI schema (it has a server-side default),
          // so normalise rather than widen the state to undefined.
          : confirmed.scan_detail ?? null,
        strong: confirmed.scan_status === 'clean',
      });
      setState('success');
      onBusyChange?.(false);
      setTimeout(() => onUploaded(file_asset_id, f), 450); // let the success check draw
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') { reset(); return; }
      fail(err instanceof Error ? err.message : 'Upload failed.');
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (state === 'uploading' || state === 'processing') return;
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  const busy = state === 'uploading' || state === 'processing';
  const accentBorder = state === 'dragover' ? 'var(--primary)' : state === 'error' ? 'var(--status-rejected)' : 'var(--border)';

  return (
    <div>
      <motion.div
        animate={state === 'error' ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
        transition={{ duration: 0.2 }}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setState('dragover'); }}
        onDragLeave={() => { if (state === 'dragover') setState('idle'); }}
        onDrop={onDrop}
        onClick={() => { if (state === 'idle') inputRef.current?.click(); }}
        role="button" tabIndex={0}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && state === 'idle') inputRef.current?.click(); }}
        aria-label="Upload a document"
        style={{
          border: `2px dashed ${accentBorder}`, borderRadius: 'var(--radius-lg)',
          background: state === 'dragover' ? 'color-mix(in srgb, var(--primary) 7%, transparent)' : 'var(--card)',
          padding: '40px 24px', textAlign: 'center', cursor: state === 'idle' ? 'pointer' : 'default',
          transition: 'border-color 0.15s, background 0.15s', minHeight: 220,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
        }}
      >
        <input ref={inputRef} type="file" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }} />

        <AnimatePresence mode="wait">
          {(state === 'idle' || state === 'dragover') && (
            <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <motion.span animate={state === 'dragover' ? { y: [-2, 2, -2] } : { y: 0 }} transition={{ repeat: state === 'dragover' ? Infinity : 0, duration: 0.8 }}
                style={{ width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--primary) 10%, transparent)', color: 'var(--primary)' }}>
                <UploadCloud size={26} />
              </motion.span>
              <div>
                <p style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--foreground)', margin: 0 }}>Drop a file here, or click to browse</p>
                <p style={{ fontSize: '0.82rem', color: 'var(--muted-foreground)', margin: '4px 0 0' }}>DOCX or PDF, up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB</p>
              </div>
            </motion.div>
          )}

          {(state === 'validating' || busy) && (
            <motion.div key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <FileText size={20} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file?.name}</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: 'var(--muted)', overflow: 'hidden' }}>
                <motion.div
                  animate={{ width: state === 'processing' ? '100%' : `${Math.round(progress * 100)}%` }}
                  transition={{ duration: 0.2 }}
                  style={{ height: '100%', background: 'var(--gradient-primary-btn, var(--primary))',
                    ...(state === 'processing' ? { animation: 'pulse 1.2s ease-in-out infinite' } : {}) }}
                />
              </div>
              <span style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                {/* "Checking…" is accurate for every configured scanner: the
                    structural pass always runs, a virus scan only when one is
                    switched on. The verdict shown afterwards says which it was. */}
                {state === 'validating' ? 'Validating…'
                  : state === 'processing' ? 'Checking…'
                    : `${resumedRef.current ? 'Resuming' : 'Uploading'}… ${Math.round(progress * 100)}%`}
                {state === 'uploading' && parts && parts.total > 1 && (
                  <span style={{ opacity: 0.8 }}>
                    {` · part ${Math.min(parts.total, Math.floor(progress * parts.total) + 1)} of ${parts.total}`}
                  </span>
                )}
              </span>
              {state === 'uploading' && (
                <button onClick={(e) => { e.stopPropagation(); abortRef.current?.abort(); }}
                  className="btn btn-ghost btn-sm" style={{ alignSelf: 'center' }}>
                  {/* A resumable upload keeps its parts, so the honest word
                      for stopping it is Pause. */}
                  {fileRef.current ? <><Pause size={13} /> Pause</> : <><X size={13} /> Cancel</>}
                </button>
              )}
            </motion.div>
          )}

          {state === 'success' && (
            <motion.div key="ok" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 56, height: 56, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--status-approved-bg)', color: 'var(--status-approved)' }}>
                <Check size={28} />
              </span>
              <p style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--foreground)', margin: 0 }}>Uploaded</p>
              {/* Verbatim from the server. "Virus scan passed" appears only when
                  a real scanner produced it; otherwise this reads "File checked"
                  or "Virus scan not enabled", which is the honest state. */}
              {scan && (
                <p style={{
                  fontSize: '0.78rem', margin: 0, textAlign: 'center',
                  color: scan.strong ? 'var(--status-approved)' : 'var(--muted-foreground)',
                }}>
                  {scan.label}
                  {scan.detail ? <><br /><span style={{ opacity: 0.85 }}>{scan.detail}</span></> : null}
                </p>
              )}
            </motion.div>
          )}

          {state === 'paused' && (
            <motion.div key="paused" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <FileText size={20} style={{ color: 'var(--status-pending)', flexShrink: 0 }} />
                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file?.name}</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: 'var(--muted)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.round(progress * 100)}%`, background: 'var(--status-pending)' }} />
              </div>
              <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                Paused at {Math.round(progress * 100)}%. The part already uploaded is kept &mdash;
                you can continue now or after a reload.
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn btn-primary btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    const f = fileRef.current;
                    if (f) { resumedRef.current = true; void runResumable(f); }
                  }}><RotateCw size={13} /> Resume</button>
                <button className="btn btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); void discardPaused(); }}><X size={13} /> Discard</button>
              </div>
            </motion.div>
          )}

          {state === 'error' && (
            <motion.div key="err" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)' }}>
                <AlertTriangle size={22} />
              </span>
              <p style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--status-rejected)', margin: 0, maxWidth: 340 }}>{error}</p>
              <button onClick={(e) => { e.stopPropagation(); reset(); }} className="btn btn-secondary btn-sm"><RotateCw size={13} /> Try again</button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

export default UploadDropzone;
