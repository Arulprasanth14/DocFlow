/**
 * DocFlow Frontend — WorkflowChatPanel
 *
 * Step 4: Slide-out panel for workflow_context conversations.
 * Embeddable in DocumentDetailPage and the Approvals queue view.
 *
 * Features:
 *  - Opens conversation by approval_step_id (idempotent — returns existing)
 *  - Shows document/step context header for clarity
 *  - Reuses useChatWebSocket — same hook, no duplicated socket logic
 *  - Handles 403 from can_user_access_document() with clear error state
 *  - Connection status indicator
 *  - Same send/typing/markRead behavior as ChatPage
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  X, MessageSquare, Send, Loader2,
  ShieldOff
} from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import chatApi from '@/lib/api/chat';
import { useChatWebSocket } from '@/hooks/useChatWebSocket';
import { useAuthStore } from '@/store/authStore';
import { ApiClientError } from '@/lib/api/client';
import { ConnectionBadge } from './ConnectionBadge';

const C = {
  card: 'var(--bg-elevated)', surface: 'var(--bg-surface)', overlay: 'var(--bg-overlay)',
  border: 'var(--border-default)', borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-500)', primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)', warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)', purple: 'var(--color-accent-400)',
  heading: 'var(--text-primary)', body: 'var(--text-secondary)',
  muted: 'var(--text-muted)', disabled: 'var(--text-disabled)',
};

export interface WorkflowChatPanelProps {
  /** The approval step this chat is pinned to */
  approvalStepId: string;
  /** Human-readable context header — e.g. "Purchase Order #102 — Finance Review" */
  contextLabel: string;
  /** Whether the panel is open */
  isOpen: boolean;
  /** Callback to close the panel */
  onClose: () => void;
}

function Avatar({ name, size = 28, color = C.primary400 }: { name?: string | null; size?: number; color?: string }) {
  const initials = (name ?? '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, background: `color-mix(in srgb, ${color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontSize: size * 0.36, fontWeight: 700, color }}>{initials}</span>
    </div>
  );
}

