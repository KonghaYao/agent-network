import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-5 右侧面板与剩余入口：文件、网页监控、画板、Memory、新建 Agent、
 * 管理权交接与群主转让。
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
  room: {
    room_id: string;
    kind: string;
    my_role: string;
    owner_transfer: { transfer_id: string; version: number } | null;
  };
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
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

test.describe('SPA 右栏与剩余入口', () => {

  let base = '';
  let tokenA = '';
  let tokenB = '';
  let nameA = '';
  let nameB = '';
  let roomId = '';
  let groupId = '';
  let agentId = '';
  let agentName = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    tokenB = crypto.randomUUID();
    nameA = `Panel A ${suffix}`;
    nameB = `Panel B ${suffix}`;
    agentName = `Panel Agent ${suffix}`;

    const a = await callTool<Registered>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameA,
      device_id: `e2e-panel-${suffix}-a`,
    });
    const b = await callTool<Registered>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameB,
      device_id: `e2e-panel-${suffix}-b`,
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

    const group = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_group'),
      kind: 'group',
      members: [b.actor_id, a.actor_id],
      title: `Panel Group ${suffix}`,
    });
    groupId = group.room.room_id;

    const agent = await callTool<{ actor_id: string }>(base, tokenA, 'network_agent_create', {
      request_id: requestId('e2e_agent'),
      name: agentName,
    });
    agentId = agent.actor_id;
    const agentRoom = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_agent_room'),
      kind: 'direct',
      members: [agentId],
    });
    expect(agentRoom.room.room_id).toBeTruthy();
  });

  test('files pane uploads, previews and deletes a file', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();
    await expect(page.locator('#title')).toHaveText(nameB);

    const fileName = `panel-${Date.now()}.txt`;
    await page.locator('#files-input').setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from('4B-5 files pane'),
    });
    const item = page.locator('#files-list .file-item').filter({ hasText: fileName });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#files-status')).toContainText('已上传');

    await item.getByRole('button', { name: '预览' }).click();
    await expect(page.locator('#file-preview')).toBeVisible();
    await expect(page.locator('#file-preview-title')).toHaveText(fileName);
    await expect(page.locator('#file-preview-body pre')).toContainText('4B-5 files pane');
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();

    await item.getByRole('button', { name: '删除' }).click();
    await item.getByRole('button', { name: '确认删除' }).click();
    await expect(item).toHaveCount(0, { timeout: 15_000 });
  });

  test('monitor URL saves, renders iframe and closes back to files', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();

    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await expect(page.locator('#files-pane')).toBeHidden();
    await page.fill('#monitor-url', 'https://example.com/4b5');
    await page.locator('#monitor-save').click();
    await expect(page.locator('#monitor-status')).toContainText('已保存');
    await expect(page.locator('#monitor-frame')).toHaveAttribute(
      'src',
      'https://example.com/4b5',
    );

    await page.locator('#monitor-close').click();
    await expect(page.locator('#monitor-pane')).toBeHidden();
    await expect(page.locator('#monitor-toggle')).toBeFocused();

    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-pane')).toBeVisible();
  });

  test('tablet drawer uses backdrop and Escape returns focus', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeHidden();

    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-pane')).toBeVisible();
    await expect(page.locator('#files-backdrop')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/files-drawer-open/u);
    await page.locator('#files-backdrop').click();
    await expect(page.locator('#files-pane')).toBeHidden();

    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#monitor-pane')).toBeHidden();
  });

  test('mobile right panes are single column full-screen pages', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeHidden();

    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-pane')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/files-page-open/u);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.locator('#files-close').click();
    await expect(page.locator('#files-pane')).toBeHidden();

    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/monitor-page-open/u);
    await page.locator('#monitor-close').click();
    await expect(page.locator('#monitor-pane')).toBeHidden();
  });

  test('dark mode keeps right-pane surfaces dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();
    const color = await page.evaluate(
      () => getComputedStyle(document.getElementById('files-pane')!).backgroundColor,
    );
    expect(color).toBe('rgb(43, 43, 43)');
    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    const monitorColor = await page.evaluate(
      () => getComputedStyle(document.getElementById('monitor-pane')!).backgroundColor,
    );
    expect(monitorColor).toBe('rgb(43, 43, 43)');
  });

  test('drawboard loads on demand and cancels without uploading', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await page.locator('#attach-file').click();
    await expect(page.locator('#attach-menu-draw')).toBeVisible();
    await page.locator('#attach-menu-draw').click();
    await expect(page.locator('[data-drawboard-overlay="1"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#composer-files .composer-file')).toHaveCount(0);
    await page.locator('#db-cancel').click();
    await expect(page.locator('[data-drawboard-overlay="1"]')).toHaveCount(0);
  });

  test('new agent entry creates credentials and memory drawer opens', async ({ page }) => {
    await login(page, base, tokenA);
    await page.locator('#new-agent').click();
    await expect(page.locator('#new-agent-modal')).toBeVisible();
    await page.fill('#new-agent-name', `UI Agent ${Date.now()}`);
    await page.locator('#new-agent-create').click();
    await expect(page.locator('#new-agent-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#new-agent-url')).toHaveValue(/\/mcp\?token=/u);
    await expect(page.locator('#new-agent-modal .new-agent-warning')).toContainText(
      '不要截图、发群或写入日志',
    );
    await page.locator('#new-agent-close').click();
    await expect(page.locator('#new-agent-modal')).toBeHidden();

    await page.locator('#memory-open').click();
    await expect(page.locator('#memory-drawer')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#memory-capability')).toContainText(
      'Memory 内容工具只对 Agent 自身凭据开放',
    );
    await expect(page.locator('#memory-tabs')).toHaveCount(0);
    await page.locator('#memory-close').click({ timeout: 5000 });
    await expect(page.locator('#memory-drawer')).toBeHidden();
  });

  test('agent management transfer dialog loads from the room menu', async ({ page }) => {
    await login(page, base, tokenA);
    const rooms = await callTool<RoomList>(base, tokenA, 'network_rooms_list', { limit: 100 });
    const agentRoom = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === agentId,
    );
    if (!agentRoom) throw new Error('新建 Agent 未生成 direct 会话');
    await page.goto(`${base}/c/${agentRoom.room_id}`);
    await expect(page.locator('#title')).toHaveText(agentName);
    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu-transfer')).toBeVisible();
    await page.locator('#room-menu-transfer').click();
    await expect(page.locator('#transfer-modal')).toBeVisible();
    await expect(page.locator('#transfer-summary')).toContainText(agentName);
    await expect(page.locator('#transfer-summary')).toContainText('你是当前管理者');
    await page.locator('#transfer-close').click();
    await expect(page.locator('#transfer-modal')).toBeHidden();
  });

  test('group owner transfer can be proposed from members dialog', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${groupId}`);
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-members').click();
    await expect(page.locator('#members-modal')).toBeVisible();
    await expect(page.locator('#members-transfer')).toBeVisible();
    await page.selectOption('#members-transfer-select', nameB);
    await page.locator('#members-transfer-propose').click();
    await expect(page.locator('#members-transfer')).toContainText('提议把群主转让给');

    const detail = await callTool<RoomDetail>(base, tokenA, 'network_room_get', {
      room_id: groupId,
    });
    expect(detail.room.owner_transfer).not.toBeNull();
  });

  test('right panes and new dialogs have no critical/serious axe violations', async ({ page }) => {
    async function violations(selector: string): Promise<string[]> {
      const results = await new AxeBuilder({ page })
        .include(selector)
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const serious = results.violations.filter(
        (item) => item.impact === 'critical' || item.impact === 'serious',
      );
      if (serious.length > 0) {
        console.log('AXE', selector, JSON.stringify(serious.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }))));
      }
      return serious.map((item) => `${item.id}(${item.impact})`);
    }

    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#files-pane')).toEqual([]);

    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#monitor-pane')).toEqual([]);
    await page.locator('#monitor-close').click();

    await page.locator('#new-agent').click();
    await expect(page.locator('#new-agent-modal')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#new-agent-modal')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#new-agent-modal')).toBeHidden();

    await page.locator('#memory-open').click();
    await expect(page.locator('#memory-drawer')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(220);
    expect(await violations('#memory-drawer')).toEqual([]);
    await page.locator('#memory-close').click();

    const rooms = await callTool<RoomList>(base, tokenA, 'network_rooms_list', { limit: 100 });
    const agentRoom = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === agentId,
    );
    if (!agentRoom) throw new Error('新建 Agent 未生成 direct 会话');
    await page.goto(`${base}/c/${agentRoom.room_id}`);
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-transfer').click();
    await expect(page.locator('#transfer-modal')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#transfer-modal')).toEqual([]);
  });
});
