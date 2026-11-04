/**
 * DocFlow — document outline pane (spec FR-6.6).
 *
 * Lists the document's headings and scrolls to one when clicked. Rebuilt from
 * the editor's own document on every change, so it cannot drift out of step
 * with what is written.
 *
 * Positions come from ProseMirror, not from querying the DOM for <h1>/<h2>:
 * a heading's position survives re-renders and decorations, whereas an
 * element reference does not. Clicking sets the selection there, which also
 * puts the caret where the author expects after the jump.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { List, ChevronRight } from 'lucide-react';

interface OutlineEntry {
  pos: number;
  level: number;
  text: string;
}

function readOutline(editor: Editor | null): OutlineEntry[] {
  if (!editor) return [];
  const out: OutlineEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true;
    const text = (node.textContent || '').trim();
    out.push({
      pos,
      level: Math.min(Number(node.attrs.level) || 1, 3),
      // An empty heading still belongs in the outline — leaving it out would
      // make the list silently shorter than the document.
      text: text || 'Untitled heading',
    });
    // Headings do not nest, so there is nothing to walk into.
    return false;
  });
  return out;
}

export interface OutlinePaneProps {
  editor: Editor | null;
  /** Rendered inside the editor column; the caller decides the layout. */
  compact?: boolean;
}

export function OutlinePane({ editor, compact = false }: OutlinePaneProps) {
  const [version, setVersion] = useState(0);
  const [activePos, setActivePos] = useState<number | null>(null);

  // One signal for "the document changed", same approach as the find bar.
  useEffect(() => {
    if (!editor) return;
    const bump = () => setVersion((v) => v + 1);
    editor.on('update', bump);
    editor.on('selectionUpdate', bump);
    return () => {
      editor.off('update', bump);
      editor.off('selectionUpdate', bump);
    };
  }, [editor]);

  const outline = useMemo(
    () => readOutline(editor),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the change signal
    [editor, version],
  );

  // Which heading the caret is currently under.
  const current = useMemo(() => {
    if (!editor || outline.length === 0) return null;
    const at = editor.state.selection.from;
    let found: number | null = null;
    for (const entry of outline) {
      if (entry.pos <= at) found = entry.pos;
      else break;
    }
    return found;
  }, [editor, outline, version]);

  const jump = useCallback((pos: number) => {
    if (!editor) return;
    setActivePos(pos);
    editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();
  }, [editor]);

  if (!editor) return null;

  return (
    <nav
      aria-label="Document outline"
      style={{
        display: 'grid', gap: 6, alignContent: 'start',
        padding: compact ? '10px 12px' : '14px 16px',
        borderRadius: 'var(--radius)', border: '1px solid var(--border)',
        background: 'var(--card-solid)',
        maxHeight: compact ? 220 : 420, overflowY: 'auto',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 2 }}>
        <List size={14} style={{ color: 'var(--muted-foreground)' }} aria-hidden="true" />
        <h3 style={{
          margin: 0, fontSize: '0.74rem', fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.04em',
          color: 'var(--muted-foreground)',
        }}>Outline</h3>
        {outline.length > 0 && (
          <span style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)', marginLeft: 'auto' }}>
            {outline.length}
          </span>
        )}
      </header>

      {outline.length === 0 ? (
        <p style={{ margin: 0, fontSize: '0.76rem', color: 'var(--muted-foreground)', lineHeight: 1.5 }}>
          No headings yet. Use Heading 1&ndash;3 from the toolbar and they will
          appear here.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 1 }}>
          {outline.map((entry) => {
            const active = (activePos ?? current) === entry.pos;
            return (
              <li key={`${entry.pos}-${entry.level}`}>
                <button
                  type="button"
                  onClick={() => jump(entry.pos)}
                  title={entry.text}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, width: '100%',
                    padding: '4px 6px',
                    paddingLeft: 6 + (entry.level - 1) * 12,
                    borderRadius: 'var(--radius-sm)',
                    border: 'none', cursor: 'pointer', textAlign: 'left',
                    background: active ? 'var(--secondary)' : 'transparent',
                    color: active ? 'var(--foreground)' : 'var(--muted-foreground)',
                    fontSize: entry.level === 1 ? '0.82rem' : '0.78rem',
                    fontWeight: entry.level === 1 ? 700 : 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                  className="glass-interactive"
                >
                  {active && (
                    <ChevronRight size={11} style={{ flexShrink: 0 }} aria-hidden="true" />
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

export default OutlinePane;
