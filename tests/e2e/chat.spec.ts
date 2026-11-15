import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-6 Chat e2e：五条页面路由始终由 React 渲染。
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

interface RoomDetail {
  room: { room_id: string };
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface HistoryPage {
  items: { preview: string; sender_id: string }[];
}

async function instrumentFetch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __mcpCalls?: {
        method: string | null;
        stream: boolean;
        body: unknown;
      }[];
      /** 首次 ack 被页面消费的时刻（浏览器时钟），用于快/慢握手断言。 */
      __streamAckAt?: number;
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
      const response = await original(input, init);
      if (method === 'subscriptions/listen') {
        // 只旁路观察 ack，不改变页面自己读取的 SSE 流。
        try {
          const clone = response.clone();
          void (async () => {
            try {
              const reader = clone.body?.getReader();
              if (!reader) return;
              const decoder = new TextDecoder();
              let text = '';
              for (;;) {
                const step = await reader.read();
                if (step.done) return;
                text += decoder.decode(step.value, { stream: true });
                if (text.includes('notifications/subscriptions/acknowledged')) {
                  target.__streamAckAt = Date.now();
                  await reader.cancel().catch(() => undefined);
                  return;
                }
                if (text.length > 16_384) text = text.slice(-2048);
              }
            } catch {
              // 页面关闭或流被取消时忽略。
            }
          })();
        } catch {
          // clone 失败不能影响页面自身读取。
        }
      }
      return response;
    }) as typeof fetch;
  });
}

async function waitForStreamAck(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __streamAckAt?: number }).__streamAckAt === 'number',
    undefined,
    { timeout },
  );
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

async function countHistoryWithoutCursor(
  page: Page,
  roomId: string,
): Promise<number> {
  return page.evaluate((targetRoom) => {
    const calls =
      (
        window as unknown as {
          __mcpCalls?: { body?: { params?: { name?: string; arguments?: { room_id?: string; cursor?: string } } } }[];
        }
      ).__mcpCalls ?? [];
    return calls.filter((call) => {
      const params = call.body?.params;
      return (
        params?.name === 'network_history_list' &&
        params.arguments?.room_id === targetRoom &&
        !params.arguments?.cursor
      );
    }).length;
  }, roomId);
}

async function countRoomCalls(page: Page, name: string, roomId: string): Promise<number> {
  return page.evaluate(
    ({ targetName, targetRoom }) => {
      const calls =
        (
          window as unknown as {
            __mcpCalls?: { body?: { params?: { name?: string; arguments?: { room_id?: string } } } }[];
          }
        ).__mcpCalls ?? [];
      return calls.filter((call) => {
        const params = call.body?.params;
        return params?.name === targetName && params.arguments?.room_id === targetRoom;
      }).length;
    },
    { targetName: name, targetRoom: roomId },
  );
}

async function countToolCalls(page: Page, name: string): Promise<number> {
  return page.evaluate((targetName) => {
    const calls =
      (
        window as unknown as {
          __mcpCalls?: { body?: { params?: { name?: string } } }[];
        }
      ).__mcpCalls ?? [];
    return calls.filter((call) => call.body?.params?.name === targetName).length;
  }, name);
}

/** 延迟首屏 room/history，让骨架与静态输入区停留到断言结束。 */
async function holdFirstLoad(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/mcp', async (route) => {
    let body: { params?: { name?: string } } | null = null;
    try {
      body = JSON.parse(route.request().postData() ?? 'null');
    } catch {
      body = null;
    }
    const name = body?.params?.name;
    if (name === 'network_room_get' || name === 'network_history_list') await gate;
    await route.continue();
  });
  return release;
}

