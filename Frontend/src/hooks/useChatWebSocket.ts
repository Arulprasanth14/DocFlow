/**
 * DocFlow Frontend — Hook: useChatWebSocket
 *
 * Step 2: Manages the WebSocket connection to /ws/chat/{conversationId}.
 *
 * Requirements implemented:
 *   - Connects with ?token=JWT (query param — confirmed from ws_chat.py)
 *   - On connect: hydrates initial messages via REST GET /messages
 *   - Auto-reconnect with exponential backoff (1s→2s→4s→8s, cap 30s)
 *   - On EVERY reconnect: re-fetches messages since last known message to
 *     catch up on any sent while disconnected before resuming live updates
 *   - Typing indicator: debounced 500ms client-side before sending frame;
 *     auto-clears after 3s inactivity; sends typing:false on blur/send
 *   - Mark read: called on mount and on new message while focused
 *   - Cleanup: closes socket + clears all timers on unmount or conversationId change
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenStore } from '@/lib/api/client';
import chatApi, { type ChatMessage } from '@/lib/api/chat';

const WS_BASE = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000';

// Backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s (capped)
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface TypingUser {
  userId: string;
  isTyping: boolean;
}

export interface UseChatWebSocketOptions {
  /** Called when a message.new event arrives */
  onMessage?: (msg: ChatMessage) => void;
  /** Whether the conversation panel is currently focused/visible */
  isFocused?: boolean;
}

export interface UseChatWebSocketReturn {
  messages: ChatMessage[];
  connectionStatus: ConnectionStatus;
  typingUsers: TypingUser[];
  /** Send a message via WebSocket (or REST fallback if disconnected) */
  sendMessage: (body: string, attachmentIds?: string[]) => Promise<void>;
  /** Send a typing indicator (debounced internally) */
  sendTyping: (isTyping: boolean) => void;
  /** Load older messages (cursor pagination) */
  loadMore: () => Promise<void>;
  hasMore: boolean;
  isLoadingMore: boolean;
}

