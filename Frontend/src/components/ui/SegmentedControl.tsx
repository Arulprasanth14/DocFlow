/**
 * SegmentedControl — pill group with a sliding thumb (framer-motion layoutId).
 * Controlled: pass `value`, `options`, `onChange`. Token-driven.
 */

import { motion } from 'framer-motion';
import { fmTransition } from '@/lib/motion/tokens';

interface SegmentedControlProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  idBase?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
  idBase = 'seg',
}: SegmentedControlProps<T>) {
  const pad = size === 'sm' ? '4px 10px' : '6px 14px';
  const fs = size === 'sm' ? '0.75rem' : '0.8125rem';
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 3,
        background: 'color-mix(in srgb, var(--muted-foreground) 10%, transparent)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-full)',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            style={{
              position: 'relative',
              padding: pad,
              fontSize: fs,
              fontFamily: 'var(--font-heading)',
              fontWeight: active ? 600 : 500,
              color: active ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-full)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {active && (
              <motion.span
                layoutId={`${idBase}-thumb`}
                transition={fmTransition.base}
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'var(--gradient-primary-btn)',
                  borderRadius: 'var(--radius-full)',
                  boxShadow: 'var(--shadow-xs)',
                  zIndex: -1,
                }}
              />
            )}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
