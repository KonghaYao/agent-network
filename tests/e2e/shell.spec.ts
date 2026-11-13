import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

/**
 * 基础设施冒烟用例：只有显式运行 `bun run test:e2e` 才执行。
 * 默认测试清单不包含 Playwright。
 */
test('legacy home remains the default shell', async ({ request }) => {
  const base = await baseUrl();
  const response = await request.get(`${base}/`);
  expect(response.ok()).toBe(true);
  const html = await response.text();
  expect(html).toContain('id="room-search"');
  expect(html).not.toContain('data-spa-route');
});

/**
 * SPA 壳用例在 4B-1 接管路由后才启用；Sprint 0 默认跳过。
 * 运行方式：WEB_SPA_ROUTES=home E2E_SPA=1 bun run test:e2e。
 */
test.describe('SPA shell placeholder', () => {
  test.skip(!process.env.E2E_SPA, 'SPA routes are not enabled in Sprint 0');

  test('home renders the React shell when enabled', async ({ page }) => {
    const base = await baseUrl();
    await page.goto(`${base}/`);
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expect(page.locator('#root')).toContainText('WeBots');
  });
});
