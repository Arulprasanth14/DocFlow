/**
 * Test harness for the review viewer and comments panel (task P3-15).
 *
 * Not part of the application build — `vite build` only bundles index.html.
 * The app's sign-in is Firebase-based, so an end-to-end test cannot reach
 * the approval screen without a real account. This mounts the same two
 * components the approval screen mounts, wired the same way, so the viewer
 * can be exercised in a real browser with the API mocked.
 */
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import '@/index.css';
import {
  useCreateAnnotation, useVersionAnnotations, useVersionFile,
} from '@/hooks/useAnnotations';
import { useAuthStore } from '@/store/authStore';
import { CommentsPanel } from '@/components/review/CommentsPanel';
import { PdfViewer, type PdfViewerHandle } from '@/components/review/PdfViewer';

const VERSION_ID = 'v-test';
const USER_ID = 'u-approver';

// The hooks are gated on a signed-in user; the harness supplies one.
useAuthStore.setState({
  user: {
    id: USER_ID, email: 'approver@example.com', name: 'Approver',
    avatar_url: null, is_superadmin: false, org_id: 'org', roles: ['worker'],
    permissions: [], status: 'active',
  },
});

function Harness() {
  const fileQ = useVersionFile(VERSION_ID);
  const annotationsQ = useVersionAnnotations(VERSION_ID);
  const createM = useCreateAnnotation(VERSION_ID);
  const viewerRef = useRef<PdfViewerHandle>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const annotations = annotationsQ.data?.annotations ?? [];

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ flex: 2, minWidth: 0 }} data-testid="viewer">
        {fileQ.data?.status === 'ready' && fileQ.data.url && (
          <PdfViewer
            ref={viewerRef}
            fileUrl={fileQ.data.url}
            annotations={annotations}
            activeId={activeId}
            canAnnotate
            onSelectAnnotation={setActiveId}
            onCreateAnchor={async (anchor) => {
              const created = await createM.mutateAsync(anchor);
              setActiveId(created.id);
            }}
          />
        )}
        {fileQ.data && fileQ.data.status !== 'ready' && (
          <p data-testid="file-state">{fileQ.data.status}: {fileQ.data.message}</p>
        )}
      </div>
      <div style={{ flex: 1, padding: 16, overflow: 'auto' }} data-testid="panel">
        <CommentsPanel
          versionId={VERSION_ID}
          annotations={annotations}
          activeId={activeId}
          currentUserId={USER_ID}
          onSelect={(a) => {
            setActiveId(a.id);
            viewerRef.current?.scrollToPage(a.page_number);
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>
  </StrictMode>,
);
