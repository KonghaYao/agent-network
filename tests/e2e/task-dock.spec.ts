import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 常驻 Task dock：列表、预览、完成、分页与实时刷新。
 *
 * 服务端由 global-setup 启动；本文件只通过真实 MCP 调用创建 fixture，
 * 失败场景用请求级 mock，不替换成功响应。
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
            name: 'agent-network-task-dock-e2e',
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

interface RegisteredHuman {
  actor_id: string;
  name: string;
  token: string;
}

interface AgentCreated {
  actor_id: string;
  name: string;
  token: string;
}

interface RoomCreated {
  room: { room_id: string };
}

interface Sent {
  message: { message_id: string };
}

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

async function registerHuman(base: string, name: string): Promise<RegisteredHuman> {
  const token = crypto.randomUUID();
  const actor = await callTool<{ actor_id: string; name: string }>(
    base,
    token,
    'network_register',
    { request_id: requestId('e2e_task_reg'), kind: 'human', name },
  );
  return { ...actor, token };
}

async function sendMessage(
  base: string,
  token: string,
  roomId: string,
  body: string,
  options: { taskRootId?: string; replyTo?: string } = {},
): Promise<string> {
  const args: Record<string, unknown> = {
    request_id: requestId('e2e_task_msg'),
    client_message_id: requestId('e2e_task_client'),
    room_id: roomId,
    body,
    invoke: [],
  };
  if (options.taskRootId) args.task_root_id = options.taskRootId;
  if (options.replyTo) args.reply_to = options.replyTo;
  const sent = await callTool<Sent>(base, token, 'network_message_send', args);
  return sent.message.message_id;
}

async function markTask(
  base: string,
  token: string,
  roomId: string,
  messageId: string,
): Promise<void> {
  await callTool(base, token, 'network_task_mark', {
    request_id: requestId('e2e_task_mark'),
    room_id: roomId,
    message_id: messageId,
  });
}

interface TaskFixture {
  owner: RegisteredHuman;
  agent: AgentCreated;
  roomId: string;
  roots: string[];
}

async function setupTaskRoom(
  base: string,
  suffix: string,
  options: { roots?: number; replies?: number } = {},
): Promise<TaskFixture> {
  const owner = await registerHuman(base, `Task Owner ${suffix}`);
  const agent = await callTool<AgentCreated>(
    base,
    owner.token,
    'network_agent_create',
    { request_id: requestId('e2e_task_agent'), name: `Task Agent ${suffix}` },
  );
  const created = await callTool<RoomCreated>(base, owner.token, 'network_room_create', {
    request_id: requestId('e2e_task_room'),
    kind: 'group',
    title: `Task Group ${suffix}`,
    members: [agent.actor_id],
  });
  const roomId = created.room.room_id;
  const roots: string[] = [];
  const count = options.roots ?? 1;
  for (let index = 0; index < count; index += 1) {
    const rootId = await sendMessage(
      base,
      owner.token,
      roomId,
      `待办 ${suffix} #${index + 1}：核对交付里程碑`,
    );
    await markTask(base, owner.token, roomId, rootId);
    for (let reply = 0; reply < (options.replies ?? 0); reply += 1) {
      await sendMessage(
        base,
        agent.token,
        roomId,
        `Agent 回复 ${reply + 1}：已完成核对`,
        { taskRootId: rootId },
      );
    }
    roots.push(rootId);
  }
  return { owner, agent, roomId, roots };
}

function itemLocator(page: Page, rootId: string) {
  return page.locator(`#task-dock .task-dock-item[data-task-root="${rootId}"]`);
}

const STREAM_ACK_FRAME = `data: ${JSON.stringify({
  jsonrpc: '2.0',
  method: 'notifications/subscriptions/acknowledged',
  params: { notifications: { resourceSubscriptions: ['agentnet://stream'] } },
})}\n\n`;

function toolErrorBody(id: unknown, code: string, message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
    },
  });
}

async function openRoom(page: Page, base: string, token: string, roomId: string) {
  await login(page, base, token);
  await page.goto(`${base}/c/${roomId}`);
  await expect(page.locator('#task-dock')).toBeVisible();
}

