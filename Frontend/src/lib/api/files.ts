/**
 * DocFlow Frontend — API Client: Files
 * Typed calls for the presigned-upload flow:
 *   1. getUploadUrl   — POST /files/upload-url     → presigned PUT URL + storage_key
 *   2. (caller PUTs the raw file bytes directly to that URL)
 *   3. confirmUpload  — POST /files/confirm-upload  → creates the FileAsset row, returns its id
 *   4. (caller then calls documentsApi.addAttachment with that file_asset_id)
 */

import { apiClient } from './client';
import type { ApiBody, ApiResponse } from '@/types/api.generated';

/**
 * FR-1.7 — these are not retyped by hand. Each one is the shape the backend
 * actually documents for that path, read out of src/types/api.generated.ts
 * (regenerate with `npm run gen:api`). If an endpoint's body or response
 * changes, this file stops compiling instead of failing at runtime.
 */
export type UploadUrlResponse = ApiResponse<'/api/v1/files/upload-url', 'post'>;
export type ConfirmUploadResponse = ApiResponse<'/api/v1/files/confirm-upload', 'post'>;

/**
 * Resumable upload (FR-3.2) — S3/MinIO multipart, driven from the browser.
 *
 * `init` hands back one presigned PUT URL per part; the caller uploads them in
 * order and may stop at any point. `resume` asks storage which parts already
 * landed, so a reload, a dropped connection or a closed tab costs only the
 * part that was in flight. The ETags never come back through the browser —
 * the server reads them from storage at `complete` — so no CORS
 * ExposeHeaders rule is needed.
 */
export type MultipartInitResponse = ApiResponse<'/api/v1/files/multipart/init', 'post'>;

export type MultipartResumeResponse = ApiResponse<'/api/v1/files/multipart/resume', 'post'>;

/** What the caller must keep to be able to resume. Safe to persist: it names
 *  an object in the caller's own org and carries no credential. */
export type MultipartSession = ApiBody<'/api/v1/files/multipart/resume', 'post'>;

export const multipartApi = {
  init: (filename: string, mimeType: string, sizeBytes: number) =>
    apiClient.post<MultipartInitResponse>('/files/multipart/init', {
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
    }),

  resume: (session: MultipartSession) =>
    apiClient.post<MultipartResumeResponse>('/files/multipart/resume', session),

  complete: (session: MultipartSession, filename: string, mimeType: string) =>
    apiClient.post<ConfirmUploadResponse>('/files/multipart/complete', {
      ...session,
      filename,
      mime_type: mimeType,
    }),

  abort: (session: MultipartSession) =>
    apiClient.post<void>('/files/multipart/abort', {
      storage_key: session.storage_key,
      bucket: session.bucket,
      upload_id: session.upload_id,
    }),
};

export const filesApi = {
  getUploadUrl: (filename: string, mimeType: string, sizeBytes: number) =>
    apiClient.post<UploadUrlResponse>('/files/upload-url', {
      filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
    }),

  confirmUpload: (payload: {
    storage_key: string;
    bucket: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
  }) => apiClient.post<ConfirmUploadResponse>('/files/confirm-upload', payload),

  /**
   * Short-lived presigned GET URL for a stored file (FR-9.7). The URL is
   * requested when it is needed and never kept: access is re-checked on
   * every call, so losing access to a document loses access to its files.
   */
  assetDownloadUrl: (fileAssetId: string) =>
    apiClient.get<ApiResponse<'/api/v1/files/asset/{file_asset_id}/download-url', 'get'>>(
      `/files/asset/${fileAssetId}/download-url`,
    ),

  /** Resumable (multipart) upload — see multipartApi above. */
  multipart: multipartApi,
};

export default filesApi;
