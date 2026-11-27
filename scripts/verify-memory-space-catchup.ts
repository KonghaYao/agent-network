/**
 * Memory 空间首次创建后的历史补扫验收。
 *
 * 覆盖：默认开关、no_space 后独立 per-space 游标回补、direct/full/from_join/
 * archive 可见边界、done 去重、单轮预算续跑、失败不写 done、空间扫描期间
 * 被停用不写 done，以及状态语义。
 *
 * 运行：bun run test:memory-backfill
 */
import { MemoryBackfill, memoryBackfillFlagsFromEnv } from '../src/memory/backfill';
import { ensureMemoryInstance } from '../src/memory/access';
import { memoryStatusSnapshot } from '../src/memory/governance';
import { MEMORY_CURSOR_KINDS, readMemoryCursor } from '../src/memory/jobs';
import { ensureSpaceForAgent } from '../src/memory/store';
import { check, checkEqual } from './lib/harness';
import {
  AT,
  MESSAGE_AT,
  count,
  insertMessage,
  unique,
} from './lib/memory-backfill-fixture';
import { createMemoryEnv, seedActor, seedManagement, seedRoom, spaceRef } from './lib/memory-unit';

async function spaceCatchupChecks(): Promise<void> {
  const defaults = memoryBackfillFlagsFromEnv({});
  checkEqual('env 默认开启 space catch-up', defaults.spaceCatchup, true);
  checkEqual('env 默认关闭窗口回填', defaults.windowEnabled, false);
  const disabledFlags = memoryBackfillFlagsFromEnv({
    MEMORY_SPACE_CATCHUP: '0',
    MEMORY_BACKFILL: '0',
  });
  checkEqual('MEMORY_SPACE_CATCHUP=0 关闭 catch-up', disabledFlags.spaceCatchup, false);
  checkEqual('MEMORY_BACKFILL=0 关闭窗口', disabledFlags.windowEnabled, false);
  const enabledFlags = memoryBackfillFlagsFromEnv({
    MEMORY_SPACE_CATCHUP: '1',
    MEMORY_BACKFILL: '1',
  });
  checkEqual('显式 1 开启 catch-up', enabledFlags.spaceCatchup, true);
  checkEqual('显式 1 开启窗口', enabledFlags.windowEnabled, true);

  // 1) 无 space 的窗口回填只记 no_space，不产生意图；建 space 后由独立
  //    per-space 游标从 0 回补，不受已经推进的全局窗口水位影响。
  const env = createMemoryEnv(':memory:');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const instanceId = await ensureMemoryInstance(env.d1, {
    configuredId: `mni_sc_${suffix}`,
    now: AT,
    captureDefault: 'enabled',
  });
  const human = `usr_sc_human_${suffix}`;
  const agentA = `agt_sc_a_${suffix}`;
  const agentB = `agt_sc_b_${suffix}`;
  seedActor(env, { actorId: human, kind: 'human' });
  seedActor(env, { actorId: agentA, kind: 'agent' });
  seedActor(env, { actorId: agentB, kind: 'agent' });
  seedManagement(env, { agentId: agentA, managerId: human });
  seedManagement(env, { agentId: agentB, managerId: human });

  const directRoom = `rm_sc_direct_${suffix}`;
  const fullRoom = `rm_sc_full_${suffix}`;
  const joinRoom = `rm_sc_join_${suffix}`;
  const archiveRoom = `rm_sc_archive_${suffix}`;
  seedRoom(env, {
    roomId: directRoom,
    kind: 'direct',
    ownerId: human,
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentA, memberGeneration: 1, joinedSeq: 10 },
    ],
  });
  seedRoom(env, {
    roomId: fullRoom,
    kind: 'group',
    ownerId: human,
    policy: 'full',
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentA, memberGeneration: 1, joinedSeq: 10 },
    ],
  });
  seedRoom(env, {
    roomId: joinRoom,
    kind: 'group',
    ownerId: human,
    policy: 'from_join',
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentA, memberGeneration: 1, joinedSeq: 10 },
    ],
  });
  seedRoom(env, {
    roomId: archiveRoom,
    kind: 'group',
    ownerId: human,
    policy: 'full',
    dissolved: true,
    archiveHeadSeq: 20,
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentA, memberGeneration: 1, joinedSeq: 0 },
    ],
  });

  const directMessage = unique('msg_sc_direct');
  const fullMessage = unique('msg_sc_full');
  const joinBefore = unique('msg_sc_join_before');
  const joinAfter = unique('msg_sc_join_after');
  const archiveBefore = unique('msg_sc_archive_before');
  const archiveAfter = unique('msg_sc_archive_after');
  insertMessage(env, {
    messageId: directMessage,
    roomId: directRoom,
    senderId: human,
    seq: 3,
    body: `SC-DIRECT-${directMessage}`,
    createdAt: MESSAGE_AT,
  });
  insertMessage(env, {
    messageId: fullMessage,
    roomId: fullRoom,
    senderId: human,
    seq: 4,
    body: `SC-FULL-${fullMessage}`,
    createdAt: MESSAGE_AT + 1_000,
  });
  insertMessage(env, {
    messageId: joinBefore,
    roomId: joinRoom,
    senderId: human,
    seq: 5,
    body: `SC-JOIN-BEFORE-${joinBefore}`,
    createdAt: MESSAGE_AT + 2_000,
  });
  insertMessage(env, {
    messageId: joinAfter,
    roomId: joinRoom,
    senderId: human,
    seq: 12,
    body: `SC-JOIN-AFTER-${joinAfter}`,
    createdAt: MESSAGE_AT + 3_000,
  });
  insertMessage(env, {
    messageId: archiveBefore,
    roomId: archiveRoom,
    senderId: human,
    seq: 15,
    body: `SC-ARCHIVE-BEFORE-${archiveBefore}`,
    createdAt: MESSAGE_AT + 4_000,
  });
  insertMessage(env, {
    messageId: archiveAfter,
    roomId: archiveRoom,
    senderId: human,
    seq: 25,
    body: `SC-ARCHIVE-AFTER-${archiveAfter}`,
    createdAt: MESSAGE_AT + 5_000,
  });

  const windowOnly = new MemoryBackfill({
    db: env.d1,
    instanceId,
    now: () => AT,
    windowEnabled: true,
    spaceCatchup: false,
  });
  const noSpace = await windowOnly.runOnce();
  check('无 space 窗口记录 no_space', noSpace.skips.no_space >= 1);
  checkEqual('无 space 窗口不产生意图', count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents'), 0);
  checkEqual('无 space 窗口不产生经历', count(env, 'SELECT COUNT(*) AS n FROM memory_experiences'), 0);
  checkEqual('space catch-up 默认关闭', noSpace.space_catchup.enabled, false);

  const spaceA = await ensureSpaceForAgent(env.d1, {
    instanceId,
    agentId: agentA,
    now: AT,
  });
  const catchup = new MemoryBackfill({
    db: env.d1,
    instanceId,
    now: () => AT,
    windowEnabled: false,
    spaceCatchup: true,
  });
  const first = await catchup.runOnce();
  checkEqual('catch-up 选中一个新空间', first.space_catchup.selected, 1);
  checkEqual('catch-up 完成一个新空间', first.space_catchup.completed, 1);
  checkEqual('catch-up 只扫描可见消息', first.space_catchup.scanned, 4);
  checkEqual('catch-up 创建四条意图', first.space_catchup.created.intents, 4);
  checkEqual('catch-up 创建四条经历', first.space_catchup.created.experiences, 4);
  checkEqual('窗口关闭时窗口计数为零', first.windows, 0);
  checkEqual('窗口关闭时不伪造 caught_up', first.caught_up, false);
  checkEqual(
    'direct/full/from_join/archive 边界：join 前与 archive 后无意图',
    count(
      env,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE operation_key LIKE ?',
      `%${joinBefore}%`,
    ) +
      count(
        env,
        'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE operation_key LIKE ?',
        `%${archiveAfter}%`,
      ),
    0,
  );
  checkEqual(
    'catch-up 覆盖 direct 历史',
    count(
      env,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE operation_key LIKE ?',
      `%${directMessage}%`,
    ),
    1,
  );
  checkEqual(
    'catch-up 覆盖 group full 历史',
    count(
      env,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE operation_key LIKE ?',
      `%${fullMessage}%`,
    ),
    1,
  );
  checkEqual(
    'catch-up 覆盖 from_join 之后消息',
    count(
      env,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE operation_key LIKE ?',
      `%${joinAfter}%`,
    ),
    1,
  );
  checkEqual(
    'catch-up 覆盖 archive 上界内消息',
    count(
      env,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE operation_key LIKE ?',
      `%${archiveBefore}%`,
    ),
    1,
  );
  checkEqual(
    'catch-up 写 done 游标',
    await readMemoryCursor(env.d1, {
      scopeKind: 'space',
      scopeId: spaceA.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
    }),
    1,
  );
  check(
    'catch-up 推进 rowid 游标',
    (await readMemoryCursor(env.d1, {
      scopeKind: 'space',
      scopeId: spaceA.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupRowid,
    })) !== null,
  );

  const second = await catchup.runOnce();
  checkEqual('已完成空间不再选中', second.space_catchup.selected, 0);
  checkEqual('已完成空间零新增意图', second.space_catchup.created.intents, 0);
  checkEqual(
    '已完成空间不重复经历',
    count(env, 'SELECT COUNT(*) AS n FROM memory_experiences'),
    4,
  );

  const status = await memoryStatusSnapshot(env.d1, {
    instanceId,
    agentId: agentA,
    space: spaceRef(spaceA),
    captureEnabled: true,
    runtimeAvailable: true,
    hostLevel: 'tool_only',
    supportedHostModes: [],
    spaceCatchupEnabled: true,
    windowEnabled: false,
    now: AT,
  });
  checkEqual('状态显示 catch-up 已完成', status.backfill.space_catchup_completed, true);
  checkEqual('状态显示 catch-up 无待补', status.backfill.space_catchup_pending, false);
  checkEqual('状态显示窗口回填关闭', status.backfill.window_enabled, false);

  // 2) MEMORY_SPACE_CATCHUP=0 等价：runner 选项关闭时不选中空间、不写游标。
  const roomB = `rm_sc_b_${suffix}`;
  const messageB = unique('msg_sc_b');
  seedRoom(env, {
    roomId: roomB,
    kind: 'direct',
    ownerId: human,
    members: [
      { actorId: human, memberGeneration: 1 },
      { actorId: agentB, memberGeneration: 1 },
    ],
  });
  insertMessage(env, {
    messageId: messageB,
    roomId: roomB,
    senderId: human,
    seq: 1,
    body: `SC-B-${messageB}`,
    createdAt: MESSAGE_AT + 6_000,
  });
  const spaceB = await ensureSpaceForAgent(env.d1, {
    instanceId,
    agentId: agentB,
    now: AT,
  });
  const disabled = new MemoryBackfill({
    db: env.d1,
    instanceId,
    now: () => AT,
    windowEnabled: false,
    spaceCatchup: false,
  });
  const disabledRun = await disabled.runOnce();
  checkEqual('MEMORY_SPACE_CATCHUP=0 不启用 catch-up', disabledRun.space_catchup.enabled, false);
  checkEqual('MEMORY_SPACE_CATCHUP=0 不选中空间', disabledRun.space_catchup.selected, 0);
  checkEqual(
    'MEMORY_SPACE_CATCHUP=0 不写 done',
    await readMemoryCursor(env.d1, {
      scopeKind: 'space',
      scopeId: spaceB.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
    }),
    null,
  );
  checkEqual(
    'MEMORY_SPACE_CATCHUP=0 不产生 B 的意图',
    count(
      env,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE space_id = ?',
      spaceB.space_id,
    ),
    0,
  );
  const disabledStatus = await memoryStatusSnapshot(env.d1, {
    instanceId,
    agentId: agentB,
    space: spaceRef(spaceB),
    captureEnabled: true,
    runtimeAvailable: true,
    hostLevel: 'tool_only',
    supportedHostModes: [],
    spaceCatchupEnabled: false,
    windowEnabled: false,
    now: AT,
  });
  checkEqual('关闭时状态 enabled=false', disabledStatus.backfill.space_catchup_enabled, false);
  checkEqual('关闭时状态 pending=false', disabledStatus.backfill.space_catchup_pending, false);
  checkEqual('关闭时状态 completed=false', disabledStatus.backfill.space_catchup_completed, false);
  await env.d1
    .prepare(
      `INSERT INTO memory_cursors (scope_kind, scope_id, cursor_kind, value, updated_at)
       VALUES ('space', ?, 'space_catchup_done', 1, ?)`,
    )
    .bind(spaceB.space_id, AT)
    .run();
  const disabledDoneStatus = await memoryStatusSnapshot(env.d1, {
    instanceId,
    agentId: agentB,
    space: spaceRef(spaceB),
    captureEnabled: true,
    runtimeAvailable: true,
    hostLevel: 'tool_only',
    supportedHostModes: [],
    spaceCatchupEnabled: false,
    windowEnabled: false,
    now: AT,
  });
  checkEqual(
    '关闭时已有 done 也不标记 completed',
    disabledDoneStatus.backfill.space_catchup_completed,
    false,
  );
  env.db.close();

  // 3) 单轮消息预算：500 条后不写 done，下一轮从游标续跑并完成。
  const budgetEnv = createMemoryEnv(':memory:');
  const budgetSuffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const budgetInstance = await ensureMemoryInstance(budgetEnv.d1, {
    configuredId: `mni_sc_budget_${budgetSuffix}`,
    now: AT,
    captureDefault: 'enabled',
  });
  const budgetHuman = `usr_sc_budget_human_${budgetSuffix}`;
  const budgetAgent = `agt_sc_budget_${budgetSuffix}`;
  seedActor(budgetEnv, { actorId: budgetHuman, kind: 'human' });
  seedActor(budgetEnv, { actorId: budgetAgent, kind: 'agent' });
  seedManagement(budgetEnv, { agentId: budgetAgent, managerId: budgetHuman });
  const budgetRoom = `rm_sc_budget_${budgetSuffix}`;
  seedRoom(budgetEnv, {
    roomId: budgetRoom,
    kind: 'direct',
    ownerId: budgetHuman,
    members: [
      { actorId: budgetHuman, memberGeneration: 1 },
      { actorId: budgetAgent, memberGeneration: 1 },
    ],
  });
  for (let index = 0; index < 501; index += 1) {
    insertMessage(budgetEnv, {
      messageId: `msg_sc_budget_${budgetSuffix}_${index}`,
      roomId: budgetRoom,
      senderId: budgetHuman,
      seq: index + 1,
      body: `SC-BUDGET-${index}`,
      createdAt: MESSAGE_AT + index,
    });
  }
  const budgetSpace = await ensureSpaceForAgent(budgetEnv.d1, {
    instanceId: budgetInstance,
    agentId: budgetAgent,
    now: AT,
  });
  const budgetRunner = new MemoryBackfill({
    db: budgetEnv.d1,
    instanceId: budgetInstance,
    now: () => AT,
    windowEnabled: false,
    spaceCatchup: true,
  });
  const budgetFirst = await budgetRunner.runOnce();
  checkEqual('预算首轮最多扫描 500 条', budgetFirst.space_catchup.scanned, 500);
  checkEqual('预算耗尽不写 done', budgetFirst.space_catchup.completed, 0);
  checkEqual(
    '预算耗尽保留未完成状态',
    await readMemoryCursor(budgetEnv.d1, {
      scopeKind: 'space',
      scopeId: budgetSpace.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
    }),
    null,
  );
  checkEqual('预算首轮创建 500 条意图', budgetFirst.space_catchup.created.intents, 500);
  const budgetSecond = await budgetRunner.runOnce();
  checkEqual('预算第二轮续跑剩余 1 条', budgetSecond.space_catchup.scanned, 1);
  checkEqual('预算第二轮完成空间', budgetSecond.space_catchup.completed, 1);
  checkEqual(
    '预算续跑后写 done',
    await readMemoryCursor(budgetEnv.d1, {
      scopeKind: 'space',
      scopeId: budgetSpace.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
    }),
    1,
  );
  checkEqual(
    '预算续跑总意图 501 且无重复',
    count(
      budgetEnv,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE space_id = ?',
      budgetSpace.space_id,
    ),
    501,
  );
  checkEqual(
    '预算续跑总经历 501 且无重复',
    count(
      budgetEnv,
      'SELECT COUNT(*) AS n FROM memory_experiences WHERE space_id = ?',
      budgetSpace.space_id,
    ),
    501,
  );
  budgetEnv.db.close();

  // 4) 单空间错误：记录 errors、不写 done；下一轮正常执行时从原游标续跑。
  const failureEnv = createMemoryEnv(':memory:');
  const failureSuffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const failureInstance = await ensureMemoryInstance(failureEnv.d1, {
    configuredId: `mni_sc_failure_${failureSuffix}`,
    now: AT,
    captureDefault: 'enabled',
  });
  const failureHuman = `usr_sc_failure_human_${failureSuffix}`;
  const failureAgent = `agt_sc_failure_${failureSuffix}`;
  seedActor(failureEnv, { actorId: failureHuman, kind: 'human' });
  seedActor(failureEnv, { actorId: failureAgent, kind: 'agent' });
  seedManagement(failureEnv, { agentId: failureAgent, managerId: failureHuman });
  const failureRoom = `rm_sc_failure_${failureSuffix}`;
  seedRoom(failureEnv, {
    roomId: failureRoom,
    kind: 'direct',
    ownerId: failureHuman,
    members: [
      { actorId: failureHuman, memberGeneration: 1 },
      { actorId: failureAgent, memberGeneration: 1 },
    ],
  });
  for (let index = 0; index < 2; index += 1) {
    insertMessage(failureEnv, {
      messageId: `msg_sc_failure_${failureSuffix}_${index}`,
      roomId: failureRoom,
      senderId: failureHuman,
      seq: index + 1,
      body: `SC-FAILURE-${index}`,
      createdAt: MESSAGE_AT + index,
    });
  }
  const failureSpace = await ensureSpaceForAgent(failureEnv.d1, {
    instanceId: failureInstance,
    agentId: failureAgent,
    now: AT,
  });
  let injected = 0;
  const failingDb = new Proxy(failureEnv.d1, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (injected === 0 && sql.includes('INSERT INTO memory_receipts')) {
            injected += 1;
            throw new Error('injected_space_catchup_failure');
          }
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as D1Database;
  const failingRunner = new MemoryBackfill({
    db: failingDb,
    instanceId: failureInstance,
    now: () => AT,
    windowEnabled: false,
    spaceCatchup: true,
  });
  const failedRun = await failingRunner.runOnce();
  checkEqual('空间失败计入 errors', failedRun.space_catchup.errors, 1);
  checkEqual('空间失败不完成', failedRun.space_catchup.completed, 0);
  checkEqual(
    '空间失败不写 done',
    await readMemoryCursor(failureEnv.d1, {
      scopeKind: 'space',
      scopeId: failureSpace.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
    }),
    null,
  );
  checkEqual(
    '空间失败不留下半批意图',
    count(
      failureEnv,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE space_id = ?',
      failureSpace.space_id,
    ),
    0,
  );

  const retryRunner = new MemoryBackfill({
    db: failureEnv.d1,
    instanceId: failureInstance,
    now: () => AT,
    windowEnabled: false,
    spaceCatchup: true,
  });
  const retried = await retryRunner.runOnce();
  checkEqual('失败后下一轮续跑完成', retried.space_catchup.completed, 1);
  checkEqual('失败后下一轮扫描两条', retried.space_catchup.scanned, 2);
  checkEqual(
    '失败后下一轮写 done',
    await readMemoryCursor(failureEnv.d1, {
      scopeKind: 'space',
      scopeId: failureSpace.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
    }),
    1,
  );
  checkEqual(
    '失败后下一轮意图完整',
    count(
      failureEnv,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE space_id = ?',
      failureSpace.space_id,
    ),
    2,
  );
  failureEnv.db.close();

  // 5) 扫描期间空间被停用：按空间过滤后没有扇出，不能越过该消息写游标或 done，
  //    否则空间重新启用后会永久漏掉这段历史。
  const racingEnv = createMemoryEnv(':memory:');
  const racingSuffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const racingInstance = await ensureMemoryInstance(racingEnv.d1, {
    configuredId: `mni_sc_racing_${racingSuffix}`,
    now: AT,
    captureDefault: 'enabled',
  });
  const racingHuman = `usr_sc_racing_human_${racingSuffix}`;
  const racingAgent = `agt_sc_racing_${racingSuffix}`;
  seedActor(racingEnv, { actorId: racingHuman, kind: 'human' });
  seedActor(racingEnv, { actorId: racingAgent, kind: 'agent' });
  seedManagement(racingEnv, { agentId: racingAgent, managerId: racingHuman });
  const racingRoom = `rm_sc_racing_${racingSuffix}`;
  seedRoom(racingEnv, {
    roomId: racingRoom,
    kind: 'direct',
    ownerId: racingHuman,
    members: [
      { actorId: racingHuman, memberGeneration: 1 },
      { actorId: racingAgent, memberGeneration: 1 },
    ],
  });
  for (let index = 0; index < 2; index += 1) {
    insertMessage(racingEnv, {
      messageId: `msg_sc_racing_${racingSuffix}_${index}`,
      roomId: racingRoom,
      senderId: racingHuman,
      seq: index + 1,
      body: `SC-RACING-${index}`,
      createdAt: MESSAGE_AT + index,
    });
  }
  const racingSpace = await ensureSpaceForAgent(racingEnv.d1, {
    instanceId: racingInstance,
    agentId: racingAgent,
    now: AT,
  });
  let deactivated = false;
  const racingDb = new Proxy(racingEnv.d1, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          if (!deactivated && sql.includes('FROM rooms WHERE room_id = ?')) {
            deactivated = true;
            target
              .prepare('UPDATE memory_spaces SET active = 0 WHERE space_id = ?')
              .bind(racingSpace.space_id)
              .run();
          }
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as D1Database;
  const racingRunner = new MemoryBackfill({
    db: racingDb,
    instanceId: racingInstance,
    now: () => AT,
    windowEnabled: false,
    spaceCatchup: true,
  });
  const racingRun = await racingRunner.runOnce();
  checkEqual(
    '扫描期间空间停用计入 space_capture_changed',
    racingRun.space_catchup.skips.space_capture_changed,
    1,
  );
  checkEqual('扫描期间空间停用不完成', racingRun.space_catchup.completed, 0);
  checkEqual(
    '扫描期间空间停用不写 done',
    await readMemoryCursor(racingEnv.d1, {
      scopeKind: 'space',
      scopeId: racingSpace.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
    }),
    null,
  );
  checkEqual(
    '扫描期间空间停用不推进 rowid 游标',
    await readMemoryCursor(racingEnv.d1, {
      scopeKind: 'space',
      scopeId: racingSpace.space_id,
      cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupRowid,
    }),
    null,
  );
  checkEqual(
    '扫描期间空间停用不产生意图',
    count(
      racingEnv,
      'SELECT COUNT(*) AS n FROM memory_retain_intents WHERE space_id = ?',
      racingSpace.space_id,
    ),
    0,
  );
  racingEnv.db.close();
}

async function run(): Promise<void> {
  console.log('memory backfill: space catch-up');
  await spaceCatchupChecks();
  console.log('memory backfill space catch-up: all checks passed');
}

await run();
