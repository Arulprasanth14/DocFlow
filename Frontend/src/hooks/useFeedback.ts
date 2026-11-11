/**
 * Review feedback hooks — WF-REV-03..06, task P3-10.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import feedbackApi, { type AnnotationStatus } from '@/lib/api/feedback';
import { useAuthStore } from '@/store/authStore';

export const feedbackKeys = {
  all: ['feedback'] as const,
  document: (documentId: string) => ['feedback', 'document', documentId] as const,
};

/** WF-REV-03 — the approver's published comments on this document. */
export function useDocumentFeedback(documentId: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: feedbackKeys.document(documentId ?? 'none'),
    queryFn: () => feedbackApi.get(documentId!),
    enabled: isAuthenticated && !!documentId,
    // Short: the approver may reply while the owner has the page open.
    staleTime: 1000 * 20,
  });
}

/** WF-REV-05 — append a reply. There is no edit and no delete. */
export function useReplyToComment(documentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ annotationId, body }: { annotationId: string; body: string }) =>
      feedbackApi.reply(annotationId, body),
    onSuccess: () => {
      if (documentId) {
        queryClient.invalidateQueries({
          queryKey: feedbackKeys.document(documentId),
        });
      }
      // The reply raises N15, so the bell changes too.
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}

/**
 * WF-REV-06 — mark addressed / resolved / reopened.
 *
 * No optimistic update on purpose: which transitions a given caller may make
 * is decided server-side and differs between the owner and the approver, so
 * guessing here would show the owner a state change that is then taken back.
 */
export function useSetCommentStatus(documentId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      annotationId,
      status,
    }: {
      annotationId: string;
      status: AnnotationStatus;
    }) => feedbackApi.setStatus(annotationId, status),
    onSuccess: () => {
      if (documentId) {
        queryClient.invalidateQueries({
          queryKey: feedbackKeys.document(documentId),
        });
      }
    },
  });
}
