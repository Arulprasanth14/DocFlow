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
import { useUIStore } from '@/store/uiStore';
import { useIdleTimeout } from '@/hooks/useIdleTimeout';

// ── Page Imports ──────────────────────────────────────────────────────────────
import LoginPage from '@/pages/auth/LoginPage';
import RegisterPage from '@/pages/auth/RegisterPage';
import ProfilePage from '@/pages/auth/ProfilePage';
import OnboardingPage from '@/pages/onboarding/OnboardingPage';

// ── Admin Page Imports (Milestone 3) ──────────────────────────────────────────
import OrganizationSettingsPage from '@/pages/admin/OrganizationSettingsPage';
import DepartmentsPage from '@/pages/admin/DepartmentsPage';
import RolesPage from '@/pages/admin/RolesPage';
import MembersPage from '@/pages/admin/MembersPage';
import DocumentTypesAdminPage from '@/pages/admin/DocumentTypesAdminPage';
import WorkflowTemplatesAdminPage from '@/pages/admin/WorkflowTemplatesAdminPage';
// ── Admin Portal Imports (Auth & RBAC Completion) ─────────────────────────────
import AdminLoginPage from '@/pages/admin/AdminLoginPage';
import AdminDashboardPage from '@/pages/admin/AdminDashboardPage';
import AdminLayout from '@/components/layout/AdminLayout';

// ── Document Page Imports (Milestone 4) ───────────────────────────────────────
import DocumentListPage from '@/pages/documents/DocumentListPage';
import DocumentCreatePage from '@/pages/documents/DocumentCreatePage';
import DocumentDetailPage from '@/pages/documents/DocumentDetailPage';
import DashboardPage from '@/pages/dashboard/DashboardPage';

// ── Approvals Page Imports (Milestone 5) ──────────────────────────────────────
import ApprovalsPage from '@/pages/approvals/ApprovalsPage';

// ── New Feature Pages ─────────────────────────────────────────────────────────
import WorkflowsPage from '@/pages/workflows/WorkflowsPage';
import SearchPage from '@/pages/search/SearchPage';
import AnalyticsPage from '@/pages/analytics/AnalyticsPage';
import ChatPage from '@/pages/chat/ChatPage';
import SettingsPage from '@/pages/settings/SettingsPage';
import DraftsPage from '@/pages/drafts/DraftsPage';
import AgentPage from '@/pages/agent/AgentPage';
import AgentKnowledgePage from '@/pages/admin/AgentKnowledgePage';

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

// ── Inner App (inside AuthProvider, so it can read auth context) ──────────────
function AppInner() {
  const { isAuthenticated } = useAuth();
  const { theme } = useUIStore();

  useIdleTimeout(isAuthenticated);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // NOTE: real-time push is handled by the two feature-specific hooks
  // (useChatWebSocket, useNotificationWebSocket), which connect to the
  // actual backend routes (/ws/chat/{id}, /ws/notifications). The generic
  // `wsManager` in lib/ws.ts pointed at a URL matching neither route and
  // was previously wired up here, producing a doomed connect/retry loop on
  // every page load — removed rather than "fixed" since it was redundant
  // with the two working hooks.

  return (
    <Routes>
      {/* ── Public Auth Routes ────────────────────────────────────── */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* ── Onboarding (authenticated, but no org yet) ────────────── */}
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute allowNoOrg>
              <OnboardingPage />
            </ProtectedRoute>
          }
        />

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

          {/* ── Milestone 3: Administration Routes (Moved to /admin portal) ── */}

          {/* ── Milestone 4: Documents & Forms Routes ───────────────── */}
          <Route path="documents" element={<DocumentListPage />} />
          <Route path="documents/new" element={<DocumentCreatePage />} />
          <Route path="documents/:id" element={<DocumentDetailPage />} />

          {/* Feature routes */}
          <Route path="approvals/*" element={<ApprovalsPage />} />
          <Route path="workflows/*" element={<WorkflowsPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="analytics/*" element={<AnalyticsPage />} />
          <Route path="chat" element={<ChatPage />} />
          {/* §11 Drafts and §12 Agent — available to every role (the Agent's
              knowledge ADMINISTRATION is Main-Admin-only, see /admin below). */}
          <Route path="drafts" element={<DraftsPage />} />
          <Route path="agent" element={<AgentPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        {/* ── Catch-all ─────────────────────────────────────────────── */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />

        {/* ── Admin Portal (/admin) ─────────────────────────────────── */}
        {/* Separate login page — not shared with employee login */}
        <Route path="/admin/login" element={<AdminLoginPage />} />
        {/* Protected admin shell — Main Admin + HR (superadmin bypasses via
            hasRole()). HR's day-to-day access per requirements §2.2; pages
            reserved for the Main Administrator only (Roles & Perms, Agent
            legal knowledge) gate themselves further inside the shell. */}
        <Route
          path="/admin"
          element={
            <ProtectedRoute requireRole={['admin', 'hr']}>
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<AdminDashboardPage />} />
          {/* Re-use existing admin section pages under the new Admin shell */}
          <Route path="organization" element={<OrganizationSettingsPage />} />
          <Route path="departments" element={<DepartmentsPage />} />
          {/* Main Administrator only (§13.4) — HR's day-to-day access does
              not extend to roles/permissions management under this baseline. */}
          <Route
            path="roles"
            element={
              <ProtectedRoute requireRole={['admin']}>
                <RolesPage />
              </ProtectedRoute>
            }
          />
          <Route path="members" element={<MembersPage />} />
          <Route path="document-types" element={<DocumentTypesAdminPage />} />
          <Route path="workflow-templates" element={<WorkflowTemplatesAdminPage />} />
          {/* §13.6 Agent legal knowledge — Main Administrator only; HR does
              not receive this privilege by default (§2.5). Enforced again
              server-side in AgentService.assert_can_manage_knowledge. */}
          <Route
            path="agent-knowledge"
            element={
              <ProtectedRoute requireRole={['admin']}>
                <AgentKnowledgePage />
              </ProtectedRoute>
            }
          />
        </Route>
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
