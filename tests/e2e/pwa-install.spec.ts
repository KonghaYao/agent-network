import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * PWA 阶段 2a：manifest/sw、离线页、移动安装引导与旁路注册。
 *
 * 真机项（iPhone Safari/Chrome 的实际分享菜单、Android 系统安装框、
 * 相机扫码）不在本文件覆盖范围。
 */

interface ToolEnvelope {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
}

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function callTool<T>(
  request: APIRequestContext,
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await request.post(`${base}/mcp`, {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      authorization: `Bearer ${token}`,
    },
    data: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-pwa-e2e',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: ToolEnvelope;
  };
  if (payload.error) throw new Error(payload.error.message ?? 'MCP 调用失败');
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

async function createAgentShare(
  request: APIRequestContext,
  base: string,
): Promise<{ shareUrl: string; token: string }> {
  const token = crypto.randomUUID();
  await callTool(request, base, token, 'network_register', {
    request_id: requestId('pwa_owner'),
    kind: 'human',
    name: `PWA Owner ${crypto.randomUUID().slice(0, 6)}`,
  });
  const agent = await callTool<{ share_url: string; token: string }>(
    request,
    base,
    token,
    'network_agent_create',
    {
      request_id: requestId('pwa_agent'),
      name: `PWA Agent ${crypto.randomUUID().slice(0, 6)}`,
    },
  );
  return { shareUrl: agent.share_url, token: agent.token };
}

async function isControlled(page: Page): Promise<boolean> {
  return page.evaluate(() => navigator.serviceWorker?.controller !== null);
}

async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  }, null, { timeout: 20_000 });
}

/** 记录 MCP 的 network_register 调用；引导流程必须为 0。 */
function countRegisters(context: BrowserContext): () => number {
  let count = 0;
  void context.route('**/mcp', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('network_register')) count += 1;
    await route.continue();
  });
  return () => count;
}

async function newMobileContext(
  browser: import('@playwright/test').Browser,
  options: { ios?: boolean } = {},
): Promise<BrowserContext> {
  const iphone = options.ios ?? true;
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: iphone
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  });
}

test('manifest、head 与图标头符合 PWA 契约', async ({ request }) => {
  const base = await baseUrl();
  const response = await request.get(`${base}/manifest.webmanifest`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/manifest+json');
  expect(response.headers()['cache-control']).toBe('no-cache');
  const etag = response.headers().etag;
  expect(etag).toBeTruthy();

  const notModified = await request.get(`${base}/manifest.webmanifest`, {
    headers: { 'if-none-match': etag ?? '' },
  });
  expect(notModified.status()).toBe(304);

  const manifest = (await response.json()) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    name: string;
    short_name: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  expect(manifest.id).toBe('/');
  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');
  expect(manifest.display).toBe('standalone');
  expect(manifest.name).toBe('WeBots');
  expect(manifest.short_name).toBe('WeBots');
  expect(manifest.theme_color).toBe('#007aff');
  expect(manifest.background_color).toBe('#ffffff');
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'any' }),
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
      expect.objectContaining({ sizes: '180x180', purpose: 'any' }),
    ]),
  );

  for (const icon of manifest.icons) {
    const iconResponse = await request.get(`${base}${icon.src}`);
    expect(iconResponse.status(), icon.src).toBe(200);
    expect(iconResponse.headers()['cache-control']).toContain('immutable');
    expect(iconResponse.headers()['content-type']).toContain(icon.src.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
  }

  const html = await (await request.get(`${base}/`)).text();
  expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  expect(html).toContain('name="theme-color" content="#007aff"');
  expect(html).toContain('rel="apple-touch-icon"');
  expect(html).toContain('viewport-fit=cover');

  const sw = await request.get(`${base}/sw.js`);
  expect(sw.status()).toBe(200);
  expect(sw.headers()['content-type']).toContain('text/javascript');
  expect(sw.headers()['cache-control']).toBe('no-cache');
  expect(sw.headers()['service-worker-allowed']).toBe('/');
  expect(await sw.text()).not.toContain('skipWaiting');
});

