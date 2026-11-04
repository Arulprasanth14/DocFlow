/**
 * Skeleton — soft shimmer placeholder (transform-based, reduced-motion aware via .skeleton CSS).
 * Use for page/section-level loading instead of spinners.
 */

import React from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, style, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton', className)} style={style} {...rest} />;
}

/** A labelled block of skeleton lines for list/card loading states. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} style={{ height: 12, width: i === lines - 1 ? '60%' : '100%' }} />
      ))}
    </div>
  );
}

export default Skeleton;
