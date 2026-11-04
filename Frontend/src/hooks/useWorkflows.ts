/**
 * DocFlow Frontend — Hooks: Workflows
 * React Query hooks for workflow instances, template listing, and workflow actions.
 *
 * New in Phase 2 (Step 8).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import workflowsApi, {
  type CancelWorkflowPayload,
  type ReviseAndResumePayload,
  type WorkflowTemplateFilters,
} from '@/lib/api/workflows';
import { useAuthStore } from '@/store/authStore';

export const workflowKeys = {
  all: ['workflows'] as const,
  templates: (filters?: WorkflowTemplateFilters) => ['workflows', 'templates', filters] as const,
  instance: (instanceId: string) => ['workflows', 'instance', instanceId] as const,
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
