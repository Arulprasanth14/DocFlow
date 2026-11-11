/**
 * Owner feedback panel — WF-REV-03..06, N15. Task P3-10.
 *
 * What the document's owner reads after an approver sends it back: every
 * published comment, grouped by page, with the replies, and the two actions
 * they can take on each one.
 *
 * Grouped by page rather than by time because that is how the work gets done
 * — open the page, fix what is on it, move on. A list ordered by timestamp
 * would make the owner jump between pages.
 *
 * Two asymmetries are deliberate and come from the server:
 *
 *   * **Only "Mark as addressed" is offered to the owner.** Resolving is the
 *     approver accepting the fix; an owner who could resolve would be
 *     approving their own corrections. The server refuses it, and this panel
 *     does not offer a button that would be refused (UX-INT-01).
 *   * **`is_open` comes from the server.** Whether 'addressed' still counts
 *     as outstanding is the same question AP-APR-01 asks when it warns an
 *     approver, so the client must not have its own opinion.
 *
 * Comment text is rendered as plain text. Never `dangerouslySetInnerHTML`:
 * these are words one user typed for another to read (AP-ANN-11).
 */
import { useState } from 'react';
import {
  AlertTriangle, Check, CheckCheck, ChevronDown, ChevronRight,
  CornerDownRight, MessageSquare, Undo2,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  useDocumentFeedback, useReplyToComment, useSetCommentStatus,
} from '@/hooks/useFeedback';
import type { AnnotationThread, FeedbackVersionGroup } from '@/lib/api/feedback';
import { ApiClientError } from '@/lib/api/client';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';

const C = {
  text: 'var(--text-primary)',
  muted: 'var(--text-muted)',
  border: 'var(--border-subtle)',
  hover: 'var(--bg-overlay)',
  accent: 'var(--accent-primary)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
};

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  open: { label: 'Needs attention', color: 'var(--warning)' },
  addressed: { label: 'Marked addressed', color: 'var(--accent-primary)' },
  resolved: { label: 'Resolved by approver', color: 'var(--text-muted)' },
};

interface Props {
  documentId: string;
  /** The current user, to decide which of the two actions to offer. */
  currentUserId: string;
  /** True when the viewer owns the document — they get "mark addressed". */
  isOwner: boolean;
}

