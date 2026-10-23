/**
 * DocFlow Frontend — Auth Context (AuthProvider)
 *
 * This is the single source of truth for authentication state.
 * It replaces the old Zustand-persisted isAuthenticated flag and the
 * manual /auth/refresh call in App.tsx.
 *
 * Lifecycle:
 *   1. On mount: set Firebase persistence (browserLocalPersistence).
 *   2. Subscribe to onAuthStateChanged — this is the ONLY trigger that
 *      updates auth state. Firebase restores the session from IndexedDB
 *      automatically after a page reload.
 *   3. isLoading = true until the first onAuthStateChanged callback fires.
 *      ProtectedRoute renders <AppLoadingScreen /> during this window.
 *   4. When user is non-null: get fresh ID token → exchange it via
 *      POST /auth/firebase-login for a DocFlow access token → tokenStore
 *      → hydrate Zustand profile store from the exchange response.
 *   5. When user is null (sign-out or expiry): clear tokenStore + Zustand.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { type User as FirebaseUser } from 'firebase/auth';

import {
  initFirebasePersistence,
  onFirebaseAuthStateChanged,
} from '@/lib/auth/firebase';
import { tokenStore } from '@/lib/api/client';
import { syncAndExchange } from '@/lib/auth/syncProfile';
import { useAuthStore } from '@/store/authStore';
import type { AuthUser } from '@/types';

// ── Context shape ─────────────────────────────────────────────────────────────

interface AuthContextValue {
  /** Firebase User object (null = not signed in) */
  firebaseUser: FirebaseUser | null;
  /** True until the first onAuthStateChanged callback resolves */
  isLoading: boolean;
  /** Convenience: firebaseUser !== null */
  isAuthenticated: boolean;
  /**
   * Set when the signed-in Firebase user could NOT be exchanged for a DocFlow
   * session (backend down, 5xx, network). The user's organization is UNKNOWN
   * in this state — consumers must show a retry screen, never onboarding.
   */
  exchangeError: string | null;
  /** Re-attempt the exchange for the current Firebase user. */
  retryExchange: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  firebaseUser: null,
  isLoading: true,
  isAuthenticated: false,
  exchangeError: null,
  retryExchange: async () => {},
});


// ── AuthProvider ──────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [exchangeError, setExchangeError] = useState<string | null>(null);

  const { setAuth, clearAuth } = useAuthStore();

  /**
   * Called when Firebase signals a signed-in user.
   *
   * IMPORTANT: the backend's CurrentUser dependency verifies DocFlow-issued
   * JWTs (iss == "docflow"), not raw Firebase ID tokens — so we must
   * exchange the Firebase token for a real DocFlow access token via
   * POST /auth/firebase-login before anything else can call a protected
   * endpoint.
   *
   * We still call /users/me/sync first, using the raw Firebase token
   * explicitly (not tokenStore, which will hold the DocFlow token after the
   * exchange) — that endpoint is what creates a brand-new organisation from
   * org_name during registration (useRegister in hooks/useAuth.ts), and is
   * safe/idempotent to call again here even when org_name isn't provided.
   * /auth/firebase-login then finds the now-existing user and returns the
   * real DocFlow access token + org_membership used to hydrate Zustand.
   *
   * Post-exchange: if the user is an admin role AND the current path is
   * /admin/login, we redirect them to /admin/dashboard automatically.
   */
  const handleUserSignedIn = useCallback(
    async (fbUser: FirebaseUser) => {
      try {
        const loginData = await syncAndExchange(fbUser);
        setExchangeError(null);

        tokenStore.set(loginData.access_token);
        setAuth(loginData.user, loginData.access_token, loginData.org_membership);
        useAuthStore.getState().setAccountState(loginData.state, loginData.pending_request);

        // ── Role-aware redirect (admin only) ───────────────────────────────
        // If the user just logged in via /admin/login and has an admin role,
        // redirect them to the admin dashboard.
        // We do NOT redirect otherwise — employees/interns land on their own
        // returnTo path handled by ProtectedRoute + LoginPage.
        const adminRoles = ['admin', 'hr'];
        const roleName = loginData.org_membership?.role_name ?? '';
        const isAdmin = loginData.user.is_superadmin || adminRoles.includes(roleName);
        const onAdminLogin = window.location.pathname === '/admin/login' || window.location.pathname === '/admin';
        if (isAdmin && onAdminLogin) {
          // Use replace so back button doesn't return to /admin/login
          window.location.replace('/admin/dashboard');
        }
        // ── End role-aware redirect ────────────────────────────────────────

      } catch (err) {
        // The exchange failed. We do NOT know whether this user has an
        // organization, so we must not pretend we do: the previous code
        // installed a profile with orgMembership=null, which the route guard
        // reads as "no organization" and answers with the create-an-org
        // onboarding screen — telling a returning user with a perfectly good
        // workspace to create a new one. Instead: keep whatever profile is
        // already persisted, drop the (useless) token, and surface an error
        // the UI renders as "couldn't reach DocFlow — Retry".
        console.warn('[AuthProvider] /auth/firebase-login exchange failed:', err);
        tokenStore.clear();
        setExchangeError(
          err instanceof Error && err.message
            ? err.message
            : "We couldn't sign you in to DocFlow. Please try again.",
        );
      }
    },
    [setAuth],
  );


  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    const init = async () => {
      // 1. Ensure Firebase uses localStorage persistence before subscribing
      await initFirebasePersistence();

      // 2. Subscribe to auth state changes
      unsubscribe = onFirebaseAuthStateChanged(async (fbUser) => {
        setFirebaseUser(fbUser);

        if (fbUser) {
          await handleUserSignedIn(fbUser);
        } else {
          // Signed out (explicit logout, token revoked, or session expired)
          tokenStore.clear();
          clearAuth();
          setExchangeError(null);
        }

        // First callback has fired — app can now decide to show login or content
        setIsLoading(false);
      });
    };

    init();

    return () => {
      unsubscribe?.();
    };
  }, [handleUserSignedIn, clearAuth]);

  const retryExchange = useCallback(async () => {
    if (!firebaseUser) return;
    setExchangeError(null);
    setIsLoading(true);
    await handleUserSignedIn(firebaseUser);
    setIsLoading(false);
  }, [firebaseUser, handleUserSignedIn]);

  const value: AuthContextValue = {
    firebaseUser,
    isLoading,
    isAuthenticated: firebaseUser !== null,
    exchangeError,
    retryExchange,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ── useAuth hook ──────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
