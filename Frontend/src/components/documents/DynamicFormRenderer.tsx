/**
 * DocFlow Frontend — Component: DynamicFormRenderer
 * Schema-driven interactive form engine with real-time field validation, rich aesthetics,
 * and support for all 8 FormField types (text, textarea, number, date, select, multiselect, checkbox, file).
 */

import type { FormField } from '@/types';

export interface DynamicFormRendererProps {
  schema: FormField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}

/**
 * Validate values against a form schema and return error messages mapped by field key.
 */
export function validateFormSchema(
  schema: FormField[],
  values: Record<string, unknown>
): { isValid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  for (const field of schema) {
    const val = values[field.key];
    const label = field.label || field.key;

    if (field.required) {
      if (
        val === undefined ||
        val === null ||
        val === '' ||
        (Array.isArray(val) && val.length === 0)
      ) {
        errors[field.key] = `${label} is required.`;
        continue;
      }
    }

    if (val !== undefined && val !== null && val !== '') {
      if (field.type === 'number') {
        const num = Number(val);
        if (isNaN(num)) {
          errors[field.key] = `${label} must be a valid number.`;
        } else if (field.validation?.min !== undefined && num < field.validation.min) {
          errors[field.key] = `${label} cannot be less than ${field.validation.min}.`;
        } else if (field.validation?.max !== undefined && num > field.validation.max) {
          errors[field.key] = `${label} cannot exceed ${field.validation.max}.`;
        }
      }

      if (field.type === 'text' || field.type === 'textarea') {
        const str = String(val);
        if (
          field.validation?.minLength !== undefined &&
          str.length < field.validation.minLength
        ) {
          errors[field.key] = `${label} must be at least ${field.validation.minLength} characters.`;
        }
        if (
          field.validation?.maxLength !== undefined &&
          str.length > field.validation.maxLength
        ) {
          errors[field.key] = `${label} cannot exceed ${field.validation.maxLength} characters.`;
        }
        if (field.validation?.pattern) {
          try {
            const regex = new RegExp(field.validation.pattern);
            if (!regex.test(str)) {
              errors[field.key] = `${label} has an invalid format.`;
            }
          } catch {
            // ignore invalid regex
          }
        }
      }
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}

export function DynamicFormRenderer({
  schema,
  values,
  onChange,
  errors = {},
  disabled = false,
}: DynamicFormRendererProps) {
  if (!schema || schema.length === 0) {
    return (
      <div
        className="glass-card"
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: '0.9rem',
          borderStyle: 'dashed',
        }}
      >
        No custom fields defined for this document type.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {schema.map((field) => {
        const error = errors[field.key];
        const value = values[field.key];

        return (
          <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {/* Label */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <span>{field.label}</span>
                {field.required && (
                  <span style={{ color: 'var(--color-error-400)', fontWeight: 700 }}>*</span>
                )}
              </label>
            </div>

            {/* Field Control */}
            {renderFieldControl(field, value, (newVal) => onChange(field.key, newVal), disabled)}

            {/* Error Message */}
            {error && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  color: 'var(--color-error-400)',
                  fontSize: '0.78rem',
                  fontWeight: 500,
                  marginTop: '2px',
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{error}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function renderFieldControl(
  field: FormField,
  value: unknown,
  onChange: (val: unknown) => void,
  disabled: boolean
) {
  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          className="input"
          placeholder={field.placeholder || ''}
          value={(value as string) || ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          style={{
            resize: 'vertical',
            minHeight: '80px',
            lineHeight: 1.5,
          }}
        />
      );

    case 'number':
      return (
        <input
          type="number"
          className="input"
          placeholder={field.placeholder || ''}
          value={value === undefined || value === null ? '' : (value as number | string)}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? '' : Number(v));
          }}
          min={field.validation?.min}
          max={field.validation?.max}
        />
      );

    case 'date':
      return (
        <input
          type="date"
          className="input"
          value={(value as string) || ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'select':
      return (
        <select
          className="input"
          value={(value as string) || ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— Select {field.label} —</option>
          {(field.options || []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );

    case 'multiselect': {
      const currentArray = Array.isArray(value) ? (value as string[]) : [];
      const toggleValue = (optVal: string) => {
        if (currentArray.includes(optVal)) {
          onChange(currentArray.filter((v) => v !== optVal));
        } else {
          onChange([...currentArray, optVal]);
        }
      };

      return (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            padding: '10px 12px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {(field.options || []).map((opt) => {
            const selected = currentArray.includes(opt.value);
            return (
              <button
                type="button"
                key={opt.value}
                disabled={disabled}
                onClick={() => toggleValue(opt.value)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  border: selected
                    ? '1px solid var(--color-primary-500)'
                    : '1px solid var(--border-subtle)',
                  background: selected
                    ? 'hsla(217, 100%, 50%, 0.15)'
                    : 'var(--bg-overlay)',
                  color: selected
                    ? 'var(--color-primary-300)'
                    : 'var(--text-secondary)',
                  transition: 'all var(--transition-fast)',
                }}
              >
                {selected && '✓ '}
                {opt.label}
              </button>
            );
          })}
          {(field.options || []).length === 0 && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              No options configured.
            </span>
          )}
        </div>
      );
    }

    case 'checkbox': {
      const isChecked = Boolean(value);
      return (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            cursor: disabled ? 'not-allowed' : 'pointer',
            padding: '8px 12px',
            background: 'var(--bg-overlay)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            width: 'fit-content',
          }}
        >
          <input
            type="checkbox"
            checked={isChecked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            style={{
              width: '18px',
              height: '18px',
              accentColor: 'var(--color-primary-500)',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          />
          <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500 }}>
            {field.placeholder || `Enable ${field.label}`}
          </span>
        </label>
      );
    }

    case 'file':
      return (
        <div
          style={{
            padding: '16px',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-overlay)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '1.1rem' }}>📎</span>
            <div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                {typeof value === 'string' && value ? value : 'No file attached'}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Upload or link a file asset
              </div>
            </div>
          </div>
          {!disabled && (
            <input
              type="text"
              className="input"
              placeholder="Enter file asset ID or URL..."
              value={(value as string) || ''}
              onChange={(e) => onChange(e.target.value)}
              style={{ maxWidth: '240px', fontSize: '0.8rem' }}
            />
          )}
        </div>
      );

    case 'text':
    default:
      return (
        <input
          type="text"
          className="input"
          placeholder={field.placeholder || ''}
          value={(value as string) || ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          minLength={field.validation?.minLength}
          maxLength={field.validation?.maxLength}
          pattern={field.validation?.pattern}
        />
      );
  }
}

export default DynamicFormRenderer;
