import React from 'react';
import { pad, sigs } from '../data';
import { Chip } from '../ui';
import { ink, surface } from '../tokens';

/** Signing and the audit trail. Every card here is explicitly planned, not live. */
export const Signatures: React.FC = () => (
  <section
    id="signatures"
    aria-labelledby="signatures-heading"
    style={{ position: 'relative', zIndex: 1, padding: '80px 24px 140px', scrollMarginTop: 96 }}
  >
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div
        data-reveal="0"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: 24,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ maxWidth: 720 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="lp-eyebrow">Signed and tracked</span>
            <Chip>Coming soon</Chip>
          </div>
          <h2
            id="signatures-heading"
            className="lp-display"
            style={{ margin: '14px 0 0', fontSize: 'clamp(40px, 5.2vw, 76px)', lineHeight: 1.02 }}
          >
            Sign off with <em className="lp-word">confidence.</em>
          </h2>
        </div>
        <p style={{ margin: 0, maxWidth: 420, fontSize: 17, lineHeight: 1.65, color: ink(0.62) }}>
          Digital signatures and a full history of every step are on the way. They will go well
          beyond a pasted picture of a signature.
        </p>
      </div>

      <div
        style={{
          marginTop: 48,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
          gap: 16,
        }}
      >
        {sigs.map((s, i) => (
          <div
            key={s.title}
            data-reveal={i}
            data-fx="stamp"
            className="liquid-glass"
            style={{
              borderRadius: 24,
              padding: 26,
              background: surface(0.6),
              minHeight: 210,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--lp-font-display)',
                fontStyle: 'italic',
                fontSize: 22,
                color: 'var(--lp-violet)',
              }}
            >
              {pad(i)}
            </span>
            <div style={{ fontFamily: 'var(--lp-font-display)', fontSize: 27, lineHeight: 1.1 }}>
              {s.title}
            </div>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: ink(0.6) }}>{s.desc}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default Signatures;
