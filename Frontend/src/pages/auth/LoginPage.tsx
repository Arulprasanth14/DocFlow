/**
 * DocFlow Frontend — Login Page
 * Stunning glassmorphism dark UI.
 * Supports: Google Sign-In, Microsoft Sign-In, Firebase Email/Password
 */

import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion, AnimatePresence } from 'framer-motion';

import { useGoogleLogin, useMicrosoftLogin, useFirebaseEmailLogin } from '@/hooks/useAuth';
import { sendFirebasePasswordReset } from '@/lib/auth/firebase';
import { useAuth } from '@/contexts/AuthContext';

// ── Zod schema ────────────────────────────────────────────────────────────────
const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
});
type LoginFormData = z.infer<typeof loginSchema>;

// ── SVG Icons ─────────────────────────────────────────────────────────────────
const GoogleIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

const MicrosoftIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <rect x="1" y="1" width="10.5" height="10.5" fill="#F25022"/>
    <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7FBA00"/>
    <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00A4EF"/>
    <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900"/>
  </svg>
);

const EmailIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="4" width="20" height="16" rx="2"/>
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
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

// ── Floating particle component ────────────────────────────────────────────────
function FloatingParticle({ delay, x, size }: { delay: number; x: number; size: number }) {
  return (
    <motion.div
      style={{
        position: 'absolute',
        left: `${x}%`,
        bottom: '-10px',
        width: size,
        height: size,
        borderRadius: '50%',
        background: `hsla(${217 + Math.random() * 40}, 90%, 65%, ${0.15 + Math.random() * 0.2})`,
        pointerEvents: 'none',
      }}
      animate={{
        y: [0, -600],
        opacity: [0, 0.8, 0],
        scale: [0.5, 1, 0.5],
      }}
      transition={{
        duration: 8 + Math.random() * 4,
        delay,
        repeat: Infinity,
        ease: 'easeInOut',
      }}
    />
  );
}

