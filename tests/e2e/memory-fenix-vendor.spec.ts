import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, resolve, sep } from 'node:path';

/**
 * Fenix memory vendor guard:
 * the ported tree is wired into the production panel only through the
 * dynamic `AgentMemoryDialog` -> `MemoriesPage` -> `DataView`/`EntitiesView`
 * chunk chain. It must never be inlined into the SPA entry or requested on
 * first paint. The isolated lazy-chunk proof lives in
 * `scripts/verify-memory-fenix-vendor.ts` and this spec mirrors its manifest
 * semantics against the real production build; the render fixture from that
 * same build proves the vendor bundle actually renders and masks credentials.
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

test('production SPA reaches the fenix tree only through dynamic chunks', async () => {
  const manifest = JSON.parse(
    await readFile(resolve(process.cwd(), 'dist/web/.vite/manifest.json'), 'utf8'),
  ) as Record<string, { file: string; imports?: string[]; dynamicImports?: string[] }>;

  const keys = Object.keys(manifest);
  const entryKey = keys.find((key) => key.endsWith('src/web/app/main.tsx'));
  const dialogKey = keys.find((key) => key.includes('AgentMemoryDialog') && key.endsWith('.js'));
  const memoriesPageKey = keys.find((key) => key.includes('MemoriesPage') && key.endsWith('.js'));
  const dataViewKey = keys.find(
    (key) => key.includes('features/memory/fenix/components/DataView') && key.endsWith('.tsx'),
  );
  const entitiesViewKey = keys.find(
    (key) => key.includes('features/memory/fenix/components/EntitiesView') && key.endsWith('.tsx'),
  );

  expect(entryKey, 'production entry resolves in the manifest').toBeTruthy();
  expect(dialogKey, 'AgentMemoryDialog chunk resolves in the manifest').toBeTruthy();
  expect(memoriesPageKey, 'MemoriesPage chunk resolves in the manifest').toBeTruthy();
  expect(dataViewKey, 'Fenix DataView chunk resolves in the manifest').toBeTruthy();
  expect(entitiesViewKey, 'Fenix EntitiesView chunk resolves in the manifest').toBeTruthy();

  const entry = manifest[entryKey as string]!;
  const dialog = manifest[dialogKey as string]!;
  const memoriesPage = manifest[memoriesPageKey as string]!;
  const dataView = manifest[dataViewKey as string]!;

  // 入口只允许动态 import 弹窗；弹窗只允许动态 import MemoriesPage，
  // MemoriesPage 再动态 import DataView / EntitiesView。
  expect(entry.dynamicImports ?? []).toContain(dialogKey as string);
  expect(entry.imports ?? []).not.toContain(dialogKey as string);
  expect(dialog.dynamicImports ?? []).toContain(memoriesPageKey as string);
  expect(dialog.imports ?? []).not.toContain(memoriesPageKey as string);
  expect(
    (dialog.dynamicImports ?? []).some((key) => key.includes('DataView') || key.includes('EntitiesView')),
  ).toBe(false);
  expect(memoriesPage.dynamicImports ?? []).toContain(dataViewKey as string);
  expect(memoriesPage.dynamicImports ?? []).toContain(entitiesViewKey as string);
  expect(memoriesPage.imports ?? []).not.toContain(dataViewKey as string);
  expect(memoriesPage.imports ?? []).not.toContain(entitiesViewKey as string);

  // 从入口沿静态 import 图可达的 chunk 不得触及 fenix 目录：动态 chunk 一旦被
  // 静态并入首屏，这里就会失败，而不是像旧的「只要存在就通过」那样放过。
  const staticClosure = new Set<string>();
  const visit = (key: string | undefined): void => {
    if (!key || staticClosure.has(key) || !manifest[key]) return;
    staticClosure.add(key);
    for (const imported of manifest[key]!.imports ?? []) visit(imported);
  };
  visit(entryKey);
  expect([...staticClosure].filter((key) => key.includes('features/memory/fenix'))).toEqual([]);
  expect([...staticClosure].filter((key) => key.includes('DataView'))).toEqual([]);

  // 入口产物本身不得含 fenix 标记，证明 vendor 代码只存在于独立 chunk。
  const entryCode = await readFile(resolve(process.cwd(), 'dist/web', entry.file), 'utf8');
  expect(entry.file).not.toContain('fenix');
  for (const marker of ['fenix-memory-root', 'fenix-constellation', 'fenix-memory-vendor-chunk']) {
    expect(entryCode, `entry must not inline ${marker}`).not.toContain(marker);
  }
  expect(dataView.file).toContain('DataView');
});

test('home first paint does not request any fenix chunk', async ({ page }) => {
  // 首屏禁用的具体文件来自生产 manifest，而不是只靠 URL 里的 "fenix" 字样：
  // 阶段 4 的 chunk 文件名是 DataView-*.js，旧拼写检查会漏掉它。
  const manifest = JSON.parse(
    await readFile(resolve(process.cwd(), 'dist/web/.vite/manifest.json'), 'utf8'),
  ) as Record<string, { file: string }>;
  const fenixFiles = Object.keys(manifest)
    .filter((key) => key.includes('features/memory/fenix'))
    .map((key) => manifest[key]!.file)
    .filter(Boolean);
  expect(fenixFiles.length).toBeGreaterThan(0);

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
  for (const file of fenixFiles) {
    expect(requested, `first paint must not request ${file}`).not.toContainEqual(
      expect.stringContaining(file),
    );
  }
});

test('isolated vendor build renders the detail panel and masks credentials', async ({ page }) => {
  const consoleLines: string[] = [];
  page.on('console', (message) => consoleLines.push(message.text()));

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

  // The failing adapter rejects with a token-bearing FenixApiError; the panel's
  // onError path must log the masked message, never the raw one.
  const detailErrorLines = consoleLines.filter((line) =>
    line.includes('Failed to fetch memory details'),
  );
  expect(detailErrorLines.length).toBeGreaterThan(0);
  for (const line of detailErrorLines) {
    expect(line).toContain('token=[已隐藏]');
    expect(line).not.toContain('e2e-console-secret');
  }
  expect(consoleLines.join('\n')).not.toContain('e2e-console-secret');
});
