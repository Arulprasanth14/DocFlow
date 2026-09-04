/**
 * DocFlow Frontend — WebSocket Connection Manager
 * Auto-reconnects, dispatches events to notification store.
 * Auth: JWT passed as ?token= query param (WS headers not supported in browsers).
 */

import { tokenStore } from '@/lib/api/client';
import { useNotificationStore } from '@/store/notificationStore';
import type { WSEvent, Notification } from '@/types';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000/api/v1/ws';

type WSEventHandler = (event: WSEvent) => void;

class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;  // start at 1s, max 30s
  private maxReconnectDelay = 30000;
  private handlers: Map<string, Set<WSEventHandler>> = new Map();
  private isIntentionalClose = false;

  connect(): void {
    const token = tokenStore.get();
    if (!token) {
      console.warn('[WS] No auth token — not connecting');
      return;
    }

    const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectDelay = 1000; // reset backoff
    };

    this.ws.onmessage = (event) => {
      try {
        const data: WSEvent = JSON.parse(event.data);
        this.dispatchEvent(data);
        this.handleBuiltinEvents(data);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    this.ws.onclose = () => {
      if (!this.isIntentionalClose) {
        console.log(`[WS] Disconnected — reconnecting in ${this.reconnectDelay}ms`);
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
    };
  }

  disconnect(): void {
    this.isIntentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  on(eventType: string, handler: WSEventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return () => this.handlers.get(eventType)?.delete(handler);
  }

  private dispatchEvent(event: WSEvent): void {
    const handlers = this.handlers.get(event.type);
    handlers?.forEach((h) => h(event));

    // Also dispatch to wildcard handlers
    const wildcardHandlers = this.handlers.get('*');
    wildcardHandlers?.forEach((h) => h(event));
  }

  private handleBuiltinEvents(event: WSEvent): void {
    // Auto-update notification store on new notification events
    if (event.type === 'notification.new') {
      const notification = event.payload as Notification;
      useNotificationStore.getState().addNotification(notification);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.isIntentionalClose = false;
      this.connect();
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }, this.reconnectDelay);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────
export const wsManager = new WebSocketManager();
