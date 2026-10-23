/**
 * DocFlow Frontend — Admin Login Page
 *
 * Route: /admin/login
 * Distinct from the Employee/Intern login page (/login).
 *
 * Design: Dark, authoritative — deep slate background with amber/red accent,
 * shield iconography, and a "Administrator Access" header to make it visually
 * clear this is a privileged portal.
 *
 * Auth flow:
 *   1. Email + Password only (no Google/Microsoft SSO for admin).
 *   2. Uses the same Firebase signInWithFirebaseEmail (reused, not reimplemented).
 *   3. After sign-in, checks if orgMembership.role_name is an admin role.
 *   4. If admin → navigate to /admin/dashboard.
 *   5. If NOT admin → immediately signs out + shows "Not an admin account" error.
 *
 * Session handling (idle-timeout, multi-tab) is identical to employee — both
 * are managed by AuthContext and useIdleTimeout in App.tsx.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion, AnimatePresence } from 'framer-motion';

import { signInWithFirebaseEmail, firebaseSignOutUser } from '@/lib/auth/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { useAuthStore } from '@/store/authStore';

// ── Zod schema ────────────────────────────────────────────────────────────────
const adminLoginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});
type AdminLoginFormData = z.infer<typeof adminLoginSchema>;

// ── Admin role names — match backend SYSTEM_ROLES keys. HR shares the admin
// portal for day-to-day management (§2.2); page-level gates inside it still
// restrict Main-Administrator-only screens (e.g. Roles & Perms).
const ADMIN_ROLES = ['admin', 'hr'];

// ── Icons ─────────────────────────────────────────────────────────────────────
const ShieldIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
);

const EyeIcon = ({ open }: { open: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    {open ? (
      <>
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/>
        <circle cx="12" cy="12" r="3"/>
      </>
    ) : (
      <>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      </>
    )}
  </svg>
);

// ── Floating particle ─────────────────────────────────────────────────────────
function AdminParticle({ delay, x, size }: { delay: number; x: number; size: number }) {
  return (
    <motion.div
      style={{
        position: 'absolute',
        left: `${x}%`,
        bottom: '-10px',
        width: size,
        height: size,
        borderRadius: '50%',
        background: `hsla(${25 + Math.random() * 20}, 90%, 55%, ${0.12 + Math.random() * 0.15})`,
        pointerEvents: 'none',
      }}
      animate={{ y: [0, -600], opacity: [0, 0.6, 0], scale: [0.5, 1, 0.5] }}
      transition={{ duration: 10 + Math.random() * 5, delay, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AdminLoginPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useAuth();
  const { hasRole, orgMembership } = useAuthStore();

  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<AdminLoginFormData>({
    resolver: zodResolver(adminLoginSchema),
    mode: 'onBlur',
  });

  // If already authenticated AND admin → redirect to admin dashboard
  useEffect(() => {
    if (!isLoading && isAuthenticated && orgMembership) {
      if (hasRole(...ADMIN_ROLES)) {
        navigate('/admin/dashboard', { replace: true });
      } else {
        // Authenticated but not admin — do not redirect to admin
        // Let them stay on admin login to see the "not admin" message
      }
    }
  }, [isAuthenticated, isLoading, orgMembership, hasRole, navigate]);

  const handleSubmitForm = async (data: AdminLoginFormData) => {
    setError(null);
    setIsSubmitting(true);

    try {
      // Step 1: Sign in via Firebase (reuses existing function, not reimplemented)
      await signInWithFirebaseEmail(data.email, data.password);

      // Step 2: AuthContext + AuthStore will sync via onAuthStateChanged.
      // We need to wait a tick for Zustand to populate with the synced role.
      // We use a short polling loop (max 3s) to wait for orgMembership to resolve.
      let attempts = 0;
      const maxAttempts = 30; // 30 * 100ms = 3s max wait
      const waitForSync = () =>
        new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            const { orgMembership: m } = useAuthStore.getState();
            attempts++;
            if (m || attempts >= maxAttempts) {
              clearInterval(interval);
              resolve();
            }
          }, 100);
        });

      await waitForSync();

      // Step 3: Check role
      const { orgMembership: m, hasRole: checkRole } = useAuthStore.getState();

      if (!m || !checkRole(...ADMIN_ROLES)) {
        // Not an admin account — sign them out immediately
        await firebaseSignOutUser();
        setError(
          'This account does not have administrator access. ' +
          'Please use the employee login instead, or contact your system administrator.'
        );
        setIsSubmitting(false);
        return;
      }

      // Step 4: Admin confirmed → navigate to admin dashboard
      navigate('/admin/dashboard', { replace: true });
    } catch (err: any) {
      const code = err?.code ?? '';
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
        setError('Incorrect email or password. Please try again.');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many failed attempts. Please try again in a few minutes.');
      } else {
        setError(err?.message ?? 'Sign-in failed. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const particles = Array.from({ length: 14 }, (_, i) => ({
    delay: i * 0.7,
    x: (i * 19 + 7) % 100,
    size: 4 + (i % 3) * 3,
  }));

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        position: 'relative',
        overflow: 'hidden',
        background:
          'radial-gradient(ellipse at 70% 0%, hsla(10, 80%, 15%, 0.6) 0%, transparent 55%), ' +
          'radial-gradient(ellipse at 0% 100%, hsla(35, 90%, 12%, 0.5) 0%, transparent 60%), ' +
          'hsl(222, 20%, 7%)',
      }}
    >
      {/* Background particles */}
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
        {particles.map((p, i) => <AdminParticle key={i} {...p} />)}

        {/* Ambient glow orbs */}
        <div style={{
          position: 'absolute', top: '-5%', right: '-8%',
          width: '480px', height: '480px', borderRadius: '50%',
          background: 'radial-gradient(circle, hsla(10, 80%, 45%, 0.07) 0%, transparent 70%)',
        }} />
        <div style={{
          position: 'absolute', bottom: '-10%', left: '-5%',
          width: '520px', height: '520px', borderRadius: '50%',
          background: 'radial-gradient(circle, hsla(35, 90%, 45%, 0.06) 0%, transparent 70%)',
        }} />
      </div>

      {/* Login card */}
      <motion.div
        initial={{ opacity: 0, y: 28, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        style={{ width: '100%', maxWidth: '420px', position: 'relative', zIndex: 10 }}
      >
        <div
          style={{
            background: 'hsla(222, 25%, 10%, 0.85)',
            backdropFilter: 'blur(24px)',
            border: '1px solid hsla(15, 80%, 45%, 0.2)',
            borderRadius: '20px',
            padding: '44px 40px',
            boxShadow:
              '0 4px 6px -1px rgba(0,0,0,0.5), 0 2px 4px -2px rgba(0,0,0,0.4), ' +
              'inset 0 1px 0 hsla(15, 80%, 60%, 0.08)',
          }}
        >
          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            {/* Shield icon + DocFlow */}
            <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
              <div style={{
                width: '56px', height: '56px', borderRadius: '16px',
                background: 'linear-gradient(135deg, hsl(10, 75%, 40%), hsl(35, 85%, 45%))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 20px hsla(10, 75%, 40%, 0.4)',
                color: 'white',
              }}>
                <ShieldIcon />
              </div>
              <div>
                <div style={{
                  fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em',
                  background: 'linear-gradient(135deg, hsl(15, 80%, 65%), hsl(38, 90%, 60%))',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                }}>
                  DocFlow Admin
                </div>
              </div>
            </div>

            <h1 style={{
              fontSize: '1.25rem', fontWeight: 700,
              color: 'hsl(210, 30%, 92%)',
              marginTop: '8px', marginBottom: '4px',
            }}>
              Administrator Access
            </h1>
            <p style={{ color: 'hsl(215, 15%, 55%)', fontSize: '0.875rem' }}>
              Restricted portal — authorized personnel only
            </p>
          </div>

          {/* Divider with warning badge */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            marginBottom: '28px',
          }}>
            <div style={{ flex: 1, height: '1px', background: 'hsla(15, 50%, 35%, 0.3)' }} />
            <span style={{
              fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em',
              color: 'hsl(35, 80%, 55%)',
              padding: '3px 10px',
              border: '1px solid hsla(35, 80%, 45%, 0.3)',
              borderRadius: '20px',
              background: 'hsla(35, 80%, 45%, 0.08)',
              whiteSpace: 'nowrap',
            }}>
              🔐 ADMIN ONLY
            </span>
            <div style={{ flex: 1, height: '1px', background: 'hsla(15, 50%, 35%, 0.3)' }} />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit(handleSubmitForm)} noValidate>
            {/* Email */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'block', fontSize: '0.8125rem', fontWeight: 600,
                color: 'hsl(215, 15%, 70%)', marginBottom: '6px',
              }}>
                Administrator Email
              </label>
              <input
                id="admin-input-email"
                type="email"
                autoComplete="email"
                placeholder="admin@company.com"
                className="input"
                style={{
                  background: 'hsla(222, 25%, 13%, 0.8)',
                  borderColor: 'hsla(15, 50%, 35%, 0.25)',
                }}
                {...register('email')}
              />
              {errors.email && (
                <p style={{ color: 'hsl(10, 75%, 60%)', fontSize: '0.8rem', marginTop: '4px' }}>
                  {errors.email.message}
                </p>
              )}
            </div>

            {/* Password */}
            <div style={{ marginBottom: '28px' }}>
              <label style={{
                display: 'block', fontSize: '0.8125rem', fontWeight: 600,
                color: 'hsl(215, 15%, 70%)', marginBottom: '6px',
              }}>
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  id="admin-input-password"
                  type={showPwd ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Enter admin password"
                  className="input"
                  style={{
                    paddingRight: '44px',
                    background: 'hsla(222, 25%, 13%, 0.8)',
                    borderColor: 'hsla(15, 50%, 35%, 0.25)',
                  }}
                  {...register('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(!showPwd)}
                  style={{
                    position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'hsl(215, 15%, 50%)', padding: '4px',
                  }}
                >
                  <EyeIcon open={showPwd} />
                </button>
              </div>
              {errors.password && (
                <p style={{ color: 'hsl(10, 75%, 60%)', fontSize: '0.8rem', marginTop: '4px' }}>
                  {errors.password.message}
                </p>
              )}
            </div>

            {/* Submit */}
            <motion.button
              id="admin-btn-submit"
              type="submit"
              disabled={isSubmitting}
              whileHover={{ scale: 1.01, translateY: -1 }}
              whileTap={{ scale: 0.99 }}
              style={{
                width: '100%',
                padding: '12px 24px',
                borderRadius: '10px',
                border: 'none',
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
                fontWeight: 700,
                fontSize: '0.9375rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                background: isSubmitting
                  ? 'hsla(10, 60%, 35%, 0.5)'
                  : 'linear-gradient(135deg, hsl(10, 75%, 42%), hsl(35, 85%, 48%))',
                color: 'white',
                boxShadow: isSubmitting ? 'none' : '0 4px 16px hsla(10, 75%, 40%, 0.35)',
                transition: 'all 0.2s',
              }}
            >
              {isSubmitting ? (
                <>
                  <div style={{
                    width: '18px', height: '18px', borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: 'white',
                    animation: 'spin 0.7s linear infinite',
                  }} />
                  Authenticating…
                </>
              ) : (
                <>
                  <ShieldIcon />
                  Sign In as Administrator
                </>
              )}
            </motion.button>
          </form>

          {/* Error message */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                style={{
                  marginTop: '16px',
                  padding: '12px 16px',
                  borderRadius: '10px',
                  background: 'hsla(10, 80%, 45%, 0.1)',
                  border: '1px solid hsla(10, 80%, 45%, 0.25)',
                  color: 'hsl(10, 80%, 65%)',
                  fontSize: '0.875rem',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginTop: '1px', flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer — link back to employee login */}
          <p style={{
            textAlign: 'center', marginTop: '28px',
            color: 'hsl(215, 15%, 45%)', fontSize: '0.8125rem',
          }}>
            Not an admin?{' '}
            <a
              href="/login"
              style={{ color: 'hsl(215, 80%, 60%)', fontWeight: 600, textDecoration: 'none' }}
            >
              Employee login →
            </a>
          </p>
        </div>

        {/* Bottom tagline */}
        <p style={{
          textAlign: 'center', color: 'hsl(215, 15%, 35%)',
          fontSize: '0.75rem', marginTop: '20px',
        }}>
          DocFlow Administrator Portal · Secure Access
        </p>
      </motion.div>

      {/* Spinner keyframe */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