// ── Main Login Page ────────────────────────────────────────────────────────────
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { isAuthenticated } = useAuth();
  const returnTo = (location.state as { returnTo?: string })?.returnTo ?? '/dashboard';
  const idleExpired = (location.state as { idleExpired?: boolean })?.idleExpired;
  
  const [showEmail, setShowEmail] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Redirect if already logged in
  useEffect(() => {
    if (isAuthenticated) navigate(returnTo, { replace: true });
  }, [isAuthenticated, navigate, returnTo]);

  const googleLogin = useGoogleLogin();
  const microsoftLogin = useMicrosoftLogin();
  const emailLogin = useFirebaseEmailLogin();

  const { register, handleSubmit, getValues, formState: { errors, isSubmitting } } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    mode: 'onBlur',
    defaultValues: {
      email: searchParams.get('email') || '',
    },
  });

  const handleGoogle = async () => {
    setError(null);
    try {
      await googleLogin.mutateAsync();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleMicrosoft = async () => {
    setError(null);
    try {
      await microsoftLogin.mutateAsync();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleEmailSubmit = async (data: LoginFormData) => {
    setError(null);
    try {
      await emailLogin.mutateAsync({
        email: data.email as string,
        password: data.password as string,
      });
    } catch (e: any) {
      if (e.isNoAccount) {
        setError(
          <span>
            No account found. <Link to={`/register?email=${encodeURIComponent(data.email)}`} style={{ color: 'var(--color-primary-400)', fontWeight: 'bold' }}>Create an account →</Link>
          </span>
        );
      } else {
        setError((e as Error).message);
      }
    }
  };

  const handlePasswordReset = async () => {
    const email = getValues('email');
    if (!email) {
      setError('Enter your email first, then click Forgot password');
      return;
    }
    setResetting(true);
    try {
      await sendFirebasePasswordReset(email);
      setResetSent(true);
      setError(null);
    } catch {
      setError('Could not send reset email. Check your email address.');
    } finally {
      setResetting(false);
    }
  };

  const isLoading =
    googleLogin.isPending || microsoftLogin.isPending || emailLogin.isPending || isSubmitting;

  const particles = Array.from({ length: 18 }, (_, i) => ({
    delay: i * 0.5,
    x: (i * 17 + 5) % 100,
    size: 4 + (i % 4) * 3,
  }));

  return (
    <div
      className="auth-container"
      style={{
        background: 'radial-gradient(ellipse at 60% 0%, hsla(258, 90%, 18%, 0.5) 0%, transparent 60%), radial-gradient(ellipse at 0% 100%, hsla(217, 100%, 18%, 0.4) 0%, transparent 60%), var(--bg-base)',
      }}
    >
      {/* Fixed background layer (prevents absolute glow orbs from causing any scrollbar) */}
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
        {/* Floating particles */}
        {particles.map((p, i) => <FloatingParticle key={i} {...p} />)}

        {/* Ambient glow orbs */}
        <div style={{
          position: 'absolute', top: '-10%', right: '-5%',
          width: '500px', height: '500px', borderRadius: '50%',
          background: 'radial-gradient(circle, hsla(258, 90%, 50%, 0.08) 0%, transparent 70%)',
        }} />
        <div style={{
          position: 'absolute', bottom: '-10%', left: '-5%',
          width: '600px', height: '600px', borderRadius: '50%',
          background: 'radial-gradient(circle, hsla(217, 100%, 50%, 0.07) 0%, transparent 70%)',
        }} />
      </div>

      {/* Login card */}
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        style={{
          width: '100%',
          maxWidth: '440px',
          margin: 'auto',
          position: 'relative',
          zIndex: 10,
        }}
      >
        <div className="glass-card auth-card">
          {/* Logo + Title */}
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
              <div style={{
                width: '42px', height: '42px', borderRadius: '12px',
                background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px hsla(217, 100%, 50%, 0.3)',
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
              </div>
              <span style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em' }} className="gradient-text">
                DocFlow
              </span>
            </div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
              Welcome back
            </h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              Sign in to your workspace
            </p>
          </div>

          {/* Idle Timeout Banner */}
          <AnimatePresence>
            {idleExpired && (
              <motion.div
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: 'auto', marginBottom: 24 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                style={{ overflow: 'hidden' }}
              >
                <div style={{
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-md)',
                  background: 'hsla(38, 92%, 50%, 0.1)',
                  border: '1px solid hsla(38, 92%, 50%, 0.25)',
                  color: 'var(--color-warning-400)',
                  fontSize: '0.875rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  Session expired due to inactivity. Please log in again.
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* OAuth Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
            <motion.button
              id="btn-google-login"
              className="btn btn-secondary btn-lg"
              style={{ width: '100%', justifyContent: 'center', position: 'relative' }}
              onClick={handleGoogle}
              disabled={isLoading}
              whileHover={{ scale: 1.01, translateY: -1 }}
              whileTap={{ scale: 0.99 }}
            >
              {googleLogin.isPending ? (
                <div className="spinner" style={{ width: '18px', height: '18px' }} />
              ) : <GoogleIcon />}
              Continue with Google
            </motion.button>

            <motion.button
              id="btn-microsoft-login"
              className="btn btn-secondary btn-lg"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleMicrosoft}
              disabled={isLoading}
              whileHover={{ scale: 1.01, translateY: -1 }}
              whileTap={{ scale: 0.99 }}
            >
              {microsoftLogin.isPending ? (
                <div className="spinner" style={{ width: '18px', height: '18px' }} />
              ) : <MicrosoftIcon />}
              Continue with Microsoft
            </motion.button>
          </div>

          {/* Divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
            <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
            <span style={{ color: 'var(--text-disabled)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
              or with email
            </span>
            <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
          </div>

          {/* Email/Password Toggle */}
          <AnimatePresence mode="wait">
            {!showEmail ? (
              <motion.button
                key="show-email"
                id="btn-email-toggle"
                className="btn btn-secondary"
                style={{ width: '100%', justifyContent: 'center', marginBottom: '16px' }}
                onClick={() => setShowEmail(true)}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                whileHover={{ scale: 1.01 }}
              >
                <EmailIcon />
                Continue with Email
              </motion.button>
            ) : (
              <motion.form
                key="email-form"
                onSubmit={handleSubmit(handleEmailSubmit)}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{ overflow: 'hidden', marginBottom: '8px' }}
              >
                {/* Email field */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Email
                  </label>
                  <input
                    id="input-email"
                    type="email"
                    autoComplete="email"
                    className="input"
                    placeholder="you@company.com"
                    {...register('email')}
                  />
                  {errors.email && (
                    <p style={{ color: 'var(--color-error-400)', fontSize: '0.8rem', marginTop: '4px' }}>
                      {errors.email.message}
                    </p>
                  )}
                </div>

                {/* Password field */}
                <div style={{ marginBottom: '8px' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Password
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id="input-password"
                      type={showPwd ? 'text' : 'password'}
                      autoComplete="current-password"
                      className="input"
                      placeholder="Enter your password"
                      style={{ paddingRight: '44px' }}
                      {...register('password')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPwd(!showPwd)}
                      style={{
                        position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-muted)', padding: '4px',
                      }}
                    >
                      <EyeIcon open={showPwd} />
                    </button>
                  </div>
                  {errors.password && (
                    <p style={{ color: 'var(--color-error-400)', fontSize: '0.8rem', marginTop: '4px' }}>
                      {errors.password.message}
                    </p>
                  )}
                </div>

                {/* Forgot password */}
                <div style={{ textAlign: 'right', marginBottom: '20px' }}>
                  <button
                    type="button"
                    id="btn-forgot-password"
                    onClick={handlePasswordReset}
                    disabled={resetting}
                    style={{ background: 'none', border: 'none', color: 'var(--color-primary-400)', fontSize: '0.8125rem', cursor: 'pointer', fontWeight: 500 }}
                  >
                    {resetting ? 'Sending…' : 'Forgot password?'}
                  </button>
                </div>

                {/* Submit */}
                <motion.button
                  id="btn-email-submit"
                  type="submit"
                  className="btn btn-primary btn-lg"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={isLoading}
                  whileHover={{ scale: 1.01, translateY: -1 }}
                  whileTap={{ scale: 0.99 }}
                >
                  {emailLogin.isPending || isSubmitting ? (
                    <div className="spinner" style={{ width: '18px', height: '18px' }} />
                  ) : null}
                  Sign In
                </motion.button>
              </motion.form>
            )}
          </AnimatePresence>

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
                  borderRadius: 'var(--radius-md)',
                  background: 'hsla(0, 82%, 55%, 0.1)',
                  border: '1px solid hsla(0, 82%, 55%, 0.25)',
                  color: 'var(--color-error-400)',
                  fontSize: '0.875rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Password reset success */}
          <AnimatePresence>
            {resetSent && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                style={{
                  marginTop: '16px',
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-md)',
                  background: 'hsla(145, 70%, 45%, 0.1)',
                  border: '1px solid hsla(145, 70%, 45%, 0.25)',
                  color: 'var(--color-success-400)',
                  fontSize: '0.875rem',
                }}
              >
                ✓ Password reset email sent. Check your inbox.
              </motion.div>
            )}
          </AnimatePresence>

          {/* Register link */}
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '28px' }}>
            Don't have an account?{' '}
            <Link
              to="/register"
              id="link-register"
              style={{ color: 'var(--color-primary-400)', fontWeight: 600, textDecoration: 'none' }}
            >
              Create one
            </Link>
          </p>
        </div>

        {/* Bottom tagline */}
        <p style={{ textAlign: 'center', color: 'var(--text-disabled)', fontSize: '0.8rem', marginTop: '24px' }}>
          Enterprise Document Workflow & Approval Platform
        </p>
      </motion.div>
    </div>
  );
}
