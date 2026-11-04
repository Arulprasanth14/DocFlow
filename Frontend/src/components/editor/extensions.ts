/**
 * DocFlow — the one TipTap schema.
 *
 * The template editor, the document editor and the read-only preview must all
 * run the SAME extension list. When they drifted apart, a node authored in one
 * surface rendered as nothing in another, which is exactly the failure the
 * preview exists to rule out. Everything builds its editor from here.
 *
 * The list is also the client half of a pair: the server's
 * `content_sanitizer.ALLOWED_NODES` is the authoritative allow-list. A node
 * added here without being added there is silently stripped on save — so the
 * two lists are changed together, on purpose.
 */
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { PlaceholderNode } from './PlaceholderNode';
import { ImageNode } from './ImageNode';
import { SlashAI } from './SlashAI';
import { GhostText } from './GhostText';
import { BlockFormat } from './BlockFormat';

export interface ExtensionOptions {
  /** Template and document bodies carry blanks; a plain note does not. */
  placeholders?: boolean;
  /** Column resizing is an editing affordance — off in read-only previews. */
  resizableTables?: boolean;
  /**
   * FR-10.1 — what "/ai" should open. Omitted (read-only previews, or an
   * org with AI switched off) the slash command is not registered at all,
   * so typing it leaves ordinary text.
   */
  onSlashAI?: (() => boolean) | null;
  /**
   * FR-10.1 — inline completion. Omitted, or with `enabled: false`, the
   * plugin registers no timer and sends nothing: the author's switch is
   * the only thing that starts it.
   */
  ghost?: {
    enabled: boolean;
    fetchSuggestion: (before: string) => Promise<string>;
    onAccept?: (text: string) => void;
  } | null;
}

export function createExtensions({
  placeholders = true,
  resizableTables = true,
  onSlashAI = null,
  ghost = null,
}: ExtensionOptions = {}) {
  return [
    StarterKit,
    TableKit.configure({
      table: { resizable: resizableTables, HTMLAttributes: { class: 'tt-table' } },
    }),
    // FR-6.1 ribbon. The kit also ships fontFamily (no picker, by decision),
    // backgroundColor (Highlight covers it) and its own lineHeight, which
    // sets an INLINE line-height on a text run — line spacing is a
    // paragraph property here, so BlockFormat owns it instead.
    TextStyleKit.configure({
      color: false,            // the standalone Color extension, below
      fontFamily: false,
      backgroundColor: false,
      lineHeight: false,
    }),
    Color,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    BlockFormat,
    ImageNode,
    ...(placeholders ? [PlaceholderNode] : []),
    ...(onSlashAI ? [SlashAI.configure({ onTrigger: onSlashAI })] : []),
    ...(ghost
      ? [GhostText.configure({
          enabled: ghost.enabled,
          fetchSuggestion: ghost.fetchSuggestion,
          onAccept: ghost.onAccept ?? null,
          debounceMs: 900,
        })]
      : []),
  ];
}

export default createExtensions;
