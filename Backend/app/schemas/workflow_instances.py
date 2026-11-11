"""
DocFlow Backend — Pydantic Schemas: Workflow Templates, Instances, Approval Steps

Covers:
  - WorkflowTemplate admin CRUD
  - WorkflowStage + StageApproverRule
  - WorkflowInstance (submission, status, SSE stream)
  - ApprovalStep decision + delegation
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator


# ── Stage Approver Rule ────────────────────────────────────────────────────────

class StageApproverRuleCreate(BaseModel):
    rule_type: str = Field(
        ...,
        description="'specific_user' | 'role_in_department' | 'manager_of_requester'"
    )
    rule_value: dict[str, Any] = Field(default_factory=dict)

    @field_validator("rule_type")
    @classmethod
    def validate_rule_type(cls, v: str) -> str:
        allowed = {"specific_user", "role_in_department", "manager_of_requester"}
        if v not in allowed:
            if v == "dynamic_by_amount_threshold":
                raise ValueError(
                    "'dynamic_by_amount_threshold' is reserved and not yet implemented. "
                    "Use one of: specific_user, role_in_department, manager_of_requester."
                )
            raise ValueError(f"rule_type must be one of {sorted(allowed)}")
        return v


class StageApproverRuleResponse(BaseModel):
    id: uuid.UUID
    stage_id: uuid.UUID
    rule_type: str
    rule_value: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Workflow Stage ────────────────────────────────────────────────────────────

class WorkflowStageCreate(BaseModel):
    name: str = Field(..., max_length=255)
    sequence_order: int = Field(..., ge=0)
    stage_type: str = Field(default="sequential", description="'sequential' | 'parallel' | 'conditional'")
    min_approvals_required: int = Field(default=1, ge=1)
    sla_hours: int | None = Field(default=None, ge=1)
    # Section 5.5 field D: the builder shows a number plus a unit ("2 days"),
    # while the engine computes in hours. Both are accepted so the UI can
    # round-trip the wording the user chose instead of being handed "48 hours"
    # back. Omit them and they are derived from sla_hours, which keeps every
    # existing caller working unchanged.
    due_within_value: int | None = Field(default=None, ge=1)
    due_within_unit: str | None = Field(default=None, pattern="^(hours|days)$")
    # Section 5.5 field C. Drives the Finance signing rule (WF-STG-20) and is
    # shown in the preview; optional for a submitter-manager stage.
    department_id: uuid.UUID | None = None
    reapproval_on_revision: bool = False
    requires_signature: bool = Field(
        default=False,
        description="If True, the Approve decision on this stage requires a digital e-signature.",
    )
    approver_rules: list[StageApproverRuleCreate] = Field(default_factory=list)


class WorkflowStageResponse(BaseModel):
    id: uuid.UUID
    template_id: uuid.UUID
    name: str
    sequence_order: int
    stage_type: str
    min_approvals_required: int
    sla_hours: int | None
    reapproval_on_revision: bool
    requires_signature: bool
    approver_rules: list[StageApproverRuleResponse] = []
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Workflow Template ─────────────────────────────────────────────────────────

class WorkflowTemplateCreate(BaseModel):
    name: str = Field(..., max_length=255)
    description: str | None = None
    # WF-BLD-07 / BR-06: when ON, a revised document restarts from stage 1
    # instead of returning to the stage that requested the changes. Default
    # OFF - the spec is explicit that this must never happen implicitly.
    require_full_reapproval: bool = False
    department_id: uuid.UUID | None = None
    doc_type_id: uuid.UUID | None = None
    document_type_scope: str | None = Field(None, max_length=100)
    is_active: bool = True
    stages: list[WorkflowStageCreate] = Field(default_factory=list)


class WorkflowTemplateUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    department_id: uuid.UUID | None = None
    document_type_scope: str | None = None
    is_active: bool | None = None
    require_full_reapproval: bool | None = None
    # Declared so the field is no longer silently discarded. Until workflow
    # versioning lands, TemplateService.update() REFUSES a changed stage list
    # with 422 instead of dropping it: `approval_steps.stage_id` and
    # `workflow_instances.current_stage_id` both reference `workflow_stages.id`
    # with no ON DELETE, so replacing stages in place would either violate
    # those foreign keys or orphan the audit trail of runs that already used
    # them. An IDENTICAL list is accepted as a no-op so that editing only the
    # name or description keeps working.
    stages: list[WorkflowStageCreate] | None = None


class WorkflowTemplateResponse(BaseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    description: str | None
    department_id: uuid.UUID | None
    doc_type_id: uuid.UUID | None
    document_type_scope: str | None
    is_active: bool
    version: int
    stages: list[WorkflowStageResponse] = []
    created_at: datetime
    updated_at: datetime | None = None
    # §7 ownership/sharing
    created_by: uuid.UUID | None = None
    visibility: str = "organization"

    model_config = {"from_attributes": True}


class WorkflowTemplateSummary(BaseModel):
    """Lightweight response — no stages included."""
    id: uuid.UUID
    name: str
    description: str | None = None
    department_id: uuid.UUID | None
    doc_type_id: uuid.UUID | None = None
    is_active: bool
    version: int
    created_at: datetime
    # §7 ownership/sharing — lets the UI show "mine" vs shared workflows and
    # decide whether to offer edit controls.
    created_by: uuid.UUID | None = None
    visibility: str = "organization"

    model_config = {"from_attributes": True}


# ── Template Review (non-admin, pre-submit workflow review) ────────────────────
# A deliberately narrower view than WorkflowTemplateResponse: human-readable
# approver descriptions instead of raw rule_type/rule_value, so a normal
# submitter (who lacks admin:users permission and can't call /orgs/me/members
# to resolve a specific_user's name themselves) can still see who will review
# their document, in what order, before submitting.

class TemplateReviewStage(BaseModel):
    name: str
    sequence_order: int
    approver_summary: str
    sla_hours: int | None
    requires_signature: bool


class TemplateReviewResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    stages: list[TemplateReviewStage]


# ── Workflow Instance ─────────────────────────────────────────────────────────

class SubmitDocumentRequest(BaseModel):
    """Request body for POST /documents/{id}/submit"""
    workflow_template_id: uuid.UUID = Field(
        ..., description="Which WorkflowTemplate to use for this submission"
    )
    note: str | None = None


class ReviseAndResumeRequest(BaseModel):
    """Request body for POST /documents/{id}/revise-and-resume"""
    # The new DocumentVersion details; actual file already uploaded via presigned URL
    new_version_id: uuid.UUID = Field(
        ..., description="UUID of the already-uploaded new DocumentVersion"
    )
    note: str | None = Field(None, description="Note explaining what was changed")
    # WF-REV-11 / E16: a revision whose bytes match the version it replaces
    # is almost always the wrong file. The first attempt is refused with 409;
    # sending this flag is the owner saying "yes, I mean it".
    confirm_identical: bool = False
    # WF-REV-10: required when reviewer comments are still open, so a
    # resubmission cannot happen without the owner acknowledging them.
    addressed_confirmed: bool = False


class ApprovalStepSummary(BaseModel):
    id: uuid.UUID
    stage_id: uuid.UUID
    stage_name: str | None = None
    approver_id: uuid.UUID
    approver_name: str | None = None
    decision: str
    decided_at: datetime | None
    due_at: datetime | None
    round_number: int

    model_config = {"from_attributes": True}


class WorkflowInstanceResponse(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    template_id: uuid.UUID | None
    status: str
    current_stage_id: uuid.UUID | None
    submitted_at: datetime
    completed_at: datetime | None
    approval_steps: list[ApprovalStepSummary] = []
    created_at: datetime

    model_config = {"from_attributes": True}


class WorkflowInstanceSummary(BaseModel):
    """Lightweight — for document detail view."""
    id: uuid.UUID
    status: str
    current_stage_id: uuid.UUID | None
    submitted_at: datetime

    model_config = {"from_attributes": True}


class CancelWorkflowRequest(BaseModel):
    reason: str | None = None


class ProgressStage(BaseModel):
    """One step on the owner's progress timeline (WF-REV-01)."""

    position: int
    stage_name: str
    status: str
    approver_name: str | None = None
    due_at: datetime | None = None
    activated_at: datetime | None = None
    completed_at: datetime | None = None
    round_count: int = 1
    signing_required: bool = False
    blocked_reason: str | None = None
    is_current: bool = False


