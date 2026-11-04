/**
 * DocFlow — clean HTML pasted from Word or the web (spec FR-6.4).
 *
 * Word does not emit HTML so much as a transcript of its own internal state:
 * `class="MsoNormal"`, `<o:p>`, `mso-*` style properties, conditional
 * comments wrapping list markup, and `<span style="...">` around almost every
 * run. Pasted straight in, that arrives as prose carrying hard-coded fonts
 * and colours that then fight the document's own styling, and which the
 * author cannot see to remove.
 *
 * This keeps the STRUCTURE (headings, lists, tables, links, bold/italic) and
 * discards the presentation. It runs in the browser purely for the author's
 * benefit — the server's allow-list sanitizer is the security boundary and
 * is unaffected by anything here.
 */

/** Attributes that only ever carry Word/editor presentation. */
const DROP_ATTRS = [
  'style', 'class', 'lang', 'align', 'bgcolor', 'color', 'face', 'size',
  'width', 'height', 'border', 'cellpadding', 'cellspacing', 'valign',
];

/** Elements with no meaning once the styling is gone. */
const UNWRAP_TAGS = ['SPAN', 'FONT', 'DIV', 'SECTION', 'ARTICLE'];

/** Elements to delete outright, contents and all. */
const DROP_TAGS = [
  'STYLE', 'SCRIPT', 'META', 'LINK', 'TITLE', 'HEAD', 'XML',
  'O:P', 'W:SDT', 'V:SHAPETYPE', 'V:SHAPE', 'V:IMAGEDATA',
];

/** Keep only the handful of tags the editor's own schema understands. */
const KEEP_TAGS = new Set([
  'P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'HR',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'A',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
]);

function stripConditionalComments(html: string): string {
  // Word wraps list markup in <!--[if !supportLists]--> ... <!--[endif]-->,
  // which carries the bullet glyph as literal text ("·", "o", "§").
  return html
    .replace(/<!--\[if[\s\S]*?\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

export function cleanPastedHTML(html: string): string {
  if (!html) return html;

  let working = stripConditionalComments(html);
  // Word's own namespace declarations confuse the parser's tag names.
  working = working.replace(/<\/?[a-z]+:[^>]*>/gi, '');

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(working, 'text/html');
  } catch {
    return working;                    // never make a paste fail
  }

  const body = doc.body;
  if (!body) return working;

  for (const tag of DROP_TAGS) {
    body.querySelectorAll(tag.toLowerCase()).forEach((el) => el.remove());
  }

  // Walk a static list: the tree is mutated as we go.
  const all = Array.from(body.querySelectorAll('*'));
  for (const el of all) {
    if (!el.isConnected) continue;
    const tag = el.tagName.toUpperCase();

    for (const attr of DROP_ATTRS) el.removeAttribute(attr);
    // data-* and Word's own attributes carry nothing we want.
    for (const attr of Array.from(el.attributes)) {
      if (/^(data-|v:|o:|w:|xmlns)/i.test(attr.name)) el.removeAttribute(attr.name);
    }

    if (tag === 'A') {
      const href = el.getAttribute('href') || '';
      // The editor's link mark would happily carry a javascript: URL into the
      // document. The server strips it too, but not letting it in is better
      // than relying on that.
      if (!/^(https?:|mailto:|tel:)/i.test(href)) el.removeAttribute('href');
      continue;
    }

    if (UNWRAP_TAGS.includes(tag) || !KEEP_TAGS.has(tag)) {
      // Replace the element with its children rather than dropping the text.
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  }

  // Word emits a paragraph per line including blank ones; drop the empties so
  // a pasted page does not arrive double-spaced.
  body.querySelectorAll('p').forEach((p) => {
    const text = (p.textContent || '').replace(/ /g, ' ').trim();
    if (!text && !p.querySelector('img,br,table')) p.remove();
  });

  return body.innerHTML;
}

/**
 * Drop-in `editorProps` for TipTap. Merge with any existing props rather
 * than replacing them, so the editors keep their aria labels.
 */
export const pasteProps = {
  transformPastedHTML: cleanPastedHTML,
};
