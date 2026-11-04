/**
 * DocFlow — TipTap image node (spec FR-6.1 "Insert ... images").
 *
 * The document never stores an image URL. It stores `assetId`: the id of a
 * FileAsset this organisation owns. Two consequences, both deliberate:
 *
 *   - There is no `src` attribute to attack. A pasted `data:` or
 *     `javascript:` URL, or a remote tracking pixel, has nowhere to live;
 *     the server-side sanitiser drops any image that arrives without a
 *     uuid `assetId` (content_sanitizer.ALLOWED_NODES["image"]).
 *   - Access is re-checked on every view. The node view exchanges the id for
 *     a short-lived presigned URL through an authorised endpoint, so losing
 *     access to the document loses access to its images too.
 *
 * Uploads go through the existing presigned-PUT flow — no new upload path.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Node, mergeAttributes, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { AlignCenter, AlignLeft, AlignRight, ImageOff, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/api/client';

export const IMAGE_NODE = 'image';

/** FR-6.3 — the widths the preset buttons offer, in CSS pixels. */
const WIDTH_PRESETS: { label: string; value: number | null }[] = [
  { label: 'S', value: 180 },
  { label: 'M', value: 360 },
  { label: 'L', value: 640 },
  { label: 'Full', value: null },
];

export const IMAGE_ALIGNMENTS = ['left', 'center', 'right'] as const;
export type ImageAlign = (typeof IMAGE_ALIGNMENTS)[number];

const MIN_IMAGE_WIDTH = 48;
const MAX_IMAGE_WIDTH = 1400;

/**
 * Presigned URLs are short-lived but not instant-expiry, and the same image
 * commonly appears in a preview and an editor at once. One in-flight request
 * per asset, shared, keeps that to a single round trip.
 */
const urlCache = new Map<string, Promise<string>>();

export function resolveAssetUrl(assetId: string): Promise<string> {
  const hit = urlCache.get(assetId);
  if (hit) return hit;
  const p = apiClient
    .get<{ download_url: string }>(`/files/asset/${assetId}/download-url`)
    .then((r) => r.download_url)
    .catch((err) => {
      // Don't cache a failure: a 403 now may be a 200 after the document is
      // shared, and a network blip should not poison the entry for the session.
      urlCache.delete(assetId);
      throw err;
    });
  urlCache.set(assetId, p);
  return p;
}

