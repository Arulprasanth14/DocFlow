/**
 * DocFlow Frontend — API Client
 * Typed fetch wrapper with:
 * - Auth header injection via Firebase ID token (auto-refreshed by Firebase SDK)
 * - Automatic token force-refresh on 401, then one retry
 * - Sign-out on persistent 401 (token irrecoverably expired)
 * - Consistent error normalization
 *
 * Token flow:
 *   1. tokenStore holds the current Firebase ID token (set by AuthProvider on
 *      onAuthStateChanged + after forced refresh).
 *   2. On every request, we attach the cached token from tokenStore.
 *   3. On 401: call getFirebaseUser().getIdToken(true) to force-refresh from
 *      Firebase, update tokenStore, retry once.
 *   4. On second 401: call Firebase signOut → triggers onAuthStateChanged →
 *      AuthProvider clears state → ProtectedRoute redirects to /login.
 */

import type { ApiError, FieldProblem } from '@/types';

const BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1';

export class ApiClientError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly requestId?: string;
  /**
   * Per-field breakdown of a 422, when the server could attribute the
   * failure. Empty for every other error, so callers can check `.length`
   * rather than the status code.
   */
  readonly fields: FieldProblem[];

  constructor(status: number, detail: string, requestId?: string, fields?: FieldProblem[]) {
    super(detail);
    this.name = 'ApiClientError';
    this.status = status;
    this.detail = detail;
    this.requestId = requestId;
    this.fields = fields ?? [];
  }
}

// ── Token Cache ───────────────────────────────────────────────────────────────
// Stores the most recently obtained Firebase ID token in memory (XSS-resistant).
// AuthProvider updates this on every onAuthStateChanged callback.
// On 401, the client force-refreshes directly from Firebase and updates this.
let _accessToken: string | null = null;

export const tokenStore = {
  get: () => _accessToken,
  set: (token: string | null) => { _accessToken = token; },
  clear: () => { _accessToken = null; },
};

// ── Core Fetch ────────────────────────────────────────────────────────────────

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
  skipAuth?: boolean;
  _isRetry?: boolean;   // internal: prevent infinite retry loops
}

async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { params, skipAuth, _isRetry, ...fetchOptions } = options;

  // Build URL with query params
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  // Build headers.
  // FormData bodies must NOT carry an explicit Content-Type: the browser has
  // to set it itself so it can include the multipart boundary. Forcing
  // application/json here (as this did unconditionally) makes every file
  // upload fail to parse server-side.
  const isFormData =
    typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(fetchOptions.headers as Record<string, string>),
  };

  const token = tokenStore.get();
  if (token && !skipAuth) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), {
    ...fetchOptions,
    headers,
    // The backend sets the DocFlow refresh token as an HttpOnly cookie
    // (POST /auth/firebase-login, /auth/login, /auth/refresh).
    // In development, VITE_API_URL points to the Vite proxy (/api/v1) which then 
    // proxies to the backend. This ensures the request is same-origin so the 
    // browser will send the HttpOnly Strict cookie. credentials: 'include' is required.
    credentials: 'include',
  });

  // Handle 401 — try refreshing the DocFlow access token once, then give up
  if (response.status === 401 && !skipAuth && !_isRetry) {
    const newToken = await tryRefreshDocFlowToken();
    if (newToken) {
      // Retry the original request with the new token
      headers['Authorization'] = `Bearer ${newToken}`;
      const retryResponse = await fetch(url.toString(), {
        ...fetchOptions,
        headers,
        credentials: 'include',
      });
      return parseResponse<T>(retryResponse);
    }
    // Force-refresh failed → sign out (triggers onAuthStateChanged → clear state)
    await triggerFirebaseSignOut();
    throw new ApiClientError(401, 'Session expired. Please sign in again.');
  }

  return parseResponse<T>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const requestId = response.headers.get('X-Request-ID') ?? undefined;

  if (!response.ok) {
    let errorData: ApiError;
    try {
      errorData = await response.json();
    } catch {
      errorData = { error: response.statusText, status_code: response.status };
    }
    throw new ApiClientError(response.status, errorData.error, requestId, errorData.fields);
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Refresh the DocFlow access token using the HttpOnly refresh-token cookie
 * (POST /auth/refresh). tokenStore holds a DocFlow-issued JWT, not a raw
 * Firebase ID token, so refreshing it means calling our own /auth/refresh —
 * re-fetching a Firebase token would just produce another token the backend
 * can't verify (see AuthContext.handleUserSignedIn for the initial exchange).
 * Returns the new access token string on success, null on failure.
 */
async function tryRefreshDocFlowToken(): Promise<string | null> {
  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { access_token: string };
    tokenStore.set(data.access_token);
    return data.access_token;
  } catch {
    return null;
  }
}

/**
 * Sign out from Firebase. Triggers onAuthStateChanged → AuthProvider clears
 * all state → ProtectedRoute redirects to /login.
 */
async function triggerFirebaseSignOut(): Promise<void> {
  try {
    const { getFirebaseAuth } = await import('@/lib/auth/firebase');
    const { signOut } = await import('firebase/auth');
    await signOut(getFirebaseAuth());
  } catch {
    // Best effort — if this fails the UI will still clear on next navigation
    tokenStore.clear();
    window.dispatchEvent(new CustomEvent('auth:logout'));
  }
}

// ── HTTP Methods ──────────────────────────────────────────────────────────────

export const apiClient = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    }),

  /** Multipart POST — pass a FormData; the browser sets the boundary. */
  postForm: <T>(path: string, form: FormData, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body: form }),

  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    }),

  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    }),

  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }),

  /**
   * Download a file the API returns as bytes (document export, FR-6.7).
   *
   * Goes through fetch with the Authorization header rather than putting the
   * URL in an <a href>: a bare link carries no token, so the browser would
   * get a 401 and show it as a broken download. Returns the blob and the
   * filename the server asked for in Content-Disposition.
   */
  download: async (path: string): Promise<{ blob: Blob; filename: string }> => {
    const url = new URL(`${BASE_URL}${path}`, window.location.origin);
    const token = tokenStore.get();
    const response = await fetch(url.toString(), {
      method: 'GET',
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      let detail = `Download failed (HTTP ${response.status})`;
      try {
        const body = await response.json();
        detail = body?.error ?? detail;
      } catch {
        /* a non-JSON error body is not worth surfacing verbatim */
      }
      throw new ApiClientError(response.status, detail);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = /filename="?([^"]+)"?/i.exec(disposition);
    return { blob: await response.blob(), filename: match?.[1] ?? 'document' };
  },
};

/** Hand a fetched blob to the browser as a save dialog. */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking immediately can cancel the download
  // in some browsers before it has started reading the object URL.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export default apiClient;
