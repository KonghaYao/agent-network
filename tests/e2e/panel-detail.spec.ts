import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * S5：文件卡、网页监控与 Memory 抽屉的细节收口。
 *
 * 只验证展示契约（尺寸/边框/格式/溢出）与既有交互入口；不重跑完整业务
 * 旅程，也不改服务端 fixture。Memory 只读工具用页内 stub，身份、房间与
 * 文件仍走真实隔离服务。
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
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-e2e',
            version: '0.1.0',
          },
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
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface Registered {
  actor_id: string;
  name: string;
}

interface RoomDetail {
  room: { room_id: string };
}

interface UploadedFile {
  fileId: string;
  publicUrl: string;
}

/** 72 个汉字 + 扩展名，覆盖 2 行省略与 `overflow-wrap`。 */
const LONG_NAME = `${'很长的文件名'.repeat(12)}-${crypto.randomUUID().slice(0, 6)}.txt`;
const FILE_MARKER = `PANEL-FILE-${crypto.randomUUID().slice(0, 8)}`;
const FILE_BODY = 'S5 文件卡元数据';

async function login(page: Page, base: string, token: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('agent-network-token', value);
      localStorage.removeItem('agent-network-logged-out');
    } catch {
      // 浏览器禁用存储时由页面错误态兜底。
    }
  }, token);
  await page.goto(base);
}

