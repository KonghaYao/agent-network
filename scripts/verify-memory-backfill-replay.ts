/**
 * Memory 定时回填验收（重放与 integration 接线）。
 *
 * 覆盖：experience 缺失重放、多日 gap 向前重放、意图指针修复，以及
 * integration 单轮不重入/状态写入。
 *
 * 运行：bun run test:memory-backfill
 */
import { MemoryBackfill } from '../src/memory/backfill';
import { createBackfillWindow } from '../src/memory/backfill-window';
import { buildInjectionPack } from '../src/memory/injection';
import { MemoryIntegration } from '../src/memory/integration';
import { MemoryRuntime } from '../src/memory/runtime';
import { check, checkEqual } from './lib/harness';
import {
  AT,
  MESSAGE_AT,
  W,
  WINDOW,
  backfill,
  count,
  insertMessage,
  seedFixture,
  sourceGateCount,
  unique,
  type Env,
} from './lib/memory-backfill-fixture';

/**
 * 修复前生产数据形态：receipt/intent/job 已存在但 experience 全缺。
 *
 * 删除 experience 并清空回填游标后重扫同一窗口，验证 `exp:` 批次只补
 * experience，不重复回执/意图/作业，并让 pack 恢复非空。
 */
async function experienceReplayChecks(): Promise<void> {
  const fixture = await seedFixture();
  const { env, instanceId, human, agentA, roomOne, roomTwo, spaceA } = fixture;
  const messageId = unique('msg_bf');
  insertMessage(env, {
    messageId,
    roomId: roomOne,
    senderId: human,
    seq: 1,
    body: `REPAIR-BODY-${messageId}`,
    createdAt: MESSAGE_AT,
  });
  const first = await backfill(fixture).runOnce();
  checkEqual('修复场景先写入两份经历', first.created.experiences, 2);
  const healthy = await buildInjectionPack({
    db: env.d1,
    instanceId,
    agentId: agentA,
    roomId: roomOne,
    now: AT + 1_000,
  });
  check('修复前 pack 非空', healthy.item_count > 0);

  // 模拟修复前的生产数据：删掉经历，保留回执/意图/作业。
  env.db.prepare('DELETE FROM memory_experiences').run();
  checkEqual(
    '缺少经历时 source 关联门关闭',
    sourceGateCount(env, {
      roomId: roomOne,
      spaceId: spaceA.space_id,
      epoch: spaceA.ownership_epoch,
      agentId: agentA,
    }),
    0,
  );
  const broken = await buildInjectionPack({
    db: env.d1,
    instanceId,
    agentId: agentA,
    roomId: roomOne,
    now: AT + 1_000,
  });
  checkEqual('缺少经历时 pack 为空', broken.item_count, 0);
  checkEqual('缺少经历时 reason=empty', broken.reason, 'empty');

  const before = {
    receipts: count(env, 'SELECT COUNT(*) AS n FROM memory_receipts'),
    intents: count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents'),
    jobs: count(env, 'SELECT COUNT(*) AS n FROM memory_jobs'),
    operations: count(env, 'SELECT COUNT(*) AS n FROM operations'),
  };
  env.db
    .prepare(
      "DELETE FROM memory_cursors WHERE scope_kind = 'agent' AND scope_id = 'memory-backfill'",
    )
    .run();
  const replay = await backfill(fixture).runOnce();
  checkEqual('重放只补经历', replay.created.experiences, 2);
  checkEqual('重放不新增回执', replay.created.receipts, 0);
  checkEqual('重放不新增意图', replay.created.intents, 0);
  checkEqual('重放不新增作业', replay.created.jobs, 0);
  checkEqual('重放扫描一条消息', replay.scanned, 1);
  checkEqual('重放把已有意图计为 already', replay.skips.already, 2);
  checkEqual(
    '重放回执数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_receipts'),
    before.receipts,
  );
  checkEqual(
    '重放意图数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents'),
    before.intents,
  );
  checkEqual(
    '重放作业数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_jobs'),
    before.jobs,
  );
  checkEqual(
    '重放只新增一个经历批次 operation',
    count(env, 'SELECT COUNT(*) AS n FROM operations'),
    before.operations + 1,
  );
  checkEqual(
    '重放后经历数恢复',
    count(env, 'SELECT COUNT(*) AS n FROM memory_experiences'),
    2,
  );

  const repaired = await buildInjectionPack({
    db: env.d1,
    instanceId,
    agentId: agentA,
    roomId: roomOne,
    now: AT + 1_000,
  });
  checkEqual('重放后 pack 恢复', repaired.available, true);
  checkEqual('重放后 pack 有经历', repaired.stats.experiences, 1);
  checkEqual(
    '重放后 source 关联门恢复',
    sourceGateCount(env, {
      roomId: roomOne,
      spaceId: spaceA.space_id,
      epoch: spaceA.ownership_epoch,
      agentId: agentA,
    }),
    1,
  );

  const third = await backfill(fixture).runOnce();
  checkEqual('再次运行零新增经历', third.created.experiences, 0);
  checkEqual(
    '再次运行 operations 不再增长',
    count(env, 'SELECT COUNT(*) AS n FROM operations'),
    before.operations + 1,
  );
  checkEqual(
    '重放不扩大到其它房间',
    (
      await buildInjectionPack({
        db: env.d1,
        instanceId,
        agentId: agentA,
        roomId: roomTwo,
        now: AT + 1_000,
      })
    ).item_count,
    0,
  );
  env.db.close();
}

