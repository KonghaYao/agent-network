/**
 * Memory 定时回填验收（窗口/基础/跳过/召回）。
 *
 * 覆盖：窗口数学、缺来源补建、跳过条件、权限、两次运行零新增、崩溃重放，
 * 以及 fake Hindsight 端到端（回填项入队 → retain → recall 可读）。
 *
 * 运行：bun run test:memory-backfill
 */
import { MemoryBackfill } from '../src/memory/backfill';
import {
  createBackfillWindow,
  planBackfillReplayWindows,
  planBackfillWindows,
} from '../src/memory/backfill-window';
import { HindsightMemoryAdapter } from '../src/memory/adapters/hindsight';
import { buildInjectionPack } from '../src/memory/injection';
import { recallMemory } from '../src/memory/recall-service';
import { MemoryRuntime } from '../src/memory/runtime';
import { parseProvenanceMetadata } from '../src/memory/provenance';
import { ensureSpaceForAgent } from '../src/memory/store';
import { FakeHindsight } from './lib/memory-hindsight-fake';
import { check, checkEqual } from './lib/harness';
import { seedActor, seedManagement, seedRoom } from './lib/memory-unit';
import {
  AT,
  MESSAGE_AT,
  W,
  WINDOW,
  addMember,
  backfill,
  count,
  insertMessage,
  seedFixture,
  sourceGateCount,
  unique,
} from './lib/memory-backfill-fixture';

async function windowMathChecks(): Promise<void> {
  const current = createBackfillWindow(AT, W);
  checkEqual('窗口 to 对齐整点', current.to % W, 0);
  checkEqual('窗口宽度 1h', current.to - current.from, W);

  const first = planBackfillWindows({
    watermark: null,
    now: AT,
    windowMs: W,
    maxCatchupWindows: 24,
  });
  checkEqual('首次运行只处理一个窗口', first.windows.length, 1);
  checkEqual('首次窗口结束于当前整点', first.windows[0]!.to, current.to);

  const behind = planBackfillWindows({
    watermark: current.to - 3 * W,
    now: AT,
    windowMs: W,
    maxCatchupWindows: 24,
  });
  checkEqual('补偿三个窗口', behind.windows.length, 3);
  checkEqual('补偿从水位开始', behind.windows[0]!.from, current.to - 3 * W);
  checkEqual('补偿止于当前整点', behind.windows.at(-1)!.to, current.to);

  const capped = planBackfillWindows({
    watermark: current.to - 30 * W,
    now: AT,
    windowMs: W,
    maxCatchupWindows: 24,
  });
  checkEqual('补偿上限 24 窗口', capped.windows.length, 24);
  checkEqual('跳过 6 个窗口', capped.skippedWindows, 6);

  const currentPlan = planBackfillWindows({
    watermark: current.to,
    now: AT,
    windowMs: W,
    maxCatchupWindows: 24,
  });
  checkEqual('已追平不重复处理', currentPlan.windows.length, 0);

  // 重放必须从起点向前逐窗口推进，而不是每次取最近 N 个窗口。
  const replayUntil = current.to - 24 * W;
  const replayFirst = planBackfillReplayWindows({
    watermark: null,
    from: current.to - 100 * W,
    until: replayUntil,
    windowMs: W,
    maxWindows: 24,
  });
  checkEqual('重放首轮有界 24 窗口', replayFirst.windows.length, 24);
  checkEqual('重放首轮从起点开始', replayFirst.windows[0]!.from, current.to - 100 * W);
  check(
    '重放首轮窗口连续',
    replayFirst.windows.every(
      (window, index) =>
        window.to - window.from === W &&
        (index === 0 || replayFirst.windows[index - 1]!.to === window.from),
    ),
  );
  checkEqual('重放首轮剩余窗口可见', replayFirst.remainingWindows, 76 - 24);
  let replayWatermark: number | null = null;
  let replayRounds = 0;
  for (;;) {
    const plan = planBackfillReplayWindows({
      watermark: replayWatermark,
      from: current.to - 100 * W,
      until: replayUntil,
      windowMs: W,
      maxWindows: 24,
    });
    if (plan.windows.length === 0) break;
    replayRounds += 1;
    replayWatermark = plan.windows.at(-1)!.to;
  }
  checkEqual('重放水位单调推进到上界', replayWatermark, replayUntil);
  checkEqual('重放按 24 窗口分轮', replayRounds, Math.ceil(76 / 24));
}

