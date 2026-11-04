/**
 * DocFlow Frontend — API Client: AI Agent (§12)
 *
 * The API key never reaches the browser: the frontend only ever learns
 * WHETHER the Agent is configured (via /agent/status), never any credential.
 */
import { apiClient } from './client';

export interface AgentStatus {
  enabled: boolean;
  provider: string;
  chat_model: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  supports_generation: boolean;
  supports_embeddings: boolean;
  notes: string[];
  retrieval: { top_k: number; min_similarity: number };
}

export interface AgentCitation {
  number: number;
  source_id: string;
  source_title: string;
  chunk_id: string;
  chunk_index: number;
  page_number: number | null;
  section_label: string | null;
  version_label: string | null;
  effective_date: string | null;
  similarity: number;
  excerpt: string;
}

export type AnswerState =
  | 'grounded'
  | 'insufficient_evidence'
  | 'clarification_needed'
  | 'not_configured'
  | 'error';

export interface AgentAnswer {
  conversation_id: string;
  message_id: string;
  role: 'assistant';
  content: string;
  citations: AgentCitation[];
  answer_state: AnswerState;
  model: string | null;
  provider: string | null;
  retrieval: Record<string, unknown>;
  created_at: string | null;
}

export interface AgentConversationSummary {
  id: string;
  title: string | null;
  last_message_at: string | null;
  created_at: string | null;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: AgentCitation[];
  answer_state: AnswerState | null;
  feedback: 'up' | 'down' | null;
  created_at: string | null;
}

export interface AgentConversationDetail {
  id: string;
  title: string | null;
  messages: AgentMessage[];
}

export interface KnowledgeSource {
  id: string;
  title: string;
  category: string | null;
  version_label: string | null;
  revision: number;
  status:
    | 'pending'
    | 'extracting'
    | 'chunking'
    | 'embedding'
    | 'ready'
    | 'failed'
    | 'archived'
    | 'needs_reembedding';
  extraction_error: string | null;
  extracted_chars: number;
  chunk_count: number;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  embedding_provider: string | null;
  effective_date: string | null;
  review_due_at: string | null;
  indexed_at: string | null;
  archived_at: string | null;
  uploaded_by: string;
  created_at: string | null;
  is_retrievable: boolean;
}

export interface IndexHealth {
  configured: boolean;
  reason?: string;
  current_model?: string;
  current_dim?: number;
  compatible_chunks?: number;
  incompatible_groups?: { model: string | null; dim: number | null; chunks: number }[];
  needs_reembedding?: boolean;
}

export interface KnowledgeListResponse {
  items: KnowledgeSource[];
  total: number;
  index_health: IndexHealth;
}

export const agentApi = {
  getStatus: () => apiClient.get<AgentStatus>('/agent/status'),

  ask: (question: string, conversationId?: string) =>
    apiClient.post<AgentAnswer>('/agent/ask', {
      question,
      conversation_id: conversationId ?? null,
    }),

  listConversations: (limit = 30) =>
    apiClient.get<AgentConversationSummary[]>('/agent/conversations', {
      params: { limit },
    }),

  getConversation: (id: string) =>
    apiClient.get<AgentConversationDetail>(`/agent/conversations/${id}`),

  sendFeedback: (messageId: string, vote: 'up' | 'down', note?: string) =>
    apiClient.post<{ message_id: string; feedback: string }>(
      `/agent/messages/${messageId}/feedback`,
      { vote, note },
    ),

  // ── Knowledge administration (Main Administrator only) ──────────────────

  listKnowledge: (includeArchived = true) =>
    apiClient.get<KnowledgeListResponse>('/agent/knowledge', {
      params: { include_archived: includeArchived },
    }),

  /** Multipart upload — the browser sets the boundary, so no Content-Type here. */
  uploadKnowledge: (form: FormData) =>
    apiClient.postForm<KnowledgeSource>('/agent/knowledge', form),

  reembedKnowledge: (sourceId: string) =>
    apiClient.post<KnowledgeSource>(`/agent/knowledge/${sourceId}/reembed`, {}),

  archiveKnowledge: (sourceId: string, reason?: string) =>
    apiClient.post<KnowledgeSource>(
      `/agent/knowledge/${sourceId}/archive`,
      {},
      { params: { reason } },
    ),
};

export default agentApi;
