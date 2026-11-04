/**
 * DocFlow — write with AI (spec FR-10.1).
 *
 * A side panel the author opens deliberately — from the toolbar, or by typing
 * "/ai" in the body. They say what they want in their own words, the server
 * writes a passage, and it sits here until they press Insert. Nothing is ever
 * put into the document automatically: the panel holds the draft, the editor
 * only receives it on an explicit action (FR-10.4).
 *
 * What leaves the browser is the instruction plus, at most, the paragraph the
 * cursor is in — never the document. The reply is plain text, so a model that
 * ignores the "no markdown" rule cannot smuggle nodes into the body.
 *
 * Non-streaming: every provider in `app/ai/providers` is request/response, so
 * the honest presentation of the wait is a labelled loading state rather than
 * a fake typing effect.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCcw, Sparkles, X } from 'lucide-react';

import { ConfidenceBadge } from './ConfidenceBadge';
import { useAIDecision, useAIDraft } from '@/hooks/useAI';
import type { Confidence } from '@/lib/api/ai';

const EXAMPLES = [
  'A two-paragraph confidentiality clause',
  'A short covering note for this document',
  'A list of the documents the employee must provide',
];

export interface AIAssistantPanelProps {
  open: boolean;
  onClose: () => void;
  /** Called with the accepted text. The caller decides where it lands. */
  onInsert: (text: string) => void;
  /** The paragraph the cursor is in, for tone. Optional, never the body. */
  getContext?: () => string;
  templateId?: string;
  documentId?: string;
}

export function AIAssistantPanel({
  open, onClose, onInsert, getContext, templateId, documentId,
}: AIAssistantPanelProps) {
  const draft = useAIDraft();
  const recordDecision = useAIDecision();
  const [instruction, setInstruction] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  if (!open) return null;

  const result = draft.data;

  const run = () => {
    if (!instruction.trim() || draft.isPending) return;
    draft.mutate({
      instruction: instruction.trim(),
      context: (getContext?.() || '').slice(0, 1500),
      template_id: templateId ?? null,
      document_id: documentId ?? null,
    });
  };

  const insert = () => {
    if (!result) return;
    recordDecision(result.interaction_id, true);
    onInsert(result.text);
    draft.reset();
    setInstruction('');
    onClose();
  };

  const discard = () => {
    // Rejections are recorded too, or the audit trail would imply every
    // suggestion was taken (FR-10.4).
    if (result) recordDecision(result.interaction_id, false);
    draft.reset();
  };

  const close = () => { discard(); onClose(); };

  const errorText = draft.isError
    ? (draft.error instanceof Error ? draft.error.message : 'AI assistance is unavailable right now.')
    : null;

  return (
    <aside
      aria-label="Write with AI"
      style={{
        display: 'grid', gap: 12, alignContent: 'start', padding: 14,
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        background: 'var(--card-solid)', boxShadow: 'var(--shadow-sm)',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkles size={15} style={{ color: 'var(--accent-violet)' }} />
        <h3 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 700, color: 'var(--foreground)' }}>
          Write with AI
        </h3>
        <button
          type="button" onClick={close} aria-label="Close the AI panel"
          className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', padding: '2px 6px' }}
        >
          <X size={14} />
        </button>
      </header>

      <label htmlFor="ai-instruction" className="sr-only">What would you like written?</label>
      <textarea
        id="ai-instruction"
        ref={inputRef}
        className="input"
        rows={3}
        value={instruction}
        placeholder="Describe what you want written…"
        onChange={(e) => setInstruction(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
        }}
        style={{ resize: 'vertical', fontSize: '0.84rem' }}
      />

      {!result && !draft.isPending && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {EXAMPLES.map((ex) => (
            <button
              key={ex} type="button" onClick={() => setInstruction(ex)}
              style={{
                padding: '4px 9px', fontSize: '0.74rem', fontFamily: 'var(--font-sans)',
                borderRadius: 'var(--radius-pill)', border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--muted-foreground)', cursor: 'pointer',
              }}
            >{ex}</button>
          ))}
        </div>
      )}

      <button
        type="button" onClick={run}
        disabled={!instruction.trim() || draft.isPending}
        className="btn btn-primary btn-sm"
        style={{ justifySelf: 'start' }}
      >
        {draft.isPending
          ? <><Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} /> Writing…</>
          : <>Write it</>}
      </button>

      {draft.isPending && (
        <p role="status" style={{ margin: 0, fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
          This usually takes a few seconds. Nothing is added to your document until you press Insert.
        </p>
      )}

      {errorText && (
        <div role="alert" style={{ display: 'grid', gap: 8 }}>
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--status-rejected)', fontWeight: 600 }}>
            {errorText}
          </p>
          <button type="button" onClick={run} className="btn btn-secondary btn-sm" style={{ justifySelf: 'start' }}>
            <RotateCcw size={13} /> Try again
          </button>
        </div>
      )}

      {result && (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--muted-foreground)' }}>
              Suggested
            </span>
            <ConfidenceBadge level={result.confidence as Confidence} />
          </div>
          <div style={{
            maxHeight: 280, overflow: 'auto', padding: '10px 12px',
            borderRadius: 'var(--radius)', background: 'var(--muted)',
            fontSize: '0.83rem', lineHeight: 1.65, color: 'var(--foreground)',
            whiteSpace: 'pre-wrap',
          }}>{result.text}</div>
          {result.note && (
            <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--muted-foreground)' }}>{result.note}</p>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={insert} className="btn btn-primary btn-sm">
              Insert at cursor
            </button>
            <button type="button" onClick={discard} className="btn btn-ghost btn-sm">
              Discard
            </button>
          </div>
          <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>
            Check it before you use it. Any <code>___</code> it wrote becomes a blank when inserted.
          </p>
        </div>
      )}
    </aside>
  );
}

export default AIAssistantPanel;
