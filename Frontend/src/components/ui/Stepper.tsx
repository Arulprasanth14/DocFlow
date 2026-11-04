/**
 * Stepper — horizontal progress stepper for the submission wizard (spec §8.13
 * FR-13.1, §28 a11y). Completed steps are clickable; the active step carries
 * aria-current. Uses theme tokens + the motion system.
 */
import { Check } from 'lucide-react';
import { motion } from 'framer-motion';

export interface Step { key: string; label: string }

export function Stepper({ steps, current, maxReached, onStepClick }: {
  steps: Step[];
  current: number;                 // active index
  maxReached: number;              // furthest index reached (controls clickability)
  onStepClick?: (index: number) => void;
}) {
  return (
    <nav aria-label="Submission steps" style={{ display: 'flex', alignItems: 'center', gap: 0, width: '100%' }}>
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const clickable = i <= maxReached && !!onStepClick && i !== current;
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', flex: i === steps.length - 1 ? '0 0 auto' : 1 }}>
            <button
              type="button"
              aria-current={active ? 'step' : undefined}
              onClick={clickable ? () => onStepClick!(i) : undefined}
              disabled={!clickable}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none',
                cursor: clickable ? 'pointer' : 'default', padding: 0, fontFamily: 'var(--font-sans)',
              }}
            >
              <motion.span
                initial={false}
                animate={{
                  background: done || active ? 'var(--primary)' : 'var(--muted)',
                  color: done || active ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
                }}
                style={{
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.8rem', fontWeight: 700,
                }}
              >
                {done ? <Check size={15} /> : i + 1}
              </motion.span>
              <span style={{
                fontSize: '0.85rem', fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
                color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
              }}>{s.label}</span>
            </button>
            {i < steps.length - 1 && (
              <span style={{
                flex: 1, height: 2, margin: '0 12px', borderRadius: 2,
                background: i < current ? 'var(--primary)' : 'var(--border)',
                transition: 'background 0.25s',
              }} />
            )}
          </div>
        );
      })}
    </nav>
  );
}

export default Stepper;
