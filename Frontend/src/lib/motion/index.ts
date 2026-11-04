/**
 * DocFlow Frontend — Motion utilities (GSAP via @gsap/react useGSAP).
 * Subtle, fast, opacity/transform only. All hooks respect prefers-reduced-motion.
 * Use these instead of writing GSAP inline. Existing framer-motion modals/drawers stay as-is.
 */

export { prefersReducedMotion } from './prefersReducedMotion';
export { usePageTransition } from './usePageTransition';
export { useStaggerIn } from './useStaggerIn';
export { useCountUp } from './useCountUp';
export { useAuraDrift } from './useAuraDrift';
export { EASE, EASE_BEZIER, DUR, fmTransition, fmReduced } from './tokens';
