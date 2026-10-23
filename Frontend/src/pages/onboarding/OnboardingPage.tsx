/**
 * DocFlow Frontend — Onboarding (/onboarding)
 *
 * Reached ONLY when the server says the signed-in user has no active
 * organization. There are exactly two situations here:
 *
 *   NO_ORG           -> Create a new organization  |  Request to join one
 *   PENDING_REQUEST  -> "Waiting for approval" (no create/join options)
 *
 * A user who already belongs to an organization is redirected to the
 * dashboard by ProtectedRoute and never sees this page.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';

import { useAuth } from '@/contexts/AuthContext';
import { syncAndExchange } from '@/lib/auth/syncProfile';
import { tokenStore } from '@/lib/api/client';
import { orgsApi } from '@/lib/api/orgs';
import { useAuthStore } from '@/store/authStore';
import { useLogout } from '@/hooks/useAuth';

const PAGE_BG =
  'radial-gradient(ellipse at 60% 0%, hsla(258, 90%, 18%, 0.5) 0%, transparent 60%), radial-gradient(ellipse at 0% 100%, hsla(217, 100%, 18%, 0.4) 0%, transparent 60%), var(--bg-base)';

/** Debounce a changing value so we don't fire a request per keystroke. */
function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-container" style={{ background: PAGE_BG }}>
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        style={{ width: '100%', maxWidth: '460px', margin: 'auto', position: 'relative', zIndex: 10 }}
      >
        <div className="glass-card auth-card">{children}</div>
      </motion.div>
    </div>
  );
}

function SignOutLink() {
  const logout = useLogout();
  return (
    <button
      type="button"
      onClick={() => logout.mutate()}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        color: 'var(--text-muted)', fontSize: '0.8rem', textDecoration: 'underline',
        marginTop: '18px',
      }}
    >
      Sign out
    </button>
  );
}

// ── Waiting for approval ────────────────────────────────────────────────────

function PendingScreen({ orgName }: { orgName: string }) {
  const { retryExchange } = useAuth();
  const [outcomeNote, setOutcomeNote] = useState('');

  // Poll the request. The moment it is no longer pending it was decided: ask
  // the server for the user's state again (HAS_ORG -> dashboard, or NO_ORG if
  // it was rejected).
  const { data } = useQuery({
    queryKey: ['org', 'join-request', 'mine', 'poll'],
    queryFn: orgsApi.getMyJoinRequest,
    refetchInterval: 8000,
  });

  useEffect(() => {
    if (data && data.status !== 'pending') {
      void retryExchange().then(() => {
        if (useAuthStore.getState().accountState === 'NO_ORG') {
          setOutcomeNote(`Your request to join ${orgName} was not approved.`);
        }
      });
    }
  }, [data, retryExchange, orgName]);

  return (
    <Shell>
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            width: '48px', height: '48px', borderRadius: '50%', margin: '0 auto 16px',
            background: 'hsla(38, 92%, 50%, 0.12)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning-400)" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <h1 style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
          Waiting for approval
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          Your request to join <strong>{orgName}</strong> has been sent to the
          organization's administrators. You'll get an email as soon as someone
          responds — this page updates automatically.
        </p>
        {outcomeNote && (
          <p style={{ color: 'var(--color-error-400)', fontSize: '0.85rem', marginTop: '12px' }}>
            {outcomeNote}
          </p>
        )}
        <SignOutLink />
      </div>
    </Shell>
  );
}