export function FeedbackPanel({ documentId, currentUserId, isOwner }: Props) {
  const feedbackQ = useDocumentFeedback(documentId);
  const replyM = useReplyToComment(documentId);
  const statusM = useSetCommentStatus(documentId);

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [collapsedVersions, setCollapsedVersions] = useState<Set<string>>(
    new Set(),
  );

  if (feedbackQ.isLoading) {
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        <Skeleton style={{ height: 68 }} />
        <Skeleton style={{ height: 68 }} />
      </div>
    );
  }

  if (feedbackQ.isError) {
    return (
      <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>
        The review comments could not be loaded. Reload the page to try again.
      </p>
    );
  }

  const data = feedbackQ.data;
  if (!data || data.total_count === 0) {
    return (
      <EmptyState
        title="No review comments"
        description="An approver has not left any comments on this document."
        compact
      />
    );
  }

  async function submitReply(annotationId: string) {
    const body = draft.trim();
    if (!body) {
      toast.error('Write something before replying.');
      return;
    }
    try {
      await replyM.mutateAsync({ annotationId, body });
      setDraft('');
      setReplyingTo(null);
      toast.success('Reply sent');
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.detail : 'Could not send your reply.',
      );
      // The draft is deliberately NOT cleared on failure — AP-ANN-20's rule
      // that review text is never lost applies to a reply just as much.
    }
  }

  async function changeStatus(
    annotationId: string,
    status: 'open' | 'addressed' | 'resolved',
  ) {
    try {
      await statusM.mutateAsync({ annotationId, status });
    } catch (err) {
      // A 409 here carries the transitions the caller CAN make, which is
      // exactly what the user needs to read.
      toast.error(
        err instanceof ApiClientError
          ? err.detail
          : 'Could not update this comment.',
        { duration: 7000 },
      );
    }
  }

  function toggleVersion(id: string) {
    setCollapsedVersions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderComment(comment: AnnotationThread, readOnly: boolean) {
    const status = STATUS_LABEL[comment.status] ?? STATUS_LABEL.open;
    const isAuthor = comment.author_id === currentUserId;
    const canMarkAddressed = isOwner && !readOnly && comment.status === 'open';
    const canUndoAddressed = isOwner && !readOnly && comment.status === 'addressed';
    const canResolve =
      isAuthor && !readOnly && (comment.status === 'open' || comment.status === 'addressed');
    const canReopen = isAuthor && !readOnly && comment.status === 'resolved';

    return (
      <li
        key={comment.id}
        style={{
          listStyle: 'none',
          padding: '12px 14px',
          borderRadius: 10,
          border: `1px solid ${C.border}`,
          background: comment.is_open ? C.hover : 'transparent',
          marginBottom: 8,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
          marginBottom: 6,
        }}>
          <strong style={{ fontSize: 13, color: C.text }}>
            {comment.author_name ?? 'An approver'}
          </strong>
          <span style={{ fontSize: 11, color: status.color, fontWeight: 600 }}>
            {status.label}
          </span>
          {/* AP-ANN-22 / E17: the anchor could not be found on this version.
              A specified outcome, so it is labelled rather than hidden. */}
          {comment.relocated === false && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 11, color: C.warning,
            }}>
              <AlertTriangle size={11} /> Location changed
            </span>
          )}
          <span style={{ fontSize: 11, color: C.muted, marginLeft: 'auto' }}>
            {new Date(comment.published_at ?? comment.created_at).toLocaleString()}
          </span>
        </div>

        {/* The quoted text, so the comment makes sense without opening the
            document — the owner is often triaging from this list. */}
        {comment.selected_text && (
          <blockquote style={{
            margin: '0 0 8px', padding: '6px 10px',
            borderLeft: `3px solid ${C.border}`,
            fontSize: 12.5, color: C.muted, fontStyle: 'italic',
          }}>
            “{comment.selected_text}”
          </blockquote>
        )}

        <p style={{
          margin: 0, fontSize: 13.5, color: C.text, lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
        }}>
          {comment.comment_text}
        </p>

        {comment.replies.length > 0 && (
          <ul style={{ margin: '10px 0 0', padding: 0, display: 'grid', gap: 8 }}>
            {comment.replies.map((reply) => (
              <li key={reply.id} style={{
                listStyle: 'none', display: 'flex', gap: 8,
                paddingLeft: 10, borderLeft: `2px solid ${C.border}`,
              }}>
                <CornerDownRight
                  size={13}
                  style={{ color: C.muted, flexShrink: 0, marginTop: 3 }}
                />
                <div>
                  <p style={{ margin: 0, fontSize: 12.5, color: C.text }}>
                    <strong>{reply.author_name ?? 'Someone'}</strong>{' '}
                    <span style={{ color: C.muted, fontSize: 11 }}>
                      {new Date(reply.created_at).toLocaleString()}
                    </span>
                  </p>
                  <p style={{
                    margin: '2px 0 0', fontSize: 13, color: C.text,
                    whiteSpace: 'pre-wrap',
                  }}>
                    {reply.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Earlier versions are history: no actions at all (WF-REV-12). */}
        {!readOnly && (
          <div style={{
            display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10,
            alignItems: 'center',
          }}>
            {replyingTo === comment.id ? (
              <div style={{ width: '100%' }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  autoFocus
                  placeholder="Say what you changed, or ask a question."
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '8px 10px',
                    background: 'var(--bg-base)',
                    border: `1px solid ${C.border}`, borderRadius: 8,
                    color: C.text, fontSize: 13,
                    fontFamily: "'Inter', sans-serif", resize: 'vertical',
                  }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => submitReply(comment.id)}
                    disabled={replyM.isPending}
                  >
                    {replyM.isPending ? 'Sending…' : 'Reply'}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => { setReplyingTo(null); setDraft(''); }}
                    disabled={replyM.isPending}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="btn btn-secondary"
                onClick={() => { setReplyingTo(comment.id); setDraft(''); }}
              >
                <MessageSquare size={14} /> Reply
              </button>
            )}

            {canMarkAddressed && (
              <button
                className="btn btn-secondary"
                onClick={() => changeStatus(comment.id, 'addressed')}
                disabled={statusM.isPending}
              >
                <Check size={14} /> Mark as addressed
              </button>
            )}
            {canUndoAddressed && (
              <button
                className="btn btn-secondary"
                onClick={() => changeStatus(comment.id, 'open')}
                disabled={statusM.isPending}
              >
                <Undo2 size={14} /> Not addressed after all
              </button>
            )}
            {/* Offered only to the comment's author. The owner marking their
                own feedback resolved would be approving their own
                corrections, and the server refuses it — so no button. */}
            {canResolve && (
              <button
                className="btn btn-secondary"
                onClick={() => changeStatus(comment.id, 'resolved')}
                disabled={statusM.isPending}
              >
                <CheckCheck size={14} /> Resolve
              </button>
            )}
            {canReopen && (
              <button
                className="btn btn-secondary"
                onClick={() => changeStatus(comment.id, 'open')}
                disabled={statusM.isPending}
              >
                <Undo2 size={14} /> Reopen
              </button>
            )}
          </div>
        )}
      </li>
    );
  }

  function renderVersion(group: FeedbackVersionGroup) {
    const collapsed = collapsedVersions.has(group.document_version_id);
    const readOnly = !group.is_current;
    const count = group.pages.reduce((n, p) => n + p.comments.length, 0);

    return (
      <section key={group.document_version_id} style={{ marginBottom: 18 }}>
        <button
          onClick={() => toggleVersion(group.document_version_id)}
          aria-expanded={!collapsed}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '8px 0', background: 'transparent', border: 'none',
            cursor: 'pointer', color: C.text, fontSize: 13, fontWeight: 600,
            fontFamily: "'Inter', sans-serif", textAlign: 'left',
          }}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          Version {group.version_num}
          <span style={{ fontWeight: 400, color: C.muted }}>
            {count} {count === 1 ? 'comment' : 'comments'}
          </span>
          {readOnly && (
            <span style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em',
              textTransform: 'uppercase', color: C.muted,
              border: `1px solid ${C.border}`, borderRadius: 999,
              padding: '1px 7px',
            }}>
              History
            </span>
          )}
        </button>

        {!collapsed && (
          <>
            {readOnly && (
              <p style={{ margin: '0 0 10px', fontSize: 12, color: C.muted }}>
                Comments on an earlier version are kept as a record. They
                refer to text that has since changed, so they can no longer
                be replied to or marked.
              </p>
            )}
            {group.pages.map((page) => (
              <div key={page.page_number} style={{ marginBottom: 10 }}>
                <h5 style={{
                  margin: '0 0 6px', fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.05em', textTransform: 'uppercase',
                  color: C.muted,
                }}>
                  Page {page.page_number}
                </h5>
                <ul style={{ margin: 0, padding: 0 }}>
                  {page.comments.map((c) => renderComment(c, readOnly))}
                </ul>
              </div>
            ))}
          </>
        )}
      </section>
    );
  }

  return (
    <div>
      {data.open_count > 0 && (
        <p style={{
          margin: '0 0 14px', padding: '9px 12px', borderRadius: 10,
          background: 'var(--warning-subtle, rgba(217,119,6,0.12))',
          color: C.warning, fontSize: 13, fontWeight: 600,
        }}>
          {data.open_count} {data.open_count === 1 ? 'comment' : 'comments'} still
          need your attention before you resubmit.
        </p>
      )}
      {data.versions.map(renderVersion)}
    </div>
  );
}

export default FeedbackPanel;
