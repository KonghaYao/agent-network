import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 长 Agent 消息验收：可见消息自动展开、16–32 KiB 折叠边界、截断预览纯文本、
 * 手动展开后的「收起」状态、图片 alt 占位与自动读取并发上限。
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
  status?: string;
  request: { contact_request_id: string } | null;
}

/** 统计同时进行中的 `network_message_read`，验证自动展开并发闸门。 */
async function instrumentReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __readPending: number;
      __maxReadPending: number;
      fetch: typeof fetch;
    };
    target.__readPending = 0;
    target.__maxReadPending = 0;
    const original = target.fetch.bind(window);
    target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      let name: string | null = null;
      try {
        const body =
          typeof init?.body === 'string'
            ? (JSON.parse(init.body) as { params?: { name?: string } })
            : null;
        name = body?.params?.name ?? null;
      } catch {
        name = null;
      }
      if (name !== 'network_message_read') return original(input, init);
      target.__readPending += 1;
      target.__maxReadPending = Math.max(target.__maxReadPending, target.__readPending);
      try {
        return await original(input, init);
      } finally {
        target.__readPending -= 1;
      }
    }) as typeof fetch;
  });
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function longBody(marker: string, size: number, tail: string): string {
  const head = `${marker}\n`;
  const bottom = `\n${tail}`;
  const filler = Math.max(0, size - bytes(head) - bytes(bottom));
  const pad = 'filler text ';
  const padding = pad.repeat(Math.ceil(filler / pad.length)).slice(0, filler);
  return `${head}${padding}${bottom}`;
}

/**
 * 滚到目标消息并等待自动展开。
 *
 * 首屏其他消息的自动展开会改变列表高度，单次 scrollIntoView 可能正好落在
 * 布局变化之间；重试滚动与短断言可以覆盖这段时间，同时保留“可见即展开”的断言。
 */
async function centerMessage(page: Page, messageId: string): Promise<void> {
  // 虚拟列表里直接对 item 调用 scrollIntoView 会与绝对定位/测量互相追逐；
  // 始终只滚动真正的容器。用 querySelector 避免 locator 等待已卸载节点。
  await page.evaluate((id) => {
    const list = document.getElementById('messages');
    const node = document.querySelector(`#messages .msg[data-message-id="${id}"]`);
    if (!list || !node) return;
    const rect = node.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const delta = rect.top - listRect.top - listRect.height / 2 + rect.height / 2;
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: delta < 0 ? -120 : 120, bubbles: true }));
    list.scrollTop += delta;
  }, messageId);
}

async function ensureVisible(
  page: Page,
  messageId: string,
  order: string[],
): Promise<Locator> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const target = await revealMessage(page, messageId, order);
    if ((await target.count()) === 0) {
      await page.waitForTimeout(100);
      continue;
    }
    try {
      await centerMessage(page, messageId);
    } catch {
      await page.waitForTimeout(100);
      continue;
    }
    await page.waitForTimeout(80);
    if ((await target.count()) === 0) continue;
    const visible = await page.evaluate((id) => {
      const list = document.getElementById('messages');
      const node = document.querySelector(`#messages .msg[data-message-id="${id}"]`);
      if (!list || !node) return false;
      const rect = node.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      return rect.bottom > listRect.top + 2 && rect.top < listRect.bottom - 2;
    }, messageId);
    if (visible) return target;
  }
  return revealMessage(page, messageId, order);
}

async function expandOnScroll(
  page: Page,
  messageId: string,
  order: string[],
  tail: string,
): Promise<Locator> {
  await expect(async () => {
    const target = await ensureVisible(page, messageId, order);
    await expect(target).toContainText(tail, { timeout: 800 });
  }).toPass({ timeout: 30_000 });
  return ensureVisible(page, messageId, order);
}

