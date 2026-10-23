/**
 * DocFlow Frontend — API Client: Files
 * Typed calls for the presigned-upload flow:
 *   1. getUploadUrl   — POST /files/upload-url     → presigned PUT URL + storage_key
 *   2. (caller PUTs the raw file bytes directly to that URL)
 *   3. confirmUpload  — POST /files/confirm-upload  → creates the FileAsset row, returns its id
 *   4. (caller then calls documentsApi.addAttachment with that file_asset_id)
 */

import { apiClient } from './client';

export interface UploadUrlResponse {
  upload_url: string;
  storage_key: string;
  bucket: string;
}

export interface ConfirmUploadResponse {
  file_asset_id: string;
}

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
};

export default filesApi;
