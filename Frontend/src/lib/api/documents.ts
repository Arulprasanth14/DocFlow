/**
 * DocFlow Frontend — API Client: Documents & Document Types
 * Typed calls for all /document-types and /documents endpoints.
 */

import { apiClient } from './client';
import type {
  DocumentType,
  Document,
  DocumentVersion,
  DocumentAttachment,
  Comment,
  FormField,
  PaginatedDocumentsResponse,
  DocumentFilterParams,
  FieldProblem,
} from '@/types';

export interface DocumentTemplate {
  id: string;
  org_id: string;
  doc_type_id: string;
  name: string;
  default_field_values: Record<string, any>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDocumentTemplatePayload {
  name: string;
  default_field_values: Record<string, any>;
}

export interface CreateDocumentTypePayload {
  name: string;
  code: string;
  description?: string;
  category?: string;
  icon?: string;
  color?: string;
  form_schema?: FormField[];
  metadata_schema?: Record<string, unknown>;
  retention_days?: number;
}

export interface UpdateDocumentTypePayload {
  name?: string;
  code?: string;
  description?: string;
  category?: string;
  icon?: string;
  color?: string;
  form_schema?: FormField[];
  metadata_schema?: Record<string, unknown>;
  is_active?: boolean;
  retention_days?: number;
}

/** Editable body of a document (spec §9 DocumentContent). */
export interface DocumentContent {
  document_id: string;
  /** Rich-text editor JSON for freeform (blank) documents. */
  content: Record<string, unknown>;
  /** Template answers by field key. */
  answers: Record<string, unknown>;
  rendered_snapshot_url: string | null;
  pdf_url: string | null;
  updated_at: string | null;
}

export interface CreateDocumentPayload {
  doc_type_id: string;
  title: string;
  priority?: string;
  tags?: string[];
  form_data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  dept_id?: string | null;
  due_at?: string | null;
  submit_immediately?: boolean;
  /** How the draft was started (spec §9). */
  source?: 'template' | 'blank' | 'upload';
  confidentiality?: string | null;
  current_step?: string | null;
  /**
   * Start from a Template Studio template. The SERVER resolves and pins the
   * template's current published version (C9) — the client never picks a
   * version id, so it cannot pin a draft or someone else's version.
   */
  template_id?: string | null;
}

/** One question from the document's pinned template version (FR-12.x). */
export interface FillField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  help_text?: string | null;
  example?: string | null;
  default_value?: unknown;
  validation?: Record<string, unknown>;
  format?: string | null;
  options?: unknown[];
  if_empty_behavior?: string;
  order_index?: number;
  section?: string | null;
}

export interface DocumentFillSchema {
  /** Null when the questions came from a template and no draft exists
   *  yet — the FR-12.1 case. */
  document_id: string | null;
  template_id: string | null;
  template_version_id: string | null;
  template_name: string | null;
  version_no: number | null;
  content: Record<string, unknown>;
  fields: FillField[];
  answers: Record<string, unknown>;
  template_deleted: boolean;
}

export interface UpdateDocumentPayload {
  title?: string;
  priority?: string;
  tags?: string[];
  form_data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  dept_id?: string | null;
  due_at?: string | null;
  confidentiality?: string | null;
  current_step?: string | null;
  change_reason?: string;
  // -- Submission details (FR-13.4) ------------------------------------
  category?: string | null;
  effective_from?: string | null;
  expires_at?: string | null;
  reminder_days_before?: number | null;
  /**
   * Detail fields to null out. An omitted field means "leave alone", so
   * clearing a date has to be said explicitly: sending expires_at: null
   * would be indistinguishable from not touching it.
   */
  clear_fields?: string[];
}

/** Someone CC'd on a document (FR-13.4). */
export interface Watcher {
  id: string;
  user_id: string;
  name: string | null;
  email: string | null;
  added_by: string;
  added_by_name: string | null;
  created_at: string;
}

/** A colleague who could be CC'd. */
export interface WatcherCandidate {
  user_id: string;
  name: string | null;
  email: string | null;
}

export interface CreateCommentPayload {
  body: string;
  parent_id?: string | null;
  is_internal?: boolean;
  mention_user_ids?: string[];
}

export interface UpdateCommentPayload {
  body?: string;
  is_resolved?: boolean;
}

export interface CreateAttachmentPayload {
  file_asset_id: string;
  label?: string;
}

// ── AI-assisted creation types (§5.4) ────────────────────────────────────────

export interface AiSuggestTypeResponse {
  suggested: { id: string; name: string; code: string } | null;
  available: { id: string; name: string; code: string }[];
}

export interface AiDraftResponse {
  /** null when called with save=false (preview only). */
  document_id: string | null;
  title: string;
  content_markdown: string;
  /** Details the AI refused to invent — the user must fill these in. */
  missing_information: string[];
  requires_review: boolean;
  used_template: boolean;
  template_id: string | null;
  template_name: string | null;
  doc_type_id: string | null;
  doc_type_name: string | null;
  /** Source files that could not be read (e.g. a scanned PDF needing OCR). */
  source_extraction_errors: string[];
  provider: string;
  model: string;
  truncated: boolean;
}

