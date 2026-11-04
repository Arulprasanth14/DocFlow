/**
 * DocFlow — TipTap placeholder node (spec §8.7 FR-7.1/7.2, §21.1)
 *
 * A blank is a STRUCTURED INLINE ATOM, never raw "*" / "__" text, so every
 * occurrence carries a stable id that highlighting and the field schema can
 * point at.
 *
 * Insert methods (FR-7.2): toolbar button, Ctrl/Cmd+Shift+B, or typing 3+
 * underscores / 3+ asterisks. A single "*" is deliberately left as normal text
 * (decision D1) — it is far too common in ordinary prose.
 */
import { Node, mergeAttributes, nodeInputRule } from '@tiptap/react';
import { Fragment, Slice, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { findBlankRuns } from './blankText';

export const PLACEHOLDER_NODE = 'placeholder';

/** Unique per occurrence, never reused (spec §21.1). */
export function newPlaceholderId(): string {
  return `ph_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

const attr = (name: string, dataName: string, fallback: unknown = null) => ({
  default: fallback,
  parseHTML: (el: HTMLElement) => el.getAttribute(dataName) ?? fallback,
  renderHTML: (attrs: Record<string, unknown>) =>
    attrs[name] == null || attrs[name] === '' ? {} : { [dataName]: String(attrs[name]) },
});

export const PlaceholderNode = Node.create({
  name: PLACEHOLDER_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      phId: attr('phId', 'data-ph-id'),
      fieldKey: attr('fieldKey', 'data-field-key'),
      label: attr('label', 'data-label', ''),
      number: attr('number', 'data-number', 0),
      // Set only in read-only previews (Try-it mode, Form Fill, Preview &
      // verify). The authoring document never stores a value — answers live
      // on the document, not in the template (FR-11.1 / FR-12.5).
      value: attr('value', 'data-value', ''),
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-placeholder]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = (node.attrs.label as string) || '';
    const value = (node.attrs.value as string) || '';
    const number = node.attrs.number || '';
    // An answered blank reads as ordinary prose with a subtle tint (FR-12.5);
    // an unanswered one still reads as a gap.
    const cls = value ? 'ph-blank ph-filled' : 'ph-blank';
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-placeholder': '', class: cls }),
      value || (label ? `${label}` : `Blank ${number}`),
    ];
  },

  /** Plain-text/AI form: placeholders travel as {{field_key}} tokens (FR-10.5). */
  renderText({ node }) {
    const value = (node.attrs.value as string) || '';
    if (value) return value;
    const key = node.attrs.fieldKey as string | null;
    return key ? `{{${key}}}` : '____';
  },

  addInputRules() {
    const make = () => ({ phId: newPlaceholderId() });
    return [
      nodeInputRule({ find: /(_{3,})$/, type: this.type, getAttributes: make }),
      nodeInputRule({ find: /(\*{3,})$/, type: this.type, getAttributes: make }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-b': () =>
        this.editor.commands.insertContent({
          type: PLACEHOLDER_NODE,
          attrs: { phId: newPlaceholderId() },
        }),
    };
  },

  /**
   * FR-7.2 — the same rule as typing, applied to pasted text.
   *
   * An input rule only fires on a keystroke, so a document written in Word
   * or ChatGPT and pasted in kept its underscores as literal text: visibly
   * full of blanks, and the Questions stage reporting none. This rewrites
   * each "___" run in the pasted slice into a placeholder node, naming it
   * from the words before it or the "(label)" after it.
   *
   * Only the pasted content is touched — nothing already in the document
   * moves — and identical labels share a key, so "Employee Name" twice is
   * one question with two occurrences (FR-7.4).
   */
  addProseMirrorPlugins() {
    const type = this.type;
    const editor = this.editor;

    const rewrite = (fragment: Fragment, used: Set<string>): Fragment => {
      const out: PMNode[] = [];
      fragment.forEach((node) => {
        if (node.isText && node.text) {
          const runs = findBlankRuns(node.text, used);
          if (runs.length === 0) { out.push(node); return; }
          runs.forEach((r) => used.add(r.key));

          let cursor = 0;
          for (const run of runs) {
            if (run.start > cursor) {
              out.push(node.cut(cursor, run.start));
            }
            out.push((type as NodeType).create({
              phId: newPlaceholderId(),
              fieldKey: run.key,
              label: run.label,
            }));
            cursor = run.end;
          }
          if (cursor < node.text.length) out.push(node.cut(cursor));
          return;
        }
        if (node.content.size > 0) {
          out.push(node.copy(rewrite(node.content, used)));
          return;
        }
        out.push(node);
      });
      return Fragment.fromArray(out);
    };

    return [
      new Plugin({
        key: new PluginKey('placeholderPaste'),
        props: {
          transformPasted(slice) {
            // Keys already spoken for, so a pasted blank cannot take over
            // a question that is already in the document.
            const used = new Set<string>();
            editor?.state.doc.descendants((n) => {
              if (n.type.name === PLACEHOLDER_NODE && n.attrs.fieldKey) {
                used.add(String(n.attrs.fieldKey));
              }
              return true;
            });
            const content = rewrite(slice.content, used);
            if (content.eq(slice.content)) return slice;
            return new Slice(content, slice.openStart, slice.openEnd);
          },
        },
      }),
    ];
  },
});

export default PlaceholderNode;
