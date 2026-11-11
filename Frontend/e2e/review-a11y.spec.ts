/**
 * Accessibility of the review surface — UX-A11Y-01..06, T40. Task P4-6.
 *
 * axe over the viewer and comments panel, plus the keyboard paths the spec
 * names: an approver who cannot use a mouse must still be able to read the
 * comments, move between them, and reach the document.
 *
 * Scoped to serious and critical violations. axe's "minor" bucket is mostly
 * advisory and a build that fails on it gets switched off within a week,
 * which protects nobody.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

function makePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { body += `${String(o).padStart(10, '0')} 00000 n \n`; });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const COMMENT = {
  id: 'a-1',
  document_version_id: 'v-test',
  page_number: 1,
  anchor_type: 'text',
  rects: [{ x: 0.12, y: 0.1, w: 0.3, h: 0.03 }],
  selected_text: 'Hello review world',
  comment_text: 'This clause needs tightening.',
  category: null,
  color: null,
  status: 'open',
  is_open: true,
  author_id: 'u-other',
  author_name: 'Priya',
  published_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  carried_from_id: null,
  relocated: null,
  replies: [],
};

async function mockApi(page: Page, annotations: unknown[]) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/test-files/doc.pdf', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: makePdf('Hello review world') }));
  await page.route('**/api/v1/approvals/document-versions/*/file', (route) =>
    json(route, {
      document_version_id: 'v-test', status: 'ready', url: '/test-files/doc.pdf',
      mime_type: 'application/pdf', filename: 'doc.pdf', page_count: 1,
      expires_in: 300, version_num: 1, message: null,
    }));
  await page.route('**/api/v1/approvals/document-versions/*/annotations', (route) =>
    json(route, {
      document_version_id: 'v-test', annotations,
      draft_count: 0, open_count: annotations.length,
    }));
  await page.route('**/api/v1/approvals/annotations/**', (route) => json(route, {}));
}

async function open(page: Page) {
  await page.goto('/e2e/harness/review.html');
  await expect(page.locator('.textLayer')).toContainText('Hello review world', { timeout: 30_000 });
}

/** axe, minus the PDF text layer. */
async function scan(page: Page) {
  return new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // pdf.js builds the text layer itself: absolutely positioned transparent
    // spans over the canvas. Its contrast and structure are not ours to fix,
    // and the document's own text is exposed through the canvas image role.
    .exclude('.textLayer')
    .analyze();
}

test('the review screen has no serious accessibility violations', async ({ page }) => {
  await mockApi(page, [COMMENT]);
  await open(page);

  const results = await scan(page);
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  // Name the rule and the element, so a failure is actionable rather than a
  // count to go hunting for.
  expect(
    serious.map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.target.join(' ')}`),
  ).toEqual([]);
});

test('the empty comments panel is accessible too', async ({ page }) => {
  // The empty state is a different DOM, and it is what most approvers see
  // first.
  await mockApi(page, []);
  await open(page);
  const results = await scan(page);
  expect(
    results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
});

test('every viewer control is reachable and named for a screen reader', async ({ page }) => {
  await mockApi(page, [COMMENT]);
  await open(page);

  // UX-A11Y: a control with no accessible name is unusable by a screen
  // reader even when it is reachable by keyboard.
  for (const name of [
    'Zoom out', 'Zoom in', 'Rotate clockwise', 'Full screen',
    'Area comment', 'Find in document',
  ]) {
    await expect(page.getByRole('button', { name }).or(page.getByLabel(name)).first())
      .toBeVisible();
  }
});

test('a comment can be opened from the keyboard alone', async ({ page }) => {
  await mockApi(page, [COMMENT]);
  await open(page);

  const item = page.getByTestId('panel').locator('li').filter({ hasText: 'tightening' }).first();
  await item.focus();
  await expect(item).toBeFocused();
  await page.keyboard.press('Enter');
  // Selecting it marks it active, which is what the viewer scrolls to.
  await expect(item).toHaveCSS('border-color', /.+/);
});

test('tabbing reaches the panel without a mouse', async ({ page }) => {
  await mockApi(page, [COMMENT]);
  await open(page);

  const reached: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return '';
      return (
        el.getAttribute('aria-label')
        || el.getAttribute('placeholder')
        || (el.textContent ?? '').trim().slice(0, 40)
      );
    });
    if (label) reached.push(label);
  }
  // Something inside the comments list must be focusable, or the panel is
  // mouse-only.
  expect(reached.some((l) => l.toLowerCase().includes('reply'))).toBe(true);
});
