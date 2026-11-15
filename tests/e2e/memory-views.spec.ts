import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { timelineGroups, type TimelineFixtureItem } from './fixtures/memory-timeline';

/**
 * 记忆弹窗阶段 3：星座图 / 时间线 / 实体。
 *
 * 使用真实浏览器、真实 MCP 身份与房间；只有记忆只读工具的响应替换为
 * 固定 fixture（与 memory-panel.spec.ts 相同），不替换权限与登录链路。
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
            name: 'agent-network-e2e-memory-views',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      content?: { type?: string; text?: string }[];
      structuredContent?: unknown;
    };
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

const SECRET_OBSERVATION = 'entity-secret-1234';
const DAY = 86_400_000;

type FactType = 'world' | 'experience' | 'observation';

interface FixtureMemory {
  id: string;
  text: string;
  fact_type: FactType;
  state: 'valid' | 'invalidated';
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  entities: string[];
  proof_count: number;
  tags: string[];
}

function memory(
  id: string,
  type: FactType,
  text: string,
  daysAgo: number,
  entities: string[] = [],
  occurredDaysAgo?: number,
): FixtureMemory {
  return {
    id,
    text,
    fact_type: type,
    state: 'valid',
    mentioned_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
    occurred_start:
      occurredDaysAgo === undefined
        ? null
        : new Date(Date.now() - occurredDaysAgo * DAY).toISOString(),
    occurred_end: null,
    entities,
    proof_count: 2,
    tags: [],
  };
}

const MEMORIES: FixtureMemory[] = [
  memory('mem-a', 'experience', 'Deploy window moved to Thursday for the alpha service.', 1, [
    'alpha',
  ], 20),
  memory('mem-b', 'experience', 'Rollback completed after the beta migration.', 2, ['beta']),
  memory('mem-c', 'experience', 'Observation runbook updated for gamma.', 5, ['gamma']),
  memory('mem-d', 'observation', 'The dashboard was slow twice during the deploy.', 10, [
    'alpha',
  ]),
  memory('mem-e', 'experience', 'Legacy deploy notes from last quarter.', 40, ['legacy']),
];

interface FixtureEntity {
  id: string;
  name: string;
  mention_count: number;
  first_seen: string;
  last_seen: string;
}

const ENTITIES: FixtureEntity[] = [
  {
    id: 'ent-a',
    name: 'Alpha Node',
    mention_count: 12,
    first_seen: '2026-09-01T08:00:00.000Z',
    last_seen: '2026-10-01T08:00:00.000Z',
  },
  {
    id: 'ent-b',
    name: 'Beta Node',
    mention_count: 7,
    first_seen: '2026-09-02T08:00:00.000Z',
    last_seen: '2026-09-28T08:00:00.000Z',
  },
  {
    id: 'ent-c',
    name: 'Gamma Node',
    mention_count: 3,
    first_seen: '2026-09-10T08:00:00.000Z',
    last_seen: '2026-09-20T08:00:00.000Z',
  },
];

interface RpcBody {
  id?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

async function installMemoryStub(
  page: Page,
  calls: MemoryCall[],
  options: { actorName: string; actorId: string },
): Promise<void> {
  const actor = {
    actor_id: options.actorId,
    name: options.actorName,
    kind: 'agent' as const,
    archived: false,
    disabled: false,
  };

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
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        stats: {
          total_nodes: 120,
          total_links: 240,
          total_documents: 8,
          by_fact_type: { world: 4, experience: 3, observation: 1 },
          links_by_type: { semantic: 120, temporal: 80, entity: 40 },
          pending_operations: 0,
          failed_operations: 0,
          last_write_at: MEMORIES[0]!.mentioned_at,
          last_consolidated_at: MEMORIES[0]!.mentioned_at,
        },
      };
    } else if (name === 'network_agent_memory_graph') {
      const type = typeof args.type === 'string' ? args.type : '';
      const limit = typeof args.limit === 'number' ? args.limit : 120;
      const allNodes = [
        {
          id: 'mem-a',
          label: 'Deploy window',
          text: 'Deploy window moved',
          fact_type: 'experience' as const,
          date: MEMORIES[0]!.mentioned_at,
          entities: ['alpha'],
          mention_count: 4,
        },
        {
          id: 'mem-b',
          label: 'Rollback completed',
          text: 'Rollback completed',
          fact_type: 'experience' as const,
          date: MEMORIES[1]!.mentioned_at,
          entities: ['beta'],
          mention_count: 2,
        },
        {
          id: 'mem-d',
          label: 'Dashboard slow',
          text: 'Dashboard slow',
          fact_type: 'observation' as const,
          date: MEMORIES[3]!.mentioned_at,
          entities: ['alpha'],
          mention_count: 1,
        },
      ];
      const nodes = allNodes
        .filter((node) => !type || node.fact_type === type)
        .slice(0, limit);
      const ids = new Set(nodes.map((node) => node.id));
      const edges = [
        { id: 'edge-1', source: 'mem-a', target: 'mem-b', type: 'semantic', weight: 2 },
        { id: 'edge-2', source: 'mem-a', target: 'mem-d', type: 'entity', weight: 1 },
      ].filter((edge) => ids.has(edge.source) && ids.has(edge.target));
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        nodes,
        edges,
        total_units: 320,
        total_edges: 900,
        raw_node_count: 320,
        raw_edge_count: 900,
        limit: 120,
        truncated: true,
      };
    } else if (name === 'network_agent_memory_timeline') {
      const days = Number(args.days ?? 30);
      const type = typeof args.type === 'string' ? args.type : '';
      const tzOffsetMinutes = Number(args.tz_offset_minutes ?? 0);
      const timeZone = typeof args.timezone === 'string' ? args.timezone : undefined;
      const cutoff = Date.now() - days * DAY;
      const items: TimelineFixtureItem[] = MEMORIES.filter((item) => {
        if (type && item.fact_type !== type) return false;
        const at = item.mentioned_at ? Date.parse(item.mentioned_at) : Number.NaN;
        return Number.isFinite(at) && at >= cutoff;
      })
        .sort(
          (left, right) =>
            Date.parse(right.occurred_start ?? right.mentioned_at ?? '') -
            Date.parse(left.occurred_start ?? left.mentioned_at ?? ''),
        )
        .map((item) => ({
          id: item.id,
          text:
            item.id === 'mem-a'
              ? `${item.text} password=${SECRET_OBSERVATION}`
              : item.text,
          fact_type: item.fact_type,
          state: 'valid' as const,
          occurred_at: item.occurred_start,
          mentioned_at: item.mentioned_at ?? '',
          entities: item.entities.slice(0, 3),
        }));
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        items,
        groups: {
          day: timelineGroups(items, 'day', timeZone, tzOffsetMinutes),
          week: timelineGroups(items, 'week', timeZone, tzOffsetMinutes),
          month: timelineGroups(items, 'month', timeZone, tzOffsetMinutes),
        },
        summary: {
          total: items.length,
          returned: items.length,
          dated: items.length,
          undated: 0,
          by_type: {
            world: items.filter((item) => item.fact_type === 'world').length,
            experience: items.filter((item) => item.fact_type === 'experience').length,
            observation: items.filter((item) => item.fact_type === 'observation').length,
          },
        },
        days,
        limit: Number(args.limit ?? 300),
        truncated: items.length > 4,
      };
    } else if (name === 'network_agent_memory_list') {
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 20);
      const type = typeof args.type === 'string' ? args.type : '';
      const start = typeof args.start_date === 'string' ? Date.parse(args.start_date) : null;
      const end = typeof args.end_date === 'string' ? Date.parse(args.end_date) : null;
      const filtered = MEMORIES.filter((item) => {
        if (type && item.fact_type !== type) return false;
        if (start !== null || end !== null) {
          const at = item.mentioned_at ? Date.parse(item.mentioned_at) : Number.NaN;
          if (!Number.isFinite(at)) return false;
          if (start !== null && at < start) return false;
          if (end !== null && at > end) return false;
        }
        return true;
      });
      const pageItems = filtered.slice(offset, offset + limit);
      const next = offset + pageItems.length < filtered.length ? offset + pageItems.length : null;
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        items: pageItems,
        total: filtered.length,
        limit,
        offset,
        has_more: next !== null,
        next_offset: next,
        truncated: false,
      };
    } else if (name === 'network_agent_memory_get') {
      const memoryId = String(args.memory_id ?? 'mem-a');
      const base = MEMORIES.find((item) => item.id === memoryId) ?? MEMORIES[0]!;
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        memory: {
          ...base,
          id: memoryId,
          context: 'context for the selected memory',
          source_memories: [],
          history_count: 1,
          text_truncated: false,
        },
      };
    } else if (name === 'network_agent_memory_entities') {
      const view = typeof args.view === 'string' ? args.view : 'list';
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 50);
      let entity = null;
      let graph = null;
      let pageItems: FixtureEntity[] = [];
      let total = ENTITIES.length;
      let hasMore = false;
      let nextOffset: number | null = null;
      if (view === 'detail') {
        const entityId = String(args.entity_id ?? 'ent-a');
        const base = ENTITIES.find((item) => item.id === entityId) ?? ENTITIES[0]!;
        entity = {
          ...base,
          observations: [
            {
              id: 'obs-1',
              text: `Observation for ${base.name}: password=${SECRET_OBSERVATION}`,
              proof_count: 3,
            },
          ],
          memories: [
            {
              id: 'mem-a',
              text_preview: `Related memory for ${base.name}: password=${SECRET_OBSERVATION}`,
              fact_type: 'experience' as const,
              mentioned_at: MEMORIES[0]!.mentioned_at,
            },
            {
              id: 'mem-b',
              text_preview: 'Rollback completed after the beta migration.',
              fact_type: 'experience' as const,
              mentioned_at: MEMORIES[1]!.mentioned_at,
            },
          ],
        };
      } else if (view === 'graph') {
        graph = {
          nodes: [
            {
              id: 'ent-a',
              label: 'Alpha Node',
              mention_count: 12,
              date: '2026-10-01T08:00:00.000Z',
            },
            {
              id: 'ent-b',
              label: 'Beta Node',
              mention_count: 7,
              date: '2026-09-28T08:00:00.000Z',
            },
          ],
          edges: [
            { id: 'co-1', source: 'ent-a', target: 'ent-b', type: 'cooccurrence', weight: 3 },
          ],
          total_entities: 40,
          total_edges: 55,
          raw_node_count: 40,
          raw_edge_count: 55,
          limit: 200,
          truncated: true,
        };
      } else {
        // 分页 fixture：每页最多 2 个实体，便于验证「加载更多」。
        pageItems = ENTITIES.slice(offset, offset + Math.min(limit, 2));
        hasMore = offset + pageItems.length < total;
        nextOffset = hasMore ? offset + pageItems.length : null;
      }
      structuredContent = {
        available: true,
        reason: 'ok',
        actor,
        fetched_at: Date.now(),
        view,
        items: pageItems,
        total,
        limit,
        offset,
        has_more: hasMore,
        next_offset: nextOffset,
        entity,
        graph,
        truncated: false,
        partial: false,
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

function graphCalls(calls: MemoryCall[]): MemoryCall[] {
  return calls.filter((call) => call.name === 'network_agent_memory_graph');
}

test.describe('Agent 记忆：星座、时间线、实体', () => {
  let base = '';
  let tokenA = '';
  let agentName = '';
  let agentId = '';
  let directRoom = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    agentName = `Graph Agent ${suffix}`;

    await callTool(base, tokenA, 'network_register', {
      request_id: requestId('e2e_graph_reg'),
      kind: 'human',
      name: `Graph Human ${suffix}`,
      device_id: `e2e-graph-${suffix}`,
    });
    const agent = await callTool<{ actor_id: string }>(base, tokenA, 'network_agent_create', {
      request_id: requestId('e2e_graph_agent'),
      name: agentName,
    });
    agentId = agent.actor_id;
    const direct = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_graph_direct'),
        kind: 'direct',
        members: [agentId],
      },
    );
    directRoom = direct.room.room_id;
  });

  test('星座图渲染、筛选、节点数、缩放拖拽、详情与截断', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);

    await page.locator('#memory-tab-constellation').click();
    const canvas = page.locator('#memory-graph-canvas');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await expect(canvas).toHaveAttribute('data-node-count', '3');
    await expect(canvas).toHaveAttribute('data-edge-count', '2');
    await expect(page.locator('#memory-graph-summary')).toContainText('3 个节点');
    await expect(page.locator('#memory-graph-truncated')).toContainText('已截断');
    await expect(page.locator('#memory-graph-truncated')).toContainText('120 节点 / 600 边');

    // 类型筛选走到服务端；world 在 fixture 中为空。
    const beforeType = graphCalls(calls).length;
    await page.selectOption('#memory-graph-type-filter', 'world');
    await expect.poll(() => graphCalls(calls).length).toBeGreaterThan(beforeType);
    await expect.poll(() => graphCalls(calls).some((call) => call.args.type === 'world')).toBe(true);
    await expect(page.locator('#memory-graph-status')).toHaveAttribute('data-state', 'empty');
    await expect(page.locator('#memory-graph-status')).toContainText('没有「世界」类型的记忆节点');

    await page.selectOption('#memory-graph-type-filter', 'observation');
    await expect(canvas).toHaveAttribute('data-node-count', '1');
    // 单节点布局归一到画布中心；点击中心应命中节点并打开复用的 MemoryDetail。
    await page.waitForTimeout(100);
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#memory-detail-text')).toContainText('The dashboard was slow');
    await page.locator('#memory-detail-close').click();
    await expect(page.locator('#memory-detail-text')).toHaveCount(0);
    await expect(page.locator('#memory-tab-constellation')).toBeFocused();

    // 节点数上限透传。
    const beforeLimit = graphCalls(calls).length;
    await page.selectOption('#memory-graph-limit', '20');
    await expect.poll(() => graphCalls(calls).length).toBeGreaterThan(beforeLimit);
    await expect.poll(() => graphCalls(calls).some((call) => call.args.limit === 20)).toBe(true);

    // 键盘列表替代：选中经验节点打开详情。
    await page.selectOption('#memory-graph-type-filter', 'experience');
    await expect(page.locator('#memory-graph-list tbody tr')).toHaveCount(2);
    await page.locator('#memory-graph-list tbody tr').first().locator('button').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    await page.locator('#memory-detail-close').click();

    // 缩放按钮、滚轮与拖拽。
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');
    await page.locator('#memory-graph-canvas-zoom-in').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('125%');
    await page.locator('#memory-graph-canvas-reset').click();
    await expect(page.locator('.memory-graph-zoom')).toHaveText('100%');
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, -200);
    await expect(page.locator('.memory-graph-zoom')).not.toHaveText('100%');
    await page.locator('#memory-graph-canvas-reset').click();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 20);
    await page.mouse.up();
    await expect(page.locator('#memory-detail-text')).toHaveCount(0);

    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);
  });

  test('时间线一次取数、分组导航、缩放、详情与截断', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);
    await page.locator('#memory-tab-timeline').click();

    const chart = page.locator('#memory-timeline-chart');
    const cards = chart.locator('.memory-timeline-card');
    const timelineCalls = () =>
      calls.filter((call) => call.name === 'network_agent_memory_timeline');
    const listCalls = () => calls.filter((call) => call.name === 'network_agent_memory_list');

    await expect(chart).toBeVisible({ timeout: 15_000 });
    await expect(cards).toHaveCount(4);
    await expect(page.locator('#memory-timeline-note')).toContainText('共 4 条');
    await expect.poll(timelineCalls).toHaveLength(1);
    expect(listCalls()).toHaveLength(0);
    const browserOffset = await page.evaluate(() => -new Date().getTimezoneOffset());
    const browserZone = await page.evaluate(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(timelineCalls()[0]?.args.tz_offset_minutes).toBe(browserOffset);
    expect(timelineCalls()[0]?.args.timezone).toBe(browserZone);
    const chartText = (await chart.textContent()) ?? '';
    expect(chartText).not.toContain(SECRET_OBSERVATION);
    expect(chartText).toContain('[已隐藏]');
    const dialogText = (await page.locator('#agent-memory-dialog').textContent()) ?? '';
    expect(dialogText).not.toContain(tokenA);
    expect(dialogText).not.toMatch(/\bbank\b|\bprovider\b/iu);

    // 默认月粒度；切换粒度、导航和缩放都不重新请求。
    const beforeInteraction = timelineCalls().length;
    await page.locator('#memory-timeline-granularity-day').click();
    const groups = chart.locator('.memory-timeline-group');
    await expect(groups).toHaveCount(4);
    await expect(page.locator('#memory-timeline-position')).toHaveText('1 / 4');
    const firstGroupKey = await groups.first().getAttribute('data-timeline-group');
    const firstCardText = (await cards.first().textContent()) ?? '';
    const cardDate = firstCardText.match(/(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})/u);
    expect(firstGroupKey).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(cardDate).not.toBeNull();
    expect(firstGroupKey).toBe(
      `${firstGroupKey!.slice(0, 4)}-${cardDate![1]!.padStart(2, '0')}-${cardDate![2]!.padStart(2, '0')}`,
    );
    await page.locator('#memory-timeline-next').click();
    await expect(page.locator('#memory-timeline-position')).toHaveText('2 / 4');
    await page.locator('#memory-timeline-last').click();
    await expect(page.locator('#memory-timeline-position')).toHaveText('4 / 4');
    await page.locator('#memory-timeline-first').click();
    await expect(page.locator('#memory-timeline-position')).toHaveText('1 / 4');
    await expect(page.locator('#memory-timeline-prev')).toBeDisabled();

    await page.locator('#memory-timeline-granularity-month').click();
    await page.locator('#memory-timeline-zoom-in').click();
    await expect(page.locator('#memory-timeline-granularity-week')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#memory-timeline-zoom-out').click();
    await expect(page.locator('#memory-timeline-granularity-month')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#memory-timeline-granularity-year').click();
    await expect(page.locator('#memory-timeline-granularity-year')).toHaveAttribute('aria-pressed', 'true');
    await expect(chart).toBeVisible();
    expect(timelineCalls()).toHaveLength(beforeInteraction);

    // 键盘打开详情，关闭后焦点回到事件卡片；详情复用 MemoryDetail。
    await page.locator('#memory-timeline-granularity-day').click();
    await cards.first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    await page.locator('#memory-detail-close').click();
    await expect(page.locator('#memory-detail-text')).toHaveCount(0);
    await expect(cards.first()).toBeFocused();

    // 发生时间与提及时间不同：卡片和详情头部都必须按发生时间显示同一天。
    const occurred = MEMORIES[0]!;
    expect(occurred.occurred_start).not.toBeNull();
    expect(occurred.occurred_start).not.toBe(occurred.mentioned_at);
    const occurredCard = chart.locator('.memory-timeline-card[data-timeline-id="mem-a"]');
    await expect(occurredCard).toBeVisible();
    const cardTime = (await occurredCard.locator('.memory-timeline-card-time').textContent()) ?? '';
    await occurredCard.click();
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    const detailTime = (await page.locator('#memory-detail-time').textContent()) ?? '';
    const occurredDay = await page.evaluate(
      (iso) => new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
      occurred.occurred_start!,
    );
    const mentionedDay = await page.evaluate(
      (iso) => new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
      occurred.mentioned_at!,
    );
    expect(occurredDay).not.toBe(mentionedDay);
    expect(cardTime).toContain(occurredDay);
    expect(detailTime).toContain(occurredDay);
    expect(detailTime).not.toContain(mentionedDay);
    await page.locator('.memory-detail-more summary').click();
    const moreInfo = (await page.locator('.memory-detail-more').textContent()) ?? '';
    expect(moreInfo).toContain('发生时间');
    expect(moreInfo).toContain('提及时间');
    await page.locator('#memory-detail-close').click();
    await expect(page.locator('#memory-detail-text')).toHaveCount(0);

    await page.selectOption('#memory-timeline-range', '7');
    await expect(cards).toHaveCount(3);
    await expect.poll(timelineCalls).toHaveLength(beforeInteraction + 1);
    expect(timelineCalls().at(-1)?.args.days).toBe(7);

    await page.selectOption('#memory-timeline-range', '90');
    await expect(cards).toHaveCount(5);
    await expect(page.locator('#memory-timeline-truncated')).toBeVisible();
    await expect(page.locator('#memory-timeline-truncated')).toContainText('已截断');

    await page.selectOption('#memory-timeline-type-filter', 'world');
    await expect(page.locator('#memory-timeline-status')).toHaveAttribute('data-state', 'empty');
    await expect(page.locator('#memory-timeline-chart')).toHaveCount(0);
    await expect.poll(() => calls.some((call) => call.name === 'network_agent_memory_timeline' && call.args.type === 'world')).toBe(true);
    await page.selectOption('#memory-timeline-type-filter', 'all');
    await expect(chart).toBeVisible();
    expect(listCalls()).toHaveLength(0);

    const serious = (
      await new AxeBuilder({ page })
        .include('#agent-memory-dialog')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    ).violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
    expect(serious.map((item) => `${item.id}(${item.impact})`)).toEqual([]);
  });

  test('实体分页、客户端筛选、共现图与实体详情→记忆详情', async ({ page }) => {
    const calls: MemoryCall[] = [];
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);
    await page.locator('#memory-tab-entities').click();

    const entityRows = page.locator('#memory-entities-list .memory-entity-row');
    await expect(entityRows).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('#memory-entities-filter-note')).toContainText('只在已加载的 2 个实体中筛选');
    await page.locator('#memory-entities-more').click();
    await expect(entityRows).toHaveCount(3);
    await expect(page.locator('#memory-entities-range')).toContainText('已加载 3 / 3 个实体');

    await page.locator('#memory-entities-search').fill('beta');
    await expect(entityRows).toHaveCount(1);
    await expect(entityRows.first()).toContainText('Beta Node');
    await page.locator('#memory-entities-search').fill('');

    await entityRows.first().click();
    await expect(page.locator('#memory-entity-detail')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#memory-entity-observations')).toContainText('Observation for Alpha Node');
    const entityText = (await page.locator('#memory-entity-detail').textContent()) ?? '';
    expect(entityText).not.toContain(SECRET_OBSERVATION);
    expect(entityText).toContain('[已隐藏]');

    await page.locator('#memory-entity-memories button').first().click();
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#memory-detail-text')).not.toContainText(SECRET_OBSERVATION);
    await page.locator('#memory-detail-close').click();

    await page.locator('#memory-entities-view-graph').click();
    const graphCanvas = page.locator('#memory-entity-graph-canvas');
    await expect(graphCanvas).toBeVisible({ timeout: 15_000 });
    await expect(graphCanvas).toHaveAttribute('data-node-count', '2');
    await expect(page.locator('#memory-entity-graph-summary')).toContainText('2 个实体');
    await expect(page.locator('#memory-entity-graph-truncated')).toContainText('已截断');

    await page.locator('#memory-entity-graph-list tbody tr').first().locator('button').click();
    await expect(page.locator('#memory-entity-detail')).toContainText('Alpha Node');
    await page.locator('#memory-entities-view-list').click();
    await expect(page.locator('#memory-entities-list')).toBeVisible();
  });

  test('三个视图在首次点击对应 Tab 前不加载 chunk', async ({ page }) => {
    const calls: MemoryCall[] = [];
    const assets: string[] = [];
    page.on('request', (request) => assets.push(request.url()));
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);

    await expect(page.locator('#memory-overview-state')).toHaveCount(0);
    await expect(page.locator('#memory-stat-nodes')).toHaveText('120');
    expect(assets.some((url) => /AgentMemoryDialog-[^/]+\.js/u.test(url))).toBe(true);
    expect(assets.some((url) => /MemoryConstellation-[^/]+\.js/u.test(url))).toBe(false);
    expect(assets.some((url) => /MemoryTimeline-[^/]+\.js/u.test(url))).toBe(false);
    expect(assets.some((url) => /MemoryEntities-[^/]+\.js/u.test(url))).toBe(false);

    await page.locator('#memory-tab-constellation').click();
    await expect(page.locator('#memory-graph-canvas')).toBeVisible({ timeout: 15_000 });
    expect(assets.some((url) => /MemoryConstellation-[^/]+\.js/u.test(url))).toBe(true);
    expect(assets.some((url) => /MemoryTimeline-[^/]+\.js/u.test(url))).toBe(false);
    expect(assets.some((url) => /MemoryEntities-[^/]+\.js/u.test(url))).toBe(false);

    await page.locator('#memory-tab-timeline').click();
    await expect(page.locator('#memory-timeline-chart')).toBeVisible({ timeout: 15_000 });
    expect(assets.some((url) => /MemoryTimeline-[^/]+\.js/u.test(url))).toBe(true);
    expect(assets.some((url) => /MemoryEntities-[^/]+\.js/u.test(url))).toBe(false);

    await page.locator('#memory-tab-entities').click();
    await expect(page.locator('#memory-entities-list')).toBeVisible({ timeout: 15_000 });
    expect(assets.some((url) => /MemoryEntities-[^/]+\.js/u.test(url))).toBe(true);

    // 键盘切换 Tab：ArrowLeft 回到时间线，焦点跟随。
    await page.locator('#memory-tab-entities').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#memory-tab-timeline')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#memory-tab-timeline')).toBeFocused();
    await expect(page.locator('#memory-panel-timeline')).toBeVisible();
  });

  test('390 全屏、暗色、横向可滚动 Tab 与底部详情', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const calls: MemoryCall[] = [];
    await installMemoryStub(page, calls, { actorName: agentName, actorId: agentId });
    await login(page, base, tokenA);
    await openRowMemory(page, directRoom);

    const box = await page.locator('#agent-memory-dialog').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.width).toBeLessThanOrEqual(391);
    expect(await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    const background = await page.evaluate(
      () => getComputedStyle(document.querySelector('#agent-memory-dialog') as HTMLElement).backgroundColor,
    );
    expect(background).toBe('rgb(43, 43, 43)');
    const tabsOverflow = await page.evaluate(
      () => getComputedStyle(document.querySelector('.memory-tabs') as HTMLElement).overflowX,
    );
    expect(tabsOverflow).toBe('auto');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    await page.locator('#memory-tab-constellation').click();
    await expect(page.locator('#memory-graph-canvas')).toBeVisible({ timeout: 15_000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);

    await page.locator('#memory-graph-list tbody tr').first().locator('button').click();
    await expect(page.locator('.memory-detail-column')).toBeVisible();
    const detail = await page.locator('.memory-detail-column').boundingBox();
    expect(detail).not.toBeNull();
    expect(detail!.width).toBeGreaterThanOrEqual(389);
    expect(detail!.y + detail!.height).toBeLessThanOrEqual(845);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.locator('#memory-detail-close').click();
    await expect(page.locator('.memory-detail-column')).toBeHidden();

    await page.locator('#memory-tab-timeline').click();
    await expect(page.locator('#memory-timeline-chart')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#memory-timeline-chart .memory-timeline-card')).toHaveCount(4);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.locator('#memory-timeline-chart .memory-timeline-card').first().click();
    await expect(page.locator('#memory-detail-text')).toBeVisible({ timeout: 15_000 });
    const timelineDetail = await page.locator('.memory-detail-column').boundingBox();
    expect(timelineDetail).not.toBeNull();
    expect(timelineDetail!.width).toBeGreaterThanOrEqual(389);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.locator('#memory-detail-close').click();
    await expect(page.locator('.memory-detail-column')).toBeHidden();
  });
});
