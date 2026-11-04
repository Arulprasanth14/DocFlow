/**
 * DocFlow — paged print-layout canvas (spec FR-6.2, page count for FR-6.5).
 *
 * The editor document is one continuous ProseMirror tree; it has no concept of
 * pages. This wraps it in a surface the width of a real page and draws guides
 * where the page would break at that size, then reports how many pages that
 * comes to so the status bar can show "Page x of y".
 *
 * Honest about what it is: a LAYOUT PREVIEW. The authoritative pagination is
 * ReportLab's, at export time, and it can differ by a line where a paragraph
 * or a table does not split the same way. The guides are therefore drawn as
 * dashed hints and labelled "approximate", rather than as hard page edges that
 * would imply a guarantee this cannot make. Getting exact agreement would mean
 * running the server's layout engine in the browser.
 *
 * Measurement is done with a ResizeObserver on the ProseMirror element, so the
 * count follows typing, pasting, image loads and window resizes without a
 * polling loop.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** CSS px per inch, which is what the browser uses for mm/in units. */
const PX_PER_IN = 96;
const PX_PER_MM = PX_PER_IN / 25.4;

export type PageSize = 'A4' | 'Letter';
export type PageOrientation = 'portrait' | 'landscape';

const SIZES: Record<PageSize, { w: number; h: number }> = {
  // 210 x 297 mm
  A4: { w: 210 * PX_PER_MM, h: 297 * PX_PER_MM },
  // 8.5 x 11 in
  Letter: { w: 8.5 * PX_PER_IN, h: 11 * PX_PER_IN },
};

/** Matches `.tt-paper` padding in index.css, which is the printable margin. */
const MARGIN_Y = 56;
const MARGIN_X = 64;

export interface PageGeometry {
  width: number;
  height: number;
  contentHeight: number;
}

export function pageGeometry(
  size: PageSize = 'A4',
  orientation: PageOrientation = 'portrait',
): PageGeometry {
  const base = SIZES[size] ?? SIZES.A4;
  const width = orientation === 'landscape' ? base.h : base.w;
  const height = orientation === 'landscape' ? base.w : base.h;
  return { width, height, contentHeight: Math.max(height - MARGIN_Y * 2, 200) };
}

/**
 * Read page size/orientation out of a template version's `page_settings`.
 * Unknown or absent values fall back to A4 portrait rather than throwing —
 * page_settings is free-form JSON written by the studio.
 */
export function readPageSettings(settings: unknown): {
  size: PageSize;
  orientation: PageOrientation;
} {
  const s = (settings ?? {}) as Record<string, unknown>;
  const rawSize = String(s.size ?? s.page_size ?? 'A4');
  const rawOrientation = String(s.orientation ?? 'portrait').toLowerCase();
  return {
    size: rawSize.toLowerCase() === 'letter' ? 'Letter' : 'A4',
    orientation: rawOrientation === 'landscape' ? 'landscape' : 'portrait',
  };
}

/** The header/footer half of `page_settings` (FR-6.6). */
export interface PageFurnitureValue {
  header_left: string;
  header_right: string;
  footer_left: string;
  footer_right: string;
  page_numbers: boolean;
}

export const EMPTY_FURNITURE: PageFurnitureValue = {
  header_left: '',
  header_right: '',
  footer_left: '',
  footer_right: '',
  page_numbers: true,
};

/**
 * Read authored header/footer text out of `page_settings`.
 *
 * Absent is not the same as empty: a template that has never set a header
 * inherits what DocFlow derives (title, reference, submission date), while one
 * that sets it to "" is asking for nothing to be printed. The editor cannot
 * express that difference in a text input, so it sends every field once the
 * author opens the panel, and a template that never opens it keeps inheriting.
 */
export function readPageFurniture(settings: unknown): PageFurnitureValue {
  const s = (settings ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    header_left: str(s.header_left),
    header_right: str(s.header_right),
    footer_left: str(s.footer_left),
    footer_right: str(s.footer_right),
    page_numbers: s.page_numbers === undefined ? true : !!s.page_numbers,
  };
}

/** True when this template has authored furniture of its own. */
export function hasAuthoredFurniture(settings: unknown): boolean {
  const s = (settings ?? {}) as Record<string, unknown>;
  return ['header_left', 'header_right', 'footer_left', 'footer_right', 'page_numbers']
    .some((k) => s[k] !== undefined);
}

export interface PagedCanvasProps {
  children: React.ReactNode;
  size?: PageSize;
  orientation?: PageOrientation;
  /** Off by default so the continuous view stays the norm (FR-6.1 View tab). */
  enabled?: boolean;
  /** Reports the measured page count so a status bar can show "Page x of y". */
  onPageCountChange?: (pages: number) => void;
}

export function PagedCanvas({
  children,
  size = 'A4',
  orientation = 'portrait',
  enabled = true,
  onPageCountChange,
}: PagedCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const geo = useMemo(() => pageGeometry(size, orientation), [size, orientation]);

  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    // Measure the ProseMirror element, not the padded wrapper, so the
    // page margins are not counted twice.
    const pm = host.querySelector('.ProseMirror') as HTMLElement | null;
    setContentHeight(pm ? pm.scrollHeight : host.scrollHeight);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    measure();

    // Observe the ProseMirror node if it exists yet, otherwise the host; the
    // editor mounts asynchronously so the node can appear after this effect.
    const target = (host.querySelector('.ProseMirror') as HTMLElement | null) ?? host;
    if (typeof ResizeObserver === 'undefined') return;   // jsdom / very old browsers
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    return () => ro.disconnect();
  }, [measure, children]);

  const pages = Math.max(1, Math.ceil(contentHeight / geo.contentHeight) || 1);

  useEffect(() => {
    onPageCountChange?.(enabled ? pages : 1);
  }, [pages, enabled, onPageCountChange]);

  if (!enabled) {
    // Continuous view: the ordinary paper surface, unchanged.
    return <div className="tt-paper" ref={hostRef}>{children}</div>;
  }

  return (
    <div className="tt-paged-outer">
      <div
        ref={hostRef}
        className="tt-paper tt-paged"
        style={{
          width: geo.width,
          maxWidth: '100%',
          minHeight: geo.height,
          paddingLeft: MARGIN_X,
          paddingRight: MARGIN_X,
          paddingTop: MARGIN_Y,
          paddingBottom: MARGIN_Y,
        }}
      >
        {/* Guides sit behind the text and never take pointer events, so
            clicking "between pages" still places the caret normally. */}
        <div className="tt-page-guides" aria-hidden="true">
          {Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => (
            <div
              key={i}
              className="tt-page-guide"
              style={{ top: (i + 1) * geo.contentHeight }}
            >
              <span className="tt-page-guide-label">Page {i + 2}</span>
            </div>
          ))}
        </div>
        {children}
      </div>
    </div>
  );
}

export default PagedCanvas;
