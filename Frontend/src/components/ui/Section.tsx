/**
 * Section — a titled content block used across pages so everything reads as one system.
 * Marks itself with data-section so PageTransition staggers it in.
 */

import React from 'react';
import { cn } from '@/lib/utils';

interface SectionProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Skip the data-section marker (e.g. when the child grid already staggers its own items). */
  noStagger?: boolean;
}

export function Section({ title, description, action, children, className, noStagger }: SectionProps) {
  return (
    <section {...(noStagger ? {} : { 'data-section': '' })} className={cn('flex flex-col gap-4', className)}>
      {(title || action) && (
        <div className="flex items-end justify-between gap-3">
          <div>
            {title && (
              <h2 style={{ margin: 0, fontFamily: 'var(--font-heading)', fontSize: '1.0625rem', fontWeight: 700, color: 'var(--foreground)', letterSpacing: '-0.01em' }}>
                {title}
              </h2>
            )}
            {description && <p style={{ marginTop: 2, fontSize: '0.82rem', color: 'var(--muted-foreground)' }}>{description}</p>}
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export default Section;