class DocumentProgressResponse(BaseModel):
    """WF-REV-01/02 — where the owner's document is, step by step.

    `locked` and `locked_reason` state BR-15 in words: the file cannot be
    changed while it is under review, and the owner should be told that
    rather than discover it from a refused save.
    """

    document_id: uuid.UUID
    instance_id: uuid.UUID | None = None
    run_status: str | None = None
    workflow_name: str | None = None
    cycle: int = 1
    previous_run_id: uuid.UUID | None = None
    stages: list[ProgressStage] = Field(default_factory=list)
    locked: bool = False
    locked_reason: str | None = None


class VersionFileResponse(BaseModel):
    """AP-VWR-04 — what the review viewer loads.

    `status` is what the client switches on:
      'ready'   — `url` is a short-lived inline URL
      'pending' — a review copy is being prepared; poll
      'failed'  — it could not be prepared; `message` says why, in words the
                  document's owner can act on
    """

    document_version_id: uuid.UUID
    status: str
    url: str | None = None
    mime_type: str | None = None
    filename: str | None = None
    page_count: int | None = None
    # Seconds the URL is good for, so the client can re-request before it
    # lapses instead of discovering the expiry as a broken frame.
    expires_in: int | None = None
    message: str | None = None
    version_num: int | None = None


class StageDecisionSummary(BaseModel):
    """One decision already recorded on this run, for the detail timeline."""

    step_id: uuid.UUID
    position: int | None = None
    stage_name: str | None = None
    approver_id: uuid.UUID
    approver_name: str | None = None
    decision: str
    decided_at: datetime | None = None
    note: str | None = None
    round_number: int = 1
    is_counted: bool = True


