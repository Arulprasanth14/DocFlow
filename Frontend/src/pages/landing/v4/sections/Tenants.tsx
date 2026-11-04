import React from 'react';
import { callouts, tenants } from '../data';
import { Check } from '../ui';
import { ink, shadow, surface } from '../tokens';

/**
 * Tenancy, shown spatially: three workspaces that start stacked and slide
 * apart as you scroll, with walls rising between them. The engine drives the
 * separation, the walls and the drifting document chips.
 */
export const Tenants: React.FC = () => (
  <section
    id="tenants"
    aria-labelledby="tenants-heading"
    style={{ position: 'relative', zIndex: 1, padding: '80px 24px 120px', scrollMarginTop: 96 }}
  >
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div data-reveal="0" style={{ textAlign: 'center', maxWidth: 780, margin: '0 auto' }}>
        <div className="lp-eyebrow">Private by design</div>
        <h2
          id="tenants-heading"
          className="lp-display"
          style={{ margin: '14px 0 0', fontSize: 'clamp(38px, 4.8vw, 70px)', lineHeight: 1.03 }}
        >
          Every company gets its own <em className="lp-word">private space.</em>
        </h2>
        <p style={{ margin: '18px 0 0', fontSize: 17, lineHeight: 1.65, color: ink(0.66) }}>
          Your people and documents are kept separate from every other company.
        </p>
      </div>

      <div
        aria-hidden="true"
        style={{
          position: 'relative',
          height: 'min(460px, 78vw)',
          perspective: 1600,
          marginTop: 8,
        }}
      >
        <div
          data-el="tenrig"
          style={{
            position: 'absolute',
            left: '50%',
            top: '56%',
            width: 0,
            height: 0,
            transformStyle: 'preserve-3d',
            transform: 'rotateX(58deg)',
          }}
        >
          {[0, 1].map((i) => (
            <div
              key={i}
              data-wall=""
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: 110,
                height: 190,
                transformOrigin: '0 50%',
                borderRadius: '0 14px 14px 0',
                background:
                  'linear-gradient(90deg, rgb(125 211 252 / 0.55), rgb(196 181 253 / 0.12))',
                border: `1px solid ${surface(0.9)}`,
                opacity: 0,
              }}
            />
          ))}

          {tenants.map((t) => (
            <div
              key={t.name}
              data-plane=""
              style={{
                position: 'absolute',
                left: -130,
                top: -95,
                width: 260,
                height: 190,
                borderRadius: 22,
                background: `linear-gradient(160deg, ${surface(0.95)}, ${t.tint})`,
                border: `1.5px solid ${t.edge}`,
                boxShadow: `0 40px 60px ${shadow(0.18)}`,
                transformStyle: 'preserve-3d',
              }}
            >
              {/* Label stands upright out of the tilted plane. */}
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: '100%',
                  paddingBottom: 12,
                  display: 'flex',
                  justifyContent: 'center',
                  transformOrigin: '50% 100%',
                  transform: 'rotateX(-58deg)',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 14px',
                    borderRadius: 999,
                    background: surface(1),
                    border: `1px solid ${ink(0.1)}`,
                    boxShadow: `0 10px 24px ${shadow(0.14)}`,
                    fontSize: 15,
                    fontWeight: 500,
                    color: ink(1),
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span
                    style={{ width: 8, height: 8, borderRadius: '50%', background: t.dot }}
                  />
                  {t.name}
                </span>
              </div>

              {[0, 1, 2].map((j) => (
                <div
                  key={j}
                  data-chip=""
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: 38,
                    height: 48,
                    borderRadius: '5px 12px 5px 5px',
                    background: j === 1 ? t.chip : surface(1),
                    border: `1px solid ${t.edge}`,
                    boxShadow: `0 6px 12px ${shadow(0.15)}`,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div
        data-reveal="1"
        data-fx="float"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
          gap: 12,
        }}
      >
        {callouts.map((c) => (
          <div
            key={c}
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
              padding: '16px 18px',
              borderRadius: 18,
              background: surface(0.65),
              border: `1px solid ${surface(0.9)}`,
              boxShadow: `0 10px 30px ${shadow(0.08)}`,
              fontSize: 15,
              lineHeight: 1.5,
            }}
          >
            <Check stroke="var(--lp-accent)" />
            {c}
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default Tenants;
