/**
 * DocFlow Frontend — useAutosave (spec §24, FR-14)
 *
 * Debounced, conflict-aware autosave for document drafts. There is never a
 * "Save draft" button (spec point 15): callers push changes with `queueChange`
 * and read `state` to render the passive save indicator.
 *
 * Behaviour (spec §24.1):
 *   - Save 1500 ms after the last change (debounce), forced at most 10 s after
 *     the first unsaved change (max-wait).
 *   - Only one request in flight; changes made during a save are coalesced.
 *   - Sends the last-seen version in `If-Match`; 409 → conflict (no silent
 *     overwrite). Other failures retry with 1/2/4/8 s backoff (max 5), then Error.
 *   - Offline → state "offline", kept locally (IndexedDB); resumes on reconnect.
 *   - Flushes on tab-hide; the IndexedDB backup covers a close mid-save.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Document } from '@/types';
import documentsApi, { type UpdateDocumentPayload } from '@/lib/api/documents';
import { ApiClientError } from '@/lib/api/client';
import { saveDraftLocal, deleteDraftLocal } from '@/lib/offline/draftCache';

export type SaveState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'offline' | 'error';

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 10000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 8000];

export interface UseAutosaveOptions {
  docId: string | null;
  /** Server version last seen for this document. */
  initialVersion: number;
  enabled?: boolean;
  /** Called after a successful save with the server's fresh document. */
  onSaved?: (doc: Document) => void;
  /** Called on a 409 — the draft changed elsewhere. */
  onConflict?: () => void;
}

export interface UseAutosaveResult {
  state: SaveState;
  lastSavedAt: Date | null;
  conflict: boolean;
  /** Merge a partial change and schedule a save. */
  queueChange: (partial: UpdateDocumentPayload) => void;
  /** Force an immediate save of anything pending. */
  flush: () => Promise<void>;
  /** Tell the hook the authoritative version (e.g. after reloading the doc). */
  setVersion: (v: number) => void;
  /** Discard pending changes and clear conflict (e.g. after "Load latest"). */
  reset: () => void;
}

export function useAutosave(opts: UseAutosaveOptions): UseAutosaveResult {
  const { docId, initialVersion, enabled = true, onSaved, onConflict } = opts;

  const [state, setState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [conflict, setConflict] = useState(false);

  const versionRef = useRef(initialVersion);
  const pendingRef = useRef<UpdateDocumentPayload | null>(null);
  const inFlightRef = useRef(false);
  const retryRef = useRef(0);
  const firstDirtyAtRef = useRef<number | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxWaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Keep callbacks current without re-subscribing effects.
  const onSavedRef = useRef(onSaved);
  const onConflictRef = useRef(onConflict);
  useEffect(() => { onSavedRef.current = onSaved; onConflictRef.current = onConflict; });

  const clearTimers = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (maxWaitTimer.current) clearTimeout(maxWaitTimer.current);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    debounceTimer.current = maxWaitTimer.current = retryTimer.current = null;
  }, []);

  const performSave = useCallback(async () => {
    if (!enabled || !docId) return;
    if (inFlightRef.current) return;              // single in-flight; coalesce
    if (!pendingRef.current) return;
    if (conflict) return;                          // blocked until resolved

    const payload = pendingRef.current;
    pendingRef.current = null;
    inFlightRef.current = true;
    if (mountedRef.current) setState('saving');

    try {
      const doc = await documentsApi.autosaveDocument(docId, payload, versionRef.current);
      versionRef.current = doc.version ?? versionRef.current + 1;
      retryRef.current = 0;
      firstDirtyAtRef.current = null;
      await deleteDraftLocal(docId);
      if (mountedRef.current) {
        setState(pendingRef.current ? 'unsaved' : 'saved');
        setLastSavedAt(new Date());
      }
      onSavedRef.current?.(doc);
    } catch (err) {
      // Re-merge the failed payload ahead of anything queued during the attempt.
      pendingRef.current = { ...payload, ...(pendingRef.current ?? {}) };

      if (err instanceof ApiClientError && err.status === 409) {
        if (mountedRef.current) { setConflict(true); setState('error'); }
        onConflictRef.current?.();
        return;
      }

      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (offline) {
        if (mountedRef.current) setState('offline');
        return; // 'online' listener resumes
      }

      if (retryRef.current < BACKOFF_MS.length) {
        const delay = BACKOFF_MS[retryRef.current];
        retryRef.current += 1;
        if (mountedRef.current) setState('unsaved');
        retryTimer.current = setTimeout(() => { void performSave(); }, delay);
      } else if (mountedRef.current) {
        setState('error');
      }
    } finally {
      inFlightRef.current = false;
      // Something queued while saving (and no conflict) → save again soon.
      if (pendingRef.current && !conflict && enabled) {
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => { void performSave(); }, DEBOUNCE_MS);
      }
    }
  }, [enabled, docId, conflict]);

  const queueChange = useCallback((partial: UpdateDocumentPayload) => {
    if (!enabled || !docId) return;
    pendingRef.current = { ...(pendingRef.current ?? {}), ...partial };
    if (mountedRef.current) setState('unsaved');

    void saveDraftLocal({
      id: docId,
      payload: pendingRef.current,
      version: versionRef.current,
      savedAt: new Date().toISOString(),
    });

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => { void performSave(); }, DEBOUNCE_MS);

    if (firstDirtyAtRef.current == null) {
      firstDirtyAtRef.current = Date.now();
      maxWaitTimer.current = setTimeout(() => { void performSave(); }, MAX_WAIT_MS);
    }
  }, [enabled, docId, performSave]);

  const flush = useCallback(async () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    await performSave();
  }, [performSave]);

  const setVersion = useCallback((v: number) => { versionRef.current = v; }, []);

  const reset = useCallback(() => {
    clearTimers();
    pendingRef.current = null;
    retryRef.current = 0;
    firstDirtyAtRef.current = null;
    setConflict(false);
    setState('idle');
  }, [clearTimers]);

  // Resume saves when connectivity returns.
  useEffect(() => {
    const onOnline = () => { if (pendingRef.current) void performSave(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [performSave]);

  // Best-effort flush when the tab is hidden/closed (IndexedDB backup covers a
  // close that races the request — authenticated PATCH rules out sendBeacon).
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden' && pendingRef.current) void performSave(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [performSave]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; clearTimers(); };
  }, [clearTimers]);

  return { state, lastSavedAt, conflict, queueChange, flush, setVersion, reset };
}

export default useAutosave;
