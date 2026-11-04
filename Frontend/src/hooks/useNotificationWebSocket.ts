/**
 * DocFlow Frontend — Hook: useNotificationWebSocket
 *
 * Step 3: Manages the global per-user WebSocket connection to /ws/notifications.
 *
 * Requirements:
 *   - Connects to /ws/notifications?token=JWT (same auth mechanism as useChatWebSocket)
 *   - On notification.new frame: updates React Query cache instantly + fires toast
 *   - Auto-reconnect with the SAME exponential backoff as useChatWebSocket
 *     (1s→2s→4s→8s→16s→30s cap) — not a divergent second implementation
 *   - REST poll retained as a fallback (60s → reduced to 3min since WS is primary)
 *   - Cleanup on unmount (socket + all timers)
 *   - Multi-tab: each tab creates its own connection; Redis fan-out handles delivery
 *
 * Toast batching:
 *   - If >1 notification arrives within a 1.5s window, groups into "N new updates"
 *   - Toast is suppressed if the notification's deep_link matches the current route
 *     (the user is already looking at the relevant page)
 */

import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { tokenStore } from '@/lib/api/client';
import { notificationKeys } from '@/hooks/useNotifications';

const WS_BASE = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000';

// Same backoff schedule as useChatWebSocket — do NOT diverge
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000];

// Batching window: coalesce rapid-fire notifications within 1.5s
const BATCH_WINDOW_MS = 1500;

export interface NotificationPayload {
  id: string;
  type: string;
  title: string;
  body: string | null;
  deep_link: string | null;
  instance_id: string | null;
  created_at: string | null;
}

export function useNotificationWebSocket(enabled: boolean = true) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffIndexRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  // Toast batching state
  const batchBufferRef = useRef<NotificationPayload[]>([]);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushBatch = useCallback(() => {
    const batch = batchBufferRef.current;
    batchBufferRef.current = [];
    batchTimerRef.current = null;
    if (batch.length === 0) return;

    if (batch.length === 1) {
      const n = batch[0];
      toast(n.title, {
        id: n.id,
        description: n.body ?? undefined,
        ...(n.deep_link
          ? { action: { label: 'View', onClick: () => navigate(n.deep_link!) } }
          : {}),
      });
    } else {
      toast(`${batch.length} new updates`, {
        id: `batch-${Date.now()}`,
      });
    }
  }, [navigate]);

  const handleNotification = useCallback((notif: NotificationPayload) => {
    // 1. Instantly update React Query cache — prepend to list, bump unread count
    queryClient.setQueryData<{ items: NotificationPayload[]; total: number; unread_count: number }>(
      notificationKeys.list(),
      (old) => {
        if (!old) return old;
        return {
          ...old,
          items: [notif, ...old.items],
          total: old.total + 1,
          unread_count: old.unread_count + 1,
        };
      }
    );
    // Also invalidate unread count query to sync any polling consumers
    queryClient.invalidateQueries({ queryKey: notificationKeys.unreadCount() });

    // 2. Toast suppression: if user is already on the destination page, skip toast
    if (notif.deep_link && location.pathname === notif.deep_link) {
      return;
    }

    // 3. Batch-buffer the notification; flush after BATCH_WINDOW_MS
    batchBufferRef.current.push(notif);
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushBatch, BATCH_WINDOW_MS);
    }
  }, [queryClient, location.pathname, flushBatch]);

  const connect = useCallback(() => {
    if (!enabled) return;
    const token = tokenStore.get();
    if (!token) {
      console.warn('[Notifications WS] No auth token — cannot connect');
      return;
    }

    intentionalCloseRef.current = false;

    const url = `${WS_BASE}/ws/notifications?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[Notifications WS] Connected');
      backoffIndexRef.current = 0; // Reset backoff on success
    };

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === 'notification.new' && frame.payload) {
          handleNotification(frame.payload as NotificationPayload);
        }
        // 'pong' frames are silently ignored
      } catch (err) {
        console.error('[Notifications WS] Parse error:', err);
      }
    };

    ws.onclose = (event) => {
      wsRef.current = null;
      if (intentionalCloseRef.current) return;

      // Unexpected close — reconnect with backoff (same as useChatWebSocket)
      const delay = BACKOFF_STEPS[Math.min(backoffIndexRef.current, BACKOFF_STEPS.length - 1)];
      backoffIndexRef.current += 1;
      console.log(`[Notifications WS] Disconnected (code=${event.code}) — reconnecting in ${delay}ms`);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    ws.onerror = (err) => {
      console.error('[Notifications WS] Error:', err);
    };
  }, [enabled, handleNotification]);

  // Mount/unmount: connect and clean up
  useEffect(() => {
    if (!enabled) return;
    connect();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled]); // intentionally only depends on enabled — stable connection for session lifetime
}
