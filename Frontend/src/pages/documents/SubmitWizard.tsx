/**
 * DocFlow Frontend — Page: Submission wizard (/documents/:id/submit)
 *
 * Spec §8.13 FR-13: stepper-driven Review → Workflow → Details → Confirm → Submit.
 * (Template/blank/upload skip the Form-Fill step — that split-view arrives in
 * Phase 2.) Details autosave via useAutosave (If-Match optimistic locking, §24);
 * a 409 opens the conflict dialog. Submit is guarded against double-fire and
 * creates the approval workflow through the existing submit endpoint.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FileText, Workflow as WorkflowIcon, ClipboardList, CheckCircle2, Lock, Sparkles } from 'lucide-react';
import { useDocument, useSubmitDocument, useDocumentContent, useDocumentFillSchema } from '@/hooks/useDocuments';
// Lazy: a static import here would drag TipTap + ProseMirror back into the
// main bundle, undoing the editor code-split (FR-6.8 / FR-15.5). The wizard
// itself must stay eager — it is reachable from the documents list.
const DocumentPreview = lazy(() =>
  import('@/components/editor/DocumentPreview').then((m) => ({ default: m.DocumentPreview })));
import {
  useWorkflowTemplateReview,
  useWorkflowsByScope,
  useWorkflowPreflight,
} from '@/hooks/useWorkflows';
import { AIReviewPanel } from '@/components/ai/AIReviewPanel';
import { useAIAvailability, useAIReview, useAIDecision } from '@/hooks/useAI';
import { useAutosave } from '@/hooks/useAutosave';
import type { UpdateDocumentPayload } from '@/lib/api/documents';
import type { WorkflowTemplateSummary } from '@/lib/api/workflows';
import { AISuggestDetails } from '@/components/documents/AISuggestDetails';
import { ContentMiniature } from '@/components/documents/ContentMiniature';
import { AttachmentsField } from '@/components/documents/AttachmentsField';
import { WatcherPicker } from '@/components/documents/WatcherPicker';
import { PageHeader } from '@/components/ui/PageHeader';
import { Stepper, type Step } from '@/components/ui/Stepper';
import { SaveIndicator } from '@/components/ui/SaveIndicator';
import { ConflictDialog } from '@/components/ui/ConflictDialog';
import { ValidationSummary, fieldProblemsOf } from '@/components/ui/ValidationSummary';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import StatusBadge from '@/components/ui/StatusBadge';
import documentsApi from '@/lib/api/documents';
import type { SubmitStage } from '@/lib/api/documents';
import type { FieldProblem } from '@/types';

/**
 * Where each server-side field name lives on this page, so a "Fix this"
 * link can focus it. Names the server can produce but this page has no
 * control for (the body, an unanswered template question) are deliberately
 * absent: those still show their message, without a dead link.
 */
const FIELD_IDS: Record<string, string> = {
  title: 'wiz-title',
  priority: 'wiz-priority',
  due_at: 'wiz-due',
  confidentiality: 'wiz-conf',
  tags: 'wiz-tags',
  effective_from: 'wiz-eff',
  expires_at: 'wiz-exp',
  reminder_days_before: 'wiz-remind',
  workflow_template_id: 'wiz-workflow',
};

const STEPS: Step[] = [
  { key: 'review', label: 'Review' },
  { key: 'workflow', label: 'Workflow' },
  { key: 'details', label: 'Details' },
  { key: 'confirm', label: 'Confirm' },
];