/** 虚拟时间线只挂载窗口内消息；按已知消息顺序把目标滚进真正的视口。 */
async function revealMessage(
  page: Page,
  messageId: string,
  order: string[],
): Promise<Locator> {
  const target = page.locator(`#messages .msg[data-message-id="${messageId}"]`);
  const targetIndex = order.indexOf(messageId);
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if ((await target.count()) > 0) {
      const visible = await page.evaluate((id) => {
        const list = document.getElementById('messages');
        const node = document.querySelector(`#messages .msg[data-message-id="${id}"]`);
        if (!list || !node) return false;
        const rect = node.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return rect.bottom > listRect.top + 2 && rect.top < listRect.bottom - 2;
      }, messageId);
      if (visible) return target;
      await centerMessage(page, messageId);
      await page.waitForTimeout(80);
      continue;
    }
    const state = await page.evaluate(() => {
      const list = document.getElementById('messages');
      if (!list) return null;
      return {
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
        mounted: Array.from(list.querySelectorAll<HTMLElement>('.msg[data-message-id]')).map(
          (node) => node.dataset.messageId ?? '',
        ),
      };
    });
    if (!state) break;
    const mountedIndexes = state.mounted
      .map((id) => order.indexOf(id))
      .filter((index) => index >= 0);
    let nextTop = state.scrollTop;
    if (mountedIndexes.length > 0 && targetIndex < Math.min(...mountedIndexes)) {
      nextTop = Math.max(0, state.scrollTop - 500);
    } else if (mountedIndexes.length > 0 && targetIndex > Math.max(...mountedIndexes)) {
      nextTop = Math.min(
        state.scrollHeight - state.clientHeight,
        state.scrollTop + 500,
      );
    } else if (targetIndex >= 0 && order.length > 1) {
      nextTop = Math.min(
        state.scrollHeight - state.clientHeight,
        Math.max(0, (state.scrollHeight * targetIndex) / order.length - state.clientHeight / 2),
      );
    }
    if (Math.abs(nextTop - state.scrollTop) < 1) break;
    await page.$eval('#messages', (node, top) => {
      const value = top as number;
      node.dispatchEvent(
        new WheelEvent('wheel', { deltaY: value < node.scrollTop ? -120 : 120, bubbles: true }),
      );
      node.scrollTop = value;
    }, nextTop);
    await page.waitForTimeout(80);
  }
  return target;
}

