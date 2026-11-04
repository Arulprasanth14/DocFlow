/**
 * GlassCard — the core surface primitive (token-driven, theme-aware).
 * variant: 'default' | 'interactive' | 'elevated' | 'solid'
 *   - default      glass (blur+saturate, glass border, top sheen, shadow-md)
 *   - interactive  + hover lift / brighter border (and optional cursor spotlight)
 *   - elevated     stronger shadow (shadow-lg) for hero tiles
 *   - solid        opaque --card-solid surface (tables/forms), no sheen
 * spotlight: follow-the-cursor radial highlight (desktop only, cheap CSS vars).
 */

import React, { useRef } from 'react';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/lib/motion';

type Variant = 'default' | 'interactive' | 'elevated' | 'solid';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: Variant;
  spotlight?: boolean;
  as?: React.ElementType;
}

export function GlassCard({
  variant = 'default',
  spotlight = false,
  as: Tag = 'div',
  className,
  style,
  children,
  onMouseMove,
  ...rest
}: GlassCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handleMove: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (spotlight && ref.current && !prefersReducedMotion()) {
      const r = ref.current.getBoundingClientRect();
      ref.current.style.setProperty('--mx', `${e.clientX - r.left}px`);
      ref.current.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
    onMouseMove?.(e);
  };

  const base =
    variant === 'solid'
      ? 'glass-solid'
      : cn('glass-card', (variant === 'interactive') && 'glass-interactive');

  return (
    <Tag
      ref={ref}
      onMouseMove={spotlight || onMouseMove ? handleMove : undefined}
      className={cn(base, spotlight && 'spotlight-surface', className)}
      style={{
        ...(variant === 'elevated' ? { boxShadow: 'var(--shadow-lg), var(--glass-inner)' } : null),
        ...style,
      }}
      {...rest}
    >
      {spotlight && (
        <span
          aria-hidden
          className="spotlight-glow"
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            pointerEvents: 'none',
            opacity: 0,
            transition: 'opacity 0.25s ease',
            background:
              'radial-gradient(260px circle at var(--mx, 50%) var(--my, 50%), color-mix(in srgb, var(--primary) 16%, transparent), transparent 60%)',
          }}
        />
      )}
      {children}
    </Tag>
  );
}

export default GlassCard;