const labelStyle: React.CSSProperties = { display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--foreground)', marginBottom: 6 };
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function SubmitWizard() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const { data: doc, isLoading, refetch } = useDocument(id);
  const { data: body } = useDocumentContent(id);
  const { data: fillSchema } = useDocumentFillSchema(id);
  const submitDoc = useSubmitDocument();
  // WF-OWN-09: mine and shared-with-me are different things, and which is
  // which matters when choosing. `activeOnly: false` on purpose - an
  // unusable workflow is SHOWN and disabled with its reason (WF-SEL-08),
  // not hidden, so a submitter looking for one they know exists can see why
  // they cannot use it.
  const mineQ = useWorkflowsByScope('mine', { activeOnly: false });
  const sharedQ = useWorkflowsByScope('shared', { activeOnly: false });
  const templatesLoading = mineQ.isLoading || sharedQ.isLoading;
  const templates = useMemo(
    () => [...(mineQ.data ?? []), ...(sharedQ.data ?? [])],
    [mineQ.data, sharedQ.data],
  );

  const [step, setStep] = useState(0);
  const [maxReached, setMaxReached] = useState(0);

  // Details form
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('normal');
  const [due, setDue] = useState('');
  const [confidentiality, setConfidentiality] = useState('internal');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');
  // Submission details (FR-13.4). Dates are held as yyyy-MM-dd for the date
  // inputs and converted at the edges.
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [reminderDays, setReminderDays] = useState('');

  // Workflow + confirm
  const [templateId, setTemplateId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState('');
  // E — the server's answer for the step being left, plus any warnings.
  const [blockers, setBlockers] = useState<FieldProblem[]>([]);
  const [warnings, setWarnings] = useState<FieldProblem[]>([]);
  const [checking, setChecking] = useState(false);
  const [conflictBusy, setConflictBusy] = useState(false);
  const initedRef = useRef(false);
  // Stable per mounted wizard so every retry of this submission reuses one key
  // (server treats a repeat as the same submission — FR-13.7).
  const idempotencyKeyRef = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  // WF-OWN-09 / WF-SEL-08. SearchableSelect has no group headers, so the
  // grouping is carried by order (mine first) and by the hint line, which is
  // also what the search box matches on — so typing "shared" finds the
  // shared ones. An unusable workflow stays in the list and is disabled with
  // its reason, rather than silently absent.
  const workflowOptions = useMemo(() => {
    const toOption = (t: WorkflowTemplateSummary, group: 'Mine' | 'Shared with me') => {
      const reason = !t.is_active ? 'inactive — ask the owner to re-enable it' : null;
      return {
        value: t.id,
        label: t.name,
        hint: [group, `Version ${t.version}`, reason].filter(Boolean).join(' · '),
        disabled: !!reason,
      };
    };
    return [
      ...(mineQ.data ?? []).map((t) => toOption(t, 'Mine')),
      ...(sharedQ.data ?? []).map((t) => toOption(t, 'Shared with me')),
    ];
  }, [mineQ.data, sharedQ.data]);

  const { data: review, isLoading: reviewLoading } = useWorkflowTemplateReview(templateId || undefined);
  // WF-SEL-06 — resolve the chain for THIS submitter. The submit endpoint
  // re-runs the same check (WF-SUB-02), so this is an early warning, never
  // the authority.
  const preflightQ = useWorkflowPreflight(templateId || undefined);

  const metadataBase = useMemo(() => (doc?.metadata ?? {}) as Record<string, unknown>, [doc?.metadata]);

  // The review step shows the real document: the freeform body for a blank
  // document, or the template body with the user's answers filled in.
  const previewContent = body?.content ?? fillSchema?.content;
  const previewAnswers = fillSchema?.fields.length
    ? ((body?.answers ?? fillSchema.answers) as Record<string, unknown>)
    : undefined;
  const hasBody = !!previewContent
    && Array.isArray((previewContent as { content?: unknown[] }).content)
    && ((previewContent as { content: unknown[] }).content.length > 0);

  const autosave = useAutosave({
    docId: id,
    initialVersion: doc?.version ?? 1,
    enabled: !!doc && doc.status === 'draft',
    onConflict: () => { /* dialog shows via autosave.conflict */ },
  });

  const initFrom = (d: NonNullable<typeof doc>) => {
    setTitle(d.title || '');
    setPriority(d.priority || 'normal');
    setDue(d.due_at ? d.due_at.slice(0, 10) : '');
    setConfidentiality(d.confidentiality || 'internal');
    setTags((d.tags || []).join(', '));
    setNotes(((d.metadata?.notes as string) || ''));
    setDescription(((d.metadata?.description as string) || ''));
    setCategory(d.category || '');
    setEffectiveFrom(d.effective_from ? d.effective_from.slice(0, 10) : '');
    setExpiresAt(d.expires_at ? d.expires_at.slice(0, 10) : '');
    setReminderDays(
      d.reminder_days_before == null ? '' : String(d.reminder_days_before),
    );
    autosave.setVersion(d.version ?? 1);
    // Resume exactly where the draft was left (FR-14.5): the saved step and
    // every step before it are already reachable.
    const saved = STEPS.findIndex((s) => s.key === d.current_step);
    if (saved > 0) { setStep(saved); setMaxReached(saved); }
  };

  useEffect(() => {
    if (!doc || initedRef.current) return;
    initedRef.current = true;
    initFrom(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const buildFullPayload = (): UpdateDocumentPayload => ({
    title: title.trim() || 'Untitled document',
    priority,
    due_at: due ? new Date(due).toISOString() : null,
    confidentiality,
    tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
    metadata: { ...metadataBase, notes, description },
    category: category.trim() || null,
    effective_from: effectiveFrom ? new Date(effectiveFrom).toISOString() : null,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    reminder_days_before: reminderDays === '' ? null : Number(reminderDays),
    // Anything the user emptied has to be named explicitly: an omitted field
    // means "leave alone", so a null alone would not clear it.
    clear_fields: [
      ...(category.trim() ? [] : ['category']),
      ...(effectiveFrom ? [] : ['effective_from']),
      ...(expiresAt ? [] : ['expires_at']),
      ...(reminderDays === '' ? ['reminder_days_before'] : []),
    ],
  });

  const queue = (partial: UpdateDocumentPayload) => autosave.queueChange(partial);

  const goTo = (i: number) => {
    setStep(i);
    setMaxReached((m) => Math.max(m, i));
    setBlockers([]);
    setWarnings([]);
    queue({ current_step: STEPS[i].key });
  };

  /**
   * Ask the server whether this step may be left.
   *
   * Pending detail edits are flushed first, because the check reads the
   * stored document, not the form state — the two have to agree or the
   * answer is about the wrong draft. Returns true when the step may be left.
   *
   * A failed CHECK (offline, server down) does not block: the submit
   * endpoint re-validates everything, so the only cost of letting someone
   * walk forward here is that they find out one step later.
   */
  const checkStage = async (stage: SubmitStage): Promise<boolean> => {
    setChecking(true);
    try {
      await autosave.flush();
      const res = await documentsApi.submitCheck(id, {
        stage,
        workflow_template_id: templateId || null,
      });
      setBlockers(res.errors);
      setWarnings(res.warnings);
      return res.ok;
    } catch {
      setBlockers([]);
      setWarnings([]);
      return true;
    } finally {
      setChecking(false);
    }
  };

  // Arriving at Confirm runs the WHOLE check, so the final review shows
  // every outstanding problem instead of revealing them one at a time after
  // the Submit button is pressed.
  useEffect(() => {
    if (step !== STEPS.length - 1) return;
    void checkStage('confirm');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  /** Continue, but only if the server agrees. */
  const advance = async () => {
    // The first step is called "Review" in the UI but it is the document
    // itself that is being checked, which the server calls "write".
    const key = STEPS[step].key;
    const ok = await checkStage(key === 'review' ? 'write' : (key as SubmitStage));
    if (ok) goTo(step + 1);
  };

  const dueError = due && due < todayISO() ? 'Due date cannot be in the past.' : '';
  const titleValid = title.trim().length > 0;
  // Mirrors the server's own check, so the user sees it before the autosave
  // round-trip rather than as a failed save.
  const rangeError =
    effectiveFrom && expiresAt && expiresAt <= effectiveFrom
      ? 'The expiry date must be after the date it takes effect.'
      : '';
  const reminderError =
    reminderDays !== '' && !expiresAt
      ? 'Set an expiry date before choosing when to be reminded.'
      : '';
  const detailsValid = titleValid && !dueError && !rangeError && !reminderError;

  // ── AI pre-submission review (FR-10.4 / FR-13.6) ────────────────────────
  // Opt-in: the author asks for it. Running automatically would send every
  // document to a model whether or not anyone wanted the help.
  const ai = useAIAvailability();
  const aiReview = useAIReview();
  const recordAIDecision = useAIDecision();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const runAIReview = () => {
    setReviewOpen(true);
    // Only the id is sent: the server reads the stored body itself, so a
    // confidential document is never shipped back up from the browser.
    aiReview.mutate({ document_id: id });
  };

  const dismissAIReview = () => {
    recordAIDecision(aiReview.data?.interaction_id, false);
    setReviewOpen(false);
    aiReview.reset();
  };

  const canSubmit = detailsValid && !!templateId && confirmed
    && !submitDoc.isPending && !reviewLoading && !checking;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitError('');
    setBlockers([]);
    try {
      await autosave.flush();                        // persist any pending detail edits
      await submitDoc.mutateAsync({
        id,
        payload: { change_reason: 'Submitted for approval', workflow_template_id: templateId },
        idempotencyKey: idempotencyKeyRef.current,
      });
      navigate(`/documents/${id}`);
    } catch (err) {
      // A 422 carries the per-field breakdown; anything else is one message.
      const fields = fieldProblemsOf(err);
      if (fields.length > 0) {
        setBlockers(fields);
        setConfirmed(false);     // the author re-confirms once it is fixed
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Failed to submit document.');
      }
    }
  };

  // Conflict resolution (§24.3)
  const keepMine = async () => {
    setConflictBusy(true);
    try {
      const res = await refetch();
      if (res.data?.version != null) autosave.setVersion(res.data.version);
      autosave.queueChange(buildFullPayload());
      await autosave.flush();
    } finally { setConflictBusy(false); }
  };
  const loadLatest = async () => {
    setConflictBusy(true);
    try {
      const res = await refetch();
      if (res.data) initFrom(res.data);
      autosave.reset();
    } finally { setConflictBusy(false); }
  };

  if (isLoading) {
    return <div className="page-content" style={{ paddingTop: 48, textAlign: 'center' }}><div className="spinner" style={{ width: 32, height: 32, margin: '0 auto' }} /></div>;
  }
  if (!doc) {
    return <div className="page-content" style={{ paddingTop: 48, textAlign: 'center', color: 'var(--muted-foreground)' }}>Document not found.</div>;
  }
  if (doc.status !== 'draft') {
    return (
      <div className="page-content" style={{ paddingTop: 48, maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
        <span style={{ display: 'inline-flex', width: 48, height: 48, borderRadius: '50%', alignItems: 'center', justifyContent: 'center', background: 'var(--muted)', color: 'var(--muted-foreground)', marginBottom: 12 }}><Lock size={22} /></span>
        <p style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--foreground)' }}>This document has already been submitted</p>
        <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', marginBottom: 20 }}>Its status is <StatusBadge status={doc.status} />. Submission details are locked.</p>
        <button className="btn btn-secondary" onClick={() => navigate(`/documents/${id}`)}>Open document</button>
      </div>
    );
  }

  return (
    <div className="page-content" style={{ paddingTop: 24, maxWidth: 860, margin: '0 auto' }}>
      <button onClick={() => navigate(`/documents/${id}`)} className="btn btn-ghost btn-sm" style={{ marginBottom: 12, paddingLeft: 0 }}>← Back to document</button>
      <PageHeader
        breadcrumbs={[{ label: 'Documents' }, { label: doc.public_id }, { label: 'Submit' }]}
        title="Submit for approval"
        description="Choose the approval workflow, confirm the details, and submit."
        actions={<SaveIndicator state={autosave.state} lastSavedAt={autosave.lastSavedAt} onRetry={() => autosave.flush()} />}
      />
      <div style={{ height: 20 }} />

      <div style={{ padding: '18px 20px', background: 'var(--card-solid)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', marginBottom: 20 }}>
        <Stepper steps={STEPS} current={step} maxReached={maxReached} onStepClick={goTo} />
      </div>

      <motion.div key={step} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
        className="glass-card" style={{ padding: 28 }}>

        <ValidationSummary errors={blockers} warnings={warnings} fieldIds={FIELD_IDS} />

        {/* ── Review ── */}
        {step === 0 && (
          <div>
            <StepTitle icon={<FileText size={18} />}>Review document</StepTitle>
            <Row label="Title">{doc.title}</Row>
            <Row label="Reference">{doc.public_id}</Row>
            <Row label="Type">{doc.doc_type_name || '—'}</Row>
            <Row label="Source">{doc.source || 'template'}</Row>
            <Row label="Status"><StatusBadge status={doc.status} /></Row>

            {/* FR-13.6 / FR-12.5 — the real document, with answers in place. */}
            {hasBody ? (
              <div style={{ marginTop: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                    Document preview
                  </span>
                  {fillSchema?.fields.length ? (
                    <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                      onClick={() => navigate(`/documents/${id}/fill`)}>
                      Edit answers
                    </button>
                  ) : doc.source === 'blank' ? (
                    <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                      onClick={() => navigate(`/documents/${id}/edit`)}>
                      Edit document
                    </button>
                  ) : null}
                </div>
                <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
                  <Suspense fallback={<div className="skeleton" style={{ height: 260, borderRadius: 'var(--radius)' }} />}>
                    <DocumentPreview content={previewContent} answers={previewAnswers} plain />
                  </Suspense>
                </div>
              </div>
            ) : (
              <p style={{ fontSize: '0.82rem', color: 'var(--muted-foreground)', marginTop: 12 }}>
                {doc.source === 'upload'
                  ? 'This document is the file you uploaded; it is submitted exactly as it is.'
                  : 'This document has no written body — its details are captured in the fields above.'}
              </p>
            )}

            {ai.enabled && hasBody && !reviewOpen && (
              <button type="button" onClick={runAIReview} className="btn btn-secondary btn-sm"
                style={{ marginTop: 16 }}>
                <Sparkles size={14} /> Check with AI before submitting
              </button>
            )}

            <AIReviewPanel
              open={reviewOpen}
              loading={aiReview.isPending}
              error={aiReview.isError
                ? (aiReview.error instanceof Error ? aiReview.error.message : 'AI assistance is unavailable right now.')
                : null}
              findings={aiReview.data?.findings ?? []}
              truncated={aiReview.data?.truncated ?? false}
              hasResult={aiReview.isSuccess}
              onDismiss={dismissAIReview}
              onRetry={runAIReview}
            />
          </div>
        )}

        {/* ── Workflow ── */}
        {step === 1 && (
          <div>
            <StepTitle icon={<WorkflowIcon size={18} />}>Choose approval workflow</StepTitle>
            {templatesLoading ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)' }}>Loading workflows…</p>
            ) : templates.length === 0 ? (
              <div style={{ padding: '12px 14px', borderRadius: 'var(--radius)', background: 'var(--status-pending-bg)', border: '1px solid color-mix(in srgb, var(--status-pending) 25%, transparent)', color: 'var(--status-pending)', fontSize: '0.85rem' }}>
                No approval workflows exist yet. Ask an admin to create one under Admin → Workflow Templates.
              </div>
            ) : (
              <>
                <label style={labelStyle} htmlFor="wiz-workflow">Workflow <span style={{ color: 'var(--status-rejected)' }}>*</span></label>
                {/* FR-13.2 — searchable. A native select is unusable once an
                    org has more than a handful of workflows, which is the
                    normal case for the orgs this is built for.

                    WF-OWN-09 — grouped into mine and shared-with-me.
                    WF-SEL-08 — an unusable workflow is listed and disabled
                    with its reason, rather than quietly missing: a submitter
                    hunting for one they know exists needs to see why it is
                    not available. */}
                <SearchableSelect
                  id="wiz-workflow"
                  value={templateId}
                  onChange={(next) => {
                    setTemplateId(next); setConfirmed(false); setBlockers([]); setWarnings([]);
                  }}
                  options={workflowOptions}
                  placeholder="Search workflows by name"
                  emptyText="No workflow matches that search"
                  required
                />

                {/* WF-SEL-06 / E1 / E2 — what would actually happen if this
                    person submitted through this workflow. The static check
                    in document_validation.py inspects the approver RULES, so
                    it passes a "submitter's manager" rule without knowing
                    that THIS submitter has no manager on record. Without
                    this panel the run was created with no approval steps at
                    all: the document sat in PENDING, nobody was notified,
                    and nobody could act on it. */}
                {templateId && preflightQ.data && !preflightQ.data.can_submit && (
                  <div
                    role="alert"
                    style={{
                      marginTop: 16, padding: '12px 14px',
                      borderRadius: 'var(--radius)',
                      background: 'var(--status-rejected-bg)',
                      border: '1px solid color-mix(in srgb, var(--status-rejected) 28%, transparent)',
                      color: 'var(--status-rejected)', fontSize: '0.85rem',
                    }}
                  >
                    <strong style={{ display: 'block', marginBottom: 6 }}>
                      This workflow cannot be used for this document yet
                    </strong>
                    <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                      {preflightQ.data.blockers.map((b) => <li key={b}>{b}</li>)}
                    </ul>
                  </div>
                )}
                {templateId && (preflightQ.data?.warnings.length ?? 0) > 0 && (
                  <div style={{
                    marginTop: 12, padding: '10px 14px',
                    borderRadius: 'var(--radius)',
                    background: 'var(--status-pending-bg)',
                    color: 'var(--status-pending)', fontSize: '0.83rem',
                  }}>
                    {preflightQ.data!.warnings.map((w) => <div key={w}>{w}</div>)}
                  </div>
                )}

                {templateId && (
                  <div style={{ marginTop: 16 }}>
                    {/* Not a <label>: it names the list below, not a form
                        control, and announcing it as a label pointed
                        screen-reader users at nothing. */}
                    <span style={labelStyle}>Approval sequence</span>
                    {/* Prefers preflight's resolved names over /review's
                        generic description ("Submitter's manager"), because
                        a name is what the submitter can actually check
                        (WF-SEL-04). Falls back to /review while preflight is
                        in flight or if it fails. */}
                    {reviewLoading && !preflightQ.data ? (
                      <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)' }}>Loading approvers…</p>
                    ) : (preflightQ.data?.stages.length ?? 0) > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {preflightQ.data!.stages.map((s) => (
                          <div
                            key={s.stage_id}
                            style={{
                              display: 'flex', gap: 10, padding: '10px 12px',
                              borderRadius: 'var(--radius)',
                              background: 'var(--muted)',
                              border: s.blocker
                                ? '1px solid color-mix(in srgb, var(--status-rejected) 45%, transparent)'
                                : '1px solid var(--border)',
                            }}
                          >
                            <span style={{
                              flexShrink: 0, width: 22, height: 22, borderRadius: '50%',
                              background: s.blocker ? 'var(--status-rejected)' : 'var(--primary)',
                              color: 'var(--primary-foreground)', fontSize: '0.75rem',
                              fontWeight: 700, display: 'flex', alignItems: 'center',
                              justifyContent: 'center',
                            }}>{s.position}</span>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--foreground)' }}>{s.name}</div>
                              <div style={{
                                fontSize: '0.8rem',
                                color: s.blocker ? 'var(--status-rejected)' : 'var(--muted-foreground)',
                              }}>
                                {s.blocker ? s.blocker : `Approver: ${s.approver_summary}`}
                              </div>
                              <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', marginTop: 2 }}>
                                {s.sla_hours ? `Due within ${s.sla_hours}h` : 'No deadline set'}
                                {/* WF-STG-21: said here so a signature
                                    requirement forced on by the resolved
                                    approver's department does not appear out
                                    of nowhere at the approval screen. */}
                                {s.requires_signature
                                  ? ` · Requires e-signature${s.signing_reason ? ` (${s.signing_reason})` : ''}`
                                  : ''}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : review && review.stages.length === 0 ? (
                      <div style={{ fontSize: '0.85rem', color: 'var(--status-pending)' }}>This workflow has no stages configured.</div>
                    ) : null}
                  </div>
                )}
                <p style={{ fontSize: '0.78rem', color: 'var(--muted-foreground)', marginTop: 12 }}>Creating a new workflow here arrives when the workflow builder is linked (feature-flagged).</p>
              </>
            )}
          </div>
        )}

        {/* ── Details ── */}
        {step === 2 && (
          <div>
            <StepTitle icon={<ClipboardList size={18} />}>Submission details</StepTitle>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={labelStyle} htmlFor="wiz-title">Title <span style={{ color: 'var(--status-rejected)' }}>*</span></label>
                <input id="wiz-title" className="input" value={title} onChange={(e) => { setTitle(e.target.value); queue({ title: e.target.value }); }} />
                {!titleValid && <p style={{ fontSize: '0.78rem', color: 'var(--status-rejected)', marginTop: 4 }}>This field is required.</p>}
              </div>
              <div>
                <label style={labelStyle} htmlFor="wiz-priority">Priority</label>
                <select id="wiz-priority" className="input" value={priority} onChange={(e) => { setPriority(e.target.value); queue({ priority: e.target.value }); }}>
                  <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
                </select>
              </div>
              <div>
                <label style={labelStyle} htmlFor="wiz-due">Due date</label>
                <input id="wiz-due" type="date" className="input" value={due} min={todayISO()}
                  onChange={(e) => { setDue(e.target.value); queue({ due_at: e.target.value ? new Date(e.target.value).toISOString() : null }); }} />
                {dueError && <p style={{ fontSize: '0.78rem', color: 'var(--status-rejected)', marginTop: 4 }}>{dueError}</p>}
              </div>
              <div>
                <label style={labelStyle} htmlFor="wiz-conf">Confidentiality</label>
                <select id="wiz-conf" className="input" value={confidentiality} onChange={(e) => { setConfidentiality(e.target.value); queue({ confidentiality: e.target.value }); }}>
                  <option value="public">Public</option><option value="internal">Internal</option><option value="confidential">Confidential</option>
                </select>
              </div>
              <div>
                <label style={labelStyle} htmlFor="wiz-tags">Tags (comma-separated)</label>
                <input id="wiz-tags" className="input" value={tags} onChange={(e) => { setTags(e.target.value); queue({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) }); }} />
              </div>
              <div>
                <label style={labelStyle} htmlFor="wiz-category">Category</label>
                <input
                  id="wiz-category"
                  className="input"
                  value={category}
                  placeholder="e.g. Procurement"
                  onChange={(e) => {
                    setCategory(e.target.value);
                    queue(
                      e.target.value.trim()
                        ? { category: e.target.value.trim() }
                        : { clear_fields: ['category'] },
                    );
                  }}
                />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={labelStyle} htmlFor="wiz-desc">Description (optional)</label>
                <textarea
                  id="wiz-desc"
                  className="input"
                  rows={2}
                  value={description}
                  placeholder="One line on what this document is for"
                  onChange={(e) => {
                    setDescription(e.target.value);
                    queue({ metadata: { ...metadataBase, notes, description: e.target.value } });
                  }}
                  style={{ resize: 'vertical' }}
                />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={labelStyle} htmlFor="wiz-notes">Notes for approvers (optional)</label>
                <textarea id="wiz-notes" className="input" rows={3} value={notes} onChange={(e) => { setNotes(e.target.value); queue({ metadata: { ...metadataBase, notes: e.target.value } }); }} style={{ resize: 'vertical' }} />
              </div>
            </div>

            {/* FR-13.5 — opt-in; it runs when asked, not on arrival. */}
            <div style={{ marginTop: 16, display: 'grid' }}>
              <AISuggestDetails
                docId={id}
                onApplyTitle={(t) => { setTitle(t); queue({ title: t }); }}
                onApplyDescription={(d) => {
                  setDescription(d);
                  queue({ metadata: { ...metadataBase, notes, description: d } });
                }}
                onApplyPriority={(p) => { setPriority(p); queue({ priority: p }); }}
              />
            </div>

            {/* Effective / expiry dates and the reminder (FR-13.4). Kept apart
                from the fields above because these three are interdependent:
                the reminder counts back from the expiry date. */}
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
              <h3 style={{ margin: '0 0 4px', fontSize: '0.82rem', fontWeight: 700, color: 'var(--foreground)' }}>
                Validity
              </h3>
              <p style={{ margin: '0 0 14px', fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>
                When this document applies from and until. Separate from the due
                date, which is the deadline for the approvers.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 18 }}>
                <div>
                  <label style={labelStyle} htmlFor="wiz-eff">Takes effect</label>
                  <input
                    id="wiz-eff"
                    type="date"
                    className="input"
                    value={effectiveFrom}
                    onChange={(e) => {
                      setEffectiveFrom(e.target.value);
                      queue(
                        e.target.value
                          ? { effective_from: new Date(e.target.value).toISOString() }
                          : { clear_fields: ['effective_from'] },
                      );
                    }}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="wiz-exp">Expires</label>
                  <input
                    id="wiz-exp"
                    type="date"
                    className="input"
                    value={expiresAt}
                    min={effectiveFrom || undefined}
                    onChange={(e) => {
                      setExpiresAt(e.target.value);
                      if (e.target.value) {
                        queue({ expires_at: new Date(e.target.value).toISOString() });
                      } else {
                        // Dropping the expiry date drops the reminder with it:
                        // the server rejects a reminder that has nothing to
                        // count back from, so leaving it set would block every
                        // later save with a validation error.
                        setReminderDays('');
                        queue({ clear_fields: ['expires_at', 'reminder_days_before'] });
                      }
                    }}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="wiz-remind">Remind me</label>
                  <select
                    id="wiz-remind"
                    className="input"
                    value={reminderDays}
                    disabled={!expiresAt}
                    onChange={(e) => {
                      setReminderDays(e.target.value);
                      queue(
                        e.target.value === ''
                          ? { clear_fields: ['reminder_days_before'] }
                          : { reminder_days_before: Number(e.target.value) },
                      );
                    }}
                  >
                    <option value="">No reminder</option>
                    <option value="7">7 days before expiry</option>
                    <option value="14">14 days before expiry</option>
                    <option value="30">30 days before expiry</option>
                    <option value="60">60 days before expiry</option>
                    <option value="90">90 days before expiry</option>
                  </select>
                  {!expiresAt && (
                    <p style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)', marginTop: 4 }}>
                      Needs an expiry date.
                    </p>
                  )}
                </div>
              </div>
              {(rangeError || reminderError) && (
                <p role="alert" style={{ fontSize: '0.78rem', color: 'var(--status-rejected)', marginTop: 8 }}>
                  {rangeError || reminderError}
                </p>
              )}
              {reminderDays !== '' && expiresAt && !rangeError && (
                <p style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)', marginTop: 8 }}>
                  You and any watchers will be notified {reminderDays} days before{' '}
                  {new Date(expiresAt).toLocaleDateString()}.
                </p>
              )}
            </div>

            {/* Attachments and watchers write through their own endpoints
                rather than the autosave payload, so each change is saved as
                soon as it is made. */}
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border)', display: 'grid', gap: 22 }}>
              <AttachmentsField docId={id} />
              <WatcherPicker docId={id} />
            </div>
          </div>
        )}

        {/* ── Confirm ── */}
        {step === 3 && (
          <div>
            <StepTitle icon={<CheckCircle2 size={18} />}>Final review</StepTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 20 }}>
              <SummaryCard title="Document" onEdit={() => goTo(0)}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <ContentMiniature
                    content={previewContent}
                    width={92}
                    height={68}
                    emptyLabel="No body"
                  />
                  <div style={{ minWidth: 0, display: 'grid', gap: 3 }}>
                    <div style={{
                      fontWeight: 600, color: 'var(--foreground)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{title}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                      {doc.public_id} · {doc.doc_type_name}
                    </div>
                    {hasBody && (
                      <button
                        type="button"
                        onClick={() => setPreviewOpen(true)}
                        className="btn btn-ghost btn-sm"
                        style={{ justifySelf: 'start', padding: '2px 6px', fontSize: '0.74rem' }}
                      >
                        Open full preview
                      </button>
                    )}
                  </div>
                </div>
              </SummaryCard>
              <SummaryCard title="Workflow" onEdit={() => goTo(1)}>
                <div style={{ fontWeight: 600, color: 'var(--foreground)' }}>{templates.find((t) => t.id === templateId)?.name || <span style={{ color: 'var(--status-rejected)' }}>Not selected</span>}</div>
                {review && review.stages.length > 0 && (
                  <ol style={{
                    listStyle: 'none', margin: '8px 0 0', padding: 0,
                    display: 'grid', gap: 5,
                  }}>
                    {review.stages.map((s, i) => (
                      <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                        <span style={{
                          flexShrink: 0, width: 16, height: 16, marginTop: 1,
                          borderRadius: '50%', background: 'var(--primary)',
                          color: 'var(--primary-foreground)', fontSize: '0.6rem',
                          fontWeight: 700, display: 'grid', placeItems: 'center',
                        }}>{i + 1}</span>
                        <span style={{ minWidth: 0 }}>
                          <span style={{
                            display: 'block', fontSize: '0.78rem', fontWeight: 600,
                            color: 'var(--foreground)', overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{s.name}</span>
                          <span style={{
                            display: 'block', fontSize: '0.72rem',
                            color: 'var(--muted-foreground)', overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {s.approver_summary}{s.sla_hours ? ` \u00b7 ${s.sla_hours}h` : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                {review && review.stages.length === 0 && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--status-pending-fg)' }}>
                    This workflow has no stages configured.
                  </div>
                )}
              </SummaryCard>
              <SummaryCard title="Details" onEdit={() => goTo(2)}>
                <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>Priority: {priority}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>Due: {due || '—'} · {confidentiality}</div>
                {category.trim() && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>Category: {category.trim()}</div>
                )}
                {(effectiveFrom || expiresAt) && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                    Valid: {effectiveFrom || '—'} → {expiresAt || 'no end date'}
                  </div>
                )}
                {reminderDays !== '' && expiresAt && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                    Reminder: {reminderDays} days before expiry
                  </div>
                )}
                {(doc.watcher_count ?? 0) > 0 && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                    {doc.watcher_count} watcher{doc.watcher_count === 1 ? '' : 's'}
                  </div>
                )}
              </SummaryCard>
            </div>

            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', borderRadius: 'var(--radius)',
              background: confirmed ? 'var(--status-approved-bg)' : 'var(--muted)',
              border: `1px solid ${confirmed ? 'color-mix(in srgb, var(--status-approved) 30%, transparent)' : 'var(--border)'}`, cursor: 'pointer',
            }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
              <span style={{ fontSize: '0.85rem', color: 'var(--foreground)' }}>I confirm the information in this document is correct.</span>
            </label>

            {submitError && <div role="alert" style={{ marginTop: 14, padding: '12px 16px', borderRadius: 'var(--radius)', background: 'var(--status-rejected-bg)', color: 'var(--status-rejected)', fontSize: '0.85rem', fontWeight: 600 }}>{submitError}</div>}
          </div>
        )}

        {/* Nav */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-ghost" onClick={() => (step === 0 ? navigate(`/documents/${id}`) : goTo(step - 1))}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary"
              disabled={checking || (step === 1 && !templateId) || (step === 2 && !detailsValid)}
              onClick={advance}>{checking ? 'Checking…' : 'Continue →'}</button>
          ) : (
            <button className="btn btn-primary" disabled={!canSubmit} onClick={handleSubmit}>
              {submitDoc.isPending ? 'Submitting…' : 'Submit for approval'}
            </button>
          )}
        </div>
      </motion.div>

      <ConflictDialog open={autosave.conflict} onKeepMine={keepMine} onLoadLatest={loadLatest} busy={conflictBusy} />

      {/* FR-13.6 "Open full preview". Reuses the same lazy DocumentPreview as
          step 1, so opening it pulls no extra code. */}
      {previewOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Document preview"
          // Escape closes it; the scrim's own click is handled by the
          // button below rather than by the backdrop element, so no
          // non-interactive element carries a mouse handler.
          onKeyDown={(e) => { if (e.key === 'Escape') setPreviewOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            background: 'var(--overlay-scrim)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '40px 16px', overflowY: 'auto',
          }}
        >
          {/* Click-to-close, as a real button. A <div> with an onClick is
              invisible to assistive tech and fails
              no-noninteractive-element-interactions; tabIndex -1 keeps it out
              of the tab order, because the header already has a Close button
              and two ways to close is one too many to tab through. */}
          <button
            type="button"
            aria-label="Close the preview"
            tabIndex={-1}
            onClick={() => setPreviewOpen(false)}
            style={{
              position: 'absolute', inset: 0, zIndex: 0,
              background: 'transparent', border: 'none', cursor: 'default',
            }}
          />
          <div
            className="glass-card"
            style={{
              position: 'relative', zIndex: 1,
              width: '100%', maxWidth: 860, padding: 24, display: 'grid', gap: 14,
            }}
          >
            <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--foreground)' }}>
                {title || doc.title}
              </h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>
                {doc.public_id}
              </span>
              <button
                type="button"
                autoFocus
                onClick={() => setPreviewOpen(false)}
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 'auto' }}
              >
                Close
              </button>
            </header>
            <Suspense fallback={
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted-foreground)' }}>
                Loading preview…
              </div>
            }>
              <DocumentPreview content={previewContent} answers={previewAnswers} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

// ── small presentational helpers ────────────────────────────────────────────────
function StepTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '1.15rem', fontWeight: 700, color: 'var(--foreground)', marginBottom: 18 }}>
      <span style={{ color: 'var(--primary)' }}>{icon}</span>{children}
    </h2>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '0.88rem' }}>
      <span style={{ width: 120, flexShrink: 0, color: 'var(--muted-foreground)' }}>{label}</span>
      <span style={{ color: 'var(--foreground)', fontWeight: 500 }}>{children}</span>
    </div>
  );
}
function SummaryCard({ title, onEdit, children }: { title: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <div style={{ padding: 16, borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted-foreground)' }}>{title}</span>
        <button onClick={onEdit} style={{ fontSize: '0.75rem', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Edit</button>
      </div>
      {children}
    </div>
  );
}
