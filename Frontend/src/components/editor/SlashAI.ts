/**
 * DocFlow — "/ai" opens the assistant (spec FR-10.1).
 *
 * Typing a slash command is how people expect to reach an assistant inside a
 * document, and it keeps hands on the keyboard. It is only a shortcut: the
 * same panel is on the toolbar, and the panel still applies nothing without
 * an explicit Insert.
 *
 * Implemented as an input rule rather than a suggestion menu on purpose —
 * there is exactly one command, so a filtered popup list would be more
 * machinery than the feature is. The typed "/ai" is removed so the document
 * never keeps the command text.
 */
import { Extension, InputRule } from '@tiptap/react';

export interface SlashAIOptions {
  /**
   * Opens the assistant. Returns false when it cannot be opened right now
   * (AI off for the org, or the author opted out), in which case the typed
   * "/ai" is left alone as ordinary text rather than vanishing into nothing.
   */
  onTrigger: (() => boolean) | null;
}

export const SlashAI = Extension.create<SlashAIOptions>({
  name: 'slashAI',

  addOptions() {
    return { onTrigger: null };
  },

  addInputRules() {
    const options = this.options;
    return [
      new InputRule({
        // Only at the very start of a block or after whitespace, so a URL
        // path or "and/air" can never fire it.
        find: /(?:^|\s)\/ai$/,
        handler: ({ range, chain }) => {
          if (!options.onTrigger) return;
          if (!options.onTrigger()) return;     // left as plain text
          // The match may have swallowed the space before "/ai"; keep it.
          const from = range.to - 3;
          chain().deleteRange({ from, to: range.to }).run();
        },
      }),
    ];
  },
});

export default SlashAI;
