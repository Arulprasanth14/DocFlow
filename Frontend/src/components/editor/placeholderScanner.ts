/**
 * DocFlow — placeholder scanner (spec §8.7 FR-7.3/7.4, §9 PlaceholderOccurrence)
 *
 * Walks the document in order and:
 *   1. repairs any blank with a missing or DUPLICATED id (duplicates happen when
 *      the author copy-pastes a blank) so every occurrence keeps a stable,
 *      unique node id;
 *   2. numbers blanks 1..N in document order;
 *   3. reports occurrences plus the unique field keys, which is what drives
 *      "N blanks, M unique fields" and the one-question-per-unique-key rule.
 *
 * Several occurrences may share a fieldKey — those are *linked* and answered once.
 */
import type { Editor } from '@tiptap/react';
import type { PlaceholderOccurrence } from '@/lib/api/templates';
import { PLACEHOLDER_NODE, newPlaceholderId } from './PlaceholderNode';

export interface ScanResult {
  occurrences: PlaceholderOccurrence[];
  /** Unique field keys in first-appearance order — one question each. */
  uniqueKeys: string[];
  /** Total blanks (occurrences), which can exceed uniqueKeys.length. */
  blankCount: number;
}

export function scanPlaceholders(editor: Editor): ScanResult {
  // ── 1. normalise ids / keys / numbers in a single history-free transaction ──
  const seenIds = new Set<string>();
  const pending: { pos: number; attrs: Record<string, unknown> }[] = [];
  let order = 0;

  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== PLACEHOLDER_NODE) return;
    order += 1;

    let phId = node.attrs.phId as string | null;
    let fieldKey = node.attrs.fieldKey as string | null;
    const number = node.attrs.number as number;
    let changed = false;

    if (!phId || seenIds.has(phId)) { phId = newPlaceholderId(); changed = true; }
    seenIds.add(phId);
    if (!fieldKey) { fieldKey = `field_${order}`; changed = true; }
    if (number !== order) { changed = true; }

    if (changed) {
      pending.push({ pos, attrs: { ...node.attrs, phId, fieldKey, number: order } });
    }
  });

  if (pending.length) {
    // Attribute-only edits don't change document size, so positions stay valid.
    const tr = editor.state.tr;
    pending.forEach((u) => tr.setNodeMarkup(u.pos, undefined, u.attrs));
    // Not undoable and not a user edit: the follow-up scan finds nothing to fix,
    // so this terminates after one pass.
    editor.view.dispatch(tr.setMeta('addToHistory', false));
  }

  // ── 2. read the (now normalised) document ──────────────────────────────────
  const occurrences: PlaceholderOccurrence[] = [];
  const uniqueKeys: string[] = [];
  let n = 0;

  editor.state.doc.descendants((node) => {
    if (node.type.name !== PLACEHOLDER_NODE) return;
    n += 1;
    const fieldKey = (node.attrs.fieldKey as string) || `field_${n}`;
    const nodeId = (node.attrs.phId as string) || `ph_${n}`;
    occurrences.push({ field_key: fieldKey, node_id: nodeId, order_no: n });
    if (!uniqueKeys.includes(fieldKey)) uniqueKeys.push(fieldKey);
  });

  return { occurrences, uniqueKeys, blankCount: occurrences.length };
}

/** "12 blanks, 8 unique fields" (spec §27 microcopy). */
export function blanksSummary(scan: ScanResult): string {
  if (scan.blankCount === 0) return 'No blanks yet';
  const b = `${scan.blankCount} blank${scan.blankCount === 1 ? '' : 's'}`;
  const f = `${scan.uniqueKeys.length} unique field${scan.uniqueKeys.length === 1 ? '' : 's'}`;
  return `${b}, ${f}`;
}
