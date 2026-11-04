import React, { useEffect, useRef, useState } from 'react';
import { bars, metrics } from '../data';
import { Chip } from '../ui';
import { ink, surface } from '../tokens';

/**
 * Where approvals slow down. The figures count up once on entry and the bars
 * grow in sequence; both are labelled "Sample data", because they are.
 */
export const Analytics: React.FC = () => {
  const sectionRef = useRef<HTMLElement>(null);
  const valueRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [grown, setGrown] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;

    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        setGrown(true);

        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        // Count each figure up from zero, preserving its formatting: "1,420+"
        // keeps the comma and the plus, "3.4 hrs" keeps one decimal and a unit.
        const specs = metrics.map((m, i) => {
          const match = m.value.match(/[\d,.]+/);
          const token = match?.[0] ?? '0';
          return {
            node: valueRefs.current[i],
            raw: m.value,
            token,
            num: parseFloat(token.replace(/,/g, '')),
            dec: (token.split('.')[1] ?? '').length,
            comma: token.includes(','),
          };
        });

        const t0 = performance.now();
        const dur = 1600;
        const ease = (x: number) => 1 - Math.pow(1 - x, 3);

        const step = (t: number) => {
          const p = ease(Math.min(1, (t - t0) / dur));
          for (const s of specs) {
            if (!s.node) continue;
            const v = s.num * p;
            const txt = s.comma
              ? Math.round(v).toLocaleString('en-US')
              : v.toFixed(s.dec);
            s.node.textContent = s.raw.replace(s.token, txt);
          }
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      },
      { threshold: 0.3 }
    );

    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section
      id="insights"
      ref={sectionRef}
      aria-labelledby="insights-heading"
      style={{ position: 'relative', zIndex: 1, padding: '80px 24px 140px', scrollMarginTop: 96 }}
    >
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <div data-reveal="0" style={{ textAlign: 'center', maxWidth: 720, margin: '0 auto' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
            <span className="lp-eyebrow">Insights</span>
            <Chip>Coming soon</Chip>
          </div>
          <h2
            id="insights-heading"
            className="lp-display"
            style={{ margin: '14px 0 0', fontSize: 'clamp(40px, 5.2vw, 76px)', lineHeight: 1.02 }}
          >
            See where things <em className="lp-word">slow down.</em>
          </h2>
          <p style={{ margin: '18px 0 0', fontSize: 17, lineHeight: 1.65, color: ink(0.62) }}>
            Spot slow steps early and keep approvals moving.
          </p>
        </div>

        <div
          data-reveal="1"
          data-fx="unfold"
          className="liquid-glass"
          style={{
            marginTop: 48,
            borderRadius: 32,
            padding: 'clamp(20px, 3vw, 40px)',
            background: surface(0.6),
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))',
              gap: 16,
            }}
          >
            {metrics.map((m, i) => (
              <div
                key={m.label}
                style={{
                  padding: 20,
                  borderRadius: 20,
                  background: ink(0.03),
                  border: `1px solid ${ink(0.07)}`,
                }}
              >
                <div style={{ fontSize: 14, color: ink(0.6) }}>{m.label}</div>
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: 'var(--lp-font-display)',
                    fontSize: 'clamp(40px, 4vw, 56px)',
                    lineHeight: 1,
                  }}
                >
                  <span
                    ref={(n) => {
                      valueRefs.current[i] = n;
                    }}
                  >
                    {m.value}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div
            aria-hidden="true"
            style={{
              marginTop: 32,
              height: 200,
              display: 'flex',
              alignItems: 'flex-end',
              gap: 'clamp(6px, 1.2vw, 14px)',
              padding: '0 4px',
              borderBottom: `1px solid ${ink(0.1)}`,
            }}
          >
            {bars.map((b, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: `${b}%`,
                  borderRadius: '8px 8px 2px 2px',
                  background:
                    'linear-gradient(to top, rgb(56 189 248 / 0.25), rgb(147 197 253 / 0.85))',
                  transformOrigin: '50% 100%',
                  transform: `scaleY(${grown ? 1 : 0.02})`,
                  transition: `transform 1s cubic-bezier(.16,1,.3,1) ${i * 60}ms`,
                }}
              />
            ))}
          </div>

          <div
            style={{
              marginTop: 14,
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 13,
              color: ink(0.5),
            }}
          >
            <span>Documents handled per week</span>
            <span>Sample data</span>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Analytics;
