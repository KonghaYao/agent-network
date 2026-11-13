import { expect, test, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LIMITS } from '../../src/contracts/limits';

/**
 * 分页竞态与“加载更早”阈值回归。
 *
 * - 无 cursor 的最新页刷新与 cursor 翻页并发时，两者都必须并入当时缓存；
 * - 自动加载阈值以可滚动范围（scrollHeight - clientHeight）为基准；
 * - 不可滚动与重复 cursor 都必须停止请求。
 *
 * 竞态用 `page.route` 精确挂起一个方向的请求，另一端通过真实 MCP 调用完成，
 * 不依赖 sleep 猜时序。
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

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface RoomsList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface HistoryPage {
  items?: { message_id: string }[];
  timeline_items?: { message_id?: string; kind?: string }[];
  timeline_has_more?: boolean;
  timeline_next_cursor?: string | null;
}

interface HistoryCall {
  room_id?: string;
  cursor?: string;
  direction?: string;
  limit?: number;
}

async function instrumentFetch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __mcpCalls?: { method: string | null; stream: boolean; body: unknown }[];
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

async function registerHuman(
  base: string,
  name: string,
  device: string,
): Promise<{ token: string; actor: Registered }> {
  const token = crypto.randomUUID();
  const actor = await callTool<Registered>(base, token, 'network_register', {
    request_id: requestId('e2e_reg'),
    kind: 'human',
    name,
    device_id: device,
  });
  return { token, actor };
}

async function befriend(
  base: string,
  fromToken: string,
  peer: Registered,
  peerToken: string,
): Promise<string> {
  const contact = await callTool<ContactRequestResult>(base, fromToken, 'network_contact_request', {
    request_id: requestId('e2e_contact'),
    actor_id: peer.actor_id,
  });
  const contactRequestId = contact.request?.contact_request_id;
  if (!contactRequestId) throw new Error('好友申请未创建');
  await callTool(base, peerToken, 'network_contact_request_respond', {
    request_id: requestId('e2e_contact'),
    contact_request_id: contactRequestId,
    action: 'accept',
  });
  const rooms = await callTool<RoomsList>(base, fromToken, 'network_rooms_list', { limit: 50 });
  const direct = rooms.items.find(
    (room) => room.kind === 'direct' && room.peer?.actor_id === peer.actor_id,
  );
  if (!direct) throw new Error('好友通过后未生成 direct 会话');
  return direct.room_id;
}

async function seedMessages(
  base: string,
  token: string,
  roomId: string,
  count: number,
  prefix: string,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await callTool(base, token, 'network_message_send', {
      request_id: requestId('e2e_seed'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      invoke: [],
      body: `${prefix} ${String(index).padStart(3, '0')}`,
    });
  }
}

async function messageIds(page: Page): Promise<string[]> {
  return page.$$eval('#messages .msg[data-message-id]', (nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.messageId ?? ''),
  );
}

async function messageCount(page: Page): Promise<number> {
  return (await messageIds(page)).length;
}

/** 只统计 cursor 翻页；首屏/刷新（无 cursor）不计。 */
async function cursorCalls(page: Page): Promise<HistoryCall[]> {
  return page.evaluate(() => {
    const calls =
      (
        window as unknown as {
          __mcpCalls?: { body?: { method?: string; params?: { name?: string; arguments?: HistoryCall } } }[];
        }
      ).__mcpCalls ?? [];
    return calls
      .filter(
        (call) =>
          call.body?.method === 'tools/call' &&
          call.body?.params?.name === 'network_history_list',
      )
      .map((call) => call.body?.params?.arguments)
      .filter(
        (args): args is HistoryCall =>
          Boolean(args && typeof args.cursor === 'string' && args.direction !== 'after'),
      );
  });
}

interface VisibleAnchor {
  id: string;
  top: number;
}

