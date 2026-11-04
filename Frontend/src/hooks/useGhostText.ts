/**
 * useGhostText — the author's switch for inline AI completion (FR-10.1).
 *
 * Off by default and remembered per browser. Ghost text is the one AI feature
 * that sends text on a timer rather than on a click, so it is opt-in for the
 * same reason the import LLM pass is: nothing leaves because a default said
 * so. Turning the org AI switch off, or opting out personally, disables it
 * regardless of what is stored here.
 */
import { useCallback, useMemo, useState } from 'react';
import { useAIComplete } from '@/hooks/useAI';

const KEY = 'docflow.editor.ghostText';

export function useGhostText({
  available,
  templateId = null,
  documentId = null,
}: {
  /** The org switch and the per-user opt-out, already resolved. */
  available: boolean;
  templateId?: string | null;
  documentId?: string | null;
}) {
  const complete = useAIComplete();
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  });

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const fetchSuggestion = useCallback(async (before: string) => {
    try {
      const res = await complete(before, { templateId, documentId });
      return res.text ?? '';
    } catch {
      // Quota, outage, opt-out mid-session: all of them mean "no suggestion",
      // and none of them should interrupt someone who is typing.
      return '';
    }
  }, [complete, templateId, documentId]);

  const config = useMemo(
    () => ({ enabled: available && on, fetchSuggestion }),
    [available, on, fetchSuggestion],
  );

  return { on, toggle, config, available };
}

export default useGhostText;
