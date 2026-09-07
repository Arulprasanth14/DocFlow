/**
 * DocFlow Frontend — TypeScript Type Definitions
 * All shared domain types. Mirror the backend Pydantic schemas.
 */

// ── Common ────────────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface ApiError {
  error: string;
  status_code: number;
  request_id?: string;
}

// ── Enums ─────────────────────────────────────────────────────────────────────

export type DocumentStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'pending_approval'
  | 'revision_requested'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'archived'
  | 'cancelled'
  | 'closed';

export type DocumentPriority = 'low' | 'normal' | 'high' | 'urgent';

export type ApprovalDecision = 'approved' | 'rejected' | 'returned' | 'delegated';

export type WorkflowStepType = 'approval' | 'parallel' | 'conditional' | 'notification' | 'auto_approve';

export type WorkflowStepStatus =
  | 'pending'
  | 'active'
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'delegated'
  | 'escalated'
  | 'skipped'
  | 'cancelled';

export type NotificationType =
  | 'approval.requested'
  | 'approval.approved'
  | 'approval.rejected'
  | 'approval.returned'
  | 'document.submitted'
  | 'document.approved'
  | 'document.rejected'
  | 'sla.warning'
  | 'sla.breach'
  | 'mention'
  | 'system';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  is_superadmin: boolean;
  org_id: string | null;
  roles: string[];
  permissions: string[];
  status: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: 'bearer';
  user: AuthUser;
  org_membership: OrgMembership | null;
}

// ── Organization ──────────────────────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  plan: string;
  status: string;
  settings?: Record<string, unknown>;
  created_at: string;
}

export interface Department {
  id: string;
  org_id: string;
  parent_id: string | null;
  name: string;
  code: string | null;
  head_user_id: string | null;
  created_at?: string;
  children?: Department[];
}

export interface Team {
  id: string;
  org_id: string;
  dept_id: string | null;
  name: string;
  created_at: string;
}

export interface Role {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
  member_count?: number;
  created_at?: string;
}

export interface OrgMembership {
  org_id: string;
  user_id: string;
  role_id: string;
  role_name: string;
  dept_id: string | null;
  team_id?: string | null;
  status: string;
  joined_at: string;
  organization: Organization;
  permissions: string[];
}

export interface OrgStats {
  member_count: number;
  department_count: number;
  team_count: number;
  role_count: number;
  active_member_count: number;
}

export interface MemberUserInfo {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  status: string;
}

export interface MemberRoleInfo {
  id: string;
  name: string;
  is_system: boolean;
}

export interface MemberDetail {
  id: string;
  org_id: string;
  user_id: string;
  role_id: string;
  dept_id: string | null;
  team_id: string | null;
  status: string;
  joined_at: string;
  user?: MemberUserInfo;
  role?: MemberRoleInfo;
}

export interface PermissionEntry {
  code: string;
  category: string;
  description?: string | null;
}

export interface PermissionCatalog {
  permissions: PermissionEntry[];
  by_category: Record<string, string[]>;
}

// ── Document Types ─────────────────────────────────────────────────────────────

export interface FormField {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'multiselect' | 'file' | 'checkbox';
  required: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  validation?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
}

export interface DocumentType {
  id: string;
  org_id: string;
  name: string;
  code: string;
  description: string | null;
  category: string | null;
  icon: string | null;
  color: string | null;
  form_schema: FormField[];
  metadata_schema?: Record<string, unknown>;
  is_active: boolean;
  retention_days?: number | null;
  created_at: string;
  updated_at?: string;
}

// ── Documents ─────────────────────────────────────────────────────────────────

export interface Document {
  id: string;
  org_id: string;
  doc_type_id: string;
  doc_type_name?: string;
  doc_type_code?: string;
  dept_id: string | null;
  public_id: string;                      // DOC-2024-00001
  title: string;
  status: DocumentStatus;
  priority: DocumentPriority;
  form_data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  submitted_by: string;
  submitter_name?: string;
  submitter_email?: string;
  submitted_at: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  attachment_count?: number;
  comment_count?: number;
  version_count?: number;

