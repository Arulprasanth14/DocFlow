/**
 * DocFlow — find and replace in the editor (spec FR-6.6).
 *
 * Works on ProseMirror positions rather than the rendered DOM, so a match is
 * always something the editor can select and replace, and highlighting cannot
 * drift out of step with the document.
 *
 * Two deliberate limits:
 *   - Placeholders are atoms with no searchable text, so a blank is never a
 *     match. Replacing text can therefore never destroy a question.
 *   - Replace operates on one match at a time from a freshly computed list, so
 *     a replacement that changes document length cannot corrupt the positions
 *     of the matches still to come.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Search, X, ChevronUp, ChevronDown, Replace, CheckCheck, CaseSensitive,
} from 'lucide-react';

interface Match {
  from: number;
  to: number;
}

/** Every occurrence of `term` in the document's text nodes. */
function findMatches(editor: Editor | null, term: string, matchCase: boolean): Match[] {
  if (!editor || !term) return [];
  const needle = matchCase ? term : term.toLowerCase();
  const out: Match[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const haystack = matchCase ? node.text : node.text.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      out.push({ from: pos + at, to: pos + at + term.length });
      at = haystack.indexOf(needle, at + Math.max(1, needle.length));
      if (out.length > 5000) return false;   // a runaway search helps nobody
    }
    return true;
  });

  return out;
}

export interface FindReplaceBarProps {
  editor: Editor | null;
  open: boolean;
  onClose: () => void;
}

export function FindReplaceBar({ editor, open, onClose }: FindReplaceBarProps) {
  const [term, setTerm] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [index, setIndex] = useState(0);
  const [docVersion, setDocVersion] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);

  // Recompute after any document change, so the count is never stale.
  useEffect(() => {
    if (!editor) return;
    const bump = () => setDocVersion((v) => v + 1);
    editor.on('update', bump);
    return () => { editor.off('update', bump); };
  }, [editor]);

  const matches = useMemo(
    () => findMatches(editor, term, matchCase),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- docVersion is the document-change signal
    [editor, term, matchCase, docVersion],
  );

  useEffect(() => { setIndex(0); }, [term, matchCase]);
  useEffect(() => { if (open) findInput.current?.focus(); }, [open]);

  const select = useCallback((i: number) => {
    if (!editor || matches.length === 0) return;
    const wrapped = ((i % matches.length) + matches.length) % matches.length;
    const m = matches[wrapped];
    setIndex(wrapped);
    editor.chain().focus().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run();
  }, [editor, matches]);

  const replaceOne = useCallback(() => {
    if (!editor || matches.length === 0) return;
    const m = matches[Math.min(index, matches.length - 1)];
    editor.chain().focus()
      .insertContentAt({ from: m.from, to: m.to }, replacement)
      .run();
    // The list is recomputed by the update handler; stay on the same ordinal
    // so repeated clicks walk forward naturally.
  }, [editor, matches, index, replacement]);

  const replaceAll = useCallback(() => {
    if (!editor || !term) return;
    // Back to front: replacing shifts every position after the match, so
    // working forwards would invalidate the positions still to be used.
    const all = findMatches(editor, term, matchCase).sort((a, b) => b.from - a.from);
    if (all.length === 0) return;
    const chain = editor.chain().focus();
    for (const m of all) {
      chain.insertContentAt({ from: m.from, to: m.to }, replacement);
    }
    chain.run();
  }, [editor, term, matchCase, replacement]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Enter' && document.activeElement === findInput.current) {
        e.preventDefault();
        select(e.shiftKey ? index - 1 : index + 1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, select, index]);

  if (!open) return null;

  const count = matches.length;

  return (
    <div
      role="search"
      aria-label="Find and replace"
      style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
        padding: '8px 10px', marginBottom: 10,
        background: 'var(--card-solid)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', position: 'sticky', top: 56, zIndex: 4,
      }}
    >
      <Search size={14} style={{ color: 'var(--muted-foreground)' }} aria-hidden="true" />

      <input
        ref={findInput}
        className="input"
        value={term}
        placeholder="Find"
        aria-label="Find"
        onChange={(e) => setTerm(e.target.value)}
        style={{ width: 150, fontSize: '0.82rem', padding: '5px 8px' }}
      />

      <span
        aria-live="polite"
        style={{
          fontSize: '0.75rem', minWidth: 68,
          color: term && count === 0 ? 'var(--status-rejected-fg)' : 'var(--muted-foreground)',
        }}
      >
        {!term ? '' : count === 0 ? 'No matches' : `${index + 1} of ${count}`}
      </span>

      <button type="button" onClick={() => select(index - 1)} disabled={count === 0}
        className="btn btn-ghost btn-sm" aria-label="Previous match"
        style={{ padding: '3px 6px' }}>
        <ChevronUp size={14} />
      </button>
      <button type="button" onClick={() => select(index + 1)} disabled={count === 0}
        className="btn btn-ghost btn-sm" aria-label="Next match"
        style={{ padding: '3px 6px' }}>
        <ChevronDown size={14} />
      </button>

      <button
        type="button"
        onClick={() => setMatchCase((c) => !c)}
        aria-pressed={matchCase}
        title="Match case"
        aria-label="Match case"
        className={matchCase ? 'btn btn-secondary btn-sm' : 'btn btn-ghost btn-sm'}
        style={{ padding: '3px 6px' }}
      >
        <CaseSensitive size={14} />
      </button>

      <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />

      <input
        className="input"
        value={replacement}
        placeholder="Replace with"
        aria-label="Replace with"
        onChange={(e) => setReplacement(e.target.value)}
        style={{ width: 150, fontSize: '0.82rem', padding: '5px 8px' }}
      />

      <button type="button" onClick={replaceOne} disabled={count === 0}
        className="btn btn-ghost btn-sm" style={{ fontSize: '0.76rem' }}>
        <Replace size={13} /> Replace
      </button>
      <button type="button" onClick={replaceAll} disabled={count === 0}
        className="btn btn-ghost btn-sm" style={{ fontSize: '0.76rem' }}>
        <CheckCheck size={13} /> All
      </button>

      <button type="button" onClick={onClose} className="btn btn-ghost btn-sm"
        aria-label="Close find and replace" style={{ marginLeft: 'auto', padding: '3px 6px' }}>
        <X size={14} />
      </button>

      <p style={{
        flexBasis: '100%', margin: '2px 0 0', fontSize: '0.72rem',
        color: 'var(--muted-foreground)',
      }}>
        Blanks are never matched, so replacing text can&apos;t remove a question.
      </p>
    </div>
  );
}

export default FindReplaceBar;
