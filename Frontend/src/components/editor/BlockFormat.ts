/**
 * DocFlow — paragraph-level line spacing and indentation (spec FR-6.1).
 *
 * TipTap's own LineHeight puts the value on the `textStyle` MARK, which makes
 * it a property of a run of characters rather than of the paragraph. Word's
 * line spacing is a paragraph property, and so is what the PDF renderer has
 * to reproduce, so these two attributes live on the block instead.
 *
 * Both render through `style`, and TipTap's `mergeAttributes` merges style
 * declarations rather than overwriting them, so the two compose with
 * `textAlign` on the same paragraph.
 *
 * Values are constrained here AND on the server (`content_sanitizer`): the
 * attribute ends up inside a style attribute in every viewer's DOM, so an
 * arbitrary string would be a CSS-injection hole.
 */
import { Extension } from '@tiptap/react';

export const LINE_HEIGHTS = ['1', '1.15', '1.5', '2'] as const;
export type LineHeight = (typeof LINE_HEIGHTS)[number];

/** One indent step, in the same unit the PDF renderer uses. */
export const INDENT_STEP_EM = 2;
export const MAX_INDENT = 8;

const BLOCK_TYPES = ['paragraph', 'heading'];

/**
 * This import is load-bearing, not decoration. A `declare module` augmentation
 * only applies when TypeScript has the target module in the program, and every
 * other file here imports from '@tiptap/react'. Without a direct reference the
 * augmentation below fails with TS2664 ("module '@tiptap/core' cannot be
 * found"), the three commands never reach `RawCommands`, and `tsc -b` — and so
 * `npm run build` — fails on this file and on EditorToolbar's call sites.
 *
 * '@tiptap/core' is not listed in package.json; it arrives as a dependency of
 * '@tiptap/react', which cannot work without it. The augmentation already
 * relied on that, so this only makes the reliance visible. Worth promoting to
 * a direct, pinned dependency.
 */
import type { Editor } from '@tiptap/core';

/** The editor these commands run against. */
export type BlockFormatEditor = Editor;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockFormat: {
      setLineSpacing: (value: LineHeight | null) => ReturnType;
      indentMore: () => ReturnType;
      indentLess: () => ReturnType;
    };
  }
}

export const BlockFormat = Extension.create({
  name: 'blockFormat',

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const raw = el.style.lineHeight;
              return (LINE_HEIGHTS as readonly string[]).includes(raw) ? raw : null;
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const value = attrs.lineHeight;
              if (typeof value !== 'string'
                || !(LINE_HEIGHTS as readonly string[]).includes(value)) return {};
              return { style: `line-height: ${value}` };
            },
          },
          indent: {
            default: 0,
            parseHTML: (el: HTMLElement) => {
              const n = parseInt(el.getAttribute('data-indent') || '0', 10);
              return Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_INDENT) : 0;
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              const level = Number(attrs.indent) || 0;
              if (level <= 0) return {};
              const clamped = Math.min(level, MAX_INDENT);
              return {
                'data-indent': String(clamped),
                style: `margin-inline-start: ${clamped * INDENT_STEP_EM}em`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    /** The block the cursor is in, or null when it is not one of ours. */
    const blockType = (editor: typeof this.editor): string | null => {
      const name = editor.state.selection.$from.parent.type.name;
      return BLOCK_TYPES.includes(name) ? name : null;
    };

    return {
      setLineSpacing: (value) => ({ chain }) => {
        const type = blockType(this.editor);
        if (!type) return false;
        return chain().updateAttributes(type, { lineHeight: value }).run();
      },

      indentMore: () => ({ chain }) => {
        const type = blockType(this.editor);
        if (!type) return false;
        const current = Number(this.editor.getAttributes(type).indent ?? 0);
        if (current >= MAX_INDENT) return false;
        return chain().updateAttributes(type, { indent: current + 1 }).run();
      },

      indentLess: () => ({ chain }) => {
        const type = blockType(this.editor);
        if (!type) return false;
        const current = Number(this.editor.getAttributes(type).indent ?? 0);
        if (current <= 0) return false;
        return chain().updateAttributes(type, { indent: current - 1 }).run();
      },
    };
  },

  addKeyboardShortcuts() {
    // Tab belongs to tables and lists; Word's own indent shortcuts are free.
    return {
      'Mod-]': () => this.editor.commands.indentMore(),
      'Mod-[': () => this.editor.commands.indentLess(),
    };
  },
});

export default BlockFormat;