  // Expanded relations (when fetched with ?expand=true)
  doc_type?: DocumentType;
  submitter?: AuthUser;
  workflow_instance?: WorkflowInstance;
  comments?: Comment[];
  attachments?: DocumentAttachment[];
  ai_summary?: string | null;
  ai_risk?: AIRiskAssessment | null;
}

export interface PaginatedDocumentsResponse {
  items: Document[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface DocumentFilterParams {
  page?: number;
  limit?: number;
  status?: string;
  doc_type_id?: string;
  dept_id?: string;
  submitted_by?: string;
  search?: string;
  sort?: string;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version_num: number;
  title: string;
  form_data: Record<string, unknown>;
  changed_by: string;
  changer_name?: string | null;
  change_reason: string | null;
  created_at: string;
}

// ── Files ─────────────────────────────────────────────────────────────────────

export interface FileAsset {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  preview_url: string | null;
  ocr_text: string | null;
  created_at: string;
}

export interface DocumentAttachment {
  id: string;
  document_id: string;
  file_asset_id: string;
  label: string | null;
  attached_by: string;
  attacher_name?: string | null;
  filename?: string;
  mime_type?: string;
  size_bytes?: number;
  preview_url?: string | null;
  created_at: string;
  file_asset?: FileAsset;
}

export interface PresignResponse {
  mode: 'presigned' | 'direct';
  file_id: string;
  url?: string;
  storage_key?: string;
}

// ── Workflow ──────────────────────────────────────────────────────────────────

export interface WorkflowStepDefinition {
  id: string;
  type: WorkflowStepType;
  assignee_type: string;
  role_id?: string;
  user_id?: string;
  sla_hours?: number;
  requires?: 'all' | 'majority' | 'any';
  condition?: Record<string, unknown>;
  label?: string;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;               // 'approved' | 'rejected'
  field_condition?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  steps: WorkflowStepDefinition[];
  edges: WorkflowEdge[];
}

export interface WorkflowTemplate {
  id: string;
  org_id: string;
  doc_type_id: string | null;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  is_active: boolean;
  version: number;
  created_at: string;
}

export interface WorkflowStepInstance {
  id: string;
  workflow_instance_id: string;
  step_id: string;
  step_type: WorkflowStepType;
  status: WorkflowStepStatus;
  assigned_role_id: string | null;
  assigned_user_id: string | null;
  delegated_to: string | null;
  sla_hours: number | null;
  due_at: string | null;
  escalated_to: string | null;
  decision: ApprovalDecision | null;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  step_order: number;
  step_definition: WorkflowStepDefinition;

  assigned_user?: AuthUser;
  decided_by_user?: AuthUser;
  workflow_instance?: WorkflowInstance;
}

export interface WorkflowInstance {
  id: string;
  org_id: string;
  document_id: string;
  template_id: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  steps: WorkflowStepInstance[];
  document?: Document;
}

// ── Comments ──────────────────────────────────────────────────────────────────

export interface Comment {
  id: string;
  document_id: string;
  parent_id: string | null;
  body: string;
  author_id: string;
  author_name?: string;
  author_email?: string;
  author_avatar?: string | null;
  is_internal: boolean;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  author?: AuthUser;
  replies?: Comment[];
  mentions?: Array<{ user_id: string; user_name?: string | null }>;
}

// ── Notifications ─────────────────────────────────────────────────────────────

export interface Notification {
  id: string;
  org_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

// ── AI ────────────────────────────────────────────────────────────────────────

export interface AIRiskFlag {
  category: string;
  description: string;
  severity: RiskLevel;
  location?: string;
}

export interface AIRiskAssessment {
  risk_level: RiskLevel;
  flags: AIRiskFlag[];
  summary: string;
}

export interface AIChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface AIChatSession {
  id: string;
  title: string | null;
  history: AIChatMessage[];
  created_at: string;
  updated_at: string;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface DashboardStats {
  documents_submitted: number;
  documents_approved: number;
  documents_rejected: number;
  avg_approval_time_hours: number;
  sla_breach_rate: number;
  pending_approvals: number;
  trend_data: Array<{ date: string; count: number }>;
}

// ── WebSocket Events ──────────────────────────────────────────────────────────

export type WSEventType =
  | 'notification.new'
  | 'document.status_changed'
  | 'workflow.step_activated'
  | 'comment.new';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  payload: T;
}
