/**
 * DocFlow Frontend — hooks for AI assistance (Documents module Phase 3).
 *
 * Two rules these hooks exist to enforce, so no page has to remember them:
 *
 *  1. AI DEGRADES, IT NEVER BLOCKS. `useAIAvailability` answers once per
 *     session; when it says no, callers render nothing at all rather than a
 *     button that fails. A failed availability check is also "no" — if we
 *     can't tell, we don't offer it.
 *  2. NOTHING IS APPLIED SILENTLY. `useAIDecision` posts the outcome of every
 *     suggestion, rejections included, which is what makes the audit trail
 *     honest (FR-10.4).
 */

import { useCallback } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { aiApi, HIDE_FEATURE_CODES } from '@/lib/api/ai';
import type { AIAvailability } from '@/lib/api/ai';

const AVAILABILITY_KEY = ['ai', 'availability'] as const;

export function useAIAvailability() {
  const query = useQuery<AIAvailability>({
    queryKey: AVAILABILITY_KEY,
    queryFn: () => aiApi.availability(),
    // The answer changes when quota is consumed or an admin flips a switch —
    // neither needs to be instant, and this must never be a hot path.
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });

  const data = query.data;
  return {
    ...query,
    /** True only on a definite yes. Unknown and error both mean "don't offer". */
    enabled: data?.enabled === true,
    /**
     * True when the reason is permanent for this session (switched off), as
     * opposed to a transient or quota reason worth telling the user about.
     */
    hidden:
      data != null &&
      !data.enabled &&
      data.reason_code != null &&
      HIDE_FEATURE_CODES.includes(data.reason_code),
    reason: data?.reason ?? null,
    usedToday: data?.used_today ?? 0,
    dailyQuota: data?.daily_quota ?? 0,
  };
}

export function useSuggestField() {
  return useMutation({ mutationFn: aiApi.suggestField });
}

export function useDetectBlanks() {
  return useMutation({ mutationFn: aiApi.detectBlanks });
}

export function useAIRewrite() {
  return useMutation({ mutationFn: aiApi.rewrite });
}

/** FR-10.1 — ask the assistant to write something. Never auto-applied. */
export function useAIDraft() {
  return useMutation({ mutationFn: aiApi.draft });
}

/**
 * FR-10.1 — inline completion for ghost text.
 *
 * Not a mutation hook: this is called from inside a ProseMirror plugin on
 * a timer, where React Query's lifecycle buys nothing and its retries
 * would be actively wrong — a stale suggestion is worse than none.
 */
export function useAIComplete() {
  return useCallback(
    async (before: string, ids: { templateId?: string | null; documentId?: string | null }) => {
      const res = await aiApi.complete({
        before,
        template_id: ids.templateId ?? null,
        document_id: ids.documentId ?? null,
      });
      return res;
    },
    [],
  );
}

export function useAIReview() {
  return useMutation({ mutationFn: aiApi.review });
}

/** FR-13.5 — suggested submission details. Nothing is applied automatically. */
export function useAISuggestDetails() {
  return useMutation({ mutationFn: aiApi.suggestDetails });
}

/**
 * Record accept/reject. Deliberately fire-and-forget: the user's action has
 * already happened locally, and a failure to log it must not undo their edit
 * or interrupt them with an error they can do nothing about.
 */
export function useAIDecision() {
  return useCallback((interactionId: string | null | undefined, accepted: boolean) => {
    if (!interactionId) return;
    void aiApi.recordDecision(interactionId, accepted).catch(() => {
      /* audit is best-effort from the client; the call itself is already logged */
    });
  }, []);
}
