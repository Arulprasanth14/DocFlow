/**
 * DocFlow Frontend — Auth Hooks (TanStack Query)
 * Mutations for login, registration, and logout using Firebase SDK.
 * Note: Success handlers don't need to manually set auth state. Firebase's
 * onAuthStateChanged will fire and AuthProvider will update the state.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import {
  getMe,
  getSessions,
  revokeSession,
  updateProfile,
  changePassword,
  type MeResponse,
} from '@/lib/api/auth';
import {
  signInWithGoogle,
  signInWithMicrosoft,
  signInWithFirebaseEmail,
  registerWithFirebaseEmail,
  firebaseSignOutUser,
  getFirebaseErrorMessage,
  checkEmailExists,
} from '@/lib/auth/firebase';
import { useAuthStore } from '@/store/authStore';
import { useAuth } from '@/contexts/AuthContext';
import type { OrgMembership } from '@/types';

// ── Query Keys ─────────────────────────────────────────────────────────────────
export const authKeys = {
  me: ['auth', 'me'] as const,
  sessions: ['auth', 'sessions'] as const,
};

// ── Google Sign-In ─────────────────────────────────────────────────────────────
export function useGoogleLogin() {
  return useMutation({
    mutationFn: async () => {
      await signInWithGoogle();
      // onAuthStateChanged handles backend sync and Zustand updates
    },
    onError: (err: Error & { code?: string }) => {
      const code = err.code ?? '';
      throw new Error(getFirebaseErrorMessage(code) || err.message);
    },
  });
}

// ── Microsoft Sign-In ──────────────────────────────────────────────────────────
export function useMicrosoftLogin() {
  return useMutation({
    mutationFn: async () => {
      await signInWithMicrosoft();
    },
    onError: (err: Error & { code?: string }) => {
      const code = err.code ?? '';
      throw new Error(getFirebaseErrorMessage(code) || err.message);
    },
  });
}

// ── Direct Email/Password Login ────────────────────────────────────────────────
export function useFirebaseEmailLogin() {
  return useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      try {
        await signInWithFirebaseEmail(email, password);
      } catch (err: any) {
        const code = err.code ?? '';
        if (code === 'auth/user-not-found') {
          throw Object.assign(new Error('NO_ACCOUNT'), { isNoAccount: true, email });
        }
        if (code === 'auth/invalid-credential') {
          // Verify if it's really wrong password or no account
          const exists = await checkEmailExists(email).catch(() => true); // Assume exists if check fails
          if (!exists) {
            throw Object.assign(new Error('NO_ACCOUNT'), { isNoAccount: true, email });
          }
        }
        throw new Error(getFirebaseErrorMessage(code) || err.message);
      }
    },
  });
}

// ── Register (Firebase Email/Password) ───────────────────────────────────────
export function useRegister() {
  return useMutation({
    mutationFn: async ({
      email,
      password,
      name,
      orgName,
      joinOrgName,
    }: {
      email: string;
      password: string;
      name: string;
      /** Create a brand-new organization and become its admin. */
      orgName?: string;
      /**
       * Request access to an existing organization by name — NOT an instant
       * join. Creates a pending membership an admin must approve. Mutually
       * exclusive with orgName; exactly one (or neither, for a bare account
       * with no org yet) should be set by the caller.
       */
      joinOrgName?: string;
    }) => {
      // 1. Create Firebase user
      const fbUser = await registerWithFirebaseEmail(email, password);

      // 2. Create the account (and organization, if requested) and obtain a
      // DocFlow session — via the shared exchange, which sends the FIREBASE
      // token to /users/me/sync. The previous code posted here with the
      // default auth header (a DocFlow token, or nothing at that moment),
      // which that endpoint cannot verify, and it raced AuthProvider's own
      // exchange that could finish first with "no organization".
      const { syncAndExchange } = await import('@/lib/auth/syncProfile');
      const { tokenStore } = await import('@/lib/api/client');
      const loginData = await syncAndExchange(fbUser, orgName?.trim() || undefined, name);
      tokenStore.set(loginData.access_token);
      useAuthStore
        .getState()
        .setAuth(loginData.user, loginData.access_token, loginData.org_membership);

      // 3. "Request access" path: submit a pending join request now that
      // the account exists. Never auto-joins — an admin must approve it.
      if (joinOrgName) {
        const { orgsApi } = await import('@/lib/api/orgs');
        await orgsApi.requestJoin(joinOrgName);
      }
    },
    onError: (err: Error & { code?: string }) => {
      const code = err.code ?? '';
      throw new Error(getFirebaseErrorMessage(code) || err.message);
    },
  });
}

// ── Logout ─────────────────────────────────────────────────────────────────────
export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: async () => {
      // Sign out of Firebase. AuthProvider clears Zustand and tokenStore.
      await firebaseSignOutUser();

      // Drop locally cached draft content so it can't leak to the next user
      // signing in on this device.
      const { clearAllDraftsLocal } = await import('@/lib/offline/draftCache');
      await clearAllDraftsLocal();

      // Best effort backend logout to clear session row (if we had one)
      const { logout: backendLogout } = await import('@/lib/api/auth');
      await backendLogout().catch(() => {});
    },
    onSuccess: () => {
      queryClient.clear();
      navigate('/login', { replace: true });
    },
    onError: () => {
      queryClient.clear();
      navigate('/login', { replace: true });
    },
  });
}

// ── Logout All Devices ─────────────────────────────────────────────────────────
export function useLogoutAll() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: async () => {
      const { logoutAll: backendLogoutAll } = await import('@/lib/api/auth');
      await backendLogoutAll().catch(() => {});
      await firebaseSignOutUser();
      const { clearAllDraftsLocal } = await import('@/lib/offline/draftCache');
      await clearAllDraftsLocal();
    },
    onSuccess: () => {
      queryClient.clear();
      navigate('/login', { replace: true });
    },
  });
}

// ── Get Current User ───────────────────────────────────────────────────────────
export function useMe() {
  const { isAuthenticated } = useAuth();
  const { setAuth } = useAuthStore();

  return useQuery({
    queryKey: authKeys.me,
    queryFn: async (): Promise<MeResponse> => {
      const data = await getMe();
      setAuth(data.user, '', data.org_membership as OrgMembership | null);
      return data;
    },
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 5,   // 5 minutes
    retry: false,
  });
}

// ── Sessions ───────────────────────────────────────────────────────────────────
export function useSessions() {
  const { isAuthenticated } = useAuth();

  return useQuery({
    queryKey: authKeys.sessions,
    queryFn: getSessions,
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: revokeSession,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.sessions }),
  });
}

// ── Profile Updates ────────────────────────────────────────────────────────────
export function useUpdateProfile() {
  const { updateUser } = useAuthStore();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateProfile,
    onSuccess: (updatedUser) => {
      updateUser(updatedUser);
      queryClient.invalidateQueries({ queryKey: authKeys.me });
    },
  });
}

export function useChangePassword() {
  const navigate = useNavigate();

  return useMutation({
    mutationFn: ({ current, next }: { current: string; next: string }) =>
      changePassword(current, next),
    onSuccess: async () => {
      await firebaseSignOutUser();
      navigate('/login', {
        replace: true,
        state: { message: 'Password changed. Please sign in again.' },
      });
    },
  });
}
