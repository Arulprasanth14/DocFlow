/**
 * DocFlow Frontend — Auth API Functions
 * Typed wrappers around all /auth endpoints.
 * All functions use the shared apiClient (auto-refresh, auth headers).
 */

import apiClient from '@/lib/api/client';
import type {
  AuthUser,
  LoginResponse,
  OrgMembership,
} from '@/types';

// ── Local type extensions for auth responses ───────────────────────────────────

export interface SessionInfo {
  id: string;
  device_info: {
    user_agent?: string;
    platform?: string;
    browser?: string;
  } | null;
  ip_address: string | null;
  created_at: string;
  expires_at: string;
  is_current: boolean;
}

export interface MeResponse {
  user: AuthUser;
  org_membership: OrgMembership | null;
  sessions: SessionInfo[];
}

export interface TokenRefreshResponse {
  access_token: string;
  token_type: string;
}

export interface DeviceInfo {
  user_agent?: string;
  platform?: string;
  browser?: string;
}

function getDeviceInfo(): DeviceInfo {
  return {
    user_agent: navigator.userAgent,
    platform: navigator.platform,
    browser: (() => {
      const ua = navigator.userAgent;
      if (ua.includes('Chrome')) return 'Chrome';
      if (ua.includes('Firefox')) return 'Firefox';
      if (ua.includes('Safari')) return 'Safari';
      if (ua.includes('Edge')) return 'Edge';
      return 'Unknown';
    })(),
  };
}

// ── Firebase Login (Google / Microsoft / Firebase Email/Password) ──────────────

/**
 * Exchange a Firebase ID token for DocFlow access + refresh tokens.
 * The refresh token is set as HttpOnly cookie by the backend.
 */
export async function firebaseLogin(idToken: string): Promise<LoginResponse> {
  return apiClient.post<LoginResponse>('/auth/firebase-login', {
    id_token: idToken,
    device_info: getDeviceInfo(),
  }, { skipAuth: true });
}

// ── Direct Email/Password Login ────────────────────────────────────────────────

export async function emailPasswordLogin(
  email: string,
  password: string
): Promise<LoginResponse> {
  return apiClient.post<LoginResponse>('/auth/login', {
    email,
    password,
    device_info: getDeviceInfo(),
  }, { skipAuth: true });
}

// ── Register ───────────────────────────────────────────────────────────────────

export async function register(
  email: string,
  name: string,
  password: string,
  orgName?: string
): Promise<LoginResponse> {
  return apiClient.post<LoginResponse>('/auth/register', {
    email,
    name,
    password,
    org_name: orgName,
    device_info: getDeviceInfo(),
  }, { skipAuth: true });
}

// ── Token Refresh ──────────────────────────────────────────────────────────────

export async function refreshToken(): Promise<TokenRefreshResponse> {
  return apiClient.post<TokenRefreshResponse>('/auth/refresh', undefined, {
    skipAuth: true,  // uses cookie, not Bearer token
  });
}

// ── Logout ─────────────────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
  return apiClient.post('/auth/logout');
}

export async function logoutAll(): Promise<void> {
  return apiClient.post('/auth/logout-all');
}

// ── Me (Current User) ──────────────────────────────────────────────────────────

export async function getMe(): Promise<MeResponse> {
  return apiClient.get<MeResponse>('/auth/me');
}

// ── Profile ────────────────────────────────────────────────────────────────────

export async function updateProfile(data: {
  name?: string;
  avatar_url?: string;
  notification_prefs?: Record<string, boolean>;
}): Promise<AuthUser> {
  return apiClient.patch<AuthUser>('/auth/me', data);
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  return apiClient.put('/auth/password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

// ── Sessions ───────────────────────────────────────────────────────────────────

export async function getSessions(): Promise<SessionInfo[]> {
  return apiClient.get<SessionInfo[]>('/auth/sessions');
}

export async function revokeSession(sessionId: string): Promise<void> {
  return apiClient.delete(`/auth/sessions/${sessionId}`);
}
