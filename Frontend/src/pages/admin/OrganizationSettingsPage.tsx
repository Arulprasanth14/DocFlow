/**
 * DocFlow Frontend — Admin: Organization Settings Page
 * Manage workspace name, logo, stats, and subscription plan.
 */

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { motion, AnimatePresence } from 'framer-motion';
import { useMyOrg, useOrgStats, useUpdateMyOrg } from '@/hooks/useOrg';

interface OrgFormData {
  name: string;
  logo_url: string;
}

export default function OrganizationSettingsPage() {
  const { data: org, isLoading: orgLoading } = useMyOrg();
  const { data: stats, isLoading: statsLoading } = useOrgStats();
  const updateOrg = useUpdateMyOrg();
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<OrgFormData>({
    defaultValues: {
      name: '',
      logo_url: '',
    },
  });

  useEffect(() => {
    if (org) {
      reset({
        name: org.name || '',
        logo_url: org.logo_url || '',
      });
    }
  }, [org, reset]);

  const onSubmit = async (data: OrgFormData) => {
    setSuccessMsg(null);
    try {
      await updateOrg.mutateAsync({
        name: data.name,
        logo_url: data.logo_url || undefined,
      });
      setSuccessMsg('Organization settings saved successfully.');
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch {
      // Error handled by query client / notification
    }
  };

  if (orgLoading) {
    return (
      <div style={{ padding: '40px', display: 'flex', justifyContent: 'center' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  if (!org) {
    return (
      <div style={{ padding: '40px', color: 'var(--text-muted)' }}>
        No organization found.
      </div>
    );
  }

  return (
    <div style={{ padding: '32px', maxWidth: '1000px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              color: 'var(--color-primary-300)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              background: 'hsla(217, 100%, 50%, 0.1)',
              padding: '4px 10px',
              borderRadius: 'var(--radius-full)',
              border: '1px solid hsla(217, 100%, 50%, 0.25)',
            }}
          >
            Admin Workspace
          </span>
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 700,
              color: 'var(--color-success-400)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              background: 'hsla(145, 70%, 50%, 0.1)',
              padding: '4px 10px',
              borderRadius: 'var(--radius-full)',
              border: '1px solid hsla(145, 70%, 50%, 0.25)',
            }}
          >
            Plan: {org.plan.toUpperCase()}
          </span>
        </div>
        <h1
          style={{
            fontSize: '2rem',
            fontWeight: 800,
            color: 'var(--text-primary)',
            marginBottom: '6px',
          }}
        >
          Organization Settings
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
          Manage your workspace identity, subscription, and view overall system metrics.
        </p>
      </div>

      {/* Stats Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '16px',
          marginBottom: '32px',
        }}
      >
        {[
          {
            label: 'Total Members',
            value: statsLoading ? '—' : stats?.member_count ?? 0,
            sub: `${stats?.active_member_count ?? 0} active`,
          },
          {
            label: 'Departments',
            value: statsLoading ? '—' : stats?.department_count ?? 0,
            sub: 'Organizational units',
          },
          {
            label: 'Teams',
            value: statsLoading ? '—' : stats?.team_count ?? 0,
            sub: 'Functional squads',
          },
          {
            label: 'Roles',
            value: statsLoading ? '—' : stats?.role_count ?? 0,
            sub: 'System & custom',
          },
        ].map((stat, i) => (
          <motion.div
            key={stat.label}
            className="glass-card"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08 }}
            style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '4px' }}
          >
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                color: 'var(--text-disabled)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {stat.label}
            </span>
            <span
              style={{
                fontSize: '1.75rem',
                fontWeight: 800,
                color: 'var(--text-primary)',
                letterSpacing: '-0.02em',
              }}
            >
              {stat.value}
            </span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{stat.sub}</span>
          </motion.div>
        ))}
      </div>

      {/* Settings Form Card */}
      <motion.div
        className="glass-card"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ padding: '28px', marginBottom: '32px' }}
      >
        <h2
          style={{
            fontSize: '1.25rem',
            fontWeight: 700,
            color: 'var(--text-primary)',
            marginBottom: '16px',
          }}
        >
          Workspace Profile
        </h2>

        <form onSubmit={handleSubmit(onSubmit)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  marginBottom: '8px',
                }}
              >
                Organization Name
              </label>
              <input
                type="text"
                className="input"
                placeholder="Acme Corporation"
                {...register('name')}
              />
            </div>

            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  marginBottom: '8px',
                }}
              >
                Organization Slug (Read-only)
              </label>
              <input
                type="text"
                className="input"
                value={org.slug}
                disabled
                style={{ background: 'var(--bg-overlay)', cursor: 'not-allowed' }}
              />
            </div>
          </div>

          <div style={{ marginBottom: '24px' }}>
            <label
              style={{
                display: 'block',
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                marginBottom: '8px',
              }}
            >
              Logo URL
            </label>
            <input
              type="url"
              className="input"
              placeholder="https://example.com/logo.png"
              {...register('logo_url')}
            />
          </div>

          <AnimatePresence>
            {successMsg && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                style={{
                  marginBottom: '20px',
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-md)',
                  background: 'hsla(145, 70%, 45%, 0.1)',
                  border: '1px solid hsla(145, 70%, 45%, 0.25)',
                  color: 'var(--color-success-400)',
                  fontSize: '0.875rem',
                }}
              >
                ✓ {successMsg}
              </motion.div>
            )}
          </AnimatePresence>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting || updateOrg.isPending}
            >
              {isSubmitting || updateOrg.isPending ? (
                <div className="spinner" style={{ width: '16px', height: '16px' }} />
              ) : null}
              Save Changes
            </button>
          </div>
        </form>
      </motion.div>

      {/* Danger Zone */}
      <div
        className="glass-card"
        style={{
          padding: '24px 28px',
          borderColor: 'hsla(0, 82%, 55%, 0.3)',
          background: 'hsla(0, 82%, 55%, 0.03)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--color-error-400)', marginBottom: '4px' }}>
              Danger Zone
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Suspending or cancelling an organization disables access for all members immediately.
            </p>
          </div>
          <button
            type="button"
            className="btn"
            disabled
            title="Please contact Enterprise support to suspend your workspace"
            style={{
              background: 'hsla(0, 82%, 55%, 0.15)',
              color: 'var(--color-error-400)',
              border: '1px solid hsla(0, 82%, 55%, 0.3)',
              cursor: 'not-allowed',
            }}
          >
            Suspend Organization
          </button>
        </div>
      </div>
    </div>
  );
}
