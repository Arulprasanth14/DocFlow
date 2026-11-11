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
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
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

    # ── Ownership & sharing (§7) ───────────────────────────────────────────
    # Requirements §7 + the §2.5 matrix ("Create and manage own workflows:
    # Yes" for all four roles): workflows are no longer admin-authored only —
    # any member can define their own named, reusable approval routes.
    # `created_by` is the owner; NULL means an org-level template authored
    # before ownership existed (treated as organization-visible, admin-managed).
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True,
    )
    # 'private'      — only the owner (and org admins) can see/use/edit it
    # 'organization' — any member of the org can see and use it; still only
    #                  the owner or an org admin may EDIT it ("Prevent
    #                  unauthorized users from editing another user's private
    #                  workflow unless sharing or administration permissions
    #                  allow it").
    visibility: Mapped[str] = mapped_column(
        String(20), default="organization", server_default="organization", nullable=False,
    )

    # ── Lifecycle + versioning (Workflow module DM-01..04, WF-LC-03) ───────
    # `status` separates "archived" (hidden from pickers, in-flight runs
    # continue, restorable) from `is_active`, which the older enable/disable
    # action toggles. Both are kept: `is_active` is still read by existing
    # callers and the two are moved in step by the service layer.
    status: Mapped[str] = mapped_column(
        String(20), default="active", server_default="active", nullable=False,
    )
    # Workflow-level setting WF-BLD-07 / BR-06: when true, a revised document
    # restarts from stage 1 instead of returning to the stage that asked for
    # the changes. Default OFF — the spec is explicit that a full re-approval
    # must never happen implicitly.
    require_full_reapproval: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False,
    )
    # Points at the newest immutable version. Nullable because a template
    # created before versioning existed has none until the backfill runs.
    # use_alter breaks the cycle with workflow_template_versions.template_id.
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_template_versions.id", use_alter=True,
                   name="fk_wft_current_version"),
        nullable=True,
    )

    owner: Mapped["User | None"] = relationship(  # type: ignore[name-defined]
        "User", lazy="noload", foreign_keys=[created_by],
    )
    versions: Mapped[list["WorkflowTemplateVersion"]] = relationship(
        "WorkflowTemplateVersion", back_populates="template",
        lazy="noload", cascade="all, delete-orphan",
        foreign_keys="WorkflowTemplateVersion.template_id",
        order_by="WorkflowTemplateVersion.version_number",
    )
    shares: Mapped[list["WorkflowShare"]] = relationship(
        "WorkflowShare", back_populates="template",
        lazy="noload", cascade="all, delete-orphan",
    )

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
    # When True, an Approve decision on this stage REQUIRES a digital e-signature;
    # the decision endpoint will reject 'approved' without a valid ESignatureRequest.
    requires_signature: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

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

    # ── Runtime layer (migration e1f2a3b4c5d6, task P2-1) ──────────────────
    # THE PINNED DEFINITION (DM-02). A run is routed by this version for its
    # whole life; the live template is never consulted again after submit.
    # Nullable only because a run whose template could not be represented as
    # a version stays on the legacy path rather than being coerced.
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_template_versions.id"),
        nullable=True, index=True,
    )
    # AP-REJ-04 / WF-SUB-06: "Submit as New" starts a fresh run linked to the
    # one it replaces, because a rejected run is terminal and is never
    # reopened (BR-07, BR-14).
    previous_run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_instances.id"), nullable=True,
    )
    # X-INT-02 optimistic locking.
    row_version: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False,
    )
    # X-INT-01: the key this run was created under, so a replayed submit
    # returns this run instead of starting a second one.
    idempotency_key: Mapped[str | None] = mapped_column(String(255))
    # WF-REV-13: a full re-approval reset opens a new cycle of stage
    # instances; this says which cycle is live.
    current_cycle: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False,
    )

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

    stage_instances: Mapped[list["StageInstance"]] = relationship(
        "StageInstance", back_populates="instance",
        foreign_keys="StageInstance.instance_id",
        lazy="noload", cascade="all, delete-orphan",
        order_by="StageInstance.position",
    )
    version: Mapped["WorkflowTemplateVersion | None"] = relationship(
        "WorkflowTemplateVersion", foreign_keys=[version_id], lazy="noload",
    )

    __table_args__ = (
        Index("idx_wi_document_status", "document_id", "status"),
        Index("idx_wi_org_status", "org_id", "status"),
        # BR-01 / X-INT-06: at most ONE live run per document, enforced by
        # the database so a double-submitted request cannot create a second
        # one (E10, T26). Partial, because a document may be resubmitted
        # after its previous run reached a terminal state.
        Index(
            "uq_wi_single_live_run", "document_id", unique=True,
            postgresql_where=text(
                "status NOT IN ('approved', 'rejected', 'cancelled',"
                " 'finalized', 'completed') AND deleted_at IS NULL"
            ),
        ),
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
    # The stage instance this decision belongs to (task P2-1). Nullable so
    # every pre-existing row stays valid; `stage_id` is untouched and still
    # populated. StageInstance owns status and timing, ApprovalStep owns the
    # decision and its signature — the link points this way only.
    stage_instance_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stage_instances.id"),
        nullable=True, index=True,
    )

    # ── Revocation / invalidation (§6.5) ───────────────────────────────────
    # A revoked decision is NEVER deleted and its `decision` field is NEVER
    # rewritten — the original decision stays exactly as recorded, and these
    # columns mark that it no longer counts toward stage gating, with who
    # revoked it, when, and why ("Never delete the original approval record.
    # Preserve it as an audit event with its status, timestamp, reason, and
    # relationship to the subsequent revocation/correction").
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    revocation_reason: Mapped[str | None] = mapped_column(Text)
    # Set when a NEW document version invalidates this decision (it was made
    # against a version that is no longer current), requiring re-approval.
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @property
    def is_counted(self) -> bool:
        """True when this decision still counts toward stage gating — i.e.
        it has not been revoked and has not been superseded by a newer
        document version."""
        return self.revoked_at is None and self.superseded_at is None

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
    Signature evidence captured when an approver signs a step.

    Requirements report §6.4: a drawn/typed signature image ALONE is not a
    cryptographic digital signature. Every row created by the current
    ApprovalService.decide() flow populates the `signature_b64`/
    `algorithm`/`key_id`/`signed_payload`/`payload_hash` fields with a real
    RSA-PSS-SHA256 signature (app/core/signing.py) binding the approver
    identity, document version hash, decision, timestamp, and workflow
    step together — `signature_method` stays as supplementary UI/ceremony
    metadata (how the approver indicated intent to sign), not the proof
    itself. The legacy `signed_hash`/`ip_address`/`user_agent`/
    `provider_reference` fields are kept for rows created before this
    (or by a future external e-sign provider integration) and are not
    required for a row to be considered a valid cryptographic signature.
    """
    __tablename__ = "esignatures"

    approval_step_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approval_steps.id", ondelete="CASCADE"),
        nullable=False, unique=True,
    )
    # 'drawn' | 'typed' | 'provider_docusign' | 'provider_adobe' | 'click_to_sign' |
    # 'system' (no separate UI ceremony — the act of deciding IS the signing event)
    signature_method: Mapped[str] = mapped_column(String(100), nullable=False)
    # SHA-256 hash of the signed document bytes at signing time (legacy —
    # superseded by `payload_hash`, which covers the full signed payload
    # including this same document-version hash plus approver/decision/step)
    signed_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    ip_address: Mapped[str | None] = mapped_column(String(50))
    user_agent: Mapped[str | None] = mapped_column(Text)
    signed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False,
    )
    # Optional: external provider reference (DocuSign envelope ID, etc.)
    provider_reference: Mapped[str | None] = mapped_column(String(255))

    # ── Cryptographic signature (§6.4) ─────────────────────────────────────
    # The exact canonicalized payload that was signed — approver_id,
    # document_version_id, document_hash, decision, step_id, instance_id,
    # signed_at (ISO) — persisted so verification never has to guess at
    # reconstruction and any later edit to this row is itself detectable
    # (the stored payload_hash must match a fresh hash of signed_payload).
    signed_payload: Mapped[dict | None] = mapped_column(JSONB)
    payload_hash: Mapped[str | None] = mapped_column(String(64))
    signature_b64: Mapped[str | None] = mapped_column(Text)
    algorithm: Mapped[str | None] = mapped_column(String(50))
    key_id: Mapped[str | None] = mapped_column(String(32))
    # Cached result of the most recent verify_signature() call (§6.4: "record
    # signature verification results... and relevant audit events") — the
    # authoritative check always re-verifies live; this is a fast-path cache
    # for list views, refreshed whenever the signature is re-checked.
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_verification_valid: Mapped[bool | None] = mapped_column(Boolean)

    approval_step: Mapped["ApprovalStep"] = relationship(
        "ApprovalStep", back_populates="esignature", lazy="noload",
    )


class ApprovalRevocation(BaseModel):
    """
    A request to revoke/recall an already-recorded approval decision (§6.5).

    Two paths, distinguished by `status` at creation time:

      'applied'   — nothing downstream had happened yet, so the revocation
                    took effect immediately: the original ApprovalStep is
                    marked revoked (never deleted) and the document went
                    back to its owner for correction.
      'requested' — the document had already moved to a later approver, so
                    the earlier approver may NOT silently roll it back. The
                    request is recorded, the instance enters
                    RECALL_REQUESTED (and stays OPEN), affected participants
                    are notified, and an authorized actor later resolves it
                    to 'approved' (apply the recall, invalidating affected
                    downstream approvals) or 'denied' (workflow continues).

    The row itself is the durable audit record of the revocation and its
    relationship to the original decision.
    """
    __tablename__ = "approval_revocations"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_instances.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # The decision being revoked — preserved, never deleted.
    approval_step_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approval_steps.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    requested_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    # 'applied' | 'requested' | 'approved' | 'denied'
    status: Mapped[str] = mapped_column(String(50), nullable=False, default="requested")
    # Steps whose decisions this recall invalidated (or would invalidate)
    affected_step_ids: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]",
    )
    resolution_note: Mapped[str | None] = mapped_column(Text)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    instance: Mapped["WorkflowInstance"] = relationship(
        "WorkflowInstance", lazy="noload", foreign_keys=[instance_id],
    )
    approval_step: Mapped["ApprovalStep"] = relationship(
        "ApprovalStep", lazy="noload", foreign_keys=[approval_step_id],
    )
    requester: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", lazy="noload", foreign_keys=[requested_by],
    )

    __table_args__ = (
        Index("idx_approval_revocation_instance_status", "instance_id", "status"),
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


# ── 3. Workflow Definition Versioning & Sharing (Workflow module §4.4, §5.1) ──

class WorkflowTemplateVersion(BaseModel):
    """
    An IMMUTABLE snapshot of a workflow definition (DM-01).

    Why this exists: before it, `WorkflowTemplate.version` was a bare integer
    counter and the stage rows were mutable, so
      * `WorkflowService.advance_stage()` read the LIVE template, meaning an
        edit silently re-routed runs that were already in flight, though
        DM-02 says a run is pinned to one version "for its entire life"; and
      * the stage list could not be edited at all without either violating
        `approval_steps.stage_id` / `workflow_instances.current_stage_id`
        (neither has ON DELETE) or orphaning the audit trail of approvals
        already recorded against those stages.

    Each save writes a new row here and never touches an existing one; a run
    pins the version it was submitted against, so editing, archiving or
    deleting the template afterwards cannot change it (BR-02, DM-02, E6).

    `stages_snapshot` duplicates the ordered stage list as JSON for cheap,
    join-free reads (audit timelines, "which stages did this run actually
    use?") while `WorkflowVersionStage` holds the same data relationally for
    querying and constraint enforcement.
    """
    __tablename__ = "workflow_template_versions"

    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_templates.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    # Name and description are snapshotted too: the audit trail must show what
    # the workflow was CALLED when a document went through it, not what it is
    # called now (X-AUD-02 renders a human-readable timeline from this).
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    require_full_reapproval: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False,
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    stages_snapshot: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]",
    )

    template: Mapped["WorkflowTemplate"] = relationship(
        "WorkflowTemplate", back_populates="versions",
        lazy="noload", foreign_keys=[template_id],
    )
    stages: Mapped[list["WorkflowVersionStage"]] = relationship(
        "WorkflowVersionStage", back_populates="version",
        lazy="noload", cascade="all, delete-orphan",
        order_by="WorkflowVersionStage.position",
    )

    __table_args__ = (
        UniqueConstraint("template_id", "version_number",
                         name="uq_wf_version_template_number"),
    )


class WorkflowVersionStage(BaseModel):
    """
    One stage inside an immutable workflow version (§5.5, §8).

    Deliberately separate from the legacy `WorkflowStage`: those rows are
    referenced by `approval_steps.stage_id` and cannot be rewritten without
    destroying history, so versioned stages get their own table and the old
    one is left exactly as it is.

    `due_within_value` + `due_within_unit` are what the builder shows
    ("2 days"); `due_within_hours` is what the engine computes with. Both are
    stored so the UI can round-trip the wording the user chose instead of
    re-deriving "48 hours" and showing that back to them.
    """
    __tablename__ = "workflow_version_stages"

    version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workflow_template_versions.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # 'specific_user' | 'submitter_manager'  (§5.5 field B offers exactly two)
    approver_type: Mapped[str] = mapped_column(String(30), nullable=False)
    # Required iff approver_type == 'specific_user' (enforced by a CHECK below).
    approver_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True,
    )
    due_within_value: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    # 'hours' | 'days'
    due_within_unit: Mapped[str] = mapped_column(
        String(10), nullable=False, default="days", server_default="days",
    )
    due_within_hours: Mapped[int] = mapped_column(Integer, nullable=False, default=48)
    require_signing: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False,
    )

    version: Mapped["WorkflowTemplateVersion"] = relationship(
        "WorkflowTemplateVersion", back_populates="stages", lazy="noload",
    )

    __table_args__ = (
        UniqueConstraint("version_id", "position", name="uq_wf_vstage_position"),
        # 1 hour .. 30 days (O-5). A zero-hour deadline would be overdue on
        # arrival; anything past 30 days is not an SLA.
        CheckConstraint("due_within_hours >= 1 AND due_within_hours <= 720",
                        name="ck_wf_vstage_due_within_hours"),
        CheckConstraint(
            "approver_type IN ('specific_user', 'submitter_manager')",
            name="ck_wf_vstage_approver_type",
        ),
        # A 'specific_user' stage with nobody selected would resolve to nobody
        # and stall the run forever; a 'submitter_manager' stage with somebody
        # pinned would contradict its own rule.
        CheckConstraint(
            "(approver_type = 'specific_user' AND approver_user_id IS NOT NULL)"
            " OR (approver_type = 'submitter_manager' AND approver_user_id IS NULL)",
            name="ck_wf_vstage_approver_presence",
        ),
        CheckConstraint("due_within_unit IN ('hours', 'days')",
                        name="ck_wf_vstage_due_within_unit"),
    )


class WorkflowShare(BaseModel):
    """
    A grant of USE permission on one workflow to one individual user (§5.1).

    Ownership, visibility and permission-to-use are three separate concepts
    and the spec is explicit that they must never be conflated:
      ownership  -> workflow_templates.created_by
      visibility -> DERIVED: "Shared" iff an active row exists here
      use        -> this row

    A grantee may view the configuration, select the workflow on upload and
    duplicate it into their own private copy. They may NOT edit, archive,
    delete or re-share it (WF-OWN-05).

    Revoking sets `revoked_at` rather than deleting, so the audit trail keeps
    who granted what to whom and when it ended (WF-OWN-11, E20). Runs already
    started are unaffected by a revoke (WF-OWN-06, DM-02).
    """
    __tablename__ = "workflow_shares"

    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_templates.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    grantee_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # v1 has exactly one grantable permission (§5.1). Stored rather than
    # implied so that adding VIEW/EDIT later needs no migration of meaning.
    permission: Mapped[str] = mapped_column(
        String(20), nullable=False, default="USE", server_default="USE",
    )
    granted_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )
    granted_at: Mapped[datetime] = mapped_column(
        # server_default mirrors migration b7c8d9e0f1a2, which created the
        # column with DEFAULT now(). Without it here the model and the
        # migrated schema disagree and `alembic check` reports drift, even
        # though the Python default made the behaviour identical.
        DateTime(timezone=True), default=utcnow,
        server_default=text("now()"), nullable=False,
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    # The chat message that announced the share, so re-sharing returns the
    # existing one instead of sending a second message (WF-OWN-07).
    chat_message_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("chat_messages.id", ondelete="SET NULL"),
        nullable=True,
    )

    template: Mapped["WorkflowTemplate"] = relationship(
        "WorkflowTemplate", back_populates="shares", lazy="noload",
    )
    grantee: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", lazy="noload", foreign_keys=[grantee_user_id],
    )

    __table_args__ = (
        # At most one LIVE share per (workflow, user). Revoked rows are kept
        # for audit and must not block a later re-share, hence partial. This
        # is what makes WF-OWN-07 ("sharing is idempotent") a database
        # guarantee rather than a check-then-insert race.
        Index(
            "uq_workflow_share_active",
            "template_id", "grantee_user_id",
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
        ),
        # The grantee "Shared with me" list and the upload picker both ask
        # "which live shares do I have?" — the index §8 requires.
        Index(
            "idx_workflow_share_grantee_active",
            "grantee_user_id",
            postgresql_where=text("revoked_at IS NULL"),
        ),
    )


# ══════════════════════════════════════════════════════════════════════════════
# RUNTIME LAYER — Workflow Module §4.3 D, migration e1f2a3b4c5d6 (task P2-1)
#
# A run's own record of the stages it must visit, created once from the PINNED
# version and never re-derived from the live template. This is what makes
# DM-02 enforceable: advance_stage() reading the live template is what let an
# owner's edit reroute — or silently approve — someone else's in-flight
# document (defect 1).
#
# Division of responsibility with the existing ApprovalStep, so the two can
# never become rival sources of truth:
#   StageInstance  owns stage STATUS, TIMING and the resolved approver.
#   ApprovalStep   owns the per-approver DECISION and its signature.
# The dependency points one way only: a step belongs to a stage instance.
# ══════════════════════════════════════════════════════════════════════════════

# §4.3 D. A module constant so the model CHECK and the migration CHECK are
# written from the same list.
STAGE_INSTANCE_STATUSES = (
    "pending", "active", "awaiting_signature", "changes_requested",
    "approved", "rejected", "blocked", "superseded",
)

_STAGE_STATUS_CHECK = "status IN ('" + "', '".join(STAGE_INSTANCE_STATUSES) + "')"


class StageInstance(BaseModel):
    """One stage of one run (§4.3 D).

    `cycle` exists for WF-REV-13: require_full_reapproval resets a run to
    stage 1, and the spec requires the earlier stage instances to be marked
    Superseded and RETAINED for audit. A new pass therefore opens cycle 2
    rather than overwriting cycle 1, which is why uniqueness is
    (instance, cycle, position) and not (instance, position).
    """
    __tablename__ = "stage_instances"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False,
    )
    instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_instances.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # The pinned definition this stage came from — authoritative for routing.
    version_stage_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_version_stages.id"), nullable=True,
    )
    # Kept only so an ApprovalStep (whose stage_id is NOT NULL and references
    # workflow_stages) can still be written for this stage while the legacy
    # table remains in the schema. Never read to decide routing.
    legacy_stage_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workflow_stages.id"), nullable=True,
    )
    cycle: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)

    # Snapshot: the timeline must still read correctly after the definition
    # changes (DM-02).
    stage_name: Mapped[str] = mapped_column(String(255), nullable=False)
    approver_type: Mapped[str] = mapped_column(
        String(40), default="specific_user",
        server_default="specific_user", nullable=False,
    )
    # Resolved ONCE at activation and authoritative from then on, even if the
    # org chart changes afterwards (WF-STG-23, E5). NULL until activation.
    resolved_approver_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True,
    )
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True,
    )
    # WF-STG-21: may be forced true at activation even when the definition
    # said off (a manager rule resolving into a signing department), so the
    # reason is recorded next to it and surfaced to the approver.
    signing_required: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False,
    )
    signing_reason: Mapped[str | None] = mapped_column(String(255))

    status: Mapped[str] = mapped_column(
        String(40), default="pending", server_default="pending", nullable=False,
    )
    due_within_hours: Mapped[int | None] = mapped_column(Integer)
    # Server-computed and stored; the UI never computes a due date
    # (AP-SLA-07, BR-13).
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # §6.10: the clock stops while Changes Requested or Blocked, so a document
    # sitting with its owner does not accrue toward the approver's breach.
    timer_paused_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    round_count: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False,
    )
    blocked_reason: Mapped[str | None] = mapped_column(String(255))
    # X-INT-02 optimistic locking.
    row_version: Mapped[int] = mapped_column(
        Integer, default=1, server_default=text("1"), nullable=False,
    )

    # Relationships
    instance: Mapped["WorkflowInstance"] = relationship(
        "WorkflowInstance", back_populates="stage_instances",
        foreign_keys=[instance_id], lazy="noload",
    )
    version_stage: Mapped["WorkflowVersionStage | None"] = relationship(
        "WorkflowVersionStage", lazy="noload",
    )
    resolved_approver: Mapped["User | None"] = relationship(  # type: ignore[name-defined]
        "User", foreign_keys=[resolved_approver_id], lazy="noload",
    )
    rounds: Mapped[list["ReviewRound"]] = relationship(
        "ReviewRound", back_populates="stage_instance",
        lazy="noload", cascade="all, delete-orphan",
        order_by="ReviewRound.round_number",
    )
    decisions: Mapped[list["Decision"]] = relationship(
        "Decision", back_populates="stage_instance",
        lazy="noload", cascade="all, delete-orphan",
    )

    @property
    def is_open(self) -> bool:
        """True while this stage still needs someone to act."""
        return self.status in (
            "pending", "active", "awaiting_signature",
            "changes_requested", "blocked",
        )

    @property
    def is_timer_running(self) -> bool:
        """The SLA sweep must skip a paused stage (§6.10, defect 6)."""
        return (
            self.status in ("active", "awaiting_signature")
            and self.timer_paused_at is None
        )

    __table_args__ = (
        UniqueConstraint("instance_id", "cycle", "position",
                         name="uq_stage_instance_position"),
        CheckConstraint("position >= 1", name="ck_stage_instance_position"),
        CheckConstraint("cycle >= 1", name="ck_stage_instance_cycle"),
        CheckConstraint("round_count >= 1", name="ck_stage_instance_rounds"),
        CheckConstraint(_STAGE_STATUS_CHECK, name="ck_stage_instance_status"),
        CheckConstraint(
            "due_within_hours IS NULL OR "
            "(due_within_hours >= 1 AND due_within_hours <= 720)",
            name="ck_stage_instance_due_within",
        ),
        # The approvals dashboard's main query (AP-DSH-*) and the one-minute
        # SLA sweep (AP-SLA-01) both read exactly these three columns.
        Index("idx_stage_instance_queue",
              "resolved_approver_id", "status", "due_at"),
        Index("idx_stage_instance_org_status", "org_id", "status"),
    )


class ReviewRound(BaseModel):
    """One pass of one stage over one document version (§6.5.2, BR-06).

    A change request closes a round; a resubmission opens the next one on the
    SAME stage instance. That is what makes "the document returns to the stage
    that asked for changes, never stage 1" auditable instead of destructive.
    """
    __tablename__ = "review_rounds"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False,
    )
    stage_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stage_instances.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    round_number: Mapped[int] = mapped_column(Integer, nullable=False)
    # The exact version under review in this round (DM-02, WF-REV-08).
    document_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("document_versions.id"), nullable=False,
    )
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow,
        server_default=text("now()"), nullable=False,
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    outcome: Mapped[str | None] = mapped_column(String(40))

    stage_instance: Mapped["StageInstance"] = relationship(
        "StageInstance", back_populates="rounds", lazy="noload",
    )

    __table_args__ = (
        UniqueConstraint("stage_instance_id", "round_number",
                         name="uq_review_round_number"),
        CheckConstraint("round_number >= 1", name="ck_review_round_number"),
        CheckConstraint(
            "outcome IS NULL OR outcome IN "
            "('approved', 'rejected', 'changes_requested', "
            "'withdrawn', 'superseded')",
            name="ck_review_round_outcome",
        ),
    )


class Decision(BaseModel):
    """An approver's recorded decision (AP-APR-06). Immutable once written (BR-09).

    Nothing in the service layer updates a Decision row. A correction is a new
    row and a revocation is recorded on the ApprovalStep, so the original
    decision survives exactly as it was made.
    """
    __tablename__ = "decisions"

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id"), nullable=False,
    )
    stage_instance_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stage_instances.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    review_round_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("review_rounds.id"), nullable=True,
    )
    actor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False,
    )
    decision: Mapped[str] = mapped_column(String(40), nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    # AP-APR-06 asks for the version id AND its hash, so a decision stays
    # verifiable on its own terms.
    document_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("document_versions.id"), nullable=False,
    )
    document_version_hash: Mapped[str | None] = mapped_column(String(128))
    esignature_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("esignatures.id"), nullable=True,
    )
    # Bridge to the existing per-approver record so the two never drift.
    approval_step_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("approval_steps.id"), nullable=True,
    )
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow,
        server_default=text("now()"), nullable=False,
    )

    stage_instance: Mapped["StageInstance"] = relationship(
        "StageInstance", back_populates="decisions", lazy="noload",
    )
    actor: Mapped["User"] = relationship(  # type: ignore[name-defined]
        "User", foreign_keys=[actor_id], lazy="noload",
    )

    __table_args__ = (
        CheckConstraint(
            "decision IN ('approved', 'rejected', 'changes_requested')",
            name="ck_decision_value",
        ),
        Index("idx_decision_actor", "actor_id", "decided_at"),
    )
