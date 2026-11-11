/**
 * Performance of the review surface — section 11 Performance, E24. Task P4-7.
 *
 * The two shapes the spec calls out for this screen: a long document, and a
 * document with a great many comments. Both are about the same risk — the
 * review screen is the one page an approver keeps open for a long time, and
 * it degrades by accumulating DOM rather than by any single slow call.
 *
 * Measured, not asserted into a stopwatch: wall-clock numbers on a laptop
 * running Docker are too noisy to gate a build on. What is asserted is the
 * thing that actually causes the degradation and is deterministic — how many
 * canvases and comment nodes exist at once.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

/** A multi-page PDF with real text on each page. */
function makePdf(pages: number): Buffer {
  const objects: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let p = 1; p <= pages; p += 1) {
    const stream = `BT /F1 18 Tf 72 700 Td (Page ${p} of ${pages} content) Tj ET`;
    objects.push(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents '
      + `${5 + (p - 1) * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

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

function makeComments(count: number, pages: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `a-${i}`,
    document_version_id: 'v-test',
    page_number: (i % pages) + 1,
    anchor_type: 'text',
    rects: [{ x: 0.1, y: 0.1 + (i % 8) * 0.05, w: 0.3, h: 0.025 }],
    selected_text: `Quoted passage number ${i}`,
    comment_text: `Comment ${i}: this paragraph needs attention and review.`,
    category: null, color: null, status: 'open', is_open: true,
    author_id: 'u-other', author_name: 'Priya',
    published_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    carried_from_id: null, relocated: null, replies: [],
  }));
}

async function mockApi(page: Page, pdfPages: number, comments: number) {
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const pdf = makePdf(pdfPages);

  await page.route('**/test-files/doc.pdf', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }));
  await page.route('**/api/v1/approvals/document-versions/*/file', (route) =>
    json(route, {
      document_version_id: 'v-test', status: 'ready', url: '/test-files/doc.pdf',
      mime_type: 'application/pdf', filename: 'doc.pdf', page_count: pdfPages,
      expires_in: 300, version_num: 1, message: null,
    }));
  await page.route('**/api/v1/approvals/document-versions/*/annotations', (route) =>
    json(route, {
      document_version_id: 'v-test',
      annotations: makeComments(comments, pdfPages),
      draft_count: 0, open_count: comments,
    }));
}

test('a 300-page document does not hold 300 rendered pages', async ({ page }) => {
  // AP-SUM-08 / E24: 300 is the spec's ceiling, so it is the case to prove.
  await mockApi(page, 300, 0);
  const started = Date.now();
  await page.goto('/e2e/harness/review.html');
  await expect(page.locator('.textLayer').first())
    .toContainText('Page 1 of 300', { timeout: 60_000 });
  const firstPaint = Date.now() - started;

  // Every page has a placeholder, which is what keeps the scrollbar honest.
  await expect(page.locator('[data-page-number]')).toHaveCount(300);

  // But only the pages near the viewport hold a bitmap. This is the
  // assertion that matters: without it, 300 canvases at ~1500x1900 would be
  // well over a gigabyte of pixels and the tab would die.
  const withBitmap = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-page-number] canvas'))
      .filter((c) => (c as HTMLCanvasElement).width > 0).length,
  );
  expect(withBitmap).toBeGreaterThan(0);
  expect(withBitmap).toBeLessThan(12);

  console.log(`300-page first paint: ${firstPaint}ms, live canvases: ${withBitmap}`);
});

test('scrolling a long document releases the pages left behind', async ({ page }) => {
  await mockApi(page, 300, 0);
  await page.goto('/e2e/harness/review.html');
  await expect(page.locator('.textLayer').first())
    .toContainText('Page 1 of 300', { timeout: 60_000 });

  const scroller = page.locator('[aria-label^="Document pages"]');
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight / 2; });
  await page.waitForTimeout(2500);

  const live = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-page-number] canvas'))
      .filter((c) => (c as HTMLCanvasElement).width > 0).length,
  );
  // Still bounded after scrolling: pages are released, not accumulated.
  expect(live).toBeLessThan(12);
  console.log(`after mid-document scroll, live canvases: ${live}`);
});

test('500 comments stay responsive', async ({ page }) => {
  // AP-ANN-10 / E24: "500+ comments must not freeze".
  await mockApi(page, 10, 500);
  const started = Date.now();
  await page.goto('/e2e/harness/review.html');
  await expect(page.locator('.textLayer').first())
    .toContainText('Page 1 of 10', { timeout: 60_000 });
  await expect(page.getByTestId('panel')).toContainText('Comment 0');
  const loaded = Date.now() - started;

  // The panel relies on `content-visibility: auto`, so the nodes exist but
  // off-screen ones skip layout and paint. Confirm the rendering strategy is
  // actually in place rather than trusting the stylesheet.
  const strategy = await page.evaluate(() => {
    const li = document.querySelector('[data-testid="panel"] li') as HTMLElement | null;
    return li ? getComputedStyle(li).contentVisibility : 'none';
  });
  expect(strategy).toBe('auto');

  // Filtering 500 comments is a pure client operation and must stay snappy.
  const filterStart = Date.now();
  await page.getByRole('button', { name: /^Open/ }).click();
  await expect(page.getByTestId('panel')).toContainText('Comment 0');
  const filtered = Date.now() - filterStart;

  console.log(`500 comments: load ${loaded}ms, filter ${filtered}ms`);
  // Generous: this is a smoke bound to catch an O(n^2) regression, not a
  // benchmark. A real freeze takes tens of seconds.
  expect(filtered).toBeLessThan(5000);
});
