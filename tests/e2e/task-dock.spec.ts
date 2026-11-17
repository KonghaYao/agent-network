import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 浮动 Task dock：默认收起、展开/收起、布局稳定、预览、完成、分页与实时刷新。
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
  options: { taskRootId?: string; replyTo?: string; invoke?: string[] } = {},
): Promise<string> {
  const args: Record<string, unknown> = {
    request_id: requestId('e2e_task_msg'),
    client_message_id: requestId('e2e_task_client'),
    room_id: roomId,
    body,
    invoke: options.invoke ?? [],
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

async function createAgent(
  base: string,
  ownerToken: string,
  name: string,
): Promise<AgentCreated> {
  return callTool<AgentCreated>(base, ownerToken, 'network_agent_create', {
    request_id: requestId('e2e_task_agent'),
    name,
  });
}

async function createGroup(
  base: string,
  ownerToken: string,
  title: string,
  members: string[],
): Promise<string> {
  const created = await callTool<RoomCreated>(base, ownerToken, 'network_room_create', {
    request_id: requestId('e2e_task_room'),
    kind: 'group',
    title,
    members,
  });
  return created.room.room_id;
}

async function createTask(
  base: string,
  token: string,
  roomId: string,
  body: string,
  invoke: string[] = [],
): Promise<string> {
  const messageId = await sendMessage(base, token, roomId, body, { invoke });
  await markTask(base, token, roomId, messageId);
  return messageId;
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

/** dock 默认收起；展开后列表与面板操作才可见。 */
async function expandDock(page: Page) {
  await expect(page.locator('#task-dock-panel')).toBeHidden();
  await page.locator('#task-dock-toggle').click();
  await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'expanded');
  await expect(page.locator('#task-dock-panel')).toBeVisible();
}

test.describe('浮动 Task dock', () => {
  test('默认收起、点击展开/收起、悬浮预览、固定与完成确认', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 2, replies: 4 });
    const [oldRoot, newRoot] = fixture.roots;
    if (!oldRoot || !newRoot) throw new Error('Task fixture 缺少 root');

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-slot')).toHaveCount(1);
    // 默认收起：只显示入口和 total_count，列表项不可见。
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#task-dock-panel')).toBeHidden();
    await expect(page.locator('#task-dock-count')).toHaveText('2');
    await expect(page.locator('#task-dock-toggle')).toContainText('Task');
    await expect(page.locator('#task-dock .task-dock-item').first()).toBeHidden();

    await expandDock(page);
    await expect(page.locator('#task-dock-count')).toHaveText('2');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(2);

    const oldItem = itemLocator(page, oldRoot);
    await expect(oldItem).toContainText('待办');
    await expect(oldItem).toContainText('1 Agent');
    await expect(oldItem).toContainText('5 消息');

    // 再次点击收起：计数常驻，列表隐藏；点击重新展开。
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

  test('浮动定位不推移消息与输入框，Esc/外部点击收起', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 2 });

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-count')).toHaveText('2');
    await expect(page.locator('#composer')).toBeVisible();
    const message = page.locator('.msg').first();
    await expect(message).toBeVisible();

    const rect = async (locator: Locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error('布局测量缺少 boundingBox');
      return box;
    };
    const before = {
      message: await rect(message),
      composer: await rect(page.locator('#composer')),
      body: await rect(page.locator('#body')),
    };

    await expandDock(page);
    const panelBox = await rect(page.locator('#task-dock-panel'));
    const composerAfter = await rect(page.locator('#composer'));
    // 面板在输入框上方浮出，不覆盖 composer。
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(composerAfter.y - 4);
    const after = {
      message: await rect(message),
      composer: composerAfter,
      body: await rect(page.locator('#body')),
    };
    const close = (left: number, right: number) => Math.abs(left - right) <= 1;
    for (const key of ['message', 'composer', 'body'] as const) {
      expect(close(after[key].x, before[key].x)).toBe(true);
      expect(close(after[key].y, before[key].y)).toBe(true);
      expect(close(after[key].width, before[key].width)).toBe(true);
      expect(close(after[key].height, before[key].height)).toBe(true);
    }

    // Esc 收起并把焦点还给入口。
    await page.keyboard.press('Escape');
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#task-dock-panel')).toBeHidden();
    await expect(page.locator('#task-dock-toggle')).toBeFocused();

    // 点击面板外部收起。
    await page.locator('#task-dock-toggle').click();
    await expect(page.locator('#task-dock-panel')).toBeVisible();
    await page.locator('#title').click();
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#task-dock-panel')).toBeHidden();
  });

  test('入口展开前后位置不变，同一坐标二次点击立即收起', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 2 });

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-slot')).toHaveCount(1);
    const toggle = page.locator('#task-dock-toggle');
    const before = await toggle.boundingBox();
    if (!before) throw new Error('入口缺少 boundingBox');
    const point = {
      x: before.x + before.width / 2,
      y: before.y + before.height / 2,
    };

    await page.mouse.click(point.x, point.y);
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'expanded');
    await expect(page.locator('#task-dock-panel')).toBeVisible();

    // 面板向上浮出，入口盒子完全不移动。
    const after = await toggle.boundingBox();
    expect(after).toEqual(before);
    const panel = await page.locator('#task-dock-panel').boundingBox();
    const head = await page.locator('.task-dock-head').boundingBox();
    if (!panel || !head) throw new Error('面板或入口缺少 boundingBox');
    expect(panel.y + panel.height).toBeLessThanOrEqual(head.y);

    // 展开动作不让静止指针自动打开 hover 预览，入口中心仍是命中目标。
    await page.waitForTimeout(500);
    await expect(page.locator('.task-preview-popover')).toHaveCount(0);
    expect(
      await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit instanceof Element && hit.closest('#task-dock-toggle') !== null;
      }, point),
    ).toBe(true);

    // 同一坐标立即再次点击必须收起，而不是被预览拦截。
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#task-dock-panel')).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('Task 行 Esc 先关预览再收起，并回焦入口', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 1 });
    const rootId = fixture.roots[0];
    if (!rootId) throw new Error('Task fixture 缺少 root');

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expandDock(page);
    const trigger = page.locator('#task-dock .task-dock-item-trigger').first();
    const popover = page.locator(`#task-preview-${rootId}`);

    // 预览未打开：焦点在 Task 行时 Esc 直接收起，并把焦点还给入口。
    await trigger.focus();
    await expect(popover).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#task-dock-panel')).toBeHidden();
    await expect(page.locator('#task-dock-toggle')).toBeFocused();

    // 预览固定打开：第一次 Esc 只关预览，第二次才收起面板。
    await expandDock(page);
    await trigger.focus();
    await trigger.press('Enter');
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'expanded');
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#task-dock-toggle')).toBeFocused();
  });

  test('展开 dock 不移动可见的「回到最新」', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 18 });

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#task-dock-count')).toHaveText('18');
    const messages = page.locator('#messages');
    await expect(page.locator('#messages .msg')).toHaveCount(18);
    // 等首屏 keepPinned 的 rAF 结束，避免它把列表重新拉回底部。
    await page.waitForTimeout(300);
    // 离开底部让「回到最新」出现，再展开 dock。
    await messages.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });
    const jump = page.locator('#jump-latest');
    await expect(jump).toBeVisible();
    const before = await jump.boundingBox();
    if (!before) throw new Error('「回到最新」缺少 boundingBox');

    await expandDock(page);
    const after = await jump.boundingBox();
    expect(after).toEqual(before);
    expect(
      await page.evaluate(() => {
        const button = document.getElementById('jump-latest');
        if (!button) return false;
        const box = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        );
        return hit instanceof Element && hit.closest('#jump-latest') !== null;
      }),
    ).toBe(true);
  });

  test('完成失败保留条目，重试沿用 request_id', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix);
    const rootId = fixture.roots[0];
    if (!rootId) throw new Error('Task fixture 缺少 root');

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expandDock(page);
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
    await expandDock(page);
    await expect(page.locator('#task-dock-error')).toContainText('列表读取失败（模拟）');
    await expect(page.locator('#task-dock-count')).toHaveText('…');
    await expect(page.locator('#task-dock-count')).not.toHaveText('0');

    await page.unroute('**/mcp');
    await page.locator('#task-dock-error button').click();
    await expect(page.locator('#task-dock-count')).toHaveText('1');

    // 展开时完成唯一 Task：保留面板并显示空态，不自动收起。
    await page.locator('#task-dock .task-dock-complete').click();
    await page.locator('#task-complete-confirm').click();
    await expect(page.locator('#task-dock-count')).toHaveText('0');
    await expect(page.locator('#task-dock-empty')).toContainText('暂无未完成 Task');
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'expanded');
    await expect(page.locator('#task-dock-panel')).toBeVisible();

    // 用户主动关闭后入口消失，不留 `Task 0`。
    await page.locator('#task-dock-empty-close').click();
    await expect(page.locator('#task-dock')).toHaveCount(0);
  });

  test('N=0 且收起时不渲染入口与占位', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 0 });

    await login(page, base, fixture.owner.token);
    await page.goto(`${base}/c/${fixture.roomId}`);
    await expect(page.locator('#title')).toHaveText(`Task Group ${suffix}`);
    await expect(page.locator('#task-dock')).toHaveCount(0);
    await expect(page.locator('#task-dock-slot')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Task 0');
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
    await expandDock(page);
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
    await expandDock(page);
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
    await expandDock(page);
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
    await expandDock(page);
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
    await expandDock(page);
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(2);
    await expect(page.locator('#task-dock')).not.toContainText('迟到的 A Task 不得回填');
    await page.waitForTimeout(2_000);
    expect(delayedSettled).toBe(true);
    await expect(page.locator('#task-dock-count')).toHaveText('2');
    await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(2);
    await expect(page.locator('#task-dock')).not.toContainText('迟到的 A Task 不得回填');
  });
});

