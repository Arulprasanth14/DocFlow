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
  industry: string;
  timezone: string;
  branding_primary_color: string;
  branding_accent_color: string;
  notify_email: boolean;
  notify_sms: boolean;
  notify_push: boolean;
  notify_in_app: boolean;
  allow_self_approval: boolean;
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
      industry: '',
      timezone: 'UTC',
      branding_primary_color: '',
      branding_accent_color: '',
      notify_email: true,
      notify_sms: false,
      notify_push: true,
      notify_in_app: true,
      allow_self_approval: false,
    },
  });

  useEffect(() => {
    if (org) {
      reset({
        name: org.name || '',
        logo_url: org.logo_url || '',
        industry: org.industry || '',
        timezone: org.timezone || 'UTC',
        branding_primary_color: org.branding_primary_color || '',
        branding_accent_color: org.branding_accent_color || '',
        notify_email: org.notification_defaults?.email ?? true,
        notify_sms: org.notification_defaults?.sms ?? false,
        notify_push: org.notification_defaults?.push ?? true,
        notify_in_app: org.notification_defaults?.in_app ?? true,
        allow_self_approval: Boolean(org.settings?.allow_self_approval) ?? false,
      });
    }
  }, [org, reset]);

  const onSubmit = async (data: OrgFormData) => {
    setSuccessMsg(null);
    try {
      await updateOrg.mutateAsync({
        name: data.name,
        logo_url: data.logo_url || undefined,
        industry: data.industry || undefined,
        timezone: data.timezone || undefined,
        branding_primary_color: data.branding_primary_color || undefined,
        branding_accent_color: data.branding_accent_color || undefined,
        notification_defaults: {
          email: data.notify_email,
          sms: data.notify_sms,
          push: data.notify_push,
          in_app: data.notify_in_app,
        },
        settings: {
          allow_self_approval: data.allow_self_approval,
        },
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
              background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
              padding: '4px 10px',
              borderRadius: 'var(--radius-full)',
              border: '1px solid color-mix(in srgb, var(--primary) 25%, transparent)',
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
              background: 'color-mix(in srgb, var(--status-approved) 12%, transparent)',
              padding: '4px 10px',
              borderRadius: 'var(--radius-full)',
              border: '1px solid color-mix(in srgb, var(--status-approved) 25%, transparent)',
            }}
          >
            Plan: {org.plan.toUpperCase()}
          </span>
        </div>
        <h1
          data-page-title
          className="font-display"
          style={{
            fontSize: 'clamp(1.75rem, 1.2rem + 2vw, 2.4rem)',
            fontWeight: 400,
            lineHeight: 1.1,
            color: 'var(--foreground)',
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
                Industry
              </label>
              <input
                type="text"
                className="input"
                placeholder="e.g. Healthcare, Finance"
                {...register('industry')}
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
                Timezone
              </label>
              <select className="input" {...register('timezone')}>
                <option value="UTC">UTC</option>
                <option value="America/New_York">Eastern Time (US & Canada)</option>
                <option value="America/Chicago">Central Time (US & Canada)</option>
                <option value="America/Denver">Mountain Time (US & Canada)</option>
                <option value="America/Los_Angeles">Pacific Time (US & Canada)</option>
                <option value="Europe/London">London</option>
                <option value="Asia/Kolkata">India Standard Time (IST)</option>
                <option value="Asia/Tokyo">Tokyo</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
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
                Primary Brand Color (Hex)
              </label>
              <input
                type="text"
                className="input"
                placeholder="#0F172A"
                {...register('branding_primary_color')}
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
                Accent Brand Color (Hex)
              </label>
              <input
                type="text"
                className="input"
                placeholder="#3B82F6"
                {...register('branding_accent_color')}
              />
            </div>
          </div>

          <div style={{ marginBottom: '28px', borderTop: '1px solid var(--border-subtle)', paddingTop: '20px' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '12px' }}>
              Approval Policy
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
              By default, nobody can approve their own document — even if a workflow
              happens to assign them as their own approver. Turn this on only if your
              organization intentionally wants self-approval to be allowed.
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" {...register('allow_self_approval')} />
              Allow self-approval
            </label>
          </div>

          <div style={{ marginBottom: '28px', borderTop: '1px solid var(--border-subtle)', paddingTop: '20px' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '12px' }}>
              Default Notification Channels
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
              These channels will be enabled by default for new users.
            </p>
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" {...register('notify_email')} />
                Email
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" {...register('notify_sms')} />
                SMS
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" {...register('notify_push')} />
                Push (Mobile)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" {...register('notify_in_app')} />
                In-App
              </label>
            </div>
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
                  background: 'color-mix(in srgb, var(--status-approved) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--status-approved) 25%, transparent)',
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
          borderColor: 'color-mix(in srgb, var(--destructive) 30%, transparent)',
          background: 'color-mix(in srgb, var(--destructive) 4%, transparent)',
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
              background: 'color-mix(in srgb, var(--destructive) 15%, transparent)',
              color: 'var(--color-error-400)',
              border: '1px solid color-mix(in srgb, var(--destructive) 30%, transparent)',
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
