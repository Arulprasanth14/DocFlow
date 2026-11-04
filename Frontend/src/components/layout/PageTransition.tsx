/**
 * PageTransition — enter animation for the routed content area.
 * The sidebar / topbar / LivingBackground live OUTSIDE this wrapper and never re-animate.
 *
 * On each route change: PageHeader reveals first, then [data-section] blocks stagger in
 * (and the first ~10 [data-stagger-item] rows inside them). Direction-aware: going deeper
 * enters from the right, going back from the left, sibling pages use a vertical fade.
 *
 * Enter-only (no exit tween): React Router v7 swaps the Outlet synchronously, so a reliable
 * cross-fade exit isn't available here — see REDESIGN_V2_PLAN.md "Decisions made". A 0.12s
 * content fade softens the swap. Honors prefers-reduced-motion (0.15s opacity fade only).
 */

import { useRef } from 'react';
import { useLocation } from 'react-router-dom';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { prefersReducedMotion } from '@/lib/motion';
import { EASE, DUR } from '@/lib/motion/tokens';

export default function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const scope = useRef<HTMLDivElement>(null);
  const prevDepth = useRef<number>(location.pathname.split('/').filter(Boolean).length);

  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;

      // Scroll the content area back to top on navigation.
      root.scrollTo?.(0, 0);
      window.scrollTo?.(0, 0);

      // Move focus to the main heading for screen readers (non-visual).
      const heading = root.querySelector<HTMLElement>('[data-page-title], h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        // defer so it doesn't fight the scroll reset
        requestAnimationFrame(() => heading.focus({ preventScroll: true }));
      }

      if (prefersReducedMotion()) {
        gsap.fromTo(root, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.15 });
        return;
      }

      // Direction: deeper (more path segments) → from right; shallower → from left; sibling → vertical.
      const depth = location.pathname.split('/').filter(Boolean).length;
      const delta = depth - prevDepth.current;
      prevDepth.current = depth;
      const xFrom = delta > 0 ? 24 : delta < 0 ? -24 : 0;
      const yFrom = delta === 0 ? 14 : 0;

      const header = root.querySelector('[data-page-header]');
      const sections = Array.from(root.querySelectorAll('[data-section]'));

      const tl = gsap.timeline();
      tl.fromTo(
        root,
        { autoAlpha: 0, x: xFrom, y: yFrom },
        { autoAlpha: 1, x: 0, y: 0, duration: DUR.page, ease: EASE.emphasized },
      );
      if (header) {
        tl.from(header, { autoAlpha: 0, y: 16, duration: DUR.base, ease: EASE.emphasized }, 0.02);
      }
      if (sections.length) {
        tl.from(
          sections,
          { autoAlpha: 0, y: 16, scale: 0.985, duration: DUR.base, ease: EASE.emphasized, stagger: 0.06 },
          header ? 0.1 : 0.04,
        );
      }
      // cap total around 0.7s
      tl.totalDuration(Math.min(tl.totalDuration(), DUR.max));
    },
    { dependencies: [location.pathname], scope },
  );

  return (
    <div ref={scope} style={{ minHeight: '100%' }}>
      {/* aria-live announces route changes politely */}
      <div aria-live="polite" className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        {location.pathname}
      </div>
      {children}
    </div>
  );
}
