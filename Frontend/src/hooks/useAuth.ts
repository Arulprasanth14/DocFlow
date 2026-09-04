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
    }: {
      email: string;
      password: string;
      name: string;
      orgName?: string;
    }) => {
      // 1. Create Firebase user
      await registerWithFirebaseEmail(email, password);
      
      // 2. We don't await the backend sync here because onAuthStateChanged
      // will fire and do it. However, if they provided an orgName, we might
      // need to ensure it's passed.
      // Wait, AuthContext POSTs to /users/me/sync without org_name for Google.
      // For registration, we should explicitly call it to pass the orgName.
      
      // Actually, since onAuthStateChanged is asynchronous, doing a POST here
      // might race with AuthProvider's POST.
      // Since they just created the account, AuthProvider's POST will act as the creation.
      // Let's import apiClient to do the specific sync call with org_name if needed.
      const apiClient = (await import('@/lib/api/client')).default;
      await apiClient.post('/users/me/sync', { name, org_name: orgName });
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
