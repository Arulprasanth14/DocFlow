/**
 * DocFlow — the imported document, with its detected blanks marked
 * (spec FR-9.5).
 *
 * Deliberately renders the extracted PLAIN TEXT rather than a rich editor.
 * Detection offsets index that exact string, so what is highlighted here is
 * precisely what the server will replace, and a span the reader selects maps
 * back to offsets with no translation step. A ProseMirror view would look
 * nicer and make both of those guesses.
 *
 * Selecting text and pressing "Make blank" is the escape hatch for anything
 * the detector missed; the server re-reads the span from its own copy of the
 * text, so the selection cannot claim to cover something it doesn't.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Scissors, Info } from 'lucide-react';
import type { Confidence, Detection } from '@/lib/api/imports';

const TINT: Record<Confidence, string> = {
  high: 'var(--status-approved-bg)',
  medium: 'var(--status-pending-bg)',
  low: 'var(--status-rejected-bg)',
};
const EDGE: Record<Confidence, string> = {
  high: 'var(--status-approved-fg)',
  medium: 'var(--status-pending-fg)',
  low: 'var(--status-rejected-fg)',
};

export interface ImportDocumentPanelProps {
  text: string;
  detections: Detection[];
  /** Which spans are currently ticked, keyed "start:end". */
  accepted: Record<string, boolean>;
  /** Jump the review list to a blank when its highlight is clicked. */
  onFocusDetection?: (d: Detection) => void;
  /** Add a blank over the reader's selection. */
  onMakeBlank?: (start: number, end: number, original: string) => void;
}

export function ImportDocumentPanel({
  text, detections, accepted, onFocusDetection, onMakeBlank,
}: ImportDocumentPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);

  /** Text split into plain runs and highlighted spans, in order. */
  const pieces = useMemo(() => {
    const sorted = [...detections].sort((a, b) => a.start - b.start);
    const out: Array<{ text: string; det?: Detection; at: number }> = [];
    let cursor = 0;
    for (const d of sorted) {
      if (d.start < cursor) continue;              // overlap guard
      if (d.start > cursor) {
        out.push({ text: text.slice(cursor, d.start), at: cursor });
      }
      out.push({ text: text.slice(d.start, d.end), det: d, at: d.start });
      cursor = d.end;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), at: cursor });
    return out;
  }, [text, detections]);

  /**
   * Turn a DOM selection into offsets into `text`.
   *
   * Every piece carries its own start offset in a data attribute, so this is
   * arithmetic on known anchors rather than walking and counting the DOM —
   * which would quietly break the moment the markup changed.
   */
  const readSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !hostRef.current) { setSelection(null); return; }
    if (!hostRef.current.contains(sel.anchorNode) || !hostRef.current.contains(sel.focusNode)) {
      setSelection(null);
      return;
    }

    const offsetOf = (node: Node | null, offset: number): number | null => {
      let el: HTMLElement | null =
        node?.nodeType === Node.TEXT_NODE
          ? (node.parentElement as HTMLElement | null)
          : (node as HTMLElement | null);
      while (el && !el.dataset?.at) el = el.parentElement;
      if (!el?.dataset.at) return null;
      return Number(el.dataset.at) + offset;
    };

    const a = offsetOf(sel.anchorNode, sel.anchorOffset);
    const b = offsetOf(sel.focusNode, sel.focusOffset);
    if (a == null || b == null) { setSelection(null); return; }
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    if (end - start < 1) { setSelection(null); return; }

    // Refuse a selection that straddles an existing blank: the server would
    // drop one of the two as an overlap, which looks like the click failed.
    const clashes = detections.some((d) => start < d.end && end > d.start);
    setSelection(clashes ? null : { start, end });
  }, [detections]);

  const makeBlank = () => {
    if (!selection || !onMakeBlank) return;
    onMakeBlank(selection.start, selection.end, text.slice(selection.start, selection.end));
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  return (
    <section style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: 'var(--foreground)' }}>
          Your document
        </h3>
        <span style={{ fontSize: '0.74rem', color: 'var(--muted-foreground)' }}>
          Select any text to add a blank the scan missed
        </span>
        {selection && (
          <button
            type="button"
            onClick={makeBlank}
            className="btn btn-primary btn-sm"
            style={{ marginLeft: 'auto', fontSize: '0.76rem' }}
          >
            <Scissors size={13} /> Make blank
          </button>
        )}
      </header>

      <div
        ref={hostRef}
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        style={{
          maxHeight: 460, overflowY: 'auto', padding: '14px 16px',
          borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          background: 'var(--card-solid)', color: 'var(--foreground)',
          fontSize: '0.82rem', lineHeight: 1.7, whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {pieces.map((piece, i) => {
          if (!piece.det) {
            return <span key={i} data-at={piece.at}>{piece.text}</span>;
          }
          const on = accepted[`${piece.det.start}:${piece.det.end}`];
          const conf = piece.det.confidence;
          return (
            <span
              key={i}
              data-at={piece.at}
              role="button"
              tabIndex={0}
              title={`${piece.det.label} (${conf} confidence) — ${piece.det.reason}`}
              onClick={() => onFocusDetection?.(piece.det!)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onFocusDetection?.(piece.det!);
                }
              }}
              style={{
                background: on ? TINT[conf] : 'transparent',
                borderBottom: `2px solid ${on ? EDGE[conf] : 'var(--border)'}`,
                borderRadius: '3px 3px 0 0',
                padding: '0 2px',
                cursor: 'pointer',
                opacity: on ? 1 : 0.5,
              }}
            >
              {piece.text.trim() ? piece.text : ' '}
            </span>
          );
        })}
      </div>

      <p style={{
        display: 'flex', alignItems: 'flex-start', gap: 6, margin: 0,
        fontSize: '0.72rem', color: 'var(--muted-foreground)', lineHeight: 1.5,
      }}>
        <Info size={12} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
        This is the text as it was read from your file. Formatting, headings and
        tables are kept in the template itself — they are just not shown here.
      </p>
    </section>
  );
}

export default ImportDocumentPanel;
