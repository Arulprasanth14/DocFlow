/**
 * DocFlow Frontend — API Client: Workflows
 * Typed calls for workflow instances and the non-admin template listing.
 *
 * New in Phase 2 (Step 8):
 *  - getWorkflowTemplates — GET /workflow-templates (public, non-admin)
 *  - getWorkflowInstance  — GET /workflow-instances/{id}
 *  - cancelWorkflow       — POST /workflow-instances/{id}/cancel
 *  - reviseAndResume      — POST /documents/{id}/revise-and-resume
 *
 * Note: Document submit (POST /documents/{id}/submit) is in documents.ts.
 *       The submit payload now accepts an optional workflow_template_id.
 */

import { apiClient } from './client';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Summary of a workflow template — enough to populate a template picker UI. */
export interface WorkflowTemplateSummary {
  id: string;
  name: string;
  department_id: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
}

export interface WorkflowInstance {
  id: string;
  document_id: string;
  template_id: string | null;
  status: string;
  current_stage_id: string | null;
  submitted_at: string;
  completed_at: string | null;
  approval_steps: ApprovalStepSummary[];
  created_at: string;
}

export interface ApprovalStepSummary {
  id: string;
  stage_id: string;
  stage_name: string | null;
  approver_id: string;
  approver_name: string | null;
  decision: string;
  decided_at: string | null;
  due_at: string | null;
  round_number: number;
}

export interface ReviseAndResumePayload {
  /** UUID of the already-uploaded new DocumentVersion. */
  new_version_id: string;
  /** Note explaining what was changed. */
  note?: string;
}

export interface CancelWorkflowPayload {
  reason?: string;
}

export interface WorkflowTemplateFilters {
  active_only?: boolean;
  department_id?: string;
  doc_type_id?: string;
  /** Case-insensitive name search (§7 "search workflows by name"). */
  search?: string;
  /** Only workflows the caller created. */
  mine_only?: boolean;
  [key: string]: string | number | boolean | undefined;
}

// ── User-owned workflow authoring (§7) ───────────────────────────────────────

export type ApproverRuleType =
  | 'specific_user'
  | 'role_in_department'
  | 'manager_of_requester'
  | 'dynamic_by_amount_threshold';

export interface StageApproverRuleInput {
  rule_type: ApproverRuleType;
  rule_value: Record<string, unknown>;
}

export interface WorkflowStageInput {
  name: string;
  sequence_order: number;
  stage_type?: 'sequential' | 'parallel' | 'conditional';
  min_approvals_required?: number;
  sla_hours?: number | null;
  reapproval_on_revision?: boolean;
  requires_signature?: boolean;
  approver_rules: StageApproverRuleInput[];
}

export interface WorkflowTemplateInput {
  name: string;
  description?: string | null;
  department_id?: string | null;
  doc_type_id?: string | null;
  document_type_scope?: string | null;
  is_active?: boolean;
  stages: WorkflowStageInput[];
}

export interface WorkflowTemplateDetail {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  department_id: string | null;
  doc_type_id: string | null;
  document_type_scope: string | null;
  is_active: boolean;
  version: number;
  created_by: string | null;
  visibility: 'private' | 'organization';
  created_at: string;
  updated_at: string | null;
  stages: {
    id: string;
    name: string;
    sequence_order: number;
    stage_type: string;
    min_approvals_required: number;
    sla_hours: number | null;
    reapproval_on_revision: boolean;
    requires_signature: boolean;
    approver_rules: { id: string; rule_type: string; rule_value: Record<string, unknown> }[];
  }[];
}

export interface TemplateReviewStage {
  name: string;
  sequence_order: number;
  approver_summary: string;
  sla_hours: number | null;
  requires_signature: boolean;
}

export interface TemplateReview {
  id: string;
  name: string;
  description: string | null;
  stages: TemplateReviewStage[];
}

// ── API ────────────────────────────────────────────────────────────────────────

export const workflowsApi = {
  /**
   * GET /workflow-templates — list active workflow templates (non-admin).
   * Returns summary data only. Use this to populate the template picker when
   * submitting a document. No admin permission required.
   */
  getWorkflowTemplates: (filters?: WorkflowTemplateFilters) =>
    apiClient.get<WorkflowTemplateSummary[]>('/workflow-templates', { params: filters }),

  /**
   * GET /workflow-templates/{id}/review — human-readable stage/approver
   * detail for the pre-submit review step. Non-admin (any org member).
   */
  getWorkflowTemplateReview: (templateId: string) =>
    apiClient.get<TemplateReview>(`/workflow-templates/${templateId}/review`),

  /**
   * GET /workflow-instances/{id} — get full instance details with steps.
   */
  getWorkflowInstance: (instanceId: string) =>
    apiClient.get<WorkflowInstance>(`/workflow-instances/${instanceId}`),

  /**
   * POST /workflow-instances/{id}/cancel — cancel a running workflow.
   */
  cancelWorkflow: (instanceId: string, payload?: CancelWorkflowPayload) =>
    apiClient.post<WorkflowInstance>(`/workflow-instances/${instanceId}/cancel`, payload ?? {}),

  /**
   * POST /documents/{id}/revise-and-resume — resume workflow after revision.
   * Called after a creator uploads a new file version in response to 'sent_back'.
   */
  reviseAndResume: (documentId: string, payload: ReviseAndResumePayload) =>
    apiClient.post<WorkflowInstance>(`/documents/${documentId}/revise-and-resume`, payload),

  // ── My workflows (§7 — any role may author their own) ───────────────────

  /**
   * GET /workflow-templates/{id} — full editable definition (stages +
   * approver rules) for a workflow I own, or any workflow for an org admin.
   */
  getWorkflow: (templateId: string) =>
    apiClient.get<WorkflowTemplateDetail>(`/workflow-templates/${templateId}`),

  /**
   * POST /workflow-templates — create my own reusable workflow.
   * Defaults to `private`; pass visibility='organization' to share it.
   * The backend validates the definition before saving (missing approvers,
   * unsatisfiable approval gates, approvers outside the org, trainees as
   * approvers) and returns 409 with an actionable message.
   */
  createWorkflow: (
    payload: WorkflowTemplateInput,
    visibility: 'private' | 'organization' = 'private',
  ) =>
    apiClient.post<WorkflowTemplateDetail>('/workflow-templates', payload, {
      params: { visibility },
    }),

  /** PATCH /workflow-templates/{id} — owner or org admin only. */
  updateWorkflow: (templateId: string, payload: Partial<WorkflowTemplateInput>) =>
    apiClient.patch<WorkflowTemplateDetail>(`/workflow-templates/${templateId}`, payload),

  /** POST /workflow-templates/{id}/duplicate — copy into a new workflow I own. */
  duplicateWorkflow: (templateId: string, newName?: string) =>
    apiClient.post<WorkflowTemplateDetail>(
      `/workflow-templates/${templateId}/duplicate`,
      {},
      { params: { new_name: newName } },
    ),

  /** POST /workflow-templates/{id}/active — enable/disable without editing. */
  setWorkflowActive: (templateId: string, isActive: boolean) =>
    apiClient.post<WorkflowTemplateDetail>(
      `/workflow-templates/${templateId}/active`,
      {},
      { params: { is_active: isActive } },
    ),

  /** DELETE /workflow-templates/{id} — owner or org admin only. */
  deleteWorkflow: (templateId: string) =>
    apiClient.delete<void>(`/workflow-templates/${templateId}`),
};

export default workflowsApi;
