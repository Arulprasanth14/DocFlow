/**
 * DocFlow Frontend — API Client: Approvals
 * Typed calls for /approvals endpoints.
 *
 * Updated in Phase 2 (Step 8):
 *  - Use POST /{step_id}/decision for all decisions (approve, reject, changes_requested)
 *  - Removed legacy /approve, /reject, /return routes (which no longer exist)
 *  - getMyQueue now hits GET /approvals (the standard pending list for the caller)
 */

import { apiClient } from './client';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ESignaturePayload {
  signature_method: 'drawn' | 'typed' | 'click_to_sign' | 'provider_docusign';
  signed_hash: string;
  provider_reference?: string;
}

export interface DecisionPayload {
  /** 'approved' | 'rejected' | 'changes_requested' */
  decision: string;
  note?: string;
  /** Required when the stage has requires_signature=true and decision='approved' */
  signature?: ESignaturePayload;
}

export interface DelegatePayload {
  delegate_user_id: string;
  reason?: string;
  ends_at?: string; // ISO datetime
}

export interface ApprovalStep {
  id: string;
  instance_id: string;
  stage_id: string;
  document_version_id: string;
  approver_id: string;
  decision: string;
  decision_note: string | null;
  decided_at: string | null;
  due_at: string | null;
  escalated_at: string | null;
  round_number: number;
  created_at: string;
  stage_name?: string;
  approver_name?: string;
  approver_email?: string;
  // Document context the backend already populates in
  // ApprovalService.list_my_approvals (batch-fetched, not N+1). These were
  // missing from this type, so the queue UI fabricated placeholder titles
  // like "Approval Step 3f2a1b" and showed the APPROVER where the requester
  // belongs.
  document_id?: string | null;
  document_title?: string | null;
  document_public_id?: string | null;
  submitted_by?: string | null;
  submitter_name?: string | null;
  // §6.5/6.6: revocation state, so the queue can show a decision that no
  // longer counts.
  revoked_at?: string | null;
  superseded_at?: string | null;
}

export interface MyApprovalsResponse {
  items: ApprovalStep[];
  total: number;
}

export interface ApprovalFilters {
  page?: number;
  limit?: number;
  status?: string;
  [key: string]: string | number | boolean | undefined;
}

// ── API ────────────────────────────────────────────────────────────────────────

export const approvalsApi = {
  /**
   * GET /approvals — list pending approval steps for the current user.
   * Replaces the old /approvals/my-queue legacy endpoint.
   */
  getMyQueue: (params?: ApprovalFilters) =>
    apiClient.get<MyApprovalsResponse>('/approvals', { params }),

  /**
   * POST /approvals/{step_id}/decision — submit an approval decision.
   * All three outcomes (approve, reject, changes_requested) go through this
   * single endpoint. Replaces the old /approve, /reject, /return routes.
   *
   * If the stage requires_signature=true, include `signature` when decision='approved'.
   * If missing, the backend returns 422 with an actionable error message.
   */
  decide: (stepId: string, payload: DecisionPayload) =>
    apiClient.post<ApprovalStep>(`/approvals/${stepId}/decision`, payload),

  /**
   * POST /approvals/{step_id}/delegate — delegate a step to another user.
   */
  delegate: (stepId: string, payload: DelegatePayload) =>
    apiClient.post<ApprovalStep>(`/approvals/${stepId}/delegate`, payload),

  /**
   * GET /approvals/{step_id} — get details of a specific step.
   */
  getStep: (stepId: string) =>
    apiClient.get<ApprovalStep>(`/approvals/${stepId}`),

  // ── Revocation / recall (§6.5) ──────────────────────────────────────────

  /**
   * POST /approvals/{step_id}/revoke — revoke a decision you recorded.
   * Returns status 'applied' when nothing downstream had happened, or
   * 'requested' when the document already moved on and a controlled recall
   * must be resolved by an administrator.
   */
  revoke: (stepId: string, reason: string) =>
    apiClient.post<RevokeResult>(`/approvals/${stepId}/revoke`, { reason }),

  /** GET /approvals/recalls — recall requests for the org (or one instance). */
  listRecalls: (instanceId?: string) =>
    apiClient.get<RecallRequest[]>('/approvals/recalls', {
      params: { instance_id: instanceId },
    }),

  /** POST /approvals/recalls/{id}/resolve — admin/HR approves or denies. */
  resolveRecall: (revocationId: string, approve: boolean, note?: string) =>
    apiClient.post<RevokeResult>(`/approvals/recalls/${revocationId}/resolve`, {
      approve,
      note,
    }),

  // ── Finalization + history (§6.2 / §6.6) ────────────────────────────────

  /** POST /approvals/instances/{id}/finalize */
  finalize: (instanceId: string) =>
    apiClient.post<FinalizeResult>(`/approvals/instances/${instanceId}/finalize`, {}),

  /** GET /approvals/instances/{id}/history — full chain of custody. */
  getHistory: (instanceId: string) =>
    apiClient.get<ApprovalHistory>(`/approvals/instances/${instanceId}/history`),

  // ── Signatures (§6.4) ───────────────────────────────────────────────────

  /** GET /approvals/{step_id}/signature/verify */
  verifySignature: (stepId: string) =>
    apiClient.get<SignatureVerification>(`/approvals/${stepId}/signature/verify`),

  /** GET /approvals/signing-key — public key for independent verification. */
  getSigningKey: () =>
    apiClient.get<{ algorithm: string; key_id: string; public_key_pem: string }>(
      '/approvals/signing-key',
    ),
};

// ── Types for the above ───────────────────────────────────────────────────────

export interface RevokeResult {
  status: 'applied' | 'requested' | 'approved' | 'denied';
  revocation_id: string;
  instance_status: string;
  affected_step_ids?: string[];
  detail: string;
}

export interface RecallRequest {
  id: string;
  instance_id: string;
  approval_step_id: string;
  requested_by: string;
  reason: string;
  status: 'applied' | 'requested' | 'approved' | 'denied';
  affected_step_ids: string[];
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string | null;
}

export interface FinalizeResult {
  instance_id: string;
  status: string;
  signatures_verified: number;
  finalized_at: string;
}

export interface SignatureVerification {
  step_id: string;
  signed: boolean;
  valid: boolean;
  payload_intact?: boolean;
  signature_valid?: boolean;
  document_intact?: boolean;
  algorithm?: string | null;
  key_id?: string | null;
  signed_at?: string | null;
  signer_id?: string | null;
  decision?: string | null;
  document_version_id?: string | null;
  verified_at?: string;
  reason?: string | null;
}

export interface ApprovalHistoryEntry {
  step_id: string;
  stage_id: string;
  stage_name: string | null;
  stage_order: number | null;
  round_number: number;
  approver_id: string;
  approver_name: string | null;
  approver_email: string | null;
  decision: string;
  decision_note: string | null;
  decided_at: string | null;
  document_version_id: string;
  counts_toward_approval: boolean;
  revoked_at: string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  superseded_at: string | null;
  signature: {
    algorithm: string | null;
    key_id: string | null;
    signed_at: string | null;
    last_verified_at: string | null;
    last_verification_valid: boolean | null;
  } | null;
}

export interface ApprovalHistory {
  instance_id: string;
  document_id: string;
  document_title: string;
  document_status: string;
  instance_status: string;
  current_stage_id: string | null;
  current_stage_name: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  can_finalize: boolean;
  outstanding_steps: { step_id: string; stage_name: string | null; approver_id: string }[];
  history: ApprovalHistoryEntry[];
  recalls: RecallRequest[];
}

export default approvalsApi;
