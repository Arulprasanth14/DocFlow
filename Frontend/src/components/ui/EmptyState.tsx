/**
 * EmptyState — shared designed empty state: inline-SVG illustration (currentColor + tokens),
 * headline, one friendly sentence, a primary CTA and optional secondary link.
 * The illustration floats gently (transform only; disabled under prefers-reduced-motion via CSS).
 * Never shows fake data — used wherever a list/card/chart has nothing to show.
 */

import React from 'react';
import { cn } from '@/lib/utils';

export type EmptyArt = 'documents' | 'inbox' | 'checklist' | 'chart' | 'people' | 'search' | 'workflow';

function Art({ kind }: { kind: EmptyArt }) {
  const stroke = 'currentColor';
  const common = { fill: 'none', stroke, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'inbox':
      return (
        <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
          <rect x="18" y="26" width="60" height="44" rx="8" {...common} />
          <path d="M18 52h16l5 8h18l5-8h16" {...common} />
          <path d="M34 26l6-10h16l6 10" {...common} opacity={0.6} />
        </svg>
      );
    case 'checklist':
      return (
        <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
          <rect x="24" y="18" width="48" height="60" rx="8" {...common} />
          <path d="M34 36l5 5 8-9" {...common} />
          <path d="M34 54l5 5 8-9" {...common} opacity={0.7} />
          <line x1="54" y1="36" x2="64" y2="36" {...common} opacity={0.5} />
          <line x1="54" y1="54" x2="64" y2="54" {...common} opacity={0.5} />
        </svg>
      );
    case 'chart':
      return (
        <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
          <path d="M22 70V26M22 70h52" {...common} />
          <rect x="32" y="48" width="9" height="22" rx="3" {...common} opacity={0.7} />
          <rect x="47" y="38" width="9" height="32" rx="3" {...common} opacity={0.85} />
          <rect x="62" y="30" width="9" height="40" rx="3" {...common} />
        </svg>
      );
    case 'people':
      return (
        <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
          <circle cx="38" cy="38" r="11" {...common} />
          <path d="M20 70c0-11 8-18 18-18s18 7 18 18" {...common} />
          <circle cx="64" cy="42" r="8" {...common} opacity={0.6} />
          <path d="M60 68c0-9 4-14 12-14s12 5 12 14" {...common} opacity={0.6} />
        </svg>
      );
    case 'search':
      return (
        <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
          <circle cx="42" cy="42" r="18" {...common} />
          <line x1="56" y1="56" x2="72" y2="72" {...common} />
        </svg>
      );
    case 'workflow':
      return (
        <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
          <rect x="18" y="20" width="22" height="16" rx="5" {...common} />
          <rect x="56" y="20" width="22" height="16" rx="5" {...common} opacity={0.7} />
          <rect x="37" y="60" width="22" height="16" rx="5" {...common} />
          <path d="M40 28h16M67 36v10l-19 14M29 36v10l19 14" {...common} opacity={0.6} />
        </svg>
      );
    case 'documents':
    default:
      return (
        <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden>
          <path d="M34 18h20l12 12v34a6 6 0 0 1-6 6H34a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6z" {...common} />
          <path d="M54 18v12h12" {...common} opacity={0.6} />
          <line x1="38" y1="44" x2="58" y2="44" {...common} opacity={0.6} />
          <line x1="38" y1="54" x2="58" y2="54" {...common} opacity={0.6} />
        </svg>
      );
  }
}

interface EmptyStateProps {
  art?: EmptyArt;
  title: string;
  description?: string;
  action?: React.ReactNode;
  secondary?: React.ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ art = 'documents', title, description, action, secondary, className, compact }: EmptyStateProps) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center text-center', className)}
      style={{ gap: 14, padding: compact ? '28px 20px' : '48px 32px', color: 'var(--muted-foreground)' }}
    >
      <div className="empty-float" style={{ color: 'var(--primary)', opacity: 0.85 }}>
        <Art kind={art} />
      </div>
      <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.0625rem', fontWeight: 700, color: 'var(--foreground)', margin: 0 }}>
        {title}
      </h3>
      {description && <p style={{ fontSize: '0.875rem', maxWidth: 360, margin: 0 }}>{description}</p>}
      {(action || secondary) && (
        <div className="flex items-center gap-3" style={{ marginTop: 6 }}>
          {action}
          {secondary}
        </div>
      )}
    </div>
  );
}

export default EmptyState;
