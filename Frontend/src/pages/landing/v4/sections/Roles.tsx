import React, { useState } from 'react';
import { ladder, roles } from '../data';
import { Check, Cross } from '../ui';
import { ink, surface } from '../tokens';

/**
 * Six roles, each with what it can and cannot do, plus the routing argument:
 * a document goes to the person who can approve it, not up a chain.
 */
export const Roles: React.FC = () => {
  const [active, setActive] = useState(0);
  const role = roles[active];

  return (
    <section
      id="roles"
      aria-labelledby="roles-heading"
      style={{ position: 'relative', zIndex: 1, padding: '80px 24px 140px', scrollMarginTop: 96 }}
    >
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <div data-reveal="0" style={{ textAlign: 'center', maxWidth: 760, margin: '0 auto' }}>
          <div className="lp-eyebrow">Who can do what</div>
          <h2
            id="roles-heading"
            className="lp-display"
            style={{ margin: '14px 0 0', fontSize: 'clamp(40px, 5.2vw, 76px)', lineHeight: 1.02 }}
          >
            The right person. <em className="lp-word">The right access.</em>
          </h2>
          <p style={{ margin: '18px 0 0', fontSize: 17, lineHeight: 1.65, color: ink(0.62) }}>
            Everyone in your organization gets only the access their role needs.
          </p>
        </div>

        <div
          data-reveal="1"
          data-fx="pop"
          role="tablist"
          aria-label="Roles"
          style={{
            marginTop: 44,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {roles.map((r, i) => (
            <button
              key={r.title}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className="lp-press"
              style={{
                padding: '10px 18px',
                borderRadius: 999,
                fontFamily: 'inherit',
                fontSize: 15,
                cursor: 'pointer',
                background: i === active ? ink(1) : surface(0.6),
                color: i === active ? 'var(--lp-page)' : ink(1),
                border: `1px solid ${i === active ? ink(1) : ink(0.14)}`,
                transition: 'all .3s',
              }}
            >
              {r.title}
            </button>
          ))}
        </div>

        <div
          data-reveal="2"
          data-fx="unfold"
          className="liquid-glass"
          style={{
            marginTop: 28,
            borderRadius: 32,
            padding: 'clamp(24px, 4vw, 52px)',
            background: surface(0.6),
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
            gap: 40,
          }}
        >
          <div>
            <span
              style={{
                fontSize: 13,
                padding: '5px 12px',
                borderRadius: 999,
                background: 'rgb(125 211 252 / 0.1)',
                color: 'var(--lp-accent-deep)',
                border: '1px solid rgb(125 211 252 / 0.25)',
              }}
            >
              {role.badge}
            </span>
            <div
              style={{
                marginTop: 18,
                fontFamily: 'var(--lp-font-display)',
                fontSize: 'clamp(34px, 3.6vw, 50px)',
                lineHeight: 1.02,
              }}
            >
              {role.title}
            </div>
            <p style={{ margin: '14px 0 0', fontSize: 17, lineHeight: 1.6, color: ink(0.65) }}>
              {role.tagline}
            </p>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            <div className="lp-eyebrow" style={{ color: 'var(--lp-ok-label)' }}>
              Can
            </div>
            {role.can.map((c) => (
              <div key={c} style={{ display: 'flex', gap: 12, fontSize: 16, lineHeight: 1.5 }}>
                <Check />
                <span>{c}</span>
              </div>
            ))}

            <div className="lp-eyebrow" style={{ marginTop: 12, color: 'var(--lp-no-label)' }}>
              Cannot
            </div>
            {role.cannot.map((c) => (
              <div
                key={c}
                style={{ display: 'flex', gap: 12, fontSize: 16, lineHeight: 1.5, color: ink(0.6) }}
              >
                <Cross />
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── routing: ladder vs. straight to the approver ──────────────────── */}
        <div
          style={{
            marginTop: 72,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
            gap: 48,
            alignItems: 'center',
          }}
        >
          <div data-reveal="0">
            <div className="lp-eyebrow">Person to person, not up a ladder</div>
            <h3
              className="lp-display"
              style={{
                margin: '14px 0 0',
                fontSize: 'clamp(32px, 3.4vw, 48px)',
                lineHeight: 1.05,
                letterSpacing: '-0.02em',
              }}
            >
              Documents go to the right person, not up a ladder.
            </h3>
            <p style={{ margin: '16px 0 0', fontSize: 17, lineHeight: 1.65, color: ink(0.65) }}>
              Many tools push every request up a fixed chain of bosses. DocFlow sends it to the
              person who can actually approve it, based on roles and workflow steps.
            </p>
          </div>

          <div
            data-reveal="1"
            data-fx="flip"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}
          >
            <div
              style={{
                borderRadius: 24,
                border: `1px solid ${ink(0.08)}`,
                padding: 22,
                display: 'grid',
                gap: 8,
                justifyItems: 'center',
                background: surface(0.6),
              }}
            >
              <div style={{ fontSize: 13, color: ink(0.5), marginBottom: 6 }}>Typical tools</div>
              {ladder.map((l, i) => (
                <div key={l} style={{ display: 'grid', justifyItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      padding: '7px 14px',
                      borderRadius: 999,
                      border: `1px solid ${ink(0.14)}`,
                      fontSize: 14,
                      color: ink(0.6),
                    }}
                  >
                    {l}
                  </span>
                  {i < ladder.length - 1 && (
                    <span
                      aria-hidden="true"
                      style={{ width: 1, height: 10, background: ink(0.18) }}
                    />
                  )}
                </div>
              ))}
              <span style={{ fontSize: 13, color: 'var(--lp-no-label)' }}>Days of waiting</span>
            </div>

            <div
              style={{
                borderRadius: 24,
                border: '1px solid rgb(125 211 252 / 0.28)',
                padding: 22,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                background:
                  'radial-gradient(circle at 50% 50%, rgb(56 189 248 / 0.12), transparent 70%)',
              }}
            >
              <div style={{ fontSize: 13, color: 'var(--lp-accent-deep)', marginBottom: 6 }}>
                DocFlow
              </div>
              <span
                style={{
                  padding: '9px 18px',
                  borderRadius: 999,
                  background: ink(0.08),
                  border: `1px solid ${ink(0.2)}`,
                  fontSize: 15,
                }}
              >
                You
              </span>
              <span
                aria-hidden="true"
                style={{
                  width: 2,
                  height: 90,
                  borderRadius: 2,
                  background: 'linear-gradient(var(--lp-ramp-1), var(--lp-ramp-3))',
                  boxShadow: '0 0 16px rgb(125 211 252 / 0.6)',
                }}
              />
              <span
                style={{
                  padding: '9px 18px',
                  borderRadius: 999,
                  background: 'var(--lp-grad-ramp)',
                  color: 'var(--lp-cta-fg)',
                  fontSize: 15,
                  fontWeight: 500,
                }}
              >
                The right approver
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Roles;
