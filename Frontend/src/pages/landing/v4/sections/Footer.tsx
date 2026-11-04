import React from 'react';
import { footer } from '../data';
import { PaperMark } from '../ui';
import { ink } from '../tokens';

export const Footer: React.FC = () => (
  <footer style={{ position: 'relative', zIndex: 1, padding: '40px 24px 48px' }}>
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
          gap: 40,
          paddingBottom: 40,
          borderBottom: `1px solid ${ink(0.08)}`,
        }}
      >
        <div style={{ gridColumn: 'span 2', maxWidth: 360 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <PaperMark w={20} h={24} glow={false} />
            <span style={{ fontFamily: 'var(--lp-font-display)', fontSize: 28 }}>DocFlow</span>
          </div>
          <p style={{ margin: '14px 0 0', fontSize: 15, lineHeight: 1.65, color: ink(0.55) }}>
            DocFlow helps your team move paperwork from draft to done, with clear steps, the right
            people, and a record of what happened.
          </p>
        </div>

        {footer.map((s) => (
          <nav key={s.title} aria-label={s.title} style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
            <div className="lp-eyebrow" style={{ color: ink(0.45) }}>
              {s.title}
            </div>
            {s.links.map((l) => (
              <a key={l.label} href={l.href} style={{ fontSize: 15, color: ink(0.75) }}>
                {l.label}
              </a>
            ))}
          </nav>
        ))}
      </div>

      <div
        style={{
          paddingTop: 24,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          fontSize: 14,
          color: ink(0.45),
        }}
      >
        <span>© 2026 DocFlow. All rights reserved.</span>
        <span>Built by Arul Prasanth K</span>
      </div>
    </div>
  </footer>
);

export default Footer;