async function loadedMessageCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const node = document.getElementById('messages');
    return Number(node?.getAttribute('data-loaded-message-count') ?? '0');
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('long agent messages', () => {
  let base = '';
  let roomId = '';
  let agentName = '';
  let humanToken = '';
  const messageOrder: string[] = [];
  const markerIds: Record<string, string> = {};
  const marker = {
    auto2k: '自动展开 2KB 标记',
    auto2kTail: '自动展开 2KB 完整结尾',
    low: '折叠边界 15KB 标记',
    lowTail: '折叠边界 15KB 完整结尾',
    high: '折叠边界 17KB 标记',
    highTail: '折叠边界 17KB 完整结尾',
    exact: '折叠边界 16KB 标记',
    exactTail: '折叠边界 16KB 完整结尾',
    manual: '截断预览 40KB 标记',
    manualTail: '截断预览 40KB 完整结尾',
    image: '图片占位验收',
  };

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    humanToken = crypto.randomUUID();
    const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;

    await callTool<Registered>(base, humanToken, 'network_register', {
      request_id: requestId('long_reg'),
      kind: 'human',
      name: `长消息人类 ${suffix}`,
      device_id: `e2e-long-${suffix}`,
    });
    const agent = await callTool<Registered>(base, agentToken, 'network_register', {
      request_id: requestId('long_reg'),
      kind: 'agent',
      name: `长消息 Agent ${suffix}`,
      agent_session_id: `sess_${suffix}`,
    });
    agentName = agent.name;

    const requested = await callTool<ContactRequestResult>(
      base,
      humanToken,
      'network_contact_request',
      { request_id: requestId('long_contact'), actor_id: agent.actor_id },
    );
    if (requested.status !== 'accepted') {
      if (!requested.request) throw new Error('好友申请未进入 pending');
      await callTool(base, agentToken, 'network_contact_request_respond', {
        request_id: requestId('long_contact'),
        contact_request_id: requested.request.contact_request_id,
        action: 'accept',
      });
    }

    const rooms = await callTool<RoomList>(base, humanToken, 'network_rooms_list', {
      limit: 50,
    });
    roomId =
      rooms.items.find(
        (room) => room.kind === 'direct' && room.peer?.actor_id === agent.actor_id,
      )?.room_id ?? '';
    if (!roomId) {
      const created = await callTool<RoomDetail>(base, humanToken, 'network_room_create', {
        request_id: requestId('long_room'),
        kind: 'direct',
        members: [agent.actor_id],
      });
      roomId = created.room.room_id;
    }

    const send = async (body: string): Promise<void> => {
      const result = await callTool<{ message: { message_id: string } }>(
        base,
        agentToken,
        'network_message_send',
        {
          request_id: requestId('long_msg'),
          client_message_id: crypto.randomUUID(),
          room_id: roomId,
          body,
          invoke: [],
        },
      );
      messageOrder.push(result.message.message_id);
    };
    const sendMarked = async (key: string, body: string): Promise<void> => {
      const before = messageOrder.length;
      await send(body);
      markerIds[key] = messageOrder[before] ?? '';
    };

    await sendMarked(
      'image',
      `${marker.image}\n\n![架构图](https://example.com/topology.png)`,
    );
    await sendMarked('auto2k', longBody(marker.auto2k, 2 * 1024, marker.auto2kTail));
    await sendMarked('low', longBody(marker.low, 15 * 1024, marker.lowTail));
    await sendMarked('exact', longBody(marker.exact, 16 * 1024, marker.exactTail));
    await sendMarked('high', longBody(marker.high, 17 * 1024, marker.highTail));
    // 512B 切口落在表格与未闭合代码围栏中间：全文加载前应保持纯文本。
    await sendMarked(
      'manual',
      `| 列A | 列B |\n| --- | --- |\n| 单元格 | 内容 |\n\n\`\`\`text\n${longBody(
        marker.manual,
        40 * 1024,
        marker.manualTail,
      )}`,
    );
    for (let index = 1; index <= 8; index += 1) {
      await send(
        longBody(
          `并发消息 ${String(index).padStart(2, '0')} 标记`,
          2 * 1024,
          `并发消息 ${String(index).padStart(2, '0')} 完整结尾`,
        ),
      );
    }
  });

  test.beforeEach(async ({ page }) => {
    await instrumentReads(page);
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    }, humanToken);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('auto-expands visible 2 KiB messages with bounded concurrency', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#title')).toHaveText(agentName);
    await expect.poll(() => loadedMessageCount(page), { timeout: 20_000 }).toBe(14);

    // 最后 8 条并发消息位于底部首屏，自动展开应并行但不超过 3 条。
    await expect(
      page.locator('#messages .msg').filter({ hasText: '并发消息 08 完整结尾' }),
    ).toBeVisible({ timeout: 20_000 });
    const concurrency = await page.evaluate(() => {
      const target = window as unknown as {
        __maxReadPending?: number;
        __readPending?: number;
      };
      return {
        max: target.__maxReadPending ?? 0,
        current: target.__readPending ?? 0,
      };
    });
    expect(concurrency.max).toBeLessThanOrEqual(3);
    expect(concurrency.max).toBeGreaterThanOrEqual(2);

    const lazy = await expandOnScroll(
      page,
      markerIds.auto2k!,
      messageOrder,
      marker.auto2kTail,
    );
    await expect(lazy.locator('.msg-plain-preview')).toHaveCount(0);
    await expect(lazy.locator('.expand')).toHaveCount(0);
  });

  test('keeps 15 KiB expanded and collapses 16/17 KiB without re-hiding loaded text', async ({
    page,
  }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect.poll(() => loadedMessageCount(page), { timeout: 20_000 }).toBe(14);

    const low = await expandOnScroll(
      page,
      markerIds.low!,
      messageOrder,
      marker.lowTail,
    );
    await expect(low.locator('.expand')).toHaveCount(0);

    const exact = await expandOnScroll(
      page,
      markerIds.exact!,
      messageOrder,
      marker.exactTail,
    );
    await expect(exact.locator('.expand')).toHaveText('收起');

    const high = await expandOnScroll(
      page,
      markerIds.high!,
      messageOrder,
      marker.highTail,
    );
    const toggle = high.locator('.expand');
    await expect(toggle).toHaveText('收起');
    await toggle.click();
    await expect(toggle).toHaveText('展开全文');
    // 收起后行高骤降，Virtuoso 会重新测量/调整窗口；等布局稳定后再展开。
    const highAgain = await ensureVisible(page, markerIds.high!, messageOrder);
    await page.waitForTimeout(500);
    await highAgain.locator('.expand').click({ timeout: 5_000 });
    await expect(highAgain.locator('.expand')).toHaveText('收起', { timeout: 5_000 });
    const reopened = await ensureVisible(page, markerIds.high!, messageOrder);
    await expect(reopened).toContainText(marker.highTail);
  });

  test('renders a truncated 512B preview as plain text until full load', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect.poll(() => loadedMessageCount(page), { timeout: 20_000 }).toBe(14);
    const message = await ensureVisible(page, markerIds.manual!, messageOrder);

    const preview = message.locator('.msg-plain-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('| 列A | 列B |');
    await expect(message.locator('.msg-markdown')).toHaveCount(0);
    await expect(message.locator('.md-table')).toHaveCount(0);
    await expect(message.locator('.md-pre')).toHaveCount(0);
    const button = message.locator('.expand');
    await expect(button).toHaveText('查看全文');
    await button.click();

    await expect(message).toContainText(marker.manualTail, { timeout: 20_000 });
    await expect(message.locator('.md-table')).toBeVisible();
    await expect(message.locator('.md-pre')).toBeVisible();
    await expect(button).toHaveText('收起');
    await expect(message.getByText('展开全文', { exact: true })).toHaveCount(0);
    await expect(message.getByText('查看全文', { exact: true })).toHaveCount(0);
  });

  test('shows alt text placeholder instead of dropping markdown images', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect.poll(() => loadedMessageCount(page), { timeout: 20_000 }).toBe(14);
    const message = await ensureVisible(page, markerIds.image!, messageOrder);
    await expect(message.locator('.md-image-placeholder')).toHaveText('[图片] 架构图', {
      timeout: 20_000,
    });
    await expect(message.locator('img')).toHaveCount(0);
  });
});
