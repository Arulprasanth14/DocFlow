/**
 * DocFlow Frontend — API Client: AI assistance (Documents module Phase 3).
 *
 * No API key, model name or prompt lives in the browser — these are plain
 * calls to our own backend, which owns the provider credentials.
 *
 * Every suggestion comes back with an `interaction_id`. The UI must report the
 * outcome with `recordDecision`, on reject as well as accept: an audit trail
 * that only records acceptances would imply every suggestion was taken.
 */

import { apiClient } from './client';
import { consumeEventStream } from './eventStream';

export type Confidence = 'high' | 'medium' | 'low';
export type Severity = 'high' | 'medium' | 'low';

/** Why AI is unavailable. 'off' reasons hide the feature; the rest offer retry. */
export type AIReasonCode =
  | 'not_configured'
  | 'org_disabled'
  | 'user_disabled'
  | 'quota_exceeded'
  | 'timeout'
  | 'provider_error'
  | 'bad_reply';

export const HIDE_FEATURE_CODES: readonly AIReasonCode[] = [
  'not_configured',
  'org_disabled',
  'user_disabled',
];

export interface AIAvailability {
  enabled: boolean;
  reason_code: AIReasonCode | null;
  reason: string | null;
  used_today: number;
  daily_quota: number;
}

export interface FieldSuggestion {
  interaction_id: string;
  label: string;
  key: string;
  type: string;
  confidence: Confidence;
}

export interface DetectedBlank {
  snippet: string;
  label: string;
  key: string;
  type: string;
  confidence: Confidence;
}

export interface BlankDetection {
  interaction_id: string;
  blanks: DetectedBlank[];
  truncated: boolean;
}

export interface RewriteSuggestion {
  interaction_id: string;
  original: string;
  suggestion: string;
  note: string | null;
  confidence: Confidence;
  /** Set when accepting would delete or duplicate placeholders. Must be shown. */
  warning: string | null;
  /**
   * FR-10.5 — true when the rewrite changed the {{placeholder}} tokens. The
   * server already retried once; the suggestion is still returned so the
   * author can see what was proposed, but it must not be applied.
   */
  blocked?: boolean;
}

export interface ReviewFinding {
  severity: Severity;
  message: string;
  quote: string | null;
  confidence: Confidence;
}

export interface DocumentReview {
  interaction_id: string;
  findings: ReviewFinding[];
  truncated: boolean;
}

export const aiApi = {
  availability: () => apiClient.get<AIAvailability>('/ai/availability'),

  suggestField: (payload: {
    before: string;
    after: string;
    existing_keys?: string[];
    template_id?: string | null;
  }) => apiClient.post<FieldSuggestion>('/ai/suggest-field', payload),

  detectBlanks: (payload: { document_text: string; template_id?: string | null }) =>
    apiClient.post<BlankDetection>('/ai/detect-blanks', payload),

  rewrite: (payload: { passage: string; instruction?: string; document_id?: string | null }) =>
    apiClient.post<RewriteSuggestion>('/ai/rewrite', payload),

  /** FR-10.3 — stream rewrite text deltas via SSE using existing consumeEventStream. */
  streamRewrite: (
    payload: { passage: string; instruction?: string; document_id?: string | null },
    callbacks: {
      onDelta: (delta: string) => void;
      onDone: (result: RewriteSuggestion) => void;
      onError: (err: Error) => void;
    },
    signal?: AbortSignal,
  ) => {
    // POST: the passage is document text and must not appear in a URL.
    return consumeEventStream('/ai/rewrite/stream', {
      method: 'POST',
      body: {
        passage: payload.passage,
        instruction: payload.instruction ?? null,
        document_id: payload.document_id ?? null,
      },
      signal,
      onEvent: (e) => {
        if (e.event === 'delta' && typeof e.data === 'object' && e.data && 'delta' in e.data) {
          callbacks.onDelta(String((e.data as { delta: string }).delta));
        } else if (e.event === 'done' && typeof e.data === 'object') {
          callbacks.onDone(e.data as RewriteSuggestion);
        } else if (e.event === 'error') {
          const msg = (e.data as { error?: string })?.error || 'Streaming failed';
          callbacks.onError(new Error(msg));
        }
      },
    });
  },

  review: (payload: { document_id?: string | null; document_text?: string }) =>
    apiClient.post<DocumentReview>('/ai/review', payload),

  /**
   * FR-10.1 — write a passage to the author's instruction.
   *
   * `context` is the paragraph before the cursor and nothing more; the
   * document body is never sent. Nothing is applied until the author
   * presses Insert.
   */
  draft: (payload: {
    instruction: string;
    context?: string;
    template_id?: string | null;
    document_id?: string | null;
  }) => apiClient.post<AIDraft>('/ai/draft', payload),

  /**
   * FR-10.1 — a short continuation for inline ghost text. Only the text
   * immediately before the cursor is sent, capped server-side at 800
   * characters, and an empty `text` in the reply is a valid answer.
   */
  complete: (payload: {
    before: string;
    template_id?: string | null;
    document_id?: string | null;
  }) => apiClient.post<{ interaction_id: string; text: string }>('/ai/complete', payload),

  /** FR-13.5 — only the id is sent; the server reads the stored text. */
  suggestDetails: (payload: { document_id: string }) =>
    apiClient.post<SubmissionDetailSuggestion>('/ai/suggest-details', payload),

  recordDecision: (interactionId: string, accepted: boolean) =>
    apiClient.post<{ message: string }>(`/ai/interactions/${interactionId}/decision`, { accepted }),

  /** My own off-switch. `optOut: true` means "don't offer me AI". */
  setMyAI: (optOut: boolean) =>
    apiClient.put<AIAvailability>('/ai/settings', { ai_opt_out: optOut }),

  /** Org-wide switch (admin only). */
  setOrgAI: (enabled: boolean) =>
    apiClient.put<AIAvailability>('/ai/org-settings', { ai_enabled: enabled }),
};

export default aiApi;

/** FR-10.1 — a passage the model wrote, waiting to be inserted or discarded. */
export interface AIDraft {
  interaction_id: string;
  text: string;
  note: string | null;
  confidence: Confidence;
}

/** FR-13.5 — a proposed title / description / priority for a submission. */
export interface SubmissionDetailSuggestion {
  interaction_id: string;
  title: string | null;
  description: string | null;
  priority: string | null;
  reason: string | null;
  confidence: string;
}
