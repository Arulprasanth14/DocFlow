/**
 * Review document viewer — section 6.4.2 (AP-VWR-01..06), 6.5 (AP-ANN-01/02,
 * AP-ANN-22). Tasks P3-5 and P3-8.
 *
 * Renders the version's PDF with a selectable text layer, draws every
 * annotation's highlight, and turns a text selection (or a dragged rectangle,
 * for pages with no text layer) into an anchor.
 *
 * Three decisions worth knowing about:
 *
 *  - The file is fetched ONCE into memory and handed to pdf.js as bytes. The
 *    URL is good for five minutes (AP-VWR-04); letting pdf.js range-request
 *    it lazily would break page 200 of a long document six minutes in.
 *  - Pages render only while near the viewport and release their canvas when
 *    far from it, so a 300-page document does not hold 300 canvases (E24).
 *  - Anchors leave here as fractions of the UNROTATED page (see geometry.ts).
 *    Rotation and zoom are view settings and never reach the server.
 */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef,
  useState,
} from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  Maximize2, MessageSquarePlus, RotateCw, Search, Square, ZoomIn, ZoomOut,
} from 'lucide-react';

import type { AnchorDraft, AnyThread, NormRect } from '@/lib/api/annotations';
import {
  clientRectsToView, storedToView, viewToStored, type Rotation,
} from './geometry';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const CONTEXT = 30; // AP-ANN-22: characters of prefix/suffix kept for re-anchoring
const MAX_QUOTE = 1000;

export interface PdfViewerHandle {
  scrollToPage: (page: number) => void;
}

interface Props {
  fileUrl: string;
  annotations: AnyThread[];
  activeId: string | null;
  canAnnotate: boolean;
  onSelectAnnotation: (id: string) => void;
  onCreateAnchor: (anchor: AnchorDraft) => void;
}

const HIGHLIGHT: Record<string, string> = {
  draft: 'rgba(250, 204, 21, 0.35)',
  open: 'rgba(249, 115, 22, 0.30)',
  addressed: 'rgba(59, 130, 246, 0.25)',
  resolved: 'rgba(148, 163, 184, 0.20)',
};

/**
 * Find a quote inside a rendered text layer and return its rectangles.
 *
 * Used for comments carried over from an earlier version (AP-ANN-22): the
 * server says which page the text is on now, and only the text layer knows
 * where on that page. Whitespace-insensitive, because a revision re-flows
 * lines. Returns [] when it is not there, which the panel shows as
 * "Location changed".
 */
function findQuoteRects(layer: HTMLElement, quote: string, pageBox: DOMRect): NormRect[] {
  const wanted = quote.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!wanted) return [];
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const map: { node: Text; offset: number }[] = [];
  let flat = '';
  let lastWasSpace = true;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n as Text).data;
    for (let i = 0; i < text.length; i += 1) {
      const isSpace = /\s/.test(text[i]);
      if (isSpace && lastWasSpace) continue;
      flat += isSpace ? ' ' : text[i].toLowerCase();
      map.push({ node: n as Text, offset: i });
      lastWasSpace = isSpace;
    }
    if (!lastWasSpace) { // runs are separate spans: treat the boundary as a space
      flat += ' ';
      map.push({ node: n as Text, offset: text.length - 1 });
      lastWasSpace = true;
    }
  }
  const at = flat.indexOf(wanted);
  if (at < 0) return [];
  const start = map[at];
  const end = map[Math.min(at + wanted.length - 1, map.length - 1)];
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, Math.min(end.offset + 1, end.node.data.length));
  return clientRectsToView(range.getClientRects(), pageBox);
}

interface PageProps {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: Rotation;
  estimate: { w: number; h: number };
  annotations: AnyThread[];
  activeId: string | null;
  areaMode: boolean;
  root: HTMLElement | null;
  onSelectAnnotation: (id: string) => void;
  onArea: (page: number, rect: NormRect) => void;
}

