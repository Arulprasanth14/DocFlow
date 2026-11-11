/**
 * Review annotations — the approver's side. Section 6.5, tasks P3-5..P3-8.
 *
 * An annotation is always created as a draft and autosaved through `update`;
 * it reaches the owner only when the approver requests changes. There is no
 * call that publishes one directly.
 */
import { apiClient } from './client';
import type { AnnotationThread } from './feedback';

/** A fraction (0..1) of the UNROTATED page. Never pixels. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnchorDraft {
  anchor_type: 'text' | 'area';
  page_number: number;
  rects: NormRect[];
  selected_text?: string | null;
  text_prefix?: string | null;
  text_suffix?: string | null;
}

export interface VersionAnnotations {
  document_version_id: string;
  annotations: (AnnotationThread | DraftThread)[];
  draft_count: number;
  open_count: number;
}

/** Same shape as a published thread, with the one extra status. */
export type DraftThread = Omit<AnnotationThread, 'status'> & { status: 'draft' };
export type AnyThread = AnnotationThread | DraftThread;

export interface VersionFile {
  document_version_id: string;
  /** 'ready' | 'pending' | 'failed' */
  status: string;
  url: string | null;
  mime_type: string | null;
  filename: string | null;
  page_count: number | null;
  expires_in: number | null;
  message: string | null;
  version_num: number | null;
}

export const annotationsApi = {
  /** Published comments plus MY drafts. Nobody else's drafts, and no count
   *  of them either (AP-ANN-05). */
  listForVersion: (versionId: string) =>
    apiClient.get<VersionAnnotations>(
      `/approvals/document-versions/${versionId}/annotations`,
    ),

  create: (versionId: string, anchor: AnchorDraft, commentText?: string) =>
    apiClient.post<DraftThread>('/approvals/annotations', {
      document_version_id: versionId,
      ...anchor,
      comment_text: commentText ?? null,
    }),

  /** The autosave. 409 once the comment has been published. */
  update: (annotationId: string, patch: { comment_text?: string | null }) =>
    apiClient.patch<DraftThread>(`/approvals/annotations/${annotationId}`, patch),

  discard: (annotationId: string) =>
    apiClient.delete<{ status: string }>(`/approvals/annotations/${annotationId}`),

  /** A short-lived (<= 5 min) inline URL, minted per request (AP-VWR-04). */
  versionFile: (versionId: string) =>
    apiClient.get<VersionFile>(`/approvals/document-versions/${versionId}/file`),
};

export default annotationsApi;
