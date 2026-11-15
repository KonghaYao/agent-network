import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LIMITS } from '../../src/contracts/limits';

/**
 * 房间滚动位置恢复。
 *
 * SPA 在房间之间复用 ChatPage/Timeline，历史渲染与 Markdown 升级又都是异步的。
 * 这里用真实 MCP 数据与真实浏览器验证：中部阅读按消息锚点恢复、底部保持钉底、
 * 新消息不打断阅读、Markdown 高度变化后锚点稳定，以及 390px 单列回的路径。
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
            name: 'agent-network-scroll-restore-e2e',
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

interface RoomCreated {
  room: { room_id: string };
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface RoomsList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
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

async function registerAgent(
  base: string,
  name: string,
): Promise<{ token: string; actor: Registered }> {
  const token = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const actor = await callTool<Registered>(base, token, 'network_register', {
    request_id: requestId('e2e_reg'),
    kind: 'agent',
    name,
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
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
  body: (index: number) => string,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await callTool(base, token, 'network_message_send', {
      request_id: requestId('e2e_seed'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      invoke: [],
      body: body(index),
    });
  }
}

async function openRoom(
  page: Page,
  base: string,
  roomId: string,
  count = LIMITS.historyPageDefault,
): Promise<void> {
  await page.goto(`${base}/c/${roomId}`);
  await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
  await expect(page.locator('#messages .msg[data-message-id]')).toHaveCount(count, {
    timeout: 20_000,
  });
}

interface ScrollAnchor {
  id: string;
  offset: number;
  scrollTop: number;
  bottomGap: number;
}

async function scrollAnchor(page: Page): Promise<ScrollAnchor | null> {
  return page.evaluate(() => {
    const list = document.getElementById('messages');
    if (!list) return null;
    const listRect = list.getBoundingClientRect();
    for (const node of Array.from(list.children)) {
      const element = node as HTMLElement;
      if (!element.dataset.messageId) continue;
      const rect = element.getBoundingClientRect();
      if (rect.top >= listRect.bottom || rect.bottom <= listRect.top) continue;
      return {
        id: element.dataset.messageId,
        offset: rect.top - listRect.top,
        scrollTop: list.scrollTop,
        bottomGap: list.scrollHeight - list.scrollTop - list.clientHeight,
      };
    }
    return null;
  });
}

async function setMiddle(page: Page): Promise<ScrollAnchor> {
  const range = await page.$eval(
    '#messages',
    (element) => element.scrollHeight - element.clientHeight,
  );
  expect(range).toBeGreaterThan(200);
  await page.$eval(
    '#messages',
    (element, top) => {
      element.scrollTop = top;
    },
    Math.floor(range * 0.45),
  );
  await expect(page.locator('#jump-latest')).toBeVisible();
  await page.waitForTimeout(80);
  const anchor = await scrollAnchor(page);
  expect(anchor).not.toBeNull();
  return anchor!;
}

async function switchToGroup(page: Page, roomId: string, title: string, count: number): Promise<void> {
  await page.locator('#room-filter-group').click();
  const link = page.locator(`#room-list a.room-item[href="/c/${encodeURIComponent(roomId)}"]`);
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('#title')).toHaveText(title);
  await expect(page.locator('#messages .msg[data-message-id]')).toHaveCount(count, {
    timeout: 10_000,
  });
}

async function switchToDirect(page: Page, roomId: string, title: string): Promise<void> {
  await page.locator('#room-filter-friend').click();
  const link = page.locator(`#room-list a.room-item[href="/c/${encodeURIComponent(roomId)}"]`);
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator('#title')).toHaveText(title);
  await expect(page.locator('#messages .msg[data-message-id]')).toHaveCount(
    LIMITS.historyPageDefault,
    { timeout: 10_000 },
  );
}

async function waitForMarkdownSettled(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator('#messages .msg-markdown h2').count(), { timeout: 15_000 })
    .toBeGreaterThan(20);
  let lastHeight = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const height = await page.$eval('#messages', (element) => element.scrollHeight);
    if (height !== lastHeight) {
      lastHeight = height;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 500) {
      return;
    }
    await page.waitForTimeout(50);
  }
  throw new Error('Markdown 高度未稳定');
}

test.describe.configure({ timeout: 180_000 });

test.describe('SPA room scroll restore', () => {
  let base = '';
  let tokenA = '';
  let tokenB = '';
  let nameB = '';
  let directRoomId = '';
  let groupRoomId = '';
  let groupTitle = '';
  let markdownRoomId = '';
  let markdownTitle = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const a = await registerHuman(base, `滚动 A ${suffix}`, `e2e-scroll-${suffix}-a`);
    const b = await registerHuman(base, `滚动 B ${suffix}`, `e2e-scroll-${suffix}-b`);
    const agent = await registerAgent(base, `滚动 Markdown Agent ${suffix}`);
    tokenA = a.token;
    tokenB = b.token;
    nameB = b.actor.name;

    directRoomId = await befriend(base, tokenA, b.actor, tokenB);
    await seedMessages(base, tokenB, directRoomId, 65, (index) =>
      `滚动消息 ${String(index).padStart(3, '0')}`,
    );

    groupTitle = `滚动群 ${suffix}`;
    const group = await callTool<RoomCreated>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_group'),
      kind: 'group',
      title: groupTitle,
      members: [b.actor.actor_id],
    });
    groupRoomId = group.room.room_id;
    await seedMessages(base, tokenB, groupRoomId, 2, (index) => `滚动群消息 ${index}`);

    markdownTitle = `滚动 Markdown 群 ${suffix}`;
    const markdownRoom = await callTool<RoomCreated>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_markdown_group'),
      kind: 'group',
      title: markdownTitle,
      members: [agent.actor.actor_id],
    });
    markdownRoomId = markdownRoom.room.room_id;
    await seedMessages(base, agent.token, markdownRoomId, 60, (index) => {
      return [
        `## Markdown ${String(index).padStart(3, '0')}`,
        '',
        '这是一段会在异步 Markdown 岛挂载后改变高度的正文。'.repeat(12),
        '',
        `- 列表项 ${index}`,
        '- 第二项',
      ].join('\n');
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

  test('restores the reading anchor after switching rooms', async ({ page }) => {
    await openRoom(page, base, directRoomId);
    const before = await setMiddle(page);
    await switchToGroup(page, groupRoomId, groupTitle, 2);
    await switchToDirect(page, directRoomId, nameB);
    await page.waitForTimeout(120);

    const after = await scrollAnchor(page);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before.id);
    expect(Math.abs(after!.offset - before.offset)).toBeLessThanOrEqual(24);
    expect(Math.abs(after!.scrollTop - before.scrollTop)).toBeLessThanOrEqual(24);
    expect(after!.bottomGap).toBeGreaterThan(LIMITS.webScrollStickyPx);
  });

  test('keeps the bottom pinned after switching rooms', async ({ page }) => {
    await openRoom(page, base, directRoomId);
    await expect(page.locator('#jump-latest')).toBeHidden();
    const beforeGap = await page.$eval(
      '#messages',
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    );
    expect(beforeGap).toBeLessThanOrEqual(2);

    await switchToGroup(page, groupRoomId, groupTitle, 2);
    await switchToDirect(page, directRoomId, nameB);
    const afterGap = await page.$eval(
      '#messages',
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    );
    expect(afterGap).toBeLessThanOrEqual(2);
    await expect(page.locator('#jump-latest')).toBeHidden();
  });

  test('does not force the reader to the bottom when a new message arrives', async ({ page }) => {
    await openRoom(page, base, directRoomId);
    const before = await setMiddle(page);
    const marker = `中部新消息 ${Date.now()}`;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_new_message'),
      client_message_id: crypto.randomUUID(),
      room_id: directRoomId,
      invoke: [],
      body: marker,
    });

    await expect(page.locator('#messages .msg', { hasText: marker })).toHaveCount(1, {
      timeout: 15_000,
    });
    await page.waitForTimeout(120);
    const after = await scrollAnchor(page);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before.id);
    expect(Math.abs(after!.offset - before.offset)).toBeLessThanOrEqual(24);
    expect(after!.bottomGap).toBeGreaterThan(LIMITS.webScrollStickyPx);
  });

  test('keeps the anchor while asynchronous Markdown changes heights', async ({ page }) => {
    let releaseMarkdown: () => void = () => undefined;
    const markdownGate = new Promise<void>((release) => {
      releaseMarkdown = release;
    });
    let markdownRequested = false;
    await page.route('**/assets/chat-markdown.js*', async (route) => {
      markdownRequested = true;
      await markdownGate;
      await route.continue();
    });

    await openRoom(page, base, markdownRoomId);
    expect(markdownRequested).toBe(true);
    const before = await setMiddle(page);
    releaseMarkdown();
    await waitForMarkdownSettled(page);

    const after = await scrollAnchor(page);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before.id);
    expect(Math.abs(after!.offset - before.offset)).toBeLessThanOrEqual(24);
    expect(after!.bottomGap).toBeGreaterThan(LIMITS.webScrollStickyPx);
  });

  test.describe('mobile 390px', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('restores the anchor after leaving and reopening the room', async ({ page }) => {
      await openRoom(page, base, directRoomId);
      const before = await setMiddle(page);
      await page.locator('#back').click();
      await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
      await page.locator(
        `#room-list a.room-item[href="/c/${encodeURIComponent(directRoomId)}"]`,
      ).click();
      await expect(page.locator('#messages .msg[data-message-id]')).toHaveCount(
        LIMITS.historyPageDefault,
        { timeout: 10_000 },
      );
      await page.waitForTimeout(120);

      const after = await scrollAnchor(page);
      expect(after).not.toBeNull();
      expect(after!.id).toBe(before.id);
      expect(Math.abs(after!.offset - before.offset)).toBeLessThanOrEqual(24);
      expect(after!.bottomGap).toBeGreaterThan(LIMITS.webScrollStickyPx);

      const layout = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        chat: document.querySelector('.chat-pane')?.getBoundingClientRect().width ?? 0,
        sidebar: document.querySelector('.sidebar')
          ? getComputedStyle(document.querySelector('.sidebar') as HTMLElement).display
          : 'absent',
      }));
      expect(layout.document).toBeLessThanOrEqual(layout.viewport + 1);
      expect(layout.chat).toBeLessThanOrEqual(layout.viewport + 1);
      expect(layout.sidebar === 'absent' || layout.sidebar === 'none').toBe(true);
    });
  });
});
