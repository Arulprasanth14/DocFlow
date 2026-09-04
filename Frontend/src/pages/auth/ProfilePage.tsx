/**
 * DocFlow Frontend — Profile Page
 * User profile, active sessions management, password change.
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import {
  useLogout,
  useLogoutAll,
  useUpdateProfile,
  useChangePassword,
  useSessions,
  useRevokeSession,
} from '@/hooks/useAuth';
import { useAuthStore } from '@/store/authStore';
import type { SessionInfo } from '@/lib/api/auth';

// ── Schemas ────────────────────────────────────────────────────────────────────
const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

const passwordSchema = z
  .object({
    current: z.string().min(1, 'Current password required'),
    next: z.string().min(8, 'Password must be at least 8 characters').regex(/[A-Z]/, 'Must contain uppercase').regex(/[0-9]/, 'Must contain a number'),
    confirm: z.string(),
  })
  .refine((d) => d.next === d.confirm, { message: "Passwords don't match", path: ['confirm'] });

type ProfileFormData = z.infer<typeof profileSchema>;
type PasswordFormData = z.infer<typeof passwordSchema>;

// ── Avatar ────────────────────────────────────────────────────────────────────
function UserAvatar({ name, avatarUrl, size = 72 }: { name: string | null; avatarUrl: string | null; size?: number }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name ?? 'User'} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }} />;
  }
  const initials = name
    ? name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
    : '?';
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.35, fontWeight: 700, color: 'white',
    }}>
      {initials}
    </div>
  );
}

// ── Session Card ──────────────────────────────────────────────────────────────
function SessionCard({ session, onRevoke }: { session: SessionInfo; onRevoke: (id: string) => void }) {
  const deviceLabel = session.device_info?.browser
    ? `${session.device_info.browser} on ${session.device_info.platform ?? 'Unknown'}`
    : 'Unknown device';

  return (
    <div style={{
      padding: '16px',
      borderRadius: 'var(--radius-md)',
      border: `1px solid ${session.is_current ? 'hsla(217, 100%, 50%, 0.3)' : 'var(--border-subtle)'}`,
      background: session.is_current ? 'hsla(217, 100%, 50%, 0.05)' : 'var(--bg-elevated)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{
          width: '36px', height: '36px', borderRadius: '8px',
          background: 'var(--bg-overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--text-muted)' }}>
            <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <div>
          <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {deviceLabel}
            {session.is_current && (
              <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-full)', background: 'hsla(217, 100%, 50%, 0.15)', color: 'var(--color-primary-300)' }}>
                This device
              </span>
            )}
          </p>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '2px' }}>
            {session.ip_address && `IP: ${session.ip_address} · `}
            Started {new Date(session.created_at).toLocaleDateString()}
          </p>
        </div>
      </div>
      {!session.is_current && (
        <button
          onClick={() => onRevoke(session.id)}
          className="btn btn-ghost btn-sm"
          style={{ color: 'var(--color-error-400)', flexShrink: 0 }}
        >
          Revoke
        </button>
      )}
    </div>
  );
}

// ── Section component ──────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-card" style={{ padding: '28px', marginBottom: '20px' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '20px', paddingBottom: '12px', borderBottom: '1px solid var(--border-subtle)' }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

// ── Profile Page ──────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const orgMembership = useAuthStore((s) => s.orgMembership);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);
  const [pwdMsg, setPwdMsg] = useState<string | null>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);

  const logout = useLogout();
  const logoutAll = useLogoutAll();
  const updateProfile = useUpdateProfile();
  const changePassword = useChangePassword();
  const { data: sessions = [] } = useSessions();
  const revokeSession = useRevokeSession();

  const profileForm = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: user?.name ?? '' },
  });

  const pwdForm = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
  });

  const handleProfileSave = async (data: ProfileFormData) => {
    setProfileErr(null);
    try {
      await updateProfile.mutateAsync({ name: data.name });
      setProfileMsg('Profile updated successfully');
      setTimeout(() => setProfileMsg(null), 3000);
    } catch (e: unknown) {
      setProfileErr((e as Error).message);
    }
  };

  const handlePasswordChange = async (data: PasswordFormData) => {
    setPwdErr(null);
    setPwdMsg(null);
    try {
      await changePassword.mutateAsync({ current: data.current, next: data.next });
      setPwdMsg('Password changed successfully');
      pwdForm.reset();
      setTimeout(() => setPwdMsg(null), 3000);
    } catch (e: unknown) {
      setPwdErr((e as Error).message);
    }
  };

  if (!user) return null;

  return (
    <div className="page-content" style={{ maxWidth: '720px', paddingTop: '32px' }}>
      <div className="page-header" style={{ padding: '0 0 24px 0' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, color: 'var(--text-primary)' }}>
          Account Settings
        </h1>
        <p style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
          Manage your profile, security, and active sessions
        </p>
      </div>

      {/* Profile Section */}
      <Section title="Profile">
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '24px' }}>
          <UserAvatar name={user.name} avatarUrl={user.avatar_url} size={72} />
          <div>
            <p style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--text-primary)' }}>{user.name ?? 'No name set'}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{user.email}</p>
            {orgMembership && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '6px', padding: '3px 10px', borderRadius: 'var(--radius-full)', background: 'hsla(217, 100%, 50%, 0.1)', border: '1px solid hsla(217, 100%, 50%, 0.2)', fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-primary-300)' }}>
                {orgMembership.role_name} · {orgMembership.organization.name}
              </span>
            )}
          </div>
        </div>

        <form onSubmit={profileForm.handleSubmit(handleProfileSave)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>Full Name</label>
              <input id="input-profile-name" className="input" type="text" {...profileForm.register('name')} />
              {profileForm.formState.errors.name && <p style={{ color: 'var(--color-error-400)', fontSize: '0.8rem', marginTop: '4px' }}>{profileForm.formState.errors.name.message}</p>}
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>Email</label>
              <input className="input" type="email" value={user.email} disabled style={{ opacity: 0.6 }} />
            </div>
          </div>

          <AnimatePresence>
            {(profileMsg || profileErr) && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={{ marginBottom: '12px', fontSize: '0.875rem', color: profileErr ? 'var(--color-error-400)' : 'var(--color-success-400)' }}
              >
                {profileMsg || profileErr}
              </motion.p>
            )}
          </AnimatePresence>

          <button
            id="btn-save-profile"
            type="submit"
            className="btn btn-primary"
            disabled={updateProfile.isPending}
          >
            {updateProfile.isPending ? <div className="spinner" style={{ width: '16px', height: '16px' }} /> : null}
            Save Changes
          </button>
        </form>
      </Section>

      {/* Sessions Section */}
      <Section title="Active Sessions">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
          {sessions.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>No active sessions</p>
          ) : (
            sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onRevoke={(id) => revokeSession.mutate(id)}
              />
            ))
          )}
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button
            id="btn-logout"
            className="btn btn-secondary"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            {logout.isPending ? <div className="spinner" style={{ width: '16px', height: '16px' }} /> : null}
            Sign Out
          </button>
          <button
            id="btn-logout-all"
            className="btn btn-danger"
            onClick={() => logoutAll.mutate()}
            disabled={logoutAll.isPending}
          >
            {logoutAll.isPending ? <div className="spinner" style={{ width: '16px', height: '16px' }} /> : null}
            Sign Out All Devices
          </button>
        </div>
      </Section>

      {/* Change Password Section */}
      <Section title="Change Password">
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '20px' }}>
          Only available for email/password accounts. Social login users (Google, Microsoft) can manage passwords through their identity provider.
        </p>
        <form onSubmit={pwdForm.handleSubmit(handlePasswordChange)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '20px' }}>
            {(['current', 'next', 'confirm'] as const).map((field) => (
              <div key={field}>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  {field === 'current' ? 'Current Password' : field === 'next' ? 'New Password' : 'Confirm New Password'}
                </label>
                <input
                  id={`input-${field}-password`}
                  type="password"
                  className="input"
                  style={{ maxWidth: '360px' }}
                  {...pwdForm.register(field)}
                />
                {pwdForm.formState.errors[field] && (
                  <p style={{ color: 'var(--color-error-400)', fontSize: '0.8rem', marginTop: '4px' }}>
                    {pwdForm.formState.errors[field]?.message}
                  </p>
                )}
              </div>
            ))}
          </div>

          <AnimatePresence>
            {(pwdMsg || pwdErr) && (
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ marginBottom: '12px', color: pwdErr ? 'var(--color-error-400)' : 'var(--color-success-400)', fontSize: '0.875rem' }}>
                {pwdMsg || pwdErr}
              </motion.p>
            )}
          </AnimatePresence>

          <button
            id="btn-change-password"
            type="submit"
            className="btn btn-primary"
            disabled={changePassword.isPending}
          >
            {changePassword.isPending ? <div className="spinner" style={{ width: '16px', height: '16px' }} /> : null}
            Change Password
          </button>
        </form>
      </Section>
    </div>
  );
}
