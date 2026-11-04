/**
 * DocFlow Landing v4 — colour token helpers.
 *
 * The design expresses every neutral as `rgba(11,27,51,<a>)` or
 * `rgba(255,255,255,<a>)`. These turn that into a token read, so the same
 * markup works in both themes.
 *
 * Kept apart from `ui.tsx` so that file exports only components and React Fast
 * Refresh keeps working.
 */

/** Ink (text) at an alpha. */
export const ink = (a: number) => `rgb(var(--lp-ink-rgb) / ${a})`;
/** Glass surface at an alpha. */
export const surface = (a: number) => `rgb(var(--lp-surface-rgb) / ${a})`;
/** Tinted shadow at an alpha — never pure black. */
export const shadow = (a: number) => `rgb(var(--lp-shadow-rgb) / ${a})`;
/** Accent wash at an alpha. */
export const accent = (a: number) => `rgb(var(--lp-accent-soft-rgb) / ${a})`;
