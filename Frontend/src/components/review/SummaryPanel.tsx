/**
 * AI summary panel — AP-SUM-03/04/05/11/12, E13. Task P4-3.
 *
 * Four states, all of them said in words: generating, ready, failed, and
 * unavailable (switched off for the organization, or not configured — a
 * setting, not an error).
 *
 * Two things the panel is built to make unmissable:
 *
 *  - **It is machine-written.** A prominent label, and distinct styling from
 *    anything a person wrote (AP-SUM-11). An approver must never mistake
 *    this for a colleague's note.
 *  - **Which claims were checked.** Every claim cites pages, and the server
 *    has already verified that the figures and dates quoted actually appear
 *    on those pages. Anything that failed is shown struck through with the
 *    reason, rather than quietly dropped — an approver needs to know the
 *    model said something it could not support.
 *
 * Rendered as plain text throughout. Never `dangerouslySetInnerHTML`: this
 * is model output about attacker-supplied content (AP-SUM-09).
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { apiClient, ApiClientError } from '@/lib/api/client';
import { useAuthStore } from '@/store/authStore';
import { Skeleton } from '@/components/ui/Skeleton';

interface SummaryItem {
  text: string;
  pages: number[];
  verified: boolean;
  unverified_reason?: string;
}

interface SummaryContent {
  purpose?: string;
  key_points?: SummaryItem[];
  obligations?: SummaryItem[];
  risks?: SummaryItem[];
  questions?: SummaryItem[];
  truncated?: boolean;
  pages_summarized?: number;
  grounding?: { items: number; verified: number; unverified: number };
}

interface SummaryResponse {
  document_version_id: string;
  status: 'none' | 'pending' | 'ready' | 'failed' | 'unavailable';
  content: SummaryContent | null;
  model: string | null;
  provider: string | null;
  page_count: number | null;
  generated_at: string | null;
  error_code: string | null;
  message: string | null;
  poll_timeout_seconds: number;
}

const BLOCKS: { key: keyof SummaryContent; label: string }[] = [
  { key: 'key_points', label: 'Key points' },
  { key: 'obligations', label: 'Obligations and dates' },
  { key: 'risks', label: 'Worth checking' },
  { key: 'questions', label: 'Unclear from the document' },
];

const C = {
  text: 'var(--text-primary)', muted: 'var(--text-muted)',
  border: 'var(--border-subtle)', warning: 'var(--warning)',
  accent: 'var(--accent-primary)',
};

export function SummaryPanel({ versionId }: { versionId: string }) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  // AP-SUM-05: stop polling after the server's own ceiling, so the panel
  // does not spin forever on work that has already given up.
  const [startedAt] = useState(() => Date.now());
  const [gaveUp, setGaveUp] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const summaryQ = useQuery({
    queryKey: ['summary', versionId] as const,
    queryFn: () =>
      apiClient.get<SummaryResponse>(
        `/approvals/document-versions/${versionId}/summary`,
      ),
    enabled: isAuthenticated && !!versionId,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || gaveUp) return false;
      if (data.status !== 'pending') return false;
      const limit = (data.poll_timeout_seconds ?? 90) * 1000;
      if (Date.now() - startedAt > limit) return false;
      return 3000;
    },
  });

  const data = summaryQ.data;

  useEffect(() => {
    if (data?.status !== 'pending') return undefined;
    const limit = (data.poll_timeout_seconds ?? 90) * 1000;
    const left = limit - (Date.now() - startedAt);
    if (left <= 0) { setGaveUp(true); return undefined; }
    const t = setTimeout(() => setGaveUp(true), left);
    return () => clearTimeout(t);
  }, [data?.status, data?.poll_timeout_seconds, startedAt]);

  async function regenerate() {
    setRegenerating(true);
    try {
      await apiClient.post(
        `/approvals/document-versions/${versionId}/summary/regenerate`,
      );
      setGaveUp(false);
      await summaryQ.refetch();
    } catch (err) {
      // 409 (already generating) and 429 (just generated) both carry a
      // sentence worth reading.
      toast.error(
        err instanceof ApiClientError ? err.detail : 'Could not regenerate the summary.',
      );
    } finally {
      setRegenerating(false);
    }
  }

  // AP-SUM-12: the owner is refused outright. Not an error to shout about.
  if (summaryQ.error instanceof ApiClientError && summaryQ.error.status === 403) {
    return (
      <p style={{ fontSize: 13, color: C.muted, margin: 0, lineHeight: 1.6 }}>
        The reviewer's summary is only shown to the approvers reviewing this
        document.
      </p>
    );
  }

  const header = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      marginBottom: 12,
    }}>
      {/* AP-SUM-11: unmissable, and styled unlike anything a person wrote. */}
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 9px', borderRadius: 999, fontSize: 10.5,
        fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
        color: C.accent, border: `1px dashed ${C.accent}`,
      }}>
        <Sparkles size={11} /> AI-generated
      </span>
      {data?.status === 'ready' && (
        <button
          onClick={regenerate}
          disabled={regenerating}
          style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center',
            gap: 5, background: 'transparent', border: 'none', color: C.muted,
            cursor: regenerating ? 'default' : 'pointer', fontSize: 11.5,
          }}
        >
          <RefreshCw size={12} /> {regenerating ? 'Starting…' : 'Regenerate'}
        </button>
      )}
    </div>
  );

  if (summaryQ.isLoading) {
    return <><Skeleton style={{ height: 16, marginBottom: 8 }} /><Skeleton style={{ height: 90 }} /></>;
  }

  if (!data || data.status === 'none') {
    return (
      <>
        {header}
        <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>
          No summary has been generated for this version yet.
        </p>
      </>
    );
  }

  if (data.status === 'unavailable') {
    return (
      <>
        {header}
        <p style={{ fontSize: 13, color: C.muted, margin: 0, lineHeight: 1.6 }}>
          {data.message
            ?? 'AI summaries are not available for this organization.'}
        </p>
      </>
    );
  }

  if (data.status === 'pending' && !gaveUp) {
    return (
      <>
        {header}
        <p role="status" style={{ fontSize: 13, color: C.muted, margin: 0 }}>
          Reading the document and writing a summary…
        </p>
        <Skeleton style={{ height: 70, marginTop: 10 }} />
      </>
    );
  }

  if (data.status === 'failed' || gaveUp) {
    return (
      <>
        {header}
        <p style={{
          display: 'flex', gap: 8, fontSize: 13, color: C.muted,
          margin: 0, lineHeight: 1.6,
        }}>
          <AlertTriangle size={14} style={{ color: C.warning, flexShrink: 0, marginTop: 2 }} />
          {gaveUp && data.status === 'pending'
            ? 'The summary is taking longer than expected. You can try again.'
            : (data.message ?? 'The summary could not be generated.')}
        </p>
        <button className="btn btn-secondary" style={{ marginTop: 12 }}
          onClick={regenerate} disabled={regenerating}>
          <RefreshCw size={13} /> Try again
        </button>
      </>
    );
  }

  const content = data.content ?? {};
  const grounding = content.grounding;

  return (
    <>
      {header}

      {content.purpose && (
        <p style={{
          margin: '0 0 14px', fontSize: 13.5, color: C.text, lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
        }}>
          {content.purpose}
        </p>
      )}

      {BLOCKS.map(({ key, label }) => {
        const items = (content[key] as SummaryItem[] | undefined) ?? [];
        if (items.length === 0) return null;
        return (
          <section key={key} style={{ marginBottom: 14 }}>
            <h5 style={{
              margin: '0 0 6px', fontSize: 11, fontWeight: 700, color: C.muted,
              letterSpacing: '0.05em', textTransform: 'uppercase',
            }}>
              {label}
            </h5>
            <ul style={{ margin: 0, padding: 0, display: 'grid', gap: 7 }}>
              {items.map((item, i) => (
                <li key={`${key}-${i}`} style={{
                  listStyle: 'none', fontSize: 13, color: C.text,
                  lineHeight: 1.55, paddingLeft: 10,
                  borderLeft: `2px solid ${item.verified ? C.border : C.warning}`,
                }}>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{item.text}</span>
                  {/* AP-SUM-06: citations are checkable, so they are shown. */}
                  {item.pages.length > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: C.muted }}>
                      {item.pages.map((p) => `p.${p}`).join(', ')}
                    </span>
                  )}
                  {!item.verified && (
                    <span style={{
                      display: 'block', marginTop: 2, fontSize: 11,
                      color: C.warning,
                    }}>
                      Unverified — {item.unverified_reason ?? 'could not be checked'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {content.truncated && (
        <p style={{ fontSize: 11.5, color: C.warning, margin: '0 0 10px' }}>
          The document was too long to summarize in full; only the first{' '}
          {content.pages_summarized} pages were read.
        </p>
      )}

      <p style={{
        margin: 0, paddingTop: 10, borderTop: `1px solid ${C.border}`,
        fontSize: 11, color: C.muted, lineHeight: 1.5,
      }}>
        {grounding
          ? `${grounding.verified} of ${grounding.items} claims were checked against the pages they cite. `
          : ''}
        Written by {data.model ?? 'a language model'}. Check anything you
        rely on against the document itself.
      </p>
    </>
  );
}

export default SummaryPanel;
