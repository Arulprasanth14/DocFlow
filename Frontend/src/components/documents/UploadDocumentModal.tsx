/**
 * DocFlow — Upload a document (modal).
 *
 * The hub's "Upload a document" = submit an existing file as-is (spec C4,
 * FR-3.7). Per §19 screen 3 the screen is: dropzone → file summary card →
 * "Continue" bar, and per §7.4 Flow C it then joins the wizard at Workflow.
 *
 * Presented as a dialog that slides down from the top edge. Accessibility:
 * role="dialog" + aria-modal + labelled title, focus trap, Esc to close,
 * click-outside to close (guarded while an upload is in flight), and
 * reduced-motion degrades to a plain fade.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, FileText, ArrowRight, CheckCircle2 } from 'lucide-react';
import { UploadDropzone } from '@/components/documents/UploadDropzone';
import { prefersReducedMotion } from '@/lib/motion/prefersReducedMotion';

export interface UploadedSummary { fileAssetId: string; file: File }

export function UploadDocumentModal({
  open, onClose, onContinue, busy, error,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the uploaded file once the user presses Continue. */
  onContinue: (uploaded: UploadedSummary) => void;
  /** True while the document is being created after Continue. */
  busy?: boolean;
  error?: string;
}) {
  const [uploaded, setUploaded] = useState<UploadedSummary | null>(null);
  const [uploading, setUploading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const reduced = prefersReducedMotion();

  // Reset when reopened.
  useEffect(() => { if (open) { setUploaded(null); setUploading(false); } }, [open]);

  // Focus management: remember opener, focus the panel, restore on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement;
    const t = setTimeout(() => panelRef.current?.focus(), 30);
    return () => {
      clearTimeout(t);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Esc to close + focus trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); attemptClose(); return; }
      if (e.key !== 'Tab') return;
      const root = panelRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uploading, busy]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const attemptClose = () => {
    if (busy) return;
    if (uploading && !window.confirm('An upload is in progress. Discard it and close?')) return;
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={attemptClose}
            style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', backdropFilter: 'blur(4px)', zIndex: 400 }}
          />
          <motion.div
            // Slides down from the top edge; reduced motion → fade only.
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -24 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -16 }}
            transition={{ duration: reduced ? 0.12 : 0.28, ease: [0.22, 1, 0.36, 1] }}
            role="dialog" aria-modal="true" aria-labelledby="upload-modal-title"
            ref={panelRef} tabIndex={-1}
            style={{
              // Centred with auto margins, NOT translateX — framer animates
              // `transform` for the slide, which would clobber a translate here.
              position: 'fixed', top: 24, left: 0, right: 0, margin: '0 auto',
              width: 'min(640px, calc(100vw - 24px))', maxHeight: '86vh', overflowY: 'auto',
              zIndex: 401, outline: 'none',
            }}
          >
            <div style={{
              background: 'var(--card-solid)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', padding: 24,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                <div>
                  <h2 id="upload-modal-title" className="font-heading"
                    style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--foreground)', margin: 0 }}>
                    Upload a document
                  </h2>
                  <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', margin: '4px 0 0' }}>
                    Submit a DOCX or PDF you already have, as-is.
                  </p>
                </div>
                <button onClick={attemptClose} aria-label="Close" disabled={busy}
                  style={{
                    display: 'inline-flex', padding: 6, borderRadius: 'var(--radius-sm)', border: 'none',
                    background: 'transparent', color: 'var(--muted-foreground)',
                    cursor: busy ? 'not-allowed' : 'pointer',
                  }}><X size={18} /></button>
              </div>

              <div style={{ marginTop: 16 }}>
                {!uploaded ? (
                  <UploadDropzone
                    onUploaded={(fileAssetId, file) => { setUploading(false); setUploaded({ fileAssetId, file }); }}
                    onBusyChange={setUploading}
                  />
                ) : (
                  // File summary card + Continue bar (§19 screen 3)
                  <div>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: 16,
                      borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--card)',
                    }}>
                      <span style={{
                        width: 44, height: 44, borderRadius: 'var(--radius)', flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'var(--status-approved-bg)', color: 'var(--status-approved)',
                      }}><CheckCircle2 size={22} /></span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--foreground)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {uploaded.file.name}
                        </p>
                        <p style={{ fontSize: '0.78rem', color: 'var(--muted-foreground)', margin: '2px 0 0' }}>
                          {(uploaded.file.size / 1024 / 1024).toFixed(2)} MB · uploaded
                        </p>
                      </div>
                      <button className="btn btn-ghost btn-sm" onClick={() => setUploaded(null)} disabled={busy}>
                        Replace
                      </button>
                    </div>

                    <p style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', color: 'var(--muted-foreground)', margin: '14px 0 0' }}>
                      <FileText size={14} />
                      A preview of the file opens on the document page after this step.
                    </p>

                    {error && (
                      <div role="alert" style={{
                        marginTop: 12, padding: '10px 14px', borderRadius: 'var(--radius)',
                        background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)',
                        fontSize: '0.84rem', fontWeight: 600,
                      }}>{error}</div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
                      <button className="btn btn-secondary" onClick={attemptClose} disabled={busy}>Cancel</button>
                      <button className="btn btn-primary" disabled={busy} onClick={() => onContinue(uploaded)}>
                        {busy ? 'Preparing…' : <>Continue <ArrowRight size={15} /></>}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default UploadDocumentModal;
