import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { prefersReducedMotion } from './prefersReducedMotion';

/**
 * Very slow, transform-only drift for 1-2 aura layers (hero/header only).
 * Mark each drifting layer with `[data-aura-layer]`. Never animates blur/filter.
 */
export function useAuraDrift<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion() || !ref.current) return;
      const layers = ref.current.querySelectorAll('[data-aura-layer]');
      layers.forEach((layer, i) => {
        gsap.to(layer, {
          xPercent: i % 2 === 0 ? -8 : 8,
          yPercent: i % 2 === 0 ? 6 : -6,
          duration: 18 + i * 5,
          ease: 'power1.inOut',
          repeat: -1,
          yoyo: true,
        });
      });
    },
    { scope: ref },
  );

  return ref;
}
