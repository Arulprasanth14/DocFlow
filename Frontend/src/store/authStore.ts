/**
 * DocFlow Frontend — Auth Store (Zustand)
 * Display-only user profile, org membership, and permissions.
 *
 * IMPORTANT: This store is NO LONGER the source of truth for auth state.
 * `isAuthenticated` and `isLoading` are now owned by AuthContext (Firebase).
 * This store holds the backend profile data that is synced after sign-in.
 *
 * What's persisted: user profile + org membership (display data only).
 * What's NOT persisted: access tokens (always in-memory via tokenStore).
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AuthUser, OrgMembership } from '@/types';
import { tokenStore } from '@/lib/api/client';

interface AuthState {
  user: AuthUser | null;
  orgMembership: OrgMembership | null;

  // Actions
  setAuth: (user: AuthUser, token: string, membership: OrgMembership | null) => void;
  clearAuth: () => void;
  updateUser: (partial: Partial<AuthUser>) => void;
  setOrgMembership: (membership: OrgMembership | null) => void;

  // Permission helpers (read from persisted profile data)
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (...permissions: string[]) => boolean;
  isSuperAdmin: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      orgMembership: null,

      setAuth: (user, token, membership) => {
        if (token) {
          tokenStore.set(token);  // token in memory only, not persisted
        }
        set({
          user,
          orgMembership: membership,
        });
      },

      clearAuth: () => {
        tokenStore.clear();
        set({
          user: null,
          orgMembership: null,
        });
      },

      updateUser: (partial) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...partial } : null,
        })),

      setOrgMembership: (membership) => set({ orgMembership: membership }),

      hasPermission: (permission: string) => {
        const { user } = get();
        if (!user) return false;
        if (user.is_superadmin) return true;
        return (user.permissions ?? []).includes(permission);
      },

      hasAnyPermission: (...permissions: string[]) => {
        const { hasPermission } = get();
        return permissions.some(hasPermission);
      },

      isSuperAdmin: () => get().user?.is_superadmin ?? false,
    }),
    {
      name: 'docflow-auth',
      storage: createJSONStorage(() => localStorage),
      // Only persist display-only profile data — never tokens or auth flags
      partialize: (state) => ({
        user: state.user,
        orgMembership: state.orgMembership,
      }),
    }
  )
);
