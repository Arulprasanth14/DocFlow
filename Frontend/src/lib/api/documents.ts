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
}

export interface UpdateDocumentPayload {
  title?: string;
  priority?: string;
  tags?: string[];
  form_data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  dept_id?: string | null;
  due_at?: string | null;
  change_reason?: string;
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

export const documentsApi = {
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

  submitDocument: (id: string, payload?: { change_reason?: string; workflow_template_id?: string }) =>
    apiClient.post<Document>(`/documents/${id}/submit`, payload ?? {}),

  deleteDocument: (id: string) =>
    apiClient.delete<{ message: string }>(`/documents/${id}`),

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
};

export default documentsApi;
