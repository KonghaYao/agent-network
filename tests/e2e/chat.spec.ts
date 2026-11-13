import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-2 Chat e2e：需要 `WEB_SPA_ROUTES=home,room E2E_SPA=1`。
 *
 * 覆盖发送/接收、引用、附件、IME/Shift+Enter、1–4 行、移动端、暗色与
 * 单一 `subscriptions/listen`。服务端仍由 Playwright globalSetup 隔离启动。
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

interface RoomList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface HistoryPage {
  items: { preview: string; sender_id: string }[];
}

const SPA_ENABLED =
  process.env.E2E_SPA === '1' &&
  (process.env.WEB_SPA_ROUTES ?? '')
    .split(',')
    .map((value) => value.trim())
    .includes('room');

async function instrumentFetch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __mcpCalls?: {
        method: string | null;
        stream: boolean;
        body: unknown;
      }[];
      fetch: typeof fetch;
    };
    target.__mcpCalls = [];
    const original = target.fetch.bind(window);
    target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      let body: { method?: string } | null = null;
      try {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      } catch {
        body = null;
      }
      const method = body?.method ?? null;
      target.__mcpCalls?.push({ method, stream: method === 'subscriptions/listen', body });
      return original(input, init);
    }) as typeof fetch;
  });
}

async function waitForHistory(
  base: string,
  token: string,
  roomId: string,
  expected: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = await callTool<HistoryPage>(base, token, 'network_history_list', {
      room_id: roomId,
      direction: 'before',
      limit: 50,
    });
    if (page.items.some((item) => item.preview.includes(expected))) return;
    await new Promise((wait) => setTimeout(wait, 150));
  }
  throw new Error(`历史中未找到消息：${expected}`);
}

