/**
 * DocFlow Frontend — Component: CommentDrawer
 * Slide-over threaded collaboration drawer for document review,
 * supporting nested replies, internal notes, mentions, and resolution toggles.
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  useDocumentComments,
  useAddDocumentComment,
  useUpdateDocumentComment,
} from '@/hooks/useDocuments';
import type { Comment } from '@/types';

export interface CommentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  docId: string;
  docTitle: string;
}

function CommentItem({
  comment,
  docId,
  onReply,
  onResolveToggle,
}: {
  comment: Comment;
  docId: string;
  onReply: (parent: Comment) => void;
  onResolveToggle: (comment: Comment) => void;
}) {
  const isResolved = Boolean(comment.resolved_at);

  const initials = comment.author_name
    ? comment.author_name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : 'U';

  return (
    <div
      style={{
        padding: '14px 16px',
        background: isResolved
          ? 'var(--bg-overlay)'
          : comment.is_internal
          ? 'hsla(38, 92%, 50%, 0.07)'
          : 'var(--bg-card)',
        border: comment.is_internal
          ? '1px solid hsla(38, 92%, 50%, 0.25)'
          : '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        marginBottom: '10px',
        opacity: isResolved ? 0.65 : 1,
        transition: 'all var(--transition-fast)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Avatar */}
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              background: 'linear-gradient(135deg, var(--color-primary-600), var(--color-primary-400))',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              fontWeight: 700,
            }}
          >
            {initials}
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {comment.author_name || 'Team Member'}
              </span>
              {comment.is_internal && (
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    color: 'var(--color-warning-400)',
                    background: 'hsla(38, 92%, 50%, 0.15)',
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  🔒 Internal
                </span>
              )}
              {isResolved && (
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    color: 'var(--color-success-400)',
                    background: 'hsla(150, 80%, 40%, 0.12)',
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  ✓ Resolved
                </span>
              )}
            </div>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {new Date(comment.created_at).toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => onResolveToggle(comment)}
            className="btn btn-ghost btn-sm"
            style={{
              fontSize: '0.75rem',
              padding: '4px 8px',
              color: isResolved ? 'var(--text-secondary)' : 'var(--color-success-400)',
            }}
          >
            {isResolved ? 'Reopen' : 'Resolve'}
          </button>
          <button
            onClick={() => onReply(comment)}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '0.75rem', padding: '4px 8px' }}
          >
            Reply
          </button>
        </div>
      </div>

      {/* Body */}
      <p
        style={{
          fontSize: '0.88rem',
          color: 'var(--text-primary)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          marginBottom: comment.replies && comment.replies.length > 0 ? '12px' : '0',
        }}
      >
        {comment.body}
      </p>

      {/* Replies */}
      {comment.replies && comment.replies.length > 0 && (
        <div
          style={{
            marginLeft: '18px',
            paddingLeft: '14px',
            borderLeft: '2px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            marginTop: '10px',
          }}
        >
          {comment.replies.map((reply) => (
            <CommentItem
              key={reply.id}
              comment={reply}
              docId={docId}
              onReply={onReply}
              onResolveToggle={onResolveToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CommentDrawer({ isOpen, onClose, docId, docTitle }: CommentDrawerProps) {
  const { data: comments = [], isLoading } = useDocumentComments(docId);
  const addComment = useAddDocumentComment();
  const updateComment = useUpdateDocumentComment();

  const [body, setBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [replyParent, setReplyParent] = useState<Comment | null>(null);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;

    try {
      await addComment.mutateAsync({
        docId,
        data: {
          body: body.trim(),
          parent_id: replyParent?.id || null,
          is_internal: isInternal,
        },
      });
      setBody('');
      setReplyParent(null);
    } catch {
      // Error handled by query hook / global error toast
    }
  };

  const handleResolveToggle = async (comment: Comment) => {
    try {
      await updateComment.mutateAsync({
        docId,
        commentId: comment.id,
        data: {
          is_resolved: !comment.resolved_at,
        },
      });
    } catch {
      // Error handled
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'hsla(220, 50%, 5%, 0.65)',
              backdropFilter: 'blur(4px)',
              zIndex: 300,
            }}
          />

          {/* Slide-over Drawer */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              width: '100%',
              maxWidth: '440px',
              background: 'var(--bg-main)',
              borderLeft: '1px solid var(--border-subtle)',
              zIndex: 301,
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '-8px 0 32px rgba(0, 0, 0, 0.4)',
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: '20px 24px',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <h2
                  style={{
                    fontSize: '1.15rem',
                    fontWeight: 800,
                    color: 'var(--text-primary)',
                    marginBottom: '2px',
                  }}
                >
                  Document Comments
                </h2>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  {docTitle}
                </p>
              </div>
              <button
                onClick={onClose}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: '6px',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                ✕
              </button>
            </div>

            {/* Comments Stream */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '20px 24px',
              }}
            >
              {isLoading ? (
                <div style={{ padding: '40px', textAlign: 'center' }}>
                  <div className="spinner" style={{ width: '28px', height: '28px' }} />
                </div>
              ) : comments.length === 0 ? (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '48px 20px',
                    color: 'var(--text-muted)',
                  }}
                >
                  <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>💬</div>
                  <p style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    No comments yet
                  </p>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Start a conversation or leave an internal review note below.
                  </p>
                </div>
              ) : (
                comments.map((comment) => (
                  <CommentItem
                    key={comment.id}
                    comment={comment}
                    docId={docId}
                    onReply={(parent) => setReplyParent(parent)}
                    onResolveToggle={handleResolveToggle}
                  />
                ))
              )}
            </div>

            {/* Compose Footer */}
            <div
              style={{
                padding: '16px 24px',
                borderTop: '1px solid var(--border-subtle)',
                background: 'var(--bg-card)',
              }}
            >
              {replyParent && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    background: 'var(--bg-overlay)',
                    borderRadius: 'var(--radius-md)',
                    marginBottom: '10px',
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                    borderLeft: '3px solid var(--color-primary-500)',
                  }}
                >
                  <span>
                    Replying to <strong>{replyParent.author_name}</strong>
                  </span>
                  <button
                    onClick={() => setReplyParent(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              <form onSubmit={handleSend} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <textarea
                  className="input"
                  placeholder={
                    replyParent
                      ? 'Write a reply...'
                      : 'Add a comment or @mention team members...'
                  }
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={3}
                  style={{ resize: 'none', fontSize: '0.88rem' }}
                />

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      color: 'var(--text-secondary)',
                      fontWeight: 600,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isInternal}
                      onChange={(e) => setIsInternal(e.target.checked)}
                      style={{
                        width: '16px',
                        height: '16px',
                        accentColor: 'var(--color-warning-500)',
                      }}
                    />
                    <span>🔒 Internal note (team only)</span>
                  </label>

                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={!body.trim() || addComment.isPending}
                    style={{ padding: '6px 16px' }}
                  >
                    {addComment.isPending ? 'Sending...' : replyParent ? 'Reply' : 'Comment'}
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default CommentDrawer;
