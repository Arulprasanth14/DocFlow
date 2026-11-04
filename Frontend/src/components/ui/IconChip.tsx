/**
 * IconChip — a rounded tinted tile holding a lucide icon.
 * `tone` selects the token family; the tile gets a soft gradient bg + inner border + tinted icon.
 * Colors come from tokens via color-mix — never hardcoded hex.
 */

import React from 'react';
import { cn } from '@/lib/utils';

export type ChipTone = 'primary' | 'cyan' | 'violet' | 'amber' | 'success' | 'danger' | 'muted';

const TONE_VAR: Record<ChipTone, string> = {
  primary: 'var(--primary)',
  cyan: 'var(--chart-2)',
  violet: 'var(--accent-violet)',
  amber: 'var(--accent-amber)',
  success: 'var(--success)',
  danger: 'var(--destructive)',
  muted: 'var(--muted-foreground)',
};

interface IconChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  size?: number;
  children: React.ReactNode;
}

export function IconChip({ tone = 'primary', size = 40, className, style, children, ...rest }: IconChipProps) {
  const c = TONE_VAR[tone];
  return (
    <span
      className={cn('inline-flex items-center justify-center flex-shrink-0', className)}
      style={{
        width: size,
        height: size,
        borderRadius: 'calc(var(--radius) - 2px)',
        color: c,
        background: `linear-gradient(145deg, color-mix(in srgb, ${c} 20%, transparent), color-mix(in srgb, ${c} 8%, transparent))`,
        border: `1px solid color-mix(in srgb, ${c} 28%, transparent)`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}

export default IconChip;
