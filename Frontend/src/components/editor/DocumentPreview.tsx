/**
 * DocFlow — read-only render of editor content (spec FR-11.1, FR-12.2/12.5).
 *
 * One component serves three surfaces, because all three are "the same document,
 * not editable, with blanks shown differently":
 *   - Template preview, Blank mode   → blanks highlighted, no answers
 *   - Template preview, Try-it mode  → sample answers filled in
 *   - Form Fill / Preview & verify   → the user's real answers filled in
 *
 * It runs the same TipTap schema as the editor, so what you preview is exactly
 * what you authored — no second renderer to drift out of step.
 */
import { useEffect, useMemo } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { PLACEHOLDER_NODE } from './PlaceholderNode';
import { createExtensions } from './extensions';

type Json = Record<string, unknown>;

function isRuleSatisfied(
  rule: { field?: string; op?: string; value?: unknown } | undefined,
  answers: Record<string, unknown>,
): boolean {
  if (!rule || !rule.field) return true;
  const actual = answers[rule.field];
  const target = rule.value;
  switch (rule.op) {
    case 'neq':
    case '!=':
      return actual !== target && String(actual) !== String(target);
    case 'in':
      return Array.isArray(target) ? target.includes(actual) : false;
    case 'not_in':
      return Array.isArray(target) ? !target.includes(actual) : true;
    case 'truthy':
      return !!actual && actual !== '' && actual !== 'false';
    case 'falsy':
      return !actual || actual === '' || actual === 'false';
    case 'eq':
    case '==':
    default:
      return actual === target || String(actual) === String(target);
  }
}

function findPlaceholdersInNode(node: unknown): Json[] {
  const list: Json[] = [];
  if (!node || typeof node !== 'object') return list;
  const n = node as Json & { content?: unknown[] };
  if (n.type === PLACEHOLDER_NODE) list.push(n);
  if (Array.isArray(n.content)) {
    for (const c of n.content) list.push(...findPlaceholdersInNode(c));
  }
  return list;
}

/**
 * Clone the document, writing each answer onto its blank's `value` attribute.
 * Every occurrence sharing a field key gets the same value, which is what
 * makes linked placeholders update together (FR-7.4 / FR-12.6).
 *
 * `if_empty_behavior: 'remove_phrase'` drops the blank entirely when there is
 * no answer, rather than leaving a gap (FR-7.7 / FR-12.5).
 *
 * FR-7.10: conditional fields (visible_when) and repeating sections (repeat_group).
 */
export function applyAnswers(
  content: unknown,
  answers: Record<string, unknown>,
  ifEmpty: Record<string, string> = {},
): Json {
  const walk = (node: unknown, currentAnswers: Record<string, unknown>): Json | null => {
    if (!node || typeof node !== 'object') return null;
    const n = { ...(node as Json) } as Json & { type?: string; attrs?: Json; content?: unknown[] };

    if (n.type === PLACEHOLDER_NODE) {
      const attrs = (n.attrs || {}) as Json;
      const rule = attrs.visible_when as { field?: string; op?: string; value?: unknown } | undefined;
      if (rule && !isRuleSatisfied(rule, currentAnswers)) {
        return null;
      }
      const key = (attrs.fieldKey as string) || '';
      const raw = currentAnswers[key];
      const text = raw == null || raw === '' ? '' : formatAnswer(raw);
      if (!text && ifEmpty[key] === 'remove_phrase') return null;
      n.attrs = { ...attrs, value: text };
      return n;
    }

    if (Array.isArray(n.content)) {
      const nextChildren: Json[] = [];
      for (const child of n.content) {
        if (!child || typeof child !== 'object') continue;
        const childJson = child as Json & { attrs?: Json };
        const childAttrs = (childJson.attrs || {}) as Json;
        const phs = findPlaceholdersInNode(childJson);
        const phKeys = phs.map((p) => (p.attrs as Json)?.fieldKey as string).filter(Boolean);

        // Check if this child block belongs to a repeating section in currentAnswers
        let repeatList: Record<string, unknown>[] | null = null;
        const sec = (childAttrs.section || childAttrs.repeat_group) as string | undefined;
        if (sec && Array.isArray(currentAnswers[sec])) {
          repeatList = currentAnswers[sec] as Record<string, unknown>[];
        } else {
          for (const [k, v] of Object.entries(currentAnswers)) {
            if (Array.isArray(v) && !k.startsWith('_')) {
              if (v.length === 0) {
                if (phs.some((p) => (p.attrs as Json)?.section === k || (p.attrs as Json)?.repeat_group === k)) {
                  repeatList = [];
                  break;
                }
              } else if (typeof v[0] === 'object' && v[0] !== null) {
                const itemKeys = Object.keys(v[0]);
                if (phKeys.some((pk) => itemKeys.includes(pk))) {
                  repeatList = v as Record<string, unknown>[];
                  break;
                }
              }
            }
          }
        }

        if (repeatList !== null) {
          if (repeatList.length === 0) {
            // Unfilled repeating section: drop this block from the preview
            continue;
          }
          for (const inst of repeatList) {
            const merged = { ...currentAnswers, ...inst };
            const renderedChild = walk(childJson, merged);
            if (renderedChild) nextChildren.push(renderedChild);
          }
        } else {
          const renderedChild = walk(childJson, currentAnswers);
          if (renderedChild) nextChildren.push(renderedChild);
        }
      }
      n.content = nextChildren;
    }
    return n;
  };

  const out = walk(content, answers);
  return out ?? { type: 'doc', content: [{ type: 'paragraph' }] };
}

