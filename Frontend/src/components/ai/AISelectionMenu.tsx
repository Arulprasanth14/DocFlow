/**
 * AISelectionMenu — the floating menu that appears over selected text (FR-10.1).
 *
 * Five named actions, because "ask the AI something" is a blank page and
 * "shorten this" is a decision someone has already made. Each one is just a
 * preset instruction handed to the same `/ai/rewrite` call the toolbar button
 * uses, so accept/reject, the confidence label, the placeholder-damage check
 * and the audit record are all shared — this adds a way to ask, not a second
 * code path.
 *
 * Nothing here applies anything. Every action opens the same diff dialog with
 * Accept and Discard, per the module's rule that AI never writes to a document
 * on its own.
 *
 * The menu is suppressed for a selection long enough that a rewrite would be
 * a different feature (the server refuses past 4,000 characters anyway), and
 * for an empty selection, so it never covers the text you are trying to read.
 */
import { useState } from 'react';
// v3 moved the menus to their own subpath; importing from the package
// root compiles against nothing.
import { BubbleMenu } from '@tiptap/react/menus';
import type { Editor } from '@tiptap/react';
import {
  ChevronLeft, Expand, Shrink, SpellCheck, Sparkles, Volume2, Wand2,
} from 'lucide-react';

/** Matches BUDGET_REWRITE in ai_assist_service.py. */
const MAX_SELECTION = 4000;

export interface AIPreset {
  key: string;
  label: string;
  icon: React.ReactNode;
  /** Sent verbatim as the author's instruction. */
  instruction: string;
}

const PRESETS: AIPreset[] = [
  {
    key: 'improve',
    label: 'Improve',
    icon: <Wand2 size={13} />,
    instruction: 'Improve the clarity and flow of this text without changing its meaning.',
  },
  {
    key: 'shorten',
    label: 'Shorten',
    icon: <Shrink size={13} />,
    instruction: 'Make this noticeably shorter while keeping every fact and obligation.',
  },
  {
    key: 'expand',
    label: 'Expand',
    icon: <Expand size={13} />,
    instruction: 'Expand this with more detail, inventing no new facts.',
  },
  {
    key: 'grammar',
    label: 'Fix grammar',
    icon: <SpellCheck size={13} />,
    instruction: 'Correct grammar, spelling and punctuation only. Change nothing else.',
  },
];

const TONES: { key: string; label: string; instruction: string }[] = [
  { key: 'formal', label: 'More formal', instruction: 'Rewrite this in a more formal, professional tone.' },
  { key: 'friendly', label: 'Friendlier', instruction: 'Rewrite this in a warmer, friendlier tone.' },
  { key: 'plain', label: 'Plain English', instruction: 'Rewrite this in plain English, avoiding jargon and legalese.' },
];

export interface AISelectionMenuProps {
  editor: Editor | null;
  /** Hidden entirely when the org switch is off or the user opted out. */
  enabled: boolean;
  /** Runs a rewrite with this instruction and opens the accept/discard dialog. */
  onPreset: (instruction: string) => void;
  /** Opens the dialog with no preset, for the author's own wording. */
  onCustom: () => void;
  /** True while a rewrite is in flight, so the menu can show it is busy. */
  busy?: boolean;
}

export function AISelectionMenu({
  editor, enabled, onPreset, onCustom, busy = false,
}: AISelectionMenuProps) {
  const [toneOpen, setToneOpen] = useState(false);

  if (!editor || !enabled) return null;

  return (
    <BubbleMenu
      editor={editor}
      // `shouldShow` runs on every selection change, so it stays cheap: a
      // size check and two state reads, no document walking.
      shouldShow={({ editor: ed, from, to }: { editor: Editor; from: number; to: number }) => {
        if (from === to) return false;
        if (to - from > MAX_SELECTION) return false;
        // Not over an image or a placeholder node — "shorten this" is
        // meaningless there, and the node has its own selection bar.
        if (ed.isActive('image') || ed.isActive('placeholder')) return false;
        return true;
      }}
      options={{ placement: 'top', offset: 8 }}
    >
      <div
        role="toolbar"
        aria-label="AI actions for the selected text"
        // A toolbar must be focusable to be announced as one. -1 rather
        // than 0: the author is mid-selection in the editor and should
        // not have a new tab stop appear in front of them.
        tabIndex={-1}
        style={{
          display: 'flex', alignItems: 'center', gap: 2, padding: 4,
          borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          background: 'var(--card-solid)',
          boxShadow: 'var(--shadow-lg, 0 10px 30px rgb(0 0 0 / 0.16))',
        }}
        onMouseLeave={() => setToneOpen(false)}
      >
        {toneOpen ? (
          <>
            <button
              type="button" className="ribbon-btn" aria-label="Back to all AI actions"
              onClick={() => setToneOpen(false)}
              style={{ width: 'auto', padding: '0 6px' }}
            ><ChevronLeft size={13} /></button>
            {TONES.map((t) => (
              <button
                key={t.key}
                type="button"
                className="ribbon-btn"
                disabled={busy}
                onClick={() => { setToneOpen(false); onPreset(t.instruction); }}
                style={{ width: 'auto', padding: '0 8px', gap: 5, fontSize: '0.78rem' }}
              >{t.label}</button>
            ))}
          </>
        ) : (
          <>
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className="ribbon-btn"
                disabled={busy}
                title={p.instruction}
                onClick={() => onPreset(p.instruction)}
                style={{ width: 'auto', padding: '0 8px', gap: 5, fontSize: '0.78rem' }}
              >{p.icon} {p.label}</button>
            ))}
            <button
              type="button"
              className="ribbon-btn"
              disabled={busy}
              aria-expanded={toneOpen}
              onClick={() => setToneOpen(true)}
              style={{ width: 'auto', padding: '0 8px', gap: 5, fontSize: '0.78rem' }}
            ><Volume2 size={13} /> Tone</button>
            <span aria-hidden style={{ width: 1, height: 18, background: 'var(--border)', margin: '0 2px' }} />
            <button
              type="button"
              className="ribbon-btn"
              disabled={busy}
              title="Describe the change in your own words"
              onClick={onCustom}
              style={{ width: 'auto', padding: '0 8px', gap: 5, fontSize: '0.78rem' }}
            ><Sparkles size={13} /> Ask&hellip;</button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}

export default AISelectionMenu;
