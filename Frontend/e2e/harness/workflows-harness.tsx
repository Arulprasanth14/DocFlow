/**
 * Test harness for the workflow module's three pages.
 *
 * Not part of the application build — `vite build` only bundles index.html.
 * Sign-in is Firebase-based, so the real pages cannot be reached in a browser
 * without an account in the project's Firebase. This mounts them inside the
 * REAL AppLayout, with the real design system and the real sidebar, which is
 * what makes it useful for checking alignment: the thing most easily got
 * wrong here is the content column's relationship to the fixed sidebar.
 *
 * The API is stubbed in-page rather than at the Playwright route layer (the
 * way review-harness.tsx does it) so the harness can be opened by URL alone.
 *
 * The harness is served from /e2e/harness/workflows.html, which is not an
 * app route, so it runs a MemoryRouter and takes the route to render from
 * `?route=`:
 *   ?route=/workflows            ?route=/workflows/new
 *   ?route=/workflows/wf-1       ?route=/workflows/wf-1/edit
 */
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@/index.css';
import AppLayout from '@/components/layout/AppLayout';
import WorkflowsPage from '@/pages/workflows/WorkflowsPage';
import WorkflowBuilderPage from '@/pages/workflows/WorkflowBuilderPage';
import WorkflowDetailPage from '@/pages/workflows/WorkflowDetailPage';
import { useAuthStore } from '@/store/authStore';
import { useUIStore } from '@/store/uiStore';
import { tokenStore } from '@/lib/api/client';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Deliberately awkward on purpose: a very long workflow name with no spaces,
// a long description, an archived row, an org-visible row and a shared row.
// Real data is the only way to see what actually overflows.

const ME = '11111111-1111-1111-1111-111111111111';
const PRIYA = '22222222-2222-2222-2222-222222222222';
const DEPT_FIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEPT_OPS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const MINE = [
  {
    id: 'wf-1',
    name: 'Purchase approval over £5,000',
    description:
      'Two-step route for capital expenditure: the requester’s manager, then Finance for the signed authorisation.',
    department_id: DEPT_FIN,
    doc_type_id: null,
    is_active: true,
    version: 3,
    created_at: '2026-10-02T09:00:00Z',
    created_by: ME,
    visibility: 'organization',
  },
  {
    id: 'wf-2',
    name: 'Supplier-onboarding-and-compliance-verification-route',
    description: null,
    department_id: DEPT_OPS,
    doc_type_id: null,
    is_active: true,
    version: 1,
    created_at: '2026-11-01T09:00:00Z',
    created_by: ME,
    visibility: 'private',
  },
  {
    id: 'wf-3',
    name: 'Old expenses route',
    description: 'Replaced by the 2026 policy. Kept for the audit trail.',
    department_id: null,
    doc_type_id: null,
    is_active: false,
    version: 7,
    created_at: '2025-04-11T09:00:00Z',
    created_by: ME,
    visibility: 'private',
  },
];

const SHARED = [
  {
    id: 'wf-9',
    name: 'Legal review (contracts)',
    description: 'Priya’s route. You can use it and duplicate it, not edit it.',
    department_id: null,
    doc_type_id: null,
    is_active: true,
    version: 2,
    created_at: '2026-09-18T09:00:00Z',
    created_by: PRIYA,
    visibility: 'private',
  },
];

const DETAIL: Record<string, unknown> = {
  'wf-1': {
    id: 'wf-1',
    org_id: 'org-1',
    name: 'Purchase approval over £5,000',
    description:
      'Two-step route for capital expenditure: the requester’s manager, then Finance for the signed authorisation.',
    department_id: DEPT_FIN,
    doc_type_id: null,
    document_type_scope: null,
    is_active: true,
    version: 3,
    require_full_reapproval: true,
    created_by: ME,
    visibility: 'organization',
    created_at: '2026-10-02T09:00:00Z',
    updated_at: '2026-11-05T11:30:00Z',
    stages: [
      {
        id: 'st-1',
        name: 'Manager sign-off',
        sequence_order: 1,
        stage_type: 'sequential',
        min_approvals_required: 1,
        sla_hours: 24,
        reapproval_on_revision: false,
        requires_signature: false,
        approver_rules: [
          { id: 'r-1', rule_type: 'manager_of_requester', rule_value: {} },
        ],
        department_id: DEPT_OPS,
        department_name: 'Operations',
        due_within_value: 24,
        due_within_unit: 'hours',
        approver_user_id: null,
        approver_name: null,
      },
      {
        id: 'st-2',
        name: 'Finance authorisation',
        sequence_order: 2,
        stage_type: 'sequential',
        min_approvals_required: 1,
        sla_hours: 72,
        reapproval_on_revision: false,
        requires_signature: true,
        approver_rules: [
          {
            id: 'r-2',
            rule_type: 'specific_user',
            rule_value: { user_id: PRIYA },
          },
        ],
        department_id: DEPT_FIN,
        department_name: 'Finance',
        due_within_value: 3,
        due_within_unit: 'days',
        approver_user_id: PRIYA,
        approver_name: 'Priya Raman',
      },
    ],
  },
};

