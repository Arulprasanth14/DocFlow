/**
 * StatusBadge — soft-bg + readable-text status pill with a leading dot.
 * Maps a raw status string to the shared `.status-*` classes (pulsing dot for in-flight states).
 * Pure presentation; status vocabulary matches the backend DocumentStatus values.
 */

import { cn } from '@/lib/utils';

const LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'In Review',
  pending: 'Pending',
  pending_approval: 'Pending',
  sent_back: 'Sent Back',
  revision_requested: 'Revision',
  approved: 'Approved',
  finalized: 'Finalized',
  rejected: 'Rejected',
  revoked: 'Revoked',
  archived: 'Archived',
  cancelled: 'Cancelled',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const key = (status || '').toLowerCase();
  const label = LABELS[key] ?? status;
  return <span className={cn('status-badge', `status-${key}`, className)}>{label}</span>;
}

export default StatusBadge;
