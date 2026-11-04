import React, { useState } from 'react';
import { HERO_VIDEO, pillars } from '../data';
import { ArrowDown, ArrowRight } from '../ui';
import { ink, surface } from '../tokens';

interface HeroProps {
  /** Show the floating status cards (wide viewports only). */
  showCards: boolean;
  /** False once the video has failed or is missing — switches to the fallback. */
  videoOk: boolean;
}

const CARDS = [
  {
    dot: '#6EE7B7',
    status: 'Approved',
    title: 'Leave Request',
    meta: 'Karthik · Manager',
    pos: { left: '5%', top: '36%', width: 220 },
  },
  {
    dot: '#FCD34D',
    status: 'Pending',
    title: 'Purchase Order',
    meta: 'In the approver’s queue',
    pos: { right: '5%', top: '26%', width: 230 },
  },
  {
    dot: '#C4B5FD',
    status: 'Coming soon',
    title: 'Digital signature',
    meta: 'Tied to who signed, and when',
    pos: { right: '11%', bottom: '20%', width: 230 },
  },
];

export const Hero: React.FC<HeroProps> = ({ showCards, videoOk }) => {
  const [sent, setSent] = useState(false);

  // Over video the hero is white-on-media. Without it, the section has to read
  // as a normal light (or dark) section instead, or the text would be white on
  // a pale page.
  const onMedia = videoOk;
  const fg = onMedia ? '#fff' : ink(1);
  const fgSoft = onMedia ? 'rgb(255 255 255 / 0.88)' : ink(0.68);
  // Densities are tuned for no backdrop blur behind them (see .liquid-glass--blur
  // in v4.css): over footage these need to carry the contrast on their own.
  const panel = onMedia ? 'rgb(0 0 0 / 0.46)' : surface(0.72);

  return (
    <section
      id="top"
      data-el="hero"
      aria-labelledby="hero-heading"
      style={{
        color: fg,
        position: 'relative',
        zIndex: 1,
        minHeight: '100svh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <video
        data-el="hero-video"
        src={HERO_VIDEO}
        muted
        autoPlay
        playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: 'bottom',
          opacity: 0,
          transformOrigin: '50% 70%',
        }}
      />

      {/* Scrim: holds the white type legible over the footage, and blends the
          bottom edge into the page colour. Only drawn when there is footage. */}
      {onMedia && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background:
              'radial-gradient(ellipse 85% 65% at 50% 46%, rgb(0 0 0 / 0.72), rgb(0 0 0 / 0.3) 70%, rgb(0 0 0 / 0.12) 100%),' +
              'linear-gradient(180deg, rgb(0 0 0 / 0.55) 0%, rgb(0 0 0 / 0.18) 30%, rgb(0 0 0 / 0.3) 72%, var(--lp-page) 100%)',
          }}
        />
      )}

      {showCards && (
        <div
          data-el="hero-cards"
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            pointerEvents: 'none',
            perspective: 1200,
          }}
        >
          {CARDS.map((c) => (
            <div
              key={c.title}
              data-hc=""
              style={{
                position: 'absolute',
                ...c.pos,
                padding: '16px 18px',
                borderRadius: 18,
                background: onMedia ? 'rgb(8 16 34 / 0.58)' : surface(0.7),
                border: onMedia ? '1px solid rgb(255 255 255 / 0.22)' : `1px solid ${ink(0.1)}`,
                // No backdrop-filter: these transform every frame over a
                // playing video, so the blur re-sampled continuously. A
                // slightly denser background reads the same at a glance.
                willChange: 'transform, opacity',
                boxShadow: '0 24px 60px rgb(0 0 0 / 0.3)',
                color: fg,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: c.dot,
                    boxShadow: `0 0 10px ${c.dot}`,
                  }}
                />
                {c.status}
              </div>
              <div
                style={{
                  marginTop: 8,
                  fontFamily: 'var(--lp-font-display)',
                  fontSize: 24,
                  lineHeight: 1.1,
                }}
              >
                {c.title}
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: fgSoft }}>{c.meta}</div>
            </div>
          ))}
        </div>
      )}

      <div
        data-el="hero-content"
        style={{
          position: 'relative',
          zIndex: 2,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '128px 24px 48px',
          textShadow: onMedia ? '0 2px 30px rgb(0 0 0 / 0.5)' : undefined,
        }}
      >
        <div
          className={`liquid-glass${onMedia ? ' liquid-glass--blur' : ''}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            borderRadius: 999,
            padding: '8px 16px',
            background: onMedia ? 'rgb(0 0 0 / 0.42)' : surface(0.7),
            fontSize: 14,
            color: fgSoft,
            textShadow: 'none',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#6EE7B7',
              boxShadow: '0 0 12px #6EE7B7',
            }}
          />
          <span>Send, approve and track documents in one place</span>
        </div>

        <h1
          id="hero-heading"
          className="lp-display"
          style={{
            margin: '28px 0 0',
            fontSize: 'clamp(52px, min(10.5vw, 15svh), 148px)',
            lineHeight: 0.94,
            maxWidth: '12ch',
            textWrap: 'balance',
          }}
        >
          Paperwork, minus the{' '}
          <em className="lp-word lp-word-light">paper&nbsp;chase.</em>
        </h1>

        <p
          style={{
            margin: '28px 0 0',
            maxWidth: 620,
            fontSize: 'clamp(17px, 1.25vw, 19px)',
            lineHeight: 1.6,
            color: fgSoft,
            textWrap: 'pretty',
          }}
        >
          Leave requests, purchase orders, claims, contracts, HR letters. DocFlow takes each one
          from draft to done. It reaches the right people, gets approved, and stays tracked in one
          place.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.currentTarget.reset();
            setSent(true);
          }}
          className={`liquid-glass${onMedia ? ' liquid-glass--blur' : ''}`}
          style={{
            marginTop: 36,
            width: '100%',
            maxWidth: 540,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            padding: '6px 6px 6px 24px',
            boxSizing: 'border-box',
            background: panel,
            textShadow: 'none',
          }}
        >
          <input
            type="email"
            required
            placeholder={sent ? 'Thanks, we’ll be in touch.' : 'Enter your work email'}
            aria-label="Work email"
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: fg,
              fontFamily: 'inherit',
              fontSize: 16,
              padding: '12px 0',
            }}
          />
          <button
            type="submit"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 46,
              padding: '0 18px 0 20px',
              borderRadius: 999,
              border: 'none',
              background: onMedia ? '#fff' : 'var(--lp-grad-ramp)',
              color: 'var(--lp-cta-fg)',
              fontFamily: 'inherit',
              fontSize: 15,
              fontWeight: 500,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Get started
            <ArrowRight />
          </button>
        </form>

        <div
          style={{
            marginTop: 22,
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            justifyContent: 'center',
            textShadow: 'none',
          }}
        >
          <a
            href="mailto:demo@docflow.app?subject=DocFlow%20Demo%20Request"
            className={`liquid-glass${onMedia ? ' liquid-glass--blur' : ''}`}
            style={{
              borderRadius: 999,
              padding: '11px 22px',
              fontSize: 15,
              background: onMedia ? 'rgb(0 0 0 / 0.42)' : surface(0.7),
            }}
          >
            Book a demo
          </a>
          <a
            href="#problem"
            style={{
              borderRadius: 999,
              padding: '11px 18px',
              fontSize: 15,
              color: fgSoft,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            See how it works
            <ArrowDown />
          </a>
        </div>
      </div>

      <div
        style={{
          position: 'relative',
          zIndex: 2,
          display: 'flex',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: 8,
          padding: '0 24px 32px',
          maxWidth: 1100,
          margin: '0 auto',
        }}
      >
        {pillars.map((p) => (
          <span
            key={p}
            style={{
              fontSize: 13,
              padding: '7px 14px',
              borderRadius: 999,
              background: onMedia ? 'rgb(0 0 0 / 0.55)' : surface(0.75),
              border: onMedia ? '1px solid rgb(255 255 255 / 0.12)' : `1px solid ${ink(0.1)}`,
              color: onMedia ? 'rgb(255 255 255 / 0.8)' : ink(0.7),
            }}
          >
            {p}
          </span>
        ))}
      </div>
    </section>
  );
};

export default Hero;
