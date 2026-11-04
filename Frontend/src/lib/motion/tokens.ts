/**
 * Shared motion tokens — one source of truth for GSAP and framer-motion so both feel identical.
 * GSAP uses the string eases; framer-motion uses the cubic-bezier array equivalent.
 */

export const EASE = {
  standard: 'power2.out',
  emphasized: 'power3.out',
  inOut: 'power2.inOut',
} as const;

/** cubic-bezier(0.22, 1, 0.36, 1) — the framer-motion equivalent of EASE.standard/emphasized. */
export const EASE_BEZIER: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const DUR = {
  micro: 0.18,
  base: 0.35,
  page: 0.45,
  max: 0.7,
} as const;

/** framer-motion transition presets (modals/drawers/dropdowns). */
export const fmTransition = {
  base: { duration: DUR.base, ease: EASE_BEZIER },
  micro: { duration: DUR.micro, ease: EASE_BEZIER },
} as const;

/** Reduced-motion fallback transition (0.15s opacity fade). */
export const fmReduced = { duration: 0.15, ease: 'linear' as const };
