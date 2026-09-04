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
  form_data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  dept_id?: string | null;
  due_at?: string | null;
  submit_immediately?: boolean;
}

export interface UpdateDocumentPayload {
  title?: string;
  priority?: string;
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

  // ── Documents (/documents) ──────────────────────────────────────────────────
  listDocuments: (params?: DocumentFilterParams) =>
    apiClient.get<PaginatedDocumentsResponse>('/documents', {
      params: params as Record<string, string | number | boolean | undefined>,
    }),

  createDocument: (data: CreateDocumentPayload) =>
    apiClient.post<Document>('/documents', data),

  getDocument: (id: string) =>
    apiClient.get<Document>(`/documents/${id}`),

  updateDocument: (id: string, data: UpdateDocumentPayload) =>
    apiClient.patch<Document>(`/documents/${id}`, data),

  submitDocument: (id: string, changeReason?: string) =>
    apiClient.post<Document>(`/documents/${id}/submit`, { change_reason: changeReason }),

  deleteDocument: (id: string) =>
    apiClient.delete<{ message: string }>(`/documents/${id}`),

  // ── Document Versions ───────────────────────────────────────────────────────
  listVersions: (docId: string) =>
    apiClient.get<DocumentVersion[]>(`/documents/${docId}/versions`),

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