test('Service Worker 注册、离线页与零业务缓存', async ({ page, context }) => {
  const base = await baseUrl();
  await page.goto(`${base}/`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await waitForController(page);

  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, script: ready.active?.scriptURL ?? '' };
  });
  expect(registration.scope).toBe(`${base}/`);
  expect(registration.script).toBe(`${base}/sw.js`);
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);

  // 非 PWA 路径不被 SW 接管：离线时真实网络失败，而不是返回离线页。
  await context.setOffline(true);
  expect(
    await page.evaluate(async () => {
      try {
        const response = await fetch('/mcp', { method: 'POST' });
        return `status:${response.status}`;
      } catch {
        return 'network-error';
      }
    }),
  ).toBe('network-error');
  for (const path of ['/pair', '/f/f_pwa_probe', '/c/rm_pwa_probe?t=ticket']) {
    let failed = false;
    try {
      await page.goto(`${base}${path}`);
    } catch {
      failed = true;
    }
    expect(failed, path).toBe(true);
  }

  await context.setOffline(false);
  await page.goto(`${base}/`);
  await waitForController(page);
  expect(await isControlled(page)).toBe(true);

  await context.setOffline(true);
  const homeOffline = await page.goto(`${base}/`);
  expect(homeOffline?.status()).toBe(503);
  await expect(page.getByRole('heading', { name: 'WeBots 当前离线' })).toBeVisible();
  await expect(page.locator('#offline-retry')).toHaveAttribute('href', '/');
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);

  await context.setOffline(false);
  await page.goto(`${base}/`);
  await waitForController(page);
  await context.setOffline(true);
  const roomPath = '/c/rm_pwa_offline_probe';
  const roomOffline = await page.goto(`${base}${roomPath}`);
  expect(roomOffline?.status()).toBe(503);
  await expect(page.locator('#offline-retry')).toHaveAttribute('href', roomPath);

  await context.setOffline(false);
  await page.locator('#offline-retry').click();
  await expect(page).toHaveURL(`${base}${roomPath}`);
});

test('移动端无账号首访先显示安装引导且不注册访客', async ({ browser }) => {
  const base = await baseUrl();
  const context = await newMobileContext(browser);
  const registerCount = countRegisters(context);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`);
    await expect(page.locator('#install-guide')).toBeVisible();
    await expect(page.getByRole('heading', { name: '在手机上使用 WeBots' })).toBeVisible();
    await expect(page.locator('#install-guide-later')).toBeVisible();
    await expect(page.locator('#install-guide-pair')).toHaveAttribute('href', '/pair');
    await page.waitForTimeout(500);
    expect(registerCount()).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('agent-network-token'))).toBeNull();

    await page.locator('#install-guide-later').click();
    await expect(page.locator('#install-guide')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('webots-install-dismissed:v1'))).toBe('1');
    await expect(page.locator('#account-pair')).toBeVisible();
    await expect(page.locator('#account-install-guide')).toBeVisible();

    await page.reload();
    await expect(page.locator('#install-guide')).toHaveCount(0);
    await page.locator('#account-install-guide').click();
    await expect(page.locator('#install-guide')).toBeVisible();
    expect(registerCount()).toBe(0);
  } finally {
    await context.close();
  }
});

test('移动端会话页无账号同样先引导', async ({ browser }) => {
  const base = await baseUrl();
  const context = await newMobileContext(browser, { ios: false });
  const registerCount = countRegisters(context);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/c/rm_pwa_mobile_probe`);
    await expect(page.locator('#install-guide')).toBeVisible();
    await expect(page.getByRole('heading', { name: '在手机上使用 WeBots' })).toBeVisible();
    await page.waitForTimeout(500);
    expect(registerCount()).toBe(0);
    await page.locator('#install-guide-later').click();
    await expect(page.locator('#chat-error-pair')).toBeVisible();
    expect(registerCount()).toBe(0);
  } finally {
    await context.close();
  }
});

