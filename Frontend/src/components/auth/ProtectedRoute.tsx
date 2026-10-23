/**
 * DocFlow Frontend — Protected Route Component
 * Route guard that reads auth state from AuthContext (Firebase-driven).
 *
 * - Renders <AppLoadingScreen /> while Firebase resolves the initial session.
 * - Redirects to /login (with returnTo) if not authenticated.
 * - Optionally checks Zustand-stored permissions for fine-grained access control.
 */

import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useAuthStore } from '@/store/authStore';
import AppLoadingScreen from '@/components/ui/AppLoadingScreen';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Optional permission string — shows 403 if user lacks it */
  permission?: string;
  /** Require superadmin access */
  requireSuperAdmin?: boolean;
  /** Require the user's org role to be one of the given role names */
  requireRole?: string[];
  /**
   * Skip the "must belong to an organization" redirect. Used only by
   * /onboarding itself, to avoid redirecting an orgless user back to the
   * very page that's trying to fix that.
   */
  allowNoOrg?: boolean;
}

export default function ProtectedRoute({
  children,
  permission,
  requireSuperAdmin,
  requireRole,
  allowNoOrg = false,
}: ProtectedRouteProps) {
  const location = useLocation();
  // Auth state comes from AuthContext (Firebase source of truth)
  const { isLoading, isAuthenticated, exchangeError, retryExchange } = useAuth();
  // Permission data lives in Zustand (display-only, derived from Firebase sync)
  const { hasPermission, isSuperAdmin, hasRole, orgMembership } = useAuthStore();

  // Wait for the first onAuthStateChanged callback — never redirect prematurely
  if (isLoading) {
    return <AppLoadingScreen />;
  }

  // Not authenticated → redirect to login with returnTo
  if (!isAuthenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ returnTo: location.pathname + location.search }}
      />
    );
  }

  // Signed in with Firebase but the DocFlow session could not be established
  // (backend unreachable / 5xx). The user's organization is UNKNOWN, so show a
  // retry screen — NOT onboarding, which would tell an existing member to
  // create a new organization.
  if (exchangeError) {
    return <ExchangeErrorScreen message={exchangeError} onRetry={retryExchange} />;
  }

  // Org gate: every feature (documents, workflows, approvals, chat, admin)
  // is org-scoped. A signed-in user with no organization — e.g. a first-time
  // Google/Microsoft sign-in, which (unlike the email/password RegisterPage)
  // never collects an org name — would otherwise land in a fully
  // authenticated but completely non-functional app: every list empty, every
  // admin page saying "nothing here yet", with no visible way to fix it.
  // Superadmins are exempt — they legitimately manage across orgs.
  if (!allowNoOrg && !orgMembership && !isSuperAdmin()) {
    return <Navigate to="/onboarding" replace />;
  }
  // Inverse: don't let an already-onboarded user land back on /onboarding.
  if (allowNoOrg && orgMembership) {
    return <Navigate to="/dashboard" replace />;
  }

  // Superadmin check
  if (requireSuperAdmin && !isSuperAdmin()) {
    return <ForbiddenPage />;
  }

  // Role check (Admin portal guard)
  if (requireRole && requireRole.length > 0 && !hasRole(...requireRole)) {
    return <ForbiddenPage redirectTo={location.pathname.startsWith('/admin') ? '/login' : '/dashboard'} />;
  }

  // Permission check
  if (permission && !hasPermission(permission)) {
    return <ForbiddenPage />;
  }

  return <>{children}</>;
}

// ── Sign-in could not complete (transient) ─────────────────────────────────────
function ExchangeErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '100vh', gap: '16px',
      textAlign: 'center', padding: '32px',
    }}>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-primary)' }}>
        Couldn't reach DocFlow
      </h2>
      <p style={{ color: 'var(--text-muted)', maxWidth: '420px' }}>
        {message} Your account and workspace are unaffected.
      </p>
      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onRetry(); } finally { setBusy(false); } }}
        >
          {busy ? 'Retrying…' : 'Try again'}
        </button>
        <a href="/login" className="btn btn-secondary">Back to sign in</a>
      </div>
    </div>
  );
}

// ── 403 Forbidden Page ─────────────────────────────────────────────────────────
function ForbiddenPage({ redirectTo = '/dashboard' }: { redirectTo?: string }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      gap: '16px',
      textAlign: 'center',
      padding: '32px',
    }}>
      <div style={{
        width: '64px', height: '64px', borderRadius: '16px',
        background: 'hsla(0, 82%, 55%, 0.1)',
        border: '1px solid hsla(0, 82%, 55%, 0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-error-400)" strokeWidth="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)' }}>
        Access Denied
      </h2>
      <p style={{ color: 'var(--text-muted)', maxWidth: '400px' }}>
        You don't have permission to access this page. Contact your administrator if you believe this is an error.
      </p>
      <a href={redirectTo} className="btn btn-secondary" style={{ marginTop: '8px' }}>
        {redirectTo.startsWith('/admin') ? 'Go to Admin Login' : 'Go to Dashboard'}
      </a>
    </div>
  );
}

