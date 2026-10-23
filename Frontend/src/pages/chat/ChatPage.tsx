/**
 * DocFlow Frontend — Chat Page (Direct Messages)
 *
 * Step 3: Replaces the mocked "AI Assistant" with real human-to-human
 * direct messaging backed by the live backend.
 *
 * Features:
 *  - Conversation list (left panel) with unread badges
 *  - Active conversation view with real-time WebSocket messages
 *  - New DM flow: search org members → startConversation
 *  - Connection status indicator (shows reconnecting/offline state)
 *  - Message content rendered as plain text (no dangerouslySetInnerHTML)
 *  - Typing indicators from other participants
 *  - Keyboard shortcut: Enter to send, Shift+Enter for newline
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  MessageSquare, Plus, Search, Send, Users,
  Loader2, ArrowLeft
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import chatApi, { type Conversation, type OrgMember } from '@/lib/api/chat';
import { useChatWebSocket } from '@/hooks/useChatWebSocket';
import { ConnectionBadge } from '@/components/ui/ConnectionBadge';
import { useAuthStore } from '@/store/authStore';

const C = {
  bg: 'var(--bg-base)', card: 'var(--bg-elevated)', surface: 'var(--bg-surface)',
  overlay: 'var(--bg-overlay)', border: 'var(--border-default)', borderSubtle: 'var(--border-subtle)',
  primary: 'var(--color-primary-500)', primary400: 'var(--color-primary-400)',
  success: 'var(--color-success-400)', warning: 'var(--color-warning-400)',
  danger: 'var(--color-error-400)', purple: 'var(--color-accent-400)',
  heading: 'var(--text-primary)', body: 'var(--text-secondary)',
  muted: 'var(--text-muted)', disabled: 'var(--text-disabled)',
};


// ── Avatar ─────────────────────────────────────────────────────────────────────
function Avatar({ name, size = 32, color = C.primary400 }: { name?: string | null; size?: number; color?: string }) {
  const initials = (name ?? '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, background: `color-mix(in srgb, ${color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ fontSize: size * 0.36, fontWeight: 700, color }}>{initials}</span>
    </div>
  );
}

// ── Conversation List Item ────────────────────────────────────────────────────
function ConvItem({ conv, isActive, onClick, currentUserId }: {
  conv: Conversation; isActive: boolean; onClick: () => void; currentUserId: string;
}) {
  const otherParticipant = conv.participants.find(p => p.user_id !== currentUserId);
  const displayName = otherParticipant?.user_name ?? otherParticipant?.user_email ?? 'Conversation';
  const lastMsgAt = conv.last_message_at ? new Date(conv.last_message_at) : null;
  const timeStr = lastMsgAt
    ? lastMsgAt.toLocaleDateString() === new Date().toLocaleDateString()
      ? lastMsgAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : lastMsgAt.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : '';

  return (
    <div
      onClick={onClick}
      style={{
        padding: '11px 14px', borderRadius: 12, cursor: 'pointer', marginBottom: 4,
        background: isActive ? `color-mix(in srgb, ${C.primary400} 10%, transparent)` : 'transparent',
        border: `1px solid ${isActive ? `color-mix(in srgb, ${C.primary400} 20%, transparent)` : 'transparent'}`,
        transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: 10,
      }}
      className="conv-item"
    >
      <Avatar name={displayName} color={C.primary400} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: isActive ? C.primary400 : C.heading, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {displayName}
          </span>
          <span style={{ color: C.disabled, fontSize: 11, flexShrink: 0, marginLeft: 6 }}>{timeStr}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ color: C.muted, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
            {conv.last_message_body ?? 'Start a conversation'}
          </span>
          {conv.unread_count > 0 && (
            <span style={{ background: C.primary, color: '#fff', fontSize: 10, fontWeight: 700, borderRadius: 99, padding: '1px 6px', flexShrink: 0 }}>
              {conv.unread_count > 99 ? '99+' : conv.unread_count}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Message Bubble ─────────────────────────────────────────────────────────────
function MessageBubble({ body, isOwn, senderName, timestamp }: {
  body: string; isOwn: boolean; senderName: string | null; timestamp: string;
}) {
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div style={{ display: 'flex', gap: 8, flexDirection: isOwn ? 'row-reverse' : 'row', alignItems: 'flex-end', marginBottom: 12 }}>
      {!isOwn && <Avatar name={senderName} size={28} color={C.purple} />}
      <div style={{ maxWidth: '70%', display: 'flex', flexDirection: 'column', gap: 3, alignItems: isOwn ? 'flex-end' : 'flex-start' }}>
        {!isOwn && senderName && (
          <span style={{ color: C.muted, fontSize: 11, marginBottom: 1 }}>{senderName}</span>
        )}
        {/* Content rendered as plain text — body is sanitized server-side; no innerHTML */}
        <div style={{
          padding: '9px 13px',
          borderRadius: isOwn ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
          background: isOwn ? `color-mix(in srgb, ${C.primary400} 18%, transparent)` : C.card,
          border: `1px solid ${isOwn ? `color-mix(in srgb, ${C.primary400} 30%, transparent)` : C.border}`,
          color: C.heading, fontSize: 14, lineHeight: 1.6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {/* Plain text — never dangerouslySetInnerHTML */}
          {body}
        </div>
        <span style={{ color: C.disabled, fontSize: 11 }}>{timeStr}</span>
      </div>
    </div>
  );
}

