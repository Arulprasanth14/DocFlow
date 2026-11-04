import React from 'react';
import { navLinks } from '../data';
import { PaperMark } from '../ui';
import { ink, shadow } from '../tokens';

/**
 * Floating glass navbar. The engine writes `data-stuck` once the page has
 * scrolled 60px, and v4.css raises the panel's opacity in response.
 */
export const Nav: React.FC<{ wide: boolean }> = ({ wide }) => (
  <header style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 60, padding: '18px 20px' }}>
    <nav
      data-el="nav"
      className="liquid-glass"
      aria-label="Main"
      style={{
        maxWidth: 1120,
        margin: '0 auto',
        color: ink(1),
        borderRadius: 999,
        padding: '8px 8px 8px 22px',
        display: 'flex',
        boxShadow: `0 10px 40px ${shadow(0.12)}, inset 0 1px 1px rgb(255 255 255 / 0.8)`,
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 36 }}>
        <a href="#top" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PaperMark />
          <span
            style={{
              fontFamily: 'var(--lp-font-display)',
              fontSize: 26,
              letterSpacing: '-0.01em',
            }}
          >
            DocFlow
          </span>
        </a>

        {wide && (
          <div style={{ display: 'flex', gap: 26, fontSize: 15, color: ink(0.72) }}>
            {navLinks.map((l) => (
              <a key={l.href} href={l.href} style={{ color: 'inherit' }}>
                {l.label}
              </a>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <a href="/login" style={{ fontSize: 15, padding: '10px 14px', color: ink(0.85) }}>
          Login
        </a>
        <a
          href="/register"
          style={{
            fontSize: 15,
            fontWeight: 500,
            padding: '10px 20px',
            borderRadius: 999,
            background: 'var(--lp-grad-ramp)',
            color: 'var(--lp-cta-fg)',
          }}
        >
          Get started
        </a>
      </div>
    </nav>
  </header>
);

export default Nav;
