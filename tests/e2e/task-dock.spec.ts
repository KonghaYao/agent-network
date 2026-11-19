import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expectNoHorizontalOverflow, LONG_TASK_URL } from './fixtures/task-layout';
import { semanticColor } from './fixtures/semantic-colors';
import { expectTaskDetailStyle } from './fixtures/task-detail-style';
import { taskTimeLabel } from '../../src/web/features/tasks/task-format';

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
  test('Task 时间：24 小时内相对，跨日仍相对，较早日期保留月日和时分', () => {
    const now = new Date(2026, 10, 18, 0, 10).getTime();
    const original = Date.now;
    Date.now = () => now;
    try {
      expect(taskTimeLabel(String(now - 3 * 60_000))).toBe('3 分钟前');
      expect(taskTimeLabel(String(now - 60 * 60_000))).toBe('1 小时前');
      expect(taskTimeLabel(String(new Date(2026, 10, 16, 16, 10).getTime()))).toBe('11月16日 16:10');
      expect(taskTimeLabel(String(now))).toBe('刚刚');
      expect(taskTimeLabel('invalid')).toBe('');
    } finally {
      Date.now = original;
    }
  });
  for (const width of [390, 1280]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`Task 数据文案去重 ${width}/${colorScheme}`, async ({ page }) => {
        const base = await baseUrl();
        const fixture = await setupTaskRoom(base, `detail-${width}-${colorScheme}`, { roots: 0 });
        const second = await createAgent(base, fixture.owner.token, '第二个协作 Agent 名称很长但只占一行');
        const roomId = await createGroup(base, fixture.owner.token, 'Task 数据规范', [fixture.agent.actor_id, second.actor_id]);
        const rootId = await createTask(base, fixture.owner.token, roomId, '统一 Task 细节');
        await sendMessage(base, fixture.agent.token, roomId, '第一条回复', { taskRootId: rootId });
        await sendMessage(base, second.token, roomId, '第二条回复', { taskRootId: rootId });
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme });
        await openRoom(page, base, fixture.owner.token, roomId);
        const bar = page.locator(`.task-bar[data-task-root="${rootId}"]`);
        await expect(bar.locator('.task-bar-count')).toHaveText('3 消息');
        await expect(bar.getByText('3 消息', { exact: true })).toHaveCount(1);
        await expandDock(page);
        const dockItem = itemLocator(page, rootId);
        await expect(dockItem.locator('.task-dock-meta')).toHaveText(/^3 条消息 · 2 个 Agent · (刚刚|\d+ 分钟前)$/u);
        await expect(dockItem.locator('.task-dock-meta')).toHaveCount(1);
        await dockItem.locator('.task-dock-item-trigger').click();
        const preview = page.locator(`#task-preview-${rootId}`);
        await expect(preview.locator('.task-preview-meta')).toHaveText('3 条消息 · 2 个 Agent 参与');
        await expect(preview.getByText('3 条消息 · 2 个 Agent 参与', { exact: true })).toHaveCount(1);
        await expect(preview.locator('.task-preview-section')).toHaveText('最近回复');
        await expect(preview.locator('.task-preview-all')).toHaveText('查看全部 3 条消息');
        await expect(preview.locator('.task-preview-time')).toHaveText(/^(刚刚|\d+ 分钟前)$/u);
        await expect(preview.locator('.task-preview-recent-time')).toHaveText([/^(刚刚|\d+ 分钟前)$/u, /^(刚刚|\d+ 分钟前)$/u]);
        await expect(preview.locator('.task-preview-sender')).toHaveText('统一 Task 细节');
        await expect(preview.locator('.task-preview-recent-text').first()).toHaveCSS('-webkit-line-clamp', '2');
        await expect(preview.locator('.task-preview-recent-sender').last()).toHaveCSS('white-space', 'nowrap');
        await expectTaskDetailStyle(page, width, colorScheme);
        await page.screenshot({ path: `/tmp/task-detail-data-${width}-${colorScheme}.png` });
      });
      test(`Lenso Task 长内容 ${width}/${colorScheme}：摘要、列表、预览、追踪与完成无横向滚动`, async ({ page }, testInfo) => {
        const base = await baseUrl();
        const fixture = await setupTaskRoom(base, `layout-${width}-${colorScheme}`, { roots: 0 });
        const rootId = await createTask(base, fixture.owner.token, fixture.roomId, LONG_TASK_URL);
        await sendMessage(base, fixture.agent.token, fixture.roomId, `\`\`\`text\n${LONG_TASK_URL}\n\`\`\`\n[${LONG_TASK_URL}](${LONG_TASK_URL})`, { taskRootId: rootId });
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme });
        await openRoom(page, base, fixture.owner.token, fixture.roomId);
        const toggle = page.locator('#task-dock-toggle');
        await expect(toggle).toHaveAttribute('data-lenso-slot', 'button');
        await expect(toggle).toHaveCSS('height', '28px');
        if (width === 390) {
          expect(await toggle.evaluate((node) => {
            const css = getComputedStyle(node, '::after');
            return node.getBoundingClientRect().height - parseFloat(css.top) - parseFloat(css.bottom);
          })).toBeGreaterThanOrEqual(44);
        }
        await expect(page.locator('#task-dock-count [data-lenso-slot="badge"]')).toHaveText('1');
        const bar = page.locator(`.task-bar[data-task-root="${rootId}"]`);
        await expectNoHorizontalOverflow(bar);
        await bar.click();
        const trace = page.locator('#task-trace-drawer');
        await expectNoHorizontalOverflow(trace);
        await page.locator('#task-trace-close').click();
        await expandDock(page);
        const panel = page.locator('#task-dock-panel');
        await expect(panel.locator('[data-lenso-slot="card"]').first()).toBeVisible();
        await expect(panel.locator('[data-lenso-slot="toolbar"]')).toBeVisible();
        const item = itemLocator(page, rootId);
        await expect(item.locator('[data-task-status="open"] [data-lenso-slot="badge"]')).toHaveText('进行中');
        await expectNoHorizontalOverflow(panel);
        await page.screenshot({ path: testInfo.outputPath(`task-${width}-${colorScheme}.png`) });
        await item.locator('.task-dock-item-trigger').click();
        const preview = page.locator(`#task-preview-${rootId}`);
        await expect(preview).toContainText('github.com');
        await expectTaskDetailStyle(page, width, colorScheme);
        await page.screenshot({ path: `/tmp/task-detail-after-${width}-${colorScheme}.png` });
        await expectNoHorizontalOverflow(preview);
        await page.keyboard.press('Escape');
        await item.locator('.task-dock-complete').click();
        await expectNoHorizontalOverflow(page.locator('#task-complete-dialog'));
        await page.locator('#task-complete-cancel').click();
        await expect(item).toBeVisible();
        await page.locator('#task-dock-toggle').click();
        const markdown = page.locator('[data-task-message] .msg-markdown').last();
        await expect(markdown.locator('pre')).toBeVisible();
        await expectNoHorizontalOverflow(markdown);
        await expectNoHorizontalOverflow(page.locator('#messages'));
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      });
    }
  }

  for (const width of [390, 1280]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`Task dock 不透明且不遮挡 composer/toggle ${width}/${colorScheme}`, async ({ page }, testInfo) => {
        const base = await baseUrl();
        const fixture = await setupTaskRoom(base, `opaque-${width}-${colorScheme}`, { roots: 0 });
        const rootId = await createTask(base, fixture.owner.token, fixture.roomId, LONG_TASK_URL);
        await sendMessage(base, fixture.agent.token, fixture.roomId, `\`\`\`text\n${LONG_TASK_URL}\n\`\`\``, { taskRootId: rootId });
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme });
        await openRoom(page, base, fixture.owner.token, fixture.roomId);
        await page.locator('#messages').evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event('scroll'));
        });
        const jump = page.locator('#jump-latest');
        await expect(jump).toBeVisible();
        await expandDock(page);

        const geometry = await page.evaluate(() => {
          const pick = (selector: string) => {
            const node = document.querySelector<HTMLElement>(selector);
            if (!node) throw new Error(`缺少 ${selector}`);
            const box = node.getBoundingClientRect();
            const css = getComputedStyle(node);
            return {
              background: css.backgroundColor,
              zIndex: css.zIndex,
              rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
            };
          };
          const panel = pick('#task-dock-panel');
          const card = pick('#task-dock-panel > [data-lenso-slot="card"]');
          const toggle = pick('#task-dock-toggle');
          const composer = pick('#composer');
          const jumpLatest = pick('#jump-latest');
          const messages = pick('#messages');
          const slot = pick('#task-dock-slot');
          const preview = pick('.task-dock-item .task-dock-preview');
          const previewHit = document.elementFromPoint(
            preview.rect.left + preview.rect.width / 2,
            preview.rect.top + preview.rect.height / 2,
          );
          const item = document.querySelector<HTMLElement>('.task-dock-item');
          const trigger = item?.querySelector<HTMLElement>('.task-dock-item-trigger')?.getBoundingClientRect();
          const actions = item?.querySelector<HTMLElement>('.task-dock-item-actions')?.getBoundingClientRect();
          const itemBox = item?.getBoundingClientRect();
          return {
            panel,
            card,
            toggle,
            composer,
            jumpLatest,
            messages,
            slot,
            panelOwnsPreview: previewHit !== null && previewHit.closest('#task-dock-panel') !== null,
            triggerActions: trigger && actions && itemBox
              ? {
                  separated: trigger.right <= actions.left + 1 || trigger.bottom <= actions.top + 1,
                  actionsInside: actions.right <= itemBox.right + 1 && actions.bottom <= itemBox.bottom + 1,
                  triggerWidth: trigger.width,
                  buttonHeights: [...(item?.querySelectorAll('.task-dock-item-actions button') ?? [])]
                    .map((button) => button.getBoundingClientRect().height),
                }
              : null,
            toggleHit: (() => {
              const box = toggle.rect;
              return document.elementFromPoint(
                (box.left + box.right) / 2,
                (box.top + box.bottom) / 2,
              )?.closest('#task-dock-toggle') !== null;
            })(),
          };
        });

        const alpha = (color: string): number => {
          const match = color.match(/rgba?\([^)]*?([\d.]+)\)$/u);
          if (!match) return 1;
          return color.startsWith('rgba') ? Number(match[1]) : 1;
        };
        const intersects = (
          a: { left: number; top: number; right: number; bottom: number },
          b: { left: number; top: number; right: number; bottom: number },
        ) =>
          Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
          Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);

        expect(alpha(geometry.panel.background)).toBe(1);
        expect(alpha(geometry.card.background)).toBe(1);
        expect(alpha(geometry.jumpLatest.background)).toBe(1);
        expect(Number(geometry.panel.zIndex)).toBeGreaterThan(
          Number(geometry.messages.zIndex) || 0,
        );
        expect(Number(geometry.slot.zIndex)).toBeGreaterThan(
          Number(geometry.messages.zIndex) || 0,
        );
        expect(intersects(geometry.panel.rect, geometry.composer.rect)).toBe(false);
        expect(intersects(geometry.panel.rect, geometry.toggle.rect)).toBe(false);
        expect(intersects(geometry.panel.rect, geometry.jumpLatest.rect)).toBe(false);
        expect(geometry.panel.rect.top).toBeGreaterThanOrEqual(0);
        expect(geometry.panel.rect.left).toBeGreaterThanOrEqual(0);
        expect(geometry.panel.rect.right).toBeLessThanOrEqual(width);
        expect(geometry.panel.rect.bottom).toBeLessThanOrEqual(844);
        expect(geometry.panelOwnsPreview).toBe(true);
        expect(geometry.toggleHit).toBe(true);
        expect(geometry.triggerActions?.separated).toBe(true);
        expect(geometry.triggerActions?.actionsInside).toBe(true);
        expect(geometry.triggerActions?.triggerWidth).toBeGreaterThanOrEqual(120);
        expect(geometry.triggerActions?.buttonHeights.every((height) => height >= (width < 760 ? 44 : 32))).toBe(true);
        await expectNoHorizontalOverflow(page.locator('#task-dock-panel'));
        await page.screenshot({ path: testInfo.outputPath(`dock-opaque-${width}-${colorScheme}.png`) });

        const toggle = page.locator('#task-dock-toggle');
        await toggle.click();
        await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'collapsed');
        await expect(page.locator('#task-dock-panel')).toBeHidden();
      });
    }
  }

  test('Task delivery Badge 与 ProgressBar 按真实 pending/claimed/completed/failed 状态着色', async ({ page }) => {
    const base = await baseUrl();
    const fixture = await setupTaskRoom(base, 'delivery-colors', { roots: 0 });
    const rootId = await createTask(base, fixture.owner.token, fixture.roomId, '核对 Task 状态', [fixture.agent.actor_id]);
    const inbox = await callTool<{ items: { delivery_id: string; message_id: string }[] }>(base, fixture.agent.token, 'network_inbox_list', { state: 'pending', limit: 50 });
    const deliveryId = inbox.items.find((item) => item.message_id === rootId)!.delivery_id;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    const bar = page.locator(`.task-bar[data-task-root="${rootId}"]`);
    const progress = page.locator('.msg-task-bar-slot [data-lenso-slot="progress-bar"]');
    const checkState = async (state: string, token: string) => {
      const badge = bar.locator(`[data-task-status="${state}"]`);
      await expect(badge.locator('[data-lenso-slot="badge"]')).toBeVisible();
      await expect(badge).toHaveCSS('color', await semanticColor(page, token, 'color'));
      await expectNoHorizontalOverflow(bar);
    };
    await checkState('pending', '--lenso-status-warning-text');
    await expect(progress).toHaveAttribute('aria-valuenow', '0');
    const claim = await callTool<{ attempt: number; claim_id: string }>(base, fixture.agent.token, 'network_delivery_claim', { request_id: requestId('claim'), delivery_id: deliveryId });
    await checkState('claimed', '--lenso-status-info-text');
    await callTool(base, fixture.agent.token, 'network_delivery_complete', { request_id: requestId('complete'), delivery_id: deliveryId, attempt: claim.attempt, claim_id: claim.claim_id });
    await checkState('completed', '--lenso-status-success-text');
    await expect(progress).toHaveAttribute('aria-valuenow', '1');
    const failedRoot = await createTask(base, fixture.owner.token, fixture.roomId, '核对失败状态', [fixture.agent.actor_id]);
    const pending = await callTool<{ items: { delivery_id: string; message_id: string }[] }>(base, fixture.agent.token, 'network_inbox_list', { state: 'pending', limit: 50 });
    const failedId = pending.items.find((item) => item.message_id === failedRoot)!.delivery_id;
    const failedClaim = await callTool<{ attempt: number; claim_id: string }>(base, fixture.agent.token, 'network_delivery_claim', { request_id: requestId('claim'), delivery_id: failedId });
    await callTool(base, fixture.agent.token, 'network_delivery_fail', { request_id: requestId('fail'), delivery_id: failedId, attempt: failedClaim.attempt, claim_id: failedClaim.claim_id, error: '验收失败状态' });
    const failedBadge = page.locator(`.task-bar[data-task-root="${failedRoot}"] [data-task-status="failed"]`);
    await expect(failedBadge).toHaveCSS('color', await semanticColor(page, '--wx-danger-text', 'color'));
    await expect(failedBadge).toHaveCSS('background-color', await semanticColor(page, '--lenso-control-status-error-soft-fill'));
  });

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
    await expect(oldItem.locator('.task-dock-meta')).toHaveText(/^5 条消息 · 1 个 Agent · /u);

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
    await expect(itemLocator(page, targetRoot)).toContainText('2 条消息', {
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

  test('页面级 TaskTrace 使用 Lenso Drawer：560/390、暗色、焦点与滚动锁', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 1, replies: 2 });
    const rootId = fixture.roots[0];
    if (!rootId) throw new Error('Task fixture 缺少 root');

    await page.setViewportSize({ width: 1280, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
    await expandDock(page);

    const trigger = itemLocator(page, rootId).locator('.task-dock-item-trigger');
    const popover = page.locator(`#task-preview-${rootId}`);
    await trigger.click();
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: /查看全部 \d+ 条消息/ }).click();

    const trace = page.locator('#task-trace-drawer');
    await expect(trace).toBeVisible({ timeout: 15_000 });
    await expect(trace).toHaveAttribute('data-task-trace-shell', 'lenso');
    await expect(trace).toHaveAttribute('role', 'dialog');
    await expect(trace).toHaveAttribute('aria-labelledby', 'task-trace-title');
    await expect(page.locator('.task-trace-overlay')).toBeVisible();
    await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(3);

    const geometry = await trace.evaluate((element) => {
      const rect = (node: Element | null) => {
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
      };
      return {
        drawer: rect(element),
        overlay: rect(document.querySelector('.task-trace-overlay')),
        background: getComputedStyle(element).backgroundColor,
        itemsOverflow: getComputedStyle(document.getElementById('task-trace-items')!).overflowY,
      };
    });
    const box = geometry.drawer!;
    expect(box.x).toBeGreaterThanOrEqual(719);
    expect(box.x).toBeLessThanOrEqual(721);
    expect(box.width).toBeGreaterThanOrEqual(559);
    expect(box.width).toBeLessThanOrEqual(561);
    expect(box.height).toBeGreaterThanOrEqual(843);
    expect(box.height).toBeLessThanOrEqual(845);
    expect(box.right).toBeGreaterThanOrEqual(1279);
    expect(box.right).toBeLessThanOrEqual(1280);
    expect(geometry.overlay).toEqual({ x: 0, y: 0, width: 1280, height: 844, right: 1280, bottom: 844 });
    const channels = geometry.background.match(/\d+/gu)!.slice(0, 3).map(Number);
    expect(channels.every((channel) => channel < 120)).toBe(true);
    expect(geometry.itemsOverflow).toBe('auto');

    await expect.poll(() =>
      trace.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press(index < 5 ? 'Tab' : 'Shift+Tab');
      await expect.poll(() =>
        trace.evaluate((node) => node.contains(document.activeElement)),
      ).toBe(true);
    }
    expect(
      await page.evaluate(() =>
        [document.body, document.documentElement].some(
          (node) => getComputedStyle(node).overflowY === 'hidden',
        ),
      ),
    ).toBe(true);

    await page.keyboard.press('Escape');
    await expect(trace).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.click();
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: /查看全部 \d+ 条消息/ }).click();
    await expect(trace).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => Math.round((await trace.boundingBox())?.x ?? -1)).toBe(0);
    await expect.poll(async () => Math.round((await trace.boundingBox())?.width ?? 0)).toBe(390);
    const mobile = (await trace.boundingBox())!;
    expect(mobile.x).toBeGreaterThanOrEqual(-0.5);
    expect(mobile.x).toBeLessThanOrEqual(0.5);
    expect(mobile.width).toBeGreaterThanOrEqual(389.5);
    expect(mobile.width).toBeLessThanOrEqual(390.5);
    expect(mobile.height).toBeGreaterThanOrEqual(843.5);
    expect(mobile.height).toBeLessThanOrEqual(844.5);
    await page.locator('#task-trace-close').click();
    await expect(trace).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('MessageSearch 内 TaskTrace 使用 Lenso Drawer，不改变既有父层时序', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const fixture = await setupTaskRoom(base, suffix, { roots: 1, replies: 1 });
    await openRoom(page, base, fixture.owner.token, fixture.roomId);
    await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');

    await page.locator('#message-search-button').click();
    const search = page.locator('#message-search-dialog');
    await expect(search).toBeVisible();
    await page.locator('#message-search-input').fill('待办');
    await page.getByRole('checkbox', { name: '只看任务' }).check();
    await page.locator('#message-search-form button[type=submit]').click();
    await page.locator('.task-search-result').first().click();

    const trace = page.locator('#task-trace-drawer');
    await expect(trace).toBeVisible({ timeout: 15_000 });
    await expect(trace).toHaveAttribute('data-task-trace-shell', 'lenso');
    await expect(trace).toHaveClass(/task-trace-drawer/u);
    await expect(trace).toHaveAttribute('role', 'dialog');
    // 既有 Task 分支先关闭搜索再打开 Trace；Lenso Drawer 只随自身关闭。
    await expect(search).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(trace).toHaveCount(0);
    await expect(page.locator('#message-search-dialog')).toHaveCount(0);
    await expect(page.locator('#task-dock')).toBeVisible();
  });

  for (const mode of ['blocked', 'delayed'] as const) {
    test(`TaskTrace 页面级 ${mode}：本次打开锁定 Radix，关闭重开升级 Drawer`, async ({ page }) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let intercepted = 0;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/assets/index-*.js', async (route) => {
        intercepted += 1;
        if (mode === 'blocked') return route.abort('failed');
        await gate;
        await route.continue();
      });
      try {
        const base = await baseUrl();
        const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
        const fixture = await setupTaskRoom(base, suffix, { roots: 1 });
        const rootId = fixture.roots[0];
        if (!rootId) throw new Error('Task fixture 缺少 root');
        await openRoom(page, base, fixture.owner.token, fixture.roomId);
        await expandDock(page);

        const trigger = itemLocator(page, rootId).locator('.task-dock-item-trigger');
        const popover = page.locator(`#task-preview-${rootId}`);
        await trigger.click();
        await expect(popover).toBeVisible();
        await popover.getByRole('button', { name: /查看全部 \d+ 条消息/ }).click();
        const trace = page.locator('#task-trace-drawer');
        await expect(trace).toBeVisible({ timeout: 15_000 });
        await expect(trace).toHaveAttribute('data-modal-shell', 'radix');
        await trace.evaluate((node) => {
          const probe = window as unknown as {
            __taskTraceNode?: Element;
            __taskTraceFocus?: Element | null;
          };
          probe.__taskTraceNode = node;
          probe.__taskTraceFocus = document.activeElement;
        });
        if (mode === 'delayed') {
          release();
          await expect.poll(() =>
            page.locator('[data-lenso-slot="button"]').count(),
          ).toBeGreaterThan(0);
          expect(await page.evaluate(() => {
            const probe = window as unknown as {
              __taskTraceNode?: Element;
              __taskTraceFocus?: Element | null;
            };
            return Boolean(probe.__taskTraceNode?.isConnected) &&
              probe.__taskTraceFocus === document.activeElement;
          })).toBe(true);
          await expect(trace).toHaveAttribute('data-modal-shell', 'radix');
        }
        expect(intercepted).toBeGreaterThan(0);
        await page.keyboard.press('Escape');
        await expect(trace).toHaveCount(0);
        await expect(trigger).toBeFocused();

        await trigger.click();
        await expect(popover).toBeVisible();
        await popover.getByRole('button', { name: /查看全部 \d+ 条消息/ }).click();
        await expect(trace).toBeVisible({ timeout: 15_000 });
        if (mode === 'delayed') {
          await expect(trace).toHaveAttribute('data-task-trace-shell', 'lenso');
        } else {
          await expect(trace).toHaveAttribute('data-modal-shell', 'radix');
        }
        await page.keyboard.press('Escape');
        await expect(trace).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally {
        release?.();
      }
    });
  }

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

  test('多 Agent 参与：摘要 24px AvatarGroup 与 +N，列表只保留单行数据', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Multi Owner ${suffix}`);
    const agents: AgentCreated[] = [];
    for (let index = 0; index < 4; index += 1) {
      agents.push(await createAgent(base, owner.token, `Multi Agent ${index + 1} ${suffix}`));
    }
    const roomId = await createGroup(
      base,
      owner.token,
      `Multi Group ${suffix}`,
      agents.map((agent) => agent.actor_id),
    );
    const rootId = await createTask(base, owner.token, roomId, '多 Agent 协作根消息');
    for (const agent of agents) {
      await sendMessage(base, agent.token, roomId, `多 Agent 回复 ${agent.name}`, {
        taskRootId: rootId,
      });
    }

    await openRoom(page, base, owner.token, roomId);
    const bar = page.locator(`.msg-task-bar-slot [data-task-root="${rootId}"]`);
    await expect(bar).toBeVisible();
    await expect(bar.locator('[data-lenso-slot="avatar-group"]')).toHaveCount(1);
    await expect(bar.locator('[data-lenso-slot="avatar"]')).toHaveCount(3);
    await expect(bar.locator('.task-bar-more')).toHaveText('+1');
    const barLayout = await bar.evaluate((element) => ({
      heights: Array.from(element.querySelectorAll('[data-lenso-slot="avatar"]')).map(
        (avatar) => Math.round(avatar.getBoundingClientRect().height),
      ),
      rowHeight: Math.round(element.getBoundingClientRect().height),
    }));
    expect(barLayout.heights).toEqual([24, 24, 24]);
    expect(barLayout.rowHeight).toBeGreaterThanOrEqual(44);

    await expandDock(page);
    const item = itemLocator(page, rootId);
    await expect(item.locator('.task-dock-avatars')).toHaveCount(0);
    await expect(item.locator('.task-dock-meta')).toHaveText(/^5 条消息 · 4 个 Agent · /u);
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
    // 服务端 mentions 按 actor_id 排序；让正文顺序与之相反，直接验证前端按正文排序。
    const [first, second] =
      agentA.actor_id < agentB.actor_id ? [agentB, agentA] : [agentA, agentB];
    const rootId = await createTask(
      base,
      owner.token,
      roomId,
      `@${first.name} @${second.name} 请同步交付里程碑`,
      [first.actor_id, second.actor_id],
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

    // 直接断言正文顺序：不能从服务端 mentions 数组推导期望。
    const firstPosition = value.indexOf(`@${first.name}`);
    const secondPosition = value.indexOf(`@${second.name}`);
    expect(firstPosition).toBeGreaterThanOrEqual(0);
    expect(secondPosition).toBeGreaterThanOrEqual(0);
    expect(firstPosition).toBeLessThan(secondPosition);

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
    // 服务端数组与正文顺序相反，证明这个 fixture 真正覆盖了排序缺陷。
    expect(root?.mentions.map((mention) => mention.actor_id)).toEqual([
      second.actor_id,
      first.actor_id,
    ]);

    await page.waitForTimeout(300);
    expect(sends).toHaveLength(0);
    await expect(page.locator('#body')).toHaveValue(value);
  });

  test('预览被截断时读取一次根正文，按完整正文顺序复原', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Ask Read Owner ${suffix}`);
    const agentA = await createAgent(base, owner.token, `Ask Read A ${suffix}`);
    const agentB = await createAgent(base, owner.token, `Ask Read B ${suffix}`);
    const roomId = await createGroup(base, owner.token, `Ask Read ${suffix}`, [
      agentA.actor_id,
      agentB.actor_id,
    ]);
    // 服务端 preview 上限 512 字节：填充文本占满预览，两个 @ 只能从正文读取。
    const [first, second] =
      agentA.actor_id < agentB.actor_id ? [agentB, agentA] : [agentA, agentB];
    const filler = '进度背景说明。'.repeat(80);
    const rootId = await createTask(
      base,
      owner.token,
      roomId,
      `${filler}@${first.name} @${second.name} 请同步进度`,
      [first.actor_id, second.actor_id],
    );

    await openRoom(page, base, owner.token, roomId);
    await expandDock(page);
    const readRequest = page.waitForRequest(
      (request) =>
        request.headers()['mcp-name'] === 'network_message_read' &&
        (request.postData() ?? '').includes(rootId),
    );
    await itemLocator(page, rootId).locator('.task-dock-ask').click();
    await readRequest;

    await expect
      .poll(() => page.locator('#body').inputValue())
      .toContain(`@${first.name}`);
    const value = await page.locator('#body').inputValue();
    expect(value.indexOf(`@${first.name}`)).toBeGreaterThanOrEqual(0);
    expect(value.indexOf(`@${second.name}`)).toBeGreaterThanOrEqual(0);
    expect(value.indexOf(`@${first.name}`)).toBeLessThan(value.indexOf(`@${second.name}`));
  });

  test('根正文读取失败时按服务端顺序兜底', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Ask Fallback Owner ${suffix}`);
    const agentA = await createAgent(base, owner.token, `Ask Fallback A ${suffix}`);
    const agentB = await createAgent(base, owner.token, `Ask Fallback B ${suffix}`);
    const roomId = await createGroup(base, owner.token, `Ask Fallback ${suffix}`, [
      agentA.actor_id,
      agentB.actor_id,
    ]);
    const [first, second] =
      agentA.actor_id < agentB.actor_id ? [agentB, agentA] : [agentA, agentB];
    const filler = '进度背景说明。'.repeat(80);
    const rootId = await createTask(
      base,
      owner.token,
      roomId,
      `${filler}@${first.name} @${second.name} 请同步进度`,
      [first.actor_id, second.actor_id],
    );

    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] !== 'network_message_read') {
        await route.continue();
        return;
      }
      const parsed = JSON.parse(route.request().postData() ?? '{}') as { id?: unknown };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: toolErrorBody(parsed.id, 'MESSAGE_UNAVAILABLE', '读取失败（模拟）'),
      });
    });

    await openRoom(page, base, owner.token, roomId);
    await expandDock(page);
    await itemLocator(page, rootId).locator('.task-dock-ask').click();

    await expect
      .poll(() => page.locator('#body').inputValue())
      .toContain(`@${second.name}`);
    const value = await page.locator('#body').inputValue();
    // 服务端 mentions 按 actor_id 排序，与正文顺序相反。
    expect(value.indexOf(`@${second.name}`)).toBeGreaterThanOrEqual(0);
    expect(value.indexOf(`@${first.name}`)).toBeGreaterThanOrEqual(0);
    expect(value.indexOf(`@${second.name}`)).toBeLessThan(value.indexOf(`@${first.name}`));
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
    const toggle = page.locator('#task-dock-toggle');
    await expect(toggle).toHaveCSS('height', '28px');
    expect(await toggle.evaluate((node) => {
      const css = getComputedStyle(node, '::after');
      return node.getBoundingClientRect().height - parseFloat(css.top) - parseFloat(css.bottom);
    })).toBeGreaterThanOrEqual(44);
    // 验证 chip 外沿仍可点按，而非只检查伪元素声明。
    const box = (await toggle.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y - 6);
    await expect(page.locator('#task-dock-panel')).toBeVisible();
    await toggle.tap();

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
