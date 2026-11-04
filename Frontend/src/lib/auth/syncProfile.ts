/**
 * DocFlow Frontend — Firebase → DocFlow token exchange.
 *
 * Plain sign-in needs exactly ONE backend call: POST /auth/firebase-login.
 * It verifies the Firebase token, finds-or-creates the DocFlow user, and
 * returns an access token whose claims reflect the user's real organization.
 *
 * Creating an organization is a separate, explicit action (the onboarding
 * page) and is the ONLY time /users/me/sync is called. Previously every
 * sign-in called /users/me/sync first and swallowed its failure — a second
 * network round trip that could only ever add a failure mode to login.
 *
 * Failure semantics matter here and are why this file is careful:
 *   - A TRANSIENT failure (5xx, network error, 503 "Firebase unreachable") is
 *     retried with backoff, and if it persists it is reported as
 *     `TransientAuthError`. Callers must NOT treat that as "this user has no
 *     organization" — doing so sent returning users to "Set up your
 *     workspace" and invited them to create duplicate organizations.
 *   - A DEFINITE answer (401/403/4xx) is rethrown unchanged.
 */

import { type User as FirebaseUser } from 'firebase/auth';
import apiClient, { ApiClientError } from '@/lib/api/client';
import type { LoginResponse } from '@/types';

/** The backend (or network) is unavailable — the user's account state is UNKNOWN. */
export class TransientAuthError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TransientAuthError';
  }
}

export function isTransient(err: unknown): boolean {
  if (err instanceof TransientAuthError) return true;
  if (err instanceof ApiClientError) return err.status >= 500 || err.status === 429;
  // fetch() rejects with a TypeError on network failure / CORS / refused connection.
  return err instanceof TypeError;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) break;
      await sleep(600 * 2 ** i); // 0.6s, 1.2s
    }
  }
  if (isTransient(lastErr)) {
    throw new TransientAuthError(
      "We couldn't reach DocFlow just now. Your account is fine — please try again.",
      lastErr,
    );
  }
  throw lastErr;
}

/**
 * Exchange the signed-in Firebase user for a DocFlow session.
 *
 * @param orgName  Only set from the onboarding page. When given, the
 *                 organization is created first via /users/me/sync, and a
 *                 failure there is NOT swallowed (the old behaviour hid it and
 *                 then reported a confusing generic error).
 */
export async function syncAndExchange(
  fbUser: FirebaseUser,
  orgName?: string,
  /** Display name to store when Firebase has none yet (email sign-up). */
  displayName?: string,
): Promise<LoginResponse> {
  const idToken = await fbUser.getIdToken();

  // A name is only ever sent together with an org (or when we hold one to
  // record), via /users/me/sync; plain sign-in does not need the call.
  if (orgName || displayName) {
    await withRetry(() =>
      apiClient.post(
        '/users/me/sync',
        {
          name: displayName ?? fbUser.displayName ?? undefined,
          avatar_url: fbUser.photoURL ?? undefined,
          org_name: orgName || undefined,
        },
        { skipAuth: true, headers: { Authorization: `Bearer ${idToken}` } },
      ),
    );
  }

  const { firebaseLogin } = await import('@/lib/api/auth');
  return withRetry(() => firebaseLogin(idToken));
}
