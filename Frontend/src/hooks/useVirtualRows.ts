/**
 * useVirtualRows — windowed rendering for a long flat list of fixed-height rows
 * (FR-1.4: "virtualise lists above ~100 rows").
 *
 * Deliberately small and dependency-free: the approved dependency list has no
 * windowing library in it, and the rows here are plain blocks in a vertical
 * flow, which is the one case windowing is trivial for. Everything above and
 * below the window is replaced by two spacer divs, so the scrollbar keeps the
 * length the full list would have had and the browser lays out a screenful
 * instead of hundreds of rows.
 *
 * It only works because every row is exactly `rowHeight` tall — the caller is
 * responsible for fixing the row height while virtualisation is on. A row that
 * grows taller than its slot would drift away from the scroll position.
 *
 * When `enabled` is false the hook returns the whole range and zero padding,
 * so the caller renders exactly what it rendered before and no scroll
 * container, measurement or listener is involved at all.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface VirtualRows {
  /** Attach to the element that scrolls. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** First row index to render (inclusive). */
  start: number;
  /** Last row index to render (exclusive). */
  end: number;
  /** Height of the spacer above the rendered rows, in px. */
  padTop: number;
  /** Height of the spacer below the rendered rows, in px. */
  padBottom: number;
  /** True when a window is actually being applied. */
  active: boolean;
  /** Jump back to the top — call when the underlying list is replaced. */
  scrollToTop: () => void;
}

export function useVirtualRows({
  count,
  rowHeight,
  enabled,
  overscan = 6,
}: {
  count: number;
  rowHeight: number;
  enabled: boolean;
  /** Extra rows rendered beyond each edge, so a fast scroll shows content. */
  overscan?: number;
}): VirtualRows {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const frame = useRef<number | null>(null);

  // Scroll, throttled to one update per frame. A list of 100 rows fires scroll
  // events far faster than React can usefully re-render.
  useEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;
    const onScroll = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [enabled]);

  // Viewport height. Measured rather than assumed, because the container is
  // sized in viewport units and the window can be resized mid-scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!enabled || !el) return;
    setViewport(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, []);

  if (!enabled || rowHeight <= 0) {
    return { scrollRef, start: 0, end: count, padTop: 0, padBottom: 0, active: false, scrollToTop };
  }

  // Before the first measurement, render one notional screenful rather than
  // nothing: a zero-height window would paint an empty table for a frame.
  const height = viewport || 640;
  const perScreen = Math.ceil(height / rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, start + perScreen + overscan * 2);

  return {
    scrollRef,
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
    active: true,
    scrollToTop,
  };
}

export default useVirtualRows;
