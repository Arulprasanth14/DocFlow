/**
 * DocFlow Frontend — Register Page
 * Stunning glassmorphism dark UI centered across all device sizes.
 * Supports: Google Sign-In, Microsoft Sign-In, and Firebase Email/Password Registration.
 */

import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion, AnimatePresence } from 'framer-motion';

import { useRegister, useGoogleLogin, useMicrosoftLogin } from '@/hooks/useAuth';
import { useAuth } from '@/contexts/AuthContext';

// ── Zod Schema ─────────────────────────────────────────────────────────────────
const registerSchema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Enter a valid email'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
      .regex(/[0-9]/, 'Must contain at least one number'),
    confirmPassword: z.string(),
    orgName: z.string().optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

type RegisterFormData = z.infer<typeof registerSchema>;

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

// ── Floating Particle ──────────────────────────────────────────────────────────
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

// ── Password Strength ──────────────────────────────────────────────────────────
function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: '8+ characters', ok: password.length >= 8 },
    { label: 'Uppercase letter', ok: /[A-Z]/.test(password) },
    { label: 'Number', ok: /[0-9]/.test(password) },
  ];
  const score = checks.filter((c) => c.ok).length;
  const colors = ['#ef4444', '#f59e0b', '#22c55e'];

  if (!password) return null;

  return (
    <div style={{ marginTop: '8px' }}>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              flex: 1, height: '3px', borderRadius: '2px',
              background: i < score ? colors[score - 1] : 'var(--border-default)',
              transition: 'background 0.3s ease',
            }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        {checks.map((c) => (
          <span
            key={c.label}
            style={{
              fontSize: '0.75rem',
              color: c.ok ? 'var(--color-success-400)' : 'var(--text-disabled)',
              display: 'flex', alignItems: 'center', gap: '4px',
            }}
          >
            {c.ok ? '✓' : '○'} {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Main Register Page ─────────────────────────────────────────────────────────
export default function RegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated } = useAuth();
  const [showEmail, setShowEmail] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showOrg, setShowOrg] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAuthenticated) navigate('/dashboard', { replace: true });
  }, [isAuthenticated, navigate]);

  const googleLogin = useGoogleLogin();
  const microsoftLogin = useMicrosoftLogin();
  const registerMutation = useRegister();

  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    mode: 'onBlur',
    defaultValues: {
      email: searchParams.get('email') || '',
    },
  });

  const password = watch('password', '');

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

  const onSubmit = async (data: RegisterFormData) => {
    setError(null);
    try {
      await registerMutation.mutateAsync({
        email: data.email,
        password: data.password,
        name: data.name,
        orgName: data.orgName || undefined,
      });
      navigate('/dashboard', { replace: true });
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const isLoading =
    googleLogin.isPending || microsoftLogin.isPending || registerMutation.isPending || isSubmitting;

  const particles = Array.from({ length: 18 }, (_, i) => ({
    delay: i * 0.5,
    x: (i * 17 + 5) % 100,
    size: 4 + (i % 4) * 3,
  }));

  return (
    <div
      className="auth-container"
      style={{
        background: 'radial-gradient(ellipse at 40% 0%, hsla(217, 100%, 18%, 0.4) 0%, transparent 60%), radial-gradient(ellipse at 100% 100%, hsla(258, 90%, 18%, 0.35) 0%, transparent 60%), var(--bg-base)',
      }}
    >
      {/* Fixed background layer (prevents absolute glow orbs from causing any scrollbar) */}
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
        {/* Floating particles */}
        {particles.map((p, i) => <FloatingParticle key={i} {...p} />)}

        {/* Glow orbs */}
        <div style={{
          position: 'absolute', top: '-10%', left: '-5%',
          width: '500px', height: '500px', borderRadius: '50%',
          background: 'radial-gradient(circle, hsla(217, 100%, 50%, 0.08) 0%, transparent 70%)',
        }} />
        <div style={{
          position: 'absolute', bottom: '-10%', right: '-5%',
          width: '600px', height: '600px', borderRadius: '50%',
          background: 'radial-gradient(circle, hsla(258, 90%, 50%, 0.07) 0%, transparent 70%)',
        }} />
      </div>

      {/* Registration card */}
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        style={{
          width: '100%',
          maxWidth: '460px',
          margin: 'auto',
          position: 'relative',
          zIndex: 10,
        }}
      >
        <div className="glass-card auth-card">
          {/* Logo + Title */}
          <div style={{ textAlign: 'center', marginBottom: '36px' }}>
            <Link to="/login" style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', textDecoration: 'none', marginBottom: '16px' }}>
              <div style={{
                width: '42px', height: '42px', borderRadius: '12px',
                background: 'linear-gradient(135deg, var(--color-primary-500), var(--color-accent-500))',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px hsla(217, 100%, 50%, 0.3)',
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
              </div>
              <span className="gradient-text" style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em' }}>DocFlow</span>
            </Link>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
              Create your account
            </h1>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              Get started with your DocFlow workspace
            </p>
          </div>

          {/* OAuth SSO Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
            <motion.button
              id="btn-google-signup"
              type="button"
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
              id="btn-microsoft-signup"
              type="button"
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
              or sign up with email
            </span>
            <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }} />
          </div>

          {/* Email/Password Toggle */}
          <AnimatePresence mode="wait">
            {!showEmail ? (
              <motion.button
                key="show-email"
                id="btn-email-toggle"
                type="button"
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
                onSubmit={handleSubmit(onSubmit)}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{ overflow: 'hidden', marginBottom: '8px' }}
              >
                {/* Full Name */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Full Name
                  </label>
                  <input
                    id="input-name"
                    type="text"
                    autoComplete="name"
                    className="input"
                    placeholder="John Smith"
                    {...register('name')}
                  />
                  {errors.name && <p style={{ color: 'var(--color-error-400)', fontSize: '0.8rem', marginTop: '4px' }}>{errors.name.message}</p>}
                </div>

                {/* Email */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Work Email
                  </label>
                  <input
                    id="input-email"
                    type="email"
                    autoComplete="email"
                    className="input"
                    placeholder="you@company.com"
                    {...register('email')}
                  />
                  {errors.email && <p style={{ color: 'var(--color-error-400)', fontSize: '0.8rem', marginTop: '4px' }}>{errors.email.message}</p>}
                </div>

                {/* Password */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Password
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id="input-password"
                      type={showPwd ? 'text' : 'password'}
                      autoComplete="new-password"
                      className="input"
                      placeholder="Create a strong password"
                      style={{ paddingRight: '44px' }}
                      {...register('password')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPwd(!showPwd)}
                      style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}
                    >
                      <EyeIcon open={showPwd} />
                    </button>
                  </div>
                  <PasswordStrength password={password} />
                  {errors.password && <p style={{ color: 'var(--color-error-400)', fontSize: '0.8rem', marginTop: '4px' }}>{errors.password.message}</p>}
                </div>

                {/* Confirm Password */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Confirm Password
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id="input-confirm-password"
                      type={showConfirm ? 'text' : 'password'}
                      autoComplete="new-password"
                      className="input"
                      placeholder="Repeat your password"
                      style={{ paddingRight: '44px' }}
                      {...register('confirmPassword')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm(!showConfirm)}
                      style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}
                    >
                      <EyeIcon open={showConfirm} />
                    </button>
                  </div>
                  {errors.confirmPassword && <p style={{ color: 'var(--color-error-400)', fontSize: '0.8rem', marginTop: '4px' }}>{errors.confirmPassword.message}</p>}
                </div>

                {/* Optional Organization */}
                <div style={{ marginBottom: '24px' }}>
                  <button
                    type="button"
                    id="btn-toggle-org"
                    onClick={() => setShowOrg(!showOrg)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--color-primary-400)', fontSize: '0.85rem',
                      fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px',
                      padding: 0,
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: showOrg ? 'rotate(45deg)' : 'none', transition: 'transform 0.2s' }}>
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
                    </svg>
                    {showOrg ? 'Skip organization setup' : 'Create an organization (optional)'}
                  </button>

                  <AnimatePresence>
                    {showOrg && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        style={{ overflow: 'hidden', marginTop: '14px' }}
                      >
                        <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                          Organization Name
                        </label>
                        <input
                          id="input-org-name"
                          type="text"
                          className="input"
                          placeholder="Acme Corporation"
                          {...register('orgName')}
                        />
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '6px' }}>
                          You'll be set as the Admin. You can invite your team later.
                        </p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Submit */}
                <motion.button
                  id="btn-register-submit"
                  type="submit"
                  className="btn btn-primary btn-lg"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={isLoading}
                  whileHover={{ scale: 1.01, translateY: -1 }}
                  whileTap={{ scale: 0.99 }}
                >
                  {registerMutation.isPending || isSubmitting ? (
                    <div className="spinner" style={{ width: '18px', height: '18px' }} />
                  ) : null}
                  Create Account
                </motion.button>
              </motion.form>
            )}
          </AnimatePresence>

          {/* Error Message */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
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

          {/* Sign In Link */}
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '28px' }}>
            Already have an account?{' '}
            <Link to="/login" id="link-login" style={{ color: 'var(--color-primary-400)', fontWeight: 600, textDecoration: 'none' }}>
              Sign in
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
