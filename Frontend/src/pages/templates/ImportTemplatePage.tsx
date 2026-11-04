/**
 * DocFlow — import an existing document as a template
 * (/documents/templates/import). Spec FR-5.1, FR-9.1-9.6.
 *
 * Three screens in one route, driven by the job's status:
 *
 *   choose    pick a file, decide whether to use AI
 *   working   staged progress while the server converts and scans
 *   review    the detected blanks, accepted or rejected one by one
 *
 * Two things this is deliberately honest about:
 *
 *   - The AI toggle is OFF by default and the document text is not sent
 *     anywhere unless it is switched on. The notice says so in plain words,
 *     and the toggle is not rendered at all when the organisation has AI
 *     turned off.
 *   - A PDF import says, on screen, that only its text survived. Pretending
 *     otherwise would leave the author to discover it after publishing.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  FileUp, Sparkles, AlertTriangle, Check, X, Loader2, ArrowRight,
  FileText, Info, RotateCcw, Columns2,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { ImportDocumentPanel } from '@/components/templates/ImportDocumentPanel';
import { OriginalPane } from '@/components/templates/OriginalPane';
import { useUploadFile } from '@/hooks/useDocuments';
import {
  useImportJob, useStartImport, useCancelImport, useApplyImport,
} from '@/hooks/useImports';
import { useAIAvailability } from '@/hooks/useAI';
import type { Confidence, Detection } from '@/lib/api/imports';

const ACCEPT = '.docx,.doc,.odt,.rtf,.pdf,.txt,.jpg,.jpeg,.png,.tiff,.tif,.webp';
const MAX_BYTES = 25 * 1024 * 1024;

const FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'date', 'email', 'phone',
  'dropdown', 'radio', 'checkbox', 'yesno',
];

/** FR-9.5 — high green, medium amber, low red. Tokens only. */
const CONFIDENCE_STYLE: Record<Confidence, { bg: string; fg: string; label: string }> = {
  high: { bg: 'var(--status-approved-bg)', fg: 'var(--status-approved-fg)', label: 'High' },
  medium: { bg: 'var(--status-pending-bg)', fg: 'var(--status-pending-fg)', label: 'Medium' },
  low: { bg: 'var(--status-rejected-bg)', fg: 'var(--status-rejected-fg)', label: 'Low' },
};

const STAGE_ORDER = ['Queued', 'Reading document', 'Finding blanks', 'Ready for review'];

type Edited = { key: string; label: string; type: string; accepted: boolean };

