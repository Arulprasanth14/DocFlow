"""
DocFlow — Model Registry
Import all models here so Alembic can discover them for autogeneration.
Also re-exports Base and engine for migration scripts.
"""
from app.database import Base  # noqa: F401

# Import all models in dependency order (FK targets before FK sources)
from app.models.base import BaseModel  # noqa: F401

# ── Identity & Access ──────────────────────────────────────────────────────────
from app.models.user import User, Session  # noqa: F401

# ── Organizational Structure ───────────────────────────────────────────────────
from app.models.organization import (  # noqa: F401
    Organization,
    Department,
    Team,
    Role,
    Permission,
    RolePermission,
    OrganizationMember,
)

# ── Documents & Versioning ─────────────────────────────────────────────────────
from app.models.document import (  # noqa: F401
    DocumentType,
    Document,
    DocumentVersion,
    FileAsset,
    DocumentAttachment,
    Comment,
    Mention,
)

# ── Workflow Engine (Template + Execution + Approvals) ─────────────────────────
from app.models.workflow import (  # noqa: F401
    # Template layer
    WorkflowTemplate,
    WorkflowStage,
    StageApproverRule,
    WorkflowStageCondition,
    # Execution layer
    WorkflowInstance,
    ApprovalStep,
    ESignature,
    Delegation,
    # Legacy (preserved for backward compatibility)
    WorkflowStepInstance,
    ApprovalDecisionRecord,
)

# ── Messaging & Chat ───────────────────────────────────────────────────────────
from app.models.chat import (  # noqa: F401
    Conversation,
    ConversationParticipant,
    ChatMessage,
)

# ── SLA Tracking ───────────────────────────────────────────────────────────────
from app.models.sla import SLAEvent  # noqa: F401

# ── Notifications ──────────────────────────────────────────────────────────────
from app.models.notification import Notification  # noqa: F401

# ── Audit & Observability ──────────────────────────────────────────────────────
from app.models.audit import AuditLog  # noqa: F401

# ── AI / ML Extensions ────────────────────────────────────────────────────────
from app.models.ai import DocumentEmbedding, AIChatSession, AIProcessingLog  # noqa: F401


__all__ = [
    # Base
    "Base",
    "BaseModel",
    # Identity
    "User",
    "Session",
    # Organization
    "Organization",
    "Department",
    "Team",
    "Role",
    "Permission",
    "RolePermission",
    "OrganizationMember",
    # Documents
    "DocumentType",
    "Document",
    "DocumentVersion",
    "FileAsset",
    "DocumentAttachment",
    "Comment",
    "Mention",
    # Workflow templates
    "WorkflowTemplate",
    "WorkflowStage",
    "StageApproverRule",
    "WorkflowStageCondition",
    # Workflow execution
    "WorkflowInstance",
    "ApprovalStep",
    "ESignature",
    "Delegation",
    # Legacy
    "WorkflowStepInstance",
    "ApprovalDecisionRecord",
    # Chat
    "Conversation",
    "ConversationParticipant",
    "ChatMessage",
    # SLA
    "SLAEvent",
    # Notifications & Audit
    "Notification",
    "AuditLog",
    # AI
    "DocumentEmbedding",
    "AIChatSession",
    "AIProcessingLog",
]
