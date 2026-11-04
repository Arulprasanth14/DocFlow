import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { prefersReducedMotion } from './prefersReducedMotion';

/**
 * Staggered entrance for a list/grid of items (fade + 12px slide-up).
 * Mark each child with the selector (default `[data-stagger-item]`).
 * Only the first `max` items animate (default 10); the rest render normally.
 */
export function useStaggerIn<T extends HTMLElement = HTMLDivElement>(
  selector = '[data-stagger-item]',
  max = 10,
) {
  const ref = useRef<T>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion() || !ref.current) return;
      const nodes = ref.current.querySelectorAll(selector);
      if (!nodes.length) return;
      const targets = Array.from(nodes).slice(0, max);
      gsap.from(targets, {
        autoAlpha: 0,
        y: 12,
        duration: 0.4,
        ease: 'power2.out',
        stagger: 0.06,
      });
    },
    { scope: ref },
  );

  return ref;
}
