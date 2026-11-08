/**
 * 长历史性能基准与查询计划守卫。
 *
 * 默认 small（10k 消息）；`PERF_SCALE=full` 为 100k，标记为手动运行。
 *
 * 运行：
 *   bun run test:perf
 *   PERF_SCALE=full bun run test:perf
 *   # 在引入 0039 索引之前记录基线：
 *   PERF_EXPECT_INDEX=0 bun scripts/verify-perf.ts --out reports/evidence/perf-baseline-small.json
 *
 * 测量的是领域函数 + D1 兼容层 + SQLite 的本地耗时，不是网络 RTT；
 * 报告中的 p50/p95 只用于同一台机器上的前后对比，不能当成线上延迟。
 */

import { Database } from 'bun:sqlite';

import { createD1 } from '../src/bun/d1';
import { historyList } from '../src/domain/messages';
import { roomsList } from '../src/domain/rooms';
import { timelineList } from '../src/domain/timeline';
import { historyBoundary } from '../src/domain/room-history';
import type { Principal } from '../src/domain/principal';
import { getActor, getMember, getRoom } from '../src/storage/queries';
import type { ActorRow } from '../src/storage/rows';
import type { HistoryListInput, RoomsListInput } from '../src/contracts/schemas';
import { createPerfFixture, type PerfScale } from './lib/perf-fixture';

const LIMIT = 50;

interface ExecutedQuery {
  sql: string;
  values: unknown[];
}

interface Timed {
  p50_ms: number;
  p95_ms: number;
  min_ms: number;
  max_ms: number;
  samples: number;
  payload_bytes: number;
  sql_statements: number;
  results: number;
}

interface Scenario {
  name: string;
  timed: Timed;
  plan: string[];
}

interface Report {
  scale: PerfScale;
  expect_index: boolean;
  counts: Record<string, number>;
  scenarios: Scenario[];
  checks: string[];
  notes: string[];
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index]!;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 记录每次实际执行的 SQL，供 SQL 条数与 EXPLAIN QUERY PLAN 使用。 */
function instrument(inner: D1Database): { db: D1Database; executed: ExecutedQuery[] } {
  const executed: ExecutedQuery[] = [];
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
    values: unknown[],
  ): D1PreparedStatement => ({
    bind: (...next) => wrap(statement.bind(...next), sql, next),
    first: async <T = unknown>(colName?: string) => {
      executed.push({ sql, values });
      return statement.first<T>(colName);
    },
    all: async <T = unknown>() => {
      executed.push({ sql, values });
      return statement.all<T>();
    },
    run: async <T = unknown>() => {
      executed.push({ sql, values });
      return statement.run<T>();
    },
    raw: async <T = unknown>() => {
      executed.push({ sql, values });
      return statement.raw<T>();
    },
  });
  const db: D1Database = {
    prepare: (sql) => wrap(inner.prepare(sql), sql, []),
    batch: (statements) => inner.batch(statements),
    exec: (query) => inner.exec(query),
  };
  return { db, executed };
}

async function measure(
  executed: ExecutedQuery[],
  run: () => Promise<{ payload: unknown; results: number }>,
  samples: number,
): Promise<Timed> {
  for (let i = 0; i < 3; i += 1) await run();
  const durations: number[] = [];
  let payloadBytes = 0;
  let sqlStatements = 0;
  let results = 0;
  for (let i = 0; i < samples; i += 1) {
    const before = executed.length;
    const started = performance.now();
    const output = await run();
    durations.push(performance.now() - started);
    sqlStatements = executed.length - before;
    payloadBytes = Buffer.byteLength(JSON.stringify(output.payload), 'utf8');
    results = output.results;
  }
  const sorted = durations.slice().sort((a, b) => a - b);
  return {
    p50_ms: round(percentile(sorted, 0.5)),
    p95_ms: round(percentile(sorted, 0.95)),
    min_ms: round(sorted[0] ?? 0),
    max_ms: round(sorted.at(-1) ?? 0),
    samples,
    payload_bytes: payloadBytes,
    sql_statements: sqlStatements,
    results,
  };
}

