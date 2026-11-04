/**
 * DocFlow Frontend — Template Studio hooks (TanStack Query).
 * Wraps lib/api/templates.ts for the gallery, My Templates and the editor.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import templatesApi, {
  type CreateTemplatePayload,
  type PublishMetadata,
  type TemplateListParams,
  type UpdateTemplatePayload,
} from '@/lib/api/templates';
import { useAuthStore } from '@/store/authStore';

export const templateKeys = {
  all: ['templates'] as const,
  list: (params?: TemplateListParams) => ['templates', 'list', params ?? {}] as const,
  detail: (id: string) => ['templates', 'detail', id] as const,
  publishCheck: (id: string) => ['templates', id, 'publish-check'] as const,
};

export function useTemplates(params?: TemplateListParams, enabled = true) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: templateKeys.list(params),
    queryFn: () => templatesApi.list(params),
    enabled: isAuthenticated && enabled,
    staleTime: 1000 * 30,
    // Switching gallery tab/sort must not blank the grid (AC1).
    placeholderData: keepPreviousData,
  });
}

export function useTemplate(id: string | undefined) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: templateKeys.detail(id ?? ''),
    queryFn: () => templatesApi.get(id as string),
    enabled: isAuthenticated && Boolean(id),
    staleTime: 1000 * 15,
  });
}

/** Live publish checklist for the editor's publish gate (FR-11.2). */
export function usePublishCheck(id: string | undefined, enabled = true) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: templateKeys.publishCheck(id ?? ''),
    queryFn: () => templatesApi.publishCheck(id as string),
    enabled: isAuthenticated && Boolean(id) && enabled,
    staleTime: 0,
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTemplatePayload) => templatesApi.create(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates', 'list'] }); },
  });
}

export function useUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTemplatePayload }) =>
      templatesApi.update(id, data),
    onSuccess: (updated, vars) => {
      qc.setQueryData(templateKeys.detail(vars.id), updated);
      qc.invalidateQueries({ queryKey: ['templates', 'list'] });
      qc.invalidateQueries({ queryKey: templateKeys.publishCheck(vars.id) });
    },
  });
}

/** FR-7.2 — rule-based blank detection over the live editor body. */
export function useDetectTemplateBlanks() {
  return useMutation({
    mutationFn: ({ id, content }: { id: string; content: Record<string, unknown> }) =>
      templatesApi.detectBlanks(id, content),
  });
}

export function usePublishTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: PublishMetadata }) =>
      templatesApi.publish(id, data),
    onSuccess: (updated, vars) => {
      qc.setQueryData(templateKeys.detail(vars.id), updated);
      qc.invalidateQueries({ queryKey: ['templates', 'list'] });
      qc.invalidateQueries({ queryKey: templateKeys.publishCheck(vars.id) });
    },
  });
}

export function useDuplicateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => templatesApi.duplicate(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates', 'list'] }); },
  });
}

/** FR-5.3 favourite toggle — optimistic so the star responds instantly. */
export function useToggleTemplateFavourite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      (on ? templatesApi.favourite(id) : templatesApi.unfavourite(id)),
    onSuccess: (updated, vars) => {
      qc.setQueryData(templateKeys.detail(vars.id), updated);
      qc.invalidateQueries({ queryKey: ['templates', 'list'] });
    },
  });
}

export function useArchiveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      (archived ? templatesApi.archive(id) : templatesApi.unarchive(id)),
    onSuccess: (updated, vars) => {
      qc.setQueryData(templateKeys.detail(vars.id), updated);
      qc.invalidateQueries({ queryKey: ['templates', 'list'] });
    },
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => templatesApi.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates', 'list'] }); },
  });
}


/** FR-14.8 — a template's version history. */
export function useTemplateVersions(templateId: string | undefined) {
  return useQuery({
    queryKey: ['templates', templateId, 'versions'],
    queryFn: () => templatesApi.listVersions(templateId!),
    enabled: !!templateId,
    staleTime: 1000 * 30,
  });
}

export function useRestoreTemplateVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, versionId }: { templateId: string; versionId: string }) =>
      templatesApi.restoreVersion(templateId, versionId),
    onSuccess: (_data, { templateId }) => {
      // The draft content changed under the editor, so both the detail and
      // the history have to be refetched.
      void qc.invalidateQueries({ queryKey: ['templates', templateId] });
    },
  });
}