test.describe('SPA Chat', () => {
  test.skip(!SPA_ENABLED, '需要 WEB_SPA_ROUTES=home,room E2E_SPA=1 才运行 React Chat 用例');

  let base = '';
  let tokenA = '';
  let tokenB = '';
  let nameB = '';
  let roomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    tokenB = crypto.randomUUID();
    const nameA = `Chat A ${suffix}`;
    nameB = `Chat B ${suffix}`;

    await callTool<Registered>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameA,
      device_id: `e2e-chat-${suffix}-a`,
    });
    const b = await callTool<Registered>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameB,
      device_id: `e2e-chat-${suffix}-b`,
    });
    const contact = await callTool<ContactRequestResult>(base, tokenA, 'network_contact_request', {
      request_id: requestId('e2e_contact'),
      actor_id: b.actor_id,
    });
    const contactRequestId = contact.request?.contact_request_id;
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
      body: 'Chat E2E 初始消息',
      invoke: [],
    });
  });

  test.beforeEach(async ({ page }) => {
    await instrumentFetch(page);
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
        sessionStorage.setItem('__chatMarker', '1');
      } catch {
        // 浏览器禁用存储时由页面错误态兜底。
      }
    }, tokenA);
  });

  test('sends, receives, quotes and keeps one stream subscription', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
    await expect(page.locator('#title')).toHaveText(nameB);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('#messages .msg .bubble').first()).toContainText('Chat E2E 初始消息');
    await expect(page.locator('#jump-latest')).toBeHidden();

    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __mcpCalls?: { stream?: boolean }[];
            }
          ).__mcpCalls?.filter((call) => call.stream === true).length ?? 0,
      ),
    ).toBe(1);

    const sent = `E2E 发送 ${Date.now()}`;
    await page.fill('#body', sent);
    await page.press('#body', 'Enter');
    await expect(page.locator('#messages .msg.mine .bubble').last()).toContainText(sent, {
      timeout: 10_000,
    });
    await waitForHistory(base, tokenB, roomId, sent);

    const received = `E2E 接收 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body: received,
      invoke: [],
    });
    await expect(page.locator('#messages .msg .bubble').last()).toContainText(received, {
      timeout: 10_000,
    });
    expect(await page.evaluate(() => sessionStorage.getItem('__chatMarker'))).toBe('1');

    await page
      .locator('#messages .msg:not(.mine)')
      .first()
      .locator('.message-actions-trigger')
      .click();
    await page.getByRole('menuitem', { name: '引用' }).click();
    await expect(page.locator('#composer-reply')).toBeVisible();
    await expect(page.locator('#composer-reply')).toContainText('Chat E2E 初始消息');

    const quoted = `E2E 引用 ${Date.now()}`;
    await page.fill('#body', quoted);
    await page.press('#body', 'Enter');
    await expect(page.locator('#messages .msg.mine .reply-reference').last()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('#messages .msg.mine .reply-reference').last()).toContainText(
      'Chat E2E 初始消息',
    );
    const hasReplyTo = await page.evaluate(() => {
      const calls = (
        window as unknown as {
          __mcpCalls?: {
            method?: string;
            body?: {
              params?: { name?: string; arguments?: Record<string, unknown> };
            };
          }[];
        }
      ).__mcpCalls ?? [];
      const args = calls
        .filter((call) => call.body?.params?.name === 'network_message_send')
        .map((call) => call.body?.params?.arguments)
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .at(-1);
      return typeof args?.reply_to === 'string' && args.reply_to.length > 0;
    });
    expect(hasReplyTo).toBe(true);
  });

  test('keeps IME Enter, Shift+Enter and 1–4 line composer behavior', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    const before = await page.locator('#messages .msg.mine').count();

    await page.locator('#body').click();
    await page.evaluate(() => {
      document
        .getElementById('body')
        ?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.keyboard.type('组合输入');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    expect(await page.locator('#messages .msg.mine').count()).toBe(before);
    await expect(page.locator('#body')).toHaveValue(/组合输入/);

    // 组合结束后的 80ms 守卫：合成 keydown 与 compositionend 在同一任务内。
    await page.evaluate(() => {
      const element = document.getElementById('body');
      if (!element) return;
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.waitForTimeout(150);
    expect(await page.locator('#messages .msg.mine').count()).toBe(before);

    await page.press('#body', 'Shift+Enter');
    expect(await page.locator('#body').inputValue()).toContain('\n');
    const height = await page.locator('#body').evaluate((element) => ({
      client: element.clientHeight,
      scroll: element.scrollHeight,
    }));
    expect(height.client).toBeLessThanOrEqual(96);
    expect(height.client).toBeGreaterThanOrEqual(38);

    await page.fill('#body', '');
    await page.fill('#body', Array.from({ length: 6 }, () => '长输入').join('\n'));
    const grown = await page.locator('#body').evaluate((element) => ({
      client: element.clientHeight,
      scroll: element.scrollHeight,
    }));
    expect(grown.client).toBeLessThanOrEqual(96);
    expect(grown.scroll).toBeGreaterThan(grown.client);

    await page.fill('#body', 'E2E IME 发送');
    await page.press('#body', 'Enter');
    await expect(page.locator('#messages .msg.mine .bubble').last()).toContainText('E2E IME 发送', {
      timeout: 10_000,
    });
  });

  test('uploads an attachment and sends its public link', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await page.locator('#composer-file-input').setInputFiles({
      name: 'e2e-note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('chat attachment'),
    });
    await expect(page.locator('#composer-files .composer-file')).toHaveCount(1);
    await expect(page.locator('#composer-files .composer-file-meta')).not.toContainText('上传中', {
      timeout: 15_000,
    });
    await page.fill('#body', 'E2E 附件发送');
    await page.press('#body', 'Enter');
    await expect(page.locator('#messages .msg.mine .msg-files .msg-file').last()).toBeVisible({
      timeout: 10_000,
    });
    const body = await page.evaluate(() => {
      const calls = (
        window as unknown as {
          __mcpCalls?: {
            method?: string;
            body?: {
              params?: { name?: string; arguments?: Record<string, unknown> };
            };
          }[];
        }
      ).__mcpCalls ?? [];
      const args = calls
        .filter((call) => call.body?.params?.name === 'network_message_send')
        .map((call) => call.body?.params?.arguments)
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .at(-1);
      return typeof args?.body === 'string' ? args.body : '';
    });
    expect(body).toMatch(/\/f\//);
  });

  test('loads older history with the cursor pager', async ({ page }) => {
    for (let index = 0; index < 51; index += 1) {
      await callTool(base, tokenB, 'network_message_send', {
        request_id: requestId('e2e_send'),
        client_message_id: requestId('e2e_cm'),
        room_id: roomId,
        body: `E2E 历史 ${index}`,
        invoke: [],
      });
    }
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('#history-pager')).toBeVisible();
    const firstPage = await page.locator('#messages .msg').count();
    expect(firstPage).toBeGreaterThanOrEqual(50);
    await page.locator('#older').click();
    await expect.poll(() => page.locator('#messages .msg').count()).toBeGreaterThan(firstPage);
    await expect(page.locator('#older-status')).toContainText('已经到最早的消息了');
  });

  test('desktop back returns to the home shell', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#back')).toBeVisible();
    await page.locator('#back').click();
    await expect(page).toHaveURL(`${base}/`);
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expect(page.locator('#room-list')).toBeVisible();
  });

  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('chat stays single column with a back affordance', async ({ page }) => {
      await page.goto(`${base}/c/${roomId}`);
      await expect(page.locator('.chat-pane')).toBeVisible();
      await expect(page.locator('.sidebar')).toHaveCount(0);
      await expect(page.locator('#back')).toBeVisible();
      await expect(page.locator('#composer')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });

  test.describe('dark mode', () => {
    test.use({ colorScheme: 'dark' });

    test('reuses the dark chat tokens', async ({ page }) => {
      await page.goto(`${base}/c/${roomId}`);
      await expect(page.locator('.chat-pane')).toBeVisible();
      const background = await page
        .locator('.chat-pane')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(background).toBe('rgb(25, 25, 25)');
      const head = await page
        .locator('.chat-head')
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(head).toBe('rgb(43, 43, 43)');
    });
  });
});