export default function ImportTemplatePage() {
  const navigate = useNavigate();
  const uploadFile = useUploadFile();
  const startImport = useStartImport();
  const cancelImport = useCancelImport();
  const applyImport = useApplyImport();
  const ai = useAIAvailability();

  const [jobId, setJobId] = useState<string | undefined>();
  const { data: job } = useImportJob(jobId);

  const [file, setFile] = useState<File | null>(null);
  const [useLlm, setUseLlm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [edits, setEdits] = useState<Record<string, Edited>>({});
  // Blanks the author marked by hand (FR-9.5). Held client-side until apply,
  // where the server re-reads each span from its own copy of the text.
  const [manual, setManual] = useState<Detection[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const detections = useMemo(
    () => [...(job?.detections ?? []), ...manual].sort((a, b) => a.start - b.start),
    [job?.detections, manual],
  );
  const idOf = (d: Detection) => `${d.start}:${d.end}`;

  // Seed the editable review rows once the detections arrive. Low-confidence
  // ones start unticked: the author opts into a guess, never out of it.
  useEffect(() => {
    if (job?.status !== 'ready' || detections.length === 0) return;
    setEdits((prev) => {
      const next = { ...prev };
      for (const d of detections) {
        // Only seed rows we have not seen; never clobber an edit in progress.
        if (next[idOf(d)]) continue;
        next[idOf(d)] = {
          key: d.key,
          label: d.label,
          type: d.type,
          // A hand-marked blank is wanted by definition; a low-confidence
          // guess has to be opted into.
          accepted: d.source === 'manual' || d.confidence !== 'low',
        };
      }
      return next;
    });
    setName((n) => n || job.filename.replace(/\.(docx|doc|odt|rtf|pdf|txt|text|md|jpg|jpeg|png|tiff|tif|webp)$/i, ''));
  }, [job?.status, job?.filename, detections]);

  const pick = (picked: File | null) => {
    setError('');
    if (!picked) { setFile(null); return; }
    if (picked.size > MAX_BYTES) {
      setError(`That file is ${(picked.size / 1024 / 1024).toFixed(1)} MB. The limit is 25 MB.`);
      setFile(null);
      return;
    }
    const ok = /\.(docx|doc|odt|rtf|pdf|txt|text|md|jpg|jpeg|png|tiff|tif|webp)$/i.test(picked.name);
    if (!ok) {
      setError('Import a Word (.docx or .doc), OpenDocument (.odt), RTF, PDF, image or plain-text file.');
      setFile(null);
      return;
    }
    setFile(picked);
  };

  const begin = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const fileAssetId = await uploadFile.mutateAsync(file);
      const created = await startImport.mutateAsync({
        file_asset_id: fileAssetId,
        filename: file.name,
        mime_type: file.type || null,
        use_llm: useLlm,
      });
      setJobId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file couldn't be imported.");
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setJobId(undefined);
    setFile(null);
    setEdits({});
    setManual([]);
    setName('');
    setError('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const acceptedCount = Object.values(edits).filter((e) => e.accepted).length;

  /** FR-9.7 — off by default: the comparison is for checking a warning,
   *  not the normal way to read the review screen. */
  const [compare, setCompare] = useState(false);

  /** FR-9.5 — the author selected text the scan missed. */
  const makeBlank = (start: number, end: number, original: string) => {
    const id = `${start}:${end}`;
    if (detections.some((d) => idOf(d) === id)) return;
    const guess = original.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    const d: Detection = {
      start, end, original,
      key: guess || `field_${detections.length + 1}`,
      label: original.trim().slice(0, 60) || 'New question',
      type: 'text',
      confidence: 'high',
      reason: 'Marked by hand',
      source: 'manual',
    };
    setManual((m) => [...m, d]);
    setEdits((p) => ({ ...p, [id]: { key: d.key, label: d.label, type: d.type, accepted: true } }));
    setFocused(id);
    // Let the new row render before scrolling to it.
    requestAnimationFrame(() => rowRefs.current[id]?.scrollIntoView({ block: 'center' }));
  };

  const focusDetection = (d: Detection) => {
    const id = idOf(d);
    setFocused(id);
    rowRefs.current[id]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const finish = async () => {
    if (!jobId || acceptedCount === 0) return;
    setError('');
    try {
      const accepted = detections
        .filter((d) => edits[idOf(d)]?.accepted)
        .map((d) => ({
          start: d.start,
          end: d.end,
          key: edits[idOf(d)].key,
          label: edits[idOf(d)].label,
          type: edits[idOf(d)].type,
        }));
      const tpl = await applyImport.mutateAsync({ jobId, name, accepted });
      navigate(`/documents/templates/${tpl.id}/edit`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That import couldn't be applied.");
    }
  };

  const setEdit = (d: Detection, patch: Partial<Edited>) =>
    setEdits((prev) => ({ ...prev, [idOf(d)]: { ...prev[idOf(d)], ...patch } }));

  const working = job && ['pending', 'extracting', 'detecting'].includes(job.status);
  const stageIndex = STAGE_ORDER.indexOf(job?.stage ?? '');

  // One element, rendered either on its own or as the left half of the
  // comparison — so the two layouts can never show different things.
  const documentPanel = job ? (
    <ImportDocumentPanel
      text={job.text}
      detections={detections}
      accepted={Object.fromEntries(
        Object.entries(edits).map(([k, v]) => [k, v.accepted]),
      )}
      onFocusDetection={focusDetection}
      onMakeBlank={makeBlank}
    />
  ) : null;

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 940, margin: '0 auto' }}>
      <button onClick={() => navigate('/documents/templates/new')}
        className="btn btn-ghost btn-sm" style={{ marginBottom: 12, paddingLeft: 0 }}>
        ← Back
      </button>
      <PageHeader
        breadcrumbs={[{ label: 'Documents' }, { label: 'Templates' }, { label: 'Import' }]}
        title="Import an existing document"
        description="Upload a document and we'll find the blanks for you to confirm."
      />
      <div style={{ height: 24 }} />

      {error && (
        <div role="alert" style={{
          padding: '12px 16px', marginBottom: 16, borderRadius: 'var(--radius)',
          background: 'var(--status-rejected-bg)', color: 'var(--status-rejected-fg)',
          fontSize: '0.85rem', fontWeight: 600,
        }}>{error}</div>
      )}

      {/* ── choose ─────────────────────────────────────────────────────── */}
      {!job && (
        <div className="glass-card" style={{ padding: 28, display: 'grid', gap: 18 }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: file ? '14px 16px' : '32px 16px',
            borderRadius: 'var(--radius)',
            border: `1px ${file ? 'solid' : 'dashed'} var(--border)`,
            background: file ? 'var(--card-solid)' : 'transparent',
            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>
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
            <FileUp size={22} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
            <span style={{ display: 'grid', gap: 3 }}>
              <span style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--foreground)' }}>
                {file ? file.name : 'Choose a document'}
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                {file
                  ? `${(file.size / 1024).toFixed(0)} KB`
                  : 'DOCX and ODT keep headings and tables. .doc via LibreOffice, scanned PDFs and images via OCR — review for recognition errors. Up to 25 MB.'}
              </span>
            </span>
          </label>

          {/* FR-9.8 notice + opt-in. Hidden entirely when the org has AI off,
              because an unusable toggle is just noise. */}
          {ai.enabled && (
            <div style={{
              display: 'grid', gap: 8, padding: '12px 14px',
              borderRadius: 'var(--radius)', border: '1px solid var(--border)',
              background: 'var(--card-solid)',
            }}>
              <label
                // The visible text is in nested spans, so the accessible name
                // is stated here rather than guessed from the first one.
                aria-label="Also use AI to look for blanks"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}
              >
                <input type="checkbox" checked={useLlm}
                  onChange={(e) => setUseLlm(e.target.checked)} style={{ marginTop: 3 }} />
                <span style={{ display: 'grid', gap: 3 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    fontSize: '0.86rem', fontWeight: 700, color: 'var(--foreground)',
                  }}>
                    <Sparkles size={14} /> Also use AI to find blanks
                  </span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
                    Finds blanks that are only implied by the wording, which the
                    standard rules miss. <strong>This sends the document&apos;s
                    text to the AI provider.</strong> Leave it off and the file
                    is only ever processed on our servers.
                  </span>
                </span>
              </label>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" disabled={!file || busy} onClick={() => void begin()}>
              {busy
                ? <><Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} /> Uploading…</>
                : <>Import <ArrowRight size={15} /></>}
            </button>
            {file && !busy && (
              <button className="btn btn-ghost" onClick={() => pick(null)}>Choose another</button>
            )}
          </div>
        </div>
      )}

      {/* ── working ────────────────────────────────────────────────────── */}
      {working && (
        <div className="glass-card" style={{ padding: 28, display: 'grid', gap: 18 }}>
          <div style={{ display: 'grid', gap: 10 }}>
            {STAGE_ORDER.slice(0, 3).map((label, i) => {
              const state = stageIndex > i ? 'done' : stageIndex === i ? 'active' : 'todo';
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                    display: 'grid', placeItems: 'center',
                    background: state === 'todo' ? 'var(--muted)' : 'var(--status-approved-bg)',
                    color: state === 'todo' ? 'var(--muted-foreground)' : 'var(--status-approved-fg)',
                  }}>
                    {state === 'done' ? <Check size={13} />
                      : state === 'active'
                        ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} />
                        : <span style={{ fontSize: '0.7rem' }}>{i + 1}</span>}
                  </span>
                  <span style={{
                    fontSize: '0.88rem',
                    fontWeight: state === 'active' ? 700 : 500,
                    color: state === 'todo' ? 'var(--muted-foreground)' : 'var(--foreground)',
                  }}>{label}</span>
                </div>
              );
            })}
          </div>

          <div style={{ height: 6, borderRadius: 999, background: 'var(--muted)', overflow: 'hidden' }}>
            <motion.div
              animate={{ width: `${job.progress}%` }}
              transition={{ duration: 0.4 }}
              style={{ height: '100%', background: 'var(--primary)' }}
            />
          </div>

          <button className="btn btn-ghost btn-sm" style={{ justifySelf: 'start' }}
            onClick={() => { if (jobId) cancelImport.mutate(jobId); restart(); }}>
            Cancel
          </button>
        </div>
      )}

      {/* ── failed / cancelled ─────────────────────────────────────────── */}
      {job && (job.status === 'failed' || job.status === 'cancelled') && (
        <div className="glass-card" style={{ padding: 28, display: 'grid', gap: 14 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            fontSize: '0.95rem', fontWeight: 700, color: 'var(--foreground)',
          }}>
            <AlertTriangle size={18} style={{ color: 'var(--status-rejected-fg)' }} />
            {job.status === 'cancelled' ? 'Import cancelled' : "That import didn't work"}
          </span>
          {job.error && (
            <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--muted-foreground)' }}>
              {job.error}
            </p>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" onClick={restart}>
              <RotateCcw size={14} /> Try another file
            </button>
            <button className="btn btn-ghost" onClick={() => navigate('/documents/templates/new')}>
              Create from scratch instead
            </button>
          </div>
        </div>
      )}

      {/* ── review ─────────────────────────────────────────────────────── */}
      {job?.status === 'ready' && (
        <div style={{ display: 'grid', gap: 16 }}>
          {job.warnings.length > 0 && (
            <div style={{
              display: 'grid', gap: 6, padding: '12px 14px',
              borderRadius: 'var(--radius)',
              background: 'var(--status-pending-bg)', color: 'var(--status-pending-fg)',
            }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                fontSize: '0.84rem', fontWeight: 700,
              }}>
                <Info size={14} /> What didn&apos;t come across
              </span>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: '0.8rem', lineHeight: 1.6 }}>
                {job.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <div className="glass-card" style={{ padding: 22, display: 'grid', gap: 14 }}>
            <div>
              <label style={{
                display: 'block', fontSize: '0.82rem', fontWeight: 600,
                color: 'var(--foreground)', marginBottom: 6,
              }} htmlFor="imp-name">Template name</label>
              <input id="imp-name" className="input" value={name}
                onChange={(e) => setName(e.target.value)} style={{ maxWidth: 420 }} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--foreground)' }}>
                {detections.length} blank{detections.length === 1 ? '' : 's'} found
              </span>
              <span style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                {acceptedCount} selected
              </span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setEdits((p) =>
                  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, accepted: true }])))}>
                  Accept all
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEdits((p) =>
                  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { ...v, accepted: false }])))}>
                  Clear all
                </button>
              </span>
            </div>

            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
              Blanks sharing a name become one question that fills in everywhere
              at once. Nothing here is final — you can change any of it in the
              editor afterwards.
            </p>

            {/* FR-9.7 — the conversion, and on request the file it came from.
                Side by side is the only way to check a fidelity warning: the
                warning says a table was dropped, this is where you see it. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-pressed={compare}
                onClick={() => setCompare((c) => !c)}
                style={{ fontSize: '0.78rem' }}
              >
                <Columns2 size={13} />
                {compare ? 'Hide the original' : 'Compare with the original'}
              </button>
              {compare && (
                <span style={{ fontSize: '0.76rem', color: 'var(--muted-foreground)' }}>
                  Converted document on the left, the file you uploaded on the right.
                </span>
              )}
            </div>

            {compare ? (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                gap: 12, alignItems: 'stretch',
              }}>
                <div style={{ minWidth: 0 }}>{documentPanel}</div>
                <OriginalPane
                  fileAssetId={job.file_asset_id}
                  filename={job.filename}
                  sourceKind={job.source_kind}
                  text={job.text}
                />
              </div>
            ) : documentPanel}

            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
              {detections.map((d) => {
                const e = edits[idOf(d)];
                if (!e) return null;
                const conf = CONFIDENCE_STYLE[d.confidence] ?? CONFIDENCE_STYLE.low;
                return (
                  <li
                    key={idOf(d)}
                    ref={(el) => { rowRefs.current[idOf(d)] = el; }}
                    style={{
                      display: 'grid', gap: 8, padding: '11px 13px',
                      borderRadius: 'var(--radius-sm)',
                      border: `1px solid ${
                        focused === idOf(d) ? 'var(--accent-violet)'
                          : e.accepted ? 'var(--primary)' : 'var(--border)'
                      }`,
                      background: 'var(--card-solid)',
                      opacity: e.accepted ? 1 : 0.62,
                      scrollMarginTop: 12,
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <input type="checkbox" checked={e.accepted}
                        aria-label={`Use the blank "${e.label}"`}
                        onChange={(ev) => setEdit(d, { accepted: ev.target.checked })} />
                      <span style={{
                        padding: '1px 8px', borderRadius: 'var(--radius-pill)',
                        background: conf.bg, color: conf.fg,
                        fontSize: '0.68rem', fontWeight: 700,
                      }}>{conf.label}</span>
                      {d.source === 'manual' && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '1px 8px', borderRadius: 'var(--radius-pill)',
                          background: 'var(--secondary)', color: 'var(--muted-foreground)',
                          fontSize: '0.68rem', fontWeight: 700,
                        }}>By hand</span>
                      )}
                      {d.source === 'ai' && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '1px 8px', borderRadius: 'var(--radius-pill)',
                          background: 'var(--secondary)', color: 'var(--muted-foreground)',
                          fontSize: '0.68rem', fontWeight: 700,
                        }}><Sparkles size={9} /> AI</span>
                      )}
                      <code style={{
                        fontSize: '0.74rem', color: 'var(--muted-foreground)',
                        background: 'var(--muted)', padding: '1px 6px',
                        borderRadius: 4, maxWidth: 220, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{d.original.trim() || '(blank)'}</code>
                      <span style={{
                        fontSize: '0.72rem', color: 'var(--muted-foreground)',
                        marginLeft: 'auto',
                      }}>{d.reason}</span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.4fr 1fr', gap: 8 }}>
                      <input className="input" value={e.label}
                        aria-label="Question" placeholder="Question"
                        disabled={!e.accepted}
                        onChange={(ev) => setEdit(d, { label: ev.target.value })}
                        style={{ fontSize: '0.82rem' }} />
                      <input className="input" value={e.key}
                        aria-label="Field name" placeholder="field_name"
                        disabled={!e.accepted}
                        onChange={(ev) => setEdit(d, {
                          key: ev.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 48),
                        })}
                        style={{ fontSize: '0.82rem', fontFamily: 'var(--font-mono, monospace)' }} />
                      <select className="input" value={e.type} aria-label="Type"
                        disabled={!e.accepted}
                        onChange={(ev) => setEdit(d, { type: ev.target.value })}
                        style={{ fontSize: '0.82rem' }}>
                        {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </li>
                );
              })}
            </ul>

            {detections.length === 0 && (
              <div style={{
                padding: '18px 14px', textAlign: 'center',
                color: 'var(--muted-foreground)', fontSize: '0.86rem',
              }}>
                <FileText size={22} style={{ marginBottom: 6 }} />
                <p style={{ margin: 0 }}>
                  No blanks were found. You can still create the template and mark
                  them yourself in the editor.
                </p>
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, paddingTop: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-primary"
                disabled={acceptedCount === 0 || applyImport.isPending || !name.trim()}
                onClick={() => void finish()}>
                {applyImport.isPending
                  ? <><Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} /> Creating…</>
                  : <>Create template with {acceptedCount} question{acceptedCount === 1 ? '' : 's'} <ArrowRight size={15} /></>}
              </button>
              <button className="btn btn-ghost" onClick={restart}>
                <X size={14} /> Start over
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
