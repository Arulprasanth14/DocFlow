/**
 * DocFlow Frontend — Root App Component
 * Sets up: TanStack Query, AuthProvider, React Router v7, all routes.
 * Milestone 2+: Full auth routing wired up with Firebase-native session.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Suspense, lazy, useEffect } from 'react';

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
import BlankDocPage from '@/pages/documents/BlankDocPage';
import StartFromTemplatePage from '@/pages/documents/StartFromTemplatePage';
import SubmitWizard from '@/pages/documents/SubmitWizard';
import TemplateStudioEntryPage from '@/pages/templates/TemplateStudioEntryPage';
import MyTemplatesPage from '@/pages/templates/MyTemplatesPage';
import DashboardPage from '@/pages/dashboard/DashboardPage';

// FR-6.8 / FR-15.5 — the TipTap editor is the heaviest thing in the app and is
// needed by exactly three routes. Lazy-loading it keeps /documents and
// /documents/new light; <Suspense> below shows the same spinner these pages
// use while the chunk arrives.
// Route-level split for the landing page: it owns the three.js/R3F chunk, which
// must not ship in the initial bundle for authenticated routes (landing §10).
const LandingPage = lazy(() => import('@/pages/landing/LandingPage'));
const DocumentEditorPage = lazy(() => import('@/pages/documents/DocumentEditorPage'));
const FormFillPage = lazy(() => import('@/pages/documents/FormFillPage'));
const TemplateEditorPage = lazy(() => import('@/pages/templates/TemplateEditorPage'));
// Lazy: the import review screen is only reached deliberately, and keeping it
// out of the main bundle matters more than its first-paint speed (FR-6.8).
const ImportTemplatePage = lazy(() => import('@/pages/templates/ImportTemplatePage'));

// ── Approvals Page Imports (Milestone 5) ──────────────────────────────────────
import ApprovalsPage from '@/pages/approvals/ApprovalsPage';
import ApprovalDetailPage from '@/pages/approvals/ApprovalDetailPage';

// ── New Feature Pages ─────────────────────────────────────────────────────────
import WorkflowsPage from '@/pages/workflows/WorkflowsPage';
import WorkflowBuilderPage from '@/pages/workflows/WorkflowBuilderPage';
import WorkflowDetailPage from '@/pages/workflows/WorkflowDetailPage';
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

/** Fallback for the lazily-loaded editor routes — matches their own spinner. */
function LazyRoute({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={
      <div className="page-content" style={{ paddingTop: 48, textAlign: 'center' }}>
        <div className="spinner" style={{ width: 32, height: 32, margin: '0 auto' }} />
      </div>
    }>
      {children}
    </Suspense>
  );
}

// ── Inner App (inside AuthProvider, so it can read auth context) ──────────────
function AppInner() {
  const { isAuthenticated } = useAuth();
  const { theme } = useUIStore();

  useIdleTimeout(isAuthenticated);

  // Apply theme: Ice uses the `.dark` class (shadcn-canonical). We also keep the
  // data-theme attribute in sync for any residual selectors during the migration.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.setAttribute('data-theme', theme);
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
      {/* ── Public Landing Route ─────────────────────────────────── */}
      <Route
        path="/"
        element={
          <Suspense
            fallback={
              <div
                style={{ minHeight: '100svh', background: 'var(--background)' }}
                aria-busy="true"
              />
            }
          >
            <LandingPage />
          </Suspense>
        }
      />

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
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        {/* Dashboard */}
        <Route path="dashboard" element={<DashboardPage />} />

          {/* Profile / Settings */}
          <Route path="profile" element={<ProfilePage />} />

          {/* ── Milestone 3: Administration Routes (Moved to /admin portal) ── */}

          {/* ── Milestone 4: Documents & Forms Routes ───────────────── */}
          <Route path="documents" element={<DocumentListPage />} />
          <Route path="documents/new" element={<DocumentCreatePage />} />
          {/* Deep link: renders the hub with the upload modal open */}
          <Route path="documents/new/upload" element={<DocumentCreatePage />} />
          <Route path="documents/new/blank" element={<BlankDocPage />} />
          <Route path="documents/new/from-template/:templateId" element={<StartFromTemplatePage />} />
          {/* Template Studio (Phase 2) — static segments outrank documents/:id */}
          <Route path="documents/templates/mine" element={<MyTemplatesPage />} />
          <Route path="documents/templates/new" element={<TemplateStudioEntryPage />} />
          <Route path="documents/templates/import" element={<LazyRoute><ImportTemplatePage /></LazyRoute>} />
          <Route path="documents/templates/:id/edit" element={<LazyRoute><TemplateEditorPage /></LazyRoute>} />
          <Route path="documents/:id" element={<DocumentDetailPage />} />
          <Route path="documents/:id/edit" element={<LazyRoute><DocumentEditorPage /></LazyRoute>} />
          <Route path="documents/:id/fill" element={<LazyRoute><FormFillPage /></LazyRoute>} />
          <Route path="documents/:id/submit" element={<SubmitWizard />} />

          {/* Feature routes */}
          {/* Workflow module section 6.3 (AP-DET-01..05): the approver's own
              screen for one stage of one run. Was a catch-all "approvals/*",
              which left no room for a detail route. */}
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="approvals/:stageInstanceId" element={<ApprovalDetailPage />} />
          {/* Workflow module section 5.3: the builder is a full page, not a
              modal - it needs room for ten stage cards plus the preview.
              Declared BEFORE the catch-all so /workflows/new is not swallowed
              by the :id route. */}
          <Route path="workflows" element={<WorkflowsPage />} />
          <Route path="workflows/new" element={<WorkflowBuilderPage />} />
          <Route path="workflows/:id" element={<WorkflowDetailPage />} />
          <Route path="workflows/:id/edit" element={<WorkflowBuilderPage />} />
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
