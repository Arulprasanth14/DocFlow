import React from 'react';
import { pad, pains } from '../data';
import { ink } from '../tokens';

/**
 * The seven concrete failures, each torn in along a ragged edge (`tear`
 * preset). The engine groups them by parent so a row tears as one gesture.
 */
export const PainPoints: React.FC = () => (
  <section
    aria-label="What goes wrong with paperwork today"
    style={{ position: 'relative', zIndex: 1, padding: '40px 24px 140px' }}
  >
    <div
      style={{
        maxWidth: 1120,
        margin: '0 auto',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
        gap: '0 40px',
      }}
    >
      {pains.map((t, i) => (
        <div
          key={t}
          data-reveal={i % 3}
          data-fx="tear"
          style={{
            display: 'grid',
            gridTemplateColumns: '48px 1fr',
            gap: 12,
            padding: '24px 0',
            borderTop: `1px solid ${ink(0.1)}`,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--lp-font-display)',
              fontStyle: 'italic',
              fontSize: 26,
              color: 'var(--lp-accent)',
            }}
          >
            {pad(i)}
          </span>
          <span style={{ fontSize: 17, lineHeight: 1.6, color: ink(0.75) }}>{t}</span>
        </div>
      ))}
    </div>
  </section>
);

export default PainPoints;
