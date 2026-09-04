"""
DocFlow — Workflow ORM Models (Architecture-aligned)

Implements the full workflow domain as specified in DocFlow-System-Architecture.md §4:
  WorkflowTemplate → WorkflowStage[] → StageApproverRule[] / WorkflowStageCondition[]
  WorkflowInstance → ApprovalStep[] (one per approver per round)
  Delegation, ESignature

IMPORTANT — Multi-round approval model:
  Each time an approver acts on a stage, a NEW ApprovalStep row is created.
  This means a stage can have MULTIPLE ApprovalStep rows across revision rounds.
  The stage pointer (WorkflowInstance.current_stage_id) is NEVER reset on
  changes_requested — only a new ApprovalStep is added at the same stage.

Legacy tables (WorkflowStepInstance, ApprovalDecisionRecord) are preserved
so existing data and references are not broken during migration.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import BaseModel, utcnow


# ── 1. Workflow Template Layer ─────────────────────────────────────────────────

class WorkflowTemplate(BaseModel):
    """
    Reusable, admin-authored workflow definition belonging to a department.
    A template defines the ordered stages and their approver resolution rules.
    """
    __tablename__ = "workflow_templates"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True, index=True,
    )
    # Optional scope — limit this template to a specific document type
    doc_type_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("document_types.id"), nullable=True,
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    # document_type_scope: free-text category filter (e.g. 'contract', 'purchase_order')
    document_type_scope: Mapped[str | None] = mapped_column(String(100))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # Relationships
    stages: Mapped[list["WorkflowStage"]] = relationship(
        "WorkflowStage", back_populates="template",
        lazy="noload", cascade="all, delete-orphan",
        order_by="WorkflowStage.sequence_order",
    )
    instances: Mapped[list["WorkflowInstance"]] = relationship(
        "WorkflowInstance", back_populates="template", lazy="noload",
    )
    doc_type: Mapped["DocumentType"] = relationship(  # type: ignore[name-defined]
        "DocumentType", back_populates="workflow_templates", lazy="noload",
    )


class WorkflowStage(BaseModel):
    """
    One sequential, parallel, or conditional stage within a WorkflowTemplate.
    sequence_order determines processing order; lower = earlier.
    """
    __tablename__ = "workflow_stages"

    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_templates.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    sequence_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # stage_type: 'sequential' | 'parallel' | 'conditional'
    stage_type: Mapped[str] = mapped_column(String(50), default="sequential", nullable=False)
    min_approvals_required: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    sla_hours: Mapped[int | None] = mapped_column(Integer)
    # When True, this stage must re-approve if a later stage requests changes
    reapproval_on_revision: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Relationships
    template: Mapped["WorkflowTemplate"] = relationship(
        "WorkflowTemplate", back_populates="stages", lazy="noload",
    )
    approver_rules: Mapped[list["StageApproverRule"]] = relationship(
        "StageApproverRule", back_populates="stage",
        lazy="noload", cascade="all, delete-orphan",
    )
    conditions: Mapped[list["WorkflowStageCondition"]] = relationship(
        "WorkflowStageCondition", back_populates="stage",
        lazy="noload", cascade="all, delete-orphan",
    )
    approval_steps: Mapped[list["ApprovalStep"]] = relationship(
        "ApprovalStep", back_populates="stage", lazy="noload",
    )

    __table_args__ = (
        UniqueConstraint("template_id", "sequence_order", name="uq_stage_template_order"),
    )


class StageApproverRule(BaseModel):
    """
    Data-driven approver resolution rule for a stage.
    Evaluated at runtime to resolve who must approve this stage.

    rule_type values (from architecture §4):
      'specific_user'               — rule_value: {"user_id": "uuid"}
      'role_in_department'          — rule_value: {"role_name": "manager", "dept_id": "uuid"}
      'manager_of_requester'        — rule_value: {} (resolved dynamically)
      'dynamic_by_amount_threshold' — rule_value: {"field": "amount", "threshold": 10000, "user_id": "uuid"}
    """
    __tablename__ = "stage_approver_rules"

    stage_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_stages.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    rule_type: Mapped[str] = mapped_column(String(100), nullable=False)
    rule_value: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict, server_default="{}")

    stage: Mapped["WorkflowStage"] = relationship(
        "WorkflowStage", back_populates="approver_rules", lazy="noload",
    )

    __table_args__ = (
        Index("idx_stage_approver_rule_value_gin", "rule_value", postgresql_using="gin"),
    )


class WorkflowStageCondition(BaseModel):
    """
    Branching condition on a stage — e.g., skip legal review unless doc.category == 'contract'.
    If any condition evaluates to False, the stage is skipped during instance execution.
    """
    __tablename__ = "workflow_stage_conditions"

    stage_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_stages.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # Condition expression: {"field": "document.category", "op": "==", "value": "contract"}
    condition: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # When False, the stage is skipped (default); when True, skip if condition passes
    skip_if_false: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)

    stage: Mapped["WorkflowStage"] = relationship(
        "WorkflowStage", back_populates="conditions", lazy="noload",
    )


# ── 2. Workflow Execution Layer ────────────────────────────────────────────────

class WorkflowInstance(BaseModel):
    """
    A running execution of a WorkflowTemplate for a specific Document.
    One Document has at most one active WorkflowInstance at a time.

    IMPORTANT — current_stage_id is NEVER reset when changes are requested.
    It only advances forward (or stays put). /revise-and-resume creates a new
    ApprovalStep at the SAME stage without touching current_stage_id.
    """
    __tablename__ = "workflow_instances"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False, index=True,
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_templates.id"), nullable=True,
    )
    # Frozen snapshot of the template at submission time (§10.3)
    template_version_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)

    # Status enum per architecture §4:
    # 'pending' | 'in_progress' | 'changes_requested' | 'approved' | 'rejected' | 'cancelled' | 'escalated'
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)

    # Points to the stage currently being processed — NEVER reset on changes_requested
    current_stage_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_stages.id"), nullable=True,
    )
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False,
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Relationships
    document: Mapped["Document"] = relationship(  # type: ignore[name-defined]
        "Document", back_populates="workflow_instances", lazy="noload",
    )
    template: Mapped["WorkflowTemplate | None"] = relationship(
        "WorkflowTemplate", back_populates="instances", lazy="noload",
    )
    current_stage: Mapped["WorkflowStage | None"] = relationship(
        "WorkflowStage", foreign_keys=[current_stage_id], lazy="noload",
    )
    approval_steps: Mapped[list["ApprovalStep"]] = relationship(
        "ApprovalStep", back_populates="instance",
        lazy="noload", cascade="all, delete-orphan",
    )
    conversations: Mapped[list["Conversation"]] = relationship(  # type: ignore[name-defined]
        "Conversation", back_populates="workflow_instance", lazy="noload",
    )
    audit_logs: Mapped[list["AuditLog"]] = relationship(  # type: ignore[name-defined]
        "AuditLog", back_populates="workflow_instance", lazy="noload",
        primaryjoin="AuditLog.instance_id == WorkflowInstance.id",
        foreign_keys="AuditLog.instance_id",
    )
    notifications: Mapped[list["Notification"]] = relationship(  # type: ignore[name-defined]
        "Notification", back_populates="workflow_instance", lazy="noload",
        primaryjoin="Notification.instance_id == WorkflowInstance.id",
        foreign_keys="Notification.instance_id",
    )

    __table_args__ = (
        Index("idx_wi_document_status", "document_id", "status"),
        Index("idx_wi_org_status", "org_id", "status"),
    )


class ApprovalStep(BaseModel):
    """
    A single approver's action on a specific stage in a specific round.

    KEY INVARIANT: A stage can have MULTIPLE ApprovalStep rows over the
    life of an instance — one per revision round. This is what makes
    'resume at the flagged stage' auditable rather than destructive.

    Each ApprovalStep is stamped with the document_version_id it was
    decided against, giving a complete version-decision audit trail.
    """
    __tablename__ = "approval_steps"

    instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_instances.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    stage_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_stages.id"),
        nullable=False, index=True,
    )
    # The exact document version this approver is deciding against
    document_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("document_versions.id"),
        nullable=False,
    )
    approver_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"),
        nullable=False, index=True,
    )
    # decision: 'pending' | 'approved' | 'rejected' | 'changes_requested' | 'delegated' | 'abstained'
    decision: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)
    decision_note: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Round number (1 = first pass, 2 = after first revision, etc.)
    round_number: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # Relationships
    instance: Mapped["WorkflowInstance"] = relationship(
        "WorkflowInstance", back_populates="approval_steps", lazy="noload",
    )
    stage: Mapped["WorkflowStage"] = relationship(
        "WorkflowStage", back_populates="approval_steps", lazy="noload",
    )
    document_version: Mapped["DocumentVersion"] = relationship(  # type: ignore[name-defined]
        "DocumentVersion", lazy="noload",
    )
    approver: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", foreign_keys=[approver_id], lazy="noload",
    )
    esignature: Mapped["ESignature | None"] = relationship(
        "ESignature", back_populates="approval_step",
        lazy="noload", uselist=False, cascade="all, delete-orphan",
    )
    # The workflow-context conversation opened when this step requested changes
    conversation: Mapped["Conversation | None"] = relationship(  # type: ignore[name-defined]
        "Conversation", back_populates="approval_step",
        lazy="noload", uselist=False,
        primaryjoin="Conversation.approval_step_id == ApprovalStep.id",
        foreign_keys="Conversation.approval_step_id",
    )
    delegations: Mapped[list["Delegation"]] = relationship(
        "Delegation", back_populates="approval_step",
        lazy="noload", cascade="all, delete-orphan",
    )
    sla_events: Mapped[list["SLAEvent"]] = relationship(  # type: ignore[name-defined]
        "SLAEvent", back_populates="approval_step",
        lazy="noload", cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("idx_approval_step_approver_decision", "approver_id", "decision"),
    )


class ESignature(BaseModel):
    """
    Electronic signature evidence captured when an approver signs a step.
    Stored for legal defensibility: hash + IP + timestamp.
    """
    __tablename__ = "esignatures"

    approval_step_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approval_steps.id", ondelete="CASCADE"),
        nullable=False, unique=True,
    )
    # 'drawn' | 'typed' | 'provider_docusign' | 'provider_adobe' | 'click_to_sign'
    signature_method: Mapped[str] = mapped_column(String(100), nullable=False)
    # SHA-256 hash of the signed document bytes at signing time
    signed_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    ip_address: Mapped[str | None] = mapped_column(String(50))
    user_agent: Mapped[str | None] = mapped_column(Text)
    signed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False,
    )
    # Optional: external provider reference (DocuSign envelope ID, etc.)
    provider_reference: Mapped[str | None] = mapped_column(String(255))

    approval_step: Mapped["ApprovalStep"] = relationship(
        "ApprovalStep", back_populates="esignature", lazy="noload",
    )


class Delegation(BaseModel):
    """
    Delegation of approval authority from one user to another.
    Can be scoped to all workflows, a department, or a specific workflow.

    scope: 'all' | 'department' | 'specific_workflow'
    """
    __tablename__ = "delegations"

    delegator_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True,
    )
    delegate_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True,
    )
    # Optional: which specific ApprovalStep triggered this delegation
    approval_step_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approval_steps.id"), nullable=True,
    )
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scope: Mapped[str] = mapped_column(String(50), default="all", nullable=False)
    # For 'specific_workflow' scope — which template this applies to
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_templates.id"), nullable=True,
    )
    # For 'department' scope
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True,
    )
    reason: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    delegator: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", foreign_keys=[delegator_id], lazy="noload",
    )
    delegate: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", foreign_keys=[delegate_id], lazy="noload",
    )
    approval_step: Mapped["ApprovalStep | None"] = relationship(
        "ApprovalStep", back_populates="delegations", lazy="noload",
    )


# ── Legacy tables (preserved for backward compatibility) ───────────────────────

class WorkflowStepInstance(BaseModel):
    """
    LEGACY — Kept for backward compatibility.
    New code should use ApprovalStep instead.
    """
    __tablename__ = "workflow_step_instances"

    workflow_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_instances.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    step_definition: Mapped[dict] = mapped_column(JSONB, nullable=False)
    step_id: Mapped[str] = mapped_column(String(50), nullable=False)
    step_type: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="pending", nullable=False)
    assigned_role_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("roles.id"), nullable=True,
    )
    assigned_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    delegated_to: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    delegated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sla_hours: Mapped[int | None] = mapped_column(Integer)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    escalated_to: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision: Mapped[str | None] = mapped_column(String(50))
    decision_note: Mapped[str | None] = mapped_column(Text)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    step_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    approval_decisions: Mapped[list["ApprovalDecisionRecord"]] = relationship(
        "ApprovalDecisionRecord", back_populates="step_instance",
        lazy="noload", cascade="all, delete-orphan",
    )


class ApprovalDecisionRecord(BaseModel):
    """
    LEGACY — Kept for backward compatibility.
    New code should use ApprovalStep instead.
    """
    __tablename__ = "approval_decisions"

    step_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_step_instances.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id"), nullable=False,
    )
    decided_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )
    decision: Mapped[str] = mapped_column(String(50), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    signatures: Mapped[dict | None] = mapped_column(JSONB)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False,
    )
    step_instance: Mapped["WorkflowStepInstance"] = relationship(
        "WorkflowStepInstance", back_populates="approval_decisions", lazy="noload",
    )
