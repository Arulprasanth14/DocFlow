/**
 * DocFlow Frontend — API Client: Template Studio (Documents module, Phase 2)
 * Mirrors Backend/app/routers/templates.py (/api/v1/templates).
 * Distinct from workflow templates (see lib/api/workflows.ts).
 */

import { apiClient } from './client';

export type TemplateScope = 'user' | 'system';
export type TemplateStatus = 'draft' | 'published' | 'archived';

/** Field definition — spec §21.2 */
export interface TemplateField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  help_text?: string | null;
  example?: string | null;
  default_value?: unknown;
  validation?: Record<string, unknown>;
  format?: string | null;
  options?: unknown[];
  if_empty_behavior?: string;
  order_index?: number;
  section?: string | null;
}

/** One blank in the content — spec §21.1 */
export interface PlaceholderOccurrence {
  field_key: string;
  node_id: string;
  order_no: number;
}

export interface TemplateSummary {
  id: string;
  org_id: string;
  owner_id: string | null;
  scope: TemplateScope;
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  icon: string | null;
  color: string | null;
  status: TemplateStatus;
  usage_count: number;
  field_count: number;
  version_no: number | null;
  is_owner: boolean;
  is_favourite: boolean;
  created_at: string;
  updated_at: string;
}

/** Gallery / My-templates query (FR-2.3 tabs + sort). */
export interface TemplateListParams {
  scope?: TemplateScope;
  category?: string;
  q?: string;
  favourites_only?: boolean;
  include_archived?: boolean;
  published_only?: boolean;
  sort?: 'recent' | 'most_used' | 'az';
}

export interface TemplateDetail extends TemplateSummary {
  version_id: string | null;
  content: Record<string, unknown>;
  page_settings: Record<string, unknown>;
  fields: TemplateField[];
  placeholders: PlaceholderOccurrence[];
}

/** One failing publish-checklist rule (FR-11.2). */
export interface PublishIssue {
  rule: string;
  field_key?: string | null;
  message: string;
}

export interface CreateTemplatePayload {
  name?: string;
  description?: string | null;
  category?: string | null;
  tags?: string[];
  icon?: string | null;
  color?: string | null;
  scope?: TemplateScope;
}

export interface UpdateTemplatePayload {
  name?: string;
  description?: string | null;
  category?: string | null;
  tags?: string[];
  icon?: string | null;
  color?: string | null;
  content?: Record<string, unknown>;
  page_settings?: Record<string, unknown>;
  fields?: TemplateField[];
  placeholders?: PlaceholderOccurrence[];
}

/** One entry in a template's version history (FR-14.8). */
export interface TemplateVersionSummary {
  id: string;
  version_no: number;
  is_published: boolean;
  /** The version new documents are currently pinned to. */
  is_current: boolean;
  field_count: number;
  published_at: string | null;
  created_at: string;
}

export const templatesApi = {
  listVersions: (templateId: string) =>
    apiClient.get<TemplateVersionSummary[]>(`/templates/${templateId}/versions`),

  /** Copies that version forward into the working draft; nothing is rewound. */
  restoreVersion: (templateId: string, versionId: string) =>
    apiClient.post<TemplateDetail>(
      `/templates/${templateId}/versions/${versionId}/restore`, {},
    ),

  list: (params?: TemplateListParams) =>
    apiClient.get<TemplateSummary[]>('/templates', {
      params: params as Record<string, string | number | boolean | undefined>,
    }),

  get: (id: string) => apiClient.get<TemplateDetail>(`/templates/${id}`),

  create: (data: CreateTemplatePayload) =>
    apiClient.post<TemplateDetail>('/templates', data),

  update: (id: string, data: UpdateTemplatePayload) =>
    apiClient.patch<TemplateDetail>(`/templates/${id}`, data),

  /** Live checklist — empty array means ready to publish. */
  publishCheck: (id: string) =>
    apiClient.get<PublishIssue[]>(`/templates/${id}/publish-check`),

  /**
   * FR-7.2 — turn plain fill-in patterns into real blanks.
   *
   * Rule-based, not AI: the same deterministic detector the document import
   * uses, so it works with AI switched off. The live body is posted (it may
   * not be autosaved yet) and comes back rewritten; the server splices the
   * placeholder nodes, so the browser never has to reimplement that.
   */
  detectBlanks: (id: string, content: Record<string, unknown>) =>
    apiClient.post<DetectBlanksResult>(`/templates/${id}/detect-blanks`, { content }),

  publish: (id: string, data?: PublishMetadata) =>
    apiClient.post<TemplateDetail>(`/templates/${id}/publish`, data ?? {}),

  duplicate: (id: string) =>
    apiClient.post<TemplateDetail>(`/templates/${id}/duplicate`),

  /** FR-5.3 — per-user favourite, stored server-side so it follows the user. */
  favourite: (id: string) => apiClient.put<TemplateDetail>(`/templates/${id}/favourite`),
  unfavourite: (id: string) => apiClient.delete<TemplateDetail>(`/templates/${id}/favourite`),

  archive: (id: string) => apiClient.post<TemplateDetail>(`/templates/${id}/archive`),
  unarchive: (id: string) => apiClient.post<TemplateDetail>(`/templates/${id}/unarchive`),

  remove: (id: string) =>
    apiClient.delete<{ message: string }>(`/templates/${id}`),
};

/** What the rule-based detector found (FR-7.2 / FR-9.3). */
export interface DetectBlanksResult {
  /** The body with placeholder nodes in place. Replaces the editor content. */
  content: Record<string, unknown>;
  found: number;
  /** Spans that could not be converted without changing the text (FR-9.4). */
  skipped: { original: string; reason: string }[];
  fields: { key: string; label: string; type: string }[];
}

/** Metadata captured on publish (FR-11.3). */
export interface PublishMetadata {
  name?: string;
  description?: string | null;
  category?: string | null;
  tags?: string[];
  icon?: string | null;
  color?: string | null;
}

export default templatesApi;
