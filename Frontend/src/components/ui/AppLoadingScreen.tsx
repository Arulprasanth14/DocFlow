/**
 * DocFlow Frontend — Full-Viewport Loading Screen
 * Used during auth initialization and any full-page loading state.
 *
 * Layout: position:fixed + inset:0 — avoids the flex-child width-collapse
 * bug that caused the old ProtectedRoute spinner to pin to the top-left corner.
 */

import { motion } from 'framer-motion';

interface AppLoadingScreenProps {
  /** Optional message shown below the spinner (e.g. "Session expired...") */
  message?: string;
}

export default function AppLoadingScreen({ message }: AppLoadingScreenProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-base)',
        zIndex: 9999,
      }}
    >
      {/* DocFlow logo */}
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 20,
          boxShadow: '0 8px 32px hsla(217, 100%, 50%, 0.3)',
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      </motion.div>

      {/* Spinner */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.25 }}
      >
        <div className="spinner" style={{ width: 28, height: 28 }} />
      </motion.div>

      {/* Optional message */}
      {message && (
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            marginTop: 20,
            maxWidth: 320,
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          {message}
        </motion.p>
      )}

      {/* DocFlow wordmark */}
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        style={{
          position: 'absolute',
          bottom: 32,
          fontSize: '0.8rem',
          color: 'var(--text-disabled)',
          letterSpacing: '0.05em',
          fontWeight: 600,
        }}
      >
        DOCFLOW
      </motion.span>
    </motion.div>
  );
}
