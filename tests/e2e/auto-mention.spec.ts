import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LIMITS } from '../../src/contracts/limits';

/**
 * 人类群聊发送回归：自动 @、手动 @、选择器与 invoke 省略语义。
 *
 * 服务端由 Playwright globalSetup 隔离启动；页面请求经 instrumentFetch 记录，
 * 断言直接检查 `network_message_send` 是否携带 invoke，再用 Agent 收件箱
 * 与历史确认 delivery 是否真实建立。
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
            name: 'agent-network-auto-mention-e2e',
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

interface Actor {
  actor_id: string;
  name: string;
}

interface RoomCreated {
  room: { room_id: string };
}

interface HistoryPage {
  items: { message_id: string; preview: string }[];
}

interface InboxPage {
  items: { delivery_id: string; message_id: string }[];
}

interface SendCall {
  method: string | null;
  body: { params?: { name?: string; arguments?: Record<string, unknown> } } | null;
}

async function instrumentFetch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __mcpCalls?: SendCall[];
      fetch: typeof fetch;
    };
    target.__mcpCalls = [];
    const original = target.fetch.bind(window);
    target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      let body: SendCall['body'] = null;
      try {
        body = typeof init?.body === 'string' ? (JSON.parse(init.body) as SendCall['body']) : null;
      } catch {
        body = null;
      }
      target.__mcpCalls?.push({ method: body?.params?.name ?? null, body });
      return original(input, init);
    }) as typeof fetch;
  });
}

async function sendCallCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __mcpCalls?: SendCall[];
        }
      ).__mcpCalls?.filter((call) => call.method === 'network_message_send').length ?? 0,
  );
}

async function lastSendArgs(page: Page): Promise<Record<string, unknown>> {
  const args = await page.evaluate(() => {
    const calls = (
      window as unknown as {
        __mcpCalls?: SendCall[];
      }
    ).__mcpCalls ?? [];
    const send = calls.filter((call) => call.method === 'network_message_send').at(-1);
    return send?.body?.params?.arguments ?? null;
  });
  if (!args) throw new Error('页面没有发出 network_message_send');
  return args as Record<string, unknown>;
}

async function sendAndCapture(page: Page, body: string): Promise<Record<string, unknown>> {
  const before = await sendCallCount(page);
  await page.fill('#body', body);
  await page.locator('#send').click();
  await expect.poll(() => sendCallCount(page)).toBeGreaterThan(before);
  return lastSendArgs(page);
}

async function messageIdFor(
  base: string,
  token: string,
  roomId: string,
  marker: string,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = await callTool<HistoryPage>(base, token, 'network_history_list', {
      room_id: roomId,
      direction: 'before',
      limit: 50,
    });
    const found = page.items.find((item) => item.preview.includes(marker));
    if (found) return found.message_id;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error(`历史中未找到消息：${marker}`);
}

async function pendingDeliveryOrNull(
  base: string,
  token: string,
  messageId: string,
): Promise<string | null> {
  const inbox = await callTool<InboxPage>(base, token, 'network_inbox_list', {
    state: 'pending',
    limit: 50,
  });
  return inbox.items.find((item) => item.message_id === messageId)?.delivery_id ?? null;
}

test.describe('SPA human group auto mention', () => {
  let base = '';
  let humanToken = '';
  let human: Actor | null = null;
  let previous: { token: string; actor: Actor } | null = null;
  let other: { token: string; actor: Actor } | null = null;
  let maintainer: { token: string; actor: Actor } | null = null;
  let duplicateA: { token: string; actor: Actor } | null = null;
  let duplicateB: { token: string; actor: Actor } | null = null;
  let groupRoomId = '';
  let attachRoomId = '';
  let duplicateRoomId = '';
  let directRoomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    humanToken = crypto.randomUUID();
    const register = async (
      name: string,
    ): Promise<{ token: string; actor: Actor }> => {
      const token = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
      const actor = await callTool<Actor>(base, token, 'network_register', {
        request_id: requestId('e2e_reg'),
        kind: 'agent',
        name,
        agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
      });
      return { token, actor };
    };
    human = await callTool<Actor>(base, humanToken, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `自动提及人类 ${suffix}`,
      device_id: `e2e-auto-mention-${suffix}`,
    });
    previous = await register(`自动提及 Agent ${suffix}`);
    other = await register(`正文命中 Agent ${suffix}`);
    maintainer = await register('WeBots 维护员');
    duplicateA = await register(`重名 Agent ${suffix}`);
    duplicateB = await register(`重名 Agent ${suffix}`);

    const group = await callTool<RoomCreated>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_group'),
      kind: 'group',
      title: `自动提及群 ${suffix}`,
      members: [previous.actor.actor_id, other.actor.actor_id],
    });
    groupRoomId = group.room.room_id;

    const attachGroup = await callTool<RoomCreated>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_attach_group'),
      kind: 'group',
      title: `附件提及群 ${suffix}`,
      members: [maintainer.actor.actor_id],
    });
    attachRoomId = attachGroup.room.room_id;

    const duplicateGroup = await callTool<RoomCreated>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_duplicate_group'),
      kind: 'group',
      title: `重名提及群 ${suffix}`,
      members: [duplicateA.actor.actor_id, duplicateB.actor.actor_id],
    });
    duplicateRoomId = duplicateGroup.room.room_id;
    await callTool(base, duplicateA.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: duplicateRoomId,
      body: '重名上一楼',
      invoke: [],
    });
    await callTool(base, humanToken, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: attachRoomId,
      body: '附件群初始消息',
      invoke: [],
    });

    const contact = await callTool<{ request: { contact_request_id: string } | null }>(
      base,
      previous.token,
      'network_contact_request',
      { request_id: requestId('e2e_contact'), actor_id: human!.actor_id },
    );
    const contactRequestId = contact.request?.contact_request_id;
    if (!contactRequestId) throw new Error('自动提及 Agent 好友申请未创建');
    await callTool(base, humanToken, 'network_contact_request_respond', {
      request_id: requestId('e2e_contact'),
      contact_request_id: contactRequestId,
      action: 'accept',
    });

    const direct = await callTool<RoomCreated>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_direct'),
      kind: 'direct',
      members: [previous.actor.actor_id],
    });
    directRoomId = direct.room.room_id;  });

  test.beforeEach(async ({ page }) => {
    await instrumentFetch(page);
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 浏览器禁用存储时由页面错误态兜底。
      }
    }, humanToken);
  });

  test('plain group text mentions the previous Agent without invoke', async ({ page }) => {
    if (!previous) throw new Error('fixture 未初始化');
    await callTool(base, previous.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: '上一条 Agent 消息',
      invoke: [],
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: '上一条 Agent 消息' })).toBeVisible();

    const marker = `纯文本自动提及 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(`${marker}\n@${previous.actor.name}`);
    expect(Object.hasOwn(args, 'invoke')).toBe(false);

    const messageId = await messageIdFor(base, humanToken, groupRoomId, marker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, previous!.token, messageId))
      .not.toBeNull();
  });

  test('body member name wins over previous sender and still omits invoke', async ({ page }) => {
    if (!other) throw new Error('fixture 未初始化');
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: '上一条 Agent 消息' })).toBeVisible();

    const marker = `正文命中的名字 ${Date.now()}`;
    const text = `请 ${other.actor.name} 看一下 ${marker}`;
    const args = await sendAndCapture(page, text);
    expect(args.body).toBe(`${text}\n@${other.actor.name}`);
    expect(Object.hasOwn(args, 'invoke')).toBe(false);

    const messageId = await messageIdFor(base, humanToken, groupRoomId, marker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, other!.token, messageId))
      .not.toBeNull();
  });

  test('manually typed @ without selector omits invoke but creates delivery', async ({ page }) => {
    if (!previous) throw new Error('fixture 未初始化');
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#composer')).toBeVisible();

    const marker = `手打提及 ${Date.now()}`;
    const text = `请 @${previous.actor.name} 处理 ${marker}`;
    const args = await sendAndCapture(page, text);
    expect(args.body).toBe(text);
    expect(Object.hasOwn(args, 'invoke')).toBe(false);

    const messageId = await messageIdFor(base, humanToken, groupRoomId, marker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, previous!.token, messageId))
      .not.toBeNull();
  });

  test('selector target sends invoke explicitly and creates delivery', async ({ page }) => {
    if (!other) throw new Error('fixture 未初始化');
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#composer')).toBeVisible();

    await page.locator('#body').click();
    await page.keyboard.type('请 @');
    const picker = page.locator('#mention-picker');
    await expect(picker).toBeVisible();
    await picker.locator('.mention-item').filter({ hasText: other.actor.name }).click();

    const marker = `选择器提及 ${Date.now()}`;
    const before = await sendCallCount(page);
    await page.keyboard.type(marker);
    await page.locator('#send').click();
    await expect.poll(() => sendCallCount(page)).toBeGreaterThan(before);
    const args = await lastSendArgs(page);
    expect(args.invoke).toEqual([other.actor.actor_id]);
    expect(String(args.body)).toContain(`@${other.actor.name}`);
    expect(String(args.body)).toContain(marker);

    const messageId = await messageIdFor(base, humanToken, groupRoomId, marker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, other!.token, messageId))
      .not.toBeNull();
  });

  test('direct send fills invoke with the peer Agent', async ({ page }) => {
    if (!previous) throw new Error('fixture 未初始化');
    await page.goto(`${base}/c/${directRoomId}`);
    await expect(page.locator('#title')).toHaveText(previous.actor.name);

    const marker = `单聊直发 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(marker);
    expect(args.invoke).toEqual([previous.actor.actor_id]);

    const messageId = await messageIdFor(base, humanToken, directRoomId, marker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, previous!.token, messageId))
      .not.toBeNull();
  });

  test('second consecutive plain text does not mention self', async ({ page }) => {
    if (!previous) throw new Error('fixture 未初始化');
    await callTool(base, previous.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: '下一轮上一楼',
      invoke: [],
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: '下一轮上一楼' })).toBeVisible();

    const firstMarker = `连续第一条 ${Date.now()}`;
    const firstArgs = await sendAndCapture(page, firstMarker);
    expect(firstArgs.body).toBe(`${firstMarker}\n@${previous.actor.name}`);
    expect(Object.hasOwn(firstArgs, 'invoke')).toBe(false);
    await expect(
      page.locator('#messages .msg.mine').filter({ hasText: firstMarker }),
    ).toBeVisible();

    const secondMarker = `连续第二条 ${Date.now()}`;
    const secondArgs = await sendAndCapture(page, secondMarker);
    expect(secondArgs.body).toBe(secondMarker);
    expect(Object.hasOwn(secondArgs, 'invoke')).toBe(false);

    const secondId = await messageIdFor(base, humanToken, groupRoomId, secondMarker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, previous!.token, secondId))
      .toBeNull();
  });

  test('duplicate display names skip auto mention and delivery', async ({ page }) => {
    if (!duplicateA || !duplicateB) throw new Error('fixture 未初始化');
    await page.goto(`${base}/c/${duplicateRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: '重名上一楼' })).toBeVisible();

    const marker = `重名接一句 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(marker);
    expect(Object.hasOwn(args, 'invoke')).toBe(false);

    const messageId = await messageIdFor(base, humanToken, duplicateRoomId, marker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, duplicateA!.token, messageId))
      .toBeNull();
    await expect
      .poll(() => pendingDeliveryOrNull(base, duplicateB!.token, messageId))
      .toBeNull();
  });

  test('over-limit body skips auto mention and still sends', async ({ page }) => {
    if (!previous) throw new Error('fixture 未初始化');
    await callTool(base, previous.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: '长文前上一条',
      invoke: [],
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: '长文前上一条' })).toBeVisible();

    const marker = `长文 ${Date.now()} `;
    const longBody = marker + 'a'.repeat(LIMITS.messageBodyBytes - Buffer.byteLength(marker, 'utf8'));
    expect(Buffer.byteLength(longBody, 'utf8')).toBe(LIMITS.messageBodyBytes);
    const args = await sendAndCapture(page, longBody);
    expect(args.body).toBe(longBody);
    expect(Object.hasOwn(args, 'invoke')).toBe(false);

    const messageId = await messageIdFor(base, humanToken, groupRoomId, marker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, previous!.token, messageId))
      .toBeNull();
  });

  test('attachment without a target falls back to the exact maintainer', async ({ page }) => {
    if (!maintainer) throw new Error('fixture 未初始化');
    await page.goto(`${base}/c/${attachRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: '附件群初始消息' })).toBeVisible();

    await page.locator('#composer-file-input').setInputFiles({
      name: 'auto-mention.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('auto mention attachment'),
    });
    await expect(page.locator('#composer-files .composer-file')).toHaveCount(1);
    await expect(page.locator('#composer-files .composer-file-meta')).not.toContainText('上传中', {
      timeout: 15_000,
    });

    const marker = `附件兜底 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(Object.hasOwn(args, 'invoke')).toBe(false);
    expect(String(args.body)).toMatch(/\/f\//);
    expect(String(args.body)).toContain('@WeBots 维护员');

    const messageId = await messageIdFor(base, humanToken, attachRoomId, marker);
    await expect
      .poll(() => pendingDeliveryOrNull(base, maintainer!.token, messageId))
      .not.toBeNull();
  });
});
