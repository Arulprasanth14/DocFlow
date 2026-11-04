import React, { useState } from 'react';
import { docTypes, pad } from '../data';
import { Chip } from '../ui';
import { ink, shadow, surface } from '../tokens';

/**
 * Every document type, as cards dealt onto the page, plus the Template Studio
 * teaser with a working fill-the-blanks toggle.
 */
export const DocTypes: React.FC = () => {
  const [filled, setFilled] = useState(false);

  /** Cursor-following spotlight, written as CSS vars the card's gradient reads. */
  const spot = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  };

  const blank = (on: string, off: string, violet = false) => (
    <span
      style={{
        padding: '3px 10px',
        borderRadius: 8,
        border: `1px dashed ${violet ? 'rgb(196 181 253 / 0.6)' : 'rgb(125 211 252 / 0.6)'}`,
        background: violet ? 'rgb(196 181 253 / 0.08)' : 'rgb(125 211 252 / 0.08)',
        color: violet ? 'var(--lp-violet-ink)' : 'var(--lp-accent-deep)',
      }}
    >
      {filled ? on : off}
    </span>
  );

  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      style={{ position: 'relative', zIndex: 1, padding: '40px 24px 140px', scrollMarginTop: 96 }}
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
            marginBottom: 48,
          }}
        >
          <div>
            <div className="lp-eyebrow">All your documents</div>
            <h2
              id="features-heading"
              className="lp-display"
              style={{ margin: '14px 0 0', fontSize: 'clamp(40px, 5.2vw, 76px)', lineHeight: 1.02 }}
            >
              Every kind of document. <em className="lp-word">One place.</em>
            </h2>
          </div>
          <p style={{ margin: 0, maxWidth: 380, fontSize: 17, lineHeight: 1.65, color: ink(0.62) }}>
            Stop juggling emails, chats and folders. Keep all your paperwork in one home.
          </p>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
            gap: 16,
          }}
        >
          {docTypes.map((d, i) => (
            <div key={d.title} data-reveal={i % 3} data-fx="deal">
              <div
                className="liquid-glass lp-hover-lift"
                onMouseMove={spot}
                style={{
                  borderRadius: 24,
                  padding: 28,
                  minHeight: 230,
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  gap: 32,
                  background: `radial-gradient(380px circle at var(--mx, 50%) var(--my, -20%), rgb(125 211 252 / 0.13), transparent 60%), ${surface(0.6)}`,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="lp-eyebrow" style={{ color: ink(0.55) }}>
                    {d.category}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--lp-font-display)',
                      fontStyle: 'italic',
                      fontSize: 22,
                      color: 'var(--lp-accent)',
                    }}
                  >
                    {pad(i)}
                  </span>
                </div>
                <div>
                  <div
                    style={{
                      fontFamily: 'var(--lp-font-display)',
                      fontSize: 32,
                      lineHeight: 1.05,
                    }}
                  >
                    {d.title}
                  </div>
                  <p style={{ margin: '10px 0 0', fontSize: 16, lineHeight: 1.6, color: ink(0.62) }}>
                    {d.description}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <p data-reveal="0" style={{ margin: '28px 0 0', fontSize: 16, color: ink(0.55) }}>
          Also great for architecture reviews, signature collection, budget changes and everyday
          team approvals.
        </p>

        {/* ── Template Studio ──────────────────────────────────────────────── */}
        <div
          data-reveal="0"
          data-fx="unfold"
          className="liquid-glass"
          style={{
            marginTop: 56,
            borderRadius: 32,
            padding: 'clamp(24px, 4vw, 56px)',
            background:
              'linear-gradient(135deg, rgb(56 189 248 / 0.07), rgb(99 102 241 / 0.05) 50%, rgb(11 27 51 / 0.01))',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
            gap: 48,
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="lp-eyebrow">Template Studio</span>
              <Chip tone="amber">In progress</Chip>
            </div>
            <h3
              className="lp-display"
              style={{
                margin: '18px 0 0',
                fontSize: 'clamp(32px, 3.4vw, 48px)',
                lineHeight: 1.05,
                letterSpacing: '-0.02em',
              }}
            >
              Make a document in minutes with ready-made templates.
            </h3>
            <p style={{ margin: '18px 0 0', fontSize: 17, lineHeight: 1.65, color: ink(0.65) }}>
              Build a template once, with fixed text and fill-in blanks. Everyone else only fills in
              what matters. AI can help write the first draft.
            </p>
          </div>

          <div style={{ perspective: 1200 }}>
            <div
              style={{
                borderRadius: 20,
                background: surface(0.82),
                border: `1px solid ${ink(0.12)}`,
                boxShadow: `0 30px 70px ${shadow(0.14)}`,
                padding: 24,
                transform: 'rotateY(-10deg) rotateX(6deg)',
                display: 'grid',
                gap: 14,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--lp-font-display)', fontSize: 22 }}>
                  Purchase Order
                </span>
                <span style={{ fontSize: 13, color: ink(0.5) }}>Template</span>
              </div>
              <div style={{ fontSize: 15, lineHeight: 2.1, color: ink(0.7) }}>
                I would like to buy {blank('2 laptops', 'Item')} for the{' '}
                {blank('Design', 'Department')} team, at a cost of{' '}
                {blank('₹1,60,000', 'Amount', true)}.
              </div>
              <div aria-hidden="true" style={{ display: 'grid', gap: 6 }}>
                <div style={{ height: 7, borderRadius: 4, background: ink(0.1), width: '90%' }} />
                <div style={{ height: 7, borderRadius: 4, background: ink(0.1), width: '70%' }} />
              </div>
              <button
                type="button"
                onClick={() => setFilled((v) => !v)}
                className="lp-press"
                style={{
                  justifySelf: 'start',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 16px',
                  borderRadius: 999,
                  border: '1px solid rgb(196 181 253 / 0.4)',
                  background: 'rgb(196 181 253 / 0.12)',
                  color: 'var(--lp-violet-ink)',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    transform: 'rotate(45deg)',
                    background: 'var(--lp-ramp-3)',
                  }}
                />
                {filled ? 'Clear blanks' : 'Draft with AI'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default DocTypes;
