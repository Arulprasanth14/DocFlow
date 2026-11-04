/**
 * AuthBrandPanel — the left brand panel for auth/onboarding (T8).
 * Big serif headline, three feature points with IconChips, and a decorative static
 * product-preview card (NO real data). Purely presentational.
 */

import { FileText, ShieldCheck, Workflow, Sparkles, CheckCircle2 } from 'lucide-react';
import { IconChip } from '@/components/ui/IconChip';
import { GlassCard } from '@/components/ui/GlassCard';

const FEATURES = [
  { icon: <Workflow size={18} />, tone: 'primary' as const, title: 'Automated approvals', desc: 'Route documents through multi-stage workflows that run themselves.' },
  { icon: <ShieldCheck size={18} />, tone: 'cyan' as const, title: 'Enterprise-grade control', desc: 'Role-based access, audit trails and org-scoped isolation by default.' },
  { icon: <Sparkles size={18} />, tone: 'violet' as const, title: 'AI that reads the fine print', desc: 'Draft, summarise and search across every document instantly.' },
];

export function AuthBrandPanel({
  eyebrow = 'Enterprise Document Platform',
  headline = (
    <>
      Where documents <em style={{ fontStyle: 'italic' }}>move</em> at the speed of your team.
    </>
  ),
}: {
  eyebrow?: string;
  headline?: React.ReactNode;
}) {
  return (
    <aside className="auth-brand">
      {/* Logo */}
      <div className="flex items-center gap-2.5" style={{ marginBottom: 40 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--gradient-brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', boxShadow: 'var(--shadow-glow)' }}>
          <FileText size={20} strokeWidth={2.5} />
        </div>
        <span style={{ fontFamily: 'var(--font-heading)', fontSize: '1.3rem', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--foreground)' }}>DocFlow</span>
      </div>

      <div className="label-caps" style={{ padding: 0, marginBottom: 14 }}>{eyebrow}</div>
      <h1 className="font-display" style={{ fontSize: 'clamp(2.2rem, 1.5rem + 2.5vw, 3.4rem)', lineHeight: 1.08, color: 'var(--foreground)', margin: 0, maxWidth: 520 }}>
        {headline}
      </h1>

      <div className="flex flex-col gap-4" style={{ marginTop: 36, maxWidth: 440 }}>
        {FEATURES.map((f) => (
          <div key={f.title} className="flex items-start gap-3">
            <IconChip tone={f.tone}>{f.icon}</IconChip>
            <div>
              <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '0.95rem', color: 'var(--foreground)' }}>{f.title}</div>
              <div style={{ fontSize: '0.84rem', color: 'var(--muted-foreground)', marginTop: 2 }}>{f.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Decorative product-preview card — static, no real data */}
      <GlassCard variant="elevated" style={{ marginTop: 44, padding: 18, maxWidth: 420 }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '0.9rem', color: 'var(--foreground)' }}>Approval pipeline</span>
          <span className="status-badge status-approved">On track</span>
        </div>
        <div className="flex items-center" style={{ gap: 0 }}>
          {['Submitted', 'Review', 'Approved'].map((s, i, arr) => (
            <div key={s} className="flex items-center" style={{ flex: 1 }}>
              <div className="flex flex-col items-center gap-1.5" style={{ flex: 1 }}>
                <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'color-mix(in srgb, var(--primary) 16%, transparent)', border: '1px solid color-mix(in srgb, var(--primary) 40%, transparent)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CheckCircle2 size={15} />
                </span>
                <span style={{ fontSize: '0.68rem', color: 'var(--muted-foreground)' }}>{s}</span>
              </div>
              {i < arr.length - 1 && <div style={{ flex: '0 0 28px', height: 2, background: 'linear-gradient(90deg, var(--chart-1), var(--chart-2))', opacity: 0.5, marginBottom: 18 }} />}
            </div>
          ))}
        </div>
      </GlassCard>
    </aside>
  );
}

export default AuthBrandPanel;