// ── New Conversation Modal ─────────────────────────────────────────────────────
function NewDMModal({ onClose, onStart }: {
  onClose: () => void;
  onStart: (userId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const { data: members, isLoading } = useQuery({
    queryKey: ['chat', 'members', search],
    queryFn: () => chatApi.listMembers(search || undefined, 30),
    staleTime: 1000 * 30,
  });

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: C.card, borderRadius: 20, padding: 24, width: 380, maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: 16, border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Users size={18} color={C.primary400} />
          <h3 style={{ color: C.heading, fontWeight: 700, margin: 0 }}>New Message</h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '8px 12px' }}>
          <Search size={14} color={C.muted} />
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            style={{ background: 'none', border: 'none', outline: 'none', color: C.heading, fontSize: 13, flex: 1 }}
          />
        </div>
        <div style={{ overflowY: 'auto', maxHeight: 320, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {isLoading && (
            <div style={{ textAlign: 'center', padding: '24px 0', color: C.muted, fontSize: 13 }}>
              <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', marginBottom: 8, display: 'block', margin: '0 auto 8px' }} />
              Searching members…
            </div>
          )}
          {!isLoading && (members ?? []).map((m: OrgMember) => (
            <div
              key={m.id}
              onClick={() => { onStart(m.id); onClose(); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', transition: 'all 0.15s' }}
              className="member-row"
            >
              <Avatar name={m.display_name} size={36} color={C.primary400} />
              <div>
                <div style={{ color: C.heading, fontSize: 13, fontWeight: 600 }}>{m.display_name}</div>
                <div style={{ color: C.muted, fontSize: 11 }}>{m.email}</div>
              </div>
            </div>
          ))}
          {!isLoading && (members ?? []).length === 0 && search && (
            <div style={{ textAlign: 'center', padding: 24, color: C.muted, fontSize: 13 }}>No members found for "{search}"</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function ChatPage() {
  const currentUser = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [activeConvId, setActiveConvId] = useState<string | undefined>(undefined);
  const [input, setInput] = useState('');
  const [showNewDM, setShowNewDM] = useState(false);
  const [isFocused, setIsFocused] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: convsData, isLoading: convsLoading } = useQuery({
    queryKey: ['chat', 'conversations', 'direct'],
    queryFn: () => chatApi.listConversations({ kind: 'direct', limit: 50 }),
    refetchInterval: 30000, // Poll every 30s for new convs/unread counts
    staleTime: 1000 * 10,
  });

  const convs = convsData?.items ?? [];

  const {
    messages,
    connectionStatus,
    typingUsers,
    sendMessage,
    sendTyping,
    loadMore,
    hasMore,
    isLoadingMore,
  } = useChatWebSocket(activeConvId, {
    isFocused,
    onMessage: () => {
      // Invalidate conversation list to refresh unread counts
      queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
    },
  });

  const startConvMutation = useMutation({
    mutationFn: (participantId: string) =>
      chatApi.startConversation({ kind: 'direct', participant_user_id: participantId }),
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] });
      setActiveConvId(conv.id);
    },
  });

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Focus tracking
  useEffect(() => {
    const onFocus = () => setIsFocused(true);
    const onBlur = () => setIsFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput('');
    sendTyping(false);
    try {
      await sendMessage(text);
    } catch (err) {
      console.error('[ChatPage] Send failed:', err);
      setInput(text); // Restore on failure
    }
  }, [input, sendMessage, sendTyping]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const activeConv = convs.find(c => c.id === activeConvId);
  const otherParticipant = activeConv?.participants.find(p => p.user_id !== currentUser?.id);

  return (
    <div style={{ position: 'relative', height: 'calc(100vh - var(--header-height))', display: 'flex', overflow: 'hidden' }}>
      {/* Ambient glow */}
      <div style={{ position: 'absolute', top: -150, right: -100, width: 500, height: 500, borderRadius: 9999, background: 'radial-gradient(circle, rgba(37,99,235,0.1) 0%, transparent 65%)', filter: 'blur(180px)', zIndex: 1, pointerEvents: 'none' }} />

      <div style={{ position: 'relative', zIndex: 10, display: 'flex', width: '100%' }}>
        {/* ── Sidebar ── */}
        <div style={{ width: 280, borderRight: `1px solid ${C.borderSubtle}`, display: 'flex', flexDirection: 'column', background: C.surface, flexShrink: 0 }}>
          {/* Header */}
          <div style={{ padding: '16px 16px 12px', borderBottom: `1px solid ${C.borderSubtle}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <MessageSquare size={18} color={C.primary400} />
                <h1 style={{ fontSize: 16, fontWeight: 800, color: C.heading, margin: 0 }}>Messages</h1>
              </div>
              <button
                onClick={() => setShowNewDM(true)}
                style={{ width: 30, height: 30, borderRadius: 8, background: `color-mix(in srgb, ${C.primary400} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${C.primary400} 20%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.primary400 }}
                title="New message"
              >
                <Plus size={15} />
              </button>
            </div>
          </div>

          {/* Conversation List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {convsLoading && (
              <div style={{ textAlign: 'center', padding: '32px 0', color: C.muted, fontSize: 13 }}>
                <Loader2 size={20} style={{ animation: 'spin 1s linear infinite', display: 'block', margin: '0 auto 8px' }} />
                Loading…
              </div>
            )}
            {!convsLoading && convs.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 16px', color: C.muted }}>
                <MessageSquare size={32} style={{ opacity: 0.3, display: 'block', margin: '0 auto 12px' }} />
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No conversations yet</div>
                <div style={{ fontSize: 12 }}>Click the + button to start a new message</div>
              </div>
            )}
            {convs.map((conv) => (
              <ConvItem
                key={conv.id}
                conv={conv}
                isActive={conv.id === activeConvId}
                currentUserId={currentUser?.id ?? ''}
                onClick={() => setActiveConvId(conv.id)}
              />
            ))}
          </div>
        </div>

        {/* ── Main Chat Area ── */}
        {activeConvId && activeConv ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Chat Header */}
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.borderSubtle}`, display: 'flex', alignItems: 'center', gap: 12, background: C.surface, flexShrink: 0 }}>
              <button
                onClick={() => setActiveConvId(undefined)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.muted, display: 'flex', padding: 4 }}
              >
                <ArrowLeft size={18} />
              </button>
              <Avatar name={otherParticipant?.user_name ?? otherParticipant?.user_email} />
              <div style={{ flex: 1 }}>
                <div style={{ color: C.heading, fontWeight: 700, fontSize: 14 }}>
                  {otherParticipant?.user_name ?? otherParticipant?.user_email ?? 'Unknown'}
                </div>
                {typingUsers.length > 0 && (
                  <div style={{ color: C.muted, fontSize: 11, fontStyle: 'italic' }}>typing…</div>
                )}
              </div>
              <ConnectionBadge status={connectionStatus} />
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column' }}>
              {hasMore && (
                <div style={{ textAlign: 'center', marginBottom: 16 }}>
                  <button
                    onClick={loadMore}
                    disabled={isLoadingMore}
                    style={{ padding: '6px 16px', borderRadius: 8, background: C.overlay, border: `1px solid ${C.border}`, color: C.muted, fontSize: 12, cursor: 'pointer' }}
                  >
                    {isLoadingMore ? 'Loading…' : 'Load older messages'}
                  </button>
                </div>
              )}
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  body={msg.body}
                  isOwn={msg.sender_id === currentUser?.id}
                  senderName={msg.sender_name}
                  timestamp={msg.created_at}
                />
              ))}
              {typingUsers.length > 0 && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}>
                  <Avatar name="?" size={28} color={C.purple} />
                  <div style={{ padding: '9px 13px', borderRadius: '4px 16px 16px 16px', background: C.card, border: `1px solid ${C.border}`, display: 'flex', gap: 4, alignItems: 'center' }}>
                    {[0, 1, 2].map(i => (
                      <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: C.purple, animation: `typingDot 1.2s ${i * 0.2}s ease infinite` }} />
                    ))}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div style={{ padding: '12px 20px 16px', borderTop: `1px solid ${C.borderSubtle}`, flexShrink: 0 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: '10px 14px', transition: 'border-color 0.2s' }} className="chat-input-box">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => {
                    setInput(e.target.value);
                    sendTyping(true);
                  }}
                  onKeyDown={handleKeyDown}
                  onBlur={() => sendTyping(false)}
                  placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
                  rows={1}
                  style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: C.heading, fontSize: 14, resize: 'none', fontFamily: 'var(--font-sans)', lineHeight: 1.5, maxHeight: 120, overflowY: 'auto' }}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim()}
                  style={{ width: 36, height: 36, borderRadius: 10, background: input.trim() ? C.primary : C.overlay, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: input.trim() ? 'pointer' : 'not-allowed', flexShrink: 0, transition: 'all 0.2s' }}
                >
                  <Send size={16} color={input.trim() ? 'white' : C.disabled} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, color: C.muted }}>
            <MessageSquare size={48} style={{ opacity: 0.25 }} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: C.heading, fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Select a conversation</div>
              <div style={{ fontSize: 13 }}>Choose from the left or start a new message</div>
            </div>
            <button
              onClick={() => setShowNewDM(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: C.primary, border: 'none', borderRadius: 12, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              <Plus size={15} /> New Message
            </button>
          </div>
        )}
      </div>

      {/* New DM Modal */}
      {showNewDM && (
        <NewDMModal
          onClose={() => setShowNewDM(false)}
          onStart={(userId) => startConvMutation.mutate(userId)}
        />
      )}

      <style>{`
        .conv-item:hover { background: var(--bg-elevated) !important; border-color: var(--border-subtle) !important; }
        .member-row:hover { background: var(--bg-elevated) !important; }
        .chat-input-box:focus-within { border-color: var(--color-primary-500) !important; box-shadow: 0 0 0 3px hsla(217, 100%, 50%, 0.1); }
        @keyframes typingDot { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
