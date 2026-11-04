/**
 * DocFlow — plain "___" runs, read as blanks (spec FR-7.2).
 *
 * People write documents elsewhere — Word, Notes, ChatGPT — and mark the
 * fill-ins with underscores. Pasted in, those used to stay as literal
 * underscores: the Questions stage then said "No blanks yet" about a document
 * that was visibly full of them.
 *
 * This is the client half of the rule. The authoritative, fuller version is
 * the server's `blank_detector` (the "Detect blanks" button), which also
 * handles {{tokens}}, [brackets], dotted and dashed runs and type inference.
 * Keeping this one small and obvious is deliberate: it has to run inside a
 * paste, synchronously, and anything it misses the button still catches.
 */

/** Three or more underscores in a row. */
const RUN_RE = /_{3,}/g;

/** "___ (Employee Name)" — the author named the blank right after it. */
const TRAILING_LABEL_RE = /^\s*\(([^)]{1,60})\)/;

/** Words that are punctuation or glue, never a useful question name. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'by', 'and', 'or', 'is',
  'are', 'was', 'were', 'be', 'this', 'that', 'with', 'at', 'as', 'between',
  'made', 'shall', 'hereby',
]);

/** Words that join two things; in a long phrase the name follows the last one. */
const JOINERS = new Set(['and', 'or', 'with', 'from', '&']);

export interface BlankRun {
  /** Offsets into the string that was searched. */
  start: number;
  end: number;
  label: string;
  key: string;
}

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

/**
 * Capitalise the first letter and leave the rest as the author wrote it.
 *
 * Matches the server's `_titlecase` exactly, so a document that is pasted in
 * and a document run through "Detect blanks" name the same blank the same
 * way — otherwise "Date Of Joining" and "Date of joining" would be two
 * questions instead of one.
 */
function titleCase(label: string): string {
  if (!label) return label;
  return label[0] === label[0].toUpperCase() ? label : label[0].toUpperCase() + label.slice(1);
}

/**
 * The words immediately before a blank, as a question name.
 *
 * Stops at a line break, a tab (a table-cell boundary) and at sentence
 * punctuation, so "…signed this agreement. Employee Name: ___" names the
 * blank "Employee Name" rather than quoting the whole sentence.
 */
function labelBefore(text: string, at: number): string {
  let window = text.slice(Math.max(0, at - 90), at);

  // Drop the separator the author put between the label and the blank.
  window = window.replace(/[\s:\-–—=.,]+$/, '');

  // A newline or tab ends the label; a full stop ends the previous sentence.
  const cut = Math.max(
    window.lastIndexOf('\n'),
    window.lastIndexOf('\t'),
    window.lastIndexOf('. '),
    window.lastIndexOf('; '),
  );
  if (cut !== -1) window = window.slice(cut + 1);

  // Parenthesised units — "Amount (INR): ___" — are not part of the name.
  window = window.replace(/\([^)]*\)\s*$/, '').trim();

  const words = window.split(/\s+/).filter(Boolean).slice(-5);

  // In a long phrase the question is whatever follows the last joining word:
  // "between the company and Employee Name" is asking for the name, not the
  // pair. Short phrases are left whole, so "Terms and conditions" survives.
  if (words.length > 3) {
    let lastJoin = -1;
    words.forEach((w, i) => {
      if (JOINERS.has(w.toLowerCase().replace(/,$/, '')) || w.endsWith(',')) lastJoin = i;
    });
    if (lastJoin > -1 && lastJoin < words.length - 1) words.splice(0, lastJoin + 1);
  }

  while (words.length > 1 && STOP_WORDS.has(words[0].toLowerCase())) words.shift();
  const label = words.join(' ').replace(/^[^A-Za-z0-9]+/, '').trim();
  return label.length >= 2 ? titleCase(label) : '';
}

/**
 * Every "___" run in `text`, each with a question name.
 *
 * Runs that end up with the same label share a key, which is what makes two
 * occurrences of "Employee Name: ___" one question rather than two (FR-7.4).
 * `usedKeys` lets a caller reserve the keys already in the document so a new
 * blank cannot quietly take over an existing question.
 */
export function findBlankRuns(text: string, usedKeys: Iterable<string> = []): BlankRun[] {
  const taken = new Set(usedKeys);
  const byLabel = new Map<string, string>();
  const runs: BlankRun[] = [];
  let anonymous = 0;

  RUN_RE.lastIndex = 0;
  let match = RUN_RE.exec(text);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;

    const after = TRAILING_LABEL_RE.exec(text.slice(end, end + 70));
    const label = after ? titleCase(after[1].trim()) : labelBefore(text, start);
    const normalised = label.toLowerCase();

    let key = normalised ? byLabel.get(normalised) ?? '' : '';
    if (!key) {
      let base = slugify(label);
      if (!base) { anonymous += 1; base = `field_${anonymous}`; }
      key = base;
      let n = 2;
      while (taken.has(key)) { key = `${base}_${n}`; n += 1; }
      taken.add(key);
      if (normalised) byLabel.set(normalised, key);
    }

    runs.push({ start, end, label, key });
    match = RUN_RE.exec(text);
  }
  return runs;
}

/** How many plain "___" runs are sitting in this text, for the empty state. */
export function countBlankRuns(text: string): number {
  RUN_RE.lastIndex = 0;
  let n = 0;
  while (RUN_RE.exec(text) !== null) n += 1;
  return n;
}
