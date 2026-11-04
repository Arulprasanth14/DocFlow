/**
 * GhostText — inline AI completion, drawn in grey ahead of the cursor (FR-10.1).
 *
 * This is the only AI feature in the module that fires without the author
 * asking for it, so it is the most constrained one:
 *
 *   · **Off by default**, per author, remembered in localStorage. Same
 *     reasoning as the import LLM pass: text must not leave on a timer
 *     because a default said so.
 *   · Only at the end of a text block, only after a pause, only when there is
 *     enough text to continue from.
 *   · The suggestion is a decoration, not content. Until Tab is pressed it is
 *     not in the document, cannot be saved, and cannot reach a PDF — which is
 *     what keeps "AI never auto-applies" true at the data layer rather than
 *     just in the UI.
 *   · Any edit, any cursor move, Esc, or a blur throws it away.
 *
 * Keys: **Tab** accepts, **Esc** dismisses. Tab is only intercepted while a
 * suggestion is showing, so it still moves focus the rest of the time.
 */
import { Extension } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const ghostTextKey = new PluginKey<GhostState>('docflowGhostText');

/** Shortest run of text worth asking for a continuation of. */
const MIN_CONTEXT = 12;
/** How much of the preceding text is sent. Matches the server's budget. */
const CONTEXT_CHARS = 800;

interface GhostState {
  /** The suggestion currently on screen, or '' for none. */
  text: string;
  /** Document position the suggestion belongs to. */
  pos: number;
}

const EMPTY: GhostState = { text: '', pos: -1 };

export interface GhostTextOptions {
  /**
   * Asks the server for a continuation. Returning '' means "nothing useful",
   * which draws nothing. Rejections are swallowed by the caller — a failed
   * suggestion must never interrupt typing.
   */
  fetchSuggestion: ((before: string) => Promise<string>) | null;
  /** Author's switch. False disables every timer and request. */
  enabled: boolean;
  /** Idle time before asking, in ms. */
  debounceMs: number;
  /** Fires when a suggestion is accepted, for the audit decision record. */
  onAccept: ((text: string) => void) | null;
}

/** Plain text from the start of the doc up to `pos`, capped. */
function contextBefore(doc: { textBetween: (a: number, b: number, s?: string) => string }, pos: number): string {
  const from = Math.max(0, pos - CONTEXT_CHARS * 2);
  return doc.textBetween(from, pos, '\n').slice(-CONTEXT_CHARS);
}

export const GhostText = Extension.create<GhostTextOptions>({
  name: 'ghostText',

  addOptions() {
    return {
      fetchSuggestion: null,
      enabled: false,
      debounceMs: 900,
      onAccept: null,
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const state = ghostTextKey.getState(this.editor.state);
        if (!state?.text) return false; // let Tab do its usual job
        const { text } = state;
        this.editor
          .chain()
          .focus()
          .insertContent(text)
          .command(({ tr, dispatch }) => {
            if (dispatch) tr.setMeta(ghostTextKey, EMPTY);
            return true;
          })
          .run();
        this.options.onAccept?.(text);
        return true;
      },
      Escape: () => {
        const state = ghostTextKey.getState(this.editor.state);
        if (!state?.text) return false;
        this.editor.view.dispatch(
          this.editor.state.tr.setMeta(ghostTextKey, EMPTY),
        );
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Bumped on every request; a reply from an older one is discarded. */
    let generation = 0;

    return [
      new Plugin<GhostState>({
        key: ghostTextKey,

        state: {
          init: () => EMPTY,
          apply(tr, value) {
            const meta = tr.getMeta(ghostTextKey) as GhostState | undefined;
            if (meta) return meta;
            // Any change to the document or the selection invalidates it:
            // a suggestion that no longer sits at the cursor is misleading.
            if (tr.docChanged || tr.selectionSet) return EMPTY;
            return value;
          },
        },

        props: {
          decorations(state) {
            const ghost = ghostTextKey.getState(state);
            if (!ghost?.text || ghost.pos < 0) return null;
            return DecorationSet.create(state.doc, [
              Decoration.widget(
                ghost.pos,
                () => {
                  const span = document.createElement('span');
                  span.className = 'ghost-text';
                  span.setAttribute('aria-hidden', 'true');
                  span.textContent = ghost.text;
                  return span;
                },
                // `side: 1` keeps the widget after the cursor, and marking it
                // ignored keeps ProseMirror from treating it as content.
                { side: 1, ignoreSelection: true, key: `ghost-${ghost.text.length}` },
              ),
            ]);
          },
        },

        view(view) {
          const schedule = () => {
            if (timer) clearTimeout(timer);
            if (!options.enabled || !options.fetchSuggestion) return;

            const { state } = view;
            const { selection } = state;
            if (!selection.empty) return;

            const $pos = selection.$from;
            // Only at the end of a text block: suggesting into the middle of a
            // sentence fights the author instead of helping.
            if ($pos.parentOffset !== $pos.parent.content.size) return;
            if (!$pos.parent.isTextblock) return;

            const pos = selection.from;
            const before = contextBefore(state.doc, pos);
            if (before.trim().length < MIN_CONTEXT) return;

            const mine = ++generation;
            timer = setTimeout(() => {
              void options
                .fetchSuggestion!(before)
                .then((text) => {
                  if (mine !== generation) return;      // superseded
                  if (!text) return;
                  const live = view.state.selection;
                  // The cursor must still be where it was when we asked.
                  if (!live.empty || live.from !== pos) return;
                  view.dispatch(view.state.tr.setMeta(ghostTextKey, { text, pos }));
                })
                .catch(() => {
                  /* A failed suggestion is a non-event. Never interrupt typing. */
                });
            }, options.debounceMs);
          };

          return {
            update(_view, prevState) {
              const changed =
                !prevState.doc.eq(view.state.doc) ||
                !prevState.selection.eq(view.state.selection);
              if (changed) {
                generation += 1; // abandon anything in flight
                schedule();
              }
            },
            destroy() {
              if (timer) clearTimeout(timer);
              timer = null;
            },
          };
        },
      }),
    ];
  },
});

export default GhostText;
