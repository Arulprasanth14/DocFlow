import React from 'react';
import { flowSteps, quotes } from '../data';
import { ink, shadow, surface } from '../tokens';

/**
 * The turn. Four scattered complaints drift in and collapse into the middle,
 * the "paperwork gets messy" headline fades out, and the answer — one visible
 * flow — fades in behind it.
 *
 * 300svh of scroll drives a single sticky viewport; the engine owns every
 * transform here.
 */
export const Problem: React.FC = () => (
  <section
    id="problem"
    data-el="problem"
    aria-labelledby="problem-heading"
    style={{ position: 'relative', zIndex: 1, height: '300svh' }}
  >
    <div
      style={{
        position: 'sticky',
        top: 0,
        height: '100svh',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {quotes.map((q) => (
        <div
          key={q.text}
          data-q=""
          className="liquid-glass"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 'min(300px, 62vw)',
            marginLeft: 'calc(min(300px, 62vw) / -2)',
            marginTop: -48,
            borderRadius: 20,
            padding: '18px 20px',
            background: surface(0.82),
            boxShadow: `0 24px 60px ${shadow(0.14)}, inset 0 1px 1px ${ink(0.1)}`,
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--lp-font-display)',
              fontSize: 'clamp(20px, 2vw, 25px)',
              lineHeight: 1.2,
            }}
          >
            “{q.text}”
          </div>
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              color: ink(0.6),
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: 'linear-gradient(135deg,#334155,#64748B)',
              }}
            />
            {q.sender}
          </div>
        </div>
      ))}

      <div
        data-el="probA"
        style={{ position: 'relative', maxWidth: 680, textAlign: 'center', padding: '0 24px' }}
      >
        <div className="lp-eyebrow">Sound familiar?</div>
        <h2
          id="problem-heading"
          className="lp-display"
          style={{
            margin: '18px 0 0',
            fontSize: 'clamp(44px, 6vw, 88px)',
            lineHeight: 1,
          }}
        >
          Paperwork gets <em className="lp-word lp-word-messy">messy</em> fast.
        </h2>
        <p
          style={{
            margin: '20px auto 0',
            maxWidth: 460,
            fontSize: 18,
            lineHeight: 1.65,
            color: ink(0.65),
          }}
        >
          It is rarely the document that is the problem. It is the handoff.
        </p>
      </div>

      <div
        data-el="probB"
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '0 24px',
          opacity: 0,
          pointerEvents: 'none',
        }}
      >
        <h2
          className="lp-display"
          style={{ margin: 0, fontSize: 'clamp(40px, 5.4vw, 80px)', lineHeight: 1.02, maxWidth: '14ch' }}
        >
          One flow. Every step <em className="lp-word">visible.</em>
        </h2>
        <p style={{ margin: '16px 0 0', fontSize: 18, color: ink(0.65) }}>No more guessing.</p>

        <div
          className="liquid-glass"
          style={{
            marginTop: 40,
            borderRadius: 999,
            padding: 10,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 6,
            background: surface(0.82),
          }}
        >
          {flowSteps.map((f) => (
            <div
              key={f.n}
              data-fs=""
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 16px',
                borderRadius: 999,
                background: ink(0.05),
                fontSize: 15,
                opacity: 0.3,
                transition: 'opacity .4s',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: f.c,
                  boxShadow: `0 0 10px ${f.c}`,
                }}
              />
              {f.n}
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);

export default Problem;