async function basicChecks(): Promise<void> {
  const fixture = await seedFixture();
  const { env, instanceId, human, agentA, agentB, roomOne, roomTwo, spaceA } = fixture;
  const messageOne = unique('msg_bf');
  const messageTwo = unique('msg_bf');
  insertMessage(env, {
    messageId: messageOne,
    roomId: roomOne,
    senderId: human,
    seq: 1,
    body: `BACKFILL-BODY-${messageOne}`,
    createdAt: MESSAGE_AT,
  });
  insertMessage(env, {
    messageId: messageTwo,
    roomId: roomTwo,
    senderId: human,
    seq: 1,
    body: `BACKFILL-BODY-${messageTwo}`,
    createdAt: MESSAGE_AT + 60_000,
  });
  const logs: string[] = [];
  const runner = backfill(fixture, logs);
  const first = await runner.runOnce();
  checkEqual('回填扫描两条消息', first.scanned, 2);
  checkEqual('回填扇出三对', first.pairs, 3);
  checkEqual('回填创建三份回执', first.created.receipts, 3);
  checkEqual('回填创建三条意图', first.created.intents, 3);
  checkEqual('回填创建三个作业', first.created.jobs, 3);
  check('回填水位已推进', first.caught_up);

  const source = env.db
    .prepare('SELECT * FROM memory_sources WHERE instance_id = ? AND source_key = ?')
    .get(instanceId, `message:${messageOne}`) as
    | { state: string; origin_member_generation: number; content_sha256: string | null }
    | null;
  check('缺失来源被确定性补建', source !== null);
  checkEqual('补建来源为 active', source?.state, 'active');
  checkEqual('补建来源记录成员代次', source?.origin_member_generation, 1);
  check('来源正文摘要存在', typeof source?.content_sha256 === 'string');
  checkEqual(
    '每个消息一条来源行',
    count(env, 'SELECT COUNT(*) AS n FROM memory_sources WHERE instance_id = ?', instanceId),
    2,
  );

  const representation = env.db
    .prepare('SELECT representation_id, kind, verbatim FROM memory_representations')
    .get() as { representation_id: string; kind: string; verbatim: number } | null;
  check('生成逐字表示', representation !== null);
  checkEqual('表示类型 raw_full', representation?.kind, 'raw_full');
  checkEqual('表示逐字标记', representation?.verbatim, 1);

  const receipt = env.db
    .prepare('SELECT evidence, origin_scopes_json, target_scope_json FROM memory_receipts LIMIT 1')
    .get() as { evidence: string; origin_scopes_json: string; target_scope_json: string } | null;
  checkEqual('回执使用房间历史证据', receipt?.evidence, 'gateway_observed_room_history');
  check('回执带房间 origin scope', receipt?.origin_scopes_json.includes(roomOne) ?? false);
  check('回执目标为 agent_private', receipt?.target_scope_json.includes('agent_private') ?? false);

  const intent = env.db
    .prepare('SELECT origin_kind, evidence FROM memory_retain_intents LIMIT 1')
    .get() as { origin_kind: string; evidence: string | null } | null;
  checkEqual('意图为 experienced', intent?.origin_kind, 'experienced');
  checkEqual('意图证据留 NULL 以通过 CHECK', intent?.evidence, null);

  checkEqual('回填创建三条经历', first.created.experiences, 3);
  checkEqual('经历数等于空间扇出', count(env, 'SELECT COUNT(*) AS n FROM memory_experiences'), 3);
  const experience = env.db
    .prepare(
      `SELECT evidence, available, capture, origin_kind, representation_kind,
              source_revision, receipt_id, origin_member_generation, dedupe_key
         FROM memory_experiences
        ORDER BY agent_actor_id
        LIMIT 1`,
    )
    .get() as {
    evidence: string | null;
    available: number;
    capture: string;
    origin_kind: string;
    representation_kind: string;
    source_revision: number | null;
    receipt_id: string | null;
    origin_member_generation: number;
    dedupe_key: string;
  } | null;
  checkEqual('经历使用房间历史证据', experience?.evidence, 'gateway_observed_room_history');
  checkEqual('经历可用', experience?.available, 1);
  checkEqual('经历类型 experienced', experience?.origin_kind, 'experienced');
  checkEqual('经历表示 raw_full', experience?.representation_kind, 'raw_full');
  checkEqual('经历捕获状态 pending', experience?.capture, 'pending');
  check('经历绑定回执', experience?.receipt_id !== null);
  checkEqual('经历绑定来源首版', experience?.source_revision, 1);
  checkEqual('经历记录成员代次', experience?.origin_member_generation, 1);
  check('经历去重键非空', (experience?.dedupe_key.length ?? 0) > 0);

  const packA = await buildInjectionPack({
    db: env.d1,
    instanceId,
    agentId: agentA,
    roomId: roomOne,
    now: AT + 1_000,
  });
  checkEqual('回填后 pack 可用', packA.available, true);
  checkEqual('回填后 pack reason=ready', packA.reason, 'ready');
  checkEqual('回填后 pack 非空', packA.item_count > 0, true);
  checkEqual('回填后 pack 有经历', packA.stats.experiences, 1);
  // 同文本的 source 与 experience 不再跨 kind 折叠：房间原文仍可单独引用。
  checkEqual('回填后 pack 保留同文 source', packA.stats.sources, 1);
  checkEqual('回填后 pack 两个条目', packA.item_count, 2);
  checkEqual('回填后 pack distinct_texts=1', packA.stats.distinct_texts, 1);
  checkEqual('回填后 pack occurrence_count=2', packA.occurrence_count, 2);
  checkEqual('回填后 pack 折叠 1 次', packA.stats.deduped, 1);
  checkEqual('回填后 pack 未截断', packA.truncated, false);
  checkEqual('回填后 pack 未省略', packA.omitted, 0);
  checkEqual('pack 只含当前房间', packA.items.every((item) => item.origin_room_id === roomOne), true);
  checkEqual('pack 文本为消息正文', packA.items[0]?.text, `BACKFILL-BODY-${messageOne}`);
  checkEqual('pack 经历携带房间历史证据', packA.items[0]?.evidence, 'gateway_observed_room_history');
  const experienceA = env.db
    .prepare(
      `SELECT experience_id FROM memory_experiences
        WHERE agent_actor_id = ? AND origin_room_id = ?`,
    )
    .get(agentA, roomOne) as { experience_id: string } | null;
  checkEqual('pack 只使用本 Agent 经历', packA.items[0]?.item_id, `exp:${experienceA?.experience_id}`);
  checkEqual(
    '回填后 source 通过 experience 关联门',
    sourceGateCount(env, {
      roomId: roomOne,
      spaceId: spaceA.space_id,
      epoch: spaceA.ownership_epoch,
      agentId: agentA,
    }),
    1,
  );

  const packAOtherRoom = await buildInjectionPack({
    db: env.d1,
    instanceId,
    agentId: agentA,
    roomId: roomTwo,
    now: AT + 1_000,
  });
  checkEqual('跨房间 pack 为空', packAOtherRoom.item_count, 0);
  checkEqual('跨房间 reason=empty', packAOtherRoom.reason, 'empty');
  const packB = await buildInjectionPack({
    db: env.d1,
    instanceId,
    agentId: agentB,
    roomId: roomTwo,
    now: AT + 1_000,
  });
  checkEqual('另一 Agent 在自己房间可见', packB.item_count, 2);
  checkEqual('另一 Agent 只看到自己房间', packB.items[0]?.origin_room_id, roomTwo);

  checkEqual(
    '回填不写 events',
    count(env, "SELECT COUNT(*) AS n FROM events WHERE event_type LIKE 'memory%'"),
    0,
  );
  checkEqual(
    '回填不写 outbox',
    count(env, 'SELECT COUNT(*) AS n FROM outbox'),
    0,
  );
  checkEqual(
    '回填不产生未读',
    count(env, 'SELECT COALESCE(SUM(pending_count), 0) AS n FROM actors'),
    0,
  );
  const logText = logs.join('\n');
  check('日志不含消息正文', !logText.includes('BACKFILL-BODY'));
  check('日志不含凭据', !logText.includes('Bearer'));

  const before = {
    sources: count(env, 'SELECT COUNT(*) AS n FROM memory_sources'),
    representations: count(env, 'SELECT COUNT(*) AS n FROM memory_representations'),
    receipts: count(env, 'SELECT COUNT(*) AS n FROM memory_receipts'),
    intents: count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents'),
    jobs: count(env, 'SELECT COUNT(*) AS n FROM memory_jobs'),
    experiences: count(env, 'SELECT COUNT(*) AS n FROM memory_experiences'),
    operations: count(env, 'SELECT COUNT(*) AS n FROM operations'),
  };
  const second = await runner.runOnce();
  checkEqual('第二次运行零新增回执', second.created.receipts, 0);
  checkEqual('第二次运行零新增意图', second.created.intents, 0);
  checkEqual('第二次运行零新增经历', second.created.experiences, 0);
  checkEqual('第二次运行已追平不重扫', second.windows, 0);
  checkEqual(
    '第二次运行来源数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_sources'),
    before.sources,
  );
  checkEqual(
    '第二次运行表示数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_representations'),
    before.representations,
  );
  checkEqual(
    '第二次运行回执数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_receipts'),
    before.receipts,
  );
  checkEqual(
    '第二次运行意图数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents'),
    before.intents,
  );
  checkEqual(
    '第二次运行作业数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_jobs'),
    before.jobs,
  );
  checkEqual(
    '第二次运行经历数不变',
    count(env, 'SELECT COUNT(*) AS n FROM memory_experiences'),
    before.experiences,
  );

  // 模拟“整窗提交后、水位推进前崩溃”：只删水位，保留扫描位与行。
  env.db
    .prepare(
      "DELETE FROM memory_cursors WHERE scope_kind = 'agent' AND scope_id = 'memory-backfill' AND cursor_kind = 'backfill_window_to'",
    )
    .run();
  const replay = await runner.runOnce();
  checkEqual('崩溃重放零新增意图', replay.created.intents, 0);
  checkEqual('崩溃重放零新增经历', replay.created.experiences, 0);
  checkEqual('崩溃重放计为 already', replay.skips.already, 3);
  checkEqual(
    '崩溃重放不回退扫描位',
    count(
      env,
      "SELECT COUNT(*) AS n FROM memory_cursors WHERE cursor_kind = 'backfill_window_to'",
    ),
    1,
  );
  checkEqual(
    '崩溃重放 operations 不增长',
    count(env, 'SELECT COUNT(*) AS n FROM operations'),
    before.operations,
  );
  env.db.close();
}

