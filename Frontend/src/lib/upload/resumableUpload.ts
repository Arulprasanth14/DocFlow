/**
 * Resumable upload driver (FR-3.2).
 *
 * Splits a file into parts, PUTs each one to its presigned URL, and keeps just
 * enough in localStorage to pick the same upload up again later: the upload id
 * and the storage key. Storage itself remembers which parts arrived, so
 * resuming is a question put to the server (`/files/multipart/resume`) rather
 * than bookkeeping we have to keep accurate across reloads.
 *
 * What this survives:
 *   · a dropped connection      — the part in flight is retried, then paused
 *   · an explicit pause         — nothing is discarded; `resume` continues
 *   · a page reload or new tab  — the session is found by file fingerprint
 *   · a part that fails twice   — retried with backoff before giving up
 *
 * What it does not do: upload parts in parallel. Sequential keeps the progress
 * bar honest and the memory flat, and the files in scope here are at most
 * 50 MB, where concurrency would save little.
 *
 * Small files never come through here — see RESUMABLE_MIN_BYTES — so the
 * ordinary single-PUT path is completely unaffected.
 */
import filesApi, {
  type ConfirmUploadResponse,
  type MultipartSession,
} from '@/lib/api/files';

/** Must match MULTIPART_MIN_BYTES / MULTIPART_PART_SIZE in core/storage.py. */
export const RESUMABLE_MIN_BYTES = 8 * 1024 * 1024;

const SESSION_KEY = 'docflow.upload.sessions.v1';
/** How long a saved session is offered for resume. Storage expires unfinished
 *  multipart uploads on its own schedule; a day is well inside any of them. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PART_ATTEMPTS = 3;

type SessionStore = Record<string, { session: MultipartSession; savedAt: number }>;

/**
 * Identifies a file well enough to match a saved session. Name + size +
 * mtime is what every browser exposes without reading the bytes; a false
 * match would need a file of identical name, byte length and timestamp, and
 * the server still verifies the assembled size before completing.
 */
export function fileFingerprint(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function readStore(): SessionStore {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as SessionStore) : {};
  } catch {
    return {}; // private mode, blocked storage, or corrupt JSON
  }
}

function writeStore(store: SessionStore): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(store));
  } catch {
    /* Resume is a convenience; losing it must not fail the upload. */
  }
}

export function loadSession(fingerprint: string): MultipartSession | null {
  const store = readStore();
  const entry = store[fingerprint];
  if (!entry) return null;
  if (Date.now() - entry.savedAt > SESSION_TTL_MS) {
    clearSession(fingerprint);
    return null;
  }
  return entry.session;
}

export function saveSession(fingerprint: string, session: MultipartSession): void {
  const store = readStore();
  // Drop anything stale while we are here, so the key cannot grow forever.
  for (const [k, v] of Object.entries(store)) {
    if (Date.now() - v.savedAt > SESSION_TTL_MS) delete store[k];
  }
  store[fingerprint] = { session, savedAt: Date.now() };
  writeStore(store);
}

export function clearSession(fingerprint: string): void {
  const store = readStore();
  if (!(fingerprint in store)) return;
  delete store[fingerprint];
  writeStore(store);
}

/** True when a saved, resumable session exists for this file. */
export function hasResumableSession(file: File): boolean {
  return file.size >= RESUMABLE_MIN_BYTES && loadSession(fileFingerprint(file)) !== null;
}

