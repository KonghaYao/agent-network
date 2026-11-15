import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  SECRET_BEARER,
  SECRET_CONTEXT,
  SECRET_ENTITY_AWS,
  SECRET_TAG_PASSWORD,
  SECRET_URL,
  callsOf,
  installMemoryFenixStub,
  type MemoryCall,
} from './fixtures/memory-fenix';

/**
 * Agent 记忆弹窗的入口、权限与焦点行为。
 *
 * 记忆数据由 Fenix 事实视角渲染；具体视图/单次取数断言在
 * `memory-fenix.spec.ts`。本文件只覆盖入口、真实服务端权限、390 与焦点归还。
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
            name: 'agent-network-e2e-memory',
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

function row(page: Page, roomId: string) {
  return page.locator(`#room-list a[data-room-id="${roomId}"]`);
}

async function openRowMemory(page: Page, roomId: string): Promise<void> {
  await page.locator('#room-filter-agent').click();
  const listRow = row(page, roomId);
  await expect(listRow).toBeVisible({ timeout: 15_000 });
  await listRow.click({ button: 'right' });
  await expect(page.locator('#room-row-menu')).toBeVisible();
  await page.locator('#room-row-menu-memory').click();
  await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
}

test.describe('Agent 记忆弹窗', () => {
  let base = '';
  let tokenA = '';
  let agentToken = '';
  let agentId = '';
  let agentName = '';
  let directRoom = '';
  let groupRoom = '';
  let blockedAgentId = '';
  let blockedAgentName = '';
  let blockedGroup = '';
  let agentMessageId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    agentName = `Memory Agent ${suffix}`;
    blockedAgentName = `Blocked Agent ${suffix}`;

    await callTool(base, tokenA, 'network_register', {
      request_id: requestId('e2e_mem_reg'),
      kind: 'human',
      name: `Memory Human ${suffix}`,
      device_id: `e2e-memory-${suffix}`,
    });
    const agent = await callTool<{ actor_id: string; token: string }>(
      base,
      tokenA,
      'network_agent_create',
      { request_id: requestId('e2e_mem_agent'), name: agentName },
    );
    agentId = agent.actor_id;
    agentToken = agent.token;

    const direct = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_mem_direct'),
        kind: 'direct',
        members: [agentId],
      },
    );
    directRoom = direct.room.room_id;

    const group = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_mem_group'),
        kind: 'group',
        title: `Memory Group ${suffix}`,
        members: [agentId],
      },
    );
    groupRoom = group.room.room_id;

    const sent = await callTool<{ message: { message_id: string } }>(
      base,
      agentToken,
      'network_message_send',
      {
        request_id: requestId('e2e_mem_message'),
        client_message_id: `client_${suffix}_1`,
        room_id: directRoom,
        body: 'Agent 记忆弹窗消息入口',
        invoke: [],
      },
    );
    agentMessageId = sent.message.message_id;

    const blockedAgent = await callTool<{ actor_id: string; token: string }>(
      base,
      tokenA,
      'network_agent_create',
      { request_id: requestId('e2e_mem_blocked_agent'), name: blockedAgentName },
    );
    blockedAgentId = blockedAgent.actor_id;
    const blockedGroupResult = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_mem_blocked_group'),
        kind: 'group',
        title: `Blocked Group ${suffix}`,
        members: [blockedAgentId],
      },
    );
    blockedGroup = blockedGroupResult.room.room_id;
    await callTool(base, tokenA, 'network_contact_block', {
      request_id: requestId('e2e_mem_block'),
      actor_id: blockedAgentId,
    });
  });

  test('Panel disabled 显示不可用态，并归还焦点', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      panelDisabled: true,
      actorName: agentName,
      actorId: agentId,
    });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);
    await expect(page.getByRole('alert')).toContainText('记忆暂不可用', { timeout: 15_000 });
    await expect(page.getByRole('alert')).toContainText('当前部署未开启 Agent 记忆面板');
    await expect(page.locator('table')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#agent-memory-dialog')).toBeHidden();
    await expect(row(page, directRoom)).toBeFocused();
  });

  test('事实视角：表格、掩码、详情揭示、搜索、视角切换与 axe', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, {
      actorName: agentName,
      actorId: agentId,
    });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);

    await expect(page.locator('#agent-memory-target')).toHaveText(agentName);
    await expect(page.locator('#agent-memory-readonly')).toHaveText('只读');
    await expect(page.locator('#agent-memory-note')).toContainText('后端原始记忆');
    await expect(page.locator('[data-fenix-summary]')).toContainText(
      '显示 12 条记忆中的 3 条',
      { timeout: 15_000 },
    );

    // 表格：一次 graph 带回的行，本地展示窗口。
    await page.getByRole('button', { name: '表格' }).click();
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(3);
    const tableText = (await page.locator('.agent-memory-content').textContent()) ?? '';
    expect(tableText).not.toContain(SECRET_ENTITY_AWS);
    expect(tableText).not.toContain(SECRET_TAG_PASSWORD);
    expect(tableText).toContain('[已隐藏]');

    // 详情默认掩码；查看原文后才渲染原文。
    await rows.first().click();
    const detailText = page.locator('[data-memory-detail-text]');
    await expect(detailText).toBeVisible({ timeout: 15_000 });
    const dialogText = (await page.locator('#agent-memory-dialog').textContent()) ?? '';
    for (const secret of [SECRET_BEARER, SECRET_URL, SECRET_CONTEXT, SECRET_ENTITY_AWS]) {
      expect(dialogText).not.toContain(secret);
    }
    expect(dialogText).toContain('[已隐藏]');
    for (const forbidden of ['bank_id', 'space_id', 'provider', 'document_id', 'chunk_id']) {
      expect(dialogText.toLowerCase()).not.toContain(forbidden);
    }
    await page.getByRole('button', { name: '查看原文' }).click();
    await expect(detailText).toContainText(SECRET_BEARER);
    await expect(detailText).toContainText(SECRET_URL);
    await expect(page.locator('[data-memory-detail-context]')).toContainText(SECRET_CONTEXT);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(detailText).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();

    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);

    // 搜索：一次 graph，不分页累加。
    await page.locator('#memory-fenix-search').fill('runbook');
    await page.locator('#memory-fenix-search').press('Enter');
    await expect.poll(() => callsOf(calls, 'network_agent_memory_graph').length).toBe(2);
    expect(callsOf(calls, 'network_agent_memory_graph')[1]!.args.q).toBe('runbook');
    await page.getByRole('button', { name: '表格' }).click();
    await expect(rows).toHaveCount(1);
    expect(callsOf(calls, 'network_agent_memory_list')).toHaveLength(0);

    // 清空搜索后切到经历视角：各一次 graph，type 正确。
    await page.locator('#memory-fenix-search').fill('');
    await page.locator('#memory-fenix-search').press('Enter');
    await expect.poll(() => callsOf(calls, 'network_agent_memory_graph').length).toBe(3);
    await page.locator('#memory-perspective-experience').click();
    await expect.poll(() => callsOf(calls, 'network_agent_memory_graph').length).toBe(4);
    expect(callsOf(calls, 'network_agent_memory_graph')[3]!.args.type).toBe('experience');
    await page.getByRole('button', { name: '表格' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Experience: deploy window');

    await page.locator('#agent-memory-close').click();
    await expect(page.locator('#agent-memory-dialog')).toBeHidden();
    await expect(row(page, directRoom)).toBeFocused();

    await openRowMemory(page, directRoom);
    await page.keyboard.press('Escape');
    await expect(page.locator('#agent-memory-dialog')).toBeHidden();
    await expect(row(page, directRoom)).toBeFocused();
  });

  test('消息头像菜单打开发送者记忆并归还焦点', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${directRoom}`);
    await expect(page.locator(`[data-message-id="${agentMessageId}"]`)).toBeVisible({
      timeout: 15_000,
    });
    const message = page.locator(`[data-message-id="${agentMessageId}"]`);
    await message.locator('.msg-avatar').click({ button: 'right' });
    await expect(page.locator('#message-context-menu')).toBeVisible();
    await page.locator('#message-action-memory').click();
    await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#agent-memory-target')).toHaveText(agentName);
    await page.locator('#agent-memory-close').click();
    await expect(message.getByRole('button', { name: '消息操作' })).toBeFocused();
  });

  test('群成员头像打开记忆，成员弹窗关闭后焦点回到房间菜单', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${groupRoom}`);
    await expect(page.locator('#room-menu-toggle')).toBeVisible({ timeout: 15_000 });
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-members').click();
    await expect(page.locator('#members-modal')).toBeVisible();
    const member = page.locator('.member-roster-item').filter({ hasText: agentName });
    await expect(member).toBeVisible();
    await member.locator('.memory-avatar-trigger').click({ button: 'right' });
    await page.locator('#memory-avatar-open').click();
    await expect(page.locator('#members-modal')).toBeHidden();
    await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
    await page.locator('#agent-memory-close').click();
    await expect(page.locator('#room-menu-toggle')).toBeFocused();
  });

  test('Agent 自身账号头像右键打开记忆', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, agentToken);
    await expect(page.locator('#account-avatar')).toBeVisible({ timeout: 15_000 });
    const trigger = page.locator('.account .memory-avatar-trigger');
    await trigger.click({ button: 'right' });
    await page.locator('#memory-avatar-open').click();
    await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#agent-memory-target')).toHaveText(agentName);
    await page.locator('#agent-memory-close').click();
    await expect(trigger).toBeFocused();
  });

  test('拉黑后的真实服务端拒绝显示 FORBIDDEN', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${blockedGroup}`);
    await expect(page.locator('#room-menu-toggle')).toBeVisible({ timeout: 15_000 });
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-members').click();
    await expect(page.locator('#members-modal')).toBeVisible();
    const member = page.locator('.member-roster-item').filter({ hasText: blockedAgentName });
    await expect(member).toBeVisible();
    await member.locator('.memory-avatar-trigger').click({ button: 'right' });
    await expect(page.locator('#memory-avatar-menu')).toBeVisible();
    await page.locator('#memory-avatar-open').click();
    await expect(page.locator('#agent-memory-dialog')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('alert')).toContainText('无权访问该记忆库', { timeout: 15_000 });
    await expect(page.locator('table')).toHaveCount(0);
    await page.locator('#agent-memory-close').click();
    await expect(page.locator('#room-menu-toggle')).toBeFocused();
  });

  test('390 移动端全屏单列、表格内部滚动、详情弹窗且无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const calls: MemoryCall[] = [];
    await installMemoryFenixStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);

    // 视角栏与内容区必须单列堆叠：grid 只有一条列轨，内容区在视角栏下方且不越界。
    const layout = await page.locator('.agent-memory-fenix-body').evaluate((element) => {
      const styles = getComputedStyle(element);
      const aside = element.querySelector<HTMLElement>('.agent-memory-perspectives');
      const content = element.querySelector<HTMLElement>('.agent-memory-content');
      if (!aside || !content) throw new Error('缺少视角栏或内容区');
      const asideRect = aside.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      return {
        columns: styles.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length,
        horizontalOverflow: element.scrollWidth - element.clientWidth,
        stacked: contentRect.top >= asideRect.bottom - 1,
        contentLeft: contentRect.left,
        contentRight: contentRect.right,
      };
    });
    expect(layout.columns).toBe(1);
    expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
    expect(layout.stacked).toBe(true);
    expect(layout.contentLeft).toBeGreaterThanOrEqual(0);
    expect(layout.contentRight).toBeLessThanOrEqual(391);

    const box = await page.locator('#agent-memory-dialog').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.width).toBeLessThanOrEqual(391);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: '表格' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(3, { timeout: 15_000 });
    await page.locator('table tbody tr').first().click();
    const detail = page.locator('[data-memory-detail-text]');
    await expect(detail).toBeVisible({ timeout: 15_000 });
    await expect(detail).toContainText('[已隐藏]');
    const modal = await page.locator('[role="dialog"]').last().boundingBox();
    expect(modal).not.toBeNull();
    expect(modal!.x).toBeGreaterThanOrEqual(0);
    expect(modal!.x + modal!.width).toBeLessThanOrEqual(391);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(detail).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });
});