async function uploadText(
  base: string,
  token: string,
  name: string,
  body: string,
): Promise<UploadedFile> {
  const bytes = Buffer.from(body);
  const response = await fetch(`${base}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': 'text/plain',
      'MCPP-File-Name': encodeURIComponent(name),
      'MCPP-File-Size': String(bytes.length),
    },
    body: bytes,
  });
  if (response.status !== 201) throw new Error(`上传失败：HTTP ${response.status}`);
  return (await response.json()) as UploadedFile;
}

async function bindRoomFile(
  base: string,
  token: string,
  roomId: string,
  fileId: string,
): Promise<void> {
  await callTool(base, token, 'network_room_file_bind', {
    request_id: requestId('e2e_panel_bind'),
    room_id: roomId,
    file_id: fileId,
  });
}

async function sendText(
  base: string,
  token: string,
  roomId: string,
  body: string,
): Promise<void> {
  await callTool(base, token, 'network_message_send', {
    request_id: requestId('e2e_panel_send'),
    client_message_id: requestId('e2e_panel_cm'),
    room_id: roomId,
    body,
    invoke: [],
  });
}

interface MemoryCall {
  name: string;
  args: Record<string, unknown>;
}

const CONTEXT_ROWS = [
  {
    context_id: 'ctx-unknown-time',
    kind: 'bound',
    validity: 'valid',
    created_at: null,
  },
  {
    context_id: 'ctx-known-time',
    kind: 'bound',
    validity: 'valid',
    created_at: '2026-10-01T09:30:00.000Z',
  },
];

/** 只替换 Memory 只读响应；network_me 仍由真实服务返回当前 Agent。 */
async function stubMemory(page: Page, calls: MemoryCall[]): Promise<void> {
  await page.route('**/mcp', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    let body: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } } | null = null;
    try {
      body = JSON.parse(route.request().postData() ?? 'null') as {
        id?: unknown;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
    } catch {
      // 非 JSON 请求直接放行。
    }
    const name = body?.params?.name;
    if (name === 'network_me') {
      const response = await route.fetch();
      const payload = (await response.json()) as {
        result?: { structuredContent?: { service?: { memory?: Record<string, unknown> } } };
      };
      const service = payload.result?.structuredContent?.service;
      if (service) {
        service.memory = {
          ...(service.memory ?? {}),
          enabled: true,
          capture: true,
          recall_modes: ['lookup'],
          supported: ['lookup'],
          unsupported: [],
          reason: null,
        };
      }
      await route.fulfill({ response, json: payload });
      return;
    }
    if (name === 'network_memory_status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          result: {
            structuredContent: {
              enabled: true,
              capture: true,
              host_level: 'tool_only',
              counts: { jobs_pending: 3, retain_pending: 0, contexts_ready: 0 },
            },
          },
        }),
      });
      return;
    }
    if (name === 'network_memory_context_list') {
      if (body?.params?.arguments) calls.push({ name, args: body.params.arguments });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          result: {
            structuredContent: {
              items: CONTEXT_ROWS,
              next_cursor: null,
              has_more: false,
            },
          },
        }),
      });
      return;
    }
    await route.fallback();
  });
}

test.describe('S5 面板细节', () => {
  test.describe.configure({ timeout: 60_000 });
  let base = '';
  let humanToken = '';
  let agentToken = '';
  let agentId = '';
  let roomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    humanToken = crypto.randomUUID();

    const human = await callTool<Registered>(base, humanToken, 'network_register', {
      request_id: requestId('e2e_panel_reg'),
      kind: 'human',
      name: `Panel Human ${suffix}`,
      device_id: `e2e-panel-${suffix}`,
    });

    const agent = await callTool<{ actor_id: string; token: string }>(
      base,
      humanToken,
      'network_agent_create',
      { request_id: requestId('e2e_panel_agent'), name: `Panel Agent ${suffix}` },
    );
    agentId = agent.actor_id;
    agentToken = agent.token;

    const direct = await callTool<RoomDetail>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_panel_room'),
      kind: 'direct',
      members: [agent.actor_id],
    });
    roomId = direct.room.room_id;

    const uploaded = await uploadText(base, humanToken, LONG_NAME, FILE_BODY);
    await bindRoomFile(base, humanToken, roomId, uploaded.fileId);
    await sendText(
      base,
      humanToken,
      roomId,
      `${FILE_MARKER}\n[${LONG_NAME}](${uploaded.publicUrl})`,
    );

    expect(human.actor_id).toBeTruthy();
    expect(agentId).toBeTruthy();
  });

  test('文件卡：单层表面、S2 类型/大小/时间、44px 操作与长名不溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, base, humanToken);
    await page.goto(`${base}/c/${roomId}`);

    const message = page.locator('#messages .msg').filter({ hasText: FILE_MARKER });
    await expect(message).toBeVisible({ timeout: 15_000 });
    const card = message.locator('.msg-file').first();
    await expect(card.locator('.msg-file-name')).toHaveText(LONG_NAME, { timeout: 15_000 });

    const cardMetrics = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      let wrapperSurface = false;
      let node: Element | null = element.parentElement;
      while (node && !node.classList.contains('msg-content')) {
        if ((node.getAttribute('data-lenso-slot') ?? '').startsWith('surface')) {
          wrapperSurface = true;
          break;
        }
        node = node.parentElement;
      }
      return {
        padding: style.padding,
        borderRadius: style.borderRadius,
        borderTopWidth: style.borderTopWidth,
        borderTopStyle: style.borderTopStyle,
        boxShadow: style.boxShadow,
        background: style.backgroundColor,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        wrapperSurface,
      };
    });
    expect(cardMetrics.padding).toBe('12px');
    expect(cardMetrics.borderRadius).toBe('12px');
    expect(cardMetrics.borderTopWidth).toBe('1px');
    expect(cardMetrics.borderTopStyle).toBe('solid');
    expect(cardMetrics.boxShadow).toBe('none');
    expect(cardMetrics.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(cardMetrics.wrapperSurface).toBe(false);
    expect(cardMetrics.scrollWidth).toBeLessThanOrEqual(cardMetrics.clientWidth + 1);

    const kind = await card.locator('.msg-file-kind').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        radius: getComputedStyle(element).borderRadius,
      };
    });
    expect(kind.width).toBeGreaterThanOrEqual(35.5);
    expect(kind.width).toBeLessThanOrEqual(36.5);
    expect(kind.height).toBeGreaterThanOrEqual(35.5);
    expect(kind.height).toBeLessThanOrEqual(36.5);
    expect(kind.radius).toBe('8px');

    const name = await card.locator('.msg-file-name').evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        clamp: style.webkitLineClamp,
        height: box.height,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    expect(name.fontSize).toBe('14px');
    expect(name.lineHeight).toBe('22px');
    expect(name.clamp).toBe('2');
    expect(name.height).toBeLessThanOrEqual(45);
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1);

    const meta = card.locator('.msg-file-size');
    await expect(meta).toContainText('文本');
    await expect(meta).toContainText('B');
    await expect(meta.locator('time')).toHaveCount(1);
    await expect(meta.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/u);
    await expect(meta.locator('time')).toHaveAttribute('title', /\d{4}年/u);
    const metaFont = await meta.evaluate((element) => {
      const style = getComputedStyle(element);
      return { fontSize: style.fontSize, lineHeight: style.lineHeight };
    });
    expect(metaFont).toEqual({ fontSize: '12px', lineHeight: '16px' });

    for (const selector of ['.msg-file-preview', '.msg-file-download']) {
      const action = card.locator(selector);
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(43.5);
      expect(box!.height).toBeGreaterThanOrEqual(43.5);
    }
    const actionRadius = await card
      .locator('.msg-file-preview')
      .evaluate((element) => getComputedStyle(element).borderRadius);
    expect(actionRadius).toBe('8px');

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(1);

    const lightBackground = cardMetrics.background;
    expect(lightBackground).not.toBe('rgba(0, 0, 0, 0)');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    const mobile = await card.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: box.width,
        right: box.right,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        background: style.backgroundColor,
        color: style.color,
      };
    });
    expect(mobile.width).toBeLessThanOrEqual(390);
    expect(mobile.right).toBeLessThanOrEqual(390);
    expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.clientWidth + 1);
    // 暗色抽样：组件不依赖浅色硬编码，表面仍为不透明且文字与背景可区分。
    expect(mobile.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(mobile.color).not.toBe(mobile.background);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(1);
  });

  test('Monitor：两行工具栏、44px 操作、状态/错误文案与 390 无溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await login(page, base, humanToken);
    await page.goto(`${base}/c/${roomId}`);

    await page.locator('#monitor-toggle').click();
    const pane = page.locator('#monitor-pane');
    await expect(pane).toBeVisible();
    await expect(page.locator('#monitor-form [data-lenso-slot="toolbar"]')).toBeVisible();
    await expect(pane.locator('.monitor-empty')).toHaveText('暂无网页');

    const metrics = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: box.x,
          y: box.y,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          borderRadius: style.borderRadius,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          borderTopWidth: style.borderTopWidth,
          background: style.backgroundColor,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      };
      return {
        pane: read('#monitor-pane'),
        input: read('#monitor-url'),
        save: read('#monitor-save'),
        clear: read('#monitor-clear'),
        external: read('#monitor-external'),
        refresh: read('#monitor-refresh'),
        close: read('#monitor-close'),
        status: read('#monitor-status'),
      };
    });
    expect(metrics.pane).not.toBeNull();
    expect(metrics.input).not.toBeNull();
    for (const key of ['save', 'clear', 'external', 'refresh', 'close'] as const) {
      const action = metrics[key]!;
      expect(action.width).toBeGreaterThanOrEqual(43.5);
      expect(action.height).toBeGreaterThanOrEqual(43.5);
      expect(action.borderRadius).toBe('8px');
      expect(action.borderTopWidth).toBe('0px');
    }
    expect(metrics.input!.height).toBeGreaterThanOrEqual(35.5);
    expect(metrics.input!.height).toBeLessThanOrEqual(36.5);
    expect(metrics.input!.fontSize).toBe('13px');
    expect(metrics.input!.borderRadius).toBe('8px');
    expect(metrics.input!.width).toBeGreaterThanOrEqual(160);
    expect(metrics.save!.top).toBeLessThan(metrics.clear!.top);
    expect(metrics.clear!.top).toBeGreaterThanOrEqual(metrics.input!.bottom - 1);
    expect(metrics.pane!.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(metrics.pane!.scrollWidth).toBeLessThanOrEqual(metrics.pane!.clientWidth + 1);
    expect(metrics.status!.fontSize).toBe('12px');
    expect(metrics.status!.lineHeight).toBe('16px');

    // 长错误走 role=alert，不横向溢出，重试仍可点击。
    await page.route('**/mcp', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      let body: { id?: unknown; params?: { name?: string } } | null = null;
      try {
        body = JSON.parse(route.request().postData() ?? 'null') as {
          id?: unknown;
          params?: { name?: string };
        };
      } catch {
        // 非 JSON 请求直接放行。
      }
      if (body?.params?.name !== 'network_room_monitor_set') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: {
            code: -32000,
            message: `保存失败测试：${'monitor-error-'.repeat(24)}`,
          },
        }),
      });
    });
    await page.fill('#monitor-url', `https://example.com/${'x'.repeat(200)}`);
    await page.locator('#monitor-save').click();
    const error = page.locator('#monitor-error');
    await expect(error).toBeVisible();
    const errorMetrics = await error.evaluate((element) => {
      const text = element.querySelector('p')!;
      const retry = element.querySelector('button')!;
      const style = getComputedStyle(text);
      const box = retry.getBoundingClientRect();
      return {
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        scrollWidth: text.scrollWidth,
        clientWidth: text.clientWidth,
        retryWidth: box.width,
        retryHeight: box.height,
        paneOverflow: document.getElementById('monitor-pane')!.scrollWidth -
          document.getElementById('monitor-pane')!.clientWidth,
      };
    });
    expect(errorMetrics.fontSize).toBe('12px');
    expect(errorMetrics.lineHeight).toBe('16px');
    expect(errorMetrics.scrollWidth).toBeLessThanOrEqual(errorMetrics.clientWidth + 1);
    expect(errorMetrics.retryWidth).toBeGreaterThanOrEqual(43.5);
    expect(errorMetrics.retryHeight).toBeGreaterThanOrEqual(43.5);
    expect(errorMetrics.paneOverflow).toBeLessThanOrEqual(1);
    await page.unroute('**/mcp');

    await page.fill('#monitor-url', 'https://example.com/panel-detail');
    await page.locator('#monitor-save').click();
    await expect(page.locator('#monitor-status')).toContainText('已保存');
    await expect(error).toHaveCount(0);

    // 390 单栏不继承桌面右栏状态，用聊天头入口重新打开全屏监控。
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(pane).toBeHidden();
    await page.locator('#monitor-toggle').click();
    await expect(pane).toBeVisible();
    await page.locator('#monitor-url').waitFor();
    const mobile = await page.evaluate(() => {
      const pane = document.getElementById('monitor-pane')!;
      const input = document.getElementById('monitor-url')!;
      const style = getComputedStyle(input);
      const box = (id: string) => {
        const rect = document.getElementById(id)!.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      };
      return {
        paneWidth: pane.getBoundingClientRect().width,
        paneRight: pane.getBoundingClientRect().right,
        inputHeight: input.getBoundingClientRect().height,
        inputFont: style.fontSize,
        save: box('monitor-save'),
        clear: box('monitor-clear'),
        close: box('monitor-close'),
        paneOverflow: pane.scrollWidth - pane.clientWidth,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(mobile.paneWidth).toBeGreaterThanOrEqual(389.5);
    expect(mobile.paneWidth).toBeLessThanOrEqual(390.5);
    expect(mobile.paneRight).toBeLessThanOrEqual(390.5);
    expect(mobile.inputHeight).toBeGreaterThanOrEqual(43.5);
    expect(mobile.inputFont).toBe('16px');
    for (const action of [mobile.save, mobile.clear, mobile.close]) {
      expect(action.width).toBeGreaterThanOrEqual(43.5);
      expect(action.height).toBeGreaterThanOrEqual(43.5);
    }
    expect(mobile.paneOverflow).toBeLessThanOrEqual(1);
    expect(mobile.documentOverflow).toBeLessThanOrEqual(1);

    await page.locator('#monitor-close').click();
    await expect(pane).toBeHidden();
    await expect(page.locator('#monitor-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  test('Memory：单壳、单层 chip、行分隔、S2 未知值与 390 无溢出', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const calls: MemoryCall[] = [];
    await stubMemory(page, calls);
    await login(page, base, agentToken);
    await expect(page.locator('#memory-open')).toBeVisible({ timeout: 15_000 });
    await page.locator('#memory-open').click();

    const drawer = page.locator('#memory-drawer');
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#memory-title')).toHaveText('记忆');

    const shell = await drawer.evaluate((element) => {
      const card = element.querySelector<HTMLElement>('.memory-card')!;
      const style = getComputedStyle(card);
      const close = element.querySelector<HTMLElement>('#memory-close')!.getBoundingClientRect();
      const refresh = element.querySelector<HTMLElement>('#memory-refresh')!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        width: box.width,
        left: box.left,
        right: box.right,
        cardShadow: style.boxShadow,
        cardBorderLeft: style.borderLeftWidth,
        cardBorderRight: style.borderRightWidth,
        close: { width: close.width, height: close.height },
        refresh: { width: refresh.width, height: refresh.height },
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(shell.width).toBeGreaterThanOrEqual(470);
    expect(shell.width).toBeLessThanOrEqual(481);
    expect(shell.right).toBeLessThanOrEqual(1280.5);
    expect(shell.cardShadow).toBe('none');
    expect(shell.cardBorderLeft).toBe('1px');
    expect(shell.cardBorderRight).toBe('0px');
    expect(shell.close.width).toBeGreaterThanOrEqual(43.5);
    expect(shell.close.height).toBeGreaterThanOrEqual(43.5);
    expect(shell.refresh.width).toBeGreaterThanOrEqual(43.5);
    expect(shell.refresh.height).toBeGreaterThanOrEqual(43.5);
    expect(shell.overflow).toBeLessThanOrEqual(1);

    // 能力状态 Badge 与普通 Chip 都只有内层一次背景/一次内距。
    const badge = page.locator('#memory-capability .memory-chip [data-lenso-slot="badge"]');
    await expect(badge).toHaveText('已启用');
    const badgeStyle = await badge.evaluate((element) => {
      const style = getComputedStyle(element);
      const outer = element.parentElement!;
      const outerStyle = getComputedStyle(outer);
      return {
        height: style.height,
        padding: style.padding,
        borderRadius: style.borderRadius,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        outerPadding: outerStyle.padding,
        outerBackground: outerStyle.backgroundColor,
      };
    });
    expect(badgeStyle).toEqual({
      height: '20px',
      padding: '2px 4px',
      borderRadius: '4px',
      fontSize: '12px',
      lineHeight: '16px',
      outerPadding: '0px',
      outerBackground: 'rgba(0, 0, 0, 0)',
    });
    const chip = page.locator('.memory-chip-row .memory-chip [data-lenso-slot^="chip"]').first();
    await expect(chip).toBeVisible();
    const chipStyle = await chip.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        padding: style.padding,
        borderRadius: style.borderRadius,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        minHeight: style.minHeight,
      };
    });
    expect(chipStyle.padding).toBe('2px 4px');
    expect(chipStyle.borderRadius).toBe('4px');
    expect(chipStyle.fontSize).toBe('12px');
    expect(chipStyle.lineHeight).toBe('16px');
    expect(chipStyle.minHeight).toBe('20px');

    // 筛选 Select 桌面 36、手机 44/16；圆角统一 8。
    const filter = await page.locator('#memory-recall-mode').evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        height: box.height,
        fontSize: style.fontSize,
        borderRadius: style.borderRadius,
      };
    });
    expect(filter.height).toBeGreaterThanOrEqual(35.5);
    expect(filter.height).toBeLessThanOrEqual(36.5);
    expect(filter.fontSize).toBe('13px');
    expect(filter.borderRadius).toBe('8px');

    // 计数：已知 3 / 0 保留，缺失显示 —。
    const stats = await page.locator('.memory-stat').evaluateAll((elements) =>
      elements.map((element) => ({
        value: element.querySelector('strong')!.textContent,
        valueFont: getComputedStyle(element.querySelector('strong')!).fontSize,
        valueLeading: getComputedStyle(element.querySelector('strong')!).lineHeight,
        labelFont: getComputedStyle(element.querySelector('span')!).fontSize,
        labelLeading: getComputedStyle(element.querySelector('span')!).lineHeight,
      })),
    );
    expect(stats.map((item) => item.value)).toEqual(['3', '—', '0', '0']);
    for (const stat of stats) {
      expect(stat.valueFont).toBe('16px');
      expect(stat.valueLeading).toBe('24px');
      expect(stat.labelFont).toBe('12px');
      expect(stat.labelLeading).toBe('16px');
    }

    await expect(page.locator('#memory-tabs [role="tab"]')).toHaveCount(5);
    await page.locator('[data-memory-tab="context"]').click();
    const rows = page.locator('#memory-context-list .memory-row');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });

    const rowMetrics = await rows.first().evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const title = element.querySelector<HTMLElement>('.memory-row-title')!;
      const meta = element.querySelector<HTMLElement>('.memory-row-meta')!;
      return {
        height: box.height,
        width: box.width,
        borderBottom: style.borderBottomWidth,
        titleFont: getComputedStyle(title).fontSize,
        titleLeading: getComputedStyle(title).lineHeight,
        titleBottom: title.getBoundingClientRect().bottom,
        metaTop: meta.getBoundingClientRect().top,
        metaFont: getComputedStyle(meta).fontSize,
        metaLeading: getComputedStyle(meta).lineHeight,
        metaText: meta.textContent ?? '',
      };
    });
    expect(rowMetrics.height).toBeGreaterThanOrEqual(43.5);
    expect(rowMetrics.width).toBeGreaterThan(300);
    expect(rowMetrics.metaTop).toBeGreaterThanOrEqual(rowMetrics.titleBottom - 1);
    expect(rowMetrics.borderBottom).toBe('0px');
    expect(rowMetrics.titleFont).toBe('14px');
    expect(rowMetrics.titleLeading).toBe('22px');
    expect(rowMetrics.metaFont).toBe('12px');
    expect(rowMetrics.metaLeading).toBe('16px');
    expect(rowMetrics.metaText).toContain('创建 —');
    await expect(rows.nth(1).locator('.memory-row-meta')).not.toContainText('创建 —');

    const separators = await page.locator('#memory-context-list .memory-list-item').evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).borderTopWidth),
    );
    expect(separators).toEqual(['0px', '1px']);
    const listSurface = await page.locator('#memory-context-list').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        padding: style.padding,
        borderTop: style.borderTopWidth,
        boxShadow: style.boxShadow,
        background: style.backgroundColor,
      };
    });
    expect(listSurface).toEqual({
      padding: '0px',
      borderTop: '0px',
      boxShadow: 'none',
      background: 'rgba(0, 0, 0, 0)',
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(1);

    // 760px 以下首页会重建单列外壳，抽屉状态不跨布局保留：关闭后以移动端重开。
    await page.locator('#memory-close').click();
    await expect(drawer).toBeHidden();
    await expect(page.locator('#memory-open')).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#memory-open').click();
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    const mobileFilter = await page.locator('#memory-recall-mode').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { height: box.height, fontSize: getComputedStyle(element).fontSize };
    });
    expect(mobileFilter.height).toBeGreaterThanOrEqual(43.5);
    expect(mobileFilter.fontSize).toBe('16px');
    await page.locator('[data-memory-tab="context"]').click();
    await expect(page.locator('#memory-context-list .memory-row')).toHaveCount(2, { timeout: 15_000 });
    const mobile = await drawer.evaluate((element) => {
      const card = element.querySelector<HTMLElement>('.memory-card')!;
      const row = element.querySelector<HTMLElement>('.memory-row')!;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(card);
      return {
        width: box.width,
        left: box.left,
        right: box.right,
        cardShadow: style.boxShadow,
        cardBorderLeft: style.borderLeftWidth,
        rowHeight: row.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
      };
    });
    expect(mobile.width).toBeGreaterThanOrEqual(389.5);
    expect(mobile.width).toBeLessThanOrEqual(390.5);
    expect(mobile.left).toBeGreaterThanOrEqual(-0.5);
    expect(mobile.right).toBeLessThanOrEqual(390.5);
    expect(mobile.cardShadow).toBe('none');
    expect(mobile.cardBorderLeft).toBe('0px');
    expect(mobile.rowHeight).toBeGreaterThanOrEqual(43.5);
    expect(mobile.overflow).toBeLessThanOrEqual(1);
    expect(mobile.cardOverflow).toBeLessThanOrEqual(1);

    await page.locator('#memory-close').click();
    await expect(drawer).toBeHidden();
    await expect(page.locator('#memory-open')).toBeFocused();
    expect(calls.length).toBeGreaterThan(0);
  });
});
