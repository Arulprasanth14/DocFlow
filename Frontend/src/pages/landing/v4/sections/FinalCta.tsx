import React from 'react';
import { HERO_VIDEO } from '../data';
import { ink, shadow, surface } from '../tokens';

/** Closing ask, stamped into place over the footage. */
export const FinalCta: React.FC<{ videoOk: boolean }> = ({ videoOk }) => {
  const onMedia = videoOk;
  const fg = onMedia ? '#fff' : ink(1);
  const fgSoft = onMedia ? 'rgb(255 255 255 / 0.85)' : ink(0.65);

  return (
    <section
      aria-labelledby="final-cta-heading"
      style={{ position: 'relative', zIndex: 1, padding: '40px 24px 100px' }}
    >
      <div
        style={{
          position: 'relative',
          maxWidth: 1200,
          margin: '0 auto',
          color: fg,
          borderRadius: 40,
          overflow: 'hidden',
          minHeight: 560,
          boxShadow: `0 40px 120px ${shadow(0.25)}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '80px 24px',
          boxSizing: 'border-box',
          background: 'var(--lp-aur-base)',
        }}
      >
        <video
          data-lazyvid=""
          src={HERO_VIDEO}
          muted
          loop
          playsInline
          preload="metadata"
          aria-hidden="true"
          tabIndex={-1}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: onMedia ? 0.55 : 0,
            transform: 'scale(1.15)',
            transition: 'opacity .5s',
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background: onMedia
              ? 'radial-gradient(ellipse at center, rgb(0 0 0 / 0.4), rgb(0 0 0 / 0.85) 80%)'
              : `radial-gradient(ellipse at center, ${surface(0.2)}, ${surface(0.75)} 80%)`,
          }}
        />

        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: '70%',
            height: '70%',
            transform: 'translate(-50%,-50%)',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgb(56 189 248 / 0.22), transparent 65%)',
            filter: 'blur(40px)',
          }}
        />

        <div data-reveal="0" data-fx="stamp" style={{ position: 'relative' }}>
          <h2
            id="final-cta-heading"
            className="lp-display"
            style={{
              margin: 0,
              fontSize: 'clamp(48px, 7vw, 112px)',
              lineHeight: 0.98,
              maxWidth: '12ch',
              textShadow: onMedia ? '0 2px 30px rgb(0 0 0 / 0.5)' : undefined,
            }}
          >
            Ready to end the <em className="lp-word lp-word-light">paper chase?</em>
          </h2>
          <p
            style={{
              margin: '22px auto 0',
              maxWidth: 480,
              fontSize: 18,
              lineHeight: 1.6,
              color: fgSoft,
            }}
          >
            Send, approve and track every document in one simple place.
          </p>

          <div
            style={{
              marginTop: 32,
              display: 'flex',
              gap: 10,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <a
              href="/register"
              className="lp-hover-rise"
              style={{
                padding: '15px 28px',
                borderRadius: 999,
                background: 'var(--lp-grad-ramp)',
                color: 'var(--lp-cta-fg)',
                fontSize: 16,
                fontWeight: 500,
                boxShadow: '0 10px 40px rgb(125 211 252 / 0.35)',
              }}
            >
              Get started
            </a>
            <a
              href="mailto:demo@docflow.app?subject=DocFlow%20Demo%20Request"
              className="liquid-glass"
              style={{
                padding: '15px 28px',
                borderRadius: 999,
                fontSize: 16,
                background: onMedia ? 'rgb(0 0 0 / 0.35)' : surface(0.75),
              }}
            >
              Book a demo
            </a>
          </div>

          <div style={{ marginTop: 28, fontSize: 14, color: onMedia ? 'rgb(255 255 255 / 0.6)' : ink(0.55) }}>
            One simple portal · A private space for every company
          </div>
        </div>
      </div>
    </section>
  );
};

export default FinalCta;
