/**
 * DocFlow Frontend — Hooks: Workflows
 * React Query hooks for workflow instances, template listing, and workflow actions.
 *
 * New in Phase 2 (Step 8).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import workflowsApi, {
  workflowSharingApi,
  type CancelWorkflowPayload,
  type ReviseAndResumePayload,
  type WorkflowScope,
  type WorkflowTemplateFilters,
  type WorkflowTemplateInput,
} from '@/lib/api/workflows';
import { useAuthStore } from '@/store/authStore';

export const workflowKeys = {
  all: ['workflows'] as const,
  templates: (filters?: WorkflowTemplateFilters) => ['workflows', 'templates', filters] as const,
  instance: (instanceId: string) => ['workflows', 'instance', instanceId] as const,
  // Workflow module additions
  scoped: (scope: WorkflowScope, filters?: WorkflowTemplateFilters) =>
    ['workflows', 'scoped', scope, filters] as const,
  detail: (templateId: string) => ['workflows', 'detail', templateId] as const,
  versions: (templateId: string) => ['workflows', 'versions', templateId] as const,
  shares: (templateId: string) => ['workflows', 'shares', templateId] as const,
};

/**
 * List workflow templates accessible to the current user.
 * Uses the non-admin GET /workflow-templates endpoint.
 * Useful for populating the template picker on the document submit form.
 */
export function useWorkflowTemplates(filters?: WorkflowTemplateFilters) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: workflowKeys.templates(filters),
    queryFn: () => workflowsApi.getWorkflowTemplates(filters),
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 5, // Templates change infrequently — cache 5 minutes
  });
}

/**
 * Human-readable stage/approver review for a template — used by the
 * pre-submit "review your workflow" step so the submitter can see who
 * will approve the document, in what order, before confirming.
 */
export function useWorkflowTemplateReview(templateId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: ['workflows', 'template-review', templateId ?? ''],
    queryFn: () => workflowsApi.getWorkflowTemplateReview(templateId!),
    enabled: isAuthenticated && !!templateId,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Get full details of a workflow instance (with approval steps).
 */
export function useWorkflowInstance(instanceId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: workflowKeys.instance(instanceId ?? ''),
    queryFn: () => workflowsApi.getWorkflowInstance(instanceId!),
    enabled: isAuthenticated && !!instanceId,
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 30,
  });
}

/**
 * Cancel a running workflow instance.
 */
export function useCancelWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ instanceId, payload }: { instanceId: string; payload?: CancelWorkflowPayload }) =>
      workflowsApi.cancelWorkflow(instanceId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

/**
 * Submit a revised document and resume the workflow at the flagged stage.
 * Called after a creator uploads a new file version in response to 'sent_back'.
 */
export function useReviseAndResume() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ documentId, payload }: { documentId: string; payload: ReviseAndResumePayload }) =>
      workflowsApi.reviseAndResume(documentId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
}

// ── Versioning, lifecycle and sharing (Workflow module §4.4, §5.1, §5.7) ─────

/**
 * Workflows for one WF-LIST-01 tab: 'mine' = My Workflows,
 * 'shared' = Shared with me. Archived workflows are included only when
 * `activeOnly` is false, because "Archived" is a filter within My Workflows
 * rather than a tab of its own.
 */
export function useWorkflowsByScope(
  scope: WorkflowScope,
  opts?: { activeOnly?: boolean; search?: string },
) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  const filters: WorkflowTemplateFilters = {
    active_only: opts?.activeOnly ?? true,
    ...(opts?.search ? { search: opts.search } : {}),
  };
  return useQuery({
    queryKey: workflowKeys.scoped(scope, filters),
    queryFn: () => workflowSharingApi.list(scope, filters),
    enabled: isAuthenticated,
    // Short: a share granted or revoked elsewhere should show up promptly.
    staleTime: 1000 * 30,
  });
}

/**
 * WF-SEL-06 / WF-SUB-02 — preflight for the selected workflow.
 *
 * Runs on selection; the submit transaction runs the same check again,
 * because this answer can go stale between the two (an approver deactivated
 * in the meantime). So this is a warning, never the authority.
 */
export function useWorkflowPreflight(templateId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: ['workflows', 'preflight', templateId] as const,
    queryFn: () => workflowSharingApi.preflight(templateId!),
    enabled: isAuthenticated && !!templateId,
    // Not cached for long: whether a stage resolves depends on who is still
    // active, and that changes outside this page.
    staleTime: 1000 * 20,
    retry: false,
  });
}

/** Owner-only version history (DM-04, WF-LC-05). */
export function useWorkflowVersions(templateId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: workflowKeys.versions(templateId ?? ''),
    queryFn: () => workflowSharingApi.listVersions(templateId!),
    enabled: isAuthenticated && !!templateId,
  });
}

/** Owner-only "Shared with" panel (WF-OWN-06). */
export function useWorkflowShares(templateId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: workflowKeys.shares(templateId ?? ''),
    queryFn: () => workflowSharingApi.listShares(templateId!),
    enabled: isAuthenticated && !!templateId,
  });
}

/**
 * Grant USE to one colleague. The result carries `created`, which is false
 * when a live share already existed — sharing is idempotent (WF-OWN-07), so
 * the caller must not claim a notification went out a second time.
 */
export function useShareWorkflow(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => workflowSharingApi.share(templateId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.shares(templateId) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
    },
  });
}

/** Revoke a share. Takes effect for the grantee at once; runs they already
 *  started continue unaffected (WF-OWN-06, DM-02). */
export function useRevokeWorkflowShare(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      workflowSharingApi.revokeShare(templateId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.shares(templateId) });
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
    },
  });
}

/** Archive or restore (WF-LC-03). Archiving is the way forward when delete
 *  is blocked by in-flight runs (WF-LIST-07). */
export function useSetWorkflowArchived() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, archived }: { templateId: string; archived: boolean }) =>
      archived
        ? workflowSharingApi.archive(templateId)
        : workflowSharingApi.restore(templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
    },
  });
}

/**
 * Create a workflow, or save an edit as a new version (DM-01).
 *
 * One hook for both so the builder has a single submit path: `templateId`
 * absent means create. Success is only ever reported after the server
 * confirms (UX-INT-06, WF-PRV-08).
 */
export function useSaveWorkflow(templateId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      payload,
      visibility,
    }: {
      payload: WorkflowTemplateInput;
      visibility?: 'private' | 'organization';
    }) =>
      templateId
        ? workflowsApi.updateWorkflow(templateId, payload)
        : workflowsApi.createWorkflow(payload, visibility ?? 'private'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workflowKeys.all });
      queryClient.invalidateQueries({ queryKey: ['workflowTemplates'] });
      queryClient.invalidateQueries({ queryKey: ['workflow-templates'] });
      if (templateId) {
        queryClient.invalidateQueries({ queryKey: workflowKeys.versions(templateId) });
      }
    },
  });
}

/** Full editable definition of one workflow (owner, or a grantee reading it). */
export function useWorkflowDetail(templateId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: workflowKeys.detail(templateId ?? ''),
    queryFn: () => workflowsApi.getWorkflow(templateId!),
    enabled: isAuthenticated && !!templateId,
  });
}