/** 只统计聊天区内的位移，侧栏/文件栏加载不计入。 */
async function trackChatLayoutShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shifts: number[] = [];
    (window as unknown as { __chatShifts?: number[] }).__chatShifts = shifts;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        hadRecentInput: boolean;
        value: number;
        sources: { node: Node | null }[];
      }[]) {
        if (entry.hadRecentInput) continue;
        if (
          entry.sources.some((source) =>
            (source.node as Element | null)?.closest?.('.chat-pane'),
          )
        ) {
          shifts.push(entry.value);
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

async function chatShiftSum(page: Page): Promise<number> {
  return page.evaluate(() =>
    ((window as unknown as { __chatShifts?: number[] }).__chatShifts ?? []).reduce(
      (sum, value) => sum + value,
      0,
    ),
  );
}

async function chatHeadHeight(page: Page): Promise<number> {
  return page.locator('.chat-head').evaluate((element) => element.getBoundingClientRect().height);
}

/** 移动端首载头部：原始像素比较，不取整；同时覆盖骨架与静态输入区。 */
async function expectStableMobileFirstLoad(
  page: Page,
  base: string,
  room: string,
): Promise<void> {
  await trackChatLayoutShifts(page);
  const release = await holdFirstLoad(page);
  let loadingHeight = 0;
  let loadingComposer = 0;
  try {
    await page.goto(`${base}/c/${room}`);
    await expect(page.locator('#chat-skeleton')).toBeVisible();
    await expect(page.locator('#composer')).toBeVisible();
    loadingHeight = await chatHeadHeight(page);
    loadingComposer = await page
      .locator('#composer')
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  } finally {
    release();
  }

  await expect(page.locator('#messages .msg .bubble').first()).toBeVisible();
  const loadedHeight = await chatHeadHeight(page);
  const loadedComposer = await page
    .locator('#composer')
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.abs(loadedHeight - loadingHeight)).toBeLessThanOrEqual(4);
  expect(Math.abs(loadedComposer - loadingComposer)).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);

  await page.waitForTimeout(400);
  expect(await chatShiftSum(page)).toBeLessThan(0.01);
}