/**
 * FR-13.8 — render state of the frozen submission snapshot's PDF.
 * `checksum` is the SHA-256 of the PDF bytes; rendering is deterministic, so
 * re-rendering the same snapshot reproduces it.
 */
export interface DocumentPDFState {
  status: 'pending' | 'ready' | 'failed' | null;
  checksum: string | null;
  rendered_at: string | null;
  error: string | null;
  download_url: string | null;
  /** False when the deployment hasn't applied the PDF migration yet. */
  available: boolean;
  has_snapshot: boolean;
}

/** Wizard steps, in order. Each check includes the steps before it. */
export type SubmitStage = 'write' | 'workflow' | 'details' | 'confirm';

export interface SubmitCheckResult {
  ok: boolean;
  errors: FieldProblem[];
  /** Shown, never blocking — e.g. "you are the only approver". */
  warnings: FieldProblem[];
}

export const documentsApi = {
  /** FR-6.7 — download this document as PDF or DOCX. */
  exportDocument: (docId: string, format: 'pdf' | 'docx') =>
    apiClient.download(`/documents/${docId}/export?format=${format}`),

  getPdfState: (docId: string) =>
    apiClient.get<DocumentPDFState>(`/documents/${docId}/pdf`),

  retryPdf: (docId: string) =>
    apiClient.post<DocumentPDFState>(`/documents/${docId}/pdf/retry`, {}),

  // ── Document Types (/document-types) ────────────────────────────────────────
  listDocumentTypes: (activeOnly = true) =>
    apiClient.get<DocumentType[]>('/document-types', { params: { active_only: activeOnly } }),

  createDocumentType: (data: CreateDocumentTypePayload) =>
    apiClient.post<DocumentType>('/document-types', data),

  getDocumentType: (id: string) =>
    apiClient.get<DocumentType>(`/document-types/${id}`),

  updateDocumentType: (id: string, data: UpdateDocumentTypePayload) =>
    apiClient.patch<DocumentType>(`/document-types/${id}`, data),

  deleteDocumentType: (id: string) =>
    apiClient.delete<{ message: string }>(`/document-types/${id}`),

  createTemplate: (docTypeId: string, data: CreateDocumentTemplatePayload) =>
    apiClient.post<DocumentTemplate>('/document-types/templates', data, { params: { doc_type_id: docTypeId } }),

  // ── Documents (/documents) ──────────────────────────────────────────────────
  getAnalytics: () =>
    apiClient.get<Record<string, number>>('/documents/analytics'),
  listDocuments: (params?: DocumentFilterParams) =>
    apiClient.get<PaginatedDocumentsResponse>('/documents', {
      params: params as Record<string, string | number | boolean | undefined>,
    }),

  createDocument: (data: CreateDocumentPayload) =>
    apiClient.post<Document>('/documents', data),

  createFromTemplate: (templateId: string, data: CreateDocumentPayload) =>
    apiClient.post<Document>(`/documents/from-template/${templateId}`, data),

  // ── AI-assisted creation (§5.4) ─────────────────────────────────────────

  /**
   * POST /documents/ai/suggest-type — identify the likely document type and
   * whether a template exists, from a plain-language description.
   */
  aiSuggestType: (instructions: string) => {
    const form = new FormData();
    form.append('instructions', instructions);
    return apiClient.postForm<AiSuggestTypeResponse>(
      '/documents/ai/suggest-type',
      form,
    );
  },

  /**
   * POST /documents/ai/draft — generate a draft from instructions, optional
   * source files, and the applicable template.
   *
   * Always returns a DRAFT for review: nothing is submitted to a workflow.
   * Details the user didn't supply come back as `[TO BE COMPLETED: …]`
   * placeholders listed in `missing_information` rather than invented.
   */
  aiGenerateDraft: (input: {
    instructions: string;
    docTypeId?: string;
    templateId?: string;
    title?: string;
    save?: boolean;
    files?: File[];
  }) => {
    const form = new FormData();
    form.append('instructions', input.instructions);
    if (input.docTypeId) form.append('doc_type_id', input.docTypeId);
    if (input.templateId) form.append('template_id', input.templateId);
    if (input.title) form.append('title', input.title);
    form.append('save', String(input.save ?? true));
    (input.files ?? []).forEach((f) => form.append('files', f));
    return apiClient.postForm<AiDraftResponse>('/documents/ai/draft', form);
  },

  getDocument: (id: string) =>
    apiClient.get<Document>(`/documents/${id}`),

  updateDocument: (id: string, data: UpdateDocumentPayload) =>
    apiClient.patch<Document>(`/documents/${id}`, data),

  /**
   * Autosave a draft with optimistic locking (spec §24). Sends the version the
   * client last saw in `If-Match`; a stale value makes the server return 409
   * VERSION_CONFLICT. The response's `version` is the new value to send next.
   */
  autosaveDocument: (id: string, data: UpdateDocumentPayload, ifMatch: number) =>
    apiClient.patch<Document>(`/documents/${id}`, data, {
      headers: { 'If-Match': String(ifMatch) },
    }),

  /**
   * Submit for approval. Pass `idempotencyKey` (stable across retries of the
   * same user action) so a double-click or network retry returns the already
   * submitted document instead of a 409 (FR-13.7).
   */
  submitDocument: (
    id: string,
    payload?: { change_reason?: string; workflow_template_id?: string },
    idempotencyKey?: string,
  ) =>
    apiClient.post<Document>(`/documents/${id}/submit`, payload ?? {}, {
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    }),

  /**
   * Whether this draft may move past a wizard step, and what blocks it.
   *
   * Read-only, and the authority: the client's own mirror of these rules is
   * only there to answer instantly while typing. The submit endpoint runs
   * exactly the same checks again, so a draft that goes stale between the
   * two is still caught.
   */
  submitCheck: (
    id: string,
    body: { stage: SubmitStage; workflow_template_id?: string | null },
  ) => apiClient.post<SubmitCheckResult>(`/documents/${id}/submit-check`, body),

  deleteDocument: (id: string) =>
    apiClient.delete<{ message: string }>(`/documents/${id}`),

  // ── Document body (spec §9 DocumentContent) ─────────────────────────────────
  getContent: (docId: string) =>
    apiClient.get<DocumentContent>(`/documents/${docId}/content`),

  saveContent: (docId: string, data: { content?: Record<string, unknown>; answers?: Record<string, unknown> }) =>
    apiClient.patch<DocumentContent>(`/documents/${docId}/content`, data),

  /** Form Fill questions, from the version this document is pinned to (C9). */
  getFillSchema: (docId: string) =>
    apiClient.get<DocumentFillSchema>(`/documents/${docId}/fill-schema`),

  /**
   * FR-12.1 — the questions of a template's published version, with no
   * document behind them, so the wizard can open before a draft exists.
   */
  templateFillSchema: (templateId: string) =>
    apiClient.get<DocumentFillSchema>(`/templates/${templateId}/fill-schema`),

  /** FR-5.4 — turn this document into a private template draft. */
  saveAsTemplate: (docId: string, data: { name?: string; description?: string | null; category?: string | null }) =>
    apiClient.post<{ id: string; name: string }>(`/documents/${docId}/save-as-template`, data),

  // ── Document Versions ───────────────────────────────────────────────────────
  listVersions: (docId: string) =>
    apiClient.get<DocumentVersion[]>(`/documents/${docId}/versions`),

  restoreVersion: (docId: string, versionId: string) =>
    apiClient.post<Document>(`/documents/${docId}/versions/${versionId}/restore`),

  // ── Document Comments ───────────────────────────────────────────────────────
  listComments: (docId: string) =>
    apiClient.get<Comment[]>(`/documents/${docId}/comments`),

  addComment: (docId: string, data: CreateCommentPayload) =>
    apiClient.post<Comment>(`/documents/${docId}/comments`, data),

  updateComment: (docId: string, commentId: string, data: UpdateCommentPayload) =>
    apiClient.patch<Comment>(`/documents/${docId}/comments/${commentId}`, data),

  // ── Document Attachments ────────────────────────────────────────────────────
  listAttachments: (docId: string) =>
    apiClient.get<DocumentAttachment[]>(`/documents/${docId}/attachments`),

  addAttachment: (docId: string, data: CreateAttachmentPayload) =>
    apiClient.post<DocumentAttachment>(`/documents/${docId}/attachments`, data),

  removeAttachment: (docId: string, attId: string) =>
    apiClient.delete<{ message: string }>(`/documents/${docId}/attachments/${attId}`),

  // -- Watchers / CC (FR-13.4) -----------------------------------------------
  listWatchers: (docId: string) =>
    apiClient.get<Watcher[]>(`/documents/${docId}/watchers`),

  /**
   * Colleagues who could be CC'd. A dedicated endpoint rather than the org
   * members list, which needs admin:users - a CC picker must not require
   * widening that permission.
   */
  listWatcherCandidates: (docId: string, q?: string) =>
    apiClient.get<WatcherCandidate[]>(`/documents/${docId}/watcher-candidates`, {
      params: q ? { q } : undefined,
    }),

  addWatcher: (docId: string, userId: string) =>
    apiClient.post<Watcher>(`/documents/${docId}/watchers`, { user_id: userId }),

  removeWatcher: (docId: string, userId: string) =>
    apiClient.delete<{ message: string }>(`/documents/${docId}/watchers/${userId}`),
};

export default documentsApi;
