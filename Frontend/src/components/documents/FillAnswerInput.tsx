/**
 * DocFlow — one answer input, rendered from a template field definition
 * (spec FR-7.6 field types, FR-7.7 properties, FR-12.3 validation).
 *
 * Shared by Form Fill (use time) and the template editor's Try-it preview, so
 * a type behaves identically wherever it appears.
 */
import type { FillField } from '@/lib/api/documents';

export type AnswerValue = string | number | boolean | string[] | null;

const inputStyle: React.CSSProperties = { width: '100%' };

/** Options may be plain strings or {label, value} objects. */
function optionList(field: FillField): { label: string; value: string }[] {
  return (field.options || []).map((o) => {
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      const value = String(rec.value ?? rec.label ?? '');
      return { label: String(rec.label ?? value), value };
    }
    return { label: String(o), value: String(o) };
  });
}

/**
 * Returns an error message, or '' when the answer is acceptable.
 * Draft answers are never blocked by this — it gates "Next" and submit only
 * (FR-14.4: validation runs on step transitions, not while typing).
 */
export function validateAnswer(field: FillField, value: AnswerValue): string {
  const empty = value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0);
  if (field.required && empty && field.type !== 'checkbox' && field.type !== 'yesno') {
    return 'This field is required.';
  }
  if (field.required && field.type === 'checkbox' && value !== true) {
    return 'This needs to be ticked.';
  }
  if (empty) return '';

  const v = field.validation || {};
  const text = String(value);

  if (typeof v.min_length === 'number' && text.length < v.min_length) {
    return `Use at least ${v.min_length} characters.`;
  }
  if (typeof v.max_length === 'number' && text.length > v.max_length) {
    return `Use at most ${v.max_length} characters.`;
  }
  if (typeof v.pattern === 'string' && v.pattern) {
    try {
      if (!new RegExp(v.pattern).test(text)) {
        return typeof v.message === 'string' && v.message ? v.message : "This doesn't match the expected format.";
      }
    } catch { /* an invalid author-supplied regex must not block the filler */ }
  }
  if (field.type === 'number' || field.type === 'currency') {
    const n = Number(text);
    if (Number.isNaN(n)) return 'Enter a number.';
    if (typeof v.min === 'number' && n < v.min) return `Enter ${v.min} or more.`;
    if (typeof v.max === 'number' && n > v.max) return `Enter ${v.max} or less.`;
  }
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return 'Enter a valid email address.';
  }
  if (field.type === 'date') {
    if (typeof v.min_date === 'string' && v.min_date && text < v.min_date) {
      return `Choose a date on or after ${v.min_date}.`;
    }
    if (typeof v.max_date === 'string' && v.max_date && text > v.max_date) {
      return `Choose a date on or before ${v.max_date}.`;
    }
  }
  return '';
}

export function FillAnswerInput({ field, value, onChange, inputRef }: {
  field: FillField;
  value: AnswerValue;
  onChange: (next: AnswerValue) => void;
  inputRef?: React.Ref<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>;
}) {
  const id = `fill-${field.key}`;
  const str = value == null ? '' : String(value);

  switch (field.type) {
    case 'textarea':
      return (
        <textarea id={id} className="input" rows={5} value={str} style={{ ...inputStyle, resize: 'vertical' }}
          placeholder={field.example || ''}
          ref={inputRef as React.Ref<HTMLTextAreaElement>}
          onChange={(e) => onChange(e.target.value)} />
      );

    case 'dropdown':
      return (
        <select id={id} className="input" value={str} style={inputStyle}
          ref={inputRef as React.Ref<HTMLSelectElement>}
          onChange={(e) => onChange(e.target.value)}>
          <option value="">— Select —</option>
          {optionList(field).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );

    case 'radio':
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {optionList(field).map((o) => (
            <label key={o.value} style={choiceStyle(str === o.value)}>
              <input type="radio" name={id} value={o.value} checked={str === o.value}
                onChange={() => onChange(o.value)} />
              <span style={{ fontSize: '0.88rem', color: 'var(--foreground)' }}>{o.label}</span>
            </label>
          ))}
        </div>
      );

    case 'yesno':
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} style={{ display: 'flex', gap: 10 }}>
          {[{ l: 'Yes', v: true }, { l: 'No', v: false }].map((o) => (
            <label key={o.l} style={{ ...choiceStyle(value === o.v), flex: 1 }}>
              <input type="radio" name={id} checked={value === o.v} onChange={() => onChange(o.v)} />
              <span style={{ fontSize: '0.88rem', color: 'var(--foreground)' }}>{o.l}</span>
            </label>
          ))}
        </div>
      );

    case 'checkbox':
      return (
        <label style={choiceStyle(value === true)}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span style={{ fontSize: '0.88rem', color: 'var(--foreground)' }}>{field.example || 'Yes'}</span>
        </label>
      );

    default: {
      const htmlType = field.type === 'number' || field.type === 'currency' ? 'number'
        : field.type === 'date' ? 'date'
          : field.type === 'email' ? 'email'
            : field.type === 'phone' ? 'tel'
              : 'text';
      return (
        <input id={id} className="input" type={htmlType} value={str} style={inputStyle}
          placeholder={field.example || ''}
          inputMode={field.type === 'currency' ? 'decimal' : undefined}
          step={field.type === 'currency' ? '0.01' : undefined}
          ref={inputRef as React.Ref<HTMLInputElement>}
          onChange={(e) => onChange(e.target.value)} />
      );
    }
  }
}

function choiceStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer',
    borderRadius: 'var(--radius)',
    border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
    background: active ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--card)',
  };
}

export default FillAnswerInput;
