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

NOTE — DocumentStatus:
  The canonical DocumentStatus enum lives in app.models.document.DocumentStatus
  (it is the SQLAlchemy Enum column type and the diagram-correct definition,
  including SENT_BACK). Re-exported here for backwards-compat imports.
"""
from __future__ import annotations

from enum import StrEnum

# ── Document Status — canonical definition is in app.models.document ───────────
# Re-exported here so existing `from app.domain.enums import DocumentStatus`
# imports continue to work without modification.
from app.models.document import DocumentStatus  # noqa: F401


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
    # §6.5: an earlier approver asked to revoke after the document had
    # already moved on. The workflow stays OPEN in this state — it must NOT
    # be closed while the recall is outstanding — until an authorized actor
    # approves the recall (invalidating affected approvals) or denies it.
    RECALL_REQUESTED = "recall_requested"
    # §6.2/6.6: explicitly finalized by the authorized final approver, only
    # once every required step is complete. Distinct from APPROVED, which
    # means "all approvals in, awaiting finalization".
    FINALIZED = "finalized"
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
    # Members — fine-grained (requirements doc §2.5/13.3: Main Admin and HR can
    # both add Worker/Trainee members, but only the Main Administrator may add
    # another HR user or delete a member)
    MEMBERS_INVITE_STANDARD = "members:invite_standard"  # invite worker/trainee
    MEMBERS_INVITE_HR = "members:invite_hr"               # invite an HR user
    MEMBERS_DELETE = "members:delete"                     # delete/deactivate a member
    # Agent legal-knowledge management (§12.2/13.6) — Main Administrator only
    # under the stated baseline; HR does not receive this by default.
    AGENT_KNOWLEDGE_MANAGE = "agent:knowledge_manage"
    # Uploads
    UPLOADS_CREATE = "uploads:create"


# ── System Roles ───────────────────────────────────────────────────────────────
# DocFlow's RBAC model has exactly 4 org-level roles, per the Organization
# Dashboard & Role-Based Access Requirements report §2: Main Administrator,
# HR, Worker, Trainee. There is no custom-role builder — every organization
# gets these 4 roles, seeded identically, and membership picks one of them.
# (Platform-level `AuthUser.is_superadmin` is a separate, orthogonal concept
# — see domain/permissions.py — and always bypasses these role checks.)
SYSTEM_ROLES = {
    "admin": {
        "description": "Main Administrator — full organization-wide administrative "
        "authority. Manages org settings, departments, members, roles, templates, "
        "and the Agent's legal knowledge base. The only role that may add an HR "
        "user or delete a member account, and may review/approve/sign documents "
        "when assigned as an authorized approver.",
        "permissions": list(Permission),
    },
    "hr": {
        "description": "HR — supports the Main Administrator with day-to-day "
        "organization management. Can add Workers and Trainees, manage "
        "departments, templates, and workflow templates, but cannot add HR "
        "users, delete members, manage roles/permissions, or manage the "
        "Agent's legal knowledge base. May review/approve/sign documents when "
        "assigned as an authorized approver.",
        "permissions": [
            # Same baseline as Worker — documents, workflows, approvals,
            # chat, analytics — plus day-to-day admin support permissions.
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
            # Admin-support permissions (§2.5 matrix — HR row), deliberately
            # excludes MEMBERS_INVITE_HR, MEMBERS_DELETE, and
            # AGENT_KNOWLEDGE_MANAGE — those stay Main-Administrator-only,
            # enforced again at the router/service layer as defense in depth.
            # ADMIN_ROLES IS included, but only ever grants read access in
            # practice: GET /orgs/me/roles and GET /orgs/me/permissions (HR
            # needs the role list to populate the invite/edit-member role
            # picker) — every mutating role endpoint (create/update/
            # set-permissions/delete) unconditionally rejects ALL callers
            # regardless of this permission (DocFlow's 4 roles are fixed,
            # see organizations.py), and the Main-Administrator-only "Roles
            # & Perms" admin SCREEN is gated separately by route (App.tsx)
            # and by admin.py's `/admin/roles/catalog` (_require_main_admin).
            Permission.ADMIN_ROLES,
            Permission.ADMIN_USERS,
            Permission.ADMIN_ORGS,
            Permission.ADMIN_DOC_TYPES,
            Permission.ADMIN_WORKFLOW_TEMPLATES,
            Permission.MEMBERS_INVITE_STANDARD,
        ],
    },
    "worker": {
        "description": "Worker — document creator and approver. Uploads and submits "
        "own documents, and reviews/approves/signs documents assigned to them.",
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
    "trainee": {
        "description": "Trainee — document creator and workflow participant. "
        "Uploads and submits own documents, tracks their status, and sees "
        "permitted analytics data; never an approver or signer, and never "
        "sees the Approvals module, approval notifications, or approval APIs.",
        "permissions": [
            # Intentionally excludes: APPROVALS_DECIDE, APPROVALS_DELEGATE,
            # WORKFLOWS_ADMIN, and every admin:*/members:*/agent:* permission.
            # A trainee must never gain approval/signing authority through this
            # role's permission set — enforced again at the service layer
            # (ApprovalService.decide) as defense in depth, not just here.
            # ANALYTICS_READ IS granted (requirements §2.5: Trainee gets
            # "Yes, permitted data") — scoped to the trainee's own records,
            # same as Worker, in document_service.py::get_analytics().
            Permission.DOCUMENTS_CREATE,
            Permission.DOCUMENTS_READ,
            Permission.DOCUMENTS_EDIT,
            Permission.DOCUMENTS_SUBMIT,
            Permission.DOCUMENTS_COMMENT,
            Permission.WORKFLOWS_READ,
            Permission.ANALYTICS_READ,
            Permission.CHAT_READ,
            Permission.CHAT_SEND,
            Permission.UPLOADS_CREATE,
        ],
    },
}