async function firstVisibleAnchor(page: Page): Promise<VisibleAnchor | null> {
  return page.evaluate(() => {
    const list = document.getElementById('messages');
    if (!list) return null;
    const top = list.getBoundingClientRect().top;
    const node = Array.from(list.querySelectorAll('.msg[data-message-id]')).find(
      (element) => element.getBoundingClientRect().bottom > top + 1,
    );
    if (!node) return null;
    return {
      id: (node as HTMLElement).dataset.messageId ?? '',
      top: node.getBoundingClientRect().top,
    };
  });
}

async function setScrollTop(page: Page, top: number): Promise<void> {
  await page.$eval('#messages', (element, value) => {
    element.scrollTop = value;
  }, top);
}

async function scrollRange(page: Page): Promise<number> {
  return page.$eval('#messages', (element) => element.scrollHeight - element.clientHeight);
}

async function openRoom(page: Page, roomId: string): Promise<void> {
  const origin = await baseUrl();
  await page.goto(`${origin}/c/${roomId}`);
  await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
  await expect(page.locator('#messages .msg[data-message-id]')).toHaveCount(
    LIMITS.historyPageDefault,
    { timeout: 20_000 },
  );
}

function historyTool(route: Route): HistoryCall | null {
  const request = route.request();
  if (request.headers()['mcp-name'] !== 'network_history_list') return null;
  const body = request.postDataJSON() as {
    id?: string;
    params?: { arguments?: HistoryCall };
  } | null;
  return body?.params?.arguments ?? null;
}

async function responseNextCursor(route: Route): Promise<string | null> {
  const response = await route.fetch();
  const payload = (await response.json()) as {
    result?: { structuredContent?: { timeline_next_cursor?: string | null } };
  };
  const next = payload.result?.structuredContent?.timeline_next_cursor ?? null;
  await route.fulfill({ response, json: payload });
  return next;
}

test.describe.configure({ timeout: 120_000 });

