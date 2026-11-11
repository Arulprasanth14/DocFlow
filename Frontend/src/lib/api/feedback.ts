/**
 * Review feedback — the owner's side of the change-request loop.
 *
 * Workflow module section 5.10 (WF-REV-03..06), N15. Task P3-10.
 *
 * Drafts never appear here: the server filters them out of the query
 * (AP-ANN-05), so the client has no path by which an unpublished comment
 * could reach the screen. There is deliberately no edit or delete call —
 * after publication a comment can only be replied to and have its status
 * changed (AP-ANN-09, BR-09).
 */

import { apiClient } from './client';

export type AnnotationStatus = 'open' | 'addressed' | 'resolved';

export interface AnnotationReply {
  id: string;
  annotation_id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

export interface AnnotationThread {
  id: string;
  document_version_id: string;
  page_number: number;
  anchor_type: string;
  /** Fractions (0..1) of the unrotated page — see the annotations model. */
  rects: Array<{ x?: number; y?: number; w?: number; h?: number }>;
  selected_text: string | null;
  comment_text: string | null;
  category: string | null;
  color: string | null;
  status: AnnotationStatus;
  /** Server-derived: 'open' or 'addressed' both still count as outstanding.
   *  Not recomputed client-side — AP-APR-01 asks the same question when it
   *  warns an approver that comments are still open. */
  is_open: boolean;
  author_id: string;
  author_name: string | null;
  published_at: string | null;
  created_at: string;
  carried_from_id: string | null;
  /** AP-ANN-22: false means the anchor could not be found on this version —
   *  rendered as "Location changed", a specified outcome, not a failure. */
  relocated: boolean | null;
  replies: AnnotationReply[];
}

export interface FeedbackPageGroup {
  page_number: number;
  comments: AnnotationThread[];
}

export interface FeedbackVersionGroup {
  document_version_id: string;
  version_num: number;
  /** Earlier versions are history: replying about text that has since been
   *  rewritten helps nobody (WF-REV-12). */
  is_current: boolean;
  pages: FeedbackPageGroup[];
}

export interface DocumentFeedback {
  document_id: string;
  document_title: string | null;
  versions: FeedbackVersionGroup[];
  open_count: number;
  total_count: number;
}

export const feedbackApi = {
  /** GET /approvals/documents/{id}/feedback — grouped by version, then page. */
  get: (documentId: string) =>
    apiClient.get<DocumentFeedback>(
      `/approvals/documents/${documentId}/feedback`,
    ),

  /** POST /approvals/annotations/{id}/replies — append-only. */
  reply: (annotationId: string, body: string) =>
    apiClient.post<AnnotationReply>(
      `/approvals/annotations/${annotationId}/replies`,
      { body },
    ),

  /**
   * PATCH /approvals/annotations/{id}/status
   *
   * The owner may set 'addressed' (and take it back); only the comment's
   * author may 'resolve'. The server decides and returns 409 with the
   * permitted transitions when a caller asks for one they cannot make.
   */
  setStatus: (annotationId: string, status: AnnotationStatus) =>
    apiClient.patch<AnnotationThread>(
      `/approvals/annotations/${annotationId}/status`,
      { status },
    ),
};

export default feedbackApi;
