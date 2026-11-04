import { useEffect } from 'react';

/**
 * DocFlow Landing v4 — custom cursor.
 *
 * Port of `setupCursor()` plus the cursor branch of `frame()`. An accent dot
 * tracks the pointer exactly; a hairline ring trails behind it and swells over
 * anything clickable.
 *
 * Two rules matter more than the look:
 *
 *  - `data-cursor-active` (which is what triggers `cursor: none` in v4.css) is
 *    set only after the first real pointer move has positioned both elements.
 *    If this hook never runs — touch device, reduced motion, an exception — the
 *    native pointer is still there.
 *  - Text inputs keep the native caret, and the dot hides over them, so the
 *    cursor never gets in the way of typing.
 *
 * Runs its own small rAF (two style writes per frame) rather than borrowing the
 * scroll engine's loop, so the pointer stays smooth independently of it.
 */
export function useV4Cursor(
  rootRef: React.RefObject<HTMLElement | null>,
  ringRef: React.RefObject<HTMLDivElement | null>,
  dotRef: React.RefObject<HTMLDivElement | null>,
  enabled = true
) {
  useEffect(() => {
    const root = rootRef.current;
    const ring = ringRef.current;
    const dot = dotRef.current;
    if (!enabled || !root || !ring || !dot) {
      root?.removeAttribute('data-cursor-active');
      return;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const c = { x: -100, y: -100, rx: -100, ry: -100, s: 1, ts: 1, on: false };

    const onMove = (e: MouseEvent) => {
      c.x = e.clientX;
      c.y = e.clientY;
      if (!c.on) {
        c.on = true;
        c.rx = c.x;
        c.ry = c.y;
        ring.style.display = 'block';
        dot.style.display = 'block';
        // Only now is it safe to hide the native pointer.
        root.setAttribute('data-cursor-active', 'true');
      }
    };

    const onOver = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest) return;

      // Native caret over anything typeable.
      if (t.closest('input,textarea,select,[contenteditable]')) {
        c.ts = 0;
        dot.style.opacity = '0';
        return;
      }
      dot.style.opacity = '1';

      const hot = t.closest('a,button');
      c.ts = hot ? 1.75 : 1;
      ring.style.background = hot ? 'var(--lp-cursor-fill-hot)' : 'transparent';
      ring.style.borderColor = hot ? 'var(--lp-cursor-ring-hot)' : 'var(--lp-cursor-ring)';
    };

    // Not in the design: without this, leaving the window leaves a frozen dot
    // stranded on screen.
    const onLeave = () => {
      ring.style.opacity = '0';
      dot.style.opacity = '0';
    };
    const onEnter = () => {
      ring.style.opacity = '1';
      dot.style.opacity = '1';
    };

    let raf = 0;
    const loop = () => {
      if (c.on) {
        c.rx += (c.x - c.rx) * 0.2;
        c.ry += (c.y - c.ry) * 0.2;
        c.s += (c.ts - c.s) * 0.18;
        ring.style.transform = `translate3d(${c.rx}px,${c.ry}px,0) translate(-50%,-50%) scale(${c.s})`;
        dot.style.transform = `translate3d(${c.x}px,${c.y}px,0) translate(-50%,-50%)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseover', onOver);
    document.documentElement.addEventListener('mouseleave', onLeave);
    document.documentElement.addEventListener('mouseenter', onEnter);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseover', onOver);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      document.documentElement.removeEventListener('mouseenter', onEnter);
      // Hand the native pointer back, whatever happened.
      root.removeAttribute('data-cursor-active');
    };
  }, [rootRef, ringRef, dotRef, enabled]);
}

export default useV4Cursor;