function PdfPage({
  pdf, pageNumber, scale, rotation, estimate, annotations, activeId,
  areaMode, root, onSelectAnnotation, onArea,
}: PageProps) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState(estimate);
  const [rendered, setRendered] = useState(0);
  const [derived, setDerived] = useState<Record<string, NormRect[]>>({});
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root, rootMargin: '150% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textDiv = textRef.current;
    if (!canvas || !textDiv) return undefined;
    if (!near) {
      // Release the bitmap; the placeholder keeps the scroll height.
      canvas.width = 0;
      canvas.height = 0;
      textDiv.replaceChildren();
      return undefined;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({
        scale, rotation: (page.rotate + rotation) % 360,
      });
      setSize({ w: viewport.width, h: viewport.height });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      task = page.render({
        canvas, canvasContext: ctx, viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      try {
        await task.promise;
        textDiv.replaceChildren();
        const layer = new pdfjsLib.TextLayer({
          textContentSource: page.streamTextContent(),
          container: textDiv,
          viewport,
        });
        await layer.render();
        if (!cancelled) setRendered((n) => n + 1);
      } catch {
        // A cancelled render is the normal result of scrolling past.
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNumber, scale, rotation, near]);

  // AP-ANN-22: a carried-over comment has no trustworthy rectangles; draw it
  // from where its quoted text sits in THIS version's text layer.
  useEffect(() => {
    const layer = textRef.current;
    const box = holder.current?.getBoundingClientRect();
    if (!layer || !box || rendered === 0) return;
    const next: Record<string, NormRect[]> = {};
    for (const a of annotations) {
      if (a.carried_from_id && a.relocated && a.selected_text) {
        const found = findQuoteRects(layer, a.selected_text, box);
        if (found.length) next[a.id] = found;
      }
    }
    setDerived(next);
  }, [rendered, annotations]);

  const toNorm = (e: React.PointerEvent) => {
    const box = holder.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    };
  };

  return (
    <div
      ref={holder}
      data-page-number={pageNumber}
      className="page"
      style={{
        position: 'relative', width: size.w, height: size.h,
        margin: '0 auto 12px', background: '#fff',
        boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
        // Both names: pdf.js renamed the variable between major versions.
        ['--scale-factor' as string]: scale,
        ['--total-scale-factor' as string]: scale,
        ['--user-unit' as string]: 1,
        ['--scale-round-x' as string]: '1px',
        ['--scale-round-y' as string]: '1px',
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <div ref={textRef} className="textLayer" />

      {/* Highlights. Stored unrotated; mapped into the current view here. */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {annotations.map((a) => {
          const carried = !!a.carried_from_id;
          const rects = derived[a.id]
            ?? (a.rects as NormRect[]).map((r) => storedToView(r, rotation));
          return rects.map((r, i) => (
            <button
              key={`${a.id}-${i}`}
              type="button"
              aria-label={`Show the comment for this highlight on page ${pageNumber}`}
              onClick={() => onSelectAnnotation(a.id)}
              style={{
                position: 'absolute', pointerEvents: 'auto', padding: 0,
                left: `${r.x * 100}%`, top: `${r.y * 100}%`,
                width: `${r.w * 100}%`, height: `${r.h * 100}%`,
                background: HIGHLIGHT[a.status] ?? HIGHLIGHT.open,
                // Dashed = re-anchored on this version, so approximate.
                border: carried ? '1.5px dashed rgba(249,115,22,0.9)'
                  : a.anchor_type === 'area' ? '1.5px solid rgba(249,115,22,0.9)' : 'none',
                outline: a.id === activeId ? '2px solid var(--accent-primary)' : 'none',
                mixBlendMode: 'multiply', cursor: 'pointer', borderRadius: 2,
              }}
            />
          ));
        })}
      </div>

      {/* AP-ANN-02 / E14: the area tool, for pages with no text to select. */}
      {areaMode && (
        <div
          style={{ position: 'absolute', inset: 0, cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={(e) => {
            const p = toNorm(e);
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const p = toNorm(e);
            setDrag({ ...drag, x1: p.x, y1: p.y });
          }}
          onPointerUp={() => {
            if (!drag) return;
            const view: NormRect = {
              x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1),
              w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0),
            };
            setDrag(null);
            // A click without a drag is not an area.
            if (view.w > 0.01 && view.h > 0.01) {
              onArea(pageNumber, viewToStored(view, rotation));
            }
          }}
        >
          {drag && (
            <div style={{
              position: 'absolute',
              left: `${Math.min(drag.x0, drag.x1) * 100}%`,
              top: `${Math.min(drag.y0, drag.y1) * 100}%`,
              width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
              height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
              border: '1.5px dashed var(--accent-primary)',
              background: 'rgba(250, 204, 21, 0.25)',
            }} />
          )}
        </div>
      )}
    </div>
  );
}

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(
  { fileUrl, annotations, activeId, canAnnotate, onSelectAnnotation, onCreateAnchor },
  ref,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1.25);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [areaMode, setAreaMode] = useState(false);
  const [estimate, setEstimate] = useState({ w: 765, h: 990 });
  const [query, setQuery] = useState('');
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [pending, setPending] = useState<{ anchor: AnchorDraft; top: number; left: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Destroyed through the loading task: in this pdf.js version the
    // document proxy itself no longer exposes destroy().
    let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    setPdf(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        task = pdfjsLib.getDocument({ data });
        const loaded = await task.promise;
        if (cancelled) return;
        const first = await loaded.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setEstimate({ w: vp.width, h: vp.height });
        setPdf(loaded);
      } catch {
        if (!cancelled) setError('This document could not be displayed. Reload the page to try again.');
      }
    })();
    return () => { cancelled = true; void task?.destroy(); };
  }, [fileUrl]);

  const scrollToPage = useCallback((page: number) => {
    scroller.current
      ?.querySelector(`[data-page-number="${page}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  const byPage = useMemo(() => {
    const map = new Map<number, AnyThread[]>();
    for (const a of annotations) {
      map.set(a.page_number, [...(map.get(a.page_number) ?? []), a]);
    }
    return map;
  }, [annotations]);

  /** Turn the current text selection into an anchor, or clear the prompt. */
  const captureSelection = useCallback(() => {
    if (!canAnnotate || areaMode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setPending(null); return; }
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.parentElement;
    const pageEl = startEl?.closest<HTMLElement>('[data-page-number]');
    const layer = pageEl?.querySelector<HTMLElement>('.textLayer');
    const host = scroller.current;
    // A selection spanning two pages cannot be one anchor; keep the first.
    if (!pageEl || !layer || !host || !layer.contains(range.startContainer)) {
      setPending(null);
      return;
    }
    const box = pageEl.getBoundingClientRect();
    const view = clientRectsToView(range.getClientRects(), box);
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!view.length || !text) { setPending(null); return; }

    const before = document.createRange();
    before.selectNodeContents(layer);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.selectNodeContents(layer);
    after.setStart(range.endContainer, range.endOffset);

    const last = range.getBoundingClientRect();
    const hostBox = host.getBoundingClientRect();
    setPending({
      anchor: {
        anchor_type: 'text',
        page_number: Number(pageEl.dataset.pageNumber),
        rects: view.slice(0, 200).map((r) => viewToStored(r, rotation)),
        selected_text: text.slice(0, MAX_QUOTE),
        text_prefix: before.toString().replace(/\s+/g, ' ').slice(-CONTEXT),
        text_suffix: after.toString().replace(/\s+/g, ' ').slice(0, CONTEXT),
      },
      top: last.bottom - hostBox.top + host.scrollTop + 6,
      left: Math.max(8, last.left - hostBox.left + host.scrollLeft),
    });
  }, [canAnnotate, areaMode, rotation]);

  const commit = useCallback(() => {
    if (!pending) return;
    onCreateAnchor(pending.anchor);
    setPending(null);
    window.getSelection()?.removeAllRanges();
  }, [pending, onCreateAnchor]);

  // AP-ANN: Ctrl+Alt+M comments on the current selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'm' && pending) {
        e.preventDefault();
        commit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, commit]);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim().toLowerCase();
    if (!pdf || !q) return;
    setSearchNote('Searching…');
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const text = content.items
        .map((it) => ('str' in it ? it.str : '')).join(' ').toLowerCase();
      if (text.includes(q)) {
        setSearchNote(`Found on page ${n}`);
        scrollToPage(n);
        return;
      }
    }
    setSearchNote('No match in this document');
  }

  const zoom = (dir: 1 | -1) => {
    const i = ZOOMS.findIndex((z) => z >= scale);
    setScale(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? ZOOMS.length - 1 : i) + dir))]);
  };

  const tool: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 9px',
    borderRadius: 8, border: '1px solid var(--border-subtle)',
    background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
    fontSize: 12, fontFamily: "'Inter', sans-serif",
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)',
      }}>
        <button style={tool} onClick={() => zoom(-1)} aria-label="Zoom out"><ZoomOut size={14} /></button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 42, textAlign: 'center' }}>
          {Math.round(scale * 100)}%
        </span>
        <button style={tool} onClick={() => zoom(1)} aria-label="Zoom in"><ZoomIn size={14} /></button>
        <button
          style={tool}
          onClick={() => setRotation(((rotation + 90) % 360) as Rotation)}
          aria-label="Rotate clockwise"
        >
          <RotateCw size={14} />
        </button>
        <button
          style={tool}
          onClick={() => scroller.current?.parentElement?.requestFullscreen?.()}
          aria-label="Full screen"
        >
          <Maximize2 size={14} />
        </button>
        {canAnnotate && (
          <button
            style={{
              ...tool,
              background: areaMode ? 'var(--accent-primary)' : 'transparent',
              color: areaMode ? '#fff' : 'var(--text-primary)',
            }}
            aria-pressed={areaMode}
            onClick={() => { setAreaMode(!areaMode); setPending(null); }}
            title="Draw a box to comment on an area — for scans and images"
          >
            <Square size={14} /> Area comment
          </button>
        )}
        <form onSubmit={runSearch} style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchNote(null); }}
            placeholder="Find in document"
            aria-label="Find in document"
            style={{
              padding: '6px 9px', borderRadius: 8, fontSize: 12, width: 160,
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-overlay)', color: 'var(--text-primary)',
            }}
          />
          {searchNote && (
            <span role="status" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{searchNote}</span>
          )}
        </form>
        {pdf && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {pdf.numPages} {pdf.numPages === 1 ? 'page' : 'pages'}
          </span>
        )}
      </div>

      {/* UX-A11Y: a scrollable region must be focusable, or a keyboard user
          cannot scroll the document at all. Found by axe (P4-6), not by
          reading the code. `group` rather than `region` because this is a
          viewport onto content, not a landmark. */}
      <div
        ref={scroller}
        tabIndex={0}
        role="group"
        aria-label="Document pages. Use the arrow keys to scroll."
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        style={{
          position: 'relative', flex: 1, minHeight: 0, overflow: 'auto',
          padding: 16, background: 'var(--bg-base)',
        }}
      >
        {error && <p role="alert" style={{ color: 'var(--text-muted)', fontSize: 13 }}>{error}</p>}
        {!pdf && !error && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading document…</p>
        )}
        {pdf && Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((n) => (
          <PdfPage
            key={n}
            pdf={pdf}
            pageNumber={n}
            scale={scale}
            rotation={rotation}
            estimate={{
              w: (rotation % 180 === 0 ? estimate.w : estimate.h) * scale,
              h: (rotation % 180 === 0 ? estimate.h : estimate.w) * scale,
            }}
            annotations={byPage.get(n) ?? []}
            activeId={activeId}
            areaMode={areaMode}
            root={scroller.current}
            onSelectAnnotation={onSelectAnnotation}
            onArea={(page, rect) => {
              setAreaMode(false);
              onCreateAnchor({ anchor_type: 'area', page_number: page, rects: [rect] });
            }}
          />
        ))}

        {pending && (
          <button
            className="btn btn-primary"
            style={{ position: 'absolute', top: pending.top, left: pending.left, zIndex: 5 }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
            title="Comment on the selected text (Ctrl+Alt+M)"
          >
            <MessageSquarePlus size={14} /> Comment
          </button>
        )}
      </div>
    </div>
  );
});

export default PdfViewer;