test('Android beforeinstallprompt 在用户点击主按钮后唤起', async ({ browser }) => {
  const base = await baseUrl();
  const context = await newMobileContext(browser, { ios: false });
  await context.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
      };
      event.prompt = async () => {
        (window as unknown as { __installPrompted?: boolean }).__installPrompted = true;
      };
      Object.defineProperty(event, 'userChoice', {
        value: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
      });
      window.dispatchEvent(event);
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`);
    await expect(page.locator('#install-guide-primary')).toHaveText('安装 WeBots');
    await page.locator('#install-guide-primary').click();
    await expect(page.locator('#install-guide-status')).toContainText('已提交安装');
    expect(
      await page.evaluate(
        () => (window as unknown as { __installPrompted?: boolean }).__installPrompted,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test('独立窗口无账号时主按钮直接进入配对页', async ({ browser }) => {
  const base = await baseUrl();
  const context = await newMobileContext(browser, { ios: false });
  await context.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = ((query: string) => {
      if (query.includes('display-mode: standalone')) {
        return {
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        } as MediaQueryList;
      }
      return original(query);
    }) as typeof window.matchMedia;
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`);
    await expect(page.locator('#install-guide-primary')).toHaveText('扫描电脑二维码');
    await expect(page.locator('#install-guide-code')).toBeVisible();
    await page.locator('#install-guide-primary').click();
    await expect(page).toHaveURL(`${base}/pair`);
  } finally {
    await context.close();
  }
});

test('iOS 引导展示分享菜单添加主屏幕步骤', async ({ browser }) => {
  const base = await baseUrl();
  const context = await newMobileContext(browser, { ios: true });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`);
    await expect(page.locator('#install-guide')).toBeVisible();
    await expect(page.locator('#install-guide-primary')).toHaveText('查看安装步骤');
    await page.locator('#install-guide-primary').click();
    await expect(page.locator('#install-guide-ios-steps')).toBeVisible();
    await expect(page.locator('#install-guide-ios-steps')).toContainText('添加到主屏幕');
  } finally {
    await context.close();
  }
});

test('邀请页在注册前先引导，不创建访客', async ({ browser }) => {
  const base = await baseUrl();
  const context = await newMobileContext(browser);
  const registerCount = countRegisters(context);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/j/${'A'.repeat(20)}`);
    await expect(page.locator('#install-guide')).toBeVisible();
    await page.waitForTimeout(500);
    expect(registerCount()).toBe(0);
    await page.locator('#install-guide-later').click();
    await expect(page.locator('#join-pair')).toBeVisible();
    await expect(page.locator('#join-install-guide')).toBeVisible();
    expect(registerCount()).toBe(0);
  } finally {
    await context.close();
  }
});

test('分享页点击加好友先引导，不创建访客', async ({ browser, request }) => {
  const base = await baseUrl();
  const { shareUrl } = await createAgentShare(request, base);
  const context = await newMobileContext(browser);
  const registerCount = countRegisters(context);
  const page = await context.newPage();
  try {
    await page.goto(shareUrl);
    await expect(page.locator('#add')).toBeVisible();
    await page.locator('#add').click();
    await expect(page.locator('#install-guide')).toBeVisible();
    await page.waitForTimeout(500);
    expect(registerCount()).toBe(0);
    await page.locator('#install-guide-later').click();
    await expect(page.locator('#install-guide')).toHaveCount(0);
    expect(registerCount()).toBe(0);
  } finally {
    await context.close();
  }
});

test('已有有效凭据的移动端直接进入，不弹安装引导', async ({ browser, request }) => {
  const base = await baseUrl();
  const token = crypto.randomUUID();
  await callTool(request, base, token, 'network_register', {
    request_id: requestId('pwa_existing'),
    kind: 'human',
    name: 'PWA Existing',
  });
  const context = await newMobileContext(browser);
  await context.addInitScript((value) => {
    localStorage.setItem('agent-network-token', value);
    localStorage.removeItem('agent-network-logged-out');
  }, token);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`);
    await expect(page.locator('#install-guide')).toHaveCount(0);
    await expect(page.locator('#room-search')).toBeVisible();
    await expect(page.locator('#account-name')).toHaveText('PWA Existing');
  } finally {
    await context.close();
  }
});
