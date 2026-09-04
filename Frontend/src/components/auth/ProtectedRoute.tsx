/**
 * DocFlow Frontend — Protected Route Component
 * Route guard that reads auth state from AuthContext (Firebase-driven).
 *
 * - Renders <AppLoadingScreen /> while Firebase resolves the initial session.
 * - Redirects to /login (with returnTo) if not authenticated.
 * - Optionally checks Zustand-stored permissions for fine-grained access control.
 */

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
}

export default function ProtectedRoute({
  children,
  permission,
  requireSuperAdmin,
}: ProtectedRouteProps) {
  const location = useLocation();
  // Auth state comes from AuthContext (Firebase source of truth)
  const { isLoading, isAuthenticated } = useAuth();
  // Permission data lives in Zustand (display-only, derived from Firebase sync)
  const { hasPermission, isSuperAdmin } = useAuthStore();

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

  // Superadmin check
  if (requireSuperAdmin && !isSuperAdmin()) {
    return <ForbiddenPage />;
  }

  // Permission check
  if (permission && !hasPermission(permission)) {
    return <ForbiddenPage />;
  }

  return <>{children}</>;
}

// ── 403 Forbidden Page ─────────────────────────────────────────────────────────
function ForbiddenPage() {
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
      <a href="/dashboard" className="btn btn-secondary" style={{ marginTop: '8px' }}>
        Go to Dashboard
      </a>
    </div>
  );
}