function explain(db: Database, query: ExecutedQuery): string[] {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...(query.values as never[])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail);
}

function findQuery(executed: ExecutedQuery[], pattern: RegExp): ExecutedQuery | null {
  for (let i = executed.length - 1; i >= 0; i -= 1) {
    if (pattern.test(executed[i]!.sql)) return executed[i]!;
  }
  return null;
}

function assert(condition: boolean, label: string, detail?: unknown): void {
  if (!condition) {
    throw new Error(`${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
  console.log(`  ✓ ${label}`);
}

function hasAll(plan: string[], needles: string[]): boolean {
  const text = plan.join('\n');
  return needles.every((needle) => text.includes(needle));
}

function hasScan(plan: string[], table: string): boolean {
  return plan.some((line) => new RegExp(`\\bSCAN ${table}\\b`, 'u').test(line));
}

function hasTempSort(plan: string[]): boolean {
  return plan.some((line) => /TEMP B-TREE/u.test(line));
}

function selectStarOffenders(queries: ExecutedQuery[]): string[] {
  return queries
    .filter((query) => {
      const sql = query.sql.replace(/\s+/gu, ' ');
      return (
        /SELECT \* FROM messages\b/iu.test(sql) ||
        /SELECT \* FROM actors\b/iu.test(sql) ||
        /SELECT \* FROM deliveries\b/iu.test(sql)
      );
    })
    .map((query) => query.sql.replace(/\s+/gu, ' '));
}

async function main(): Promise<void> {
  const scale = (process.env.PERF_SCALE ?? 'small') as PerfScale;
  if (scale !== 'small' && scale !== 'full') throw new Error(`未知 PERF_SCALE: ${scale}`);
  const expectIndex = process.env.PERF_EXPECT_INDEX !== '0';
  const baselineMode = process.env.PERF_BASELINE === '1';
  const samples = Number(process.env.PERF_SAMPLES ?? (scale === 'small' ? 21 : 9));
  const outputIndex = process.argv.indexOf('--out');
  const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;

  console.log(`perf fixture: scale=${scale} expect_index=${expectIndex}`);
  const fixture = createPerfFixture(scale);
  try {
    const raw = createD1(fixture.db);
    const { db, executed } = instrument(raw);
    const actor = await getActor(db, fixture.viewerId);
    if (!actor) throw new Error('fixture viewer 不存在');
    const principal: Principal = {
      credentialHash: 'perf-fixture',
      actor: actor as ActorRow,
      credential: null,
    };
    const room = await getRoom(db, fixture.roomId);
    if (!room) throw new Error('fixture room 不存在');
    const member = await getMember(db, fixture.roomId, fixture.viewerId);
    if (!member) throw new Error('fixture member 不存在');
    const boundary = historyBoundary(room, member);

    const historyInput = (cursor?: string): HistoryListInput => ({
      room_id: fixture.roomId,
      direction: 'before',
      limit: LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    const timelineInput = (cursor?: string): HistoryListInput => ({
      ...historyInput(cursor),
      view: 'timeline',
    });

    async function historyPage(cursor?: string) {
      const page = await historyList(db, principal, historyInput(cursor));
      if ('timeline_items' in page) throw new Error('history 返回了 timeline');
      return page;
    }
    async function timelinePage(cursor?: string) {
      const page = await timelineList(db, room!, timelineInput(cursor), boundary);
      return page;
    }

    async function historyCursorFor(pageNumber: number): Promise<string | null> {
      let cursor: string | null = null;
      for (let page = 1; page < pageNumber; page += 1) {
        const current: Awaited<ReturnType<typeof historyPage>> = await historyPage(
          cursor ?? undefined,
        );
        cursor = current.next_cursor;
        if (!cursor) return null;
      }
      return cursor;
    }
    async function timelineCursorFor(pageNumber: number): Promise<string | null> {
      let cursor: string | null = null;
      for (let page = 1; page < pageNumber; page += 1) {
        const current = await timelinePage(cursor ?? undefined);
        cursor = current.timeline_next_cursor;
        if (!cursor) return null;
      }
      return cursor;
    }

    const scenarios: Scenario[] = [];
    const notes: string[] = [];

    // -------- messages 视图翻页 --------
    for (const pageNumber of [1, 10, 100]) {
      const cursor = pageNumber === 1 ? null : await historyCursorFor(pageNumber);
      if (pageNumber > 1 && !cursor) {
        notes.push(`messages 第 ${pageNumber} 页不可达（房间消息数不足）`);
        continue;
      }
      executed.length = 0;
      const timed = await measure(
        executed,
        async () => {
          const page = await historyPage(cursor ?? undefined);
          return { payload: page, results: page.items.length };
        },
        samples,
      );
      const planQuery = findQuery(executed, /FROM messages[\s\S]*ORDER BY created_seq/u);
      const plan = planQuery ? explain(fixture.db, planQuery) : [];
      scenarios.push({ name: `messages_page_${pageNumber}`, timed, plan });
    }

    // -------- timeline（人类默认视图）翻页 --------
    for (const pageNumber of [1, 10, 100]) {
      const cursor = pageNumber === 1 ? null : await timelineCursorFor(pageNumber);
      if (pageNumber > 1 && !cursor) {
        notes.push(`timeline 第 ${pageNumber} 页不可达（时间线条目不足）`);
        continue;
      }
      executed.length = 0;
      const timed = await measure(
        executed,
        async () => {
          const page = await timelinePage(cursor ?? undefined);
          return { payload: page, results: page.timeline_items.length };
        },
        samples,
      );
      const planQuery = findQuery(executed, /AS timeline/u);
      const plan = planQuery ? explain(fixture.db, planQuery) : [];
      scenarios.push({ name: `timeline_page_${pageNumber}`, timed, plan });
    }

    // -------- rooms_list --------
    executed.length = 0;
    const roomsInput: RoomsListInput = { limit: 50 };
    const roomsTimed = await measure(
      executed,
      async () => {
        const page = await roomsList(db, principal, roomsInput);
        return { payload: page, results: page.items.length };
      },
      samples,
    );
    const roomsPlanQuery = findQuery(executed, /LEFT JOIN messages lm/u);
    const roomsPlan = roomsPlanQuery ? explain(fixture.db, roomsPlanQuery) : [];
    scenarios.push({ name: 'rooms_list', timed: roomsTimed, plan: roomsPlan });

    // -------- 计划与投影断言 --------
    const names = new Set(scenarios.map((scenario) => scenario.name));
    const checks: string[] = [];
    const check = (condition: boolean, label: string, detail?: unknown) => {
      assert(condition, label, detail);
      checks.push(label);
    };

    const historyScenario = scenarios.find((s) => s.name === 'messages_page_1');
    if (!historyScenario) throw new Error('缺少 messages_page_1');
    check(
      hasAll(historyScenario.plan, ['idx_messages_room_seq']),
      'messages 分页使用 idx_messages_room_seq',
      historyScenario.plan,
    );
    check(!hasScan(historyScenario.plan, 'messages'), 'messages 分页无全表扫描', historyScenario.plan);
    check(!hasTempSort(historyScenario.plan), 'messages 分页无临时排序', historyScenario.plan);

    const timelineScenario = scenarios.find((s) => s.name === 'timeline_page_1');
    if (!timelineScenario) throw new Error('缺少 timeline_page_1');
    check(
      hasAll(timelineScenario.plan, ['idx_messages_room_seq', 'idx_room_presence_seq']),
      'timeline 双源都走索引',
      timelineScenario.plan,
    );
    check(!hasScan(timelineScenario.plan, 'messages'), 'timeline 无 messages 全表扫描', timelineScenario.plan);
    check(
      !hasScan(timelineScenario.plan, 'room_presence_events'),
      'timeline 无 presence 全表扫描',
      timelineScenario.plan,
    );
    if (hasTempSort(timelineScenario.plan)) {
      // 第 2 波（双路归并）的目标；第 1 波只记录，不让守卫误判为回归。
      notes.push('timeline 双源 UNION ALL 仍使用 TEMP B-TREE 排序（第 2 波处理）');
    }

    const roomsScenario = scenarios.find((s) => s.name === 'rooms_list');
    if (!roomsScenario) throw new Error('缺少 rooms_list');
    check(hasAll(roomsScenario.plan, ['idx_room_members_actor']), 'rooms_list 走成员索引', roomsScenario.plan);
    check(!hasScan(roomsScenario.plan, 'messages'), 'rooms_list 的 last_message 走主键', roomsScenario.plan);

    executed.length = 0;
    await historyPage();
    const deliveryQuery = findQuery(executed, /FROM deliveries[\s\S]*GROUP BY message_id, state/u);
    if (!deliveryQuery) throw new Error('未捕获 delivery 聚合 SQL');
    const deliveryPlan = explain(fixture.db, deliveryQuery);
    const indexExists = Boolean(
      fixture.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_deliveries_message_state'")
        .get(),
    );
    if (expectIndex) {
      check(indexExists, '0039 覆盖索引已应用');
      check(
        hasAll(deliveryPlan, ['idx_deliveries_message_state']),
        'delivery 聚合使用覆盖索引',
        deliveryPlan,
      );
      check(!hasTempSort(deliveryPlan), 'delivery 聚合无临时分组/排序', deliveryPlan);
    } else {
      notes.push(`基线模式：覆盖索引${indexExists ? '已存在' : '不存在'}，不强制断言`);
    }

    const pageQueries = executed.filter((query) =>
      /FROM messages|FROM actors|FROM deliveries/u.test(query.sql),
    );
    const offenders = selectStarOffenders(pageQueries);
    if (baselineMode) {
      notes.push(`基线检测到 ${offenders.length} 条 SELECT *（第 1 波目标）：${offenders.join(' | ')}`);
    } else {
      assert(offenders.length === 0, '当前页查询无消息/actor/delivery 的 SELECT *', offenders);
      checks.push('当前页查询无 SELECT *');
    }
    for (const scenario of scenarios) {
      if (scenario.name.startsWith('messages_') || scenario.name.startsWith('timeline_')) {
        check(
          scenario.timed.payload_bytes < LIMIT * 4096,
          `${scenario.name} payload 不随正文增长`,
          scenario.timed.payload_bytes,
        );
      }
    }
    check(names.size === scenarios.length, '场景名唯一');

    const report: Report = {
      scale,
      expect_index: expectIndex,
      counts: fixture.counts as unknown as Record<string, number>,
      scenarios,
      checks,
      notes,
    };

    console.log('\nscenario                 p50(ms)  p95(ms)  payload(B)  SQL  rows');
    for (const scenario of scenarios) {
      const t = scenario.timed;
      console.log(
        `${scenario.name.padEnd(24)} ${String(t.p50_ms).padStart(7)} ${String(t.p95_ms).padStart(8)} ` +
          `${String(t.payload_bytes).padStart(11)} ${String(t.sql_statements).padStart(4)} ${String(t.results).padStart(5)}`,
      );
    }
    if (notes.length > 0) console.log(`\nnotes:\n- ${notes.join('\n- ')}`);

    if (outputPath) {
      await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\nwrote ${outputPath}`);
    }
    console.log(`\nperf checks=${checks.length} scale=${scale} PASS`);
  } finally {
    fixture.cleanup();
  }
}

if (import.meta.main) {
  await main();
}

