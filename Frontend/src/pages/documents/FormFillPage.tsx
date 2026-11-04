/**
 * DocFlow — Form Fill (/documents/:id/fill)
 *
 * Spec §8.12 FR-12, flow B2/B3, screen 7. "Use template" creates a draft pinned
 * to the template's published version (C9); this page answers that version's
 * questions:
 *   - left  : the live document, answers appearing in place as you type
 *   - right : one question at a time, "Question k of N", with validation
 *   - clicking a blank on the left jumps to its question (FR-12.2)
 *   - linked placeholders (same field key) update everywhere at once (FR-12.6)
 *
 * Answers autosave to DocumentContent.answers; nothing is validated while
 * typing (FR-14.4) — only "Next" and "Continue" gate on it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CheckCircle2, Eye, Lock, RotateCw, TriangleAlert } from 'lucide-react';

import { DocumentPreview } from '@/components/editor/DocumentPreview';
import { FillAnswerInput, validateAnswer, type AnswerValue } from '@/components/documents/FillAnswerInput';
import { SplitPane } from '@/components/ui/SplitPane';
import { PageHeader } from '@/components/ui/PageHeader';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import StatusBadge from '@/components/ui/StatusBadge';
import { useDocument, useDocumentFillSchema, useSaveDocumentContent } from '@/hooks/useDocuments';
import type { SaveState } from '@/hooks/useAutosave';
import type { DocumentFillSchema, FillField } from '@/lib/api/documents';
import type { Document } from '@/types';

const AUTOSAVE_MS = 1500;
// FR-7.10 — evaluate conditional field visibility
export function isFieldVisible(f: FillField, currentAnswers: Record<string, unknown>): boolean {
  const rule = (f as any).visible_when || f.validation?.visible_when;
  if (!rule || !rule.field) return true;
  const actual = currentAnswers[rule.field];
  const target = rule.value;
  switch (rule.op) {
    case 'eq':
    case '==':
      return actual === target || String(actual) === String(target);
    case 'neq':
    case '!=':
      return actual !== target && String(actual) !== String(target);
    case 'in':
      return Array.isArray(target) ? target.includes(actual) : false;
    case 'not_in':
      return Array.isArray(target) ? !target.includes(actual) : true;
    case 'truthy':
      return !!actual && actual !== '' && actual !== 'false';
    case 'falsy':
      return !actual || actual === '' || actual === 'false';
    default:
      return actual === target || String(actual) === String(target);
  }
}


export default function FormFillPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: doc, isLoading: docLoading, isError: docError, refetch } = useDocument(id);
  const { data: schema, isLoading: schemaLoading } = useDocumentFillSchema(id);

  if (docLoading || schemaLoading) {
    return (
      <div className="page-content" style={{ paddingTop: 48, textAlign: 'center' }}>
        <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto' }} />
      </div>
    );
  }
  if (docError || !doc || !schema) {
    return (
      <div className="page-content" style={{ paddingTop: 48, maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <p style={{ fontWeight: 700, color: 'var(--foreground)' }}>Couldn&rsquo;t open this document</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
          <button className="btn btn-secondary" onClick={() => refetch()}><RotateCw size={14} /> Retry</button>
          <button className="btn btn-primary" onClick={() => navigate('/documents')}>All documents</button>
        </div>
      </div>
    );
  }

  // A blank or uploaded document has no questions (FR-13.9) — it belongs in the
  // freeform editor, not here. Send it there rather than showing an empty form.
  if (schema.fields.length === 0) {
    return <NoQuestions doc={doc} />;
  }

  return <FillSurface key={doc.id} doc={doc} schema={schema} />;
}

function NoQuestions({ doc }: { doc: Document }) {
  const navigate = useNavigate();
  const target = doc.source === 'upload' ? `/documents/${doc.id}/submit` : `/documents/${doc.id}/edit`;
  return (
    <div className="page-content" style={{ paddingTop: 48, maxWidth: 520, margin: '0 auto', textAlign: 'center' }}>
      <p style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--foreground)' }}>
        This document has no questions to answer
      </p>
      <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', marginBottom: 20 }}>
        {doc.source === 'upload'
          ? 'Uploaded documents are submitted as they are.'
          : 'It was started from a blank page, so you write it freely instead.'}
      </p>
      <button className="btn btn-primary" onClick={() => navigate(target)}>
        Continue <ArrowRight size={15} />
      </button>
    </div>
  );
}

export function FillSurface({ doc, schema, onCreate }: {
  doc: Document;
  schema: DocumentFillSchema;
  /**
   * FR-12.1 — present only in the deferred-create mode, where `doc` is a
   * stand-in with an empty id and no row exists yet. Called with the
   * answers so far the first time the author answers anything; it creates
   * the draft and takes over navigation. Absent for a saved document,
   * which is every other way into this page.
   */
  onCreate?: (answers: Record<string, unknown>) => Promise<string>;
}) {
  const navigate = useNavigate();
  const saveContent = useSaveDocumentContent();
  const locked = doc.status !== 'draft';
  /** True until the first answer has brought a real document into being. */
  const unsaved = !doc.id;

  const allFields = useMemo(
    () => [...schema.fields].sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)),
    [schema.fields],
  );

  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(() => {
    const seed: Record<string, AnswerValue> = {};
    for (const f of allFields) {
      const existing = schema.answers[f.key];
      seed[f.key] = (existing ?? (f.default_value as AnswerValue) ?? '') as AnswerValue;
    }
    return seed;
  });

  // FR-7.10 — filter by conditional visibility rule
  const fields = useMemo(
    () => allFields.filter((f) => isFieldVisible(f, answers)),
    [allFields, answers],
  );
  const [index, setIndex] = useState(0);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [showOverview, setShowOverview] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; }, [answers]);
  const firstInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(null);

  const current = fields[index];
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = validateAnswer(f, answers[f.key] ?? '');
    return out;
  }, [fields, answers]);

  const ifEmpty = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = f.if_empty_behavior || 'keep_blank';
    return out;
  }, [fields]);

  const answeredCount = fields.filter((f) => {
    const v = answers[f.key];
    return v !== '' && v !== null && v !== undefined;
  }).length;
  const blockingCount = fields.filter((f) => errors[f.key]).length;

  // ── autosave ──────────────────────────────────────────────────────────────
  const flush = useCallback(async () => {
    if (locked) return;
    setSaveState('saving');
    try {
      if (unsaved) {
        // FR-12.1 — this is the first answer, so this is where the draft
        // starts existing. Opening the template created nothing.
        if (!onCreate) return;
        await onCreate(answersRef.current as Record<string, unknown>);
      } else {
        await saveContent.mutateAsync({
          docId: doc.id,
          data: { answers: answersRef.current as Record<string, unknown> },
        });
      }
      setSaveState('saved');
      setLastSavedAt(new Date());
    } catch {
      setSaveState('error');
    }
  }, [doc.id, locked, saveContent, unsaved, onCreate]);

  const schedule = useCallback(() => {
    if (locked) return;
    setSaveState('unsaved');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, AUTOSAVE_MS);
  }, [flush, locked]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setAnswer = (key: string, value: AnswerValue) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    schedule();
  };

  // ── navigation ────────────────────────────────────────────────────────────
  const goTo = useCallback((i: number) => {
    setIndex(Math.max(0, Math.min(fields.length - 1, i)));
    setShowOverview(false);
  }, [fields.length]);

  const jumpToField = useCallback((key: string) => {
    const i = fields.findIndex((f) => f.key === key);
    if (i >= 0) goTo(i);
  }, [fields, goTo]);

  const next = () => {
    setTouched((t) => ({ ...t, [current.key]: true }));
    if (errors[current.key]) return;
    if (index < fields.length - 1) goTo(index + 1);
  };
  const prev = () => goTo(index - 1);

  // Move focus to the question when it changes, so keyboard users land on the
  // input rather than at the top of the page.
  useEffect(() => {
    const el = firstInputRef.current;
    if (el && !locked) el.focus({ preventScroll: true });
  }, [index, locked]);

  // FR-12.4 — Enter = next, Shift+Enter = previous.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'TEXTAREA') return;   // Enter is a newline there
    e.preventDefault();
    if (e.shiftKey) prev(); else next();
  };

  const continueToWorkflow = async () => {
    setTouched(Object.fromEntries(fields.map((f) => [f.key, true])));
    if (blockingCount > 0) { setShowOverview(true); return; }
    if (timer.current) clearTimeout(timer.current);
    if (unsaved) {
      // FR-12.1 — Continue on a wizard that has never been answered (every
      // question optional, nothing typed). The draft has to exist before it
      // can be submitted, so create it here and let the creator navigate.
      if (!onCreate) return;
      setSaveState('saving');
      try {
        await onCreate(answersRef.current as Record<string, unknown>);
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
      return;
    }
    await flush();
    navigate(`/documents/${doc.id}/submit`);
  };

  const showError = (f: FillField) => (touched[f.key] ? errors[f.key] : '');

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 1320, margin: '0 auto' }}>
      <button onClick={() => navigate('/documents/new')} className="btn btn-ghost btn-sm" style={{ marginBottom: 12, paddingLeft: 0 }}>
        <ArrowLeft size={14} /> Back to templates
      </button>
      <PageHeader
        breadcrumbs={[
          { label: 'Documents' },
          { label: doc.public_id || 'New document' },
          { label: 'Fill' },
        ]}
        title={schema.template_name || 'Fill in your document'}
        description="Answer one question at a time. The document on the left updates as you type."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {!locked && <SaveIndicator state={saveState} lastSavedAt={lastSavedAt} onRetry={() => void flush()} />}
            <button className="btn btn-primary" onClick={continueToWorkflow} disabled={locked}>
              Continue <ArrowRight size={15} />
            </button>
          </div>
        }
      />
      <div style={{ height: 16 }} />

      {locked && (
        <Banner tone="muted" icon={<Lock size={15} />}>
          This document is <StatusBadge status={doc.status} /> and its answers can no longer be changed.
        </Banner>
      )}
      {schema.template_deleted && (
        <Banner tone="pending" icon={<TriangleAlert size={15} />}>
          The template this came from has since been deleted. Your copy is unaffected — it stays pinned to
          version {schema.version_no ?? '—'}.
        </Banner>
      )}

      <SplitPane
        storageKey="form-fill"
        stackedLeftLabel="Document preview"
        leftLabel="Document" rightLabel="Questions"
        left={
          <DocumentPreview
            content={schema.content}
            answers={answers as Record<string, unknown>}
            ifEmpty={ifEmpty}
            activeFieldKey={current?.key}
            onBlankClick={jumpToField}
          />
        }
        right={
          // FR-12.4 — Enter/Shift+Enter move between questions, handled on the
          // group rather than on each input. It is a group, so it says so: a
          // keyboard handler on an unlabelled div is invisible to assistive
          // tech. (A JS comment, not a JSX one: `right={...}` holds a single
          // expression, and a {/* */} sibling would be a second child.)
          <div
            role="group"
            aria-label="Current question"
            onKeyDown={onKeyDown}
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            {/* Progress */}
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                  Question {index + 1} of {fields.length}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                  {answeredCount} answered
                </span>
              </div>
              <div
                role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={fields.length}
                aria-label="Fill progress"
                style={{ height: 5, borderRadius: 999, background: 'var(--muted)', overflow: 'hidden' }}
              >
                <div style={{
                  width: `${((index + 1) / fields.length) * 100}%`, height: '100%',
                  background: 'var(--primary)', transition: 'width 180ms ease-out',
                }} />
              </div>
            </div>

            {/* The question */}
            {current && (
              <section style={{
                padding: 18, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
                background: 'var(--card-solid)', display: 'flex', flexDirection: 'column', gap: 10,
              }}>
                <label id={`fill-${current.key}-label`} htmlFor={`fill-${current.key}`}
                  style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--foreground)' }}>
                  {current.label || current.key}
                  {current.required && <span style={{ color: 'var(--status-rejected)' }} aria-hidden> *</span>}
                  {current.required && <span className="sr-only"> (required)</span>}
                </label>

                {current.help_text && (
                  <p style={{ fontSize: '0.82rem', color: 'var(--muted-foreground)', margin: 0, lineHeight: 1.5 }}>
                    {current.help_text}
                  </p>
                )}

                <FillAnswerInput
                  field={current}
                  value={answers[current.key] ?? ''}
                  onChange={(v) => setAnswer(current.key, v)}
                  inputRef={firstInputRef}
                />

                {showError(current)
                  ? <p role="alert" style={{ fontSize: '0.78rem', color: 'var(--status-rejected)', margin: 0 }}>{showError(current)}</p>
                  : current.example
                    ? <p style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', margin: 0 }}>For example: {current.example}</p>
                    : null}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                  <button className="btn btn-ghost btn-sm" onClick={prev} disabled={index === 0}>
                    <ArrowLeft size={14} /> Previous
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={next} disabled={index === fields.length - 1}>
                    Next <ArrowRight size={14} />
                  </button>
                  <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>
                    Enter = next
                  </span>
                </div>
              </section>
            )}

            {/* Overview (FR-12.2 / FR-8.3) */}
            <section style={{
              borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
              background: 'var(--card-solid)', overflow: 'hidden',
            }}>
              <button
                onClick={() => setShowOverview((o) => !o)} aria-expanded={showOverview}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '10px 14px',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: '0.84rem', fontWeight: 700, color: 'var(--foreground)',
                }}>
                <Eye size={14} /> All questions
                {blockingCount > 0 && (
                  <span style={{
                    marginLeft: 'auto', fontSize: '0.72rem', fontWeight: 700,
                    color: 'var(--status-pending)',
                  }}>Fix {blockingCount} issue{blockingCount === 1 ? '' : 's'}</span>
                )}
              </button>
              {showOverview && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border)', maxHeight: '40vh', overflowY: 'auto' }}>
                  {fields.map((f, i) => {
                    const bad = touched[f.key] && errors[f.key];
                    const done = !errors[f.key] && answers[f.key] !== '' && answers[f.key] != null;
                    return (
                      <li key={f.key}>
                        <button onClick={() => goTo(i)} style={{
                          display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                          padding: '9px 14px', border: 'none', cursor: 'pointer',
                          fontFamily: 'var(--font-sans)', fontSize: '0.83rem',
                          background: i === index ? 'color-mix(in srgb, var(--primary) 7%, transparent)' : 'transparent',
                          color: 'var(--foreground)',
                        }}>
                          <span style={{ width: 18, fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>{i + 1}</span>
                          <span style={{ flex: 1 }}>{f.label || f.key}</span>
                          {bad ? <TriangleAlert size={13} style={{ color: 'var(--status-rejected)' }} />
                            : done ? <CheckCircle2 size={13} style={{ color: 'var(--status-approved)' }} />
                              : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        }
      />
      <div style={{ height: 40 }} />
    </div>
  );
}

function Banner({ tone, icon, children }: {
  tone: 'muted' | 'pending'; icon: React.ReactNode; children: React.ReactNode;
}) {
  const pending = tone === 'pending';
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', marginBottom: 14,
      borderRadius: 'var(--radius)', fontSize: '0.85rem',
      background: pending ? 'var(--status-pending-bg)' : 'var(--muted)',
      border: `1px solid ${pending ? 'color-mix(in srgb, var(--status-pending) 25%, transparent)' : 'var(--border)'}`,
      color: pending ? 'var(--status-pending)' : 'var(--muted-foreground)',
    }}>
      {icon}{children}
    </div>
  );
}
