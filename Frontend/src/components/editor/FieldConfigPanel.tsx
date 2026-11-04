/**
 * DocFlow — Field Configuration panel (author time)
 *
 * Spec §8.8 FR-8.2/8.3/8.5 (split view, "Question k of N", bi-directional
 * navigation, "Fix n issues") and §8.7 FR-7.4/7.6/7.7 (linked placeholders,
 * field types, full property set).
 *
 * This is the RIGHT pane of the Template Studio split view. The left pane is a
 * read-only DocumentPreview; the two are kept in step by `activeKey`.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Link2, Link2Off, ListChecks,
  Sparkles, Loader2,
} from 'lucide-react';
import type { TemplateField, PlaceholderOccurrence } from '@/lib/api/templates';
import { useAIAvailability, useSuggestField, useAIDecision } from '@/hooks/useAI';
import { QuestionReorderList } from './QuestionReorderList';
import { ConfidenceBadge, AIBadge } from '@/components/ai/ConfidenceBadge';

/** FR-7.6 — the first-release field types, in the order authors meet them. */
export const FIELD_TYPES: { value: string; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'date', label: 'Date' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'radio', label: 'Radio buttons' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'yesno', label: 'Yes / No' },
];

const CHOICE_TYPES = new Set(['dropdown', 'radio']);
const NUMERIC_TYPES = new Set(['number', 'currency']);
const TEXTUAL_TYPES = new Set(['text', 'textarea', 'email', 'phone']);

export function fieldIssue(f: TemplateField): string {
  if (!f.label?.trim()) return 'Needs a question';
  if (!f.type?.trim()) return 'Needs a type';
  if (CHOICE_TYPES.has(f.type) && (f.options || []).length === 0) return 'Needs options';
  return '';
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.76rem', fontWeight: 700, color: 'var(--muted-foreground)', marginBottom: 5,
};
const cardStyle: React.CSSProperties = {
  padding: 16, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
  background: 'var(--card-solid)',
};

export interface FieldConfigPanelProps {
  fields: TemplateField[];
  occurrences: PlaceholderOccurrence[];
  activeKey: string | null;
  onActiveKeyChange: (key: string) => void;
  onPatch: (key: string, patch: Partial<TemplateField>) => void;
  /** Give one occurrence its own key, splitting it off its question (FR-7.4). */
  onUnlinkOccurrence: (nodeId: string) => void;
  /** Point one occurrence at another question's key (FR-7.4). */
  onLinkOccurrence: (nodeId: string, targetKey: string) => void;
  /** Scroll + pulse an individual blank in the left pane. */
  onFocusOccurrence: (nodeId: string) => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
  /**
   * Text on either side of this question's first blank, for AI field
   * suggestion (FR-8.4). Omit and the Suggest button is not offered — the
   * panel never guesses at context it wasn't given.
   */
  getFieldContext?: (key: string) => { before: string; after: string } | null;
  templateId?: string | null;
  /**
   * FR-8.6 — persist a new question order / section assignment. Omit and the
   * reorder list is not shown, so the panel never offers a control that
   * cannot save.
   */
  onReorderFields?: (
    updates: { key: string; order_index: number; section: string | null }[],
  ) => void;
}