class StageInstanceDetailResponse(BaseModel):
    """AP-DET-01..05 — everything the approval screen needs in one call.

    `can_act` is computed on the server from stored state (section 7.3
    CRITICAL: never from anything the client sends), and
    `cannot_act_reason` is populated whenever it is false so the UI can
    explain itself instead of rendering a disabled button with no
    explanation (UX-INT-01).
    """

    id: uuid.UUID
    instance_id: uuid.UUID
    position: int
    total_stages: int
    stage_name: str
    status: str
    cycle: int = 1
    round_count: int = 1

    signing_required: bool = False
    signing_reason: str | None = None

    due_at: datetime | None = None
    urgency: str = "none"
    hours_until_due: float | None = None
    activated_at: datetime | None = None
    timer_paused_at: datetime | None = None
    blocked_reason: str | None = None

    document_id: uuid.UUID | None = None
    document_public_id: str | None = None
    document_title: str | None = None
    document_version_id: uuid.UUID | None = None
    document_version_num: int | None = None
    # AP-RES-03: the version this one replaced, so the approval screen can
    # offer a comparison. Null on a first submission, which is why the
    # comparison tab is conditional rather than always present.
    previous_version_id: uuid.UUID | None = None
    previous_version_num: int | None = None
    submitted_by: uuid.UUID | None = None
    submitter_name: str | None = None
    submitted_at: datetime | None = None

    template_id: uuid.UUID | None = None
    workflow_name: str | None = None
    run_status: str | None = None

    resolved_approver_id: uuid.UUID | None = None
    resolved_approver_name: str | None = None

    # The ApprovalStep a decision is posted to. Null when the caller is not
    # the approver, so a viewer cannot be handed an id to act on.
    my_step_id: uuid.UUID | None = None
    can_act: bool = False
    cannot_act_reason: str | None = None
    # AP-DET-02 — what the approvers before this one decided.
    history: list[StageDecisionSummary] = Field(default_factory=list)


class PreflightStage(BaseModel):
    """One stage, as it would resolve for the caller right now."""

    position: int
    stage_id: uuid.UUID
    name: str
    approver_ids: list[uuid.UUID] = Field(default_factory=list)
    approver_names: list[str] = Field(default_factory=list)
    approver_summary: str = ""
    requires_signature: bool = False
    signing_reason: str | None = None
    sla_hours: int | None = None
    # Populated only when this stage is the problem, so the UI can mark the
    # offending stage rather than show one message for the whole workflow.
    blocker: str | None = None


class PreflightResponse(BaseModel):
    """WF-SUB-02 / WF-SEL-06 — can this person submit through this workflow?

    `can_submit` is the same verdict the submit transaction will reach,
    because both run the identical resolution pass. It can still go stale
    between the two - an approver deactivated in the meantime - which is
    exactly why submit re-runs it rather than trusting this answer.
    """

    template_id: uuid.UUID
    workflow_name: str
    can_submit: bool
    blockers: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    stages: list[PreflightStage] = Field(default_factory=list)


