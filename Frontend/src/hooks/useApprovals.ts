import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import approvalsApi, { type ApprovalFilters } from '@/lib/api/approvals';
import { useAuthStore } from '@/store/authStore';

export const approvalKeys = {
  all: ['approvals'] as const,
  myQueue: () => ['approvals', 'myQueue'] as const,
  list: (params?: ApprovalFilters) => ['approvals', 'list', params] as const,
};

export function useMyApprovalQueue() {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: approvalKeys.myQueue(),
    queryFn: () => approvalsApi.getMyQueue(),
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
  });
}

export function useApprovals(params?: ApprovalFilters) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: approvalKeys.list(params),
    queryFn: () => approvalsApi.listApprovals(params),
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
  });
}

export function useApproveStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, note }: { stepId: string; note?: string }) => approvalsApi.approveStep(stepId, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: approvalKeys.all });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export function useRejectStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, note }: { stepId: string; note: string }) => approvalsApi.rejectStep(stepId, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: approvalKeys.all });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export function useReturnStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, note }: { stepId: string; note: string }) => approvalsApi.returnStep(stepId, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: approvalKeys.all });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export function useDelegateStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, userId, note }: { stepId: string; userId: string; note?: string }) => approvalsApi.delegateStep(stepId, userId, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}
