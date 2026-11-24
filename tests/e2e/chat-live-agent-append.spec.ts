import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 无 delivery 的 Agent 房间消息也要实时出现在人类页面。
 *
 * 复现口径：Agent 用 `invoke: []` 发纯文本，服务端只写 `room.message` 与
 * `room:<id>` outbox，不创建 delivery。人类页面必须靠 SSE 失效 history
 * 后追加；不能等刷新/重新进房才出现。
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

interface CreatedAgent {
  actor_id: string;
  name: string;
  token: string;
}

interface RoomDetail {
  room: { room_id: string };
}

interface Sent {
  message: { message_id: string };
  delivery_ids: string[];
}

async function send(
  base: string,
  token: string,
  roomId: string,
  body: string,
): Promise<Sent> {
  return callTool<Sent>(base, token, 'network_message_send', {
    request_id: requestId('live_send'),
    client_message_id: crypto.randomUUID(),
    room_id: roomId,
    body,
    invoke: [],
  });
}

async function bottomGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const node = document.getElementById('messages');
    return node ? node.scrollHeight - node.scrollTop - node.clientHeight : Number.NaN;
  });
}

async function loadedMessages(page: Page): Promise<number> {
  return page.evaluate(() => {
    const node = document.getElementById('messages');
    return Number(node?.getAttribute('data-loaded-message-count') ?? '0');
  });
}

test.describe.configure({ timeout: 180_000 });

