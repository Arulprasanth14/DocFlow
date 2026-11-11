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
  /** Returned by the API (schemas/workflow_instances.py) but missing here, so
   *  WorkflowsPage's reads of it failed to typecheck. */
  description: string | null;
  department_id: string | null;
  doc_type_id: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  /** Ownership/sharing: lets the UI tell "mine" from shared and decide
   *  whether to offer edit controls. */
  created_by: string | null;
  visibility: 'private' | 'organization';
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
  /** WF-REV-11: resubmit a file identical to the one sent back, knowingly. */
  confirm_identical?: boolean;
  /** WF-REV-10: the owner confirms they have addressed open comments. */
  addressed_confirmed?: boolean;
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
  /** Section 5.5 field C/D: the department the stage belongs to (drives the
   *  Finance signing rule) and the deadline in the unit the user picked. */
  department_id?: string | null;
  due_within_value?: number | null;
  due_within_unit?: 'hours' | 'days' | null;
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
  /** WF-BLD-07: when ON a revised document restarts from stage 1 instead of
   *  returning to the stage that asked for changes. Default OFF. */
  require_full_reapproval?: boolean;
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

// ── Versioning, lifecycle and sharing (Workflow module §4.4, §5.1, §5.7) ─────

/** A stage of an immutable workflow version. */
export interface WorkflowVersionStage {
  id: string;
  position: number;
  name: string;
  approver_type: 'specific_user' | 'submitter_manager';
  approver_user_id: string | null;
  department_id: string | null;
  due_within_value: number;
  due_within_unit: 'hours' | 'days';
  due_within_hours: number;
  require_signing: boolean;
}

/** A row in the owner-only version history (DM-04, WF-LC-05). */
export interface WorkflowVersionSummary {
  id: string;
  version_number: number;
  name: string;
  created_by: string | null;
  created_at: string;
  stage_count: number;
  is_current: boolean;
}

/** A live USE grant, as the owner's "Shared with" panel shows it. */
export interface WorkflowShare {
  id: string;
  template_id: string;
  grantee_user_id: string;
  permission: 'USE';
  granted_at: string;
  granted_by: string;
  grantee_name: string | null;
  grantee_email: string | null;
  grantee_department: string | null;
}

export interface WorkflowShareResult {
  share: WorkflowShare;
  /** False when a live share already existed. WF-OWN-07 makes sharing
   *  idempotent, so the UI can say "already shared" instead of implying a
   *  second notification went out. */
  created: boolean;
  chat_message_sent: boolean;
}

/** WF-LIST-01 tabs. */
export type WorkflowScope = 'all' | 'mine' | 'shared';

export interface PreflightStage {
  position: number;
  stage_id: string;
  name: string;
  approver_ids: string[];
  approver_names: string[];
  approver_summary: string;
  requires_signature: boolean;
  signing_reason: string | null;
  sla_hours: number | null;
  /** Set only on the stage that is the problem, so the UI can mark that
   *  stage rather than print one message for the whole workflow. */
  blocker: string | null;
}

/** WF-SUB-02 / WF-SEL-06 — can THIS person submit through this workflow? */
export interface PreflightResult {
  template_id: string;
  workflow_name: string;
  can_submit: boolean;
  blockers: string[];
  warnings: string[];
  stages: PreflightStage[];
}

export const workflowSharingApi = {
  /**
   * POST /workflow-templates/{id}/preflight — resolve every stage for the
   * caller. Distinct from /review, which describes the workflow in general:
   * this answers who would actually approve and what stops this person
   * submitting at all (E1, E2).
   */
  preflight: (templateId: string) =>
    apiClient.post<PreflightResult>(
      `/workflow-templates/${templateId}/preflight`,
    ),

  /** GET /workflow-templates?scope= — My Workflows / Shared with me. */
  list: (scope: WorkflowScope, filters?: WorkflowTemplateFilters) =>
    apiClient.get<WorkflowTemplateSummary[]>('/workflow-templates', {
      params: { ...(filters ?? {}), scope },
    }),

  /** GET /workflow-templates/{id}/versions — owner only. */
  listVersions: (templateId: string) =>
    apiClient.get<WorkflowVersionSummary[]>(
      `/workflow-templates/${templateId}/versions`,
    ),

  /** GET /workflow-templates/{id}/shares — owner only. */
  listShares: (templateId: string) =>
    apiClient.get<WorkflowShare[]>(`/workflow-templates/${templateId}/shares`),

  /**
   * POST /workflow-templates/{id}/shares — grant USE to one colleague.
   * Idempotent: check `created` in the result before telling the user a
   * message was sent (WF-OWN-07).
   */
  share: (templateId: string, userId: string) =>
    apiClient.post<WorkflowShareResult>(
      `/workflow-templates/${templateId}/shares`,
      { user_id: userId },
    ),

  /** DELETE /workflow-templates/{id}/shares/{userId} — takes effect at once
   *  for the grantee; runs they already started continue (WF-OWN-06). */
  revokeShare: (templateId: string, userId: string) =>
    apiClient.delete<void>(
      `/workflow-templates/${templateId}/shares/${userId}`,
    ),

  /** POST /workflow-templates/{id}/archive — hides it from pickers; in-flight
   *  runs continue (WF-LC-03). The way out when delete is blocked. */
  archive: (templateId: string) =>
    apiClient.post<WorkflowTemplateDetail>(
      `/workflow-templates/${templateId}/archive`,
      {},
    ),

  /** POST /workflow-templates/{id}/restore */
  restore: (templateId: string) =>
    apiClient.post<WorkflowTemplateDetail>(
      `/workflow-templates/${templateId}/restore`,
      {},
    ),
};

export default workflowsApi;