// ── Create / join ───────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { firebaseUser } = useAuth();
  const { setAuth, setAccountState } = useAuthStore.getState();
  const pending = useAuthStore((s) => s.pendingRequest);

  const [orgMode, setOrgMode] = useState<'create' | 'join'>('create');
  const [orgName, setOrgName] = useState('');
  const [error, setError] = useState('');
  const debounced = useDebounced(orgName.trim());
  const joinedRef = useRef(false);

  // Live availability while creating (case-insensitive, server-side).
  const availability = useQuery({
    queryKey: ['org', 'availability', debounced],
    queryFn: () => orgsApi.checkOrgName(debounced),
    enabled: orgMode === 'create' && debounced.length >= 2,
    staleTime: 10_000,
  });
  const nameTaken = orgMode === 'create' && availability.data?.available === false;
  const nameChecking =
    orgMode === 'create' && orgName.trim().length >= 2 && (orgName.trim() !== debounced || availability.isFetching);

  // Suggestions while joining: names only.
  const suggestions = useQuery({
    queryKey: ['org', 'search', debounced],
    queryFn: () => orgsApi.searchOrgs(debounced),
    enabled: orgMode === 'join' && debounced.length >= 2,
    staleTime: 10_000,
  });

  const createM = useMutation({
    mutationFn: async (name: string) => {
      if (!firebaseUser) throw new Error('Your session expired. Please sign in again.');
      return syncAndExchange(firebaseUser, name);
    },
    onSuccess: (loginData) => {
      tokenStore.set(loginData.access_token);
      setAuth(loginData.user, loginData.access_token, loginData.org_membership);
      setAccountState(loginData.state, loginData.pending_request);
      if (loginData.state === 'HAS_ORG') navigate('/dashboard', { replace: true });
      else setError('We could not finish creating the organization. Please try again.');
    },
    onError: (err: Error) => setError(err.message || 'Something went wrong. Please try again.'),
  });

  const joinM = useMutation({
    mutationFn: (name: string) => orgsApi.requestJoin(name),
    onSuccess: async () => {
      joinedRef.current = true;
      // Ask the server for the authoritative state (-> PENDING_REQUEST).
      const { firebaseLogin } = await import('@/lib/api/auth');
      const idToken = await firebaseUser!.getIdToken();
      const res = await firebaseLogin(idToken);
      tokenStore.set(res.access_token);
      setAuth(res.user, res.access_token, res.org_membership);
      setAccountState(res.state, res.pending_request);
      queryClient.invalidateQueries({ queryKey: ['org', 'join-request'] });
    },
    onError: (err: Error) => setError(err.message || 'Something went wrong. Please try again.'),
  });

  const submitting = createM.isPending || joinM.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmed = orgName.trim().replace(/\s+/g, ' ');
    if (trimmed.length < 2) {
      setError('Organization name must be at least 2 characters.');
      return;
    }
    if (orgMode === 'create') createM.mutate(trimmed);
    else joinM.mutate(trimmed);
  };

  // A request is on file -> only the waiting screen, never create/join.
  if (pending) return <PendingScreen orgName={pending.org_name} />;

  return (
    <Shell>
      <div style={{ textAlign: 'center', marginBottom: '28px' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
          Set up your workspace
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          You're signed in, but you're not part of an organization yet.
          Create one, or ask to join an existing one.
        </p>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['create', 'join'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => { setOrgMode(mode); setError(''); }}
              disabled={submitting}
              style={{
                flex: 1, padding: '10px 12px', borderRadius: 'var(--radius-md)',
                border: orgMode === mode ? '1.5px solid var(--color-primary-400)' : '1px solid var(--border-subtle)',
                background: orgMode === mode ? 'hsla(217, 100%, 50%, 0.1)' : 'transparent',
                color: orgMode === mode ? 'var(--color-primary-300)' : 'var(--text-secondary)',
                fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
              }}
            >
              {mode === 'create' ? 'Create a new organization' : 'Request to join an existing one'}
            </button>
          ))}
        </div>

        <div>
          <label htmlFor="orgName" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
            Organization name
          </label>
          <input
            id="orgName"
            type="text"
            className="input"
            placeholder={orgMode === 'create' ? 'e.g. Acme Corporation' : 'Start typing the organization name'}
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            disabled={submitting}
            autoFocus
            autoComplete="off"
            style={{ width: '100%', fontSize: '0.95rem' }}
          />

          {orgMode === 'create' ? (
            <p style={{ fontSize: '0.78rem', marginTop: '6px', color: nameTaken ? 'var(--color-error-400)' : 'var(--text-muted)' }}>
              {nameChecking
                ? 'Checking availability…'
                : nameTaken
                  ? availability.data?.reason || 'That name is taken.'
                  : orgName.trim().length >= 2 && availability.data?.available
                    ? '✓ This name is available.'
                    : "You'll be the Administrator. You can invite your team later."}
            </p>
          ) : (
            <>
              {(suggestions.data ?? []).length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {(suggestions.data ?? []).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setOrgName(n)}
                      style={{
                        textAlign: 'left', padding: '8px 12px', borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border-subtle)', background: 'transparent',
                        color: 'var(--text-secondary)', fontSize: '0.85rem', cursor: 'pointer',
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}
              <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '6px' }}>
                An administrator or HR of this organization must approve your
                request and choose your role before you get access.
              </p>
            </>
          )}
        </div>

        {error && (
          <div style={{
            padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'hsla(0, 82%, 55%, 0.1)', border: '1px solid hsla(0, 82%, 55%, 0.25)',
            color: 'var(--color-error-400)', fontSize: '0.85rem',
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={submitting || orgName.trim().length < 2 || nameTaken || nameChecking}
          style={{ width: '100%', padding: '12px', fontSize: '0.95rem', fontWeight: 600 }}
        >
          {submitting
            ? (orgMode === 'create' ? 'Creating workspace…' : 'Sending request…')
            : (orgMode === 'create' ? 'Create organization' : 'Request access')}
        </button>
      </form>

      <div style={{ textAlign: 'center' }}>
        <SignOutLink />
      </div>
    </Shell>
  );
}
