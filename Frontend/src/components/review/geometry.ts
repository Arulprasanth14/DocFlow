/**
 * Anchor geometry — section 6.5.2. Tasks P3-5, P3-8.
 *
 * Annotations are stored as fractions (0..1) of the UNROTATED page. The
 * viewer may show a page rotated, so every rectangle crosses this boundary
 * twice: view -> stored when the approver selects, stored -> view when a
 * highlight is drawn. Rotation is a view setting; two people looking at one
 * page at different rotations must agree where a highlight is.
 */
import type { NormRect } from '@/lib/api/annotations';

export type Rotation = 0 | 90 | 180 | 270;

/** A point in the rotated view (0..1) -> the same point on the unrotated page. */
function pointToStored(u: number, v: number, rotation: Rotation): [number, number] {
  switch (rotation) {
    case 90: return [v, 1 - u];
    case 180: return [1 - u, 1 - v];
    case 270: return [1 - v, u];
    default: return [u, v];
  }
}

function pointToView(x: number, y: number, rotation: Rotation): [number, number] {
  switch (rotation) {
    case 90: return [1 - y, x];
    case 180: return [1 - x, 1 - y];
    case 270: return [y, 1 - x];
    default: return [x, y];
  }
}

function fromCorners(a: [number, number], b: [number, number]): NormRect {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

export function viewToStored(rect: NormRect, rotation: Rotation): NormRect {
  return fromCorners(
    pointToStored(rect.x, rect.y, rotation),
    pointToStored(rect.x + rect.w, rect.y + rect.h, rotation),
  );
}

export function storedToView(rect: NormRect, rotation: Rotation): NormRect {
  return fromCorners(
    pointToView(rect.x, rect.y, rotation),
    pointToView(rect.x + rect.w, rect.y + rect.h, rotation),
  );
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Client rects of a selection -> normalized view rects relative to a page.
 *
 * `getClientRects()` returns one rectangle per text run, often with
 * duplicates and zero-width slivers. Those are dropped here; the server caps
 * a comment at 200 rectangles and refuses rather than truncates.
 */
export function clientRectsToView(
  rects: DOMRect[] | DOMRectList,
  page: DOMRect,
): NormRect[] {
  const out: NormRect[] = [];
  const seen = new Set<string>();
  for (const r of Array.from(rects)) {
    if (r.width < 1 || r.height < 1) continue;
    const x = clamp01((r.left - page.left) / page.width);
    const y = clamp01((r.top - page.top) / page.height);
    const w = Math.min(r.width / page.width, 1 - x);
    const h = Math.min(r.height / page.height, 1 - y);
    if (w <= 0 || h <= 0) continue;
    const key = `${x.toFixed(4)}|${y.toFixed(4)}|${w.toFixed(4)}|${h.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, y, w, h });
  }
  return out;
}
