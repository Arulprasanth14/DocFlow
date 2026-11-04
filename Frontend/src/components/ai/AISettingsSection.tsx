/**
 * DocFlow — AI assistance preferences (spec §23 governance).
 *
 * Two switches, deliberately separate:
 *   - MINE: anyone can turn AI off for themselves.
 *   - ORGANISATION: admins only, because it decides for people who wanted it.
 *
 * The organisation switch is OFF until an admin turns it on, and it wins. A
 * non-admin whose org has not enabled AI is told who can enable it, rather
 * than shown a dead toggle with no explanation.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Sparkles, AlertCircle, Loader2 } from 'lucide-react';
import { aiApi } from '@/lib/api/ai';
import { useAIAvailability } from '@/hooks/useAI';
import { useAuthStore } from '@/store/authStore';

export function AISettingsSection() {
  const qc = useQueryClient();
  const ai = useAIAvailability();
  const isAdmin = useAuthStore((s) => s.hasRole('admin') || s.isSuperAdmin());

  const [saving, setSaving] = useState<null | 'mine' | 'org'>(null);
  const [error, setError] = useState<string | null>(null);

  const reason = ai.data?.reason_code ?? null;
  const notConfigured = reason === 'not_configured';
  const orgDisabled = reason === 'org_disabled';
  const iOptedOut = reason === 'user_disabled';

  const save = async (which: 'mine' | 'org', fn: () => Promise<unknown>) => {
    setSaving(which);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['ai', 'availability'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "That couldn't be saved.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="glass-card" style={{ padding: 20, display: 'grid', gap: 18 }}>
      <header style={{ display: 'grid', gap: 4 }}>
        <h2 style={{
          display: 'flex', alignItems: 'center', gap: 8, margin: 0,
          fontSize: '1rem', fontWeight: 700, color: 'var(--foreground)',
        }}>
          <Sparkles size={17} style={{ color: 'var(--accent-violet)' }} aria-hidden="true" />
          AI assistance
        </h2>
        <p style={{ margin: 0, fontSize: '0.84rem', color: 'var(--muted-foreground)' }}>
          AI can suggest questions for blanks, find fillable gaps in an imported
          document, rewrite a passage, and review a draft before you submit it.
          It never changes anything on its own — you accept or reject every
          suggestion.
        </p>
      </header>

      {notConfigured ? (
        <p style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', margin: 0,
          padding: '10px 12px', borderRadius: 'var(--radius-sm)',
          background: 'var(--secondary)', fontSize: '0.84rem',
          color: 'var(--muted-foreground)',
        }}>
          <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          AI features aren&apos;t set up for this deployment, so there is nothing
          to switch on here.
        </p>
      ) : (
        <>
          <Row
            id="ai-mine"
            label="Use AI assistance"
            hint={orgDisabled
              ? (isAdmin
                  ? 'AI is off for this organisation. Turn it on below first.'
                  : 'AI is not enabled for your organisation. An administrator can turn it on.')
              : 'Turn this off and AI suggestions stop appearing for you.'}
            checked={!iOptedOut}
            disabled={orgDisabled || saving !== null}
            busy={saving === 'mine'}
            onChange={(on) => save('mine', () => aiApi.setMyAI(!on))}
          />

          {isAdmin && (
            <Row
              id="ai-org"
              label="Enable AI for this organisation"
              hint="Off by default. Turning it on lets members use AI assistance; each person can still opt out for themselves."
              checked={!orgDisabled}
              disabled={saving !== null}
              busy={saving === 'org'}
              onChange={(on) => save('org', () => aiApi.setOrgAI(on))}
            />
          )}

          {ai.enabled && (
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
              {ai.usedToday} of {ai.dailyQuota} AI requests used in the last 24 hours.
            </p>
          )}
        </>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: '0.82rem', color: 'var(--status-rejected-fg)' }}>
          {error}
        </p>
      )}
    </section>
  );
}

function Row({ id, label, hint, checked, disabled, busy, onChange }: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        // A native checkbox exposes `checked`, but the switch role does
        // not inherit it: without this, every screen reader announces
        // the switch with no state at all.
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, flexShrink: 0 }}
      />
      <label htmlFor={id} style={{ display: 'grid', gap: 2, cursor: disabled ? 'default' : 'pointer' }}>
        <span style={{
          display: 'flex', alignItems: 'center', gap: 7,
          fontSize: '0.88rem', fontWeight: 600, color: 'var(--foreground)',
        }}>
          {label}
          {busy && <Loader2 size={13} style={{ animation: 'spin 0.8s linear infinite' }} aria-label="Saving" />}
        </span>
        <span style={{ fontSize: '0.8rem', color: 'var(--muted-foreground)' }}>{hint}</span>
      </label>
    </div>
  );
}

export default AISettingsSection;
