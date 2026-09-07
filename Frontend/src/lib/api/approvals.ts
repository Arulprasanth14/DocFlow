/**
 * DocFlow Frontend — API Client: Approvals
 * Typed calls for /approvals endpoints.
 */

import { apiClient } from './client';
import type { WorkflowStepInstance, PaginatedResponse } from '@/types';

export interface ApprovalFilters {
  page?: number;
  limit?: number;
  status?: string;
  doc_type_id?: string;
  dept_id?: string;
}

export const approvalsApi = {
  getMyQueue: () =>
    apiClient.get<WorkflowStepInstance[]>('/approvals/my-queue'),

  listApprovals: (params?: ApprovalFilters) =>
    apiClient.get<PaginatedResponse<WorkflowStepInstance>>('/approvals', { params }),

  approveStep: (stepId: string, note?: string) =>
    apiClient.post<{ message: string; step: WorkflowStepInstance }>(`/approvals/${stepId}/approve`, { note }),

  rejectStep: (stepId: string, note: string) =>
    apiClient.post<{ message: string; step: WorkflowStepInstance }>(`/approvals/${stepId}/reject`, { note }),

  returnStep: (stepId: string, note: string) =>
    apiClient.post<{ message: string; step: WorkflowStepInstance }>(`/approvals/${stepId}/return`, { note }),

  delegateStep: (stepId: string, userId: string, note?: string) =>
    apiClient.post<{ message: string; step: WorkflowStepInstance }>(`/approvals/${stepId}/delegate`, { user_id: userId, note }),
};

export default approvalsApi;
