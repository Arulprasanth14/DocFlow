/**
 * DocFlow Frontend — UI Store (Zustand)
 * Sidebar collapse, modal state, global loading.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface Modal {
  id: string;
  props?: Record<string, unknown>;
}

interface UIState {
  sidebarCollapsed: boolean;
  activeModal: Modal | null;
  globalLoading: boolean;
  theme: 'dark' | 'light';

  // Actions
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  openModal: (id: string, props?: Record<string, unknown>) => void;
  closeModal: () => void;
  setGlobalLoading: (loading: boolean) => void;
  toggleTheme: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      activeModal: null,
      globalLoading: false,
      theme: 'light',

      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      openModal: (id, props) => set({ activeModal: { id, props } }),

      closeModal: () => set({ activeModal: null }),

      setGlobalLoading: (loading) => set({ globalLoading: loading }),

      toggleTheme: () =>
        set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
    }),
    {
      name: 'docflow-ui',
      storage: createJSONStorage(() => localStorage),
      version: 2,
      // Bumping to version 2 forces a migration for any user who had
      // the old 'dark' default persisted — resets them to 'light'.
      migrate: (persistedState) => {
        const state = persistedState as Partial<UIState>;
        return {
          ...state,
          theme: 'light' as const,
        };
      },
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        theme: state.theme,
      }),
    }
  )
);
