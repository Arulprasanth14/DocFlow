/**
 * DocFlow Frontend — Date Utilities
 */

export function formatDate(isoString?: string | null): string {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '—';
  }
}

export function formatDateTime(isoString?: string | null): string {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}
