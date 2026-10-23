/**
 * DocFlow Frontend — Global Toast Notification UI
 *
 * Renders slide-in toast alerts from the global toastStore.
 * Uses Framer Motion (already a project dependency) for animations.
 *
 * Features:
 *   - Slide-in from bottom-right
 *   - Shows title + optional body preview
 *   - Clickable → navigates to deep_link (relies on destination page's own
 *     access checks — no bypass path here)
 *   - Dismiss button (X)
 *   - Auto-dismiss after `duration` ms (handled in toastStore)
 *   - Stacks cleanly up to ~4 visible at once; older ones push up
 */

import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useToastStore, type ToastItem } from '@/store/toastStore';

function ToastCard({ toast }: { toast: ToastItem }) {
  const navigate = useNavigate();
  const { dismissToast } = useToastStore();

  const handleClick = () => {
    if (toast.deepLink) {
      navigate(toast.deepLink);
    }
    dismissToast(toast.id);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 60, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 60, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 340, damping: 30 }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '14px 16px',
        borderRadius: '14px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-lg)',
        cursor: toast.deepLink ? 'pointer' : 'default',
        maxWidth: '340px',
        width: '340px',
        backdropFilter: 'blur(12px)',
      }}
      onClick={handleClick}
    >
      {/* Bell icon */}
      <div style={{
        width: 34, height: 34, borderRadius: '10px', flexShrink: 0,
        background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          margin: 0,
          fontSize: '0.875rem',
          fontWeight: 600,
          color: 'var(--text-primary)',
          lineHeight: 1.35,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {toast.title}
        </p>
        {toast.body && (
          <p style={{
            margin: '3px 0 0',
            fontSize: '0.78rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}>
            {toast.body}
          </p>
        )}
      </div>

      {/* Dismiss */}
      <button
        onClick={(e) => { e.stopPropagation(); dismissToast(toast.id); }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-muted)',
          padding: '2px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
        }}
        aria-label="Dismiss notification"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </motion.div>
  );
}

export function ToastContainer() {
  const { toasts } = useToastStore();

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: '10px',
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <div key={toast.id} style={{ pointerEvents: 'auto' }}>
            <ToastCard toast={toast} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
