/**
 * DocFlow Frontend — Hooks: Admin Workflow Templates (TanStack Query)
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import adminWorkflowsApi, {
  type WorkflowTemplateCreatePayload,
  type WorkflowTemplateUpdatePayload,
} from '@/lib/api/adminWorkflows';
import { useAuthStore } from '@/store/authStore';

export const adminWorkflowKeys = {
  all: ['admin', 'workflow-templates'] as const,
  detail: (id: string) => ['admin', 'workflow-templates', id] as const,
};

export function useAdminWorkflowTemplates(params?: { active_only?: boolean }) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: [...adminWorkflowKeys.all, params] as const,
    queryFn: () => adminWorkflowsApi.list(params),
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
  });
}

export function useAdminWorkflowTemplate(templateId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: adminWorkflowKeys.detail(templateId ?? ''),
    queryFn: () => adminWorkflowsApi.get(templateId!),
    enabled: isAuthenticated && !!templateId,
  });
}

export function useCreateWorkflowTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: WorkflowTemplateCreatePayload) => adminWorkflowsApi.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminWorkflowKeys.all });
      queryClient.invalidateQueries({ queryKey: ['workflow-templates'] });
    },
  });
}

export function useUpdateWorkflowTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: WorkflowTemplateUpdatePayload }) =>
      adminWorkflowsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminWorkflowKeys.all });
      queryClient.invalidateQueries({ queryKey: ['workflow-templates'] });
    },
  });
}

export function useDeleteWorkflowTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminWorkflowsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adminWorkflowKeys.all });
      queryClient.invalidateQueries({ queryKey: ['workflow-templates'] });
    },
  });
}