const VERSIONS = [
  {
    id: 'v-1',
    version_number: 1,
    name: 'Purchase approval over £5,000',
    created_by: ME,
    created_at: '2026-10-02T09:00:00Z',
    stage_count: 1,
    is_current: false,
  },
  {
    id: 'v-2',
    version_number: 2,
    name: 'Purchase approval over £5,000',
    created_by: ME,
    created_at: '2026-10-20T09:00:00Z',
    stage_count: 2,
    is_current: false,
  },
  {
    id: 'v-3',
    version_number: 3,
    name: 'Purchase approval over £5,000',
    created_by: ME,
    created_at: '2026-11-05T11:30:00Z',
    stage_count: 2,
    is_current: true,
  },
];

const MEMBERS = {
  items: [
    {
      user_id: PRIYA,
      status: 'active',
      role: { name: 'worker' },
      user: { name: 'Priya Raman', email: 'priya@example.com' },
    },
    {
      user_id: '33333333-3333-3333-3333-333333333333',
      status: 'active',
      role: { name: 'admin' },
      user: { name: 'Tomasz Włodarczyk', email: 'tomasz@example.com' },
    },
    {
      user_id: '44444444-4444-4444-4444-444444444444',
      status: 'active',
      role: { name: 'hr' },
      user: { name: 'Ama Boateng', email: 'ama@example.com' },
    },
  ],
  total: 3,
  page: 1,
  page_size: 100,
};

const DEPARTMENTS = [
  { id: DEPT_FIN, name: 'Finance', code: 'fin', requires_signature: true },
  { id: DEPT_OPS, name: 'Operations', code: 'ops', requires_signature: false },
];

const SHARES = [
  {
    id: 'sh-1',
    template_id: 'wf-1',
    grantee_user_id: PRIYA,
    permission: 'USE',
    granted_at: '2026-10-22T08:00:00Z',
    granted_by: ME,
    grantee_name: 'Priya Raman',
    grantee_email: 'priya@example.com',
    grantee_department: 'Finance',
  },
];

// ── API stub ────────────────────────────────────────────────────────────────

function body(pathname: string, search: URLSearchParams): unknown {
  const p = pathname.replace(/^\/api\/v1/, '');

  if (p === '/workflow-templates') {
    const scope = search.get('scope');
    const activeOnly = search.get('active_only') !== 'false';
    if (scope === 'shared') return SHARED;
    return activeOnly ? MINE.filter((w) => w.is_active) : MINE;
  }

  const detail = /^\/workflow-templates\/([^/]+)$/.exec(p);
  if (detail) return DETAIL[detail[1]] ?? DETAIL['wf-1'];

  if (/\/versions$/.test(p)) return VERSIONS;
  if (/\/shares$/.test(p)) return SHARES;

  if (p === '/orgs/me/members') return MEMBERS;
  if (p === '/orgs/me/departments') return DEPARTMENTS;

  // App shell.
  if (p === '/notifications/unread-count') return { count: 2 };
  if (p === '/notifications') {
    return {
      items: [
        {
          id: 'n-1',
          title: 'Priya approved “Q4 capex request”',
          body: 'Finance authorisation complete.',
          read_at: null,
          created_at: '2026-11-12T08:40:00Z',
        },
      ],
      total: 1,
      page: 1,
      page_size: 5,
    };
  }
  if (p === '/approvals') return { items: [], total: 3 };
  if (p === '/chat/conversations') return { items: [], total: 0 };
  if (p === '/orgs/me') {
    return { organization: { id: 'org-1', name: 'SD Innovations' } };
  }

  return {};
}

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, window.location.origin);
  if (!url.pathname.startsWith('/api/')) return realFetch(input as RequestInfo, init);

  const method = (init?.method ?? 'GET').toUpperCase();
  // Writes succeed and echo something plausible, so Save / Share / Archive can
  // be exercised without a backend.
  const payload =
    method === 'GET' ? body(url.pathname, url.searchParams) : DETAIL['wf-1'];

  return new Response(JSON.stringify(payload), {
    status: method === 'DELETE' ? 204 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof window.fetch;

// The shell opens a notifications socket; there is nothing to connect to here.
class DeadSocket {
  onopen: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  readyState = 3;
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
}
(window as unknown as { WebSocket: unknown }).WebSocket = DeadSocket;

// ── Session ─────────────────────────────────────────────────────────────────

tokenStore.set('harness-token');
useAuthStore.setState({
  user: {
    id: ME,
    email: 'manager@example.com',
    name: 'Arun Mehta',
    avatar_url: null,
    is_superadmin: false,
    org_id: 'org-1',
    roles: ['worker'],
    permissions: [],
    status: 'active',
  },
  orgMembership: {
    organization: { id: 'org-1', name: 'SD Innovations' },
  } as never,
});

function Harness() {
  const theme = useUIStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route path="workflows" element={<WorkflowsPage />} />
        <Route path="workflows/new" element={<WorkflowBuilderPage />} />
        <Route path="workflows/:id" element={<WorkflowDetailPage />} />
        <Route path="workflows/:id/edit" element={<WorkflowBuilderPage />} />
      </Route>
    </Routes>
  );
}

const route = new URLSearchParams(window.location.search).get('route') || '/workflows';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter initialEntries={[route]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Harness />
      </QueryClientProvider>
    </MemoryRouter>
  </StrictMode>,
);
