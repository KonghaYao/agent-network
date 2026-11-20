import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { encode } from 'uqr';

/**
 * PWA 阶段 2b：手机扫码配对。
 *
 * 原生 BarcodeDetector 与 getUserMedia 使用页面内桩；软件回退用 uqr 生成
 * SVG、canvas.captureStream 提供真实帧，由 jsqr 在浏览器里真实解码。
 * 真机相机指示、系统安装与权限弹窗不在本文件覆盖范围。
 */

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

interface ToolEnvelope {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
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
            name: 'agent-network-pwa-pair-e2e',
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
    throw new Error(result.content?.find((item) => item.type === 'text')?.text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface PairingCreated {
  challenge: string;
  pairing_id: string;
}

interface PairingList {
  items: {
    pairing_id: string;
    confirm_code: string | null;
    status: string;
    device_label: string;
  }[];
}

interface Registered {
  actor_id: string;
}

const base = await baseUrl();
let ownerToken = '';
let ownerName = '';
let otherToken = '';
let otherActorId = '';

async function newMobileContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  });
}

async function storedIdentity(
  page: Page,
  actorId: string,
): Promise<{ actor_id?: string; token?: string } | null> {
  return page.evaluate((id) => {
    const raw = window.localStorage.getItem(`agent-network-identity-v1:${id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { actor_id?: string; token?: string };
    } catch {
      return null;
    }
  }, actorId);
}

function qrSvg(text: string): string {
  const encoded = encode(text, { ecc: 'M', border: 4 });
  let rects = '';
  for (let row = 0; row < encoded.size; row += 1) {
    for (let column = 0; column < encoded.size; column += 1) {
      if (encoded.data[row]?.[column] !== true) continue;
      rects += `<rect x="${column}" y="${row}" width="1" height="1"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${encoded.size} ${encoded.size}" ` +
    `shape-rendering="crispEdges"><rect width="${encoded.size}" height="${encoded.size}" fill="#fff"/>` +
    `<g fill="#000">${rects}</g></svg>`
  );
}

interface ScannerStubOptions {
  qr: string;
  native: boolean;
  deny?: boolean;
  /** 软件回退时延迟绘制二维码，留出观察 data-decoder 的窗口。 */
  drawDelayMs?: number;
  svg?: string;
}

async function installScannerStub(
  context: BrowserContext,
  options: ScannerStubOptions,
): Promise<void> {
  await context.addInitScript((config: ScannerStubOptions) => {
    const state: { qr: string; stops: number } = { qr: config.qr, stops: 0 };
    (window as unknown as { __pairState?: typeof state }).__pairState = state;
    const recordStop = () => {
      state.stops += 1;
      try {
        localStorage.setItem('__pwa_pair_camera_stops', String(state.stops));
      } catch {
        // 忽略存储不可用；页面内计数仍可读。
      }
    };

    if (config.deny) {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          throw new DOMException('denied', 'NotAllowedError');
        },
      });
    } else {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 320;
          const context = canvas.getContext('2d');
          if (context) {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
          }
          const stream = canvas.captureStream(10);
          for (const track of stream.getTracks()) {
            const originalStop = track.stop.bind(track);
            track.stop = () => {
              recordStop();
              originalStop();
            };
          }
          if (config.svg) {
            const image = new Image();
            image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(config.svg)}`;
            const draw = () => {
              if (!context) return;
              context.fillStyle = '#ffffff';
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.drawImage(image, 0, 0, canvas.width, canvas.height);
            };
            const delay = config.drawDelayMs ?? 0;
            if (delay > 0) {
              setTimeout(() => {
                void image.decode().then(draw).catch(draw);
              }, delay);
            } else {
              void image.decode().then(draw).catch(draw);
            }
          }
          return stream;
        },
      });
    }

    if (config.native) {
      class FakeBarcodeDetector {
        static async getSupportedFormats(): Promise<string[]> {
          return ['qr_code'];
        }

        async detect(): Promise<{ rawValue: string }[]> {
          return state.qr ? [{ rawValue: state.qr }] : [];
        }
      }
      Object.defineProperty(window, 'BarcodeDetector', {
        configurable: true,
        value: FakeBarcodeDetector,
      });
    } else {
      Object.defineProperty(window, 'BarcodeDetector', {
        configurable: true,
        value: undefined,
      });
    }
  }, options);
}

function countMcpCalls(context: BrowserContext): {
  registers: () => number;
  joins: () => { count: number; ids: string[] };
} {
  let registers = 0;
  let joins = 0;
  const joinIds: string[] = [];
  void context.route('**/mcp', async (route) => {
    const request = route.request();
    let body: {
      method?: string;
      params?: { name?: string; arguments?: { request_id?: string } };
    } = {};
    try {
      body = request.postDataJSON() as typeof body;
    } catch {
      body = {};
    }
    const name = body.params?.name;
    if (name === 'network_register') registers += 1;
    if (name === 'network_device_pairing_join') {
      joins += 1;
      const id = body.params?.arguments?.request_id;
      if (id) joinIds.push(id);
    }
    await route.continue();
  });
  return {
    registers: () => registers,
    joins: () => ({ count: joins, ids: joinIds }),
  };
}

async function createPairing(
  apiRequest: APIRequestContext,
  deviceLabel: string,
): Promise<PairingCreated> {
  return callTool<PairingCreated>(apiRequest, base, ownerToken, 'network_device_pairing_create', {
    request_id: requestId('e2e_pair'),
    device_label: deviceLabel,
  });
}

async function cancelPairing(
  apiRequest: APIRequestContext,
  pairingId: string,
): Promise<void> {
  try {
    await callTool(apiRequest, base, ownerToken, 'network_device_pairing_cancel', {
      request_id: requestId('e2e_cancel'),
      pairing_id: pairingId,
      reason: 'e2e cleanup',
    });
  } catch {
    // 已兑换或已过期时无需清理；测试用临时数据库会在下一轮重建。
  }
}

async function approvePairing(
  apiRequest: APIRequestContext,
  confirmCode: string,
): Promise<void> {
  const listed = await callTool<PairingList>(
    apiRequest,
    base,
    ownerToken,
    'network_device_pairing_list',
    { limit: 50 },
  );
  const item = listed.items.find(
    (entry) =>
      entry.confirm_code === confirmCode &&
      (entry.status === 'pending' || entry.status === 'approved'),
  );
  if (!item) throw new Error(`未找到确认码 ${confirmCode} 的配对请求`);
  await callTool(apiRequest, base, ownerToken, 'network_device_pairing_approve', {
    request_id: requestId('e2e_approve'),
    pairing_id: item.pairing_id,
  });
}

test.beforeAll(async ({ request }) => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  ownerToken = crypto.randomUUID();
  ownerName = `PWA 配对主人 ${suffix}`;
  await callTool(request, base, ownerToken, 'network_register', {
    request_id: requestId('pwa_pair_owner'),
    kind: 'human',
    name: ownerName,
    device_id: crypto.randomUUID(),
  });
  otherToken = crypto.randomUUID();
  const other = await callTool<Registered>(request, base, otherToken, 'network_register', {
    request_id: requestId('pwa_pair_other'),
    kind: 'human',
    name: `PWA 另一账号 ${suffix}`,
    device_id: crypto.randomUUID(),
  });
  otherActorId = other.actor_id;
});

test('短码配对保持原流程并在空设备自动进入', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 短码手机');
  const context = await newMobileContext(browser);
  const counters = countMcpCalls(context);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair#c=${created.challenge}`);
    await page.waitForFunction(() => window.location.hash === '');
    await expect(page.locator('#pair-challenge')).toHaveValue(created.challenge);
    await expect(page.locator('#pair-original')).toContainText('未登录');
    await page.locator('#pair-start').click();
    await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
    const confirm = (await page.locator('#pair-confirm').textContent()) ?? '';
    expect(confirm).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/u);
    expect(counters.joins().count).toBe(1);
    await approvePairing(request, confirm);
    await page.waitForURL(`${base}/`, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toHaveText(ownerName);
    const pairedToken = await page.evaluate(() =>
      window.localStorage.getItem('agent-network-token'),
    );
    expect(pairedToken).toBeTruthy();
    expect(pairedToken).not.toBe(ownerToken);
    expect(counters.registers()).toBe(0);
    console.log(JSON.stringify({ flow: 'short-code', joins: counters.joins().count }));
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('网络失败后重试复用原 join request_id', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 重试手机');
  const context = await newMobileContext(browser);
  const joinIds: string[] = [];
  let failOnce = true;
  await context.route('**/mcp', async (route) => {
    let body: {
      method?: string;
      params?: { name?: string; arguments?: { request_id?: string } };
    } = {};
    try {
      body = route.request().postDataJSON() as typeof body;
    } catch {
      body = {};
    }
    if (body.params?.name === 'network_device_pairing_join') {
      const id = body.params.arguments?.request_id;
      if (id) joinIds.push(id);
      if (failOnce) {
        failOnce = false;
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair#c=${created.challenge}`);
    await page.waitForFunction(() => window.location.hash === '');
    await page.locator('#pair-start').click();
    await expect(page.locator('#status')).toContainText('配对失败', { timeout: 10_000 });
    await expect(page.locator('#pair-start')).toBeEnabled();
    await page.locator('#pair-start').click();
    await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
    expect(joinIds).toHaveLength(2);
    expect(joinIds[0]).toBe(joinIds[1]);
    console.log(JSON.stringify({ flow: 'join-retry', joinIds }));
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('扫码优先原生解码，只发起一次申请并显示确认码后自动进入', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 扫码手机');
  const context = await newMobileContext(browser);
  const counters = countMcpCalls(context);
  await installScannerStub(context, {
    qr: `${base}/pair#c=${created.challenge}`,
    native: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair?scan=1`);
    await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
    await expect(page.locator('#pair-scanner')).toHaveCount(0);
    const confirm = (await page.locator('#pair-confirm').textContent()) ?? '';
    expect(confirm).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/u);
    await page.waitForTimeout(600);
    expect(counters.joins().count).toBe(1);
    expect(counters.joins().ids).toHaveLength(1);
    const stops = await page.evaluate(() =>
      Number(localStorage.getItem('__pwa_pair_camera_stops') ?? '0'),
    );
    expect(stops).toBeGreaterThanOrEqual(1);
    await approvePairing(request, confirm);
    await page.waitForURL(`${base}/`, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toHaveText(ownerName);
    expect(counters.registers()).toBe(0);
    console.log(
      JSON.stringify({ flow: 'scan-native', joins: counters.joins(), cameraStops: stops }),
    );
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('无原生 BarcodeDetector 时按需加载 jsqr 并真实解码', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 软件解码手机');
  const context = await newMobileContext(browser);
  const counters = countMcpCalls(context);
  await installScannerStub(context, {
    qr: `${base}/pair#c=${created.challenge}`,
    native: false,
    svg: qrSvg(`${base}/pair#c=${created.challenge}`),
    drawDelayMs: 500,
  });
  const page = await context.newPage();
  const decoderRequests: string[] = [];
  page.on('request', (event) => {
    if (event.url().includes('/static/') && event.url().endsWith('.js')) {
      decoderRequests.push(event.url());
    }
  });
  try {
    await page.goto(`${base}/pair?scan=1`);
    await expect(page.locator('#pair-scanner[data-decoder="jsqr"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
    expect(counters.joins().count).toBe(1);
    expect(counters.registers()).toBe(0);
    expect(decoderRequests.some((url) => /jsqr/iu.test(url))).toBe(true);
    console.log(
      JSON.stringify({
        flow: 'scan-jsqr',
        decoderRequests,
        joins: counters.joins().count,
      }),
    );
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('外域二维码给出原因并保留重扫入口', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 重扫手机');
  const context = await newMobileContext(browser);
  const counters = countMcpCalls(context);
  await installScannerStub(context, {
    qr: `https://evil.example/pair#c=${created.challenge}`,
    native: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair?scan=1`);
    await expect(page.locator('#status')).toContainText('来自其他站点', { timeout: 10_000 });
    await expect(page.locator('#pair-scanner')).toHaveCount(0);
    await expect(page.locator('#pair-scan')).toBeEnabled();
    expect(counters.joins().count).toBe(0);

    await page.evaluate(
      (qr) => {
        (window as unknown as { __pairState: { qr: string } }).__pairState.qr = qr;
      },
      `${base}/pair#c=${created.challenge}`,
    );
    await page.locator('#pair-scan').click();
    await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
    expect(counters.joins().count).toBe(1);
    console.log(JSON.stringify({ flow: 'scan-invalid-then-valid', joins: counters.joins().count }));
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('拒绝相机权限时短码输入仍可完成配对', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 拒权手机');
  const context = await newMobileContext(browser);
  const counters = countMcpCalls(context);
  await installScannerStub(context, {
    qr: `${base}/pair#c=${created.challenge}`,
    native: true,
    deny: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair?scan=1`);
    await expect(page.locator('#pair-scanner[data-state="error"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('#pair-scanner-status')).toContainText('相机权限被拒绝');
    await expect(page.locator('#pair-challenge')).toBeVisible();
    await expect(page.locator('#pair-challenge')).toBeEditable();
    await page.locator('#pair-challenge').fill(created.challenge);
    await page.locator('#pair-start').click();
    await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
    expect(counters.joins().count).toBe(1);
    expect(counters.registers()).toBe(0);
    console.log(JSON.stringify({ flow: 'permission-denied-fallback', joins: 1 }));
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('取消扫描与离页都会停止相机轨道', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 停轨手机');
  const context = await newMobileContext(browser);
  await installScannerStub(context, {
    qr: '',
    native: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair?scan=1`);
    await expect(page.locator('#pair-scanner[data-state="scanning"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.locator('#pair-scanner[data-state="stopped"]')).toBeVisible();
    const afterHidden = await page.evaluate(() =>
      Number(localStorage.getItem('__pwa_pair_camera_stops') ?? '0'),
    );
    expect(afterHidden).toBeGreaterThanOrEqual(1);

    await page.locator('#pair-scanner-restart').click();
    await expect(page.locator('#pair-scanner[data-state="scanning"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.locator('#pair-scanner-cancel').click();
    await expect(page.locator('#pair-scanner')).toHaveCount(0);
    const afterCancel = await page.evaluate(() =>
      Number(localStorage.getItem('__pwa_pair_camera_stops') ?? '0'),
    );
    expect(afterCancel).toBeGreaterThan(afterHidden);

    await page.locator('#pair-scan').click();
    await expect(page.locator('#pair-scanner[data-state="scanning"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.goto(`${base}/pair`);
    const afterNavigate = await page.evaluate(() =>
      Number(localStorage.getItem('__pwa_pair_camera_stops') ?? '0'),
    );
    expect(afterNavigate).toBeGreaterThan(afterCancel);
    console.log(
      JSON.stringify({
        flow: 'camera-stop',
        afterHidden,
        afterCancel,
        afterNavigate,
        challengeLength: created.challenge.length,
      }),
    );
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('已有账号时保留显式切换，不自动覆盖当前身份', async ({ browser, request }) => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const phoneToken = crypto.randomUUID();
  const registered = await callTool<Registered>(request, base, phoneToken, 'network_register', {
    request_id: requestId('pwa_pair_phone'),
    kind: 'human',
    name: `PWA 手机原账号 ${suffix}`,
    device_id: crypto.randomUUID(),
  });
  const created = await createPairing(request, 'E2E 已有账号手机');
  const context = await newMobileContext(browser);
  await context.addInitScript(
    ({ token }: { token: string }) => {
      try {
        if (localStorage.getItem('__pwa_pair_seeded') !== '1') {
          localStorage.setItem('agent-network-token', token);
          localStorage.setItem('__pwa_pair_seeded', '1');
        }
      } catch {
        // 忽略存储不可用。
      }
    },
    { token: phoneToken },
  );
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair#c=${created.challenge}`);
    await expect(page.locator('#pair-original')).toContainText('PWA 手机原账号', {
      timeout: 10_000,
    });
    await page.locator('#pair-start').click();
    await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
    const confirm = (await page.locator('#pair-confirm').textContent()) ?? '';
    await approvePairing(request, confirm);
    await expect(page.locator('#pair-switch')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(`${base}/pair`);
    await page.locator('#pair-switch').click();
    await page.waitForURL(`${base}/`, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toHaveText(ownerName);
    const pairedToken = await page.evaluate(() =>
      window.localStorage.getItem('agent-network-token'),
    );
    expect(pairedToken).toBeTruthy();
    expect(pairedToken).not.toBe(phoneToken);
    expect(pairedToken).not.toBe(ownerToken);
    const oldIdentity = await storedIdentity(page, registered.actor_id);
    expect(oldIdentity).not.toBeNull();
    expect(oldIdentity?.token).toBe(phoneToken);
    expect(oldIdentity?.token).not.toBe(ownerToken);
    console.log(
      JSON.stringify({
        flow: 'existing-account-explicit-switch',
        pairedTokenDiffers: true,
        oldIdentityTokenMatches: oldIdentity?.token === phoneToken,
      }),
    );
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('扫码期间切换账号时保留显式确认', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 切号手机');
  const context = await newMobileContext(browser);
  await installScannerStub(context, {
    qr: `${base}/pair#c=${created.challenge}`,
    native: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair?scan=1`);
    await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
    const confirm = (await page.locator('#pair-confirm').textContent()) ?? '';
    await page.evaluate((token) => localStorage.setItem('agent-network-token', token), otherToken);
    await approvePairing(request, confirm);
    await expect(page.locator('#pair-switch')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(`${base}/pair?scan=1`);
    await page.locator('#pair-switch').click();
    await page.waitForURL(`${base}/`, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toHaveText(ownerName);
    // unknown 基线（配对期间才出现 token B）不得把 B 按旧身份写入。
    expect(await storedIdentity(page, otherActorId)).toBeNull();
    console.log(JSON.stringify({ flow: 'account-switched-during-pair', explicit: true }));
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('已有账号配对期间切到 B 后不写入 actor/token 错配', async ({ browser, request }) => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const phoneToken = crypto.randomUUID();
  const registered = await callTool<Registered>(request, base, phoneToken, 'network_register', {
    request_id: requestId('pwa_pair_identity_phone'),
    kind: 'human',
    name: `PWA 切号身份表 ${suffix}`,
    device_id: crypto.randomUUID(),
  });
  const created = await createPairing(request, 'E2E 身份表切号手机');
  const context = await newMobileContext(browser);
  await context.addInitScript(
    ({ token }: { token: string }) => {
      try {
        if (localStorage.getItem('__pwa_pair_identity_seeded') !== '1') {
          localStorage.setItem('agent-network-token', token);
          localStorage.setItem('__pwa_pair_identity_seeded', '1');
        }
      } catch {
        // 忽略存储不可用。
      }
    },
    { token: phoneToken },
  );
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair#c=${created.challenge}`);
    await expect(page.locator('#pair-original')).toContainText('PWA 切号身份表', {
      timeout: 10_000,
    });
    await page.locator('#pair-start').click();
    await expect(page.locator('#pair-confirm')).toHaveText(/^[0-9A-F]{4}-[0-9A-F]{4}$/u, {
      timeout: 10_000,
    });
    // 批准前把 token 切到账号 B；页面里的 A 身份已经陈旧。
    await page.evaluate((token) => localStorage.setItem('agent-network-token', token), otherToken);
    const confirm = (await page.locator('#pair-confirm').textContent()) ?? '';
    await approvePairing(request, confirm);
    await expect(page.locator('#pair-switch')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(`${base}/pair`);
    await page.locator('#pair-switch').click();
    await page.waitForURL(`${base}/`, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toHaveText(ownerName);

    const oldIdentity = await storedIdentity(page, registered.actor_id);
    const switchedIdentity = await storedIdentity(page, otherActorId);
    expect(oldIdentity).not.toBeNull();
    // A 的记录只能保存 A 的 token；B 不能被顶替成 A，也不会凭空出现。
    expect(oldIdentity?.token).toBe(phoneToken);
    expect(oldIdentity?.token).not.toBe(otherToken);
    expect(switchedIdentity).toBeNull();
    console.log(
      JSON.stringify({
        flow: 'identity-switched-during-pair',
        oldTokenMatchesA: oldIdentity?.token === phoneToken,
        foreignIdentityAbsent: switchedIdentity === null,
      }),
    );
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('空设备配对期间瞬时切号后不自动进入', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 瞬时切号手机');
  const context = await newMobileContext(browser);
  const page = await context.newPage();
  const writer = await context.newPage();
  try {
    await page.goto(`${base}/pair#c=${created.challenge}`);
    await page.waitForFunction(() => window.location.hash === '');
    await page.locator('#pair-start').click();
    await expect(page.locator('#pair-confirm')).toHaveText(/^[0-9A-F]{4}-[0-9A-F]{4}$/u, {
      timeout: 10_000,
    });
    // 另一个标签页短暂出现 B 的 token，再删除；首尾状态仍为空。
    await writer.goto(`${base}/pair`);
    await writer.evaluate((token) => localStorage.setItem('agent-network-token', token), otherToken);
    await writer.waitForTimeout(100);
    await writer.evaluate(() => localStorage.removeItem('agent-network-token'));
    await writer.waitForTimeout(300);
    expect(await page.evaluate(() => localStorage.getItem('agent-network-token'))).toBeNull();

    const confirm = (await page.locator('#pair-confirm').textContent()) ?? '';
    await approvePairing(request, confirm);
    await expect(page.locator('#pair-switch')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(`${base}/pair`);
    expect(await page.evaluate(() => localStorage.getItem('agent-network-token'))).toBeNull();

    await page.locator('#pair-switch').click();
    await page.waitForURL(`${base}/`, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toHaveText(ownerName);
    console.log(
      JSON.stringify({ flow: 'transient-switch-back-to-empty', autoEntered: false }),
    );
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});

test('空设备配对期间同标签页瞬时切号后不自动进入', async ({ browser, request }) => {
  const created = await createPairing(request, 'E2E 同标签瞬时切号手机');
  const context = await newMobileContext(browser);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pair#c=${created.challenge}`);
    await page.waitForFunction(() => window.location.hash === '');
    await page.locator('#pair-start').click();
    await expect(page.locator('#pair-confirm')).toHaveText(/^[0-9A-F]{4}-[0-9A-F]{4}$/u, {
      timeout: 10_000,
    });
    // 同一文档内写入后立即删除：不会产生 storage 事件，只能靠存储方法标记。
    await page.evaluate((token) => localStorage.setItem('agent-network-token', token), otherToken);
    await page.waitForTimeout(100);
    await page.evaluate(() => localStorage.removeItem('agent-network-token'));
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => localStorage.getItem('agent-network-token'))).toBeNull();

    const confirm = (await page.locator('#pair-confirm').textContent()) ?? '';
    await approvePairing(request, confirm);
    await expect(page.locator('#pair-switch')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await expect(page).toHaveURL(`${base}/pair`);
    expect(await page.evaluate(() => localStorage.getItem('agent-network-token'))).toBeNull();

    await page.locator('#pair-switch').click();
    await page.waitForURL(`${base}/`, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toHaveText(ownerName);
    console.log(JSON.stringify({ flow: 'same-tab-transient-switch', autoEntered: false }));
  } finally {
    await context.close();
    await cancelPairing(request, created.pairing_id);
  }
});
