import { expect, test, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Lenso 共享运行时基础（N1a）。
 *
 * 浏览器内冒烟用 Bun 现场打包 runtime + 一个可控的 `@lenso/ui` stub：
 * 失败→显式重试、加载中打开→open 周期锁、host props 合并。
 * 真实页面部分复用账号菜单验证 fallback 可操作和延迟 chunk 不中途换壳。
 */

const ROOT = resolve(import.meta.dirname, '../..');
const HARNESS_ORIGIN = 'http://lenso.test';
const STUB = 'export const ready = true; export const marker = "lenso-foundations";';

interface Probe {
  status: 'idle' | 'loading' | 'ready' | 'error';
  ready: boolean;
  backend: 'lenso' | 'fallback';
  open: boolean;
  setOpen: (open: boolean) => void;
  retry: () => Promise<'ok' | 'error'>;
  host: { className: string | null; color: string | null; dataProbe: string | null };
}

interface ManifestChunk {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
}

let harness = '';
let tempDir = '';

function buildHarness(): string {
  const runtime = resolve(ROOT, 'src/web/app/lenso-runtime.ts');
  const host = resolve(ROOT, 'src/web/app/lenso-host.ts');
  tempDir = mkdtempSync(join(ROOT, 'node_modules/.lenso-foundations-'));
  const source = `
import { createElement, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getLensoStatus, retryLenso, useBackendLease, useLenso, useLensoStatus } from ${JSON.stringify(runtime)};
import { mergeHostProps } from ${JSON.stringify(host)};

function Probe() {
  const [open, setOpen] = useState(false);
  const lenso = useLenso();
  const status = useLensoStatus();
  const backend = useBackendLease(open);
  const inputRef = useRef(null);
  useEffect(() => { window.__probeInput = inputRef.current; }, []);
  const merged = mergeHostProps(
    { className: 'base', style: { color: 'red' }, 'data-probe': 'base' },
    { className: 'extra', style: { color: 'blue' }, 'data-probe': 'override' },
  );
  window.__lensoProbe = {
    status,
    ready: Boolean(lenso),
    backend,
    open,
    setOpen,
    retry: () => retryLenso().then(() => 'ok', () => 'error'),
    getStatus: getLensoStatus,
    host: {
      className: merged.className ?? null,
      color: merged.style?.color ?? null,
      dataProbe: merged['data-probe'] ?? null,
    },
  };
  return createElement('div', { id: 'probe', 'data-status': status, 'data-backend': backend },
    createElement('input', { id: 'probe-input', ref: inputRef }));
}

createRoot(document.getElementById('root')).render(createElement(Probe));
`;
  const entry = join(tempDir, 'harness.ts');
  writeFileSync(entry, source);
  const outdir = join(tempDir, 'out');
  execFileSync('bun', [
    'build', entry,
    '--target', 'browser',
    '--format', 'esm',
    '--external', '@lenso/ui',
    '--outdir', outdir,
  ], { cwd: ROOT, stdio: 'pipe' });
  return readFileSync(join(outdir, 'harness.js'), 'utf8');
}

async function openHarness(
  page: Page,
  lenso: (route: Route) => Promise<void> | void,
): Promise<void> {
  const html = `<!doctype html><html><head>
<script type="importmap">{"imports":{"@lenso/ui":"/lenso-stub.js"}}</script>
</head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`;
  await page.route(`${HARNESS_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (path === '/harness.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: harness });
    }
    if (path === '/lenso-stub.js') return lenso(route);
    return route.fulfill({ status: 404, body: 'missing' });
  });
  await page.goto(`${HARNESS_ORIGIN}/`);
}

function probe<T>(page: Page, read: (probe: Probe) => T): Promise<T> {
  return page.evaluate((reader) => {
    const value = (window as unknown as { __lensoProbe: Probe }).__lensoProbe;
    return new Function('probe', `return (${reader})(probe)`)(value) as T;
  }, read.toString());
}

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

interface ToolEnvelope {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
}

async function callTool<T>(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name,
        arguments: { request_id: `n1a_${crypto.randomUUID()}`, ...args },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'lenso-foundations', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: ToolEnvelope;
  };
  if (payload.error) throw new Error(payload.error.message ?? 'MCP 调用失败');
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    throw new Error(result.content?.find((item) => item.type === 'text')?.text ?? '工具失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

async function login(page: Page, token: string): Promise<void> {
  await page.addInitScript((credential) => {
    try {
      localStorage.setItem('agent-network-token', credential);
      localStorage.removeItem('agent-network-logged-out');
      localStorage.setItem('agent-network-room-filter', 'group');
    } catch {
      // 页面会显示错误态。
    }
  }, token);
}

test.describe.serial('Lenso shared runtime foundations', () => {
  let base = '';
  let token = '';
  let roomId = '';

  test.beforeAll(async () => {
    harness = buildHarness();
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    token = crypto.randomUUID();
    const peerToken = crypto.randomUUID();
    const me = await callTool<{ actor_id: string }>(base, token, 'network_register', {
      kind: 'human',
      name: `N1a 用户 ${suffix}`,
      device_id: `n1a-${suffix}-me`,
    });
    const peer = await callTool<{ actor_id: string }>(base, peerToken, 'network_register', {
      kind: 'human',
      name: `N1a 好友 ${suffix}`,
      device_id: `n1a-${suffix}-peer`,
    });
    const request = await callTool<{ request: { contact_request_id: string } }>(
      base,
      token,
      'network_contact_request',
      { actor_id: peer.actor_id },
    );
    await callTool(base, peerToken, 'network_contact_request_respond', {
      contact_request_id: request.request.contact_request_id,
      action: 'accept',
    });
    const room = await callTool<{ room: { room_id: string } }>(base, token, 'network_room_create', {
      kind: 'group',
      title: `N1a 群 ${suffix}`,
      members: [peer.actor_id, me.actor_id],
    });
    roomId = room.room.room_id;
  });

  test.afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('Lenso chunk 首次失败后显式重试恢复，并合并宿主 props', async ({ page }) => {
    let requests = 0;
    await openHarness(page, async (route) => {
      requests += 1;
      if (requests === 1) return route.fulfill({ status: 500, body: 'lenso unavailable' });
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: STUB,
      });
    });

    await expect.poll(() => probe(page, (item) => item.status)).toBe('error');
    expect(requests).toBe(1);
    expect(await probe(page, (item) => item.ready)).toBe(false);

    expect(await probe(page, (item) => item.retry())).toBe('ok');
    await expect.poll(() => probe(page, (item) => item.status)).toBe('ready');
    expect(requests).toBe(2);
    expect(await probe(page, (item) => item.ready)).toBe(true);

    // 重试后同一个订阅者拿到模块，不需要刷新页面。
    expect(await probe(page, (item) => ({
      className: item.host.className,
      color: item.host.color,
      dataProbe: item.host.dataProbe,
    }))).toEqual({ className: 'base extra', color: 'blue', dataProbe: 'override' });
  });

  test('打开周期锁定 fallback：模块晚到不换壳、不丢焦点，关闭后可升级', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    await openHarness(page, async (route) => {
      await gate;
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: STUB,
      });
    });

    await expect.poll(() => probe(page, (item) => item.status)).toBe('loading');
    await page.locator('#probe-input').focus();
    await page.locator('#probe-input').evaluate((node) => {
      (window as unknown as { __n1aInput?: Element }).__n1aInput = node;
    });

    await probe(page, (item) => item.setOpen(true));
    expect(await probe(page, (item) => item.backend)).toBe('fallback');

    release();
    await expect.poll(() => probe(page, (item) => item.status)).toBe('ready');
    // 模块已到，但本次 open 仍然锁在 fallback；输入节点与焦点都不能变化。
    expect(await probe(page, (item) => ({ backend: item.backend, ready: item.ready })))
      .toEqual({ backend: 'fallback', ready: true });
    expect(await page.evaluate(() =>
      (window as unknown as { __n1aInput?: Element }).__n1aInput ===
      document.getElementById('probe-input'))).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('probe-input');

    await probe(page, (item) => item.setOpen(false));
    await probe(page, (item) => item.setOpen(true));
    await expect.poll(() => probe(page, (item) => item.backend)).toBe('lenso');
  });

  test('真实账号菜单：延迟 Lenso chunk 时 fallback 保持到关闭，重开升级', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, token);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    await page.route('**/assets/index-*.js', async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await page.goto(`${base}/c/${roomId}`);
      const toggle = page.locator('#account-menu-toggle');
      const menu = page.locator('#account-menu');
      await expect(toggle).toBeVisible();

      await toggle.click();
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-fallback');
      await expect(page.locator('#account-rename')).toBeFocused();

      await toggle.evaluate((node) => {
        (node as unknown as { __n1aTrigger?: string }).__n1aTrigger = 'locked';
      });
      await menu.evaluate((node) => {
        (node as unknown as { __n1aMenu?: string }).__n1aMenu = 'locked';
      });

      release();
      // 其他已挂载按钮升级到 Lenso 说明 chunk 确实到达了。
      await expect(page.locator('[data-lenso-slot="button"]').first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-fallback');
      expect(await menu.evaluate(
        (node) => (node as unknown as { __n1aMenu?: string }).__n1aMenu,
      )).toBe('locked');
      expect(await toggle.evaluate(
        (node) => (node as unknown as { __n1aTrigger?: string }).__n1aTrigger,
      )).toBe('locked');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('account-rename');

      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(toggle).toBeFocused();

      await toggle.click();
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-popup');
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(toggle).toBeFocused();
    } finally {
      release();
    }
  });

  test('真实账号菜单：Lenso 不可用时 fallback 菜单仍可操作且无页面错误', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await login(page, token);
    await page.route('**/assets/index-*.js', (route) => route.abort('failed'));
    await page.goto(`${base}/c/${roomId}`);
    const toggle = page.locator('#account-menu-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    const menu = page.locator('#account-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-fallback');
    await expect(page.locator('#account-rename')).toBeFocused();

    await page.locator('#account-rename').click();
    await expect(page.locator('#me-rename-dialog')).toBeVisible();
    await expect(page.locator('#me-rename-input')).toBeFocused();
    await page.locator('#me-rename-cancel').click();
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();
    expect(pageErrors).toEqual([]);
  });

  test('入口静态闭包无 @lenso/ui，SSR 渲染不启动 runtime', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, 'dist/web/.vite/manifest.json'), 'utf8'),
    ) as Record<string, ManifestChunk>;
    const entry = manifest['src/web/app/main.tsx'];
    if (!entry) throw new Error('manifest 缺少应用入口');
    const staticFiles = new Set<string>();
    const visit = (key: string) => {
      const chunk = manifest[key];
      if (!chunk || staticFiles.has(chunk.file)) return;
      staticFiles.add(chunk.file);
      for (const dependency of chunk.imports ?? []) visit(dependency);
    };
    for (const dependency of entry.imports ?? []) visit(dependency);
    visit('src/web/app/main.tsx');

    const lensoChunk = Object.values(manifest).find(
      (chunk) => /(^|\/)assets\/index-[\w-]+\.js$/u.test(chunk.file),
    );
    expect(lensoChunk, 'Lenso 必须是动态 chunk').toBeTruthy();
    expect(staticFiles.has(lensoChunk!.file)).toBe(false);
    expect(entry.dynamicImports ?? []).toContain(
      Object.keys(manifest).find((key) => manifest[key] === lensoChunk),
    );

    const runtime = readFileSync(resolve(ROOT, 'src/web/app/lenso-runtime.ts'), 'utf8');
    expect(runtime).toContain("import('@lenso/ui')");
    expect(runtime).not.toMatch(/^import\s+(?!type)[^;]*from\s+'@lenso\/ui'/mu);
    const display = readFileSync(resolve(ROOT, 'src/web/app/lenso-display.ts'), 'utf8');
    expect(display).not.toContain("import('@lenso/ui')");

    const script = `
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeScope } from './src/web/app/lenso-controls.ts';
import { getLensoStatus } from './src/web/app/lenso-runtime.ts';
const html = renderToStaticMarkup(createElement(ThemeScope, { className: 'lenso-root' }, 'ssr'));
console.log(JSON.stringify({ status: getLensoStatus(), hasRoot: html.includes('lenso-root') }));
`;
    const output = execFileSync('bun', ['-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const result = JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as {
      status?: string;
      hasRoot?: boolean;
    };
    expect(result).toEqual({ status: 'idle', hasRoot: true });
  });
});