test.describe('live append for delivery-less agent messages', () => {
  let base = '';
  let humanToken = '';
  let agentToken = '';
  let roomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    humanToken = crypto.randomUUID();
    await callTool<Registered>(base, humanToken, 'network_register', {
      request_id: requestId('live_reg'),
      kind: 'human',
      name: `实时人类 ${suffix}`,
      device_id: `live-${suffix}`,
    });
    const agent = await callTool<CreatedAgent>(base, humanToken, 'network_agent_create', {
      request_id: requestId('live_agent'),
      name: `实时 Agent ${suffix}`,
      agent_session_id: `sess_live_${suffix}`,
    });
    agentToken = agent.token;
    const room = await callTool<RoomDetail>(base, humanToken, 'network_room_create', {
      request_id: requestId('live_room'),
      kind: 'direct',
      members: [agent.actor_id],
    });
    roomId = room.room.room_id;
    for (let index = 0; index < 40; index += 1) {
      await send(base, humanToken, roomId, `实时历史 ${index}`);
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    }, humanToken);
  });

  async function openRoom(page: Page): Promise<void> {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
    await expect(page.locator('#messages')).toHaveAttribute('data-timeline-mode', 'virtual');
    await expect(page.locator('#messages')).toHaveAttribute('data-loaded-ready', 'true');
    await expect(page.locator('#messages')).toHaveAttribute('data-virt-at-bottom', 'true');
  }

  test('appends an agent message while pinned and keeps the viewport at the bottom', async ({
    page,
  }) => {
    await openRoom(page);
    const before = await loadedMessages(page);
    const marker = `无投递实时消息 ${Date.now()}`;

    const started = Date.now();
    const sent = await send(base, agentToken, roomId, marker);
    expect(sent.delivery_ids).toEqual([]);
    await expect(
      page.locator(`.msg[data-message-id="${sent.message.message_id}"] .bubble`),
    ).toContainText(marker, { timeout: 2_000 });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(await loadedMessages(page)).toBe(before + 1);
    expect(await bottomGap(page)).toBeLessThanOrEqual(4);
    await expect(page.locator('#jump-latest')).toBeHidden();
  });

  test('shows a new-message hint when scrolled up without forcing the viewport', async ({
    page,
  }) => {
    await openRoom(page);
    const anchor = page.locator('#messages .msg[data-message-id]').last();
    await expect(anchor).toBeVisible();
    const anchorId = await anchor.getAttribute('data-message-id');
    const pinnedAnchor = page.locator(`#messages .msg[data-message-id="${anchorId}"]`);

    await page.evaluate(() => {
      const node = document.getElementById('messages');
      if (!node) return;
      node.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
      node.scrollTop = Math.max(0, node.scrollTop - 300);
    });
    await expect(page.locator('#messages')).toHaveAttribute('data-virt-at-bottom', 'false');
    await expect(pinnedAnchor).toBeVisible();
    // 等待虚拟列表完成为本次滚动的二次测量，避免把测量修正误判为追加跳动。
    await page.waitForTimeout(400);
    const anchorTop = await pinnedAnchor.evaluate((node) => node.getBoundingClientRect().top);
    const before = await loadedMessages(page);

    const marker = `上翻提示消息 ${Date.now()}`;
    const sent = await send(base, agentToken, roomId, marker);
    await expect
      .poll(() => loadedMessages(page), { timeout: 3_000 })
      .toBe(before + 1);
    await expect(page.locator('#jump-latest')).toBeVisible();
    await expect(page.locator('#jump-latest-label')).toHaveText('有新消息 · 回到最新');
    // 不强制拉回：用户原先可见的锚点仍在原处。
    await expect(pinnedAnchor).toBeVisible();
    const afterTop = await pinnedAnchor.evaluate((node) => node.getBoundingClientRect().top);
    expect(Math.abs(afterTop - anchorTop)).toBeLessThanOrEqual(2);

    await page.locator('#jump-latest').click();
    await expect(
      page.locator(`.msg[data-message-id="${sent.message.message_id}"] .bubble`),
    ).toContainText(marker);
    await expect(page.locator('#jump-latest')).toBeHidden();
    await expect.poll(() => bottomGap(page), { timeout: 3_000 }).toBeLessThanOrEqual(4);
  });

  test('catches up a message sent while the stream reconnects', async ({ page }) => {
    await openRoom(page);
    await page.context().setOffline(true);
    // 断开期间服务端仍提交消息；客户端靠重连 ack 的恢复轮补读。
    const marker = `重连期间消息 ${Date.now()}`;
    const sent = await send(base, agentToken, roomId, marker);
    await expect(
      page.locator(`.msg[data-message-id="${sent.message.message_id}"] .bubble`),
    ).toHaveCount(0);
    await page.context().setOffline(false);
    await expect(
      page.locator(`.msg[data-message-id="${sent.message.message_id}"] .bubble`),
    ).toContainText(marker, { timeout: 20_000 });
  });

  test('recovers the open room when one stream frame is truncated', async ({ page }) => {
    // 服务端一帧最多 20 条/1 KiB，超出部分只以 more/dropped 标注，不会补发。
    // 这里把当前房间的消息从真实 SSE 帧里移除并标记为 dropped，模拟
    // “本房间事件正好落在被截断的尾巴上”；页面必须保守重读当前房间。
    await page.addInitScript((targetRoom) => {
      const target = window as unknown as {
        __truncateNextRoomFrame?: boolean;
        __liveHistoryCalls?: number;
        fetch: typeof fetch;
      };
      target.__truncateNextRoomFrame = false;
      target.__liveHistoryCalls = 0;
      const original = target.fetch.bind(window);
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        let method: string | null = null;
        try {
          method = typeof init?.body === 'string' ? JSON.parse(init.body).method : null;
        } catch {
          method = null;
        }
        if (method === 'tools/call') {
          try {
            const name = JSON.parse(String(init?.body)).params?.name;
            if (name === 'network_history_list') target.__liveHistoryCalls! += 1;
          } catch {
            // 非 JSON 请求不计数。
          }
        }
        const response = await original(input, init);
        if (method !== 'subscriptions/listen' || !response.body) return response;
        let buffer = '';
        const rewrite = (raw: string): string => {
          const data = raw
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (!data || !target.__truncateNextRoomFrame) return raw;
          let message: {
            params?: {
              _meta?: Record<
                string,
                { items?: { room_id?: string }[]; more?: boolean; dropped?: number }
              >;
            };
          };
          try {
            message = JSON.parse(data);
          } catch {
            return raw;
          }
          const envelope = message.params?._meta?.['io.agent-network/event'];
          if (!envelope || !Array.isArray(envelope.items)) return raw;
          const removed = envelope.items.filter((item) => item.room_id === targetRoom);
          if (removed.length === 0) return raw;
          envelope.items = envelope.items.filter((item) => item.room_id !== targetRoom);
          envelope.more = true;
          envelope.dropped = (envelope.dropped ?? 0) + removed.length;
          target.__truncateNextRoomFrame = false;
          return 'event: message\ndata: ' + JSON.stringify(message);
        };
        const transform = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            for (;;) {
              const index = buffer.indexOf('\n\n');
              if (index < 0) break;
              const raw = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              controller.enqueue(encoder.encode(rewrite(raw) + '\n\n'));
            }
          },
          flush(controller) {
            if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
          },
        });
        return new Response(response.body.pipeThrough(transform), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }) as typeof fetch;
    }, roomId);

    await openRoom(page);
    // 第一条 Agent 消息会让服务端推断 Agent 上线并写入 presence；先发一条
    // 预热消息并等它落定，避免 presence 触发的 history 刷新掩盖本用例。
    const warm = await send(base, agentToken, roomId, `预热消息 ${Date.now()}`);
    await expect(
      page.locator(`.msg[data-message-id="${warm.message.message_id}"] .bubble`),
    ).toContainText('预热消息', { timeout: 5_000 });
    await page.waitForTimeout(800);
    const historyBefore = await page.evaluate(
      () =>
        (window as unknown as { __liveHistoryCalls?: number }).__liveHistoryCalls ?? 0,
    );
    await page.evaluate(() => {
      (window as unknown as { __truncateNextRoomFrame?: boolean }).__truncateNextRoomFrame =
        true;
    });
    const marker = `截断后补偿消息 ${Date.now()}`;
    const sent = await send(base, agentToken, roomId, marker);
    // 帧里的本房间定位已被移除；只能靠 more/dropped 触发当前房间重读。
    await expect(
      page.locator(`.msg[data-message-id="${sent.message.message_id}"] .bubble`),
    ).toContainText(marker, { timeout: 5_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __liveHistoryCalls?: number }).__liveHistoryCalls ?? 0,
          ),
        { timeout: 2_000 },
      )
      .toBeGreaterThan(historyBefore);
  });
});
