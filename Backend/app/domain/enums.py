"""
DocFlow Backend — Domain Enums
All domain string enums, authoritative source of truth.
Used in SQLAlchemy models (VARCHAR columns), Pydantic schemas, and business logic.
Never use raw string literals for statuses — always reference these enums.

Updated per DocFlow-System-Architecture.md:
  - WorkflowInstanceStatus: added pending, in_progress, changes_requested, escalated
  - ApprovalDecision: added changes_requested, abstained; kept returned as alias
  - Added: ConversationKind, StageType, ApproverRuleType, SLAEventType, DelegationScope
  - NotificationType: aligned to architecture §4 values
"""
from __future__ import annotations

from enum import StrEnum


# ── Document Status ────────────────────────────────────────────────────────────
class DocumentStatus(StrEnum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    IN_REVIEW = "in_review"                    # matches architecture §4
    PENDING_APPROVAL = "pending_approval"
    CHANGES_REQUESTED = "changes_requested"    # matches architecture §4
    REVISION_REQUESTED = "revision_requested"  # legacy alias
    APPROVED = "approved"
    REJECTED = "rejected"
    EXECUTED = "executed"     # signed/effective after approval
    ARCHIVED = "archived"
    CANCELLED = "cancelled"
    CLOSED = "closed"

    @classmethod
    def active_statuses(cls) -> list["DocumentStatus"]:
        return [
            cls.SUBMITTED,
            cls.IN_REVIEW,
            cls.PENDING_APPROVAL,
            cls.CHANGES_REQUESTED,
            cls.REVISION_REQUESTED,
        ]

    @classmethod
    def terminal_statuses(cls) -> list["DocumentStatus"]:
        return [cls.APPROVED, cls.REJECTED, cls.ARCHIVED, cls.CANCELLED, cls.CLOSED]


# ── Document Priority ─────────────────────────────────────────────────────────
class DocumentPriority(StrEnum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


# ── Stage Type (WorkflowStage.stage_type) ─────────────────────────────────────
class StageType(StrEnum):
    SEQUENTIAL = "sequential"
    PARALLEL = "parallel"
    CONDITIONAL = "conditional"


# ── Workflow Step Type (legacy DAG engine) ─────────────────────────────────────
class WorkflowStepType(StrEnum):
    APPROVAL = "approval"
    PARALLEL = "parallel"
    CONDITIONAL = "conditional"
    NOTIFICATION = "notification"
    AUTO_APPROVE = "auto_approve"


# ── Workflow Step Status (legacy DAG engine) ───────────────────────────────────
class WorkflowStepStatus(StrEnum):
    PENDING = "pending"
    ACTIVE = "active"
    APPROVED = "approved"
    REJECTED = "rejected"
    RETURNED = "returned"
    DELEGATED = "delegated"
    ESCALATED = "escalated"
    SKIPPED = "skipped"
    CANCELLED = "cancelled"


# ── Workflow Instance Status (architecture §4) ────────────────────────────────
class WorkflowInstanceStatus(StrEnum):
    # Architecture-specified values
    PENDING = "pending"              # submitted, not yet started (stage 1 not notified)
    IN_PROGRESS = "in_progress"     # at least one stage active
    CHANGES_REQUESTED = "changes_requested"  # approver sent back for revision
    APPROVED = "approved"           # all stages complete + approved
    REJECTED = "rejected"           # blocking rejection received
    CANCELLED = "cancelled"         # creator withdrew
    ESCALATED = "escalated"         # SLA breach escalated
    # Legacy values (kept for backward compatibility)
    ACTIVE = "active"
    COMPLETED = "completed"
    SUSPENDED = "suspended"


# ── Approval Decision (architecture §4 ApprovalStep.decision) ────────────────
class ApprovalDecision(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    CHANGES_REQUESTED = "changes_requested"  # architecture primary value
    RETURNED = "returned"                    # legacy alias for changes_requested
    DELEGATED = "delegated"
    ABSTAINED = "abstained"                  # architecture §4


# ── Approver Rule Type (StageApproverRule.rule_type) ─────────────────────────
class ApproverRuleType(StrEnum):
    SPECIFIC_USER = "specific_user"
    ROLE_IN_DEPARTMENT = "role_in_department"
    MANAGER_OF_REQUESTER = "manager_of_requester"
    DYNAMIC_BY_AMOUNT_THRESHOLD = "dynamic_by_amount_threshold"


# ── Assignee Type (legacy workflow DAG engine) ────────────────────────────────
class AssigneeType(StrEnum):
    USER = "user"
    ROLE = "role"
    DEPARTMENT_HEAD = "department_head"
    SUBMITTER_MANAGER = "submitter_manager"
    DYNAMIC = "dynamic"          # resolved at runtime by condition


# ── Conversation Kind (architecture §5) ───────────────────────────────────────
class ConversationKind(StrEnum):
    WORKFLOW_CONTEXT = "workflow_context"  # pinned to an approval step
    DIRECT = "direct"                       # free-form direct message


# ── SLA Event Type (architecture §4 SLAEvent) ────────────────────────────────
class SLAEventType(StrEnum):
    STARTED = "started"
    REMINDER_SENT = "reminder_sent"
    ESCALATED = "escalated"
    BREACHED = "breached"


# ── Delegation Scope (architecture §4 Delegation) ────────────────────────────
class DelegationScope(StrEnum):
    ALL = "all"
    DEPARTMENT = "department"
    SPECIFIC_WORKFLOW = "specific_workflow"


# ── Notification Type (architecture §4) ───────────────────────────────────────
class NotificationType(StrEnum):
    # Architecture §4 values
    ASSIGNED = "assigned"
    APPROVED = "approved"
    REJECTED = "rejected"
    CHANGES_REQUESTED = "changes_requested"
    SLA_BREACH_WARNING = "sla_breach_warning"
    ESCALATED = "escalated"
    NEW_MESSAGE = "new_message"
    # Extended values
    DELEGATED = "delegated"
    DOCUMENT_SUBMITTED = "document.submitted"
    DOCUMENT_APPROVED = "document.approved"
    DOCUMENT_REJECTED = "document.rejected"
    DOCUMENT_CANCELLED = "document.cancelled"
    DOCUMENT_COMMENT = "document.comment"
    MENTION = "mention"
    SYSTEM = "system"


# ── User Role (architecture §4 coarse system role) ────────────────────────────
class UserRole(StrEnum):
    MEMBER = "member"
    DEPARTMENT_ADMIN = "department_admin"
    SUPER_ADMIN = "super_admin"


# ── User Status ────────────────────────────────────────────────────────────────
class UserStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    SUSPENDED = "suspended"
    PENDING_INVITE = "pending_invite"


# ── Organization Status ────────────────────────────────────────────────────────
class OrganizationStatus(StrEnum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    CANCELLED = "cancelled"


# ── Organization Plan ──────────────────────────────────────────────────────────
class OrganizationPlan(StrEnum):
    TRIAL = "trial"
    STARTER = "starter"
    PROFESSIONAL = "professional"
    ENTERPRISE = "enterprise"


# ── Organization Member Status ─────────────────────────────────────────────────
class MemberStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    SUSPENDED = "suspended"


# ── File Storage Mode ──────────────────────────────────────────────────────────
class StorageMode(StrEnum):
    S3 = "s3"
    MINIO = "minio"
    LOCAL = "local"


# ── AI Task Type ───────────────────────────────────────────────────────────────
class AITaskType(StrEnum):
    OCR = "ocr"
    CLASSIFY = "classify"
    EMBED = "embed"
    SUMMARIZE = "summarize"
    EXTRACT_METADATA = "extract_metadata"
    RISK_ANALYSIS = "risk_analysis"
    WORKFLOW_RECOMMEND = "workflow_recommend"


# ── AI Processing Status ───────────────────────────────────────────────────────
class AIProcessingStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


# ── Risk Level ─────────────────────────────────────────────────────────────────
class RiskLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


# ── Audit Action Categories ────────────────────────────────────────────────────
class AuditAction(StrEnum):
    # Document actions
    DOCUMENT_CREATE = "document.create"
    DOCUMENT_UPDATE = "document.update"
    DOCUMENT_SUBMIT = "document.submit"
    DOCUMENT_REVISE_AND_RESUME = "document.revise_and_resume"
    DOCUMENT_CANCEL = "document.cancel"
    DOCUMENT_DELETE = "document.delete"
    # Approval actions
    APPROVAL_APPROVE = "approval.approve"
    APPROVAL_REJECT = "approval.reject"
    APPROVAL_CHANGES_REQUESTED = "approval.changes_requested"
    APPROVAL_RETURN = "approval.return"         # legacy alias
    APPROVAL_DELEGATE = "approval.delegate"
    APPROVAL_ESCALATE = "approval.escalate"
    # Workflow actions
    WORKFLOW_INSTANCE_CREATE = "workflow.instance.create"
    WORKFLOW_INSTANCE_CANCEL = "workflow.instance.cancel"
    WORKFLOW_INSTANCE_COMPLETE = "workflow.instance.complete"
    WORKFLOW_STAGE_ADVANCE = "workflow.stage.advance"
    # User actions
    USER_LOGIN = "user.login"
    USER_LOGOUT = "user.logout"
    USER_INVITE = "user.invite"
    USER_SUSPEND = "user.suspend"
    USER_DEACTIVATE = "user.deactivate"
    # Admin actions
    ROLE_CREATE = "role.create"
    ROLE_UPDATE = "role.update"
    ROLE_DELETE = "role.delete"
    WORKFLOW_CREATE = "workflow.create"
    WORKFLOW_UPDATE = "workflow.update"


# ── Permissions (Resource Codes) ──────────────────────────────────────────────
class Permission(StrEnum):
    # Documents
    DOCUMENTS_CREATE = "documents:create"
    DOCUMENTS_READ = "documents:read"
    DOCUMENTS_EDIT = "documents:edit"
    DOCUMENTS_DELETE = "documents:delete"
    DOCUMENTS_SUBMIT = "documents:submit"
    DOCUMENTS_CANCEL = "documents:cancel"
    DOCUMENTS_COMMENT = "documents:comment"
    # Workflows
    WORKFLOWS_READ = "workflows:read"
    WORKFLOWS_ADMIN = "workflows:admin"
    # Approvals
    APPROVALS_DECIDE = "approvals:decide"
    APPROVALS_DELEGATE = "approvals:delegate"
    # Chat
    CHAT_READ = "chat:read"
    CHAT_SEND = "chat:send"
    # Analytics
    ANALYTICS_READ = "analytics:read"
    ANALYTICS_EXPORT = "analytics:export"
    # Admin
    ADMIN_USERS = "admin:users"
    ADMIN_ROLES = "admin:roles"
    ADMIN_ORGS = "admin:orgs"
    ADMIN_AUDIT = "admin:audit"
    ADMIN_DOC_TYPES = "admin:doc_types"
    ADMIN_WORKFLOW_TEMPLATES = "admin:workflow_templates"
    # Uploads
    UPLOADS_CREATE = "uploads:create"


# ── System Roles ───────────────────────────────────────────────────────────────
SYSTEM_ROLES = {
    "super_admin": {
        "description": "Full platform access",
        "permissions": list(Permission),
    },
    "org_admin": {
        "description": "Full org access",
        "permissions": [p for p in Permission if not p.startswith("admin:orgs")],
    },
    "dept_manager": {
        "description": "Dept-scoped document + workflow access",
        "permissions": [
            Permission.DOCUMENTS_CREATE,
            Permission.DOCUMENTS_READ,
            Permission.DOCUMENTS_EDIT,
            Permission.DOCUMENTS_SUBMIT,
            Permission.DOCUMENTS_CANCEL,
            Permission.DOCUMENTS_COMMENT,
            Permission.WORKFLOWS_READ,
            Permission.APPROVALS_DECIDE,
            Permission.APPROVALS_DELEGATE,
            Permission.CHAT_READ,
            Permission.CHAT_SEND,
            Permission.ANALYTICS_READ,
            Permission.UPLOADS_CREATE,
        ],
    },
    "approver": {
        "description": "Approve documents assigned to them",
        "permissions": [
            Permission.DOCUMENTS_READ,
            Permission.DOCUMENTS_COMMENT,
            Permission.APPROVALS_DECIDE,
            Permission.APPROVALS_DELEGATE,
            Permission.CHAT_READ,
            Permission.CHAT_SEND,
            Permission.UPLOADS_CREATE,
        ],
    },
    "submitter": {
        "description": "Create + submit own documents",
        "permissions": [
            Permission.DOCUMENTS_CREATE,
            Permission.DOCUMENTS_READ,
            Permission.DOCUMENTS_EDIT,
            Permission.DOCUMENTS_SUBMIT,
            Permission.DOCUMENTS_CANCEL,
            Permission.DOCUMENTS_COMMENT,
            Permission.CHAT_READ,
            Permission.CHAT_SEND,
            Permission.UPLOADS_CREATE,
        ],
    },
    "viewer": {
        "description": "Read-only access to permitted documents",
        "permissions": [
            Permission.DOCUMENTS_READ,
            Permission.CHAT_READ,
        ],
    },
}
