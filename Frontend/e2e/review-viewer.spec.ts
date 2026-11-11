/**
 * Review viewer and comments panel in a real browser.
 * Workflow module T8, T28, T37; AP-VWR-01, AP-ANN-01/02/20. Task P3-15.
 *
 * The API is mocked; the PDF, pdf.js, the text layer, the selection maths
 * and the autosave are all real.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

/** A one-page PDF with a real text layer, built with correct xref offsets. */
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

interface Mock {
  annotations: Record<string, unknown>[];
  posts: Record<string, unknown>[];
  patches: { id: string; body: Record<string, unknown> }[];
  failPatches: number;
}

async function mockApi(page: Page, fileStatus: 'ready' | 'failed' = 'ready'): Promise<Mock> {
  const mock: Mock = { annotations: [], posts: [], patches: [], failPatches: 0 };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/test-files/doc.pdf', (route) =>
    route.fulfill({ status: 200, contentType: 'application/pdf', body: makePdf('Hello review world') }));

  await page.route('**/api/v1/approvals/document-versions/*/file', (route) =>
    json(route, {
      document_version_id: 'v-test', status: fileStatus,
      url: fileStatus === 'ready' ? '/test-files/doc.pdf' : null,
      mime_type: 'application/pdf', filename: 'doc.pdf', page_count: 1,
      expires_in: 300, version_num: 1,
      message: fileStatus === 'failed' ? 'That PDF is password-protected.' : null,
    }));

  await page.route('**/api/v1/approvals/document-versions/*/annotations', (route) =>
    json(route, {
      document_version_id: 'v-test', annotations: mock.annotations,
      draft_count: mock.annotations.length, open_count: 0,
    }));

  await page.route('**/api/v1/approvals/annotations', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    mock.posts.push(body);
    const created = {
      id: `a-${mock.posts.length}`, document_version_id: 'v-test',
      page_number: body.page_number, anchor_type: body.anchor_type,
      rects: body.rects, selected_text: body.selected_text ?? null,
      comment_text: null, category: null, color: null, status: 'draft',
      is_open: false, author_id: 'u-approver', author_name: 'Approver',
      published_at: null, created_at: new Date().toISOString(),
      carried_from_id: null, relocated: null, replies: [],
    };
    mock.annotations.push(created);
    return json(route, created, 201);
  });

  await page.route('**/api/v1/approvals/annotations/*', (route) => {
    const id = route.request().url().split('/').pop()!;
    if (route.request().method() !== 'PATCH') return json(route, { status: 'discarded' });
    if (mock.failPatches > 0) {
      mock.failPatches -= 1;
      return json(route, { detail: 'Service unavailable' }, 503);
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    mock.patches.push({ id, body });
    const row = mock.annotations.find((a) => a.id === id);
    if (row) Object.assign(row, body);
    return json(route, row ?? {});
  });

  return mock;
}

async function openHarness(page: Page) {
  await page.goto('/e2e/harness/review.html');
  await expect(page.locator('.textLayer')).toContainText('Hello review world', { timeout: 30_000 });
}