function ImageView({ node, selected, updateAttributes, editor }: NodeViewProps) {
  const assetId = node.attrs.assetId as string | null;
  const alt = (node.attrs.alt as string) || '';
  const width = node.attrs.width as number | null;
  const align = (node.attrs.align as ImageAlign | null) || null;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const imgRef = useRef<HTMLImageElement>(null);
  const [dragging, setDragging] = useState(false);

  /**
   * FR-6.3 — drag the corner to resize.
   *
   * Pointer events with capture rather than mousemove on the document: the
   * browser keeps delivering them when the pointer leaves the image, and
   * releases the capture for us if the gesture is interrupted. The width is
   * written to the node only on release, so a drag is one undo step instead
   * of one per pixel.
   */
  const startResize = useCallback((e: React.PointerEvent) => {
    const img = imgRef.current;
    if (!img || !editor.isEditable) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);

    let next = startWidth;
    const onMove = (ev: PointerEvent) => {
      next = Math.round(Math.min(
        Math.max(startWidth + (ev.clientX - startX), MIN_IMAGE_WIDTH),
        MAX_IMAGE_WIDTH,
      ));
      img.style.width = `${next}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      setDragging(false);
      updateAttributes({ width: next });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, [editor, updateAttributes]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!assetId) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setUrl(null);
    resolveAssetUrl(assetId)
      .then((u) => {
        if (alive.current) setUrl(u);
      })
      .catch(() => {
        if (alive.current) setFailed(true);
      });
  }, [assetId]);

  const editable = editor.isEditable;

  return (
    <NodeViewWrapper
      as="span"
      className={`tt-image${selected ? ' tt-image-selected' : ''}`}
      data-align={align || undefined}
      data-drag-handle
    >
      {failed ? (
        <span className="tt-image-missing" role="img" aria-label={alt || 'Image unavailable'}>
          <ImageOff size={16} aria-hidden="true" />
          <span>{alt || 'Image unavailable'}</span>
        </span>
      ) : url ? (
        <span className="tt-image-frame">
          <img ref={imgRef} src={url} alt={alt} style={width ? { width: `${width}px` } : undefined} />
          {editable && (
            <span
              className="tt-image-handle"
              role="slider"
              tabIndex={0}
              aria-label="Resize image"
              aria-valuenow={width ?? 0}
              aria-valuemin={MIN_IMAGE_WIDTH}
              aria-valuemax={MAX_IMAGE_WIDTH}
              onPointerDown={startResize}
              onKeyDown={(e) => {
                // Resizable from the keyboard too, or the control is
                // unreachable without a mouse (FR-15.4).
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const base = width ?? imgRef.current?.getBoundingClientRect().width ?? 320;
                const step = e.shiftKey ? 50 : 10;
                updateAttributes({
                  width: Math.round(Math.min(
                    Math.max(base + (e.key === 'ArrowRight' ? step : -step), MIN_IMAGE_WIDTH),
                    MAX_IMAGE_WIDTH,
                  )),
                });
              }}
              style={{ opacity: selected || dragging ? 1 : 0 }}
            />
          )}
          {editable && selected && !dragging && (
            <span className="tt-image-bar" contentEditable={false} role="group" aria-label="Image options">
              {WIDTH_PRESETS.map((p) => (
                <button
                  key={p.label} type="button" className="tt-image-bar-btn"
                  aria-pressed={width === p.value}
                  title={p.value ? `Width ${p.value}px` : 'Original width'}
                  onClick={() => updateAttributes({ width: p.value })}
                >{p.label}</button>
              ))}
              <span className="tt-image-bar-sep" aria-hidden />
              {([
                ['left', AlignLeft, 'Align left'],
                ['center', AlignCenter, 'Align centre'],
                ['right', AlignRight, 'Align right'],
              ] as const).map(([value, Icon, label]) => (
                <button
                  key={value} type="button" className="tt-image-bar-btn"
                  aria-pressed={align === value} title={label} aria-label={label}
                  onClick={() => updateAttributes({ align: align === value ? null : value })}
                ><Icon size={13} /></button>
              ))}
            </span>
          )}
        </span>
      ) : (
        <span className="tt-image-loading" aria-label="Loading image">
          <Loader2 size={16} aria-hidden="true" style={{ animation: 'spin 0.8s linear infinite' }} />
        </span>
      )}
    </NodeViewWrapper>
  );
}

export const ImageNode = Node.create({
  name: IMAGE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-asset-id'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.assetId ? { 'data-asset-id': String(attrs.assetId) } : {},
      },
      alt: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('alt') ?? '',
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.alt ? { alt: String(attrs.alt) } : {},
      },
      title: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('title'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.title ? { title: String(attrs.title) } : {},
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-width');
          const n = raw ? Number(raw) : NaN;
          return Number.isFinite(n) ? n : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.width ? { 'data-width': String(attrs.width) } : {},
      },
      // FR-6.3. Stored as a name, not a CSS value: the server allow-lists
      // the three names, and the PDF renderer maps them to its own units.
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const raw = el.getAttribute('data-align');
          return (IMAGE_ALIGNMENTS as readonly string[]).includes(raw || '') ? raw : null;
        },
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.align ? { 'data-align': String(attrs.align) } : {},
      },
    };
  },

  // Only our own markup round-trips. Pasting an <img src="..."> from the web
  // finds no matching rule, so the image is dropped rather than silently
  // hotlinked — which is the behaviour the sanitiser enforces server-side too.
  parseHTML() {
    return [{ tag: 'span[data-asset-id][data-docflow-image]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-docflow-image': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});

export default ImageNode;
