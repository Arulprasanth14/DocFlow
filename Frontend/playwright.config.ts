import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests (workflow module section 13, task P3-15).
 *
 * Runs against the Vite dev server on its own port so it never collides
 * with a dev server you already have open. The API is mocked per test at
 * the browser, so no backend, database or account is needed.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5199',
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: 'npx vite --port 5199 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5199/e2e/harness/review.html',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
