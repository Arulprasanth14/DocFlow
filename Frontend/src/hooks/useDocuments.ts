/**
 * DocFlow Frontend — Documents & Document Types Hooks (TanStack Query)
 * Queries and mutations for document types, documents, versions, comments, and attachments.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import documentsApi, {
  type CreateDocumentTypePayload,
  type UpdateDocumentTypePayload,
  type CreateDocumentPayload,
  type UpdateDocumentPayload,
  type CreateCommentPayload,
  type UpdateCommentPayload,
  type CreateAttachmentPayload,
} from '@/lib/api/documents';
import filesApi from '@/lib/api/files';
import type { DocumentFilterParams } from '@/types';
import { useAuthStore } from '@/store/authStore';

// ── Query Keys ─────────────────────────────────────────────────────────────────
export const documentKeys = {
  types: (activeOnly?: boolean) => ['documentTypes', { activeOnly }] as const,
  type: (id: string) => ['documentTypes', id] as const,
  list: (params?: DocumentFilterParams) => ['documents', 'list', params] as const,
  detail: (id: string) => ['documents', 'detail', id] as const,
  versions: (id: string) => ['documents', id, 'versions'] as const,
  comments: (id: string) => ['documents', id, 'comments'] as const,
  attachments: (id: string) => ['documents', id, 'attachments'] as const,
};

// ── Document Types Queries & Mutations ────────────────────────────────────────
export function useDocumentTypes(activeOnly = true) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: documentKeys.types(activeOnly),
    queryFn: () => documentsApi.listDocumentTypes(activeOnly),
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 5,
  });
}

export function useDocumentType(id: string) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: documentKeys.type(id),
    queryFn: () => documentsApi.getDocumentType(id),
    enabled: isAuthenticated && Boolean(id),
    staleTime: 1000 * 60 * 5,
  });
}

export function useCreateDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDocumentTypePayload) => documentsApi.createDocumentType(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documentTypes'] });
    },
  });
}

export function useUpdateDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDocumentTypePayload }) =>
      documentsApi.updateDocumentType(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['documentTypes'] });
      queryClient.invalidateQueries({ queryKey: documentKeys.type(variables.id) });
    },
  });
}

export function useDeleteDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => documentsApi.deleteDocumentType(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documentTypes'] });
    },
  });
}

// ── Documents Queries & Mutations ─────────────────────────────────────────────
export function useDocuments(params?: DocumentFilterParams) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: documentKeys.list(params),
    queryFn: () => documentsApi.listDocuments(params),
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
  });
}

export function useDocument(id: string) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: documentKeys.detail(id),
    queryFn: () => documentsApi.getDocument(id),
    enabled: isAuthenticated && Boolean(id),
    staleTime: 1000 * 15,
  });
}

export function useCreateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDocumentPayload) => documentsApi.createDocument(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', 'list'] });
    },
  });
}

export function useUpdateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDocumentPayload }) =>
      documentsApi.updateDocument(id, data),
    onSuccess: (updated, variables) => {
      queryClient.invalidateQueries({ queryKey: ['documents', 'list'] });
      queryClient.setQueryData(documentKeys.detail(variables.id), updated);
      queryClient.invalidateQueries({ queryKey: documentKeys.versions(variables.id) });
    },
  });
}

export function useSubmitDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload?: { change_reason?: string; workflow_template_id?: string } }) =>
      documentsApi.submitDocument(id, payload),
    onSuccess: (updated, variables) => {
      queryClient.invalidateQueries({ queryKey: ['documents', 'list'] });
      queryClient.setQueryData(documentKeys.detail(variables.id), updated);
      queryClient.invalidateQueries({ queryKey: documentKeys.versions(variables.id) });
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => documentsApi.deleteDocument(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', 'list'] });
    },
  });
}

// ── Document Versions ─────────────────────────────────────────────────────────
export function useDocumentVersions(docId: string) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: documentKeys.versions(docId),
    queryFn: () => documentsApi.listVersions(docId),
    enabled: isAuthenticated && Boolean(docId),
    staleTime: 1000 * 30,
  });
}

export function useRestoreDocumentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, versionId }: { docId: string; versionId: string }) =>
      documentsApi.restoreVersion(docId, versionId),
    onSuccess: (updated, variables) => {
      queryClient.invalidateQueries({ queryKey: ['documents', 'list'] });
      queryClient.setQueryData(documentKeys.detail(variables.docId), updated);
      queryClient.invalidateQueries({ queryKey: documentKeys.versions(variables.docId) });
    },
  });
}

// ── Document Comments ─────────────────────────────────────────────────────────
export function useDocumentComments(docId: string) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: documentKeys.comments(docId),
    queryFn: () => documentsApi.listComments(docId),
    enabled: isAuthenticated && Boolean(docId),
    staleTime: 1000 * 15,
  });
}

export function useAddDocumentComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, data }: { docId: string; data: CreateCommentPayload }) =>
      documentsApi.addComment(docId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.comments(variables.docId) });
      queryClient.invalidateQueries({ queryKey: documentKeys.detail(variables.docId) });
    },
  });
}

export function useUpdateDocumentComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, commentId, data }: { docId: string; commentId: string; data: UpdateCommentPayload }) =>
      documentsApi.updateComment(docId, commentId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.comments(variables.docId) });
    },
  });
}

// ── Document Attachments ──────────────────────────────────────────────────────
export function useDocumentAttachments(docId: string) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: documentKeys.attachments(docId),
    queryFn: () => documentsApi.listAttachments(docId),
    enabled: isAuthenticated && Boolean(docId),
    staleTime: 1000 * 30,
  });
}

export function useAddDocumentAttachment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, data }: { docId: string; data: CreateAttachmentPayload }) =>
      documentsApi.addAttachment(docId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.attachments(variables.docId) });
      queryClient.invalidateQueries({ queryKey: documentKeys.detail(variables.docId) });
    },
  });
}

export function useRemoveDocumentAttachment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, attId }: { docId: string; attId: string }) =>
      documentsApi.removeAttachment(docId, attId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: documentKeys.attachments(variables.docId) });
      queryClient.invalidateQueries({ queryKey: documentKeys.detail(variables.docId) });
    },
  });
}

/**
 * Upload a raw File: presigned URL → direct PUT to storage → confirm → file_asset_id.
 * The file bytes never pass through our own backend. Returns the file_asset_id,
 * which the caller then attaches to a document via useAddDocumentAttachment.
 */
export function useUploadFile() {
  return useMutation({
    mutationFn: async (file: File): Promise<string> => {
      const { upload_url, storage_key, bucket } = await filesApi.getUploadUrl(
        file.name,
        file.type,
        file.size,
      );

      const putResponse = await fetch(upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putResponse.ok) {
        throw new Error(`File upload to storage failed (HTTP ${putResponse.status})`);
      }

      const { file_asset_id } = await filesApi.confirmUpload({
        storage_key,
        bucket,
        filename: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      });
      return file_asset_id;
    },
  });
}
