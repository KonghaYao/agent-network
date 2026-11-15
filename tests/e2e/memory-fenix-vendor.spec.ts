import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';

/**
 * Fenix memory vendor phase guard:
 * the ported tree must stay out of the production entry and first paint until the
 * later UI-switch phase. The isolated lazy-chunk proof lives in
 * `scripts/verify-memory-fenix-vendor.ts`; the render fixture from that same build
 * is served here to prove the vendor bundle actually renders and masks credentials
 * in the default/compact detail branch.
 */

const VENDOR_DIST = resolve(process.cwd(), 'dist/fenix-vendor-check');
const RENDER_PAGE = '/static/tests/fixtures/fenix-render-host.html';
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

let vendorServer: Server | undefined;
let vendorBase = '';

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

test.beforeAll(async () => {
  // 隔离构建与体积/CSS 断言一次完成；生产 manifest 断言依赖 test:e2e 先跑 build:web。
  test.setTimeout(120_000);
  execFileSync('bun', ['scripts/verify-memory-fenix-vendor.ts'], { cwd: process.cwd() });

  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
      );
      if (!pathname.startsWith('/static/')) {
        response.statusCode = 404;
        response.end('not found');
        return;
      }
      const file = resolve(VENDOR_DIST, pathname.slice('/static/'.length));
      if (file !== VENDOR_DIST && !file.startsWith(`${VENDOR_DIST}${sep}`)) {
        response.statusCode = 403;
        response.end('forbidden');
        return;
      }
      const body = await readFile(file);
      response.statusCode = 200;
      response.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end('not found');
    }
  });
  vendorServer = server;
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address() as AddressInfo;
  vendorBase = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (!vendorServer) return;
  await new Promise<void>((resolveClose) => vendorServer?.close(() => resolveClose()));
});

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

test('isolated vendor build renders the detail panel and masks credentials', async ({ page }) => {
  await page.goto(`${vendorBase}${RENDER_PAGE}`, { waitUntil: 'load' });

  for (const testId of ['fenix-default-panel', 'fenix-compact-panel']) {
    const panel = page.getByTestId(testId);
    // 真实渲染：标题来自 vendored memoryTypeTitle，正文来自 vendored 详情面板。
    await expect(panel.getByText('世界事实')).toBeVisible();
    await expect(panel.getByText('完整文本')).toBeVisible();
    await expect(panel).toContainText('token=[已隐藏]');
    await expect(panel).toContainText('Bearer [已隐藏]');
    await expect(panel).toContainText('password=[已隐藏]');

    const text = await panel.innerText();
    expect(text).not.toContain('e2e-query-secret');
    expect(text).not.toContain('e2e-bearer-secret');
    expect(text).not.toContain('e2e-password');
  }
});
