/**
 * DocFlow Frontend — API Client: Chat
 *
 * REST endpoints for chat conversations and messages.
 * The WebSocket connection is handled separately by useChatWebSocket.ts.
 *
 * Auth: token is handled by apiClient (Bearer header on REST, query param for WS).
 * WS auth: the backend ws_chat.py expects ?token=JWT (query param — confirmed
 *           from router source; browser WS API does not support custom headers).
 *
 * Step 1 implementation:
 *   - listConversations  (with unread counts — populated by backend _enrich_conversation)
 *   - getConversation    (single conversation)
 *   - startConversation  (unified: kind='direct' | 'workflow_context', idempotent for wf_ctx)
 *   - getMessages        (cursor-paginated, used for initial hydration on WS connect/reconnect)
 *   - sendMessage        (REST fallback — WS is the primary path)
 *   - markRead           (called on mount + on new message while focused)
 *   - listMembers        (org member picker for "New DM" flow — no admin gate required)
 */

import { apiClient } from './client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatParticipant {
  user_id: string;
  joined_at: string;
  last_read_at: string | null;
  user_name: string | null;
  user_email: string | null;
  user_avatar_url: string | null;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'workflow_context';
  title: string | null;
  workflow_instance_id: string | null;
  approval_step_id: string | null;
  created_by: string;
  created_at: string;
  participants: ChatParticipant[];
  last_message_body: string | null;
  last_message_at: string | null;
  unread_count: number;
}

export interface ConversationListResponse {
  items: Conversation[];
  total: number;
  page: number;
  limit: number;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;                // Plain text — sanitized server-side; render as-is, no innerHTML
  attachment_ids: string[];
  created_at: string;
  edited_at: string | null;
  sender_name: string | null;
  sender_avatar_url: string | null;
}

export interface StartConversationPayload {
  /** 'direct' or 'workflow_context' */
  kind?: string;
  /** Required for kind='direct' */
  participant_user_id?: string;
  /** Required for kind='workflow_context' — creation is idempotent per step */
  approval_step_id?: string;
  title?: string;
  initial_message?: string;
}

export interface SendMessagePayload {
  body: string;
  attachment_ids?: string[];
}

export interface OrgMember {
  id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
}

export interface ConversationFilters {
  kind?: 'direct' | 'workflow_context';
  page?: number;
  limit?: number;
  [key: string]: string | number | boolean | undefined;
}

export interface MessageFilters {
  /** Cursor — fetch messages older than this message ID */
  before_id?: string;
  limit?: number;
  [key: string]: string | number | boolean | undefined;
}

// ── API ───────────────────────────────────────────────────────────────────────

export const chatApi = {
  /**
   * GET /chat/conversations — list my conversations with unread counts.
   */
  listConversations: (params?: ConversationFilters) =>
    apiClient.get<ConversationListResponse>('/chat/conversations', { params }),

  /**
   * GET /chat/conversations/{id} — get single conversation details.
   */
  getConversation: (conversationId: string) =>
    apiClient.get<Conversation>(`/chat/conversations/${conversationId}`),

  /**
   * POST /chat/conversations — start a conversation.
   * For kind='workflow_context': idempotent — same approval_step_id returns
   * the existing conversation. Returns 403 if caller can't access the document.
   */
  startConversation: (payload: StartConversationPayload) =>
    apiClient.post<Conversation>('/chat/conversations', {
      kind: payload.kind ?? 'direct',
      ...payload,
    }),

  /**
   * GET /chat/conversations/{id}/messages — cursor-paginated messages.
   * Called on initial WS connect and on every reconnect to catch up on
   * messages missed while disconnected.
   */
  getMessages: (conversationId: string, params?: MessageFilters) =>
    apiClient.get<ChatMessage[]>(`/chat/conversations/${conversationId}/messages`, { params }),

  /**
   * POST /chat/conversations/{id}/messages — REST fallback send.
   * Used when WS is unavailable. WS path (ChatService.send) is preferred.
   */
  sendMessage: (conversationId: string, payload: SendMessagePayload) =>
    apiClient.post<ChatMessage>(`/chat/conversations/${conversationId}/messages`, payload),

  /**
   * POST /chat/conversations/{id}/read — mark conversation read.
   * Called: on mount when conversation is visible, on new message while focused.
   * NOT on every render.
   */
  markRead: (conversationId: string) =>
    apiClient.post<void>(`/chat/conversations/${conversationId}/read`),

  /**
   * GET /chat/members — list org members for the "New DM" picker.
   * Lightweight — no admin:users gate. Any org member can discover peers.
   */
  listMembers: (search?: string, limit?: number) =>
    apiClient.get<OrgMember[]>('/chat/members', {
      params: { search, limit },
    }),
};

export default chatApi;