function putPart(
  url: string,
  blob: Blob,
  onLoaded: (bytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // No Content-Type: the part URL is signed without one, and setting a
    // header that was not signed fails the signature check.
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onLoaded(e.loaded); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve()
      : reject(new Error(`Part upload failed (HTTP ${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.ontimeout = () => reject(new Error('The upload timed out'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort);
    xhr.send(blob);
  });
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export interface ResumableHandle {
  /** Fraction 0..1 of the whole file, counting parts already in storage. */
  onProgress?: (fraction: number) => void;
  /** Called once the plan is known, so the UI can say "part 3 of 7". */
  onParts?: (info: { total: number; alreadyUploaded: number }) => void;
  /** Aborts the part in flight. The session is kept, so this is a pause. */
  signal: AbortSignal;
}

/**
 * Upload `file` resumably and return the server's confirm response — the same
 * shape, with the same honest scan labels, as a single-PUT upload.
 *
 * Throws AbortError when the signal fires. The saved session is left in place
 * in that case, which is what makes the next call resume instead of restart.
 */
export async function uploadResumable(
  file: File,
  { onProgress, onParts, signal }: ResumableHandle,
): Promise<ConfirmUploadResponse> {
  const fingerprint = fileFingerprint(file);

  let session: MultipartSession | null = loadSession(fingerprint);
  // Defaults are placeholders: one of the two branches below always sets
  // all three from the server's answer before they are read.
  let partSize = RESUMABLE_MIN_BYTES;
  let partCount = 1;
  let partUrls: string[] = [];
  let uploaded = new Set<number>();

  if (session) {
    try {
      const res = await filesApi.multipart.resume(session);
      partSize = res.part_size;
      partCount = res.part_count;
      partUrls = res.part_urls;
      uploaded = new Set(res.uploaded_parts);
    } catch {
      // 410 (no longer resumable) or anything else: forget it and start over
      // rather than leave the user stuck on a session they cannot finish.
      clearSession(fingerprint);
      session = null;
    }
  }

  if (!session) {
    const init = await filesApi.multipart.init(file.name, file.type, file.size);
    session = {
      upload_id: init.upload_id,
      storage_key: init.storage_key,
      bucket: init.bucket,
      size_bytes: file.size,
    };
    partSize = init.part_size;
    partCount = init.part_count;
    partUrls = init.part_urls;
    saveSession(fingerprint, session);
  }

  const active: MultipartSession = session;

  onParts?.({ total: partCount, alreadyUploaded: uploaded.size });

  // Bytes that storage already holds count as progress — resuming a 90%
  // upload must not show 0%.
  let doneBytes = [...uploaded].reduce(
    (sum, n) => sum + Math.min(partSize, file.size - (n - 1) * partSize),
    0,
  );
  onProgress?.(Math.min(1, doneBytes / file.size));

  for (let part = 1; part <= partCount; part += 1) {
    if (uploaded.has(part)) continue;
    const from = (part - 1) * partSize;
    const blob = file.slice(from, Math.min(from + partSize, file.size));

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt += 1) {
      try {
        await putPart(
          partUrls[part - 1],
          blob,
          (loaded) => onProgress?.(Math.min(1, (doneBytes + loaded) / file.size)),
          signal,
        );
        lastError = null;
        break;
      } catch (err) {
        if (isAbort(err)) throw err;
        lastError = err;
        if (attempt < PART_ATTEMPTS) {
          // 0.6s, 1.8s — long enough for a blip, short enough not to look stuck.
          await wait(600 * Math.pow(3, attempt - 1), signal);
        }
      }
    }
    if (lastError) throw lastError instanceof Error ? lastError : new Error('Upload failed');

    doneBytes += blob.size;
    onProgress?.(Math.min(1, doneBytes / file.size));
  }

  const confirmed = await filesApi.multipart.complete(active, file.name, file.type);
  // Only now: a kept session would otherwise offer to resume a finished upload.
  clearSession(fingerprint);
  return confirmed;
}

/** Give up on a file for good: discard the parts server-side and forget it. */
export async function discardResumable(file: File): Promise<void> {
  const fingerprint = fileFingerprint(file);
  const session = loadSession(fingerprint);
  clearSession(fingerprint);
  if (!session) return;
  try {
    await filesApi.multipart.abort(session);
  } catch {
    /* Best effort — storage expires abandoned uploads on its own. */
  }
}