async function skipAndPermissionChecks(): Promise<void> {
  const fixture = await seedFixture();
  const { env, instanceId, human, roomOne } = fixture;
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const disabled = `agt_bf_disabled_${suffix}`;
  const excluded = `agt_bf_excluded_${suffix}`;
  const noSpace = `agt_bf_nospace_${suffix}`;
  seedActor(env, { actorId: disabled, kind: 'agent', disabled: true });
  seedActor(env, { actorId: excluded, kind: 'agent' });
  seedActor(env, { actorId: noSpace, kind: 'agent' });
  seedManagement(env, { agentId: excluded, managerId: human });
  seedManagement(env, { agentId: noSpace, managerId: human });
  addMember(env, roomOne, { actorId: disabled });
  addMember(env, roomOne, { actorId: excluded });
  addMember(env, roomOne, { actorId: noSpace });
  const excludedSpace = await ensureSpaceForAgent(env.d1, {
    instanceId,
    agentId: excluded,
    now: AT,
  });
  env.db
    .prepare("UPDATE memory_spaces SET capture = 'excluded' WHERE space_id = ?")
    .run(excludedSpace.space_id);

  const normal = unique('msg_bf');
  insertMessage(env, {
    messageId: normal,
    roomId: roomOne,
    senderId: human,
    seq: 1,
    body: `NORMAL-${normal}`,
    createdAt: MESSAGE_AT,
  });
  const recalled = unique('msg_bf');
  insertMessage(env, {
    messageId: recalled,
    roomId: roomOne,
    senderId: human,
    seq: 2,
    body: '',
    bodyBytes: 0,
    createdAt: MESSAGE_AT + 1_000,
  });
  const outside = unique('msg_bf');
  insertMessage(env, {
    messageId: outside,
    roomId: roomOne,
    senderId: human,
    seq: 3,
    body: `OUTSIDE-${outside}`,
    createdAt: WINDOW.from - 60_000,
  });
  const retractedMessage = unique('msg_bf');
  insertMessage(env, {
    messageId: retractedMessage,
    roomId: roomOne,
    senderId: human,
    seq: 4,
    body: `RETRACTED-${retractedMessage}`,
    createdAt: MESSAGE_AT + 2_000,
  });
  env.db
    .prepare(
      `INSERT INTO memory_sources
         (source_id, instance_id, source_key, source_kind, business_ref_kind, business_ref_json,
          origin_room_id, origin_member_generation, origin_policy_revision, origin_joined_seq,
          origin_joined_at, origin_archive_head_seq, origin_seq, origin_created_at,
          author_actor_id, state, revision, content_text, content_sha256, content_bytes,
          created_at, updated_at)
       VALUES (?, ?, ?, 'message', 'message', '{}', ?, 1, 0, 0, 0, NULL, 4, ?, ?, 'retracted', 1,
               NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      `msrc_bf_retracted_${suffix}`,
      instanceId,
      `message:${retractedMessage}`,
      roomOne,
      AT,
      human,
      AT,
      AT,
    );

  const run = await backfill(fixture).runOnce();
  checkEqual('仅正常消息命中权限', run.pairs, 2);
  check('撤回消息跳过', run.skips.empty_body >= 1);
  check('窗口外消息跳过', run.skips.out_of_window >= 1);
  checkEqual('已失效来源不复活', run.skips.source_inactive, 1);
  checkEqual(
    '只有两个 active Agent 得到意图',
    count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents'),
    2,
  );
  checkEqual(
    '禁用 Agent 无意图',
    count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE agent_actor_id = ?', disabled),
    0,
  );
  checkEqual(
    '排除空间无意图',
    count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE agent_actor_id = ?', excluded),
    0,
  );
  checkEqual(
    '无空间 Agent 无意图',
    count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE agent_actor_id = ?', noSpace),
    0,
  );
  checkEqual(
    '禁用 Agent 无经历',
    count(env, 'SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?', disabled),
    0,
  );
  checkEqual(
    '排除空间无经历',
    count(env, 'SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?', excluded),
    0,
  );
  checkEqual(
    '无空间 Agent 无经历',
    count(env, 'SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?', noSpace),
    0,
  );
  checkEqual(
    '撤回消息无意图',
    count(
      env,
      "SELECT COUNT(*) AS n FROM memory_receipts WHERE idempotency_key LIKE ?",
      `%${recalled}%`,
    ),
    0,
  );

  // from_join 历史边界：后加入成员不能回填加入前的消息。
  const lateAgent = `agt_bf_late_${suffix}`;
  seedActor(env, { actorId: lateAgent, kind: 'agent' });
  seedManagement(env, { agentId: lateAgent, managerId: human });
  const lateRoom = `rm_bf_late_${suffix}`;
  seedRoom(env, {
    roomId: lateRoom,
    kind: 'group',
    ownerId: human,
    policy: 'from_join',
    policyRevision: 0,
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: lateAgent, memberGeneration: 1, joinedSeq: 10, joinedAt: MESSAGE_AT + 10 },
    ],
  });
  await ensureSpaceForAgent(env.d1, { instanceId, agentId: lateAgent, now: AT });
  const lateMessage = unique('msg_bf');
  insertMessage(env, {
    messageId: lateMessage,
    roomId: lateRoom,
    senderId: human,
    seq: 1,
    body: `LATE-${lateMessage}`,
    createdAt: MESSAGE_AT + 3_000,
  });
  // 重新打开已提交窗口，验证同一窗口内新增消息的权限判定。
  env.db
    .prepare(
      "DELETE FROM memory_cursors WHERE scope_kind = 'agent' AND scope_id = 'memory-backfill' AND cursor_kind = 'backfill_window_to'",
    )
    .run();
  const second = await backfill(fixture).runOnce();
  check('历史边界拒绝计入 denied', second.skips.denied >= 1);
  checkEqual(
    '后加入成员不产生意图',
    count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE agent_actor_id = ?', lateAgent),
    0,
  );
  checkEqual(
    '后加入成员不产生经历',
    count(env, 'SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?', lateAgent),
    0,
  );

  // 实例级 capture 关闭时整轮不写入。
  const disabledFixture = await seedFixture({ captureDefault: 'disabled' });
  const disabledRunner = backfill(disabledFixture);
  const disabledRun = await disabledRunner.runOnce();
  checkEqual('实例 capture 关闭跳过', disabledRun.skips.capture_off, 1);
  checkEqual(
    'capture 关闭零意图',
    count(disabledFixture.env, 'SELECT COUNT(*) AS n FROM memory_retain_intents'),
    0,
  );
  disabledFixture.env.db.close();

  // MEMORY_CAPTURE=0 等价入口：不制造无主意图。
  const noCapture = new MemoryBackfill({
    db: env.d1,
    instanceId,
    capture: () => false,
    now: () => AT,
  });
  const noCaptureRun = await noCapture.runOnce();
  checkEqual('capture 关闭入口跳过', noCaptureRun.skips.capture_off, 1);
  env.db.close();
}

async function recallEndToEndChecks(): Promise<void> {
  const fixture = await seedFixture();
  const { env, instanceId, human, agentA, roomOne, spaceA } = fixture;
  // 单 Agent 端到端，确保 fake 的 lastOperationId 与回填作业一一对应。
  env.db
    .prepare("UPDATE room_members SET status = 'left' WHERE room_id = ? AND actor_id = ?")
    .run(roomOne, fixture.agentB);
  const body = `RECALL-CHECK-${crypto.randomUUID().slice(0, 8)}`;
  const messageId = unique('msg_bf');
  insertMessage(env, {
    messageId,
    roomId: roomOne,
    senderId: human,
    seq: 1,
    body,
    createdAt: MESSAGE_AT,
  });

  const token = `test_backfill_${crypto.randomUUID().replaceAll('-', '')}`;
  const fake = new FakeHindsight(token);
  const adapter = new HindsightMemoryAdapter({
    baseUrl: fake.baseUrl,
    apiKey: token,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryBaseMs: 1,
    sleepImpl: async () => undefined,
  });
  const runtime = new MemoryRuntime(env.d1, {
    adapter,
    instanceId,
    capture: true,
    now: () => AT,
  });
  try {
    await runtime.start();
    const run = await backfill(fixture).runOnce();
    checkEqual('端到端回填入队', run.created.jobs, 1);
    await runtime.tick();
    const operation = fake.lastOperationId();
    check('Hindsight 收到 retain 作业', operation !== null);
    fake.setOperationStatus(operation!, 'completed');
    await runtime.reconcile();
    checkEqual(
      'retain 作业完成',
      count(env, "SELECT COUNT(*) AS n FROM memory_jobs WHERE status = 'completed'"),
      1,
    );
    const local = env.db
      .prepare('SELECT representation_id FROM memory_representations LIMIT 1')
      .get() as { representation_id: string } | null;
    check('本地表示存在', local !== null);

    const recalled = await recallMemory(env.d1, runtime, {
      instanceId,
      agentId: agentA,
      space: spaceA,
      now: AT + 1_000,
      input: {
        request_id: unique('req_bf_recall'),
        mode: 'lookup',
        dispatch: 'explicit',
        query: body,
        budget: { candidate_limit: 10, output_bytes: 64 * 1024 },
      },
    });
    check('回填项可被 recall 返回', recalled.recall.items.length === 1);
    check('回填项可生成 lookup Context', recalled.context_ref !== null);
    checkEqual(
      'recall 证据为房间历史',
      recalled.recall.items[0]?.evidence,
      'gateway_observed_room_history',
    );
    checkEqual(
      'recall representation id 与本地一致',
      recalled.recall.items[0]?.representation.representation_id,
      local?.representation_id,
    );
    check(
      'recall 不再报 representation_missing',
      !recalled.recall.exclusions.some((item) => item.detail === 'representation_missing'),
    );
    const recallProvenance = recalled.recall.items[0]?.provenance;
    checkEqual('recall provenance author', recallProvenance?.author_actor_id, human);
    checkEqual('recall provenance 显示名取当前 actor', recallProvenance?.author_name, human);
    checkEqual(
      'recall provenance 显示名来源 read_current',
      recallProvenance?.author_name_source,
      'read_current',
    );
    checkEqual('recall provenance source_kind', recallProvenance?.source_kind, 'message');
    checkEqual('recall provenance room', recallProvenance?.origin_room_id, roomOne);
    checkEqual('recall provenance message', recallProvenance?.source_message_id, messageId);
    checkEqual('recall provenance occurred_at', recallProvenance?.occurred_at, MESSAGE_AT);
    check(
      'recall provenance 只含白名单字段',
      !/document_id|chunk_id|metadata|tags/u.test(JSON.stringify(recallProvenance)),
      recallProvenance,
    );
    check(
      'retain 请求写入 provenance 快照',
      parseProvenanceMetadata(fake.documents[0]?.metadata.agentnet_provenance) !== null,
      fake.documents[0]?.metadata,
    );

    // 旧数据：Hindsight 丢弃 provenance metadata 时，recall 仍以本地 source row 回退。
    for (const document of fake.documents) {
      delete document.metadata.agentnet_provenance;
    }
    const fallback = await recallMemory(env.d1, runtime, {
      instanceId,
      agentId: agentA,
      space: spaceA,
      now: AT + 1_500,
      input: {
        request_id: unique('req_bf_fallback'),
        mode: 'lookup',
        dispatch: 'explicit',
        query: body,
        budget: { candidate_limit: 10, output_bytes: 64 * 1024 },
      },
    });
    checkEqual(
      '旧数据无 provenance 回退本地 source',
      JSON.stringify(fallback.recall.items[0]?.provenance),
      JSON.stringify(recallProvenance),
    );

    const strict = await recallMemory(env.d1, runtime, {
      instanceId,
      agentId: agentA,
      space: spaceA,
      now: AT + 2_000,
      input: {
        request_id: unique('req_bf_strict'),
        mode: 'lookup',
        dispatch: 'explicit',
        query: body,
        hard_filters: { minimum_evidence: 'host_reported_submitted' },
        budget: { candidate_limit: 10, output_bytes: 64 * 1024 },
      },
    });
    checkEqual('公开 minimum_evidence 仍排除回填项', strict.recall.items.length, 0);
    check(
      '排除原因为证据不足',
      strict.recall.exclusions.some((item) => item.reason === 'evidence_below_minimum'),
    );
  } finally {
    await runtime.stop();
    await fake.stop();
    env.db.close();
  }
}

async function run(): Promise<void> {
  console.log('memory backfill: window math');
  await windowMathChecks();
  console.log('memory backfill: basic + idempotency + crash replay');
  await basicChecks();
  console.log('memory backfill: skips + permissions');
  await skipAndPermissionChecks();
  console.log('memory backfill: recall end-to-end');
  await recallEndToEndChecks();
  console.log('memory backfill: all checks passed');
}

await run();
