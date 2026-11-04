/**
 * DocFlow Frontend — Hooks: Approvals
 * React Query hooks for approval queue and decision actions.
 *
 * Updated in Phase 2 (Step 8):
 * - useMyApprovalQueue uses the correct GET /approvals endpoint
 * - useDecide replaces three separate approve/reject/return hooks — all decisions
 *   go through POST /approvals/{step_id}/decision
 * - Handles the 422 "signature required" error from requires_signature stages
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import approvalsApi, { type ApprovalFilters, type DecisionPayload, type DelegatePayload } from '@/lib/api/approvals';
import chatApi from '@/lib/api/chat';
import { useAuthStore } from '@/store/authStore';

/**
 * Lightweight org member list for the delegate picker — uses GET /chat/members
 * (no admin:users gate) rather than GET /orgs/me/members, since any approver
 * needs to be able to pick a delegate, not just org admins.
 */
export function useMessageableMembers(search?: string) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: ['chat', 'members', search] as const,
    queryFn: () => chatApi.listMembers(search),
    enabled: isAuthenticated,
    staleTime: 1000 * 60,
  });
}

export const approvalKeys = {
  all: ['approvals'] as const,
  myQueue: (params?: ApprovalFilters) => ['approvals', 'queue', params] as const,
  step: (stepId: string) => ['approvals', 'step', stepId] as const,
};

/**
 * List pending approval steps assigned to the current user.
 * Polling interval: 30 seconds.
 */
export function useMyApprovalQueue(params?: ApprovalFilters) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: approvalKeys.myQueue(params),
    queryFn: () => approvalsApi.getMyQueue(params),
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 30,
  });
}

export function useApprovalStep(stepId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: approvalKeys.step(stepId ?? ''),
    queryFn: () => approvalsApi.getStep(stepId!),
    enabled: isAuthenticated && !!stepId,
    staleTime: 1000 * 60,
  });
}

/**
 * Submit an approval decision (approved | rejected | changes_requested).
 *
 * Error handling: if the backend returns 422 with "signature required",
 * the error message is surfaced via the mutation's error state so the
 * consuming component can display an inline signature form.
 */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, payload }: { stepId: string; payload: DecisionPayload }) =>
      approvalsApi.decide(stepId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: approvalKeys.all });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}

export function useDelegateStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, payload }: { stepId: string; payload: DelegatePayload }) =>
      approvalsApi.delegate(stepId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: approvalKeys.all });
    },
  });
}

// ── Legacy compatibility aliases (remove after consuming components are updated) ──

/** @deprecated Use useDecide({ decision: 'approved', ... }) instead */
export function useApproveStep() {
  const decide = useDecide();
  return {
    ...decide,
    mutate: ({ stepId, note, signature }: { stepId: string; note?: string; signature?: DecisionPayload['signature'] }) =>
      decide.mutate({ stepId, payload: { decision: 'approved', note, signature } }),
    mutateAsync: ({ stepId, note, signature }: { stepId: string; note?: string; signature?: DecisionPayload['signature'] }) =>
      decide.mutateAsync({ stepId, payload: { decision: 'approved', note, signature } }),
  };
}

/** @deprecated Use useDecide({ decision: 'rejected', ... }) instead */
export function useRejectStep() {
  const decide = useDecide();
  return {
    ...decide,
    // note is optional on the backend (schemas/workflow_instances.py: `note: str | None = None`)
    mutate: ({ stepId, note }: { stepId: string; note?: string }) =>
      decide.mutate({ stepId, payload: { decision: 'rejected', note } }),
    mutateAsync: ({ stepId, note }: { stepId: string; note?: string }) =>
      decide.mutateAsync({ stepId, payload: { decision: 'rejected', note } }),
  };
}

/** @deprecated Use useDecide({ decision: 'changes_requested', ... }) instead */
export function useReturnStep() {
  const decide = useDecide();
  return {
    ...decide,
    mutate: ({ stepId, note }: { stepId: string; note?: string }) =>
      decide.mutate({ stepId, payload: { decision: 'changes_requested', note } }),
    mutateAsync: ({ stepId, note }: { stepId: string; note?: string }) =>
      decide.mutateAsync({ stepId, payload: { decision: 'changes_requested', note } }),
  };
}
