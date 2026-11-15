import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Agent 记忆弹窗：真实浏览器 + 真实 MCP 身份/房间；
 * 只对记忆工具的只读响应做请求级 fixture，验证分页、搜索、详情掩码与焦点。
 * 权限拒绝用真实服务端（拉黑后读取）验证，不替换成功响应。
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

interface MemoryCall {
  name: string;
  args: Record<string, unknown>;
}

interface RpcBody {
  id?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

const SECRET_BEARER = 'sk-testonly-memory-panel-token';
const SECRET_URL = 'SECRET-URL-TOKEN';
const SECRET_CONTEXT = 'sk-testonly-context-token';
const SECRET_SOURCE = 'SRC-TOKEN-987654';
const SECRET_PASSWORD = 'hunter2-panel-secret';
const SECRET_COOKIE = 'session-cookie-778899';
const SECRET_SET_COOKIE = 'set-cookie-445566';
const SECRET_PRIVATE_KEY = 'MIIEowIBAAKCAQEAprivatekeybody';
const SECRET_AWS = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_ENTITY_AWS = 'AKIAENTITYSECRET1234';
const SECRET_ENTITY_PASSWORD = 'entity-secret-800';
const SECRET_TAG_PASSWORD = 'tag-secret-900';

const MEMORY_TEXT = [
  `Deploy runbook uses Authorization: Bearer ${SECRET_BEARER} and https://example.com/hook?token=${SECRET_URL}`,
  `password=${SECRET_PASSWORD}`,
  `Cookie: session=${SECRET_COOKIE}`,
  `Set-Cookie: sid=${SECRET_SET_COOKIE}`,
  `${SECRET_AWS}`,
  '-----BEGIN RSA PRIVATE KEY-----',
  SECRET_PRIVATE_KEY,
  '-----END RSA PRIVATE KEY-----',
].join('\n');

function memoryItem(id: string, type: 'world' | 'experience' | 'observation', text: string) {
  return {
    id,
    text,
    fact_type: type,
    state: 'valid' as const,
    mentioned_at: '2026-10-01T09:30:00.000Z',
    occurred_start: null,
    occurred_end: null,
    entities: ['deploy', 'runbook'] as string[],
    proof_count: 3,
    tags: [] as string[],
  };
}

async function installMemoryStub(
  page: Page,
  calls: MemoryCall[],
  options: { panelDisabled?: boolean; actorName: string; actorId: string },
): Promise<void> {
  const actor = {
    actor_id: options.actorId,
    name: options.actorName,
    kind: 'agent' as const,
    archived: false,
    disabled: false,
  };
  const primary = memoryItem('mem-1', 'world', MEMORY_TEXT);
  // 实体与标签同样可能被上游写入敏感值，默认渲染必须走 maskSecrets。
  primary.entities = ['deploy', SECRET_ENTITY_AWS, `password=${SECRET_ENTITY_PASSWORD}`];
  primary.tags = ['ops', SECRET_ENTITY_AWS, `password=${SECRET_TAG_PASSWORD}`];
  const items = [
    primary,
    memoryItem('mem-2', 'experience', 'Experience: deploy window is Thursday; retry after rollback.'),
    memoryItem('mem-3', 'observation', 'Observation: the deploy dashboard was slow twice.'),
    memoryItem('mem-4', 'world', 'World: the staging deploy uses an isolated project.'),
  ];

  await page.route('**/mcp', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.continue();
      return;
    }
    let body: RpcBody | null = null;
    try {
      body = JSON.parse(request.postData() ?? 'null') as RpcBody;
    } catch {
      body = null;
    }
    const name = typeof body?.params?.name === 'string' ? body.params.name : null;
    if (!name || !name.startsWith('network_agent_memory_')) {
      await route.continue();
      return;
    }
    const args =
      body?.params?.arguments && typeof body.params.arguments === 'object'
        ? (body.params.arguments as Record<string, unknown>)
        : {};
    calls.push({ name, args });

    let structuredContent: unknown;
    if (name === 'network_agent_memory_overview') {
      structuredContent = options.panelDisabled
        ? { available: false, reason: 'panel_disabled', actor, fetched_at: Date.now(), stats: null }
        : {
            available: true,
            reason: 'ok',
            actor,
            fetched_at: 1_760_000_000_000,
            stats: {
              total_nodes: 42,
              total_links: 81,
              total_documents: 7,
              by_fact_type: { world: 12, experience: 20, observation: 10 },
              links_by_type: { semantic: 40, temporal: 20, entity: 15, caused_by: 6 },
              pending_operations: 2,
              failed_operations: 1,
              last_write_at: '2026-10-01T10:00:00.000Z',
              last_consolidated_at: '2026-10-01T09:00:00.000Z',
            },
          };
    } else if (name === 'network_agent_memory_list') {
      const offset = Number(args.offset ?? 0);
      const q = typeof args.q === 'string' ? args.q.toLowerCase() : '';
      const type = typeof args.type === 'string' ? args.type : '';
      const filtered = items.filter(
        (item) =>
          (!type || item.fact_type === type) &&
          (!q || item.text.toLowerCase().includes(q)),
      );
      const pageItems = filtered.slice(offset, offset + 2);
      const next = offset + pageItems.length < filtered.length ? offset + pageItems.length : null;
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: 1_760_000_000_000,
        items: pageItems,
        total: filtered.length,
        limit: 2,
        offset,
        has_more: next !== null,
        next_offset: next,
        truncated: false,
      };
    } else if (name === 'network_agent_memory_get') {
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: 1_760_000_000_000,
        memory: {
          ...items[0],
          id: String(args.memory_id ?? 'mem-1'),
          context: `context Authorization: Bearer ${SECRET_CONTEXT}`,
          source_memories: [
            {
              id: 'source-1',
              text: `source token=${SECRET_SOURCE}`,
              type: 'world',
              mentioned_at: '2026-09-30T10:00:00.000Z',
            },
          ],
          history_count: 2,
          text_truncated: false,
        },
      };
    } else {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        result: { structuredContent },
      }),
    });
  });
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

  test('Panel disabled 状态来自只读工具', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryStub(page, calls, {
      panelDisabled: true,
      actorName: agentName,
      actorId: agentId,
    });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);
    await expect(page.locator('#memory-overview-state')).toHaveAttribute(
      'data-state',
      'panel_disabled',
    );
    await expect(page.locator('#memory-overview-state')).toContainText(
      '当前部署未开启 Agent 记忆面板',
    );
    await expect(page.locator('#memory-facts-list')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#agent-memory-dialog')).toBeHidden();
    await expect(row(page, directRoom)).toBeFocused();
  });

  test('概览、分页、搜索、筛选、详情掩码与 axe', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryStub(page, calls, {
      actorName: agentName,
      actorId: agentId,
    });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);

    await expect(page.locator('#agent-memory-target')).toHaveText(agentName);
    await expect(page.locator('#agent-memory-readonly')).toHaveText('只读');
    await expect(page.locator('#agent-memory-note')).toContainText('后端原始记忆');
    await expect(page.locator('#memory-stat-nodes')).toHaveText('42');
    await expect(page.locator('#memory-stat-links')).toHaveText('81');
    await expect(page.locator('#memory-stat-docs')).toHaveText('7');
    await expect(page.locator('#memory-overview-jobs')).toContainText('后台仍在整理 2 条记忆');
    await expect(page.locator('#memory-overview-jobs')).toContainText('有 1 条整理失败');
    await expect(page.locator('#memory-overview-last-write')).not.toHaveText('—');

    const facts = page.locator('#memory-facts-list .memory-fact');
    await expect(facts).toHaveCount(2);
    await expect(page.locator('#memory-facts-range')).toContainText('已显示 2 / 4 条');
    await page.locator('#memory-facts-more').click();
    await expect(facts).toHaveCount(4);
    await expect(page.locator('#memory-facts-more')).toHaveCount(0);

    // 事实列表的实体预览默认掩码；详情、上下文、来源与标签默认掩码。
    const factListText = await page.locator('#memory-facts-list').textContent();
    expect(factListText).not.toContain(SECRET_ENTITY_AWS);
    expect(factListText).not.toContain(SECRET_ENTITY_PASSWORD);
    expect(factListText).toContain('[已隐藏]');

    await facts.first().click();
    await expect(page.locator('#memory-detail-text')).toBeVisible();
    const dialogText = (await page.locator('#agent-memory-dialog').textContent()) ?? '';
    for (const secret of [
      SECRET_BEARER,
      SECRET_URL,
      SECRET_CONTEXT,
      SECRET_SOURCE,
      SECRET_PASSWORD,
      SECRET_COOKIE,
      SECRET_SET_COOKIE,
      SECRET_PRIVATE_KEY,
      SECRET_AWS,
      SECRET_ENTITY_AWS,
      SECRET_ENTITY_PASSWORD,
      SECRET_TAG_PASSWORD,
    ]) {
      expect(dialogText).not.toContain(secret);
    }
    expect(dialogText).toContain('[已隐藏]');
    for (const forbidden of ['bank', 'bank_id', 'space_id', 'provider', 'document_id', 'chunk_id']) {
      expect(dialogText.toLowerCase()).not.toContain(forbidden);
    }
    await page.locator('#memory-detail-reveal').click();
    await expect(page.locator('#memory-detail-text')).toContainText(SECRET_BEARER);
    await expect(page.locator('#memory-detail-text')).toContainText(SECRET_URL);
    await expect(page.locator('#memory-detail-text')).toContainText(SECRET_PASSWORD);
    await expect(page.locator('#memory-detail-text')).toContainText(SECRET_COOKIE);
    await expect(page.locator('#memory-detail-text')).toContainText(SECRET_SET_COOKIE);
    await expect(page.locator('#memory-detail-text')).toContainText(SECRET_AWS);
    await expect(page.locator('#memory-detail-text')).toContainText(SECRET_PRIVATE_KEY);
    await expect(page.locator('#memory-detail-reveal')).toHaveText('隐藏原文');
    await expect(page.locator('#memory-detail-context')).toContainText(SECRET_CONTEXT);
    await expect(page.locator('#memory-detail-sources')).toContainText(SECRET_SOURCE);
    await expect(page.locator('#memory-detail-tags')).toContainText(SECRET_ENTITY_AWS);
    await expect(page.locator('#memory-detail-tags')).toContainText(`password=${SECRET_TAG_PASSWORD}`);
    // 实体没有「查看原文」入口，即使正文已展开也必须保持掩码。
    await expect(facts.first()).not.toContainText(SECRET_ENTITY_AWS);
    await expect(facts.first()).not.toContainText(SECRET_ENTITY_PASSWORD);

    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);

    // 关闭详情后焦点回到触发详情的事实按钮。
    await page.locator('#memory-detail-close').click();
    await expect(page.locator('#memory-detail-text')).toHaveCount(0);
    await expect(facts.first()).toBeFocused();

    // Escape 优先关闭详情并归还焦点，不关闭整个弹窗。
    await facts.first().click();
    await expect(page.locator('#memory-detail-text')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#memory-detail-text')).toHaveCount(0);
    await expect(page.locator('#agent-memory-dialog')).toBeVisible();
    await expect(facts.first()).toBeFocused();

    const listCalls = () => calls.filter((call) => call.name === 'network_agent_memory_list');
    const beforeSearch = listCalls().length;
    await page.locator('#memory-facts-search').fill('runbook');
    await page.locator('#memory-facts-search').press('Enter');
    await expect.poll(() => listCalls().length).toBeGreaterThan(beforeSearch);
    await expect.poll(() => listCalls().some((call) => call.args.q === 'runbook')).toBe(true);
    await expect(facts).toHaveCount(1);
    await expect(facts.first()).toContainText('Deploy runbook');

    await page.locator('#memory-facts-search').fill('');
    await page.locator('#memory-facts-search').press('Enter');
    const beforeType = listCalls().length;
    await page.selectOption('#memory-type-filter', 'experience');
    await expect.poll(() => listCalls().length).toBeGreaterThan(beforeType);
    await expect.poll(() => listCalls().some((call) => call.args.type === 'experience')).toBe(true);
    await expect(facts).toHaveCount(1);
    await expect(facts.first()).toContainText('Experience: deploy window');

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
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
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
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
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
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
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

  test('拉黑后的真实服务端拒绝显示 FORBIDDEN 空态', async ({ page }) => {
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
    await expect(page.locator('#memory-overview-state')).toHaveAttribute(
      'data-state',
      'forbidden',
    );
    await expect(page.locator('#memory-overview-state')).toContainText('无权查看');
    await expect(page.locator('#memory-facts-list')).toHaveCount(0);
    await page.locator('#agent-memory-close').click();
    await expect(page.locator('#room-menu-toggle')).toBeFocused();
  });

  test('390 移动端全屏单列、底部详情抽屉且无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const calls: MemoryCall[] = [];
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);

    const box = await page.locator('#agent-memory-dialog').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.width).toBeLessThanOrEqual(391);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await expect(page.locator('.memory-detail-column')).toBeHidden();
    await page.locator('#memory-facts-list .memory-fact').first().click();
    await expect(page.locator('.memory-detail-column')).toBeVisible();
    const detail = await page.locator('.memory-detail-column').boundingBox();
    expect(detail).not.toBeNull();
    expect(detail!.x).toBeGreaterThanOrEqual(0);
    expect(detail!.width).toBeGreaterThanOrEqual(389);
    expect(detail!.y + detail!.height).toBeLessThanOrEqual(845);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.locator('#memory-detail-close').click();
    await expect(page.locator('.memory-detail-column')).toBeHidden();
    await page.locator('#agent-memory-close').click();
    await expect(page.locator('#agent-memory-dialog')).toBeHidden();
  });
});
