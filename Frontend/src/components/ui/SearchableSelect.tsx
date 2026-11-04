/**
 * SearchableSelect — a combobox you can type into (FR-13.2).
 *
 * The workflow picker was a native `<select>`, which is fine for five options
 * and useless for fifty: there is no way to find "Finance — above 1 lakh"
 * except scrolling. This is the ARIA 1.2 combobox pattern, written by hand
 * because `cmdk` is already in the bundle for the command palette but is built
 * around a full-screen dialog, not a field in a form.
 *
 * Keyboard, which is the whole point of the pattern:
 *   ↓ / ↑     move through the matches (opens the list if closed)
 *   Enter     choose the active match
 *   Esc       close, keeping the current selection
 *   Tab       leave; the field keeps what was selected, not what was typed
 *   Home/End  first / last match
 *
 * The typed text is a filter, never the value: closing without choosing
 * restores the selected option's label, so the field can never be left
 * showing something that is not what is selected.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';

export interface SearchableOption {
  value: string;
  label: string;
  /** Second line, e.g. a stage summary. Also searched. */
  hint?: string;
  disabled?: boolean;
}

export interface SearchableSelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  /** Shown when the filter matches nothing. */
  emptyText?: string;
  disabled?: boolean;
  required?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export function SearchableSelect({
  id,
  value,
  onChange,
  options,
  placeholder = 'Search…',
  emptyText = 'Nothing matches',
  disabled = false,
  required = false,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: SearchableSelectProps) {
  const reactId = useId();
  const inputId = id ?? `combo-${reactId}`;
  const listId = `${inputId}-list`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q),
    );
  }, [options, query]);

  // While closed the field shows the selection; while open it shows the filter.
  const shown = open ? query : selected?.label ?? '';

  const close = useCallback((restore = true) => {
    setOpen(false);
    if (restore) setQuery('');
  }, []);

  const choose = useCallback((option: SearchableOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
    inputRef.current?.focus();
  }, [onChange, close]);

  // Click outside closes without changing the selection.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Keep the active option in view when it moves by keyboard.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // A filter that no longer contains the active index would leave the listbox
  // pointing at nothing.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) { setOpen(true); setActive(0); return; }
        setActive((i) => (matches.length ? (i + 1) % matches.length : 0));
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) { setOpen(true); setActive(Math.max(0, matches.length - 1)); return; }
        setActive((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0));
        return;
      case 'Home':
        if (!open) return;
        e.preventDefault();
        setActive(0);
        return;
      case 'End':
        if (!open) return;
        e.preventDefault();
        setActive(Math.max(0, matches.length - 1));
        return;
      case 'Enter':
        if (!open) return;
        e.preventDefault();
        if (matches[active]) choose(matches[active]);
        return;
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        close();
        return;
      case 'Tab':
        // Leaving commits nothing: the typed text was only ever a filter.
        close();
        return;
      default:
        return;
    }
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <Search
          size={14}
          aria-hidden
          style={{
            position: 'absolute', left: 10, pointerEvents: 'none',
            color: 'var(--muted-foreground)',
          }}
        />
        <input
          ref={inputRef}
          id={inputId}
          className="input"
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${inputId}-opt-${active}` : undefined}
          aria-required={required || undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          disabled={disabled}
          value={shown}
          placeholder={selected ? selected.label : placeholder}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          style={{ paddingLeft: 30, paddingRight: 56 }}
        />
        {selected && !disabled && (
          <button
            type="button"
            aria-label={`Clear the selected option, ${selected.label}`}
            onClick={() => { onChange(''); setQuery(''); inputRef.current?.focus(); }}
            className="btn btn-ghost btn-sm"
            style={{ position: 'absolute', right: 28, padding: 2, minWidth: 24, minHeight: 24 }}
          >
            <X size={13} />
          </button>
        )}
        <ChevronDown
          size={15}
          aria-hidden
          style={{
            position: 'absolute', right: 9, pointerEvents: 'none',
            color: 'var(--muted-foreground)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 140ms',
          }}
        />
      </div>

      {open && (
        // A div-based listbox rather than ul/li: identical ARIA semantics, and
        // it does not trip no-noninteractive-element-to-interactive-role.
        // (A JS comment — `{open && (...)}` holds one expression, so a
        // {/* */} sibling here is a syntax error.)
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Matching options"
          style={{
            position: 'absolute', zIndex: 20, top: 'calc(100% + 4px)', left: 0, right: 0,
            maxHeight: 260, overflowY: 'auto', margin: 0, padding: 4,
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)', background: 'var(--card-solid)',
            boxShadow: 'var(--shadow-lg, 0 10px 30px rgb(0 0 0 / 0.14))',
          }}
        >
          {matches.length === 0 ? (
            <div
              role="option"
              aria-selected={false}
              aria-disabled
              style={{ padding: '10px 10px', fontSize: '0.82rem', color: 'var(--muted-foreground)' }}
            >
              {emptyText}
            </div>
          ) : matches.map((o, i) => {
            const isSelected = o.value === value;
            return (
              <div
                key={o.value}
                id={`${inputId}-opt-${i}`}
                data-index={i}
                role="option"
                // Focusable but not tabbable: the ARIA combobox pattern keeps
                // focus on the input and moves `aria-activedescendant`, but an
                // option still has to be focusable to be a valid one.
                tabIndex={-1}
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                onPointerDown={(e) => { e.preventDefault(); choose(o); }}
                onMouseEnter={() => setActive(i)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  // 24px is the WCAG 2.2 AA minimum target (SC 2.5.8); rows are
                  // comfortably past it so a pointer never needs precision.
                  padding: '8px 10px', minHeight: 36, borderRadius: 'var(--radius-sm)',
                  cursor: o.disabled ? 'not-allowed' : 'pointer',
                  opacity: o.disabled ? 0.5 : 1,
                  background: i === active ? 'var(--muted)' : 'transparent',
                }}
              >
                <span style={{ width: 14, flexShrink: 0, paddingTop: 2 }}>
                  {isSelected && <Check size={13} style={{ color: 'var(--primary)' }} />}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{
                    display: 'block', fontSize: '0.86rem', fontWeight: isSelected ? 700 : 500,
                    color: 'var(--foreground)',
                  }}>{o.label}</span>
                  {o.hint && (
                    <span style={{
                      display: 'block', fontSize: '0.76rem', color: 'var(--muted-foreground)',
                      marginTop: 1,
                    }}>{o.hint}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default SearchableSelect;
