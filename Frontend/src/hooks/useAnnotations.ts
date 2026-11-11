/**
 * Review annotation hooks — tasks P3-5..P3-8.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import annotationsApi, { type AnchorDraft } from '@/lib/api/annotations';
import { useAuthStore } from '@/store/authStore';

export const annotationKeys = {
  version: (versionId: string) => ['annotations', 'version', versionId] as const,
  file: (versionId: string) => ['annotations', 'file', versionId] as const,
};

export function useVersionAnnotations(versionId: string | null | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: annotationKeys.version(versionId ?? 'none'),
    queryFn: () => annotationsApi.listForVersion(versionId!),
    enabled: isAuthenticated && !!versionId,
    staleTime: 1000 * 15,
  });
}

/**
 * The viewer's file. Polls while a review copy is still being prepared, and
 * stops as soon as the answer is final either way ('ready' or 'failed').
 *
 * Never cached past its lifetime: the URL is good for five minutes, so a
 * stale one from the cache would hand the viewer a link that no longer opens.
 */
export function useVersionFile(versionId: string | null | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: annotationKeys.file(versionId ?? 'none'),
    queryFn: () => annotationsApi.versionFile(versionId!),
    enabled: isAuthenticated && !!versionId,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === 'pending' ? 3000 : false,
  });
}

export function useCreateAnnotation(versionId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (anchor: AnchorDraft) => annotationsApi.create(versionId!, anchor),
    onSuccess: () => {
      if (versionId) {
        queryClient.invalidateQueries({ queryKey: annotationKeys.version(versionId) });
      }
    },
  });
}

export function useDiscardAnnotation(versionId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (annotationId: string) => annotationsApi.discard(annotationId),
    onSuccess: () => {
      if (versionId) {
        queryClient.invalidateQueries({ queryKey: annotationKeys.version(versionId) });
      }
    },
  });
}
