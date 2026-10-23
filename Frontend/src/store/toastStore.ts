/**
 * DocFlow Frontend — Toast Store (Zustand)
 *
 * Lightweight global toast queue used by:
 *   - useNotificationWebSocket: fires toasts on notification.new frames
 *
 * Batching (1.5s window) is handled in the hook; this store just manages
 * the visible queue and auto-dismiss timers.
 */
import { create } from 'zustand';

export interface ToastItem {
  id: string;
  title: string;
  body?: string;
  /** If set, clicking the toast navigates here */
  deepLink?: string;
  /** Auto-dismiss after this many ms. Defaults to 5000. */
  duration?: number;
}

interface ToastState {
  toasts: ToastItem[];
  pushToast: (toast: ToastItem) => void;
  dismissToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  pushToast: (toast) => {
    set((state) => ({
      // Deduplicate by id (guard against duplicate batches)
      toasts: state.toasts.some((t) => t.id === toast.id)
        ? state.toasts
        : [...state.toasts, { duration: 5000, ...toast }],
    }));

    // Auto-dismiss after duration
    const duration = toast.duration ?? 5000;
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== toast.id),
      }));
    }, duration);
  },

  dismissToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));
