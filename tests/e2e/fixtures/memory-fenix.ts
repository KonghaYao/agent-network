import type { Page } from '@playwright/test';

import { timelineGroups, type TimelineFixtureItem } from './memory-timeline';

/**
 * 记忆面板 Fenix IA 的 e2e stub。
 *
 * 只替换 `network_agent_memory_*` 的只读响应；身份、房间与其余工具走真实服务端。
 * graph 响应同时包含 `include_rows=true` 的 `table_rows` 与 `timeline.groups`，
 * 用来断言「一次取数、四视图共享」以及本地翻页/缩放大粒度不发请求。
 */

export interface MemoryCall {
  name: string;
  args: Record<string, unknown>;
}

interface RpcBody {
  id?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

export const SECRET_BEARER = 'sk-testonly-memory-panel-token';
export const SECRET_URL = 'SECRET-URL-TOKEN';
export const SECRET_CONTEXT = 'sk-testonly-context-token';
export const SECRET_PASSWORD = 'hunter2-panel-secret';
export const SECRET_ENTITY_AWS = 'AKIAENTITYSECRET1234';
export const SECRET_TAG_PASSWORD = 'tag-secret-900';

export interface FenixRow {
  id: string;
  text: string;
  fact_type: 'world' | 'experience' | 'observation';
  state: 'valid';
  occurred_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  mentioned_at: string;
  entities: string[];
  proof_count: number;
  tags: string[];
}

export function memoryRows(): FenixRow[] {
  return [
    {
      id: 'mem-1',
      text: `Deploy runbook uses Authorization: Bearer ${SECRET_BEARER} and https://example.com/hook?token=${SECRET_URL}`,
      fact_type: 'world',
      state: 'valid',
      occurred_at: '2026-10-01T09:30:00.000Z',
      occurred_start: null,
      occurred_end: null,
      mentioned_at: '2026-10-02T09:30:00.000Z',
      entities: ['deploy', SECRET_ENTITY_AWS, `password=${SECRET_PASSWORD}`],
      proof_count: 3,
      tags: ['ops', `password=${SECRET_TAG_PASSWORD}`],
    },
    {
      id: 'mem-2',
      text: 'Experience: deploy window is Thursday; retry after rollback.',
      fact_type: 'experience',
      state: 'valid',
      occurred_at: '2026-10-01T08:00:00.000Z',
      occurred_start: '2026-10-01T08:00:00.000Z',
      occurred_end: '2026-10-01T10:00:00.000Z',
      mentioned_at: '2026-10-01T11:00:00.000Z',
      entities: ['deploy'],
      proof_count: 2,
      tags: ['ops'],
    },
    {
      id: 'mem-3',
      text: 'Observation: the deploy dashboard was slow twice.',
      fact_type: 'observation',
      state: 'valid',
      occurred_at: '2026-09-15T03:00:00.000Z',
      occurred_start: '2026-09-15T03:00:00.000Z',
      occurred_end: null,
      mentioned_at: '2026-09-16T03:00:00.000Z',
      entities: ['dashboard'],
      proof_count: 5,
      tags: [],
    },
    {
      id: 'mem-4',
      text: 'World: the staging deploy uses an isolated project.',
      fact_type: 'world',
      state: 'valid',
      occurred_at: '2026-08-20T12:00:00.000Z',
      occurred_start: '2026-08-20T12:00:00.000Z',
      occurred_end: null,
      mentioned_at: '2026-08-21T12:00:00.000Z',
      entities: ['staging'],
      proof_count: 1,
      tags: ['staging'],
    },
    {
      id: 'mem-5',
      text: 'Undated note: remember to rotate the deploy credentials.',
      fact_type: 'world',
      state: 'valid',
      occurred_at: null,
      occurred_start: null,
      occurred_end: null,
      mentioned_at: '2026-07-01T00:00:00.000Z',
      entities: ['credentials'],
      proof_count: 1,
      tags: [],
    },
  ];
}

function toTimelineItem(row: FenixRow): TimelineFixtureItem {
  return {
    id: row.id,
    text: row.text,
    fact_type: row.fact_type,
    state: row.state,
    occurred_at: row.occurred_at,
    mentioned_at: row.mentioned_at,
    entities: row.entities,
  };
}

const timezoneArgs = (args: Record<string, unknown>) => ({
  timezone: typeof args.timezone === 'string' ? args.timezone : undefined,
  offsetMinutes: typeof args.tz_offset_minutes === 'number' ? args.tz_offset_minutes : 0,
});

function graphTimeline(rows: FenixRow[], args: Record<string, unknown>) {
  const { timezone, offsetMinutes } = timezoneArgs(args);
  const dated = rows.filter((row) => row.occurred_at !== null).map(toTimelineItem);
  const build = (granularity: 'year' | 'month' | 'week' | 'day') =>
    timelineGroups(dated, granularity, timezone, offsetMinutes).map((group) => ({
      ...group,
      // 服务端标签前缀：若前端仍在本地分组，DOM 里不会出现 "S:"。
      label: `S:${group.label}`,
    }));
  return {
    groups: { year: build('year'), month: build('month'), week: build('week'), day: build('day') },
    summary: {
      total: rows.length,
      returned: rows.length,
      dated: dated.length,
      undated: rows.length - dated.length,
      by_type: { world: 0, experience: 0, observation: 0 },
    },
    basis: 'occurred_at' as const,
  };
}

export interface InstallMemoryFenixStubOptions {
  actorId: string;
  actorName: string;
  panelDisabled?: boolean;
  /** `available=false` 但按空态渲染的服务端原因（如 bank_missing）。 */
  bankMissing?: boolean;
  graphFailure?: boolean;
  totalUnits?: number;
  rows?: FenixRow[];
  /** 让 `table_rows[].entities` 以逗号字符串返回，覆盖 tooltip 的字符串分支。 */
  graphEntitiesAsString?: boolean;
}

export async function installMemoryFenixStub(
  page: Page,
  calls: MemoryCall[],
  options: InstallMemoryFenixStubOptions,
): Promise<void> {
  const rows = options.rows ?? memoryRows();
  const actor = {
    actor_id: options.actorId,
    name: options.actorName,
    kind: 'agent' as const,
    archived: false,
    disabled: false,
  };
  const base = {
    available: true,
    reason: 'ok' as const,
    actor,
    fetched_at: 1_760_000_000_000,
  };
  const entityItems = ['Alpha Node', 'Beta Node', 'Gamma Node'].map((name, index) => ({
    id: `entity-${index + 1}`,
    name,
    mention_count: 3 - index,
    first_seen: '2026-07-01T00:00:00.000Z',
    last_seen: '2026-10-01T00:00:00.000Z',
  }));

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

    if (name === 'network_agent_memory_graph' && options.graphFailure) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ message: '上游记忆服务超时', code: 'UPSTREAM_TIMEOUT' }),
              },
            ],
          },
        }),
      });
      return;
    }

    let structuredContent: unknown;
    if (name === 'network_agent_memory_graph') {
      const unavailableReason = options.bankMissing
        ? 'bank_missing'
        : options.panelDisabled
          ? 'panel_disabled'
          : null;
      if (unavailableReason) {
        structuredContent = {
          ...base,
          available: false,
          reason: unavailableReason,
          nodes: [],
          edges: [],
          total_units: null,
          total_edges: 0,
          raw_node_count: 0,
          raw_edge_count: 0,
          limit: 120,
          truncated: false,
          table_rows: [],
          rows_truncated: false,
          timeline: graphTimeline([], args),
        };
      } else {
        const type = typeof args.type === 'string' ? args.type : '';
        const q = typeof args.q === 'string' ? args.q.toLowerCase() : '';
        const filtered = rows.filter(
          (row) =>
            (!type || row.fact_type === type) &&
            (!q || row.text.toLowerCase().includes(q)),
        );
        structuredContent = {
          ...base,
          nodes: filtered.map((row) => ({
            id: row.id,
            label: row.text.slice(0, 40),
            fact_type: row.fact_type,
          })),
          edges: [
            { id: 'edge-1', source: 'mem-1', target: 'mem-2', type: 'semantic', weight: 0.9 },
            { id: 'edge-2', source: 'mem-2', target: 'mem-3', type: 'temporal', weight: 0.4 },
          ].filter(
            (edge) =>
              filtered.some((row) => row.id === edge.source) &&
              filtered.some((row) => row.id === edge.target),
          ),
          total_units: options.totalUnits ?? (q ? filtered.length : Math.max(filtered.length, 12)),
          total_edges: 2,
          raw_node_count: filtered.length,
          raw_edge_count: 2,
          limit: 120,
          truncated: false,
          table_rows: options.graphEntitiesAsString
            ? filtered.map((row) => ({ ...row, entities: row.entities.join(', ') }))
            : filtered,
          rows_truncated: false,
          timeline: graphTimeline(filtered, args),
        };
      }
    } else if (name === 'network_agent_memory_get') {
      const id = String(args.memory_id ?? 'mem-1');
      const row = rows.find((item) => item.id === id) ?? rows[0]!;
      structuredContent = {
        ...base,
        memory: {
          ...row,
          context: `context Authorization: Bearer ${SECRET_CONTEXT}`,
          source_memories: [
            {
              id: 'source-1',
              text: 'source token=SECRET-SOURCE-TOKEN',
              type: 'world',
              mentioned_at: '2026-09-30T10:00:00.000Z',
            },
          ],
          history_count: 2,
          text_truncated: false,
        },
      };
    } else if (name === 'network_agent_memory_entities') {
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 50);
      const pageItems = entityItems.slice(offset, offset + limit);
      structuredContent = {
        ...base,
        view: args.view ?? 'list',
        items: args.view === 'graph' || args.view === 'detail' ? [] : pageItems,
        total: entityItems.length,
        limit,
        offset,
        has_more: offset + pageItems.length < entityItems.length,
        next_offset:
          offset + pageItems.length < entityItems.length ? offset + pageItems.length : null,
        entity: {
          id: 'entity-1',
          name: 'Alpha Node',
          mention_count: 3,
          first_seen: '2026-07-01T00:00:00.000Z',
          last_seen: '2026-10-01T00:00:00.000Z',
          observations: [
            { id: 'obs-1', text: 'Observation for Alpha Node', proof_count: 2 },
          ],
          memories: [
            {
              id: 'mem-1',
              text_preview: `preview Authorization: Bearer ${SECRET_BEARER}`,
              fact_type: 'world',
              mentioned_at: '2026-10-01T09:30:00.000Z',
            },
          ],
        },
        graph: {
          nodes: entityItems.map((item) => ({ id: item.id, name: item.name })),
          edges: [
            { id: 'edge-1', source: 'entity-1', target: 'entity-2', type: 'cooccurrence', weight: 4 },
            { id: 'edge-2', source: 'entity-2', target: 'entity-3', type: 'cooccurrence', weight: 2 },
          ],
          total_entities: 3,
          total_edges: 2,
          raw_node_count: 3,
          raw_edge_count: 2,
          limit: 200,
          truncated: false,
        },
        truncated: false,
        partial: false,
      };
    } else {
      // 阶段 4 后 Web 面板不得再调用 overview/list/timeline；记录后返回最小响应，
      // 让断言给出「调用次数」而不是被网络错误掩盖。
      structuredContent =
        name === 'network_agent_memory_overview'
          ? { ...base, stats: null }
          : { ...base, items: [], total: 0, limit: 50, offset: 0, has_more: false, next_offset: null, truncated: false, groups: { day: [], week: [], month: [], year: [] }, summary: { total: 0, returned: 0, dated: 0, undated: 0, by_type: { world: 0, experience: 0, observation: 0 } }, days: 30 };
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

export function callsOf(calls: MemoryCall[], name: string): MemoryCall[] {
  return calls.filter((call) => call.name === name);
}