test.describe('常驻 Task dock', () => {
  test('展开/折叠、悬浮预览、固定与完成确认', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 2, replies: 4 });
    const [oldRoot, newRoot] = fixture.roots;
    if (!oldRoot || !newRoot) throw new Error('Task fixture 缺少 root');

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-count')).toHaveText('2');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(2);
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'expanded');

    const oldItem = itemLocator(page, oldRoot);
    await expect(oldItem).toContainText('待办');
    await expect(oldItem).toContainText('1 Agent');
    await expect(oldItem).toContainText('5 消息');

    // 折叠后计数常驻，列表隐藏。
    await page.locator('#task-dock-toggle').click();
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#task-dock-panel')).toBeHidden();
    await expect(page.locator('#task-dock-count')).toHaveText('2');
    await page.locator('#task-dock-toggle').click();
    await expect(page.locator('#task-dock-panel')).toBeVisible();

    const trigger = oldItem.locator('.task-dock-item-trigger');
    const popover = page.locator(`#task-preview-${oldRoot}`);
    await trigger.hover();
    await expect(popover).toBeVisible();
    // 悬浮不移动焦点。
    expect(
      await page.evaluate(
        (id) => document.activeElement?.closest(`#${id}`) === null,
        `task-preview-${oldRoot}`,
      ),
    ).toBe(true);
    await popover.hover();
    await page.waitForTimeout(350);
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('Agent 回复');
    await expect(popover.locator('.task-preview-recent')).toHaveCount(3);
    await page.locator('#title').hover();
    await expect(popover).toBeHidden();

    // 悬浮后点击固定；Esc 关闭并把焦点还给触发项。
    await trigger.hover();
    await expect(popover).toBeVisible();
    await trigger.click();
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();

    // Enter 固定打开；点击外部关闭后仍回到触发项。
    await trigger.press('Enter');
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(popover).toBeVisible();
    await page.locator('#title').click();
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();

    // 固定打开后查看全部，复用现有 Trace 抽屉。
    await trigger.click();
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: /查看全部 5 条消息/ }).click();
    await expect(page.locator('#task-trace-drawer')).toBeVisible();
    await expect(page.locator('#task-trace-items .task-trace-item')).not.toHaveCount(0);
    await page.locator('#task-trace-close').click();
    await expect(trigger).toBeFocused();

    // 完成确认先取消，条目保留。
    const complete = itemLocator(page, newRoot).locator('.task-dock-complete');
    await complete.click();
    await expect(page.locator('#task-complete-dialog')).toBeVisible();
    await page.locator('#task-complete-cancel').click();
    await expect(page.locator('#task-complete-dialog')).toBeHidden();
    await expect(itemLocator(page, newRoot)).toHaveCount(1);
    await expect(complete).toBeFocused();

    // 确认成功后移除该行并更新计数；焦点回到 dock 入口。
    await complete.click();
    await page.locator('#task-complete-confirm').click();
    await expect(page.locator('#task-complete-dialog')).toBeHidden();
    await expect(itemLocator(page, newRoot)).toHaveCount(0);
    await expect(page.locator('#task-dock-count')).toHaveText('1');
    await expect(page.locator('#task-dock-toggle')).toBeFocused();

    const completed = await callTool<{ items: { root_message_id: string; status: string }[] }>(
      base,
      fixture.owner.token,
      'network_task_list',
      { room_id: fixture.roomId, status: 'completed', limit: 20 },
    );
    expect(completed.items.some((item) => item.root_message_id === newRoot)).toBe(true);
  });

  test('完成失败保留条目，重试沿用 request_id', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix);
    const rootId = fixture.roots[0];
    if (!rootId) throw new Error('Task fixture 缺少 root');

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    const requestIds: string[] = [];
    let attempts = 0;
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] !== 'network_task_complete') {
        await route.continue();
        return;
      }
      const parsed = JSON.parse(route.request().postData() ?? '{}') as {
        id?: unknown;
        params?: { arguments?: { request_id?: string } };
      };
      const requestIdValue = parsed.params?.arguments?.request_id;
      if (requestIdValue) requestIds.push(requestIdValue);
      attempts += 1;
      if (attempts > 1) {
        // 重试交给真实服务端：使用同一 request_id 提交并验证列表移除。
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: 'INTERNAL',
                  message: '完成失败（模拟）',
                }),
              },
            ],
          },
        }),
      });
    });

    await page.locator('#task-dock .task-dock-complete').click();
    await page.locator('#task-complete-confirm').click();
    await expect(page.locator('#task-complete-error')).toContainText('完成失败（模拟）');
    await expect(page.locator('#task-complete-dialog')).toBeVisible();
    await expect(itemLocator(page, rootId)).toHaveCount(1);
    await expect(page.locator('#task-dock-count')).toHaveText('1');
    await expect(page.locator('#task-complete-confirm')).toHaveText('重试');

    await page.locator('#task-complete-confirm').click();
    await expect(page.locator('#task-complete-dialog')).toBeHidden();
    await expect(itemLocator(page, rootId)).toHaveCount(0);
    await expect(page.locator('#task-dock-count')).toHaveText('0');
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  test('空态与加载失败不伪装为 0', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix);

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-count')).toHaveText('1');

    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] !== 'network_task_list') {
        await route.continue();
        return;
      }
      const body = route.request().postData() ?? '{}';
      const parsed = JSON.parse(body) as { id?: unknown };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: 'INTERNAL',
                  message: '列表读取失败（模拟）',
                }),
              },
            ],
          },
        }),
      });
    });

    await page.reload();
    await expect(page.locator('#task-dock')).toBeVisible();
    await expect(page.locator('#task-dock-error')).toContainText('列表读取失败（模拟）');
    await expect(page.locator('#task-dock-count')).toHaveText('…');
    await expect(page.locator('#task-dock-count')).not.toHaveText('0');

    await page.unroute('**/mcp');
    await page.locator('#task-dock-error button').click();
    await expect(page.locator('#task-dock-count')).toHaveText('1');

    // 完成唯一 Task 后显示空态 `Task 0 / 暂无未完成 Task`。
    await page.locator('#task-dock .task-dock-complete').click();
    await page.locator('#task-complete-confirm').click();
    await expect(page.locator('#task-dock-count')).toHaveText('0');
    await expect(page.locator('#task-dock-empty')).toHaveText('暂无未完成 Task');
  });

  test('归档只读时禁用完成', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix);
    await callTool(base, fixture.owner.token, 'network_room_dissolve', {
      request_id: requestId('e2e_task_dissolve'),
      room_id: fixture.roomId,
    });

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#room-archive-banner')).toBeVisible();
    await expect(page.locator('#task-dock-count')).toHaveText('1');
    await expect(page.locator('#task-dock .task-dock-complete')).toBeDisabled();
  });

  test('分页加载更多与实时刷新', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 21 });
    const targetRoot = fixture.roots[0];
    if (!targetRoot) throw new Error('Task fixture 缺少 root');

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-count')).toHaveText('21');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(20);
    await page.locator('#task-dock-load-more').click();
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(21);
    await expect(page.locator('#task-dock-load-more')).toBeHidden();

    // 打开 Trace 后由其他成员发消息：房间消息事件同时刷新已打开的 Trace。
    await itemLocator(page, targetRoot).locator('.task-dock-item-trigger').click();
    await page.getByRole('button', { name: /查看全部 1 条消息/ }).click();
    await expect(page.locator('#task-trace-drawer')).toBeVisible();
    await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(1);

    await sendMessage(base, fixture.agent.token, fixture.roomId, '新增处理回复', {
      taskRootId: targetRoot,
    });
    await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(2, {
      timeout: 10_000,
    });
    // 列表从首页重建后，第二页的旧游标与旧页不再保留。
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(20, {
      timeout: 10_000,
    });
    await expect(itemLocator(page, targetRoot)).toHaveCount(0);
    await expect(page.locator('#task-dock-count')).toHaveText('21');
    await page.locator('#task-trace-close').click();

    // 重新加载第二页即可看到新回复计数。
    await page.locator('#task-dock-load-more').click();
    await expect(itemLocator(page, targetRoot)).toContainText('2 消息', {
      timeout: 10_000,
    });

    // 其他成员完成 Task：task.updated 驱动列表与已打开的 Trace 刷新。
    await itemLocator(page, targetRoot).locator('.task-dock-item-trigger').click();
    await page.getByRole('button', { name: /查看全部 2 条消息/ }).click();
    await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(2);
    await callTool(base, fixture.agent.token, 'network_task_complete', {
      request_id: requestId('e2e_task_complete'),
      room_id: fixture.roomId,
      root_message_id: targetRoot,
    });
    await expect(page.locator('#task-trace-drawer')).toBeVisible();
    await expect(page.locator('#task-trace-meta')).toContainText('已完成', {
      timeout: 10_000,
    });
    await page.locator('#task-trace-close').click();
    await expect(itemLocator(page, targetRoot)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#task-dock-count')).toHaveText('20', { timeout: 10_000 });
  });

  test('过期游标自动重建首页并提示', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 21 });

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-count')).toHaveText('21');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(20);

    let cursorRequests = 0;
    let rebuildRequests = 0;
    let expired = false;
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      if (request.headers()['mcp-name'] !== 'network_task_list') {
        await route.continue();
        return;
      }
      const parsed = JSON.parse(request.postData() ?? '{}') as {
        id?: unknown;
        params?: { arguments?: { cursor?: unknown } };
      };
      const cursor = parsed.params?.arguments?.cursor;
      if (typeof cursor !== 'string' || cursor.length === 0) {
        rebuildRequests += 1;
        await route.continue();
        return;
      }
      cursorRequests += 1;
      if (expired) {
        await route.continue();
        return;
      }
      expired = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: toolErrorBody(
          parsed.id,
          'CURSOR_EXPIRED',
          'Task 列表已变化，请重新加载',
        ),
      });
    });

    // 第二页返回过期游标：自动回首页一次，并保留可继续翻页的新游标。
    await page.locator('#task-dock-load-more').click();
    await expect(page.locator('#task-dock-notice')).toHaveText(
      'Task 列表已更新，已重新加载首页',
    );
    await expect(page.locator('#task-dock-count')).toHaveText('21');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(20);
    await expect(page.locator('#task-dock-load-more-error')).toHaveCount(0);
    await expect(page.locator('#task-dock')).not.toContainText('刷新失败');
    expect(cursorRequests).toBe(1);
    expect(rebuildRequests).toBeGreaterThanOrEqual(1);

    await page.locator('#task-dock-load-more').click();
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(21);
    expect(cursorRequests).toBe(2);
  });

  test('重连 ack 清空 Task 列表与 Trace 缓存后重新鉴权', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 1 });
    const rootId = fixture.roots[0];
    if (!rootId) throw new Error('Task fixture 缺少 root');

    let releaseStream: (() => void) | null = null;
    const streamGate = new Promise<void>((release) => {
      releaseStream = release;
    });
    let listenCount = 0;
    let failTaskReads = false;
    let listRequests = 0;
    let traceRequests = 0;

    // 首页先正常加载；路由只接管进入房间后的第一条订阅流。
    await login(page, base, fixture.owner.token);
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      const method = request.headers()['mcp-method'];
      if (method === 'subscriptions/listen') {
        listenCount += 1;
        if (listenCount === 1) {
          // 首条连接由测试提供，等首屏数据就绪后再发两个 ack：
          // 第一个是首次 ack，第二个在同一条流里触发 reconnect 分支。
          await streamGate;
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: `${STREAM_ACK_FRAME}${STREAM_ACK_FRAME}`,
          });
          return;
        }
        await route.continue();
        return;
      }
      const name = request.headers()['mcp-name'];
      if (name === 'network_task_list') listRequests += 1;
      if (name === 'network_task_trace') traceRequests += 1;
      if (failTaskReads && (name === 'network_task_list' || name === 'network_task_trace')) {
        const parsed = JSON.parse(request.postData() ?? '{}') as { id?: unknown };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: toolErrorBody(parsed.id, 'INTERNAL', '重连后读取失败（模拟）'),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${base}/c/${fixture.roomId}`);
    await expect(page.locator('#task-dock')).toBeVisible();
    await expect(page.locator('#task-dock-count')).toHaveText('1');
    await expect(itemLocator(page, rootId)).toHaveCount(1);

    await itemLocator(page, rootId).locator('.task-dock-item-trigger').click();
    await page.getByRole('button', { name: /查看全部 1 条消息/ }).click();
    await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(1);

    const listBefore = listRequests;
    const traceBefore = traceRequests;
    failTaskReads = true;
    releaseStream!();

    // reset 而不是 invalidate：旧数据立即丢弃，重读失败时不能继续展示旧列表。
    await expect(page.locator('#task-dock-error')).toContainText(
      '重连后读取失败（模拟）',
      { timeout: 10_000 },
    );
    await expect(page.locator('#task-dock-count')).toHaveText('…');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(0);
    await expect(page.locator('#task-trace-status')).toContainText(
      '重连后读取失败（模拟）',
      { timeout: 10_000 },
    );
    await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(0);
    expect(listRequests).toBeGreaterThan(listBefore);
    expect(traceRequests).toBeGreaterThan(traceBefore);
  });

  test('切房后迟到的列表响应不回填', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const roomA = await setupTaskRoom(base, `${suffix}a`, { roots: 1 });
    const owner = roomA.owner;
    const createdB = await callTool<RoomCreated>(base, owner.token, 'network_room_create', {
      request_id: requestId('e2e_task_room_b'),
      kind: 'group',
      title: `Task Room B ${suffix}`,
      members: [roomA.agent.actor_id],
    });
    const roomBId = createdB.room.room_id;
    for (let index = 0; index < 2; index += 1) {
      const rootId = await sendMessage(
        base,
        owner.token,
        roomBId,
        `B 房间待办 ${index + 1}`,
      );
      await markTask(base, owner.token, roomBId, rootId);
    }

    let delayedSettled = false;
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      if (request.headers()['mcp-name'] !== 'network_task_list') {
        await route.continue();
        return;
      }
      const body = request.postData() ?? '{}';
      const parsed = JSON.parse(body) as {
        id?: unknown;
        params?: { arguments?: { room_id?: string } };
      };
      if (parsed.params?.arguments?.room_id !== roomA.roomId) {
        await route.continue();
        return;
      }
      const rootId = roomA.roots[0];
      if (!rootId) throw new Error('房间 A 缺少 Task root');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
      delayedSettled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            structuredContent: {
              items: [
                {
                  root_message_id: rootId,
                  room_id: roomA.roomId,
                  preview: '迟到的 A Task 不得回填',
                  root_sender_id: owner.actor_id,
                  root_sender_name: owner.name,
                  root_sender_kind: 'human',
                  root_created_seq: '1',
                  root_created_at: String(Date.now()),
                  participants: [],
                  participant_count: 0,
                  message_count: 1,
                  status: 'open',
                  completed_at: null,
                  completed_by: null,
                  can_unmark: true,
                  can_complete: true,
                  latest_activity_seq: '1',
                  latest_activity_at: String(Date.now()),
                  latest_message_id: rootId,
                  recent_messages: [],
                },
              ],
              total_count: 1,
              next_cursor: null,
              has_more: false,
              snapshot: '1',
              authorization: {
                policy_revision: 0,
                history_from_seq: '0',
                member_generation: '0',
              },
            },
          },
        }),
      });
    });

    const requestSeen = page.waitForRequest(
      (request) =>
        request.headers()['mcp-name'] === 'network_task_list' &&
        (request.postData() ?? '').includes(roomA.roomId),
    );
    await openRoom(page, base, owner.token, roomA.roomId);
    await requestSeen;
    await page.locator('#room-filter-group').click();
    await page.locator(`#room-list a[data-room-id="${roomBId}"]`).click();
    await expect(page.locator('#title')).toHaveText(`Task Room B ${suffix}`);
    await expect(page.locator('#task-dock-count')).toHaveText('2');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(2);
    await expect(page.locator('#task-dock')).not.toContainText('迟到的 A Task 不得回填');
    await page.waitForTimeout(2_000);
    expect(delayedSettled).toBe(true);
    await expect(page.locator('#task-dock-count')).toHaveText('2');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(2);
    await expect(page.locator('#task-dock')).not.toContainText('迟到的 A Task 不得回填');
  });
});

test.describe('mobile Task dock', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('点按打开预览且单列不溢出', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 1, replies: 1 });

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-count')).toHaveText('1');
    const dockBox = await page.locator('#task-dock').boundingBox();
    expect(dockBox?.width ?? 0).toBeLessThanOrEqual(390);
    const completeBox = await page
      .locator('#task-dock .task-dock-complete')
      .boundingBox();
    expect(completeBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    const trigger = page.locator('#task-dock .task-dock-item-trigger');
    await trigger.tap();
    const popover = page.locator(`#task-preview-${fixture.roots[0]}`);
    await expect(popover).toBeVisible();
    const popoverBox = await popover.boundingBox();
    expect(popoverBox?.width ?? 0).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();

    const results = await new AxeBuilder({ page })
      .include('#task-dock')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      results.violations.filter(
        (item) => item.impact === 'critical' || item.impact === 'serious',
      ),
    ).toEqual([]);
  });
});
