/**
 * MF11 验收（二）：补读固定快照、分页、预算与计划生命周期。
 *
 * 覆盖 C07/C11：H 固定后新消息不进入旧计划、scan cursor 与消费范围独立、
 * 未读集合不变成待办/事件/pending_count、缺失必要消息显式标记、请求幂等、
 * 退群重加后计划过期且不可消费。
 *
 * 运行：bun run test:memory-catchup
 */
import { check, checkEqual, checksPassed } from './lib/harness';
import { createMemoryEnv, leaveAndRejoin, privateTarget } from './lib/memory-unit';
import {
  AT,
  expectCode,
  insertMessage,
  instanceId,
  setupAgentRoom,
} from './lib/memory-mf11';
import {
  getCatchupPage,
  planCatchup,
  prepareCatchupSelections,
} from '../src/memory/catchup';

async function main(): Promise<void> {
  const env = createMemoryEnv();
  // -------------------------------------------------------------------------
  // 5. catchup：固定 H、分页、预算、幂等、退群重加
  // -------------------------------------------------------------------------
  const fourth = await setupAgentRoom(env, 'catchup');
  for (const seq of [10, 20, 30, 40, 50, 60]) {
    insertMessage(env, {
      messageId: `msg_${fourth.room}_${seq}`,
      roomId: fourth.room,
      senderId: fourth.manager,
      seq,
      body: `CATCHUP-${seq}`,
    });
  }
  const beforeEvents = (env.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
  const beforePending = (env.db
    .prepare('SELECT pending_count AS n FROM actors WHERE actor_id = ?')
    .get(fourth.agent) as { n: number }).n;
  const planRequest = {
    instanceId,
    agentId: fourth.agent,
    space: fourth.space,
    roomId: fourth.room,
    query: '补充当前任务上下文',
    requiredMessageIds: [`msg_${fourth.room}_30`],
    budget: { candidate_limit: 3, selected_limit: 1, output_bytes: 1024 },
    requestKey: 'catchup_req_1',
    now: AT,
  };
  const plan = await planCatchup(env.d1, planRequest);
  checkEqual('catchup 状态 partial', plan.status, 'partial');
  checkEqual('catchup 固定 H', plan.snapshot.upper_bound, 60);
  check('scan cursor 记录扫描位置', plan.scan_cursor !== null);
  const planAgain = await planCatchup(env.d1, planRequest);
  checkEqual('同 requestKey 幂等', planAgain.plan_id, plan.plan_id);
  await expectCode(
    '同 requestKey 换预算冲突',
    planCatchup(env.d1, {
      ...planRequest,
      budget: { candidate_limit: 2, selected_limit: 1, output_bytes: 1024 },
    }),
    'IDEMPOTENCY_CONFLICT',
  );
  insertMessage(env, {
    messageId: `msg_${fourth.room}_70`,
    roomId: fourth.room,
    senderId: fourth.manager,
    seq: 70,
    body: 'CATCHUP-70',
  });
  const page1 = await getCatchupPage(env.d1, {
    instanceId,
    planId: plan.plan_id,
    agentId: fourth.agent,
    space: fourth.space,
    limit: 1,
    now: AT + 1,
  });
  checkEqual('分页第一页 1 项', page1.items.length, 1);
  checkEqual('新消息不进入固定 H 计划', page1.items.some((item) => item.message_id.endsWith('_70')), false);
  check('分页有 next_cursor', page1.next_cursor !== null);
  const page2 = await getCatchupPage(env.d1, {
    instanceId,
    planId: plan.plan_id,
    agentId: fourth.agent,
    space: fourth.space,
    limit: 5,
    cursor: page1.next_cursor,
    now: AT + 1,
  });
  checkEqual('分页第二页继续', page2.items[0]?.message_id, `msg_${fourth.room}_60`);
  checkEqual('分页使用固定快照', page2.snapshot.upper_bound, 60);
  const prepared = await prepareCatchupSelections(env.d1, {
    instanceId,
    planId: plan.plan_id,
    agentId: fourth.agent,
    space: fourth.space,
    targetScope: privateTarget(),
    now: AT + 1,
  });
  checkEqual('catchup 选中项生成 selection', prepared.selections.length, 1);
  checkEqual('selection 仍为 not_consumed', prepared.selections[0]?.consumption, 'not_consumed');
  checkEqual(
    'catchup 不产生经历',
    (env.db
      .prepare('SELECT COUNT(*) AS n FROM memory_experiences WHERE agent_actor_id = ?')
      .get(fourth.agent) as { n: number }).n,
    0,
  );
  checkEqual(
    'catchup 不写 events',
    (env.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
    beforeEvents,
  );
  checkEqual(
    'catchup 不改 pending_count',
    (env.db
      .prepare('SELECT pending_count AS n FROM actors WHERE actor_id = ?')
      .get(fourth.agent) as { n: number }).n,
    beforePending,
  );
  const preparedAgain = await prepareCatchupSelections(env.d1, {
    instanceId,
    planId: plan.plan_id,
    agentId: fourth.agent,
    space: fourth.space,
    targetScope: privateTarget(),
    now: AT + 2,
  });
  checkEqual(
    'catchup 消费幂等',
    preparedAgain.selections[0]?.selection_id,
    prepared.selections[0]?.selection_id,
  );
  const missingPlan = await planCatchup(env.d1, {
    ...planRequest,
    requestKey: 'catchup_req_missing',
    requiredMessageIds: [`msg_${fourth.room}_missing`],
    now: AT + 2,
  });
  checkEqual('缺失必要消息状态', missingPlan.status, 'missing_required');
  checkEqual(
    '缺失必要消息显式标记',
    missingPlan.items.find((item) => item.message_id.endsWith('_missing'))?.selection_state,
    'missing',
  );
  leaveAndRejoin(env, fourth.room, fourth.agent, {
    joinedSeq: 50,
    memberGeneration: 2,
    at: AT + 3,
  });
  env.db
    .prepare('UPDATE rooms SET member_seq = member_seq + 1, policy_revision = policy_revision + 1 WHERE room_id = ?')
    .run(fourth.room);
  const expiredPage = await getCatchupPage(env.d1, {
    instanceId,
    planId: plan.plan_id,
    agentId: fourth.agent,
    space: fourth.space,
    limit: 5,
    now: AT + 3,
  });
  checkEqual('退群重加后旧计划过期', expiredPage.status, 'expired');
  checkEqual('过期计划不返回条目', expiredPage.items.length, 0);
  await expectCode(
    '退群重加后不能消费旧计划',
    prepareCatchupSelections(env.d1, {
      instanceId,
      planId: plan.plan_id,
      agentId: fourth.agent,
      space: fourth.space,
      targetScope: privateTarget(),
      now: AT + 3,
    }),
    'MEMBERSHIP_STALE',
  );

  console.log(`\nMF11 catchup checks passed: ${checksPassed()} 项`);
}

await main();
