import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { prefersReducedMotion } from './prefersReducedMotion';

interface CountUpOptions {
  duration?: number;
  decimals?: number;
  /** Text prepended to the number, e.g. "$". */
  prefix?: string;
  /** Text appended to the number, e.g. "%". */
  suffix?: string;
}

/**
 * Number count-up for stat cards. Attach the returned ref to a <span>.
 * Re-runs when `value` changes. Honors prefers-reduced-motion (renders final value).
 */
export function useCountUp(value: number, options: CountUpOptions = {}) {
  const { duration = 0.8, decimals = 0, prefix = '', suffix = '' } = options;
  const ref = useRef<HTMLSpanElement>(null);

  const format = (n: number) =>
    `${prefix}${n.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}${suffix}`;

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      if (prefersReducedMotion()) {
        el.textContent = format(value);
        return;
      }
      const counter = { v: 0 };
      gsap.to(counter, {
        v: value,
        duration,
        ease: 'power2.out',
        onUpdate: () => {
          el.textContent = format(counter.v);
        },
      });
    },
    { dependencies: [value] },
  );

  return ref;
}
