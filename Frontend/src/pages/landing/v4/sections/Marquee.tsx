import React, { useEffect, useRef } from 'react';
import { marquee } from '../data';
import { ink } from '../tokens';

/**
 * Continuously scrolling strip of document types. The engine advances it at
 * 42px/s and wraps at half the track width, so the list is rendered twice.
 *
 * Hover and focus pause it. Those listeners are attached imperatively rather
 * than as JSX props on purpose: pausing is a cosmetic courtesy, not an
 * interaction, and putting mouse handlers on a non-interactive element would
 * imply an affordance that is not there. Nothing is lost if they never fire —
 * the strip is decorative and every item also appears elsewhere on the page.
 */
export const Marquee: React.FC = () => {
  const section = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = section.current;
    if (!el) return;

    const set = (paused: boolean) => {
      if (track.current) track.current.dataset.paused = paused ? '1' : '0';
    };
    const on = () => set(true);
    const off = () => set(false);

    el.addEventListener('mouseenter', on, { passive: true });
    el.addEventListener('mouseleave', off, { passive: true });
    el.addEventListener('focusin', on);
    el.addEventListener('focusout', off);
    return () => {
      el.removeEventListener('mouseenter', on);
      el.removeEventListener('mouseleave', off);
      el.removeEventListener('focusin', on);
      el.removeEventListener('focusout', off);
    };
  }, []);

  return (
    <section
      ref={section}
      aria-label="Document types DocFlow handles"
      className="lp-marquee-mask"
      style={{
        position: 'relative',
        zIndex: 1,
        borderTop: `1px solid ${ink(0.08)}`,
        borderBottom: `1px solid ${ink(0.08)}`,
        padding: '26px 0',
        overflow: 'hidden',
      }}
    >
      <div
        ref={track}
        data-el="marquee"
        style={{ display: 'flex', gap: 48, width: 'max-content', willChange: 'transform' }}
      >
        {[...marquee, ...marquee].map((m, i) => (
          <div
            key={`${m}-${i}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 48,
              fontFamily: 'var(--lp-font-display)',
              fontSize: 30,
              color: ink(0.75),
              whiteSpace: 'nowrap',
            }}
          >
            <span>{m}</span>
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--lp-ramp-1)',
                opacity: 0.7,
              }}
            />
          </div>
        ))}
      </div>
    </section>
  );
};

export default Marquee;
