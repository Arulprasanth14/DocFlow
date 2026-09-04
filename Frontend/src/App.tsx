/**
 * DocFlow Frontend — Root App Component
 * Sets up: TanStack Query, AuthProvider, React Router v7, all routes.
 * Milestone 2+: Full auth routing wired up with Firebase-native session.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';

import { AuthProvider } from '@/contexts/AuthContext';
import { useAuth } from '@/contexts/AuthContext';
import { useAuthStore } from '@/store/authStore';
import { useUIStore } from '@/store/uiStore';
import { wsManager } from '@/lib/ws';
import { useIdleTimeout } from '@/hooks/useIdleTimeout';

// ── Page Imports ──────────────────────────────────────────────────────────────
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import ProfilePage from '@/pages/auth/ProfilePage';

// ── Admin Page Imports (Milestone 3) ──────────────────────────────────────────
import OrganizationSettingsPage from '@/pages/admin/OrganizationSettingsPage';
import DepartmentsPage from '@/pages/admin/DepartmentsPage';
import RolesPage from '@/pages/admin/RolesPage';
import MembersPage from '@/pages/admin/MembersPage';
import DocumentTypesAdminPage from '@/pages/admin/DocumentTypesAdminPage';

// ── Document Page Imports (Milestone 4) ───────────────────────────────────────
import DocumentListPage from '@/pages/documents/DocumentListPage';
import DocumentCreatePage from '@/pages/documents/DocumentCreatePage';
import DocumentDetailPage from '@/pages/documents/DocumentDetailPage';
import DashboardPage from '@/pages/dashboard/DashboardPage';

// ── Approvals Page Imports (Milestone 5) ──────────────────────────────────────
import ApprovalsPage from '@/pages/approvals/ApprovalsPage';

// ── Component Imports ─────────────────────────────────────────────────────────
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import AppLayout from '@/components/layout/AppLayout';

// ── TanStack Query Client ─────────────────────────────────────────────────────
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2,       // 2 minutes
      gcTime: 1000 * 60 * 10,          // 10 minutes cache retention
      retry: 2,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

// ── Coming Soon Placeholder ───────────────────────────────────────────────────
function ComingSoonPage({ title }: { title: string }) {
  return (
    <div className="empty-state" style={{ minHeight: 'calc(100vh - 64px)' }}>
      <div style={{
        width: '64px', height: '64px', borderRadius: '16px',
        background: 'hsla(217, 100%, 50%, 0.08)',
        border: '1px solid hsla(217, 100%, 50%, 0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: '8px',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary-400)" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      </div>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</h2>
      <p style={{ color: 'var(--text-muted)', maxWidth: '400px' }}>
        This feature is coming in a future milestone. Check back soon!
      </p>
    </div>
  );
}

// ── Inner App (inside AuthProvider, so it can read auth context) ──────────────
function AppInner() {
  const { isAuthenticated } = useAuth();
  const { theme } = useUIStore();
  
  useIdleTimeout(isAuthenticated);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Connect WebSocket when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      wsManager.connect();
    } else {
      wsManager.disconnect();
    }
    return () => wsManager.disconnect();
  }, [isAuthenticated]);

  return (
    <Routes>
      {/* ── Public Auth Routes ────────────────────────────────────── */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* ── Protected App Routes (inside AppLayout) ───────────────── */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          {/* Default redirect */}
          <Route index element={<Navigate to="/dashboard" replace />} />

          {/* Dashboard */}
          <Route path="dashboard" element={<DashboardPage />} />

          {/* Profile / Settings */}
          <Route path="profile" element={<ProfilePage />} />

          {/* ── Milestone 3: Administration Routes ──────────────────── */}
          <Route path="admin/organization" element={<OrganizationSettingsPage />} />
          <Route path="admin/departments" element={<DepartmentsPage />} />
          <Route path="admin/roles" element={<RolesPage />} />
          <Route path="admin/members" element={<MembersPage />} />
          <Route path="admin/document-types" element={<DocumentTypesAdminPage />} />

          {/* ── Milestone 4: Documents & Forms Routes ───────────────── */}
          <Route path="documents" element={<DocumentListPage />} />
          <Route path="documents/new" element={<DocumentCreatePage />} />
          <Route path="documents/:id" element={<DocumentDetailPage />} />

          {/* Milestone 5+ routes (coming soon UI) */}
          <Route path="approvals/*" element={<ApprovalsPage />} />
          <Route path="workflows/*" element={<ComingSoonPage title="Workflows" />} />
          <Route path="search" element={<ComingSoonPage title="Search" />} />
          <Route path="analytics/*" element={<ComingSoonPage title="Analytics" />} />
        </Route>

        {/* ── Catch-all ─────────────────────────────────────────────── */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
  );
}

// ── App Root ──────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AppInner />
        </AuthProvider>

        {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
      </QueryClientProvider>
    </BrowserRouter>
  );
}