/** Drag across the rendered text to select it, the way a reader would. */
async function selectText(page: Page) {
  const box = (await page.locator('.textLayer span', { hasText: 'Hello' }).first().boundingBox())!;
  // Drag along the direction the text runs: on a rotated page the line is
  // taller than it is wide.
  const vertical = box.height > box.width;
  const from = vertical
    ? { x: box.x + box.width / 2, y: box.y + 2 }
    : { x: box.x + 2, y: box.y + box.height / 2 };
  const to = vertical
    ? { x: box.x + box.width / 2, y: box.y + box.height - 2 }
    : { x: box.x + box.width - 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test('the PDF renders with a selectable text layer', async ({ page }) => {
  await mockApi(page);
  await openHarness(page);
  const size = await page.locator('[data-page-number="1"] canvas').evaluate(
    (c: HTMLCanvasElement) => ({ w: c.width, h: c.height }),
  );
  expect(size.w).toBeGreaterThan(100);
  expect(size.h).toBeGreaterThan(100);
  await expect(page.getByText('1 page')).toBeVisible();
});

test('selecting text creates a draft anchored in page fractions', async ({ page }) => {
  const mock = await mockApi(page);
  await openHarness(page);
  await selectText(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  await expect.poll(() => mock.posts.length).toBe(1);
  const post = mock.posts[0] as {
    anchor_type: string; page_number: number; selected_text: string;
    rects: { x: number; y: number; w: number; h: number }[];
  };
  expect(post.anchor_type).toBe('text');
  expect(post.page_number).toBe(1);
  expect(post.selected_text).toContain('Hello');
  expect(post.rects.length).toBeGreaterThan(0);
  // The whole point: fractions of the page, never pixels.
  for (const r of post.rects) {
    for (const v of [r.x, r.y, r.w, r.h]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  }
  // The text sits about 72pt in and 92pt down on a 612x792 page.
  expect(post.rects[0].x).toBeGreaterThan(0.08);
  expect(post.rects[0].x).toBeLessThan(0.2);
  expect(post.rects[0].y).toBeGreaterThan(0.05);
  expect(post.rects[0].y).toBeLessThan(0.2);

  await expect(page.getByTestId('panel')).toContainText('Draft — only you can see this');
});

test('a draft autosaves what is typed', async ({ page }) => {
  const mock = await mockApi(page);
  await openHarness(page);
  await selectText(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  const editor = page.getByRole('textbox', { name: 'Comment on page 1' });
  await editor.fill('Please tighten this sentence.');
  // Poll the request, not the indicator: it reads "Saved" before the
  // one-second debounce has fired.
  await expect.poll(() => mock.patches.at(-1)?.body.comment_text, { timeout: 10_000 })
    .toBe('Please tighten this sentence.');
  await expect(page.getByTestId('panel')).toContainText('Saved');
});

test('a failed save keeps the text and retries', async ({ page }) => {
  const mock = await mockApi(page);
  await openHarness(page);
  await selectText(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  mock.failPatches = 1;
  const editor = page.getByRole('textbox', { name: 'Comment on page 1' });
  await editor.fill('Written during an outage.');
  await expect(page.getByTestId('panel')).toContainText('retrying', { timeout: 10_000 });
  await expect(editor).toHaveValue('Written during an outage.');
  // The retry (2s back-off) succeeds and the text arrives.
  await expect(page.getByTestId('panel')).toContainText('Saved', { timeout: 15_000 });
  expect(mock.patches.at(-1)?.body.comment_text).toBe('Written during an outage.');
});

test('the area tool anchors a drawn rectangle', async ({ page }) => {
  const mock = await mockApi(page);
  await openHarness(page);
  await page.getByRole('button', { name: 'Area comment' }).click();

  const box = (await page.locator('[data-page-number="1"]').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();

  await expect.poll(() => mock.posts.length).toBe(1);
  const post = mock.posts[0] as {
    anchor_type: string; rects: { x: number; y: number; w: number; h: number }[];
  };
  expect(post.anchor_type).toBe('area');
  expect(post.rects[0].x).toBeCloseTo(0.25, 1);
  expect(post.rects[0].y).toBeCloseTo(0.4, 1);
  expect(post.rects[0].w).toBeCloseTo(0.25, 1);
  expect(post.rects[0].h).toBeCloseTo(0.1, 1);
});

test('rotating the page does not change where an anchor is stored', async ({ page }) => {
  const mock = await mockApi(page);
  await openHarness(page);
  await page.getByRole('button', { name: 'Rotate clockwise' }).click();
  // Wait for the ROTATED layer; the unrotated one still has the text.
  await expect(page.locator('.textLayer[data-main-rotation="90"]'))
    .toContainText('Hello review world');
  await selectText(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();

  await expect.poll(() => mock.posts.length).toBe(1);
  const r = (mock.posts[0] as { rects: { x: number; y: number }[] }).rects[0];
  // Same place on the UNROTATED page as in the unrotated test.
  expect(r.x).toBeGreaterThan(0.08);
  expect(r.x).toBeLessThan(0.2);
  expect(r.y).toBeGreaterThan(0.05);
  expect(r.y).toBeLessThan(0.2);
});

test('a review copy that could not be prepared says why', async ({ page }) => {
  await mockApi(page, 'failed');
  await page.goto('/e2e/harness/review.html');
  await expect(page.getByTestId('file-state')).toContainText('password-protected');
});
