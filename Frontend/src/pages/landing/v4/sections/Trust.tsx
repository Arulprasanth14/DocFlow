import React from 'react';
import { pad, trust } from '../data';
import { ink } from '../tokens';

/**
 * What DocFlow is actually built on. No certification claims — every line here
 * is a fact about the stack, which is the point the heading makes.
 */
export const Trust: React.FC = () => (
  <section
    id="security"
    aria-labelledby="security-heading"
    style={{ position: 'relative', zIndex: 1, padding: '80px 24px 140px', scrollMarginTop: 96 }}
  >
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div data-reveal="0" style={{ maxWidth: 760 }}>
        <div className="lp-eyebrow">Security</div>
        <h2
          id="security-heading"
          className="lp-display"
          style={{ margin: '14px 0 0', fontSize: 'clamp(40px, 5.2vw, 76px)', lineHeight: 1.02 }}
        >
          Built on solid, <em className="lp-word">honest</em> foundations.
        </h2>
        <p style={{ margin: '18px 0 0', fontSize: 17, lineHeight: 1.65, color: ink(0.62) }}>
          No big certification claims. Just clear facts about how DocFlow is built.
        </p>
      </div>

      <div
        style={{
          marginTop: 48,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
          gap: '0 40px',
        }}
      >
        {trust.map((p, i) => (
          <div
            key={p.title}
            data-reveal={i % 2}
            data-fx="float"
            style={{
              padding: '26px 0',
              borderTop: `1px solid ${ink(0.1)}`,
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
              <span
                style={{
                  fontFamily: 'var(--lp-font-display)',
                  fontStyle: 'italic',
                  fontSize: 20,
                  color: 'var(--lp-accent)',
                }}
              >
                {pad(i)}
              </span>
              <span style={{ fontFamily: 'var(--lp-font-display)', fontSize: 27 }}>{p.title}</span>
            </div>
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.6, color: ink(0.6) }}>{p.desc}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default Trust;
