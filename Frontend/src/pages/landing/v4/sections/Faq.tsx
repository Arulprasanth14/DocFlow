import React, { useState } from 'react';
import { faqs } from '../data';
import { Plus } from '../ui';
import { ink } from '../tokens';

/**
 * Accordion. Rows animate on `grid-template-rows: 0fr → 1fr`, so the answer
 * keeps its natural height and nothing has to be measured in JS.
 */
export const Faq: React.FC = () => {
  const [open, setOpen] = useState(0);

  return (
    <section
      id="faq"
      aria-labelledby="faq-heading"
      style={{ position: 'relative', zIndex: 1, padding: '80px 24px 140px', scrollMarginTop: 96 }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
          gap: 48,
          alignItems: 'start',
        }}
      >
        <div data-reveal="0" style={{ position: 'sticky', top: 120 }}>
          <div className="lp-eyebrow">Questions</div>
          <h2
            id="faq-heading"
            className="lp-display"
            style={{ margin: '14px 0 0', fontSize: 'clamp(40px, 4.6vw, 66px)', lineHeight: 1.02 }}
          >
            Frequently asked <em className="lp-word">questions</em>
          </h2>
          <p style={{ margin: '18px 0 0', fontSize: 17, color: ink(0.62) }}>
            Quick answers about how DocFlow works.
          </p>
        </div>

        <div style={{ display: 'grid' }}>
          {faqs.map((f, i) => {
            const isOpen = open === i;
            return (
              <div
                key={f.question}
                data-reveal={i}
                data-fx="unfold"
                style={{ borderTop: `1px solid ${ink(0.1)}` }}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  aria-expanded={isOpen}
                  aria-controls={`faq-panel-${i}`}
                  id={`faq-button-${i}`}
                  style={{
                    width: '100%',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 16,
                    padding: '22px 0',
                    background: 'none',
                    border: 'none',
                    color: ink(1),
                    textAlign: 'left',
                    fontFamily: 'var(--lp-font-display)',
                    fontSize: 'clamp(21px, 1.8vw, 25px)',
                    lineHeight: 1.25,
                    cursor: 'pointer',
                  }}
                >
                  <span>{f.question}</span>
                  <span
                    aria-hidden="true"
                    style={{
                      flexShrink: 0,
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      border: `1px solid ${ink(0.18)}`,
                      display: 'grid',
                      placeItems: 'center',
                      transform: `rotate(${isOpen ? '45deg' : '0deg'})`,
                      transition: 'transform .4s cubic-bezier(.16,1,.3,1)',
                    }}
                  >
                    <Plus />
                  </span>
                </button>

                <section
                  id={`faq-panel-${i}`}
                  aria-labelledby={`faq-button-${i}`}
                  style={{
                    display: 'grid',
                    gridTemplateRows: isOpen ? '1fr' : '0fr',
                    transition: 'grid-template-rows .45s cubic-bezier(.16,1,.3,1)',
                  }}
                >
                  <div style={{ overflow: 'hidden' }}>
                    <p
                      style={{
                        margin: '0 48px 24px 0',
                        fontSize: 16,
                        lineHeight: 1.65,
                        color: ink(0.65),
                      }}
                    >
                      {f.answer}
                    </p>
                  </div>
                </section>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default Faq;