export function WorkflowChatPanel({
  approvalStepId,
  contextLabel,
  isOpen,
  onClose,
}: WorkflowChatPanelProps) {
  const currentUser = useAuthStore((s) => s.user);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [input, setInput] = useState('');
  const [accessError, setAccessError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Step 4.2: Open or create the conversation (idempotent for same step)
  const initConvMutation = useMutation({
    mutationFn: () =>
      chatApi.startConversation({
        kind: 'workflow_context',
        approval_step_id: approvalStepId,
      }),
    onSuccess: (conv) => {
      setConversationId(conv.id);
      setAccessError(null);
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.status === 403) {
        // Step 4.5: Clear error state for 403 — not a broken/empty panel
        setAccessError("You don't have access to the document associated with this conversation.");
      } else {
        setAccessError('Failed to open conversation. Please try again.');
      }
    },
  });

  // Open conversation when panel opens
  useEffect(() => {
    if (isOpen && approvalStepId && !conversationId) {
      setAccessError(null);
      initConvMutation.mutate();
    }
    // Reset when closed
    if (!isOpen) {
      setConversationId(undefined);
      setAccessError(null);
    }
  }, [isOpen, approvalStepId]);

  // Step 4.3: Reuse useChatWebSocket — same hook as ChatPage, no duplication
  const {
    messages,
    connectionStatus,
    typingUsers,
    sendMessage,
    sendTyping,
  } = useChatWebSocket(conversationId, {
    isFocused: isOpen,
  });

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput('');
    sendTyping(false);
    try {
      await sendMessage(text);
    } catch {
      setInput(text); // Restore on failure
    }
  }, [input, sendMessage, sendTyping]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Slide-out animation via CSS transform
  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    right: 0,
    top: 0,
    bottom: 0,
    width: 380,
    maxWidth: '100vw',
    background: C.surface,
    borderLeft: `1px solid ${C.border}`,
    boxShadow: 'var(--shadow-lg)',
    zIndex: 500,
    display: 'flex',
    flexDirection: 'column',
    transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  };

  return (
    <div style={panelStyle}>
      {/* Step 4.4: Context header */}
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.borderSubtle}`, display: 'flex', flexDirection: 'column', gap: 8, background: C.card, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageSquare size={16} color={C.purple} />
            <span style={{ color: C.heading, fontWeight: 700, fontSize: 14 }}>Discussion</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {conversationId && <ConnectionBadge status={connectionStatus} />}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.muted, padding: 4, borderRadius: 6, display: 'flex' }}>
              <X size={16} />
            </button>
          </div>
        </div>
        {/* Context label — so users know what they're discussing */}
        <div style={{ background: `color-mix(in srgb, ${C.purple} 8%, transparent)`, border: `1px solid color-mix(in srgb, ${C.purple} 20%, transparent)`, borderRadius: 8, padding: '6px 10px' }}>
          <span style={{ color: C.purple, fontSize: 11, fontWeight: 600 }}>Discussing: </span>
          <span style={{ color: C.body, fontSize: 11 }}>{contextLabel}</span>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Step 4.5: Access error state */}
        {accessError && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
            <ShieldOff size={36} color={C.danger} style={{ opacity: 0.7 }} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: C.heading, fontWeight: 700, marginBottom: 6 }}>Access Denied</div>
              <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.6 }}>{accessError}</div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {!accessError && !conversationId && initConvMutation.isPending && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: C.muted }}>
            <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 13 }}>Opening conversation…</span>
          </div>
        )}

        {/* Messages */}
        {conversationId && !accessError && (
          <>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
              {messages.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 16px', color: C.muted }}>
                  <MessageSquare size={28} style={{ opacity: 0.3, display: 'block', margin: '0 auto 12px' }} />
                  <div style={{ fontSize: 13 }}>No messages yet. Start the discussion.</div>
                </div>
              )}
              {messages.map((msg) => {
                const isOwn = msg.sender_id === currentUser?.id;
                const timeStr = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                return (
                  <div key={msg.id} style={{ display: 'flex', gap: 8, flexDirection: isOwn ? 'row-reverse' : 'row', alignItems: 'flex-end', marginBottom: 10 }}>
                    {!isOwn && <Avatar name={msg.sender_name} size={26} color={C.purple} />}
                    <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column', gap: 3, alignItems: isOwn ? 'flex-end' : 'flex-start' }}>
                      {/* Plain text — sanitized server-side, rendered safely */}
                      <div style={{
                        padding: '8px 12px',
                        borderRadius: isOwn ? '14px 4px 14px 14px' : '4px 14px 14px 14px',
                        background: isOwn ? `color-mix(in srgb, ${C.primary400} 15%, transparent)` : C.card,
                        border: `1px solid ${isOwn ? `color-mix(in srgb, ${C.primary400} 25%, transparent)` : C.border}`,
                        color: C.heading, fontSize: 13, lineHeight: 1.6,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        {msg.body}
                      </div>
                      <span style={{ color: C.disabled, fontSize: 11 }}>{timeStr}</span>
                    </div>
                  </div>
                );
              })}
              {typingUsers.length > 0 && (
                <div style={{ color: C.muted, fontSize: 11, fontStyle: 'italic', marginBottom: 8 }}>
                  Someone is typing…
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div style={{ padding: '10px 12px 14px', borderTop: `1px solid ${C.borderSubtle}`, flexShrink: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '8px 12px', transition: 'border-color 0.2s' }} className="chat-input-box">
                <textarea
                  value={input}
                  onChange={e => {
                    setInput(e.target.value);
                    sendTyping(true);
                  }}
                  onKeyDown={handleKeyDown}
                  onBlur={() => sendTyping(false)}
                  placeholder="Type a message…"
                  rows={1}
                  style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: C.heading, fontSize: 13, resize: 'none', fontFamily: 'var(--font-sans)', lineHeight: 1.5, maxHeight: 100, overflowY: 'auto' }}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  style={{ width: 32, height: 32, borderRadius: 8, background: input.trim() ? C.primary : C.overlay, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: input.trim() ? 'pointer' : 'not-allowed', flexShrink: 0, transition: 'all 0.2s' }}
                >
                  <Send size={14} color={input.trim() ? 'white' : C.disabled} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <style>{`
        .chat-input-box:focus-within { border-color: var(--color-primary-500) !important; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
