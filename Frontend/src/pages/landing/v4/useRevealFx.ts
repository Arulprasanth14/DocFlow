import { useEffect } from 'react';

/**
 * DocFlow Landing v4 — entrance reveal engine.
 *
 * Port of `setupReveal()` from the design. Elements opt in with
 * `data-reveal="<stagger index>"` and `data-fx="<preset>"`; the engine writes
 * the from-state and a transition inline, then flips to the to-state when the
 * element crosses into view.
 *
 * Eight presets, each a different physical idea: paper rising, popping,
 * stamping down, unfolding, flipping open, being dealt onto a table, floating
 * up, or tearing along a ragged edge.
 *
 * `tear` is the odd one out — it animates a jagged `clip-path`, and because a
 * torn edge only reads as one gesture when the whole group tears together, its
 * elements are observed via their shared parent rather than individually.
 */

type Preset = {
  from: string;
  filter?: string;
  origin?: string;
  clip?: boolean;
  ease: string;
  dur: number;
  /** Per-index stagger in ms; defaults to 90. */
  step?: number;
};

const FX: Record<string, Preset> = {
  rise: {
    from: 'translateY(44px)',
    filter: 'blur(6px)',
    ease: 'cubic-bezier(.16,1,.3,1)',
    dur: 1000,
  },
  pop: {
    from: 'translateY(60px) scale(.55)',
    ease: 'cubic-bezier(.34,1.56,.64,1)',
    dur: 950,
  },
  stamp: {
    from: 'scale(1.5) rotate(-6deg)',
    filter: 'blur(8px)',
    ease: 'cubic-bezier(.3,1.75,.5,1)',
    dur: 650,
  },
  unfold: {
    from: 'perspective(1200px) rotateX(-72deg)',
    origin: '50% 0%',
    ease: 'cubic-bezier(.2,1.25,.4,1)',
    dur: 1200,
  },
  flip: {
    from: 'perspective(1400px) rotateY(-68deg) translateX(-40px)',
    origin: '0% 50%',
    ease: 'cubic-bezier(.2,1.2,.4,1)',
    dur: 1200,
  },
  deal: {
    from: 'translate(-160px,140px) rotate(-16deg) scale(.82)',
    ease: 'cubic-bezier(.2,1.3,.4,1)',
    dur: 1000,
    step: 130,
  },
  float: {
    from: 'translateY(100px) rotate(2.5deg)',
    filter: 'blur(10px)',
    ease: 'cubic-bezier(.16,1,.3,1)',
    dur: 1400,
  },
  tear: {
    from: 'translateY(-16px) rotate(-1.4deg)',
    clip: true,
    ease: 'cubic-bezier(.65,0,.35,1)',
    dur: 1100,
    step: 110,
  },
};

/** A ragged horizontal edge at `y`% with `amp`% of jitter — a torn paper line. */
function jag(y: number, amp: number): string {
  const n = 18;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    pts.push(`${(i / n) * 100}% ${y + (i % 2 ? amp : -amp) + (i % 3 ? 1.5 : 0)}%`);
  }
  return `polygon(0% -30%, 100% -30%, ${pts.reverse().join(', ')})`;
}

/** Elements grouped under a parent for a shared tear. */
type Grouped = HTMLElement & { _kids?: HTMLElement[] };
/** Per-element resolved preset + delay. */
type Prepared = HTMLElement & { _fx?: Preset; _d?: number };

export function useRevealFx(rootRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Under reduced motion the CSS backstop already forces the end state;
    // skip the engine entirely so nothing starts invisible.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));

    const els = Array.from(root.querySelectorAll<Prepared>('[data-reveal]'));

    for (const el of els) {
      const f = FX[el.getAttribute('data-fx') ?? ''] ?? FX.rise;
      const d = (Number(el.getAttribute('data-reveal')) || 0) * (f.step ?? 90);
      el._fx = f;
      el._d = d;

      el.style.opacity = '0';
      el.style.transform = f.from;
      if (f.origin) el.style.transformOrigin = f.origin;
      if (f.filter) el.style.filter = f.filter;
      if (f.clip) el.style.clipPath = jag(-14, 3);

      // Opacity deliberately lags the transform. Several presets start scaled
      // down (`pop` at .55, `deal` at .82), which would drag a 13px label to
      // ~7-11px for the length of the entrance — visible, and under the 12px
      // floor. Holding the element invisible through the first third of the
      // transform means it only becomes readable once the easing has already
      // resolved the scale to ~0.95+, so every preset keeps its exact design
      // values and no text is ever legible at a shrunken size.
      const opDelay = d + (f.clip ? 0 : Math.round(f.dur * 0.35));
      const opDur = f.clip ? 250 : Math.round(f.dur * 0.45);

      const tr = [
        `opacity ${opDur}ms ease ${opDelay}ms`,
        `transform ${f.dur}ms ${f.ease} ${d}ms`,
      ];
      if (f.filter) tr.push(`filter ${f.dur}ms ease ${d}ms`);
      if (f.clip) tr.push(`clip-path ${f.dur}ms ${f.ease} ${d}ms`);
      el.style.transition = tr.join(', ');
    }

    const show = (el: Prepared) => {
      const f = el._fx;
      if (!f) return;
      el.style.opacity = '1';
      el.style.transform = 'none';
      if (f.filter) el.style.filter = 'none';
      if (f.clip) el.style.clipPath = jag(118, 3);
      // Drop the clip and filter once the tween is done: leaving a clip-path in
      // place would keep clipping focus rings and hover shadows afterwards.
      later(
        () => {
          el.style.clipPath = '';
          el.style.filter = '';
        },
        f.dur + (el._d ?? 0) + 120
      );
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const t = e.target as Grouped;
          (t._kids ?? [t as Prepared]).forEach(show);
          io.unobserve(t);
        }
      },
      { threshold: 0.02, rootMargin: '0px 0px -4% 0px' }
    );

    for (const el of els) {
      const p = el.parentElement as Grouped | null;
      if (el._fx?.clip && p) {
        if (!p._kids) {
          p._kids = [];
          io.observe(p);
        }
        p._kids.push(el);
      } else {
        io.observe(el);
      }
    }

    // Defensive fallback: ensure no element remains permanently invisible
    // if scroll boundaries, rapid scrolling, or layout shifts miss an observer trigger.
    const backstop = setTimeout(() => {
      for (const el of els) {
        if (el.style.opacity === '0') {
          show(el);
        }
      }
    }, 2000);
    timers.push(backstop);

    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [rootRef]);
}

export default useRevealFx;
