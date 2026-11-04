/**
 * PageHeader — the standard header every page uses: breadcrumb, title, one-line description,
 * right-aligned actions, optional tabs row. Top-level page titles use the display serif.
 * Sets data-page-header / data-page-title so PageTransition can reveal + focus it.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface Crumb {
  label: string;
  to?: string;
}

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: Crumb[];
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
  /** Use the display serif for the title (top-level pages). Default true. */
  display?: boolean;
  className?: string;
}

export function PageHeader({ title, description, breadcrumbs, actions, tabs, display = true, className }: PageHeaderProps) {
  return (
    <header data-page-header className={cn('flex flex-col gap-3', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5" style={{ fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
          {breadcrumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {c.to ? (
                <Link to={c.to} style={{ color: 'inherit', textDecoration: 'none' }} className="hover:text-[var(--foreground)] transition-colors">
                  {c.label}
                </Link>
              ) : (
                <span style={{ color: 'var(--foreground)' }}>{c.label}</span>
              )}
              {i < breadcrumbs.length - 1 && <ChevronRight size={13} style={{ opacity: 0.6 }} />}
            </span>
          ))}
        </nav>
      )}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1
            data-page-title
            className={cn(display && 'font-display')}
            style={{
              margin: 0,
              outline: 'none',
              fontSize: display ? 'clamp(1.75rem, 1.2rem + 2vw, 2.4rem)' : '1.5rem',
              fontWeight: display ? 400 : 700,
              lineHeight: 1.1,
              color: 'var(--foreground)',
              letterSpacing: display ? '0' : '-0.01em',
            }}
          >
            {title}
          </h1>
          {description && (
            <p style={{ marginTop: 6, fontSize: '0.9rem', color: 'var(--muted-foreground)' }}>{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>

      {tabs && <div className="mt-1">{tabs}</div>}
    </header>
  );
}

export default PageHeader;