test.describe('SPA Chat', () => {

  let base = '';
  let tokenA = '';
  let tokenB = '';
  let nameB = '';
  let roomId = '';
  let otherRoomId = '';
  let agentRoomId = '';

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
    const other = await callTool<RoomDetail>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_room'),
      kind: 'group',
      title: 'Chat E2E 其他房间',
      members: [b.actor_id],
    });
    otherRoomId = other.room.room_id;
    await callTool(base, tokenA, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: otherRoomId,
      body: 'Chat E2E 群聊初始消息',
      invoke: [],
    });
    const agent = await callTool<{ actor_id: string }>(base, tokenA, 'network_agent_create', {
      request_id: requestId('e2e_agent'),
      name: `Chat E2E Agent ${suffix}`,
    });
    const agentRoom = await callTool<RoomDetail>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_agent_room'),
      kind: 'direct',
      members: [agent.actor_id],
    });
    agentRoomId = agentRoom.room.room_id;
    await callTool(base, tokenA, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: agentRoomId,
      body: 'Chat E2E Agent 初始消息',
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

  test('first load reserves the chat shell without layout shift', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await trackChatLayoutShifts(page);
    const release = await holdFirstLoad(page);
    try {
      await page.goto(`${base}/c/${roomId}`);

      await expect(page.locator('#chat-skeleton')).toBeVisible();
      await expect(page.locator('#chat-skeleton .skeleton-row')).toHaveCount(3);
      await expect(page.locator('#composer')).toBeVisible();
      await expect(page.locator('#body')).toBeDisabled();
      await expect(page.locator('#send')).toBeDisabled();

      const skeletonHeight = await page
        .locator('#chat-skeleton')
        .evaluate((element) => Math.round(element.getBoundingClientRect().height));
      expect(skeletonHeight).toBeGreaterThan(200);
      expect(await chatHeadHeight(page)).toBeGreaterThan(40);
    } finally {
      release();
    }

    await expect(page.locator('#chat-skeleton')).toHaveCount(0);
    await expect(page.locator('#body')).toBeEnabled();
    await expect(page.locator('#messages .msg .bubble').first()).toContainText(
      'Chat E2E 初始消息',
    );
    await page.waitForTimeout(400);
    expect(await chatShiftSum(page)).toBeLessThan(0.01);

    // 首屏请求不因骨架/静态输入区增加：history 1–2 次，rooms_list 1 次。
    expect(await countHistoryWithoutCursor(page, roomId)).toBeGreaterThanOrEqual(1);
    expect(await countHistoryWithoutCursor(page, roomId)).toBeLessThanOrEqual(2);
    expect(await countToolCalls(page, 'network_history_list')).toBeLessThanOrEqual(2);
    expect(await countToolCalls(page, 'network_rooms_list')).toBe(1);
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

  test('scopes stream invalidation to the current room', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#messages .msg .bubble').first()).toContainText('Chat E2E 初始消息');
    // 首次 ack 晚于 history 请求发起时允许补拉一次；等补拉落定后再取基线。
    await page.waitForTimeout(1_200);
    const firstHistory = await countHistoryWithoutCursor(page, roomId);
    expect(firstHistory).toBeGreaterThanOrEqual(1);
    expect(firstHistory).toBeLessThanOrEqual(2);
    const firstRoomGet = await countRoomCalls(page, 'network_room_get', roomId);
    expect(firstRoomGet).toBeGreaterThanOrEqual(1);
    expect(firstRoomGet).toBeLessThanOrEqual(2);
    await page.waitForTimeout(600);
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(firstHistory);
    expect(await countRoomCalls(page, 'network_room_get', roomId)).toBe(firstRoomGet);

    // 其他房间是群聊；切到群聊分类后侧栏才渲染它。
    await page.locator('#room-filter-group').click();
    const otherItem = page.locator(
      `#room-list a.room-item[href="/c/${encodeURIComponent(otherRoomId)}"]`,
    );
    await expect(otherItem).toBeVisible();

    const otherMarker = `E2E 其他房间 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: otherRoomId,
      body: otherMarker,
      invoke: [],
    });
    await expect(otherItem).toContainText(otherMarker, { timeout: 15_000 });
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(firstHistory);
    expect(await countRoomCalls(page, 'network_room_get', roomId)).toBe(firstRoomGet);

    const currentMarker = `E2E 当前房间 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body: currentMarker,
      invoke: [],
    });
    await expect(page.locator('#messages .msg .bubble').last()).toContainText(currentMarker, {
      timeout: 15_000,
    });
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(firstHistory + 1);
  });

  test('catches up current room when the first stream ack lags behind history', async ({ page }) => {
    let releaseStream: () => void = () => undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let markStreamHeld: () => void = () => undefined;
    const streamHeld = new Promise<void>((resolve) => {
      markStreamHeld = resolve;
    });
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-method'] === 'subscriptions/listen') {
        markStreamHeld();
        await streamGate;
      }
      await route.continue();
    });

    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#messages .msg .bubble').first()).toContainText('Chat E2E 初始消息');
    await streamHeld;
    await page.waitForTimeout(400);
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(1);

    const marker = `E2E 握手窗口 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body: marker,
      invoke: [],
    });
    await waitForHistory(base, tokenB, roomId, marker);
    // 订阅尚未建立，服务端不重放握手窗口内的事件：页面此刻看不到消息。
    await expect(page.locator('#messages .msg .bubble', { hasText: marker })).toHaveCount(0);

    releaseStream();
    // 首次 ack 补拉一次即可看到消息，无需第二条消息事件。
    await expect(page.locator('#messages .msg .bubble', { hasText: marker })).toHaveCount(1, {
      timeout: 10_000,
    });
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(2);

    // 只补一次，不形成循环，也不重建订阅。
    await page.waitForTimeout(1_200);
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(2);
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
  });

  test('catches up when ack arrives while the first history response is suspended', async ({ page }) => {
    let releaseHistory: () => void = () => undefined;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let markHistoryHeld: () => void = () => undefined;
    const historyHeld = new Promise<void>((resolve) => {
      markHistoryHeld = resolve;
    });
    let releaseStream: () => void = () => undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let markStreamHeld: () => void = () => undefined;
    const streamHeld = new Promise<void>((resolve) => {
      markStreamHeld = resolve;
    });

    let heldHistory = false;
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      if (request.headers()['mcp-method'] === 'subscriptions/listen') {
        markStreamHeld();
        await streamGate;
        await route.continue().catch(() => undefined);
        return;
      }
      if (
        !heldHistory &&
        request.headers()['mcp-name'] === 'network_history_list' &&
        !(request.postData() ?? '').includes('"cursor"')
      ) {
        heldHistory = true;
        // 先让服务端读取快照，再挂起响应：复现“快照早于 ack、响应晚于 ack”。
        const response = await route.fetch();
        markHistoryHeld();
        await historyGate;
        await route.fulfill({ response }).catch(() => undefined);
        return;
      }
      await route.continue();
    });

    await page.goto(`${base}/c/${roomId}`);
    await historyHeld;
    await streamHeld;

    const marker = `E2E 响应晚于 ack ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body: marker,
      invoke: [],
    });
    await waitForHistory(base, tokenB, roomId, marker);
    // 订阅尚未建立、首屏响应仍被挂起：页面此刻看不到消息。
    await expect(page.locator('#messages .msg .bubble', { hasText: marker })).toHaveCount(0);

    releaseStream();
    await waitForStreamAck(page);
    // 先释放 history 响应：它的完成时刻晚于 ack，但快照早于握手窗口。
    releaseHistory();
    await expect(page.locator('#messages .msg .bubble', { hasText: marker })).toHaveCount(1, {
      timeout: 10_000,
    });
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(2);

    // 只补一次，不形成循环，也不重建订阅。
    await page.waitForTimeout(1_200);
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(2);
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
  });

  test('keeps one first-page read when the ack predates the history request', async ({ page }) => {
    // 正常加载顺序中 history 先发起、ack 后到，必然保守补拉；该用例把页面
    // 时钟固定后再回拨，模拟 ack 时间戳早于请求发起的分支，验证不补拉。
    await page.clock.setFixedTime(new Date('2026-11-13T12:00:00Z'));
    let releaseStream: () => void = () => undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let markStreamHeld: () => void = () => undefined;
    const streamHeld = new Promise<void>((resolve) => {
      markStreamHeld = resolve;
    });
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-method'] === 'subscriptions/listen') {
        markStreamHeld();
        await streamGate;
      }
      await route.continue();
    });

    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#messages .msg .bubble').first()).toContainText('Chat E2E 初始消息');
    await streamHeld;
    // ack 在回拨后的时钟到达，早于 history 请求发起时刻。
    await page.clock.setFixedTime(new Date('2026-11-13T11:59:00Z'));
    releaseStream();
    await waitForStreamAck(page);
    await page.waitForTimeout(1_200);
    expect(await countHistoryWithoutCursor(page, roomId)).toBe(1);
    expect(await countRoomCalls(page, 'network_room_get', roomId)).toBe(1);
  });

  test('keeps IME Enter, Shift+Enter and 1–4 line composer behavior', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    // 静态 composer 在首载时即可见，历史快照要等真实输入区启用后再计数。
    await expect(page.locator('#body')).toBeEnabled();
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

  test.describe('desktop', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('keeps the conversation sidebar and hides the back affordance', async ({ page }) => {
      await page.goto(`${base}/c/${roomId}`);
      await expect(page.locator('.chat-pane')).toBeVisible();
      const sidebar = page.locator('.sidebar');
      await expect(sidebar).toBeVisible();
      const width = (await sidebar.boundingBox())?.width ?? 0;
      expect(width).toBeGreaterThanOrEqual(280);
      expect(width).toBeLessThanOrEqual(322);
      await expect(page.locator('#room-list')).toBeVisible();
      await expect(page.locator('#back')).toBeHidden();
      await expect(page.locator('#composer')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
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

    test('first load keeps the direct human header height stable without overflow', async ({
      page,
    }) => {
      await expectStableMobileFirstLoad(page, base, roomId);
    });

    test('first load keeps the group header height stable without overflow', async ({ page }) => {
      await expectStableMobileFirstLoad(page, base, otherRoomId);
    });

    test('first load keeps the direct agent header height stable without overflow', async ({
      page,
    }) => {
      await expectStableMobileFirstLoad(page, base, agentRoomId);
    });

    test('error state drops the skeleton and static composer', async ({ page }) => {
      await page.goto(`${base}/c/room_missing_e2e`);
      await expect(page.locator('#chat-error')).toBeVisible();
      await expect(page.locator('#chat-skeleton')).toHaveCount(0);
      await expect(page.locator('#composer')).toHaveCount(0);
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
