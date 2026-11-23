import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 群聊自动 @ 的发送前兜底回归。
 *
 * 线上问题是“空闲较久后第一条消息不再补 @”：自动 @ 原先只看内存里已加载
 * 的历史窗口，窗口为空或停在发送者自己的上一条时，就静默跳过了补 @。
 *
 * 这里用请求层故障注入模拟“服务端已有 Agent 新消息、页面窗口仍滞后/为空”：
 * - `trim`：完整历史页永远缺最新一条消息，游标冻结在启用时刻；
 * - `empty`：完整历史页返回空列表；
 * - `probeFail`：只让兜底读取（limit=1）失败。
 *
 * 断言直接检查 `network_message_send` 的 arguments，不依赖页面是否渲染出
 * 最新消息；兜底失败时消息仍必须发出。
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
            name: 'agent-network-auto-mention-fallback-e2e',
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
  room: { room_id: string; head_seq: string };
}

interface HistoryPage {
  items: { message_id: string; preview: string }[];
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

/**
 * 只改写 `network_history_list` 的响应：`limit <= 5` 视为发送前兜底读取，
 * 保持真实结果；更大的完整页按模式注入滞后/为空。`after` 补读保持原样由
 * 冻结游标避免触发，不影响其他工具。
 */
async function installHistoryFaults(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __historyWindowMode?: 'trim' | 'empty' | null;
      __historyProbeFail?: boolean;
      __historyCalls?: { limit: number | null; probe: boolean; at: number }[];
      __historyFrozen?: { snapshot: string | null; resume: string | null } | null;
      fetch: typeof fetch;
    };
    target.__historyWindowMode = null;
    target.__historyProbeFail = false;
    target.__historyCalls = [];
    target.__historyFrozen = null;
    const original = target.fetch.bind(window);
    target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      let name: string | null = null;
      let args: Record<string, unknown> = {};
      try {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        name = body?.params?.name ?? null;
        args = body?.params?.arguments ?? {};
      } catch {
        /* 非 JSON 请求原样放行。 */
      }
      if (name !== 'network_history_list') return original(input, init);
      const limit = typeof args.limit === 'number' ? args.limit : null;
      const probe = limit !== null && limit <= 5;
      target.__historyCalls?.push({ limit, probe, at: Date.now() });
      if (probe && target.__historyProbeFail) {
        throw new TypeError('simulated auto-mention probe failure');
      }
      const mode = target.__historyWindowMode;
      if (!mode || probe) return original(input, init);
      // 补洞（after）不参与滞后模拟：直接失败让调用方保留旧窗口，避免把
      // 注入掉的最新消息又补回内存。
      if (args.direction === 'after') {
        throw new TypeError('simulated history catch-up failure');
      }

      const response = await original(input, init);
      const payload = (await response.clone().json().catch(() => null)) as {
        result?: { structuredContent?: Record<string, unknown> };
      } | null;
      const result = payload?.result?.structuredContent;
      if (!payload || !result) return response;

      const timeline = Array.isArray(result.timeline_items)
        ? (result.timeline_items as Record<string, unknown>[])
        : null;
      const frozen = target.__historyFrozen;
      if (frozen) {
        // 冻结在启用时刻的游标，避免触发 after 补洞把新消息补回来。
        result.timeline_snapshot = frozen.snapshot;
        result.timeline_resume_cursor = frozen.resume;
      } else {
        target.__historyFrozen = {
          snapshot: typeof result.timeline_snapshot === 'string' ? result.timeline_snapshot : null,
          resume:
            typeof result.timeline_resume_cursor === 'string'
              ? result.timeline_resume_cursor
              : null,
        };
      }
      if (timeline) {
        if (mode === 'empty') {
          result.timeline_items = [];
          result.timeline_next_cursor = null;
          result.timeline_has_more = false;
        } else {
          // timeline_items 是最新在前；去掉最新一条消息，窗口停在上一条。
          const index = timeline.findIndex((item) => item.kind !== 'presence');
          if (index >= 0) timeline.splice(index, 1);
          result.timeline_items = timeline;
        }
      }
      return new Response(JSON.stringify(payload), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
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

async function historyCalls(
  page: Page,
): Promise<{ limit: number | null; probe: boolean; at: number }[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __historyCalls?: { limit: number | null; probe: boolean; at: number }[] })
        .__historyCalls ?? [],
  );
}