function experienceCount(env: Env, messageId: string): number {
  return count(
    env,
    `SELECT COUNT(*) AS n FROM memory_experiences e
       JOIN memory_sources s
         ON s.source_id = e.source_id AND s.revision = e.source_revision
      WHERE s.source_key = ?`,
    `message:${messageId}`,
  );
}

/**
 * B1 回归：大窗口一次性重放只覆盖过去的粗边界；常规调度只补最近 24h，
 * 两者之间的 gap 会被永久跳过。重放必须按 1h 窗口向前推进补上 gap。
 */
async function multiDayReplayChecks(): Promise<void> {
  const fixture = await seedFixture();
  const { env, instanceId, human, agentA, roomOne } = fixture;
  const badWindow = createBackfillWindow(AT, 3 * 24 * W);
  const horizon = WINDOW.to - 24 * W;
  const oldAt = badWindow.from + 60_000;
  const gapAt = badWindow.to + 12 * W;
  const recentAt = WINDOW.to - 2 * W;
  check('gap 位于大窗口之后、最近 24h 之前', gapAt > badWindow.to && gapAt < horizon);

  const oldId = unique('msg_bf');
  const gapId = unique('msg_bf');
  const recentId = unique('msg_bf');
  const gapBody = `GAP-BODY-${gapId}`;
  insertMessage(env, {
    messageId: oldId,
    roomId: roomOne,
    senderId: human,
    seq: 1,
    body: `OLD-BODY-${oldId}`,
    createdAt: oldAt,
  });
  insertMessage(env, {
    messageId: gapId,
    roomId: roomOne,
    senderId: human,
    seq: 2,
    body: gapBody,
    createdAt: gapAt,
  });
  insertMessage(env, {
    messageId: recentId,
    roomId: roomOne,
    senderId: human,
    seq: 3,
    body: `RECENT-BODY-${recentId}`,
    createdAt: recentAt,
  });

  // 旧的生产做法：windowMs=3d 一步推进到过去的粗边界。
  const legacy = new MemoryBackfill({
    db: env.d1,
    instanceId,
    now: () => AT,
    windowMs: 3 * 24 * W,
    maxCatchupWindows: 1,
  });
  const legacyRun = await legacy.runOnce();
  checkEqual('大窗口只覆盖粗边界前的旧消息', legacyRun.created.experiences, 2);
  checkEqual('大窗口后旧消息有经历', experienceCount(env, oldId), 2);
  checkEqual('大窗口未覆盖 gap', experienceCount(env, gapId), 0);

  // 常规调度只补最近 24 个窗口，gap 位于水位与最近 24h 之间。
  const regular = await backfill(fixture).runOnce();
  checkEqual('常规调度覆盖最近 24h', regular.created.experiences, 2);
  checkEqual('常规调度未回看 gap', experienceCount(env, gapId), 0);
  checkEqual('常规调度覆盖 recent', experienceCount(env, recentId), 2);

  // 重放：清空两类游标后按 1h 窗口从起点推进到 now-24h。
  env.db
    .prepare(
      "DELETE FROM memory_cursors WHERE scope_kind = 'agent' AND scope_id = 'memory-backfill'",
    )
    .run();
  const replay = new MemoryBackfill({
    db: env.d1,
    instanceId,
    now: () => AT,
    windowMs: W,
    maxCatchupWindows: 4,
    replayFrom: oldAt,
    replayUntil: horizon,
  });
  const totals = { windows: 0, experiences: 0, receipts: 0, intents: 0, jobs: 0, errors: 0 };
  let replayRounds = 0;
  let replayed = false;
  for (; replayRounds < 40; replayRounds += 1) {
    const run = await replay.runOnce();
    totals.windows += run.windows;
    totals.experiences += run.created.experiences;
    totals.receipts += run.created.receipts;
    totals.intents += run.created.intents;
    totals.jobs += run.created.jobs;
    totals.errors += run.errors;
    if (run.caught_up) {
      replayed = true;
      break;
    }
  }
  check('多日重放已追平', replayed);
  checkEqual('多日重放覆盖全部 1h 窗口', totals.windows, 94);
  checkEqual('多日重放只补 gap 经历', totals.experiences, 2);
  checkEqual('多日重放只补 gap 回执', totals.receipts, 2);
  checkEqual('多日重放只补 gap 意图', totals.intents, 2);
  checkEqual('多日重放只补 gap 作业', totals.jobs, 2);
  checkEqual('多日重放无错误', totals.errors, 0);
  checkEqual('多日重放后 gap 有经历', experienceCount(env, gapId), 2);
  checkEqual('多日重放不重复旧消息经历', experienceCount(env, oldId), 2);
  checkEqual('多日重放不重复 recent 经历', experienceCount(env, recentId), 2);

  const handoff = await backfill(fixture).runOnce();
  checkEqual('重放后常规调度已追平', handoff.caught_up, true);
  checkEqual('重放后常规调度零新增经历', handoff.created.experiences, 0);

  const pack = await buildInjectionPack({
    db: env.d1,
    instanceId,
    agentId: agentA,
    roomId: roomOne,
    now: AT + 1_000,
  });
  checkEqual('多日重放 pack 包含三条经历', pack.stats.experiences, 3);
  // source 与 experience 分开去重：三条房间原文同样各保留一条 source。
  checkEqual('多日重放 pack 保留三条同文 source', pack.stats.sources, 3);
  checkEqual('多日重放 pack 六条条目', pack.item_count, 6);
  checkEqual('多日重放 pack distinct_texts=3', pack.stats.distinct_texts, 3);
  check(
    '多日重放补上 gap 正文',
    pack.items.some((item) => item.text === gapBody),
  );
  env.db.close();
}

