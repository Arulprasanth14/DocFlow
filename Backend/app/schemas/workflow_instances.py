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
        description="'specific_user' | 'role_in_department' | 'manager_of_requester' | 'dynamic_by_amount_threshold'"
    )
    rule_value: dict[str, Any] = Field(default_factory=dict)


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
    reapproval_on_revision: bool = False
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
    approver_rules: list[StageApproverRuleResponse] = []
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Workflow Template ─────────────────────────────────────────────────────────

class WorkflowTemplateCreate(BaseModel):
    name: str = Field(..., max_length=255)
    description: str | None = None
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

    model_config = {"from_attributes": True}


class WorkflowTemplateSummary(BaseModel):
    """Lightweight response — no stages included."""
    id: uuid.UUID
    name: str
    department_id: uuid.UUID | None
    is_active: bool
    version: int
    created_at: datetime

    model_config = {"from_attributes": True}


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


# ── Approval Step ─────────────────────────────────────────────────────────────

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

    model_config = {"from_attributes": True}


class MyApprovalsResponse(BaseModel):
    items: list[ApprovalStepResponse]
    total: int


# ── SSE Event Types ────────────────────────────────────────────────────────────

class WorkflowSSEEvent(BaseModel):
    """Data shape for GET /workflows/{id}/stream SSE events."""
    event: str  # 'status_update' | 'step_decided' | 'escalated' | 'completed'
    instance_id: str
    status: str
    current_stage_id: str | None
    updated_at: str  # ISO datetime
    payload: dict[str, Any] = Field(default_factory=dict)
