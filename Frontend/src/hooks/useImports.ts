/**
 * DocFlow — document import hooks (spec FR-9.6).
 *
 * Progress arrives two ways, on purpose:
 *
 *   1. A server-sent-events stream (`GET /imports/{id}/stream`), which pushes
 *      each stage change as it happens. This is what the spec asks for and
 *      what the UI feels like it should do.
 *   2. A 3-second poll, which keeps running underneath. Streams are the first
 *      thing a corporate proxy breaks — buffered, stripped, or silently held
 *      until the response ends — and "the import looks stuck forever" is a
 *      much worse failure than one extra request every three seconds.
 *
 * Both write into the same query cache, so whichever arrives first wins and
 * the UI never sees them disagree. Polling stops the moment a job is terminal,
 * so a finished job on an open screen costs nothing either way.
 */
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import importsApi, {
  type AcceptedDetection,
  type ImportJob,
  type StartImportPayload,
} from '@/lib/api/imports';
import { consumeEventStream } from '@/lib/api/eventStream';

export const importKeys = {
  detail: (id: string) => ['imports', id] as const,
};

/** States where more work is still coming. */
const RUNNING = new Set(['pending', 'extracting', 'detecting']);

export function useImportJob(jobId: string | undefined) {
  const query = useQuery({
    queryKey: importKeys.detail(jobId ?? ''),
    queryFn: () => importsApi.get(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const data = q.state.data as ImportJob | undefined;
      return data && RUNNING.has(data.status) ? 3000 : false;
    },
    staleTime: 0,
  });
  useImportProgressStream(jobId, query.data?.status);
  return query;
}

/**
 * Subscribe to the stage stream while a job is running (FR-9.6).
 *
 * A `stage` event updates the cached job in place — stage and progress are the
 * only fields it carries, and patching them avoids a request per tick. `done`
 * triggers one real refetch, because the finished job brings the converted
 * content and the detections with it, which the stream deliberately does not
 * carry: those payloads are large and belong in one response, not in an event.
 */
function useImportProgressStream(jobId: string | undefined, status: string | undefined) {
  const qc = useQueryClient();
  /** Streams are reopened after a server-side timeout; this counts attempts so
   *  a stream that fails immediately, every time, stops being retried. */
  const failures = useRef(0);

  const running = !!status && RUNNING.has(status);

  useEffect(() => {
    if (!jobId || !running || failures.current >= 3) return;
    const ac = new AbortController();
    let cancelled = false;

    const run = async () => {
      try {
        await consumeEventStream(`/imports/${jobId}/stream`, {
          signal: ac.signal,
          onEvent: ({ event, data }) => {
            if (cancelled || !data || typeof data !== 'object') return;
            const payload = data as { status?: string; stage?: string; progress?: number };
            if (event === 'stage') {
              qc.setQueryData(importKeys.detail(jobId), (prev: ImportJob | undefined) =>
                prev
                  ? {
                      ...prev,
                      status: payload.status ?? prev.status,
                      stage: payload.stage ?? prev.stage,
                      progress: payload.progress ?? prev.progress,
                    }
                  : prev);
            } else if (event === 'done') {
              // The result itself is not in the stream — fetch it properly.
              void qc.invalidateQueries({ queryKey: importKeys.detail(jobId) });
            }
            // 'timeout' needs nothing: the effect re-runs and reconnects while
            // the job is still in a running state.
          },
        });
        failures.current = 0;
      } catch {
        // Streaming is unavailable or was cut off. The poll above is already
        // keeping the UI correct, so this is not surfaced to the user.
        failures.current += 1;
      }
    };
    void run();

    return () => {
      cancelled = true;
      ac.abort();
    };
    // `status` is in the deps via `running`: when the server times a stream out
    // and the job is still running, this re-runs and opens the next one.
  }, [jobId, running, qc]);
}

export function useStartImport() {
  return useMutation({
    mutationFn: (data: StartImportPayload) => importsApi.start(data),
  });
}

export function useCancelImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => importsApi.cancel(jobId),
    onSuccess: (_d, jobId) => {
      void qc.invalidateQueries({ queryKey: importKeys.detail(jobId) });
    },
  });
}

export function useApplyImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, name, accepted }: {
      jobId: string; name: string; accepted: AcceptedDetection[];
    }) => importsApi.apply(jobId, name, accepted),
    onSuccess: (_d, { jobId }) => {
      void qc.invalidateQueries({ queryKey: importKeys.detail(jobId) });
      // A new template now exists.
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}