class SubmitAsNewRequest(BaseModel):
    """WF-SUB-06 - start a fresh run after a terminal one.

    `template_id` is optional: the usual case is "try again through the same
    workflow", so leaving it out reuses the previous run's template. Passing
    one lets the owner route a rejected document somewhere else, which is
    often the actual answer to a rejection.
    """

    template_id: uuid.UUID | None = None
    version_id: uuid.UUID | None = None


class ReassignStageRequest(BaseModel):
    """AP-SLA-06 / P2-17 - hand a blocked or stuck stage to another approver.

    The reason is required, not optional. This overrides an approver chain
    the workflow's owner defined, so the audit entry has to say why, and both
    the outgoing and incoming approver are shown it.
    """

    new_approver_id: uuid.UUID
    reason: str = Field(min_length=5, max_length=1000)


# ── Approval Step ─────────────────────────────────────────────────────────────

class RevokeRequest(BaseModel):
    """
    Request body for POST /approvals/{step_id}/revoke (§6.5).

    A reason is REQUIRED — the revocation is preserved as a permanent audit
    event, and "add a correction comment" is part of the specified flow, so
    there is no such thing as an unexplained revocation.
    """
    reason: str = Field(..., min_length=3, max_length=2000)


class ResolveRecallRequest(BaseModel):
    """Request body for POST /approvals/recalls/{revocation_id}/resolve (§6.5)."""
    approve: bool = Field(
        ...,
        description=(
            "True applies the recall (invalidating the recalled decision and "
            "affected downstream approvals, returning the document for "
            "correction); False denies it and the workflow continues."
        ),
    )
    note: str | None = Field(default=None, max_length=2000)


class DecisionRequest(BaseModel):
    """
    Request body for POST /approvals/{step_id}/decision

    decision values:
      'approved'           — approve this step; advance workflow
      'rejected'           — blocking rejection; close workflow
      'changes_requested'  — send back to creator; open chat; stay at this stage
    """
    decision: str = Field(
        ...,
        description="'approved' | 'rejected' | 'changes_requested'"
    )
    note: str | None = None
    # Optional: capture e-signature on approve
    signature: "ESignatureRequest | None" = None

    @field_validator("decision")
    @classmethod
    def validate_decision(cls, v: str) -> str:
        allowed = {"approved", "rejected", "changes_requested", "abstained"}
        if v not in allowed:
            raise ValueError(f"decision must be one of {sorted(allowed)}")
        return v


class ESignatureRequest(BaseModel):
    signature_method: str = Field(..., description="'drawn' | 'typed' | 'click_to_sign' | 'provider_docusign'")
    signed_hash: str = Field(..., description="SHA-256 hash of the signed document")
    provider_reference: str | None = None


class DelegateRequest(BaseModel):
    """Request body for POST /approvals/{step_id}/delegate"""
    delegate_user_id: uuid.UUID
    reason: str | None = None
    ends_at: datetime | None = None


class ApprovalStepResponse(BaseModel):
    id: uuid.UUID
    instance_id: uuid.UUID
    stage_id: uuid.UUID
    document_version_id: uuid.UUID
    approver_id: uuid.UUID
    decision: str
    decision_note: str | None
    decided_at: datetime | None
    due_at: datetime | None
    escalated_at: datetime | None
    round_number: int
    created_at: datetime
    # Resolved relations (populated when loaded with joins)
    stage_name: str | None = None
    approver_name: str | None = None
    approver_email: str | None = None
    # Document context — who/what this step is actually about. Added because
    # the approvals queue UI had nothing to display per row except raw UUIDs
    # (these, like the three above, were declared in this schema but never
    # actually populated by any code path before now).
    document_id: uuid.UUID | None = None
    document_title: str | None = None
    document_public_id: str | None = None
    submitted_by: uuid.UUID | None = None
    submitter_name: str | None = None
    # §6.5 revocation state — a decision that has been revoked or superseded
    # by a newer document version is preserved but no longer counts toward
    # the stage gate, and the UI must be able to show that distinction.
    revoked_at: datetime | None = None
    revocation_reason: str | None = None
    superseded_at: datetime | None = None
    # AP-DSH-06 urgency. Computed on the server from `due_at`, because the
    # client must not decide what counts as late: BR-13 / AP-SLA-07 make the
    # deadline server-owned, and a browser with a wrong clock would otherwise
    # render its own idea of overdue.
    #   'overdue'  — past due_at
    #   'due_soon' — within 24 hours
    #   'normal'   — further out
    #   'none'     — no deadline on this stage
    urgency: str = "none"
    hours_until_due: float | None = None
    # The stage instance this step belongs to, so a dashboard row can link to
    # the approval screen (AP-DET-01) instead of to the OWNER's document
    # page. Resolved per row rather than read from
    # `approval_steps.stage_instance_id`, which is nullable and is not
    # populated for runs created before P2-1.
    stage_instance_id: uuid.UUID | None = None

    model_config = {"from_attributes": True}


