/**
 * DocFlow — first-page thumbnail for a template card (spec FR-4.1, FR-4.3).
 *
 * WHAT THIS IS: a real miniature of the template's own first page, rendered
 * from the stored editor JSON and scaled down with a CSS transform. It is not
 * a stock image and not a placeholder dressed up as a preview — if the
 * template says "Rent Agreement" at the top, that is what you see.
 *
 * WHY NOT A RASTER: a server-rendered PNG would need a rasteriser
 * (PyMuPDF / poppler / headless Chrome), which is a new dependency. The
 * `template_versions.thumbnail_url` column exists for that day; until then
 * this gives a truthful preview with nothing new installed, and it has the
 * side benefit of never going stale against the content.
 *
 * LAZY (FR-4.3): the content arrives via the quick-look's existing prefetch,
 * so nothing is fetched until a card is hovered or focused. A template whose
 * content has not loaded shows a skeleton, never invented text.
 *
 * A DocumentType has no page at all — it is a form, not a document — so it
 * gets an honest "form with N questions" panel rather than a fake page.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, ListChecks } from 'lucide-react';
import templatesApi from '@/lib/api/templates';
import { templateKeys } from '@/hooks/useTemplates';

/** Page width the miniature is laid out at before scaling (A4 at 96dpi). */
const PAGE_W = 794;
const PAGE_H = 1123;

interface Block {
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'rule' | 'table' | 'image';
  text: string;
}

/** Plain text of a node's inline children, with blanks shown as a gap. */
function inlineText(node: Record<string, unknown>): string {
  const content = node.content;
  if (!Array.isArray(content)) return typeof node.text === 'string' ? node.text : '';
  return content
    .map((child) => {
      const c = child as Record<string, unknown>;
      if (c.type === 'text' && typeof c.text === 'string') return c.text;
      // A placeholder is an atom with no text; show it as a ruled gap so the
      // miniature looks like the document rather than silently dropping it.
      if (c.type === 'placeholder') return '______';
      return inlineText(c);
    })
    .join('');
}

/** Flatten the editor JSON into the handful of block kinds worth drawing. */
function toBlocks(content: unknown, limit = 60): Block[] {
  const root = (content ?? {}) as Record<string, unknown>;
  const nodes = Array.isArray(root.content) ? root.content : [];
  const out: Block[] = [];

  const walk = (list: unknown[]) => {
    for (const raw of list) {
      if (out.length >= limit) return;
      const n = raw as Record<string, unknown>;
      const type = String(n.type ?? '');
      const attrs = (n.attrs ?? {}) as Record<string, unknown>;

      if (type === 'heading') {
        const level = Number(attrs.level ?? 1);
        out.push({ kind: level >= 3 ? 'h3' : level === 2 ? 'h2' : 'h1', text: inlineText(n) });
      } else if (type === 'paragraph') {
        const text = inlineText(n);
        if (text.trim()) out.push({ kind: 'p', text });
      } else if (type === 'bulletList' || type === 'orderedList') {
        const items = Array.isArray(n.content) ? n.content : [];
        for (const item of items) {
          if (out.length >= limit) return;
          out.push({ kind: 'li', text: inlineText(item as Record<string, unknown>) });
        }
      } else if (type === 'horizontalRule') {
        out.push({ kind: 'rule', text: '' });
      } else if (type === 'table') {
        const rows = Array.isArray(n.content) ? n.content.length : 0;
        out.push({ kind: 'table', text: `${rows} row${rows === 1 ? '' : 's'}` });
      } else if (type === 'image') {
        out.push({ kind: 'image', text: String(attrs.alt ?? 'Image') });
      } else if (type === 'blockquote' && Array.isArray(n.content)) {
        walk(n.content);
      }
    }
  };

  walk(nodes);
  return out;
}