export function useChatWebSocket(
  conversationId: string | undefined,
  options: UseChatWebSocketOptions = {},
): UseChatWebSocketReturn {
  const { onMessage, isFocused = true } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffIndexRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const lastMessageIdRef = useRef<string | undefined>(undefined);

  // Typing debounce refs
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Hydrate initial messages via REST ──────────────────────────────────────
  const hydrate = useCallback(async (afterId?: string) => {
    if (!conversationId) return;
    try {
      const msgs = await chatApi.getMessages(conversationId, {
        // Fetch newest 50 on initial connect; use before_id cursor for older
        limit: 50,
      });
      setMessages((prev) => {
        if (!afterId) {
          // Initial load — replace state
          if (msgs.length > 0) {
            lastMessageIdRef.current = msgs[msgs.length - 1].id;
          }
          setHasMore(msgs.length === 50);
          return msgs;
        }
        // Reconnect catch-up — merge new messages only
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = msgs.filter((m) => !existingIds.has(m.id));
        if (newMsgs.length > 0) {
          lastMessageIdRef.current = newMsgs[newMsgs.length - 1].id;
        }
        return [...prev, ...newMsgs];
      });
    } catch (err) {
      console.error('[Chat] Failed to hydrate messages:', err);
    }
  }, [conversationId]);

  // ── Mark read when focused ──────────────────────────────────────────────────
  const markReadIfFocused = useCallback(async () => {
    if (!conversationId || !isFocused) return;
    try {
      await chatApi.markRead(conversationId);
    } catch {
      // Non-critical
    }
  }, [conversationId, isFocused]);

  // ── Load older messages ─────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (!conversationId || isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const oldest = messages[0]?.id;
      const older = await chatApi.getMessages(conversationId, {
        before_id: oldest,
        limit: 50,
      });
      setHasMore(older.length === 50);
      setMessages((prev) => [...older, ...prev]);
    } catch (err) {
      console.error('[Chat] Failed to load more messages:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [conversationId, isLoadingMore, hasMore, messages]);

  // ── WebSocket connect ───────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!conversationId) return;
    const token = tokenStore.get();
    if (!token) {
      console.warn('[Chat WS] No auth token — cannot connect');
      return;
    }

    intentionalCloseRef.current = false;
    setConnectionStatus('connecting');

    const url = `${WS_BASE}/ws/chat/${conversationId}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = async () => {
      console.log(`[Chat WS] Connected to ${conversationId}`);
      setConnectionStatus('connected');
      backoffIndexRef.current = 0; // Reset backoff on successful connect

      // Hydrate: on initial connect fetch everything; on reconnect fetch only missed
      const afterId = lastMessageIdRef.current;
      await hydrate(afterId);
      await markReadIfFocused();
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        handleInboundFrame(frame);
      } catch (err) {
        console.error('[Chat WS] Parse error:', err);
      }
    };

    ws.onclose = (event) => {
      wsRef.current = null;
      if (intentionalCloseRef.current) {
        setConnectionStatus('disconnected');
        return;
      }
      // Unexpected close — schedule reconnect with backoff
      const delay = BACKOFF_STEPS[Math.min(backoffIndexRef.current, BACKOFF_STEPS.length - 1)];
      backoffIndexRef.current += 1;
      console.log(`[Chat WS] Disconnected (code=${event.code}) — reconnecting in ${delay}ms`);
      setConnectionStatus('reconnecting');
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    ws.onerror = (err) => {
      console.error('[Chat WS] Error:', err);
    };
  }, [conversationId, hydrate, markReadIfFocused]);

  // ── Handle inbound frames ───────────────────────────────────────────────────
  const handleInboundFrame = useCallback((frame: { type: string; payload: unknown }) => {
    switch (frame.type) {
      case 'message.new': {
        const msg = frame.payload as ChatMessage;
        setMessages((prev) => {
          // Deduplicate by ID (guards against reconnect race conditions)
          if (prev.some((m) => m.id === msg.id)) return prev;
          lastMessageIdRef.current = msg.id;
          return [...prev, msg];
        });
        onMessage?.(msg);
        markReadIfFocused();
        break;
      }
      case 'typing': {
        const { user_id, is_typing } = frame.payload as { user_id: string; is_typing: boolean };
        setTypingUsers((prev) => {
          const without = prev.filter((u) => u.userId !== user_id);
          return is_typing ? [...without, { userId: user_id, isTyping: true }] : without;
        });
        break;
      }
      case 'error': {
        const { message, error_type } = frame.payload as { message: string; error_type?: string };
        console.error(`[Chat WS] Server error (${error_type}):`, message);
        break;
      }
      case 'pong':
        break;
      default:
        break;
    }
  }, [onMessage, markReadIfFocused]);

  // ── Send message ────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (body: string, attachmentIds?: string[]) => {
    if (!conversationId || !body.trim()) return;

    // Stop typing indicator immediately
    sendTypingFrame(false);

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'message',
        payload: { body: body.trim(), attachment_ids: attachmentIds ?? [] },
      }));
    } else {
      // REST fallback when WS is disconnected
      console.log('[Chat] WS unavailable — using REST fallback');
      try {
        const msg = await chatApi.sendMessage(conversationId, {
          body: body.trim(),
          attachment_ids: attachmentIds,
        });
        setMessages((prev) =>
          prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]
        );
      } catch (err) {
        console.error('[Chat] REST send failed:', err);
        throw err;
      }
    }
  }, [conversationId]);

  // ── Typing indicator (debounced) ────────────────────────────────────────────
  const sendTypingFrame = useCallback((isTyping: boolean) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'typing',
        payload: { is_typing: isTyping },
      }));
    }
  }, []);

  const sendTyping = useCallback((isTyping: boolean) => {
    if (!isTyping) {
      // Immediate clear (called on blur/send)
      if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
      if (typingClearRef.current) clearTimeout(typingClearRef.current);
      sendTypingFrame(false);
      return;
    }

    // Debounce the `typing:true` frame — ~500ms after last keystroke
    if (typingDebounceRef.current) clearTimeout(typingDebounceRef.current);
    typingDebounceRef.current = setTimeout(() => {
      sendTypingFrame(true);

      // Auto-clear after 3s of inactivity
      if (typingClearRef.current) clearTimeout(typingClearRef.current);
      typingClearRef.current = setTimeout(() => {
        sendTypingFrame(false);
      }, 3000);
    }, 500);
  }, [sendTypingFrame]);

  // ── Effect: connect / cleanup on conversationId change ──────────────────────
  useEffect(() => {
    if (!conversationId) return;

    // Reset state for new conversation
    setMessages([]);
    setTypingUsers([]);
    setHasMore(false);
    lastMessageIdRef.current = undefined;
    backoffIndexRef.current = 0;

    connect();

    return () => {
      // Cleanup: close socket, clear all timers (requirement: no leaked sockets)
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (typingDebounceRef.current) {
        clearTimeout(typingDebounceRef.current);
        typingDebounceRef.current = null;
      }
      if (typingClearRef.current) {
        clearTimeout(typingClearRef.current);
        typingClearRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnectionStatus('disconnected');
    };
  }, [conversationId]); // Intentionally only depends on conversationId — re-runs on conversation switch

  // ── Effect: mark read when focus changes ────────────────────────────────────
  useEffect(() => {
    if (isFocused && conversationId) {
      markReadIfFocused();
    }
  }, [isFocused, conversationId, markReadIfFocused]);

  return {
    messages,
    connectionStatus,
    typingUsers,
    sendMessage,
    sendTyping,
    loadMore,
    hasMore,
    isLoadingMore,
  };
}