class ApprovalQueueSummary(BaseModel):
    """AP-DSH-08 summary strip — the whole pending workload, unfiltered."""

    pending: int = 0
    overdue: int = 0
    due_today: int = 0
    due_this_week: int = 0


class MyApprovalsResponse(BaseModel):
    """AP-DSH-01..08.

    `total`/`page`/`limit`/`pages` describe the filtered set, matching the
    documents list convention. `counts` is per tab so each tab can carry a
    badge without fetching that tab (AP-DSH-02), and `summary` is the
    unfiltered urgency strip.
    """

    items: list[ApprovalStepResponse]
    total: int
    page: int = 1
    limit: int = 25
    pages: int = 1
    counts: dict[str, int] = Field(default_factory=dict)
    summary: ApprovalQueueSummary = Field(default_factory=ApprovalQueueSummary)


# ── SSE Event Types ────────────────────────────────────────────────────────────

class WorkflowSSEEvent(BaseModel):
    """Data shape for GET /workflows/{id}/stream SSE events."""
    event: str  # 'status_update' | 'step_decided' | 'escalated' | 'completed'
    instance_id: str
    status: str
    current_stage_id: str | None
    updated_at: str  # ISO datetime
    payload: dict[str, Any] = Field(default_factory=dict)


# ── Workflow definition versions (DM-01..04) ──────────────────────────────────

class WorkflowVersionStageResponse(BaseModel):
    """One stage of an immutable version, as the builder and preview read it."""
    id: uuid.UUID
    position: int
    name: str
    approver_type: str
    approver_user_id: uuid.UUID | None = None
    department_id: uuid.UUID | None = None
    due_within_value: int
    due_within_unit: str
    due_within_hours: int
    require_signing: bool

    model_config = {"from_attributes": True}


class WorkflowVersionResponse(BaseModel):
    id: uuid.UUID
    template_id: uuid.UUID
    version_number: int
    name: str
    description: str | None = None
    require_full_reapproval: bool
    created_by: uuid.UUID | None = None
    created_at: datetime
    stages: list[WorkflowVersionStageResponse] = []

    model_config = {"from_attributes": True}


class WorkflowVersionSummary(BaseModel):
    """A row in the owner-only version history list (WF-LC-05, DM-04)."""
    id: uuid.UUID
    version_number: int
    name: str
    created_by: uuid.UUID | None = None
    created_at: datetime
    stage_count: int = 0
    is_current: bool = False

    model_config = {"from_attributes": True}


# ── Workflow sharing (§5.1, WF-OWN-*) ─────────────────────────────────────────

class WorkflowShareCreate(BaseModel):
    """Body of POST /workflow-templates/{id}/shares."""
    user_id: uuid.UUID = Field(..., description="The colleague to grant USE to")


class WorkflowShareResponse(BaseModel):
    """A row in the owner's "Shared with" panel (WF-OWN-06)."""
    id: uuid.UUID
    template_id: uuid.UUID
    grantee_user_id: uuid.UUID
    permission: str
    granted_at: datetime
    granted_by: uuid.UUID
    # Resolved for display so the panel does not need a second round trip
    # (and so a grantee's name is shown without needing admin:users).
    grantee_name: str | None = None
    grantee_email: str | None = None
    grantee_department: str | None = None

    model_config = {"from_attributes": True}


class WorkflowShareResult(BaseModel):
    """Share outcome. `created` is False when an active share already existed:
    WF-OWN-07 makes sharing idempotent, so the caller can tell "granted now"
    from "already had it" and skip sending a second chat message."""
    share: WorkflowShareResponse
    created: bool
    chat_message_sent: bool = False
