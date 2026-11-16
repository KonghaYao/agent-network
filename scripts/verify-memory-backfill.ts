/**
 * Memory 定时回填验收。
 *
 * 覆盖：窗口数学、缺来源补建、跳过条件、权限、两次运行零新增、崩溃重放，
 * 以及 fake Hindsight 端到端（回填项入队 → retain → recall 可读）。
 *
 * 运行：bun run test:memory-backfill
 */
import { MemoryBackfill } from '../src/memory/backfill';
import {
  createBackfillWindow,
  planBackfillWindows,
} from '../src/memory/backfill-window';
import { ensureMemoryInstance } from '../src/memory/access';
import { HindsightMemoryAdapter } from '../src/memory/adapters/hindsight';
import { buildInjectionPack } from '../src/memory/injection';
import { MemoryIntegration } from '../src/memory/integration';
import { recallMemory } from '../src/memory/recall-service';
import { MemoryRuntime } from '../src/memory/runtime';
import { ensureSpaceForAgent } from '../src/memory/store';
import { createMemoryEnv, seedActor, seedManagement, seedRoom, spaceRef, unique } from './lib/memory-unit';
import { FakeHindsight } from './lib/memory-hindsight-fake';
import { check, checkEqual } from './lib/harness';

const AT = 1_700_000_000_000;
const W = 3_600_000;
const WINDOW = createBackfillWindow(AT, W);
const MESSAGE_AT = WINDOW.from + 60_000;

type Env = ReturnType<typeof createMemoryEnv>;

function count(env: Env, sql: string, ...binds: (string | number)[]): number {
  const row = env.db.prepare(sql).get(...binds) as { n: number } | null;
  return row?.n ?? 0;
}

/** 与 `collectSources` 相同的 experience 关联门。 */
function sourceGateCount(
  env: Env,
  input: { roomId: string; spaceId: string; epoch: number; agentId: string },
): number {
  return count(
    env,
    `SELECT COUNT(*) AS n FROM memory_sources s
      WHERE s.state = 'active'
        AND s.origin_room_id = ?
        AND EXISTS (
              SELECT 1 FROM memory_experiences e
               WHERE e.source_id = s.source_id
                 AND e.source_revision = s.revision
                 AND e.space_id = ?
                 AND e.ownership_epoch = ?
                 AND e.agent_actor_id = ?
                 AND e.available = 1
                 AND e.origin_room_id = ?
            )`,
    input.roomId,
    input.spaceId,
    input.epoch,
    input.agentId,
    input.roomId,
  );
}

function insertMessage(
  env: Env,
  input: {
    messageId: string;
    roomId: string;
    senderId: string;
    seq: number;
    body: string;
    createdAt: number;
    bodyBytes?: number;
  },
): void {
  const bytes = new TextEncoder().encode(input.body).length;
  env.db
    .prepare(
      `INSERT INTO messages
         (message_id, room_id, sender_id, client_message_id, created_seq, body,
          body_bytes, preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.messageId,
      input.roomId,
      input.senderId,
      `client_${input.messageId}`,
      input.seq,
      input.body,
      input.bodyBytes ?? bytes,
      input.body.slice(0, 32),
      input.createdAt,
    );
}

function addMember(
  env: Env,
  roomId: string,
  input: { actorId: string; memberGeneration?: number; joinedSeq?: number; joinedAt?: number },
): void {
  env.db
    .prepare(
      `INSERT INTO room_members
         (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
          member_generation, role_revision, updated_at)
       VALUES (?, ?, 'member', 'active', ?, 0, ?, ?, 1, ?)`,
    )
    .run(
      roomId,
      input.actorId,
      input.joinedSeq ?? 0,
      input.joinedAt ?? AT,
      input.memberGeneration ?? 1,
      AT,
    );
}

interface BackfillFixture {
  env: Env;
  instanceId: string;
  human: string;
  agentA: string;
  agentB: string;
  roomOne: string;
  roomTwo: string;
  spaceA: { space_id: string; ownership_epoch: number; backend_binding_epoch: number };
  spaceB: { space_id: string; ownership_epoch: number; backend_binding_epoch: number };
}

async function seedFixture(
  options: { agents?: number; captureDefault?: 'enabled' | 'disabled' } = {},
): Promise<BackfillFixture> {
  const env = createMemoryEnv(':memory:');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const instanceId = await ensureMemoryInstance(env.d1, {
    configuredId: `mni_bf_${suffix}`,
    now: AT,
    captureDefault: options.captureDefault ?? 'enabled',
  });
  const human = `usr_bf_human_${suffix}`;
  const agentA = `agt_bf_a_${suffix}`;
  const agentB = `agt_bf_b_${suffix}`;
  const roomOne = `rm_bf_one_${suffix}`;
  const roomTwo = `rm_bf_two_${suffix}`;
  seedActor(env, { actorId: human, kind: 'human' });
  seedActor(env, { actorId: agentA, kind: 'agent' });
  seedActor(env, { actorId: agentB, kind: 'agent' });
  seedManagement(env, { agentId: agentA, managerId: human });
  seedManagement(env, { agentId: agentB, managerId: human });
  seedRoom(env, {
    roomId: roomOne,
    kind: 'group',
    ownerId: human,
    policyRevision: 0,
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentA, memberGeneration: 1 },
      { actorId: agentB, memberGeneration: 1 },
    ],
  });
  seedRoom(env, {
    roomId: roomTwo,
    kind: 'direct',
    ownerId: human,
    policyRevision: 0,
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentB, memberGeneration: 1 },
    ],
  });
  const spaceA = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agentA, now: AT });
  const spaceB = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agentB, now: AT });
  return {
    env,
    instanceId,
    human,
    agentA,
    agentB,
    roomOne,
    roomTwo,
    spaceA: spaceRef(spaceA),
    spaceB: spaceRef(spaceB),
  };
}

function backfill(fixture: BackfillFixture, logs: string[] = []): MemoryBackfill {
  return new MemoryBackfill({
    db: fixture.env.d1,
    instanceId: fixture.instanceId,
    now: () => AT,
    log: (message, detail) => {
      logs.push(`${message} ${JSON.stringify(detail)}`);
    },
  });
}

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
  checkEqual('另一 Agent 在自己房间可见', packB.item_count, 1);
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
    },
    errors: 0,
    pending_backlog: 0,
    duration_ms: 0,
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
  console.log('memory backfill: window math');
  await windowMathChecks();
  console.log('memory backfill: basic + idempotency + crash replay');
  await basicChecks();
  console.log('memory backfill: experience replay');
  await experienceReplayChecks();
  console.log('memory backfill: skips + permissions');
  await skipAndPermissionChecks();
  console.log('memory backfill: recall end-to-end');
  await recallEndToEndChecks();
  console.log('memory backfill: integration wiring');
  await integrationWiringChecks();
  console.log('memory backfill: all checks passed');
}

await run();