const BLOCK_STYLE: Record<Block['kind'], React.CSSProperties> = {
  h1: { fontSize: 34, fontWeight: 700, margin: '0 0 14px' },
  h2: { fontSize: 26, fontWeight: 700, margin: '18px 0 10px' },
  h3: { fontSize: 21, fontWeight: 700, margin: '14px 0 8px' },
  p: { fontSize: 15, lineHeight: 1.55, margin: '0 0 11px' },
  li: { fontSize: 15, lineHeight: 1.55, margin: '0 0 6px 22px' },
  rule: {},
  table: {},
  image: {},
};

export interface TemplateThumbnailProps {
  /** A Template Studio template id, or null for a DocumentType. */
  templateId: string | null;
  /** Only fetch and render once the quick-look is actually open (FR-4.3). */
  active: boolean;
  fieldCount: number;
  /** Rendered box size; the page is scaled to fit this width. */
  width?: number;
  height?: number;
}

export function TemplateThumbnail({
  templateId,
  active,
  fieldCount,
  width = 150,
  height = 106,
}: TemplateThumbnailProps) {
  const { data, isLoading } = useQuery({
    queryKey: templateKeys.detail(templateId ?? ''),
    queryFn: () => templatesApi.get(templateId!),
    enabled: active && !!templateId,
    staleTime: 1000 * 60 * 5,
  });

  const blocks = useMemo(
    () => (data?.content ? toBlocks(data.content) : []),
    [data?.content],
  );

  const frame: React.CSSProperties = {
    width, height, flexShrink: 0, overflow: 'hidden',
    borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    background: 'var(--card-solid)', position: 'relative',
  };

  // A DocumentType is a form, not a document. Saying so is more useful than
  // drawing a page that does not exist.
  if (!templateId) {
    return (
      <div style={{ ...frame, display: 'grid', placeItems: 'center' }} aria-hidden="true">
        <div style={{ textAlign: 'center', color: 'var(--muted-foreground)' }}>
          <ListChecks size={20} />
          <div style={{ fontSize: '0.68rem', fontWeight: 600, marginTop: 4 }}>
            {fieldCount} question{fieldCount === 1 ? '' : 's'}
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return <div className="skeleton" style={frame} aria-hidden="true" />;
  }

  if (blocks.length === 0) {
    return (
      <div style={{ ...frame, display: 'grid', placeItems: 'center' }} aria-hidden="true">
        <div style={{ textAlign: 'center', color: 'var(--muted-foreground)' }}>
          <FileText size={20} />
          <div style={{ fontSize: '0.68rem', fontWeight: 600, marginTop: 4 }}>Empty page</div>
        </div>
      </div>
    );
  }

  const scale = width / PAGE_W;

  return (
    <div style={frame} aria-hidden="true" title="First page of this template">
      <div
        style={{
          position: 'absolute', top: 0, left: 0,
          width: PAGE_W, height: PAGE_H,
          transform: `scale(${scale})`, transformOrigin: 'top left',
          // Fixed light page: a document page is white in both themes, the
          // same as the editor's own `.tt-paper`.
          background: '#ffffff', color: '#1a1a1a',
          padding: '56px 64px', boxSizing: 'border-box',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {blocks.map((b, i) => {
          if (b.kind === 'rule') {
            return <hr key={i} style={{ border: 0, borderTop: '1px solid #d8d8d8', margin: '14px 0' }} />;
          }
          if (b.kind === 'table') {
            return (
              <div key={i} style={{
                border: '1px solid #d0d0d0', borderRadius: 3,
                padding: '10px 12px', margin: '0 0 11px',
                fontSize: 13, color: '#6b6b6b',
              }}>Table · {b.text}</div>
            );
          }
          if (b.kind === 'image') {
            return (
              <div key={i} style={{
                border: '1px dashed #d0d0d0', borderRadius: 3,
                padding: '18px 12px', margin: '0 0 11px', textAlign: 'center',
                fontSize: 13, color: '#6b6b6b',
              }}>{b.text}</div>
            );
          }
          return (
            <div key={i} style={BLOCK_STYLE[b.kind]}>
              {b.kind === 'li' ? `• ${b.text}` : b.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TemplateThumbnail;
