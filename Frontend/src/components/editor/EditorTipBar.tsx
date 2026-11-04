/**
 * DocFlow — how to make a blank, said where the author is looking.
 *
 * The instruction used to live in grey 12px text under the word count, after
 * the fold, which is why people wrote documents full of underscores and then
 * found the Questions stage empty. It sits above the canvas now, with the
 * keys drawn as keys, and can be dismissed once it has been read (FR-6.1).
 *
 * The second half is for the common case of drafting the text in a chat
 * assistant first: one prompt rule, copyable, that produces text this editor
 * can turn into blanks without any cleaning up.
 */
import { useState } from 'react';
import { Check, ChevronDown, Copy, Lightbulb, X } from 'lucide-react';

const DISMISS_KEY = 'docflow.editor.tipbar.dismissed';

/** The rule to paste into a chat assistant before asking it for a document. */
export const CHATGPT_PROMPT_RULE = [
  'Write the document as plain text.',
  'Wherever the person must fill something in, put three underscores ___ with',
  'a short label before it, e.g. Employee Name: ___.',
  'Reuse the same label for the same value.',
  'Use simple headings and lists; no tables unless needed, no markdown symbols,',
  'and no [brackets] for blanks.',
].join(' ');

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd style={{
      display: 'inline-block', padding: '1px 6px', margin: '0 1px',
      fontFamily: 'var(--font-mono)', fontSize: '0.74rem', fontWeight: 600,
      lineHeight: 1.6, color: 'var(--foreground)',
      background: 'var(--card-solid)', border: '1px solid var(--border)',
      borderBottomWidth: 2, borderRadius: 5, whiteSpace: 'nowrap',
    }}>{children}</kbd>
  );
}

export function EditorTipBar() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const [promptOpen, setPromptOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
  };

  const copyRule = async () => {
    try {
      await navigator.clipboard.writeText(CHATGPT_PROMPT_RULE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (insecure origin, permission). The text is on
      // screen and selectable, so there is nothing to recover from.
      setCopied(false);
    }
  };

  if (dismissed) return null;

  return (
    <div style={{
      display: 'grid', gap: 10, padding: '10px 12px', marginBottom: 12,
      borderRadius: 'var(--radius)', border: '1px solid var(--border)',
      background: 'var(--muted)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {/* --accent-amber is a decorative fill (2.0:1 on a light page); the
            amber token that is legible as a mark is --status-pending. */}
        <Lightbulb size={15} aria-hidden style={{ flexShrink: 0, color: 'var(--status-pending)' }} />
        <span style={{ fontSize: '0.82rem', color: 'var(--foreground)' }}>
          Type <Key>_</Key><Key>_</Key><Key>_</Key> or press <Key>Ctrl</Key>+<Key>Shift</Key>+<Key>B</Key> to add a blank
        </span>
        <button
          type="button"
          onClick={() => setPromptOpen((o) => !o)}
          aria-expanded={promptOpen}
          className="btn btn-ghost btn-sm"
          style={{ fontSize: '0.78rem', padding: '2px 8px', marginLeft: 'auto' }}
        >
          Writing in ChatGPT?
          <ChevronDown
            size={13}
            style={{ transform: promptOpen ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }}
          />
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss this tip"
          className="btn btn-ghost btn-sm"
          style={{ padding: '2px 6px' }}
        >
          <X size={14} />
        </button>
      </div>

      {promptOpen && (
        <div style={{
          display: 'grid', gap: 8, padding: '10px 12px',
          borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          background: 'var(--card-solid)',
        }}>
          <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--muted-foreground)' }}>
            Add this to your prompt, then paste the result here &mdash; the blanks
            come through as real questions.
          </p>
          <p style={{
            margin: 0, padding: '8px 10px', borderRadius: 'var(--radius)',
            background: 'var(--muted)', fontFamily: 'var(--font-mono)',
            fontSize: '0.76rem', lineHeight: 1.6, color: 'var(--foreground)',
            whiteSpace: 'pre-wrap',
          }}>{CHATGPT_PROMPT_RULE}</p>
          <button
            type="button"
            onClick={copyRule}
            className="btn btn-secondary btn-sm"
            style={{ justifySelf: 'start', fontSize: '0.78rem' }}
          >
            {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
          </button>
        </div>
      )}
    </div>
  );
}

export default EditorTipBar;
