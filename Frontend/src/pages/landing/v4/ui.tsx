import React from 'react';

/**
 * DocFlow Landing v4 — shared components.
 *
 * Colour helpers live in ./tokens, so this file exports only components and
 * React Fast Refresh keeps working.
 */

/** Status pill: "Coming soon", "In progress", "Preview". */
export const Chip: React.FC<{
  tone?: 'violet' | 'amber';
  children: React.ReactNode;
}> = ({ tone = 'violet', children }) => (
  <span
    style={{
      fontSize: 13,
      padding: '4px 11px',
      borderRadius: 999,
      whiteSpace: 'nowrap',
      background: tone === 'violet' ? 'rgb(167 139 250 / 0.14)' : 'rgb(251 191 36 / 0.1)',
      color: tone === 'violet' ? 'var(--lp-violet-chip-fg)' : 'var(--lp-amber-chip-fg)',
      border:
        tone === 'violet'
          ? '1px solid rgb(167 139 250 / 0.32)'
          : '1px solid rgb(251 191 36 / 0.28)',
    }}
  >
    {children}
  </span>
);

/* ── icons ─────────────────────────────────────────────────────────────────── */

type IconProps = { size?: number; stroke?: string; style?: React.CSSProperties };

const svg = (size: number, style?: React.CSSProperties, stroke = 'currentColor') => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke,
  strokeWidth: 2,
  'aria-hidden': true,
  focusable: 'false' as const,
  style,
});

export const Check: React.FC<IconProps> = ({ size = 18, stroke = 'var(--lp-ok)', style }) => (
  <svg {...svg(size, { flexShrink: 0, marginTop: 2, ...style }, stroke)}>
    <path d="M5 12l5 5 9-10" />
  </svg>
);

export const Cross: React.FC<IconProps> = ({ size = 18, stroke = 'var(--lp-no)', style }) => (
  <svg {...svg(size, { flexShrink: 0, marginTop: 2, ...style }, stroke)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const ArrowRight: React.FC<IconProps> = ({ size = 16, style }) => (
  <svg {...svg(size, style)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const ArrowDown: React.FC<IconProps> = ({ size = 14, style }) => (
  <svg {...svg(size, style)}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);

export const ArrowUpRight: React.FC<IconProps> = ({ size = 15, style }) => (
  <svg {...svg(size, style)}>
    <path d="M7 17L17 7M8 7h9v9" />
  </svg>
);

export const Plus: React.FC<IconProps> = ({ size = 14, style }) => (
  <svg {...svg(size, style)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** The folded-corner paper glyph used as the DocFlow mark. */
export const PaperMark: React.FC<{ w?: number; h?: number; glow?: boolean }> = ({
  w = 22,
  h = 26,
  glow = true,
}) => (
  <span
    aria-hidden="true"
    style={{
      width: w,
      height: h,
      borderRadius: '5px 11px 5px 5px',
      background: 'linear-gradient(160deg,#E0F2FE,#93C5FD 60%,#A5B4FC)',
      boxShadow: glow ? '0 0 24px rgb(125 211 252 / 0.45)' : undefined,
      flexShrink: 0,
    }}
  />
);
