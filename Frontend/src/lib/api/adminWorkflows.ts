/**
 * DocFlow Frontend — API Client: Admin Workflow Templates
 * Typed calls for /admin/workflow-templates (create/edit/delete — requires
 * admin:workflow_templates permission). The non-admin read-only template
 * list lives in lib/api/workflows.ts (workflowsApi.getWorkflowTemplates).
 *
 * This client didn't exist at all before — there was no frontend admin UI
 * for creating or editing workflow templates, even though the backend has
 * always fully supported it (POST/GET/PATCH/DELETE /admin/workflow-templates).
 */

import { apiClient } from './client';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ApproverRuleType = 'specific_user' | 'role_in_department' | 'manager_of_requester';

export interface StageApproverRulePayload {
  rule_type: ApproverRuleType;
  /** specific_user: {user_id}. role_in_department: {role_name, dept_id?}. manager_of_requester: {}. */
  rule_value: Record<string, string | undefined>;
}

export interface StageApproverRuleResponse extends StageApproverRulePayload {
  id: string;
  stage_id: string;
  created_at: string;
}

export interface WorkflowStagePayload {
  name: string;
  sequence_order: number;
  stage_type?: 'sequential' | 'parallel' | 'conditional';
  min_approvals_required?: number;
  sla_hours?: number;
  reapproval_on_revision?: boolean;
  requires_signature?: boolean;
  approver_rules: StageApproverRulePayload[];
}

export interface WorkflowStageResponse {
  id: string;
  template_id: string;
  name: string;
  sequence_order: number;
  stage_type: string;
  min_approvals_required: number;
  sla_hours?: number;
  reapproval_on_revision: boolean;
  requires_signature: boolean;
  approver_rules: StageApproverRuleResponse[];
  created_at: string;
}

export interface WorkflowTemplateCreatePayload {
  name: string;
  description?: string;
  department_id?: string;
  doc_type_id?: string;
  is_active?: boolean;
  stages: WorkflowStagePayload[];
}

export interface WorkflowTemplateUpdatePayload {
  name?: string;
  description?: string;
  department_id?: string;
  document_type_scope?: string;
  is_active?: boolean;
}

export interface AdminWorkflowTemplateResponse {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  department_id: string | null;
  doc_type_id: string | null;
  document_type_scope: string | null;
  is_active: boolean;
  version: number;
  stages: WorkflowStageResponse[];
  created_at: string;
  updated_at: string | null;
}

export interface AdminWorkflowTemplateSummary {
  id: string;
  name: string;
  department_id: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
}

// ── API ────────────────────────────────────────────────────────────────────────

export const adminWorkflowsApi = {
  list: (params?: { active_only?: boolean; department_id?: string }) =>
    apiClient.get<AdminWorkflowTemplateSummary[]>('/admin/workflow-templates', { params }),

  get: (templateId: string) =>
    apiClient.get<AdminWorkflowTemplateResponse>(`/admin/workflow-templates/${templateId}`),

  create: (payload: WorkflowTemplateCreatePayload) =>
    apiClient.post<AdminWorkflowTemplateResponse>('/admin/workflow-templates', payload),

  update: (templateId: string, payload: WorkflowTemplateUpdatePayload) =>
    apiClient.patch<AdminWorkflowTemplateResponse>(`/admin/workflow-templates/${templateId}`, payload),

  delete: (templateId: string) =>
    apiClient.delete<void>(`/admin/workflow-templates/${templateId}`),
};

export default adminWorkflowsApi;
