import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Fenix memory vendor phase guard:
 * the ported tree must stay out of the production entry and first paint until the
 * later UI-switch phase. The isolated lazy-chunk proof lives in
 * `scripts/verify-memory-fenix-vendor.ts`.
 */

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

test('production SPA manifest does not reference the fenix vendor tree', async () => {
  const manifest = await readFile(resolve(process.cwd(), 'dist/web/.vite/manifest.json'), 'utf8');
  expect(manifest).not.toContain('features/memory/fenix');
  expect(manifest).not.toContain('fenix-memory-vendor-chunk');
});

test('home first paint does not request any fenix chunk', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/static/')) requested.push(url);
  });

  await page.goto(await baseUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#root');
  // The app keeps an SSE subscription open, so `networkidle` never settles.
  await page.waitForTimeout(1000);

  expect(requested.length).toBeGreaterThan(0);
  expect(requested.some((url) => /fenix/i.test(url))).toBe(false);
});
