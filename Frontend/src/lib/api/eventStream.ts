/**
 * Server-sent events over `fetch`, not `EventSource` (FR-9.6).
 *
 * `EventSource` cannot set request headers, and this API authenticates with a
 * bearer token, so the browser's built-in SSE client is unusable here without
 * putting the token in the query string — which would land it in access logs
 * and browser history. `fetch` + a stream reader costs about forty lines and
 * keeps the token in an Authorization header, where it belongs.
 *
 * Deliberately not a React hook: the caller owns the lifecycle, because the
 * sensible thing to do when a stream dies is usually "carry on polling", and
 * that decision belongs to the caller.
 */
import { tokenStore } from './client';

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1';

export interface StreamEvent {
  /** The SSE `event:` name. Defaults to 'message' when the server omits it. */
  event: string;
  /** Parsed `data:` payload, or `null` when it was not JSON. */
  data: unknown;
}

export class EventStreamError extends Error {
  /** HTTP status, when the failure was an HTTP one. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EventStreamError';
    this.status = status;
  }
}

/**
 * Open `path` as an event stream and call `onEvent` for each frame.
 *
 * Resolves when the server closes the stream, rejects on a transport or HTTP
 * error, and resolves quietly on abort — a cancelled stream is not a failure.
 */
export async function consumeEventStream(
  path: string,
  { onEvent, signal, method = 'GET', body }: {
    onEvent: (e: StreamEvent) => void;
    signal?: AbortSignal;
    /** POST when the request carries data. Document text must never go in a
     *  query string — it would land in every access log on the way. */
    method?: 'GET' | 'POST';
    /** JSON-serialised as the request body when method is POST. */
    body?: unknown;
  },
): Promise<void> {
  const token = tokenStore.get();
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      credentials: 'include',
      headers: {
        Accept: 'text/event-stream',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    throw new EventStreamError('Could not open the progress stream');
  }

  if (!response.ok) {
    throw new EventStreamError(
      `Progress stream refused (HTTP ${response.status})`,
      response.status,
    );
  }
  if (!response.body) {
    // Some environments (older Safari, certain test shims) expose no readable
    // body. The caller's poll covers it.
    throw new EventStreamError('This browser cannot read a progress stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Normalise CRLF first: the spec
      // allows either, and a proxy may rewrite one into the other.
      const frames = buffer.replace(/\r\n/g, '\n').split('\n\n');
      // The last element is whatever has not been terminated yet.
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        let name = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          // A line starting with ':' is a comment — that is how the server's
          // keep-alive arrives, and it carries no payload.
          if (!line || line.startsWith(':')) continue;
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join('\n');
        let data: unknown = null;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw; // not JSON; hand it over as-is rather than dropping it
        }
        onEvent({ event: name, data });
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    throw new EventStreamError('The progress stream was interrupted');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

export default consumeEventStream;
