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

import type { ApiError } from '@/types';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000/api/v1';

export class ApiClientError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly requestId?: string;

  constructor(status: number, detail: string, requestId?: string) {
    super(detail);
    this.name = 'ApiClientError';
    this.status = status;
    this.detail = detail;
    this.requestId = requestId;
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
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string>),
  };

  const token = tokenStore.get();
  if (token && !skipAuth) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), {
    ...fetchOptions,
    headers,
  });

  // Handle 401 — try Firebase force-refresh once, then give up
  if (response.status === 401 && !skipAuth && !_isRetry) {
    const newToken = await tryFirebaseForceRefresh();
    if (newToken) {
      // Retry the original request with the new token
      headers['Authorization'] = `Bearer ${newToken}`;
      const retryResponse = await fetch(url.toString(), {
        ...fetchOptions,
        headers,
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
    throw new ApiClientError(response.status, errorData.error, requestId);
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Force-refresh the Firebase ID token and update tokenStore.
 * Returns the new token string on success, null on failure.
 */
async function tryFirebaseForceRefresh(): Promise<string | null> {
  try {
    // Lazily import to avoid circular deps — firebase.ts imports from here indirectly
    const { getFirebaseAuth } = await import('@/lib/auth/firebase');
    const auth = getFirebaseAuth();
    const user = auth.currentUser;
    if (!user) return null;
    const newToken = await user.getIdToken(/* forceRefresh= */ true);
    tokenStore.set(newToken);
    return newToken;
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
};

export default apiClient;