/**
 * 非阻塞竞态：同 dedupe key 的 experience 已被其它路径写入、意图仍指向计划 ID。
 * 重放同窗口时必须把意图校正到实际 experience_id。
 */
async function intentExperienceRepairChecks(): Promise<void> {
  const fixture = await seedFixture();
  const { env, instanceId, human, agentA, roomOne } = fixture;
  const messageId = unique('msg_bf');
  insertMessage(env, {
    messageId,
    roomId: roomOne,
    senderId: human,
    seq: 1,
    body: `RACE-BODY-${messageId}`,
    createdAt: MESSAGE_AT,
  });
  const first = await backfill(fixture).runOnce();
  checkEqual('竞态场景先写入两份经历', first.created.experiences, 2);

  const existing = env.db
    .prepare(
      `SELECT experience_id FROM memory_experiences
        WHERE agent_actor_id = ? AND origin_room_id = ?`,
    )
    .get(agentA, roomOne) as { experience_id: string } | null;
  check('竞态场景存在经历', existing !== null);
  const racedId = `mexp_race_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  env.db
    .prepare('UPDATE memory_experiences SET experience_id = ? WHERE experience_id = ?')
    .run(racedId, existing!.experience_id);
  const intentBefore = env.db
    .prepare(
      'SELECT experience_id FROM memory_retain_intents WHERE agent_actor_id = ? AND source_id IS NOT NULL',
    )
    .get(agentA) as { experience_id: string | null } | null;
  checkEqual('竞态前意图仍指向旧 ID', intentBefore?.experience_id, existing!.experience_id);

  env.db
    .prepare(
      "DELETE FROM memory_cursors WHERE scope_kind = 'agent' AND scope_id = 'memory-backfill'",
    )
    .run();
  const repairRun = await backfill(fixture).runOnce();
  checkEqual('指针修复不新增经历', repairRun.created.experiences, 0);
  const intentAfter = env.db
    .prepare(
      'SELECT experience_id FROM memory_retain_intents WHERE agent_actor_id = ? AND source_id IS NOT NULL',
    )
    .get(agentA) as { experience_id: string | null } | null;
  checkEqual('重放把意图指向实际 experience', intentAfter?.experience_id, racedId);

  const pack = await buildInjectionPack({
    db: env.d1,
    instanceId,
    agentId: agentA,
    roomId: roomOne,
    now: AT + 1_000,
  });
  check(
    '修复后 pack 使用实际经历',
    pack.items.some((item) => item.item_id === `exp:${racedId}`),
  );
  env.db.close();
}

async function integrationWiringChecks(): Promise<void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const emptyRun = {
    skipped: false,
    windows: 0,
    caught_up: true,
    skipped_windows: 0,
    scanned: 0,
    pairs: 0,
    created: { representations: 0, receipts: 0, intents: 0, jobs: 0, experiences: 0 },
    skips: {
      empty_body: 0,
      out_of_window: 0,
      source_inactive: 0,
      source_missing: 0,
      no_agent: 0,
      no_space: 0,
      capture_off: 0,
      denied: 0,
      already: 0,
      space_capture_changed: 0,
    },
    errors: 0,
    pending_backlog: 0,
    duration_ms: 0,
    space_catchup: {
      enabled: true,
      selected: 0,
      completed: 0,
      scanned: 0,
      pairs: 0,
      created: { representations: 0, receipts: 0, intents: 0, jobs: 0, experiences: 0 },
      skips: {
        empty_body: 0,
        out_of_window: 0,
        source_inactive: 0,
        source_missing: 0,
        no_agent: 0,
        no_space: 0,
        capture_off: 0,
        denied: 0,
        already: 0,
        space_capture_changed: 0,
      },
      errors: 0,
    },
  };
  const runtime = {
    start: async () => undefined,
    stop: async () => undefined,
    captureEnabled: true,
    tick: async () => ({
      claimed: 0,
      completed: 0,
      requeued: 0,
      unknown: 0,
      failed: 0,
      cancelled: 0,
      suppressed: 0,
    }),
    reconcile: async () => ({ completed: 0, requeued: 0, stillUnknown: 0, unsupported: 0 }),
  } as unknown as MemoryRuntime;
  const integration = new MemoryIntegration({
    runtime,
    now: () => AT,
    tickIntervalMs: 60_000,
    reconcileIntervalMs: 60_000,
    backfillIntervalMs: 60_000,
    backfill: {
      runOnce: async () => {
        runs += 1;
        await gate;
        return emptyRun;
      },
      status: () => ({ running: false, last_run_at: null, last_run: null }),
    },
  });
  await integration.start();
  const concurrent = integration.runBackfillOnce();
  checkEqual('回填单轮不重入', runs, 1);
  release();
  await concurrent;
  checkEqual(
    '回填周期写入 integration 状态',
    integration.status().backfill_interval_ms,
    60_000,
  );
  check('回填状态可读', integration.status().last_backfill_at !== null);
  await integration.stop();
  checkEqual('回填随 integration 关闭', runs, 1);
}

async function run(): Promise<void> {
  console.log('memory backfill: experience replay');
  await experienceReplayChecks();
  console.log('memory backfill: multi-day hourly replay');
  await multiDayReplayChecks();
  console.log('memory backfill: intent experience repair');
  await intentExperienceRepairChecks();
  console.log('memory backfill: integration wiring');
  await integrationWiringChecks();
  console.log('memory backfill replay: all checks passed');
}

await run();