export function FieldConfigPanel({
  fields, occurrences, activeKey, onActiveKeyChange, onPatch,
  onUnlinkOccurrence, onLinkOccurrence, onFocusOccurrence,
  showAdvanced, onToggleAdvanced, getFieldContext, templateId, onReorderFields,
}: FieldConfigPanelProps) {
  const index = Math.max(0, fields.findIndex((f) => f.key === activeKey));
  const field = fields[index];

  const occurrencesForField = useMemo(
    () => occurrences.filter((o) => o.field_key === field?.key).sort((a, b) => a.order_no - b.order_no),
    [occurrences, field?.key],
  );

  const issues = useMemo(
    () => fields.map((f) => ({ key: f.key, label: f.label, issue: fieldIssue(f) })).filter((i) => i.issue),
    [fields],
  );

  // ── AI field suggestion (FR-8.4) ────────────────────────────────────────
  // The proposal is held here and applied only when the author presses Apply;
  // the question is never overwritten by the model on its own (FR-10.4).
  const ai = useAIAvailability();
  const suggest = useSuggestField();
  const recordDecision = useAIDecision();
  const [proposal, setProposal] = useState<
    { interaction_id: string; label: string; type: string; confidence: 'high' | 'medium' | 'low' } | null
  >(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // Moving to another question must not leave the previous one's proposal on
  // screen, where Apply would write it to the wrong field.
  useEffect(() => {
    setProposal(null);
    setSuggestError(null);
  }, [activeKey]);

  const canSuggest = ai.enabled && !!getFieldContext && !!field;

  const askSuggestion = () => {
    const ctx = getFieldContext?.(field?.key ?? '');
    if (!ctx) return;
    setSuggestError(null);
    setProposal(null);
    suggest.mutate(
      {
        before: ctx.before,
        after: ctx.after,
        existing_keys: fields.map((f) => f.key),
        template_id: templateId ?? null,
      },
      {
        onSuccess: (data) => setProposal({
          interaction_id: data.interaction_id,
          label: data.label,
          type: data.type,
          confidence: data.confidence,
        }),
        onError: (err) => setSuggestError(
          err instanceof Error ? err.message : 'AI assistance is unavailable right now.',
        ),
      },
    );
  };

  const applyProposal = () => {
    if (!proposal || !field) return;
    // The key is deliberately NOT changed: it is already referenced by every
    // placeholder occurrence, and renaming it here would unlink them.
    onPatch(field?.key ?? '', { label: proposal.label, type: proposal.type });
    recordDecision(proposal.interaction_id, true);
    setProposal(null);
  };

  const dismissProposal = () => {
    if (proposal) recordDecision(proposal.interaction_id, false);
    setProposal(null);
  };

  if (fields.length === 0) {
    return (
      <div style={cardStyle}>
        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--foreground)', marginBottom: 6 }}>
          No blanks yet
        </h3>
        <p style={{ fontSize: '0.83rem', color: 'var(--muted-foreground)', margin: 0, lineHeight: 1.5 }}>
          Type <code>___</code>, press Ctrl+Shift+B, or use <strong>Insert blank</strong>. Each unique blank
          becomes one question here. Without blanks this is a plain document, not a fillable template (FR-8.1).
        </p>
      </div>
    );
  }

  const go = (i: number) => {
    const target = fields[Math.max(0, Math.min(fields.length - 1, i))];
    if (target) onActiveKeyChange(target.key);
  };

  const setValidation = (patch: Record<string, unknown>) => {
    const next = { ...(field.validation || {}), ...patch };
    for (const [k, v] of Object.entries(next)) {
      if (v === '' || v === null || v === undefined || Number.isNaN(v)) delete next[k];
    }
    onPatch(field.key, { validation: next });
  };

  const optionsText = (field.options || []).map((o) =>
    (o && typeof o === 'object' ? String((o as Record<string, unknown>).label ?? '') : String(o))).join('\n');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Stepper header — FR-8.2 "Question k of N" */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--muted-foreground)' }}>
            Question {index + 1} of {fields.length}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
            {fields.length - issues.length} configured
          </span>
        </div>
        <div role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={fields.length}
          aria-label="Question progress"
          style={{ height: 5, borderRadius: 999, background: 'var(--muted)', overflow: 'hidden' }}>
          <div style={{
            width: `${((index + 1) / fields.length) * 100}%`, height: '100%',
            background: 'var(--primary)', transition: 'width 180ms ease-out',
          }} />
        </div>
      </div>

      {/* FR-8.6 — reorder questions and group them into sections. */}
      {onReorderFields && fields.length > 1 && (
        <section style={cardStyle}>
          <QuestionReorderList
            fields={fields}
            activeKey={activeKey}
            onActiveKeyChange={onActiveKeyChange}
            onReorder={onReorderFields}
            hasIssue={(f) => !!fieldIssue(f)}
          />
        </section>
      )}

      {/* The question being configured */}
      <section style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          }}>
            <label style={labelStyle} htmlFor="fc-label">
              Question <span style={{ color: 'var(--status-rejected)' }} aria-hidden>*</span>
            </label>
            {canSuggest && (
              <button type="button" onClick={askSuggestion} disabled={suggest.isPending}
                className="btn btn-ghost btn-sm"
                style={{ fontSize: '0.74rem', padding: '2px 8px', marginBottom: 6 }}
                title="Suggest a question from the surrounding text">
                {suggest.isPending
                  ? <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} />
                  : <Sparkles size={13} />}
                Suggest
              </button>
            )}
          </div>
          <input id="fc-label" className="input" value={field.label || ''}
            placeholder="What should we ask? e.g. Client name"
            onChange={(e) => onPatch(field.key, { label: e.target.value })} />

          {suggestError && (
            <p role="alert" style={{
              margin: '8px 0 0', fontSize: '0.76rem', color: 'var(--muted-foreground)',
            }}>{suggestError}</p>
          )}

          {proposal && (
            <div style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)', background: 'var(--secondary)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <AIBadge />
                <ConfidenceBadge level={proposal.confidence} compact />
              </div>
              <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--foreground)', fontWeight: 600 }}>
                {proposal.label}
              </p>
              <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--muted-foreground)' }}>
                Answer type: {FIELD_TYPES.find((t) => t.value === proposal.type)?.label ?? proposal.type}
              </p>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" onClick={applyProposal} className="btn btn-primary btn-sm">
                  Apply
                </button>
                <button type="button" onClick={dismissProposal} className="btn btn-ghost btn-sm">
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end' }}>
          <div>
            <label style={labelStyle} htmlFor="fc-type">Answer type</label>
            <select id="fc-type" className="input" value={field.type || 'text'}
              onChange={(e) => onPatch(field.key, { type: e.target.value })}>
              {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.8rem',
            color: 'var(--foreground)', whiteSpace: 'nowrap', paddingBottom: 9,
          }}>
            <input type="checkbox" checked={!!field.required}
              onChange={(e) => onPatch(field.key, { required: e.target.checked })} />
            Required
          </label>
        </div>

        {CHOICE_TYPES.has(field.type) && (
          <div>
            <label style={labelStyle} htmlFor="fc-options">Options (one per line)</label>
            <textarea id="fc-options" className="input" rows={4} value={optionsText}
              placeholder={'Option A\nOption B'}
              style={{ resize: 'vertical' }}
              onChange={(e) => onPatch(field.key, {
                options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
              })} />
          </div>
        )}

        {/* FR-7.7 — the rest of the property set, folded away by default so the
            common case (question + type + required) stays a three-field form. */}
        <button onClick={onToggleAdvanced} aria-expanded={showAdvanced} style={{
          display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontFamily: 'var(--font-sans)', fontSize: '0.78rem', fontWeight: 700, color: 'var(--primary)',
        }}>
          {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {showAdvanced ? 'Fewer options' : 'More options'}
        </button>

        {showAdvanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 2 }}>
            <div>
              <label style={labelStyle} htmlFor="fc-help">Help text</label>
              <input id="fc-help" className="input" value={field.help_text || ''}
                placeholder="Shown under the question"
                onChange={(e) => onPatch(field.key, { help_text: e.target.value })} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle} htmlFor="fc-example">Example</label>
                <input id="fc-example" className="input" value={field.example || ''}
                  placeholder="e.g. Acme Ltd"
                  onChange={(e) => onPatch(field.key, { example: e.target.value })} />
              </div>
              <div>
                <label style={labelStyle} htmlFor="fc-default">Default value</label>
                <input id="fc-default" className="input"
                  value={field.default_value == null ? '' : String(field.default_value)}
                  onChange={(e) => onPatch(field.key, { default_value: e.target.value || null })} />
              </div>
            </div>

            {TEXTUAL_TYPES.has(field.type) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle} htmlFor="fc-minlen">Min length</label>
                  <input id="fc-minlen" className="input" type="number" min={0}
                    value={numValue(field.validation?.min_length)}
                    onChange={(e) => setValidation({ min_length: e.target.value === '' ? '' : Number(e.target.value) })} />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="fc-maxlen">Max length</label>
                  <input id="fc-maxlen" className="input" type="number" min={0}
                    value={numValue(field.validation?.max_length)}
                    onChange={(e) => setValidation({ max_length: e.target.value === '' ? '' : Number(e.target.value) })} />
                </div>
              </div>
            )}

            {NUMERIC_TYPES.has(field.type) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle} htmlFor="fc-min">Minimum</label>
                  <input id="fc-min" className="input" type="number" value={numValue(field.validation?.min)}
                    onChange={(e) => setValidation({ min: e.target.value === '' ? '' : Number(e.target.value) })} />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="fc-max">Maximum</label>
                  <input id="fc-max" className="input" type="number" value={numValue(field.validation?.max)}
                    onChange={(e) => setValidation({ max: e.target.value === '' ? '' : Number(e.target.value) })} />
                </div>
              </div>
            )}

            {field.type === 'date' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={labelStyle} htmlFor="fc-mindate">Earliest date</label>
                  <input id="fc-mindate" className="input" type="date" value={strValue(field.validation?.min_date)}
                    onChange={(e) => setValidation({ min_date: e.target.value })} />
                </div>
                <div>
                  <label style={labelStyle} htmlFor="fc-maxdate">Latest date</label>
                  <input id="fc-maxdate" className="input" type="date" value={strValue(field.validation?.max_date)}
                    onChange={(e) => setValidation({ max_date: e.target.value })} />
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle} htmlFor="fc-format">Display format</label>
                <input id="fc-format" className="input" value={field.format || ''}
                  placeholder={field.type === 'date' ? 'DD/MM/YYYY' : 'Optional'}
                  onChange={(e) => onPatch(field.key, { format: e.target.value || null })} />
              </div>
              <div>
                <label style={labelStyle} htmlFor="fc-ifempty">If left empty</label>
                <select id="fc-ifempty" className="input" value={field.if_empty_behavior || 'keep_blank'}
                  onChange={(e) => onPatch(field.key, { if_empty_behavior: e.target.value })}>
                  <option value="keep_blank">Keep the blank line</option>
                  <option value="remove_phrase">Remove the phrase</option>
                </select>
              </div>
            </div>

            <div>
              <label style={labelStyle} htmlFor="fc-pattern">Validation pattern (regex)</label>
              <input id="fc-pattern" className="input" value={strValue(field.validation?.pattern)}
                placeholder="Optional, e.g. ^[A-Z]{2}[0-9]{4}$"
                onChange={(e) => setValidation({ pattern: e.target.value })} />
            </div>

            <div>
              <label style={labelStyle} htmlFor="fc-section">Section</label>
              <input id="fc-section" className="input" value={field.section || ''}
                placeholder="Group related questions, e.g. Parties"
                onChange={(e) => onPatch(field.key, { section: e.target.value || null })} />
            </div>
          </div>
        )}

        {/* Linked occurrences — FR-7.4 */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
            <Link2 size={13} style={{ color: 'var(--muted-foreground)' }} />
            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--muted-foreground)' }}>
              Used in {occurrencesForField.length} place{occurrencesForField.length === 1 ? '' : 's'}
            </span>
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', margin: '0 0 8px', lineHeight: 1.45 }}>
            All of these are answered once and fill in together. Unlink one to ask for it separately.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {occurrencesForField.map((o) => (
              <span key={o.node_id} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 9px',
                borderRadius: 'var(--radius-pill)', border: '1px solid var(--border)',
                background: 'var(--card)', fontSize: '0.74rem', color: 'var(--muted-foreground)',
              }}>
                <button onClick={() => onFocusOccurrence(o.node_id)}
                  title="Show this blank in the document"
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                    fontFamily: 'var(--font-sans)', fontSize: '0.74rem', fontWeight: 700, color: 'var(--foreground)',
                  }}>
                  Blank {o.order_no}
                </button>
                {occurrencesForField.length > 1 && (
                  <button onClick={() => onUnlinkOccurrence(o.node_id)}
                    aria-label={`Unlink blank ${o.order_no} from this question`} title="Unlink"
                    style={{
                      display: 'inline-flex', background: 'none', border: 'none', padding: 2,
                      cursor: 'pointer', color: 'var(--muted-foreground)',
                    }}>
                    <Link2Off size={12} />
                  </button>
                )}
              </span>
            ))}
          </div>

          {fields.length > 1 && occurrencesForField.length === 1 && (
            <div style={{ marginTop: 10 }}>
              <label style={labelStyle} htmlFor="fc-link">Or reuse another question&rsquo;s answer</label>
              <select id="fc-link" className="input" value=""
                onChange={(e) => {
                  if (e.target.value) onLinkOccurrence(occurrencesForField[0].node_id, e.target.value);
                }}>
                <option value="">— Keep as its own question —</option>
                {fields.filter((f) => f.key !== field.key).map((f) => (
                  <option key={f.key} value={f.key}>{f.label || f.key}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Prev / next */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => go(index - 1)} disabled={index === 0}>Previous</button>
          <button className="btn btn-secondary btn-sm" onClick={() => go(index + 1)} disabled={index === fields.length - 1}>Next</button>
        </div>
      </section>

      {/* Overview + "Fix n issues" — FR-8.3 / FR-8.5 */}
      <section style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
          fontSize: '0.84rem', fontWeight: 700, color: 'var(--foreground)',
        }}>
          <ListChecks size={14} /> All questions
          {issues.length > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--status-pending)' }}>
              Fix {issues.length} issue{issues.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: '1px solid var(--border)', maxHeight: '34vh', overflowY: 'auto' }}>
          {fields.map((f, i) => {
            const issue = fieldIssue(f);
            const uses = occurrences.filter((o) => o.field_key === f.key).length;
            return (
              <li key={f.key}>
                <button onClick={() => onActiveKeyChange(f.key)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                  padding: '9px 14px', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: '0.83rem', color: 'var(--foreground)',
                  background: f.key === field.key ? 'color-mix(in srgb, var(--primary) 7%, transparent)' : 'transparent',
                }}>
                  <span style={{ width: 18, fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>{i + 1}</span>
                  <span style={{ flex: 1 }}>{f.label || <em style={{ color: 'var(--muted-foreground)' }}>{f.key}</em>}</span>
                  {uses > 1 && (
                    <span title={`${uses} linked blanks`} style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <Link2 size={11} />{uses}
                    </span>
                  )}
                  {issue
                    ? <AlertTriangle size={13} style={{ color: 'var(--status-pending)' }} aria-label={issue} />
                    : <CheckCircle2 size={13} style={{ color: 'var(--status-approved)' }} aria-label="Configured" />}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function numValue(v: unknown): string | number {
  return typeof v === 'number' ? v : '';
}
function strValue(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export default FieldConfigPanel;
