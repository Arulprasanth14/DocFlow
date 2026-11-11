/**
 * Version comparison — AP-RES-03, T18. Task P4-4.
 *
 * The approver's "what actually changed?" after a resubmission, page by page.
 *
 * The specified fallback matters as much as the diff: when a version has no
 * text layer there is nothing to compare, and the panel says so. An empty
 * diff would read as "nothing changed", which is the one wrong answer.
 */
import { useQuery } from '@tanstack/react-query';
import { FileDiff, Minus, Plus } from 'lucide-react';

import { apiClient } from '@/lib/api/client';
import { useAuthStore } from '@/store/authStore';
import { Skeleton } from '@/components/ui/Skeleton';

interface PageDiff {
  page_number: number;
  status: 'unchanged' | 'changed' | 'rewritten' | 'added' | 'removed';
  added: string[];
  removed: string[];
  similarity: number;
  truncated: boolean;
}

interface VersionDiff {
  from_version_num: number | null;
  to_version_num: number | null;
  available: boolean;
  reason: string | null;
  changed_pages: number[];
  added_pages: number[];
  removed_pages: number[];
  pages: PageDiff[];
}

const C = {
  text: 'var(--text-primary)', muted: 'var(--text-muted)',
  border: 'var(--border-subtle)', warning: 'var(--warning)',
  added: 'var(--success, #16a34a)', removed: 'var(--danger)',
};

export function VersionDiffPanel({
  fromVersionId, toVersionId, onGoToPage,
}: {
  fromVersionId: string;
  toVersionId: string;
  onGoToPage?: (page: number) => void;
}) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  const diffQ = useQuery({
    queryKey: ['version-diff', fromVersionId, toVersionId] as const,
    queryFn: () =>
      apiClient.get<VersionDiff>(
        `/approvals/document-versions/${fromVersionId}/compare/${toVersionId}`,
      ),
    enabled: isAuthenticated && !!fromVersionId && !!toVersionId,
    // Versions are immutable, so the answer cannot change.
    staleTime: Infinity,
    retry: false,
  });

  if (diffQ.isLoading) return <Skeleton style={{ height: 120 }} />;
  if (diffQ.isError || !diffQ.data) {
    return (
      <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>
        The two versions could not be compared.
      </p>
    );
  }

  const d = diffQ.data;

  if (!d.available) {
    return (
      <p style={{ fontSize: 13, color: C.muted, margin: 0, lineHeight: 1.6 }}>
        {d.reason ?? 'These versions cannot be compared.'}
      </p>
    );
  }

  const touched = d.pages.filter((p) => p.status !== 'unchanged');

  return (
    <div>
      <p style={{
        display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 12px',
        fontSize: 12.5, color: C.muted,
      }}>
        <FileDiff size={14} />
        Version {d.from_version_num} to {d.to_version_num}
      </p>

      {touched.length === 0 ? (
        <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>
          The text of these two versions is identical. Any change is in
          formatting or images, which this comparison does not read.
        </p>
      ) : (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: C.text }}>
            {d.changed_pages.length > 0 && (
              <>Changed: {d.changed_pages.map((p) => `p.${p}`).join(', ')}. </>
            )}
            {d.added_pages.length > 0 && (
              <>Added: {d.added_pages.map((p) => `p.${p}`).join(', ')}. </>
            )}
            {d.removed_pages.length > 0 && (
              <>Removed: {d.removed_pages.map((p) => `p.${p}`).join(', ')}.</>
            )}
          </p>

          {touched.map((page) => (
            <section key={page.page_number} style={{ marginBottom: 14 }}>
              <button
                onClick={() => onGoToPage?.(page.page_number)}
                disabled={!onGoToPage || page.status === 'removed'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: 0, marginBottom: 6, background: 'transparent',
                  border: 'none', textAlign: 'left',
                  cursor: onGoToPage && page.status !== 'removed' ? 'pointer' : 'default',
                  fontSize: 11, fontWeight: 700, color: C.muted,
                  letterSpacing: '0.05em', textTransform: 'uppercase',
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                Page {page.page_number}
                <span style={{
                  fontWeight: 600, textTransform: 'none', letterSpacing: 0,
                  color: page.status === 'added' ? C.added
                    : page.status === 'removed' ? C.removed : C.warning,
                }}>
                  {page.status}
                </span>
              </button>

              {page.status === 'rewritten' && (
                <p style={{ margin: 0, fontSize: 12.5, color: C.muted }}>
                  This page was rewritten; too little of it is the same to
                  show a line-by-line comparison.
                </p>
              )}

              {page.removed.map((line, i) => (
                <p key={`r-${i}`} style={{
                  display: 'flex', gap: 6, margin: '0 0 2px', fontSize: 12.5,
                  color: C.muted, lineHeight: 1.5,
                }}>
                  <Minus size={12} style={{ color: C.removed, flexShrink: 0, marginTop: 3 }} />
                  <span style={{ textDecoration: 'line-through' }}>{line}</span>
                </p>
              ))}
              {page.added.map((line, i) => (
                <p key={`a-${i}`} style={{
                  display: 'flex', gap: 6, margin: '0 0 2px', fontSize: 12.5,
                  color: C.text, lineHeight: 1.5,
                }}>
                  <Plus size={12} style={{ color: C.added, flexShrink: 0, marginTop: 3 }} />
                  <span>{line}</span>
                </p>
              ))}

              {page.truncated && (
                <p style={{ margin: '4px 0 0', fontSize: 11.5, color: C.warning }}>
                  Too many changes on this page to list them all. Open the page
                  to read it.
                </p>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

export default VersionDiffPanel;
