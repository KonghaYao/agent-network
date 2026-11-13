import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-1 Home e2e：需要服务端以 `WEB_SPA_ROUTES=home` 启动并显式 `E2E_SPA=1`。
 * 默认 `bun run test:e2e` 不跑 SPA 用例，旧壳用例保持独立。
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
    error?: { message?: string; data?: { code?: string } };
    result?: ToolEnvelope;
  };
  if (payload.error) {
    throw new Error(payload.error.message ?? 'MCP 调用失败');
  }
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface Registered {
  actor_id: string;
  name: string;
}

interface RoomList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

const SPA_ENABLED =
  process.env.E2E_SPA === '1' &&
  (process.env.WEB_SPA_ROUTES ?? '')
    .split(',')
    .map((value) => value.trim())
    .includes('home');

test.describe('SPA Home', () => {
  test.skip(!SPA_ENABLED, '需要 WEB_SPA_ROUTES=home E2E_SPA=1 才运行 React Home 用例');

  let base = '';
  let tokenA = '';
  let tokenB = '';
  let nameA = '';
  let nameB = '';
  let roomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    tokenB = crypto.randomUUID();
    nameA = `E2E A ${suffix}`;
    nameB = `E2E B ${suffix}`;

    await callTool<Registered>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameA,
      device_id: `e2e-${suffix}-a`,
    });
    const b = await callTool<Registered>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameB,
      device_id: `e2e-${suffix}-b`,
    });
    const request = await callTool<ContactRequestResult>(
      base,
      tokenA,
      'network_contact_request',
      { request_id: requestId('e2e_contact'), actor_id: b.actor_id },
    );
    const contactRequestId = request.request?.contact_request_id;
    if (!contactRequestId) throw new Error('好友申请未创建');
    await callTool(base, tokenB, 'network_contact_request_respond', {
      request_id: requestId('e2e_contact'),
      contact_request_id: contactRequestId,
      action: 'accept',
    });

    const rooms = await callTool<RoomList>(base, tokenA, 'network_rooms_list', { limit: 50 });
    const direct = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === b.actor_id,
    );
    if (!direct) throw new Error('好友通过后未生成 direct 会话');
    roomId = direct.room_id;

    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body: 'E2E 初始未读消息',
      invoke: [],
    });
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 浏览器禁用存储时由页面错误态兜底。
      }
    }, tokenA);
  });

  test('renders rooms, unread state, search and account', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${base}/`);
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#room-search')).toBeVisible();
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);
    await expect(page.locator('#room-list .room-name')).toHaveText(nameB);
    await expect(page.locator('#room-list .unread')).toHaveCount(1);
    await expect(page.locator('#account-name')).toHaveText(nameA);
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#composer')).toHaveCount(0);

    await page.fill('#room-search', '不存在的会话');
    await expect(page.locator('#room-list-status')).toHaveText('没有匹配的会话');
    await expect(page.locator('#room-list .room-item')).toHaveCount(0);
    await page.press('#room-search', 'Escape');
    await expect(page.locator('#room-search')).toHaveValue('');
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);

    expect(errors).toEqual([]);
  });

  test('stream notification refreshes the list without a reload', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);
    await page.evaluate(() => {
      window.sessionStorage.setItem('__homeMarker', '1');
    });

    const body = `E2E 实时消息 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body,
      invoke: [],
    });

    await expect(page.locator('#room-list .room-preview')).toContainText('E2E 实时消息', {
      timeout: 10_000,
    });
    expect(await page.evaluate(() => window.sessionStorage.getItem('__homeMarker'))).toBe('1');
  });

  test('clicking a room opens the chat page', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.locator(`#room-list a[href="/c/${roomId}"]`).click();
    await expect(page).toHaveURL(`${base}/c/${roomId}`);
    await expect(page.locator('body')).toHaveClass(/page-room/);
    await expect(page.locator('#composer')).toBeVisible();
  });

  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('home stays single column', async ({ page }) => {
      await page.goto(`${base}/`);
      await expect(page.locator('.sidebar')).toBeVisible();
      await expect(page.locator('#room-search')).toBeVisible();
      await expect(page.locator('#empty-state')).toBeHidden();
    });
  });

  test.describe('dark mode', () => {
    test.use({ colorScheme: 'dark' });

    test('reuses the dark sidebar tokens', async ({ page }) => {
      await page.goto(`${base}/`);
      await expect(page.locator('.sidebar')).toBeVisible();
      const background = await page
        .locator('.sidebar')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(background).toBe('rgb(43, 43, 43)');
      const chatBackground = await page
        .locator('.chat-pane')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(chatBackground).toBe('rgb(25, 25, 25)');
    });
  });
});
