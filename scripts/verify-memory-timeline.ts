/**
 * 只读 Agent 记忆时间线的单元/集成验收。
 *
 * 使用真实 migrations + 内存 SQLite + 受控 Hindsight HTTP 假服务，覆盖：
 * 授权、compact 上限、天/周/月分组、无日期事件、分页合并、字节裁剪、
 * single-flight、敏感字段过滤，以及 tz_offset_minutes 的本地时区分组。
 *
 * 运行：bun run test:memory-timeline
 */
import { BusinessError } from '../src/contracts/errors';
import { LIMITS } from '../src/contracts/limits';
import { bankIdFor } from '../src/memory/adapters/hindsight-tags';
import {
  insightTimelineInputSchema,
  type InsightViewer,
} from '../src/memory/insight/contracts';
import { HindsightInsightReader } from '../src/memory/insight/hindsight-read';
import { MemoryInsightService } from '../src/memory/insight/service';
import { sortedPairKey, utf8Bytes } from '../src/storage/db';
import { check, checkEqual, checksPassed } from './lib/harness';
import { FakeHindsightInsight } from './lib/memory-insight-fake';
import { createMemoryEnv, seedActor, unique } from './lib/memory-unit';

const AT = 1_700_000_000_000;
const TOKEN = `test_timeline_${crypto.randomUUID().replaceAll('-', '')}`;
const INTERNAL_TAG = 'agentnet:o:authored';
const DOCUMENT_SECRET = 'document-secret-id';
const CHUNK_SECRET = 'chunk-secret-id';
const METADATA_SECRET = 'metadata-secret-value';

function viewer(kind: 'human' | 'agent', actorId: string): InsightViewer {
  return { kind, actor_id: actorId };
}

async function expectBusiness(
  label: string,
  promise: Promise<unknown>,
  code: string,
  insightCode?: string,
): Promise<void> {
  try {
    await promise;
    check(label, false, 'expected BusinessError');
  } catch (error) {
    check(`${label} 抛出 BusinessError`, error instanceof BusinessError);
    const business = error as BusinessError;
    checkEqual(`${label} 错误码`, business.code, code);
    if (insightCode) {
      checkEqual(`${label} insight_code`, business.details?.insight_code, insightCode);
    }
  }
}

function seedFriend(
  db: D1Database,
  left: string,
  right: string,
  status: 'active' | 'ended',
): void {
  const pairKey = sortedPairKey(left, right);
  const [actorA, actorB] = left < right ? [left, right] : [right, left];
  db.prepare(
    `INSERT INTO contact_relations
       (pair_key, actor_a, actor_b, status, source, request_id, created_at, updated_at, ended_at, ended_by)
     VALUES (?, ?, ?, ?, 'request', NULL, ?, ?, ?, NULL)`,
  )
    .bind(pairKey, actorA, actorB, status, AT, AT, status === 'ended' ? AT : null)
    .run();
}

