/**
 * DocFlow — a scaled-down render of a document's first page.
 *
 * Takes editor JSON directly, so it works for a document as well as a
 * template. Same approach as the template card's thumbnail: lay the content
 * out at real page width and scale it with a CSS transform, rather than
 * rasterising server-side (which would need a new dependency).
 *
 * It shows the real first page — never a stock image and never a placeholder
 * dressed up as a preview. An empty document says it is empty.
 */
import { useMemo } from 'react';
import { FileText } from 'lucide-react';

const PAGE_W = 794;      // A4 at 96dpi
const PAGE_H = 1123;

interface Block {
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'rule' | 'table' | 'image';
  text: string;
}

function inlineText(node: Record<string, unknown>): string {
  const content = node.content;
  if (!Array.isArray(content)) return typeof node.text === 'string' ? node.text : '';
  return content
    .map((child) => {
      const c = child as Record<string, unknown>;
      if (c.type === 'text' && typeof c.text === 'string') return c.text;
      // A blank is an atom with no text; show the gap so the miniature reads
      // like the document rather than quietly closing up.
      if (c.type === 'placeholder') return '______';
      return inlineText(c);
    })
    .join('');
}

export function toBlocks(content: unknown, limit = 60): Block[] {
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
        for (const item of (Array.isArray(n.content) ? n.content : [])) {
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

export interface ContentMiniatureProps {
  content: unknown;
  width?: number;
  height?: number;
  /** Shown instead of the page when there is nothing to draw. */
  emptyLabel?: string;
}

export function ContentMiniature({
  content, width = 150, height = 106, emptyLabel = 'Empty page',
}: ContentMiniatureProps) {
  const blocks = useMemo(() => toBlocks(content), [content]);

  const frame: React.CSSProperties = {
    width, height, flexShrink: 0, overflow: 'hidden',
    borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    background: 'var(--card-solid)', position: 'relative',
  };

  if (blocks.length === 0) {
    return (
      <div style={{ ...frame, display: 'grid', placeItems: 'center' }} aria-hidden="true">
        <div style={{ textAlign: 'center', color: 'var(--muted-foreground)' }}>
          <FileText size={20} />
          <div style={{ fontSize: '0.68rem', fontWeight: 600, marginTop: 4 }}>{emptyLabel}</div>
        </div>
      </div>
    );
  }

  const scale = width / PAGE_W;

  return (
    <div style={frame} aria-hidden="true" title="First page">
      <div
        style={{
          position: 'absolute', top: 0, left: 0,
          width: PAGE_W, height: PAGE_H,
          transform: `scale(${scale})`, transformOrigin: 'top left',
          // A document page is white in both themes, like the editor's paper.
          background: '#ffffff', color: '#1a1a1a',
          padding: '56px 64px', boxSizing: 'border-box',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {blocks.map((b, i) => {
          if (b.kind === 'rule') {
            return <hr key={i} style={{ border: 0, borderTop: '1px solid #d8d8d8', margin: '14px 0' }} />;
          }
          if (b.kind === 'table' || b.kind === 'image') {
            return (
              <div key={i} style={{
                border: `1px ${b.kind === 'image' ? 'dashed' : 'solid'} #d0d0d0`,
                borderRadius: 3, padding: b.kind === 'image' ? '18px 12px' : '10px 12px',
                margin: '0 0 11px', fontSize: 13, color: '#6b6b6b',
                textAlign: b.kind === 'image' ? 'center' : 'left',
              }}>{b.kind === 'table' ? `Table · ${b.text}` : b.text}</div>
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

export default ContentMiniature;