async function latestMessageId(
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

test.describe('SPA group auto mention fallback', () => {
  let base = '';
  let humanToken = '';
  let agent: { token: string; actor: Actor } | null = null;
  let newerAgent: { token: string; actor: Actor } | null = null;
  let groupRoomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    humanToken = crypto.randomUUID();
    await callTool<Actor>(base, humanToken, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `兜底人类 ${suffix}`,
      device_id: `e2e-auto-mention-fallback-${suffix}`,
    });
    const token = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
    const actor = await callTool<Actor>(base, token, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'agent',
      name: `兜底 Agent ${suffix}`,
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    agent = { token, actor };
    const newerToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
    const newerActor = await callTool<Actor>(base, newerToken, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'agent',
      name: `兜底新 Agent ${suffix}`,
      agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    newerAgent = { token: newerToken, actor: newerActor };
    const group = await callTool<RoomCreated>(base, humanToken, 'network_room_create', {
      request_id: requestId('e2e_group'),
      kind: 'group',
      title: `兜底提及群 ${suffix}`,
      members: [actor.actor_id, newerActor.actor_id],
    });
    groupRoomId = group.room.room_id;
  });

  test.beforeEach(async ({ page }) => {
    await instrumentFetch(page);
    await installHistoryFaults(page);
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 浏览器禁用存储时由页面错误态兜底。
      }
    }, humanToken);
  });

  test('fresh window does not issue the fallback read', async ({ page }) => {
    if (!agent) throw new Error('fixture 未初始化');
    await callTool(base, agent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: 'Agent 新窗口一楼',
      invoke: [],
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: 'Agent 新窗口一楼' })).toBeVisible();
    const before = (await historyCalls(page)).filter((call) => call.probe).length;

    const marker = `新窗口发送 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(`${marker}\n@${agent.actor.name}`);

    const after = (await historyCalls(page)).filter((call) => call.probe).length;
    // 窗口本来就能给出上一位成员：不额外发兜底读取。
    expect(after).toBe(before);
  });

  test('lagging window still mentions the latest Agent', async ({ page }) => {
    if (!agent) throw new Error('fixture 未初始化');
    await callTool(base, agent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: 'Agent 一楼',
      invoke: [],
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: 'Agent 一楼' })).toBeVisible();

    // 先让窗口末尾停在自己的消息。
    const mine = `我的上一条 ${Date.now()}`;
    await sendAndCapture(page, mine);
    await expect(page.locator('#messages .msg').filter({ hasText: mine })).toBeVisible();

    // 打开滞后模拟：完整历史页永远缺最新一条，游标冻结。
    await page.evaluate(() => {
      (
        window as unknown as { __historyWindowMode?: 'trim' | 'empty' | null }
      ).__historyWindowMode = 'trim';
    });
    const agentLatest = `Agent 最新 ${Date.now()}`;
    await callTool(base, agent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: agentLatest,
      invoke: [],
    });
    await page.waitForTimeout(600);
    // 页面窗口滞后：最新 Agent 消息没有进入 DOM。
    await expect(page.locator('#messages .msg').filter({ hasText: agentLatest })).toHaveCount(0);

    const marker = `滞后窗口发送 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(`${marker}\n@${agent.actor.name}`);
    expect(Object.hasOwn(args, 'invoke')).toBe(false);

    const calls = await historyCalls(page);
    expect(calls.some((call) => call.probe)).toBe(true);
    await latestMessageId(base, humanToken, groupRoomId, marker);
  });

  test('empty loaded window still mentions the latest Agent', async ({ page }) => {
    if (!agent) throw new Error('fixture 未初始化');
    await callTool(base, agent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: 'Agent 空窗口一楼',
      invoke: [],
    });
    await page.addInitScript(() => {
      (
        window as unknown as { __historyWindowMode?: 'trim' | 'empty' | null }
      ).__historyWindowMode = 'empty';
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#body')).toBeVisible();

    const marker = `空窗口发送 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(`${marker}\n@${agent.actor.name}`);
    expect(Object.hasOwn(args, 'invoke')).toBe(false);
    await latestMessageId(base, humanToken, groupRoomId, marker);
  });

  test('failed fallback read still sends the message without mention', async ({ page }) => {
    if (!agent) throw new Error('fixture 未初始化');
    await callTool(base, agent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: 'Agent 失败一楼',
      invoke: [],
    });
    // 空窗口 + 兜底读取失败：窗口无法给出上一位成员，读取也失败。
    await page.addInitScript(() => {
      (
        window as unknown as { __historyWindowMode?: 'trim' | 'empty' | null }
      ).__historyWindowMode = 'empty';
      (window as unknown as { __historyProbeFail?: boolean }).__historyProbeFail = true;
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#body')).toBeVisible();

    const marker = `兜底失败仍发送 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    // 读取失败按现有窗口语义降级：不补 @，但消息必须发出。
    expect(args.body).toBe(marker);
    await latestMessageId(base, humanToken, groupRoomId, marker);
  });

  test('fresh window ending with my own message neither probes nor mentions', async ({ page }) => {
    const mine = `我的最新一条 ${Date.now()}`;
    await callTool(base, humanToken, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: mine,
      invoke: [],
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: mine })).toBeVisible();
    const before = (await historyCalls(page)).filter((call) => call.probe).length;

    const marker = `自身上一条发送 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(marker);
    const after = (await historyCalls(page)).filter((call) => call.probe).length;
    expect(after).toBe(before);
  });

  test('lagging window with an old Agent mentions the newest Agent', async ({ page }) => {
    if (!agent || !newerAgent) throw new Error('fixture 未初始化');
    // 先制造“旧 Agent 在窗口末尾、新 Agent 是服务端最新”，并在导航前注入
    // 滞后窗口，避免依赖订阅刷新时序。
    const oldLatest = `旧 Agent 窗口末尾 ${Date.now()}`;
    await callTool(base, agent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: oldLatest,
      invoke: [],
    });
    const newLatest = `新 Agent 最新 ${Date.now()}`;
    await callTool(base, newerAgent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: newLatest,
      invoke: [],
    });
    await page.addInitScript(() => {
      (
        window as unknown as { __historyWindowMode?: 'trim' | 'empty' | null }
      ).__historyWindowMode = 'trim';
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: oldLatest })).toBeVisible();
    await expect(page.locator('#messages .msg').filter({ hasText: newLatest })).toHaveCount(0);

    const before = (await historyCalls(page)).filter((call) => call.probe).length;
    const marker = `滞后旧成员发送 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(`${marker}\n@${newerAgent.actor.name}`);
    const after = (await historyCalls(page)).filter((call) => call.probe).length;
    expect(after - before).toBe(1);
    await latestMessageId(base, humanToken, groupRoomId, marker);
  });

  test('lagging window whose newest message is mine probes once without mention', async ({ page }) => {
    if (!agent) throw new Error('fixture 未初始化');
    const oldLatest = `滞后窗口旧消息 ${Date.now()}`;
    await callTool(base, agent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: oldLatest,
      invoke: [],
    });
    const myLatest = `服务端最新是我 ${Date.now()}`;
    await callTool(base, humanToken, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: myLatest,
      invoke: [],
    });
    // 窗口去掉最新一条后停在旧 Agent，但 head 指向自己的最新消息。
    await page.addInitScript(() => {
      (
        window as unknown as { __historyWindowMode?: 'trim' | 'empty' | null }
      ).__historyWindowMode = 'trim';
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: oldLatest })).toBeVisible();
    await expect(page.locator('#messages .msg').filter({ hasText: myLatest })).toHaveCount(0);

    const before = (await historyCalls(page)).filter((call) => call.probe).length;
    const marker = `滞后最新自身发送 ${Date.now()}`;
    const args = await sendAndCapture(page, marker);
    expect(args.body).toBe(marker);
    const after = (await historyCalls(page)).filter((call) => call.probe).length;
    expect(after - before).toBe(1);
    await latestMessageId(base, humanToken, groupRoomId, marker);
  });

  test('refresh in flight with a stale window probes the newest Agent', async ({ page }) => {
    if (!agent || !newerAgent) throw new Error('fixture 未初始化');
    // 旧 Agent 的消息先进入页面窗口；此时 room.head_seq 与窗口最大 seq 一致。
    const oldLatest = `刷新竞态旧消息 ${Date.now()}`;
    await callTool(base, agent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: oldLatest,
      invoke: [],
    });
    await page.goto(`${base}/c/${groupRoomId}`);
    await expect(page.locator('#messages .msg').filter({ hasText: oldLatest })).toBeVisible();

    // 模拟恢复轮/慢刷新：房间详情与完整历史页延迟 5s。兜底读取（limit<=5）
    // 保持原速，验证的是“窗口不可信时仍会探测”，不是探测本身的超时路径。
    let heldRefreshes = 0;
    const pendingReleases = new Set<() => void>();
    const hold = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          pendingReleases.delete(done);
          resolve();
        };
        pendingReleases.add(done);
        setTimeout(done, 5_000);
      });
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      const name = request.headers()['mcp-name'];
      let limit: number | null = null;
      if (name === 'network_history_list') {
        try {
          const payload = request.postDataJSON() as {
            params?: { arguments?: { limit?: unknown } };
          };
          const value = payload.params?.arguments?.limit;
          limit = typeof value === 'number' ? value : null;
        } catch {
          limit = null;
        }
      }
      const refreshRead =
        name === 'network_room_get' || (name === 'network_history_list' && (limit ?? 50) > 5);
      try {
        if (refreshRead) {
          heldRefreshes += 1;
          await hold();
        }
        await route.continue();
      } catch {
        // 页面已关闭或客户端已取消。
      }
    });

    const newLatest = `刷新竞态新消息 ${Date.now()}`;
    await callTool(base, newerAgent.token, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: crypto.randomUUID(),
      room_id: groupRoomId,
      body: newLatest,
      invoke: [],
    });
    try {
      // 等到刷新请求真的在途：此时详情与历史都在重读，窗口停在旧消息。
      await expect.poll(() => heldRefreshes).toBeGreaterThan(0);
      await expect(page.locator('#messages .msg').filter({ hasText: newLatest })).toHaveCount(0);

      const before = (await historyCalls(page)).filter((call) => call.probe).length;
      const marker = `刷新竞态发送 ${Date.now()}`;
      const args = await sendAndCapture(page, marker);
      expect(args.body).toBe(`${marker}\n@${newerAgent.actor.name}`);
      expect(String(args.body)).not.toContain(`@${agent.actor.name}`);
      const after = (await historyCalls(page)).filter((call) => call.probe).length;
      expect(after - before).toBe(1);
      await latestMessageId(base, humanToken, groupRoomId, marker);
    } finally {
      for (const release of [...pendingReleases]) release();
    }
  });
});
