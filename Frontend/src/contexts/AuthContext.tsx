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
 *   4. When user is non-null: get fresh ID token → tokenStore → call
 *      /users/me/sync to hydrate Zustand profile store.
 *   5. When user is null (sign-out or expiry): clear tokenStore + Zustand.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { type User as FirebaseUser } from 'firebase/auth';

import {
  getFirebaseAuth,
  initFirebasePersistence,
  onFirebaseAuthStateChanged,
} from '@/lib/auth/firebase';
import { tokenStore } from '@/lib/api/client';
import { useAuthStore } from '@/store/authStore';
import apiClient from '@/lib/api/client';
import type { OrgMembership, AuthUser } from '@/types';

// ── Context shape ─────────────────────────────────────────────────────────────

interface AuthContextValue {
  /** Firebase User object (null = not signed in) */
  firebaseUser: FirebaseUser | null;
  /** True until the first onAuthStateChanged callback resolves */
  isLoading: boolean;
  /** Convenience: firebaseUser !== null */
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue>({
  firebaseUser: null,
  isLoading: true,
  isAuthenticated: false,
});

// ── Sync response type (matches backend SyncUserResponse) ─────────────────────

interface SyncResponse {
  user: AuthUser;
  org_membership: OrgMembership | null;
}

// ── AuthProvider ──────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const { setAuth, clearAuth } = useAuthStore();

  /**
   * Called when Firebase signals a signed-in user.
   * Gets a fresh ID token, sets it in the token cache, then syncs the
   * backend profile into Zustand.
   */
  const handleUserSignedIn = useCallback(
    async (fbUser: FirebaseUser) => {
      try {
        const idToken = await fbUser.getIdToken();
        tokenStore.set(idToken);

        // Sync profile (creates user record if first login, updates if stale)
        const syncData = await apiClient.post<SyncResponse>('/users/me/sync', {
          name: fbUser.displayName ?? undefined,
          avatar_url: fbUser.photoURL ?? undefined,
        });

        setAuth(syncData.user, idToken, syncData.org_membership);
      } catch (err) {
        // If sync fails (e.g. backend unreachable) we still let the user in —
        // the profile data in Zustand may be stale but auth is valid.
        console.warn('[AuthProvider] /users/me/sync failed:', err);
        // Populate from Firebase claims as a fallback
        setAuth(
          {
            id: fbUser.uid,
            email: fbUser.email ?? '',
            name: fbUser.displayName,
            avatar_url: fbUser.photoURL,
            is_superadmin: false,
            status: 'active',
            permissions: [],
            roles: [],
            created_at: new Date().toISOString(),
            last_seen_at: null,
            notification_prefs: {},
          } as unknown as AuthUser,
          tokenStore.get() ?? '',
          null,
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

  const value: AuthContextValue = {
    firebaseUser,
    isLoading,
    isAuthenticated: firebaseUser !== null,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ── useAuth hook ──────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