function seedSpace(
  db: D1Database,
  input: {
    spaceId: string;
    agentId: string;
    ownershipEpoch: number;
    backendBindingEpoch: number;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_instances (instance_id, capture_default, created_at, updated_at)
     VALUES ('mni_insight', 'enabled', ?, ?)`,
  )
    .bind(AT, AT)
    .run();
  db.prepare(
    `INSERT INTO memory_spaces
       (space_id, instance_id, agent_actor_id, owner_actor_id, ownership_kind,
        ownership_epoch, backend_binding_epoch, management_binding_id, capture, active,
        created_at, updated_at)
     VALUES (?, 'mni_insight', ?, ?, 'self_owned', ?, ?, NULL, 'excluded', 1, ?, ?)`,
  )
    .bind(
      input.spaceId,
      input.agentId,
      input.agentId,
      input.ownershipEpoch,
      input.backendBindingEpoch,
      AT,
      AT,
    )
    .run();
}

function assertNoSensitive(label: string, value: unknown, bank: string): void {
  const text = JSON.stringify(value);
  check(`${label} 不含 bank`, !text.includes(bank), text.slice(0, 200));
  check(`${label} 不含 space`, !text.includes('msp_insight'), text.slice(0, 200));
  check(`${label} 不含 provider`, !text.includes('hindsight'), text.slice(0, 200));
  check(`${label} 不含凭据`, !text.includes(TOKEN), text.slice(0, 200));
  check(`${label} 不含上游地址`, !text.includes('127.0.0.1'), text.slice(0, 200));
  check(`${label} 不含 document_id`, !text.includes(DOCUMENT_SECRET), text.slice(0, 200));
  check(`${label} 不含 chunk_id`, !text.includes(CHUNK_SECRET), text.slice(0, 200));
  check(`${label} 不含 metadata`, !text.includes(METADATA_SECRET), text.slice(0, 200));
  check(`${label} 不含内部 tags`, !text.includes(INTERNAL_TAG), text.slice(0, 200));
}

async function main(): Promise<void> {
  const env = createMemoryEnv();
  const fake = new FakeHindsightInsight(TOKEN);

  const friend = unique('usr_tl_friend');
  const stranger = unique('usr_tl_stranger');
  const target = unique('agt_tl_target');
  const otherAgent = unique('agt_tl_other');

  seedActor(env, { actorId: friend, kind: 'human', name: '好友' });
  seedActor(env, { actorId: stranger, kind: 'human', name: '陌生人' });
  seedActor(env, { actorId: target, kind: 'agent', name: '目标 Agent' });
  seedActor(env, { actorId: otherAgent, kind: 'agent', name: '另一个 Agent' });
  seedFriend(env.d1, friend, target, 'active');

  const targetSpace = {
    space_id: 'msp_insight_timeline',
    ownership_epoch: 2,
    backend_binding_epoch: 3,
  };
  seedSpace(env.d1, {
    spaceId: targetSpace.space_id,
    agentId: target,
    ownershipEpoch: targetSpace.ownership_epoch,
    backendBindingEpoch: targetSpace.backend_binding_epoch,
  });
  const targetBank = await bankIdFor('agentnet', targetSpace);
  check('bank 由 space + epochs 派生', targetBank.startsWith('agentnet-') && targetBank.length === 49);

  const memories = [
    {
      id: 'm1',
      text: '事实正文'.repeat(1_000),
      fact_type: 'world',
      state: 'valid',
      mentioned_at: '2026-11-01T00:00:00Z',
      occurred_start: '2026-10-01T00:00:00Z',
      occurred_end: '2026-10-02T00:00:00Z',
      entities: 'Alice, Bob, Alice, Carol',
      entity_ids: ['e0'],
      proof_count: 2,
      tags: [INTERNAL_TAG, 'public'],
      document_id: DOCUMENT_SECRET,
      chunk_id: CHUNK_SECRET,
      metadata: { secret: METADATA_SECRET },
    },
    {
      id: 'm2',
      text: '跨日事件',
      fact_type: 'observation',
      state: 'valid',
      mentioned_at: '2026-11-02T16:30:00Z',
      occurred_start: null,
      occurred_end: null,
      entities: ['Alice'],
      proof_count: 1,
      tags: ['agentnet:s:internal', 'public'],
    },
    {
      id: 'm3',
      text: '第三条事实',
      fact_type: 'experience',
      state: 'valid',
      mentioned_at: '2026-11-03T10:00:00Z',
      occurred_start: null,
      occurred_end: null,
      entities: ['Bob'],
      proof_count: 0,
      tags: [],
    },
  ];
  fake.seedBank(targetBank, { memories });

  const clock = Date.now();
  const reader = new HindsightInsightReader({
    baseUrl: fake.baseUrl,
    apiKey: TOKEN,
    bankPrefix: 'agentnet',
    requestTimeoutMs: 1_000,
    maxRetries: 0,
  });
  const service = new MemoryInsightService({
    db: env.d1,
    reader,
    memoryEnabled: true,
    now: () => clock,
  });

  console.log('--- timeline 授权与 UTC 基线 ---');
  await expectBusiness(
    '陌生人不能查看 timeline',
    service.timeline(viewer('human', stranger), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  await expectBusiness(
    'Agent 不能查看其他 Agent 的 timeline',
    service.timeline(viewer('agent', otherAgent), { actor_id: target }),
    'PERMISSION_DENIED',
    'FORBIDDEN',
  );
  fake.resetRequests();
  const timeline = await service.timeline(viewer('human', friend), {
    actor_id: target,
    days: 30,
    refresh: true,
  });
  checkEqual('timeline available', timeline.available, true);
  checkEqual('timeline 默认 days', timeline.days, 30);
  checkEqual('timeline 默认 limit', timeline.limit, LIMITS.memoryPanelTimelineLimitDefault);
  checkEqual('timeline 返回全部事实', timeline.items.length, 3);
  checkEqual('timeline summary total', timeline.summary.total, 3);
  checkEqual('timeline summary dated', timeline.summary.dated, 3);
  checkEqual('timeline summary undated', timeline.summary.undated, 0);
  checkEqual('timeline 正文上限', timeline.items.find((item) => item.id === 'm1')?.text.length, LIMITS.memoryPanelTimelineTextChars);
  checkEqual('timeline 保留 occurred_at', timeline.items.find((item) => item.id === 'm1')?.occurred_at, '2026-10-01T00:00:00Z');
  checkEqual('timeline 按发生时间倒序', timeline.items.map((item) => item.id).join(','), 'm3,m2,m1');
  checkEqual('timeline day 分组', timeline.groups.day.map((group) => group.key).join(','), '2026-11-03,2026-11-02,2026-10-01');
  checkEqual('timeline month 分组', timeline.groups.month.map((group) => group.key).join(','), '2026-11,2026-10');
  checkEqual('timeline 分组计数一致', timeline.groups.day.reduce((sum, group) => sum + group.count, 0), timeline.items.length);
  check(
    'timeline 分组索引连续',
    timeline.groups.day.every((group, index, all) =>
      index === 0 ? group.start_index === 0 : group.start_index === all[index - 1]!.end_index,
    ) && timeline.groups.day.at(-1)?.end_index === timeline.items.length,
  );
  checkEqual('timeline UTC day 起点', timeline.groups.day[0]?.start, '2026-11-03T00:00:00.000Z');
  checkEqual('timeline UTC day 终点', timeline.groups.day[0]?.end, '2026-11-04T00:00:00.000Z');
  checkEqual('timeline UTC week 起点', timeline.groups.week[0]?.start, '2026-11-02T00:00:00.000Z');
  checkEqual('timeline UTC month 起点', timeline.groups.month[0]?.start, '2026-11-01T00:00:00.000Z');
  const timelineRequest = fake.requests.filter((item) => item.path.endsWith('/memories/list')).at(-1);
  checkEqual('timeline 转发 time_field', timelineRequest?.query.get('time_field'), 'mentioned_at');
  checkEqual('timeline 单页上限 200', timelineRequest?.query.get('limit'), '200');
  check('timeline 转发 start_date', Boolean(timelineRequest?.query.get('start_date')));
  check('timeline 转发 end_date', Boolean(timelineRequest?.query.get('end_date')));
  assertNoSensitive('timeline 输出', timeline, targetBank);

  console.log('--- timeline 本地时区 offset ---');
  const localTimeline = await service.timeline(viewer('human', friend), {
    actor_id: target,
    days: 30,
    tz_offset_minutes: 480,
    refresh: true,
  });
  checkEqual(
    'timeline +480 跨日事件归到本地日',
    localTimeline.groups.day.map((group) => group.key).join(','),
    '2026-11-03,2026-10-01',
  );
  checkEqual('timeline +480 首组计数', localTimeline.groups.day[0]?.count, 2);
  checkEqual('timeline +480 首组 label', localTimeline.groups.day[0]?.label, '2026年11月3日');
  checkEqual('timeline +480 首组起点', localTimeline.groups.day[0]?.start, '2026-11-02T16:00:00.000Z');
  checkEqual('timeline +480 首组终点', localTimeline.groups.day[0]?.end, '2026-11-03T16:00:00.000Z');
  checkEqual('timeline +480 week 起点', localTimeline.groups.week[0]?.start, '2026-11-01T16:00:00.000Z');
  checkEqual('timeline +480 month 起点', localTimeline.groups.month[0]?.start, '2026-10-31T16:00:00.000Z');
  check(
    'timeline +480 分组索引连续',
    localTimeline.groups.day.every((group, index, all) =>
      index === 0 ? group.start_index === 0 : group.start_index === all[index - 1]!.end_index,
    ) && localTimeline.groups.day.at(-1)?.end_index === localTimeline.items.length,
  );

  const westTimeline = await service.timeline(viewer('human', friend), {
    actor_id: target,
    days: 30,
    tz_offset_minutes: -480,
    refresh: true,
  });
  checkEqual(
    'timeline -480 反向跨日',
    westTimeline.groups.day.map((group) => group.key).join(','),
    '2026-11-03,2026-11-02,2026-09-30',
  );

  const cachedUtc = await service.timeline(viewer('human', friend), {
    actor_id: target,
    days: 30,
  });
  checkEqual(
    'timeline 缓存按 offset 隔离',
    cachedUtc.groups.day.map((group) => group.key).join(','),
    '2026-11-03,2026-11-02,2026-10-01',
  );

  check(
    'timeline schema 接受 +480',
    insightTimelineInputSchema.safeParse({ actor_id: target, tz_offset_minutes: 480 }).success,
  );
  check(
    'timeline schema 接受 -840',
    insightTimelineInputSchema.safeParse({ actor_id: target, tz_offset_minutes: -840 }).success,
  );
  check(
    'timeline schema 拒绝 841',
    !insightTimelineInputSchema.safeParse({ actor_id: target, tz_offset_minutes: 841 }).success,
  );
  check(
    'timeline schema 拒绝 -841',
    !insightTimelineInputSchema.safeParse({ actor_id: target, tz_offset_minutes: -841 }).success,
  );
  check(
    'timeline schema 拒绝非整数 offset',
    !insightTimelineInputSchema.safeParse({ actor_id: target, tz_offset_minutes: 480.5 }).success,
  );

  console.log('--- timeline 无日期与字节裁剪 ---');
  fake.seedBank(targetBank, {
    memories: [
      ...memories,
      {
        id: 'm-undated',
        text: '无日期事件',
        fact_type: 'world',
        state: 'valid',
        mentioned_at: null,
        occurred_start: null,
        occurred_end: null,
        entities: [],
        proof_count: 0,
        tags: [],
      },
    ],
  });
  const undatedTimeline = await service.timeline(viewer('human', friend), {
    actor_id: target,
    days: 30,
    refresh: true,
  });
  checkEqual('timeline 无日期单独分组', undatedTimeline.groups.day.at(-1)?.key, 'undated');
  checkEqual('timeline undated 计数', undatedTimeline.summary.undated, 1);

  const largeMemories = Array.from({ length: 520 }, (_, index) => ({
    id: `tl${index}`,
    text: '时间线正文'.repeat(40),
    fact_type: index % 3 === 0 ? 'world' : index % 3 === 1 ? 'experience' : 'observation',
    state: 'valid',
    mentioned_at: new Date(Date.parse('2026-11-10T00:00:00Z') - index * 3_600_000).toISOString(),
    occurred_start: null,
    occurred_end: null,
    entities: [
      `实体甲${'长'.repeat(40)}`,
      `实体乙${'长'.repeat(40)}`,
      `实体丙${'长'.repeat(40)}`,
      `实体丁${'长'.repeat(40)}`,
    ],
    proof_count: 1,
    tags: [],
  }));
  fake.seedBank(targetBank, { memories: largeMemories });
  fake.resetRequests();
  const largeTimeline = await service.timeline(viewer('human', friend), {
    actor_id: target,
    days: 90,
    limit: 500,
    tz_offset_minutes: 480,
    refresh: true,
  });
  check('timeline 合并多页', largeTimeline.items.length > 200, largeTimeline.items.length);
  check('timeline 不超过 limit', largeTimeline.items.length <= 500, largeTimeline.items.length);
  check(
    'timeline JSON 不超过 248KB',
    utf8Bytes(JSON.stringify(largeTimeline)) <= LIMITS.memoryPanelTimelineBytes,
    utf8Bytes(JSON.stringify(largeTimeline)),
  );
  check('timeline 超预算标记 truncated', largeTimeline.truncated);
  checkEqual('timeline 实体最多 3 个', largeTimeline.items[0]?.entities.length, LIMITS.memoryPanelTimelineEntitiesMax);
  checkEqual('timeline 裁剪后仍按 +480 分组', largeTimeline.groups.day[0]?.start, '2026-11-09T16:00:00.000Z');
  check(
    'timeline 最多合并 5 页',
    fake.requestCount('GET', '/memories/list') <= LIMITS.memoryPanelTimelinePagesMax,
    fake.requestCount('GET', '/memories/list'),
  );
  check('timeline 分页合并为 3 次上游请求', fake.requestCount('GET', '/memories/list') === 3, fake.requestCount('GET', '/memories/list'));
  assertNoSensitive('large timeline 输出', largeTimeline, targetBank);

  console.log('--- timeline single-flight ---');
  fake.resetRequests();
  fake.delay('/memories/list', 120);
  await Promise.all([
    service.timeline(viewer('human', friend), {
      actor_id: target,
      days: 7,
      limit: 500,
      tz_offset_minutes: 480,
      refresh: true,
    }),
    service.timeline(viewer('human', friend), {
      actor_id: target,
      days: 7,
      limit: 500,
      tz_offset_minutes: 480,
      refresh: true,
    }),
  ]);
  checkEqual(
    '并发 timeline 合并为同一组上游请求',
    fake.requestCount('GET', '/memories/list'),
    3,
  );

  await fake.stop();
  console.log(`memory timeline checks passed (${checksPassed()} assertions)`);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