function formatAnswer(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

export interface DocumentPreviewProps {
  content: unknown;
  /** Answers by field key. Omit for Blank mode. */
  answers?: Record<string, unknown>;
  ifEmpty?: Record<string, string>;
  /** Scrolls to and flashes this field's blank(s). */
  activeFieldKey?: string | null;
  /** Clicking a blank jumps to its question (FR-8.3 / FR-12.2). */
  onBlankClick?: (fieldKey: string) => void;
  /** Hide the amber "unconfigured" tint — used in Try-it mode. */
  plain?: boolean;
}

export function DocumentPreview({
  content, answers, ifEmpty, activeFieldKey, onBlankClick, plain,
}: DocumentPreviewProps) {
  const doc = useMemo(
    () => (answers ? applyAnswers(content, answers, ifEmpty) : (content as Json)),
    [content, answers, ifEmpty],
  );

  // The editor instance is created once and then fed new content. Passing
  // `doc` as a dependency would tear down and rebuild ProseMirror on every
  // keystroke in Form Fill, which is exactly what FR-12.2 cannot afford.
  const editor = useEditor({
    immediatelyRender: false,
    editable: false,
    extensions: createExtensions({ resizableTables: false }),
    content: isEmpty(doc) ? { type: 'doc', content: [{ type: 'paragraph' }] } : doc,
    editorProps: { attributes: { 'aria-label': 'Document preview' } },
  });

  useEffect(() => {
    if (!editor) return;
    const next = isEmpty(doc) ? { type: 'doc', content: [{ type: 'paragraph' }] } : doc;
    // Cheap guard: skip the transaction when nothing actually changed.
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(next)) return;
    editor.commands.setContent(next, { emitUpdate: false });
  }, [editor, doc]);

  // Clicking a blank in the preview selects its question.
  useEffect(() => {
    if (!onBlankClick || !editor) return;
    const root = editor.view.dom;
    const handler = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.ph-blank');
      const key = el?.getAttribute('data-field-key');
      if (key) onBlankClick(key);
    };
    root.addEventListener('click', handler);
    return () => root.removeEventListener('click', handler);
  }, [editor, onBlankClick]);

  // Scroll the active blank into view and pulse it (FR-8.2).
  useEffect(() => {
    if (!editor || !activeFieldKey) return;
    const root = editor.view.dom;
    const matches = root.querySelectorAll<HTMLElement>(
      `.ph-blank[data-field-key="${CSS.escape(activeFieldKey)}"]`,
    );
    matches.forEach((el) => el.classList.add('ph-active'));
    matches[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => matches.forEach((el) => el.classList.remove('ph-active')), 1400);
    return () => {
      clearTimeout(t);
      matches.forEach((el) => el.classList.remove('ph-active'));
    };
  }, [editor, activeFieldKey, doc]);

  return (
    <div className={`tt-paper${plain ? ' tt-paper-plain' : ''}`} data-clickable-blanks={onBlankClick ? '' : undefined}>
      <EditorContent editor={editor} />
    </div>
  );
}

function isEmpty(c: unknown): boolean {
  if (!c || typeof c !== 'object') return true;
  const doc = c as { type?: string; content?: unknown[] };
  return doc.type !== 'doc' || !Array.isArray(doc.content) || doc.content.length === 0;
}

export default DocumentPreview;
