/**
 * DocFlow — AI-suggested submission details (spec FR-13.5).
 *
 * Proposes a title, a one-line description and a priority. Each one is
 * applied individually, or all three at once, and nothing happens until the
 * author presses something — same accept/reject rule as every other AI
 * surface here (FR-10.2).
 *
 * Opt-in: it runs when asked, not on arrival at the step. Running it
 * automatically would send every document to a model whether or not anyone
 * wanted the help.
 */
import { useState } from 'react';
import { Sparkles, Check, X, Loader2, RotateCcw } from 'lucide-react';
import { useAIAvailability, useAISuggestDetails, useAIDecision } from '@/hooks/useAI';
import { ConfidenceBadge } from '@/components/ai/ConfidenceBadge';
import type { Confidence } from '@/lib/api/ai';

export interface AISuggestDetailsProps {
  docId: string;
  onApplyTitle: (title: string) => void;
  onApplyDescription: (description: string) => void;
  onApplyPriority: (priority: string) => void;
}

export function AISuggestDetails({
  docId, onApplyTitle, onApplyDescription, onApplyPriority,
}: AISuggestDetailsProps) {
  const ai = useAIAvailability();
  const suggest = useAISuggestDetails();
  const recordDecision = useAIDecision();
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState<Set<string>>(new Set());

  if (!ai.enabled) return null;

  const data = suggest.data;

  const run = () => {
    setOpen(true);
    setUsed(new Set());
    suggest.mutate({ document_id: docId });
  };

  const dismiss = () => {
    recordDecision(data?.interaction_id, false);
    setOpen(false);
    setUsed(new Set());
    suggest.reset();
  };

  const mark = (field: string) => {
    const next = new Set(used);
    next.add(field);
    setUsed(next);
    // The first thing they take counts as acceptance for the audit trail.
    if (used.size === 0) recordDecision(data?.interaction_id, true);
  };

  const applyAll = () => {
    if (!data) return;
    if (data.title) onApplyTitle(data.title);
    if (data.description) onApplyDescription(data.description);
    if (data.priority) onApplyPriority(data.priority);
    recordDecision(data.interaction_id, true);
    setUsed(new Set(['title', 'description', 'priority']));
  };

  if (!open) {
    return (
      <button type="button" onClick={run} className="btn btn-secondary btn-sm"
        style={{ justifySelf: 'start', fontSize: '0.78rem' }}>
        <Sparkles size={14} /> Suggest title and priority
      </button>
    );
  }

  return (
    <section
      aria-live="polite"
      style={{
        display: 'grid', gap: 10, padding: '13px 15px',
        borderRadius: 'var(--radius)', border: '1px solid var(--border)',
        background: 'var(--card-solid)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Sparkles size={14} style={{ color: 'var(--accent-violet)' }} aria-hidden="true" />
        <h3 style={{ margin: 0, fontSize: '0.84rem', fontWeight: 700, color: 'var(--foreground)' }}>
          Suggested details
        </h3>
        {data && <ConfidenceBadge level={data.confidence as Confidence} />}
        <button type="button" onClick={dismiss} className="btn btn-ghost btn-sm"
          aria-label="Dismiss suggestions" style={{ marginLeft: 'auto', padding: '3px 6px' }}>
          <X size={14} />
        </button>
      </header>

      {suggest.isPending && (
        <p style={{
          display: 'flex', alignItems: 'center', gap: 8, margin: 0,
          fontSize: '0.82rem', color: 'var(--muted-foreground)',
        }}>
          <Loader2 size={14} style={{ animation: 'spin 0.8s linear infinite' }} />
          Reading your document…
        </p>
      )}

      {suggest.isError && (
        <div style={{ display: 'grid', gap: 8 }}>
          <p role="alert" style={{ margin: 0, fontSize: '0.82rem', color: 'var(--status-rejected-fg)' }}>
            {suggest.error instanceof Error
              ? suggest.error.message
              : 'AI assistance is unavailable right now.'}
          </p>
          <button type="button" onClick={run} className="btn btn-ghost btn-sm"
            style={{ justifySelf: 'start' }}>
            <RotateCcw size={13} /> Try again
          </button>
        </div>
      )}

      {data && !suggest.isPending && (
        <>
          <Row label="Title" value={data.title} applied={used.has('title')}
            onApply={() => { if (data.title) { onApplyTitle(data.title); mark('title'); } }} />
          <Row label="Description" value={data.description} applied={used.has('description')}
            onApply={() => {
              if (data.description) { onApplyDescription(data.description); mark('description'); }
            }} />
          <Row label="Priority" value={data.priority} applied={used.has('priority')}
            onApply={() => { if (data.priority) { onApplyPriority(data.priority); mark('priority'); } }} />

          {data.reason && (
            <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
              {data.reason}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={applyAll} className="btn btn-secondary btn-sm"
              disabled={used.size >= 3}>
              <Check size={13} /> Use all
            </button>
            <button type="button" onClick={run} className="btn btn-ghost btn-sm">
              <RotateCcw size={13} /> Regenerate
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Row({ label, value, applied, onApply }: {
  label: string; value: string | null; applied: boolean; onApply: () => void;
}) {
  if (!value) {
    return (
      <div style={{ display: 'flex', gap: 10, fontSize: '0.8rem' }}>
        <span style={{ minWidth: 86, color: 'var(--muted-foreground)', fontWeight: 600 }}>{label}</span>
        <span style={{ color: 'var(--muted-foreground)', fontStyle: 'italic' }}>
          nothing suggested
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: '0.8rem' }}>
      <span style={{ minWidth: 86, color: 'var(--muted-foreground)', fontWeight: 600, paddingTop: 2 }}>
        {label}
      </span>
      <span style={{ flex: 1, minWidth: 0, color: 'var(--foreground)' }}>{value}</span>
      <button
        type="button"
        onClick={onApply}
        disabled={applied}
        className={applied ? 'btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm'}
        style={{ flexShrink: 0, fontSize: '0.74rem', padding: '2px 8px' }}
      >
        {applied ? <><Check size={12} /> Used</> : 'Use'}
      </button>
    </div>
  );
}

export default AISuggestDetails;