test.describe('Task dock 询问进度', () => {
  test('复原根消息的 @，引用根消息且不自动发送', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Ask Owner ${suffix}`);
    const agentA = await createAgent(base, owner.token, `Ask Agent A ${suffix}`);
    const agentB = await createAgent(base, owner.token, `Ask Agent B ${suffix}`);
    const roomId = await createGroup(base, owner.token, `Ask Group ${suffix}`, [
      agentA.actor_id,
      agentB.actor_id,
    ]);
    const rootId = await createTask(
      base,
      owner.token,
      roomId,
      `@${agentA.name} @${agentB.name} 请同步交付里程碑`,
      [agentA.actor_id, agentB.actor_id],
    );
    await sendMessage(base, agentA.token, roomId, 'A 正在核对', { taskRootId: rootId });
    await sendMessage(base, agentB.token, roomId, 'B 正在核对', { taskRootId: rootId });

    const sends: string[] = [];
    page.on('request', (request) => {
      if (request.headers()['mcp-name'] === 'network_message_send') {
        sends.push(request.postData() ?? '');
      }
    });

    await openRoom(page, base, owner.token, roomId);
    await expandDock(page);
    const item = itemLocator(page, rootId);
    await expect(item.locator('.task-dock-ask')).toBeVisible();
    await item.locator('.task-dock-ask').click();

    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#composer-reply')).toBeVisible();
    await expect(page.locator('#composer-reply')).toContainText('请同步交付里程碑');
    await expect(page.locator('#body')).toBeFocused();
    await expect
      .poll(() => page.locator('#body').inputValue())
      .toContain('这个 task 现在进度如何？');

    const value = await page.locator('#body').inputValue();
    expect(value.trim().endsWith('这个 task 现在进度如何？')).toBe(true);

    // 复原顺序与服务端 mentions 顺序一致，两个 Agent 都保留。
    interface HistoryPage {
      items: { message_id: string; mentions: { actor_id: string; kind: string }[] }[];
    }
    const history = await callTool<HistoryPage>(
      base,
      owner.token,
      'network_history_list',
      { room_id: roomId, direction: 'before', limit: 50 },
    );
    const root = history.items.find((entry) => entry.message_id === rootId);
    expect(root).toBeTruthy();
    const names = new Map([
      [agentA.actor_id, agentA.name],
      [agentB.actor_id, agentB.name],
      [owner.actor_id, owner.name],
    ]);
    const expected = (root?.mentions ?? [])
      .map((mention) => names.get(mention.actor_id))
      .filter((name): name is string => Boolean(name));
    expect(expected).toHaveLength(2);
    const positions = expected.map((name) => value.indexOf(`@${name}`));
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));

    await page.waitForTimeout(300);
    expect(sends).toHaveLength(0);
    await expect(page.locator('#body')).toHaveValue(value);
  });

  test('无根 @ 时回退最近参与的 Agent，预览入口共用同一处理', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Ask Latest Owner ${suffix}`);
    const agentA = await createAgent(base, owner.token, `Ask Latest A ${suffix}`);
    const agentB = await createAgent(base, owner.token, `Ask Latest B ${suffix}`);
    const roomId = await createGroup(base, owner.token, `Ask Latest ${suffix}`, [
      agentA.actor_id,
      agentB.actor_id,
    ]);
    const rootId = await createTask(base, owner.token, roomId, '请同步交付里程碑');
    await sendMessage(base, agentA.token, roomId, 'A 较早回复', { taskRootId: rootId });
    await sendMessage(base, agentB.token, roomId, 'B 最近回复', { taskRootId: rootId });

    await openRoom(page, base, owner.token, roomId);
    await expandDock(page);
    const trigger = itemLocator(page, rootId).locator('.task-dock-item-trigger');
    await trigger.click();
    const popover = page.locator(`#task-preview-${rootId}`);
    await expect(popover).toBeVisible();
    await popover.locator('.task-preview-ask').click();

    await expect(page.locator('#composer-reply')).toBeVisible();
    await expect(page.locator('#composer-reply')).toContainText('请同步交付里程碑');
    await expect(page.locator('#body')).toBeFocused();
    await expect
      .poll(() => page.locator('#body').inputValue())
      .toContain(`@${agentB.name} 这个 task 现在进度如何？`);
    const value = await page.locator('#body').inputValue();
    expect(value).toContain(`@${agentB.name} 这个 task 现在进度如何？`);
    expect(value).not.toContain(`@${agentA.name}`);
  });

  test('没有 Agent 参与时不渲染询问入口', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Ask Human Owner ${suffix}`);
    const bystander = await createAgent(base, owner.token, `Ask Bystander ${suffix}`);
    const roomId = await createGroup(base, owner.token, `Ask Humans ${suffix}`, [
      bystander.actor_id,
    ]);
    const rootId = await createTask(base, owner.token, roomId, '人类之间的 Task');
    await sendMessage(base, owner.token, roomId, '人类之间的后续回复', {
      taskRootId: rootId,
    });

    await openRoom(page, base, owner.token, roomId);
    await expandDock(page);
    const item = itemLocator(page, rootId);
    await expect(item).toBeVisible();
    await expect(item.locator('.task-dock-ask')).toHaveCount(0);
    await item.locator('.task-dock-item-trigger').click();
    await expect(page.locator(`#task-preview-${rootId}`)).toBeVisible();
    await expect(page.locator(`#task-preview-${rootId} .task-preview-ask`)).toHaveCount(0);
  });

  test('只读房间不渲染询问入口', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { replies: 1 });
    await callTool(base, fixture.owner.token, 'network_room_dissolve', {
      request_id: requestId('e2e_task_dissolve'),
      room_id: fixture.roomId,
    });

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#room-archive-banner')).toBeVisible();
    await expandDock(page);
    const rootId = fixture.roots[0];
    if (!rootId) throw new Error('Task fixture 缺少 root');
    const item = itemLocator(page, rootId);
    await expect(item.locator('.task-dock-ask')).toHaveCount(0);
    await item.locator('.task-dock-item-trigger').click();
    await expect(page.locator(`#task-preview-${rootId}`)).toBeVisible();
    await expect(page.locator(`#task-preview-${rootId} .task-preview-ask`)).toHaveCount(0);
  });

  test('已有草稿保留并追加一行，不被静默清空', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { replies: 1 });
    const rootId = fixture.roots[0];
    if (!rootId) throw new Error('Task fixture 缺少 root');

    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await page.locator('#body').fill('我已经写了一半的草稿');
    await expandDock(page);
    await itemLocator(page, rootId).locator('.task-dock-ask').click();

    await expect(page.locator('#body')).toBeFocused();
    await expect
      .poll(() => page.locator('#body').inputValue())
      .toContain(`@${fixture.agent.name} 这个 task 现在进度如何？`);
    const value = await page.locator('#body').inputValue();
    expect(value.startsWith('我已经写了一半的草稿\n')).toBe(true);
    expect(value).toContain(`@${fixture.agent.name} 这个 task 现在进度如何？`);
    await expect(page.locator('#composer-reply')).toBeVisible();
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
    // 默认只显示入口，入口触控高度 >= 44px。
    await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
    await expect(page.locator('#task-dock-panel')).toBeHidden();
    const collapsedDock = await page.locator('#task-dock').boundingBox();
    expect(collapsedDock?.width ?? 0).toBeLessThanOrEqual(390);
    const toggleBox = await page.locator('#task-dock-toggle').boundingBox();
    expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await expandDock(page);
    const dockBox = await page.locator('#task-dock').boundingBox();
    expect(dockBox?.width ?? 0).toBeLessThanOrEqual(390);
    const composerBox = await page.locator('#composer').boundingBox();
    const panelBox = await page.locator('#task-dock-panel').boundingBox();
    expect((panelBox?.y ?? 0) + (panelBox?.height ?? 0)).toBeLessThanOrEqual(
      (composerBox?.y ?? 0) - 2,
    );
    const completeBox = await page
      .locator('#task-dock .task-dock-complete')
      .boundingBox();
    expect(completeBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    const askBox = await page.locator('#task-dock .task-dock-ask').boundingBox();
    expect(askBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(askBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    const trigger = page.locator('#task-dock .task-dock-item-trigger');
    await trigger.tap();
    const popover = page.locator(`#task-preview-${fixture.roots[0]}`);
    await expect(popover).toBeVisible();
    const popoverAskBox = await popover.locator('.task-preview-ask').boundingBox();
    expect(popoverAskBox?.height ?? 0).toBeGreaterThanOrEqual(44);
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
