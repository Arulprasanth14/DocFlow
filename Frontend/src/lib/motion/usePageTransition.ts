import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { prefersReducedMotion } from './prefersReducedMotion';

/**
 * Page/route entrance: fade + 12px slide-up (standard 0.4s, power2.out).
 * Attach the returned ref to the page root element.
 */
export function usePageTransition<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion() || !ref.current) return;
      gsap.from(ref.current, {
        autoAlpha: 0,
        y: 12,
        duration: 0.4,
        ease: 'power2.out',
      });
    },
    { scope: ref },
  );

  return ref;
}