test.describe('SPA pagination races', () => {
  let base = '';
  let tokenA = '';
  let tokenB = '';
  let tokenC = '';
  let mainRoomId = '';
  let shortRoomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const a = await registerHuman(base, `分页 A ${suffix}`, `e2e-page-${suffix}-a`);
    tokenA = a.token;
    const b = await registerHuman(base, `分页 B ${suffix}`, `e2e-page-${suffix}-b`);
    tokenB = b.token;
    const c = await registerHuman(base, `分页 C ${suffix}`, `e2e-page-${suffix}-c`);
    tokenC = c.token;

    mainRoomId = await befriend(base, tokenA, b.actor, tokenB);
    shortRoomId = await befriend(base, tokenA, c.actor, tokenC);
    await seedMessages(base, tokenB, mainRoomId, 150, '分页主会话');
    await seedMessages(base, tokenC, shortRoomId, 51, '分页短会话');
  });

  test.beforeEach(async ({ page }) => {
    await instrumentFetch(page);
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 浏览器禁用存储时由页面错误态兜底。
      }
    }, tokenA);
  });

  test('keeps loaded older pages when a refresh resolves late', async ({ page }) => {
    await openRoom(page, mainRoomId);
    // 让首屏请求与 stream 握手先完成，避免把初始重读误当成刷新。
    await page.waitForTimeout(500);

    let releaseRefresh: (() => void) | null = null;
    let refreshStarted = false;
    let refreshFinished = false;
    let heldRefresh = false;
    let firstCursor: string | null = null;
    let firstNextCursor: string | null = null;

    await page.route('**/mcp', async (route) => {
      const args = historyTool(route);
      if (!args || args.room_id !== mainRoomId) {
        await route.continue();
        return;
      }
      if (!args.cursor) {
        if (heldRefresh) {
          await route.continue();
          return;
        }
        heldRefresh = true;
        refreshStarted = true;
        await new Promise<void>((release) => {
          releaseRefresh = release;
        });
        const response = await route.fetch();
        const payload = (await response.json()) as unknown;
        await route.fulfill({ response, json: payload });
        refreshFinished = true;
        return;
      }
      if (firstCursor) {
        await route.continue();
        return;
      }
      firstCursor = args.cursor;
      firstNextCursor = await responseNextCursor(route);
    });

    // 1) 让一次真实刷新进入等待：B 发消息 → SSE → 无 cursor 重读。
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_race'),
      client_message_id: crypto.randomUUID(),
      room_id: mainRoomId,
      invoke: [],
      body: '分页并发刷新消息',
    });
    await expect.poll(() => refreshStarted, { timeout: 10_000 }).toBe(true);

    // 2) 刷新挂起期间把 older 加载到 100 条。
    await setScrollTop(page, 0);
    await expect.poll(() => messageCount(page), { timeout: 20_000 }).toBe(100);
    await page.waitForTimeout(150);
    const anchorBefore = await firstVisibleAnchor(page);
    expect(anchorBefore).not.toBeNull();

    // 3) 释放刷新：必须并入当时的缓存，而不是覆盖。
    releaseRefresh!();
    await expect.poll(() => refreshFinished, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => messageCount(page), { timeout: 10_000 }).toBe(101);

    const mergedIds = await messageIds(page);
    expect(new Set(mergedIds).size).toBe(mergedIds.length);
    const anchorAfter = await firstVisibleAnchor(page);
    expect(anchorAfter?.id).toBe(anchorBefore?.id);
    expect(Math.abs((anchorAfter?.top ?? 0) - (anchorBefore?.top ?? 0))).toBeLessThanOrEqual(4);

    // olderLoaded 未被重置，nextOlder 未回退。
    await expect(page.locator('#older')).toBeEnabled();
    await expect(page.locator('#older-status')).toHaveText('');
    await setScrollTop(page, 0);
    await expect.poll(() => messageCount(page), { timeout: 20_000 }).toBe(151);
    const cursors = (await cursorCalls(page)).map((call) => call.cursor);
    expect(cursors).toEqual([firstCursor, firstNextCursor]);
    const finalIds = await messageIds(page);
    expect(new Set(finalIds).size).toBe(finalIds.length);
  });

  test('auto-loads older only at 10% of the scrollable range', async ({ page }) => {
    await openRoom(page, mainRoomId);
    const range = await scrollRange(page);
    expect(range).toBeGreaterThan(0);
    const ratio = LIMITS.webOlderAutoTopRatio;

    for (const percent of [20, 50, 80]) {
      await setScrollTop(page, Math.floor(range * (percent / 100)));
      await page.waitForTimeout(300);
      expect(await cursorCalls(page), `${percent}% 不应触发加载更早`).toHaveLength(0);
    }

    await setScrollTop(page, Math.floor(range * ratio));
    await expect
      .poll(async () => (await cursorCalls(page)).length, { timeout: 5_000 })
      .toBe(1);
    await expect.poll(() => messageCount(page), { timeout: 20_000 }).toBeGreaterThan(
      LIMITS.historyPageDefault,
    );
    // 加载后的锚点恢复不应落回阈值内，短列表也不能重复请求。
    await page.waitForTimeout(800);
    expect((await cursorCalls(page)).length).toBe(1);
    expect(await scrollRange(page)).toBeGreaterThan(0);
  });

  test('keeps older pages when the refresh commits before the older page', async ({ page }) => {
    await openRoom(page, mainRoomId);
    await page.waitForTimeout(500);

    let releaseOlder: (() => void) | null = null;
    let olderStarted = false;
    let heldOlder = false;
    let firstCursor: string | null = null;
    let firstNextCursor: string | null = null;

    await page.route('**/mcp', async (route) => {
      const args = historyTool(route);
      if (!args || args.room_id !== mainRoomId || !args.cursor || heldOlder) {
        await route.continue();
        return;
      }
      heldOlder = true;
      olderStarted = true;
      firstCursor = args.cursor;
      await new Promise<void>((release) => {
        releaseOlder = release;
      });
      firstNextCursor = await responseNextCursor(route);
    });

    await setScrollTop(page, 0);
    await expect.poll(() => olderStarted, { timeout: 10_000 }).toBe(true);

    // 刷新先完成：50 → 51，而 older 仍挂起。
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_race'),
      client_message_id: crypto.randomUUID(),
      room_id: mainRoomId,
      invoke: [],
      body: '分页反方向并发消息',
    });
    await expect.poll(() => messageCount(page), { timeout: 20_000 }).toBe(51);

    releaseOlder!();
    await expect.poll(() => messageCount(page), { timeout: 20_000 }).toBe(101);
    const mergedIds = await messageIds(page);
    expect(new Set(mergedIds).size).toBe(mergedIds.length);
    await expect(page.locator('#older')).toBeEnabled();

    await setScrollTop(page, 0);
    await expect.poll(() => messageCount(page), { timeout: 20_000 }).toBeGreaterThan(101);
    const cursors = (await cursorCalls(page)).map((call) => call.cursor);
    expect(cursors[0]).toBe(firstCursor);
    expect(cursors[1]).toBe(firstNextCursor);
  });

  test('stops when the server repeats the same cursor', async ({ page }) => {
    await openRoom(page, mainRoomId);

    const latest = await callTool<HistoryPage>(base, tokenA, 'network_history_list', {
      room_id: mainRoomId,
      direction: 'before',
      limit: LIMITS.historyPageDefault,
      view: 'timeline',
    });
    const cursor = latest.timeline_next_cursor;
    expect(cursor).toBeTruthy();
    if (!cursor) return;
    const olderPage = await callTool<HistoryPage>(base, tokenA, 'network_history_list', {
      room_id: mainRoomId,
      direction: 'before',
      limit: LIMITS.historyPageDefault,
      view: 'timeline',
      cursor,
    });
    expect(olderPage.timeline_items?.length).toBeGreaterThan(0);

    await page.route('**/mcp', async (route) => {
      const args = historyTool(route);
      if (!args || args.room_id !== mainRoomId || args.cursor !== cursor) {
        await route.continue();
        return;
      }
      const request = route.request().postDataJSON() as { id?: string } | null;
      const repeated = {
        ...olderPage,
        timeline_has_more: true,
        timeline_next_cursor: cursor,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: request?.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(repeated) }],
            structuredContent: repeated,
          },
        }),
      });
    });

    await setScrollTop(page, 0);
    await expect.poll(() => messageCount(page), { timeout: 20_000 }).toBe(100);
    expect((await cursorCalls(page)).length).toBe(1);
    await expect(page.locator('#older')).toBeDisabled();
    await expect(page.locator('#older-status')).toHaveText('已经到最早的消息了');

    // 重复 scroll / 点击都不能再产生 cursor 请求。
    await setScrollTop(page, 0);
    await page.evaluate(`document.getElementById('older').click()`);
    await page.waitForTimeout(500);
    expect((await cursorCalls(page)).length).toBe(1);
    const ids = await messageIds(page);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.describe('short list', () => {
    test.use({ viewport: { width: 1280, height: 6000 } });

    test('does not auto-load when the list cannot scroll', async ({ page }) => {
      await openRoom(page, shortRoomId);
      expect(await scrollRange(page)).toBeLessThanOrEqual(0);

      await page.evaluate(`document.getElementById('messages').dispatchEvent(new Event('scroll'))`);
      await page.waitForTimeout(500);
      expect(await cursorCalls(page)).toHaveLength(0);

      await page.evaluate(`document.getElementById('older').click()`);
      await expect.poll(() => messageCount(page), { timeout: 20_000 }).toBe(51);
      const loaded = await messageIds(page);
      expect(new Set(loaded).size).toBe(loaded.length);

      await page.evaluate(`document.getElementById('messages').dispatchEvent(new Event('scroll'))`);
      await page.evaluate(`document.getElementById('messages').dispatchEvent(new Event('scroll'))`);
      await page.waitForTimeout(500);
      expect((await cursorCalls(page)).length).toBe(1);
      await expect(page.locator('#older')).toBeDisabled();
      await expect(page.locator('#older-status')).toHaveText('已经到最早的消息了');
    });
  });
});
