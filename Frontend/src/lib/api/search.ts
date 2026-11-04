/**
 * DocFlow Frontend — Unified Search API client
 *
 * Backs the Search page with real, permission-filtered backend results
 * (GET /api/v1/search). Results the signed-in user may not access are
 * filtered out server-side and never reach the client.
 */
import { apiClient } from './client';

export type SearchEntity = 'documents' | 'workflows' | 'members' | 'messages';

export interface SearchDocumentItem {
  id: string;
  type: 'document';
  title: string;
  public_id: string;
  status: string;
  document_type: string | null;
  owner_id: string;
  owner_name: string | null;
  dept_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  deep_link: string;
}

export interface SearchWorkflowItem {
  id: string;
  type: 'workflow';
  title: string;
  description: string | null;
  is_active: boolean;
  visibility: string;
  owned_by_me: boolean;
  version: number;
  created_at: string | null;
  deep_link: string;
}

export interface SearchMemberItem {
  id: string;
  type: 'member';
  title: string;
  email: string;
  role: string | null;
  department: string | null;
  avatar_url: string | null;
  deep_link: string;
}

export interface SearchMessageItem {
  id: string;
  type: 'message';
  title: string;
  conversation_id: string;
  conversation_title: string | null;
  sender_id: string;
  sender_name: string | null;
  created_at: string | null;
  deep_link: string;
}

export type SearchItem =
  | SearchDocumentItem
  | SearchWorkflowItem
  | SearchMemberItem
  | SearchMessageItem;

export interface SearchGroup<T = SearchItem> {
  items: T[];
  total: number;
}

export interface SearchResponse {
  query: string;
  entities: SearchEntity[];
  limit: number;
  offset: number;
  total: number;
  groups: {
    documents?: SearchGroup<SearchDocumentItem>;
    workflows?: SearchGroup<SearchWorkflowItem>;
    members?: SearchGroup<SearchMemberItem>;
    messages?: SearchGroup<SearchMessageItem>;
  };
}

export interface SearchParams {
  q: string;
  entities?: SearchEntity[];
  limit?: number;
  offset?: number;
  status?: string;
  doc_type_id?: string;
  dept_id?: string;
  owner_id?: string;
  date_from?: string;
  date_to?: string;
  sort?: 'relevance' | 'newest' | 'oldest' | 'title';
}

export const searchApi = {
  search: ({ entities, ...rest }: SearchParams) =>
    apiClient.get<SearchResponse>('/search', {
      params: {
        ...rest,
        entities: entities?.length ? entities.join(',') : undefined,
      },
    }),
};
