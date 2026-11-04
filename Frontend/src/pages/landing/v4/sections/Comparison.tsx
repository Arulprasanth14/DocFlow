import React from 'react';
import { compare } from '../data';
import { ink, surface } from '../tokens';

/** DocFlow against the tools teams usually end up with. */
export const Comparison: React.FC = () => {
  const cols = '1fr 1.3fr 1.3fr';

  return (
    <section
      id="compare"
      aria-labelledby="compare-heading"
      style={{ position: 'relative', zIndex: 1, padding: '80px 24px 140px', scrollMarginTop: 96 }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div data-reveal="0" style={{ textAlign: 'center' }}>
          <div className="lp-eyebrow">Why DocFlow</div>
          <h2
            id="compare-heading"
            className="lp-display"
            style={{ margin: '14px 0 0', fontSize: 'clamp(40px, 5.2vw, 76px)', lineHeight: 1.02 }}
          >
            Simple to use. <em className="lp-word">Built for serious work.</em>
          </h2>
          <p style={{ margin: '18px 0 0', fontSize: 17, color: ink(0.62) }}>
            How DocFlow compares with typical workflow tools.
          </p>
        </div>

        <div
          data-reveal="1"
          className="liquid-glass"
          style={{
            marginTop: 48,
            borderRadius: 28,
            background: surface(0.6),
            overflowX: 'auto',
          }}
        >
          {/* A real table, not divs with ARIA roles: this is genuinely tabular
              data, so screen readers get row/column semantics for free. The
              rows are grid containers to keep the original column layout. */}
          <table
            aria-labelledby="compare-heading"
            style={{ minWidth: 640, width: '100%', borderCollapse: 'collapse' }}
          >
            <thead>
              <tr
                className="lp-eyebrow"
                style={{
                  display: 'grid',
                  gridTemplateColumns: cols,
                  gap: 20,
                  padding: '20px 28px',
                  color: ink(0.5),
                  borderBottom: `1px solid ${ink(0.08)}`,
                }}
              >
                <th scope="col" style={{ textAlign: 'left', fontWeight: 'inherit' }}>
                  Capability
                </th>
                <th scope="col" style={{ textAlign: 'left', fontWeight: 'inherit' }}>
                  Typical tools
                </th>
                <th
                  scope="col"
                  style={{
                    textAlign: 'left',
                    fontWeight: 'inherit',
                    color: 'var(--lp-accent-deep)',
                  }}
                >
                  DocFlow
                </th>
              </tr>
            </thead>
            <tbody>
              {compare.map((r) => (
                <tr
                  key={r.capability}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: cols,
                    gap: 20,
                    padding: '20px 28px',
                    borderBottom: `1px solid ${ink(0.06)}`,
                    background: r.h ? 'rgb(2 132 199 / 0.06)' : 'transparent',
                    fontSize: 16,
                    lineHeight: 1.5,
                  }}
                >
                  <th
                    scope="row"
                    style={{
                      textAlign: 'left',
                      fontWeight: 400,
                      fontFamily: 'var(--lp-font-display)',
                      fontSize: 22,
                      lineHeight: 1.2,
                    }}
                  >
                    {r.capability}
                  </th>
                  <td style={{ color: ink(0.5) }}>{r.typicalTools}</td>
                  <td style={{ color: ink(1) }}>{r.docFlow}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};

export default Comparison;
