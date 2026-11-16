/**
 * Phase A：Agent Memory space provisioning 验收。
 *
 * 覆盖：幂等/并发、managed/self_owned owner、excluded 继承、instance 不匹配、
 * disabled/archived skip、sweep 批量与游标、login 失败隔离、消息异步兜底，
 * 以及数据库重启后重复扫描不新增行。
 *
 * 运行：bun run test:memory-provision
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Principal } from '../src/domain/principal';
import type { Env } from '../src/env';
import { ensureMemoryInstance } from '../src/memory/access';
import { MemoryIntegration } from '../src/memory/integration';
import {
  ensureAgentSpace,
  MemoryProvisioner,
  provisionAgentAfterMessage,
  type MemoryProvisionSweepResult,
} from '../src/memory/provision';
import type { MemoryRuntime } from '../src/memory/runtime';
import { login } from '../src/realtime/presence';
import { getActor } from '../src/storage/queries';
import { check, checkEqual, checksPassed, waitUntil } from './lib/harness';
import {
  createMemoryEnv,
  seedActor,
  seedManagement,
  unique,
  type MemoryTestEnv,
} from './lib/memory-unit';

const AT = 1_700_000_000_000;
const INSTANCE = 'mni_provision_test';

function count(
  env: MemoryTestEnv,
  sql: string,
  ...binds: (string | number)[]
): number {
  const row = env.db.prepare(sql).get(...binds) as { n: number } | null;
  return row?.n ?? 0;
}

function spaceCount(env: MemoryTestEnv, agentId: string): number {
  return count(env, 'SELECT COUNT(*) AS n FROM memory_spaces WHERE agent_actor_id = ?', agentId);
}

function activeSpaceCount(env: MemoryTestEnv, agentId: string): number {
  return count(
    env,
    'SELECT COUNT(*) AS n FROM memory_spaces WHERE agent_actor_id = ? AND active = 1',
    agentId,
  );
}

function transitionCount(env: MemoryTestEnv, agentId: string): number {
  return count(
    env,
    'SELECT COUNT(*) AS n FROM memory_space_transitions WHERE agent_actor_id = ?',
    agentId,
  );
}

function loginEnv(
  env: MemoryTestEnv,
  memory: { instanceId: string } | null,
  provision: boolean,
): Env {
  return {
    DB: env.d1,
    MEMORY: memory,
    MEMORY_PROVISION: provision,
    NOTIFICATION_HUB: {
      loginActor: () => ({ online: true, since: AT, connections: 0 }),
    },
  } as unknown as Env;
}

async function principalOf(env: MemoryTestEnv, agentId: string): Promise<Principal> {
  const actor = await getActor(env.d1, agentId);
  if (!actor) throw new Error(`missing actor ${agentId}`);
  return { credentialHash: 'test-hash', actor, credential: null };
}

async function basicChecks(): Promise<void> {
  const env = createMemoryEnv();
  const agent = unique('agt_self');
  seedActor(env, { actorId: agent, kind: 'agent' });

  const first = await ensureAgentSpace(env.d1, {
    agentId: agent,
    instanceId: INSTANCE,
    now: AT,
  });
  checkEqual('legacy self-owned 创建空间', first.status, 'created');
  if (first.status !== 'created') throw new Error('unreachable');
  check('确定性 space id', first.space.space_id.startsWith('msp_pv_'), first.space.space_id);
  checkEqual('self_owned owner 是自己', first.space.owner_actor_id, agent);
  checkEqual('self_owned kind', first.space.ownership_kind, 'self_owned');
  checkEqual('capture=pending', first.space.capture, 'pending');
  checkEqual('epoch=1', first.space.ownership_epoch, 1);
  checkEqual('space 行数=1', spaceCount(env, agent), 1);
  checkEqual('transition 行数=1', transitionCount(env, agent), 1);

  const second = await ensureAgentSpace(env.d1, {
    agentId: agent,
    instanceId: INSTANCE,
    now: AT + 1,
  });
  checkEqual('重复调用 existing', second.status, 'existing');
  checkEqual('重复不新增 space', spaceCount(env, agent), 1);
  checkEqual('重复不新增 transition', transitionCount(env, agent), 1);

  await ensureAgentSpace(env.d1, { agentId: agent, instanceId: INSTANCE, now: AT + 2 });
  checkEqual('第三次仍不新增', spaceCount(env, agent), 1);
  checkEqual('provisioning 不写 operations', count(env, 'SELECT COUNT(*) AS n FROM operations'), 0);
  checkEqual('provisioning 不写 events', count(env, 'SELECT COUNT(*) AS n FROM events'), 0);
  checkEqual('provisioning 不写 outbox', count(env, 'SELECT COUNT(*) AS n FROM outbox'), 0);

  const manager = unique('hum_manager');
  const managed = unique('agt_managed');
  seedActor(env, { actorId: manager, kind: 'human' });
  seedActor(env, { actorId: managed, kind: 'agent' });
  const bindingId = seedManagement(env, { agentId: managed, managerId: manager });
  const managedResult = await ensureAgentSpace(env.d1, {
    agentId: managed,
    instanceId: INSTANCE,
    now: AT,
  });
  checkEqual('managed 创建空间', managedResult.status, 'created');
  if (managedResult.status !== 'created') throw new Error('unreachable');
  checkEqual('managed owner=manager', managedResult.space.owner_actor_id, manager);
  checkEqual('managed kind', managedResult.space.ownership_kind, 'managed');
  checkEqual('managed binding', managedResult.space.management_binding_id, bindingId);

  env.db.close();
}

async function skipAndConflictChecks(): Promise<void> {
  const env = createMemoryEnv();

  const human = unique('hum_only');
  seedActor(env, { actorId: human, kind: 'human' });
  const humanResult = await ensureAgentSpace(env.d1, {
    agentId: human,
    instanceId: INSTANCE,
    now: AT,
  });
  checkEqual('human 不建空间', humanResult.status, 'skipped');
  if (humanResult.status === 'skipped') checkEqual('human reason', humanResult.reason, 'not_agent');

  const missing = await ensureAgentSpace(env.d1, {
    agentId: unique('agt_missing'),
    instanceId: INSTANCE,
    now: AT,
  });
  checkEqual('不存在 actor skip', missing.status, 'skipped');

  const disabled = unique('agt_disabled');
  seedActor(env, { actorId: disabled, kind: 'agent', disabled: true });
  const disabledResult = await ensureAgentSpace(env.d1, {
    agentId: disabled,
    instanceId: INSTANCE,
    now: AT,
  });
  checkEqual('disabled skip', disabledResult.status, 'skipped');
  if (disabledResult.status === 'skipped') {
    checkEqual('disabled reason', disabledResult.reason, 'disabled');
  }
  checkEqual('disabled 不建空间', spaceCount(env, disabled), 0);

  const archived = unique('agt_archived');
  seedActor(env, { actorId: archived, kind: 'agent' });
  env.db.prepare('UPDATE actors SET archived_at = ? WHERE actor_id = ?').run(AT, archived);
  const archivedResult = await ensureAgentSpace(env.d1, {
    agentId: archived,
    instanceId: INSTANCE,
    now: AT,
  });
  checkEqual('archived skip', archivedResult.status, 'skipped');
  if (archivedResult.status === 'skipped') {
    checkEqual('archived reason', archivedResult.reason, 'archived');
  }

  const noInstance = await ensureAgentSpace(env.d1, {
    agentId: disabled,
    instanceId: null,
    now: AT,
  });
  checkEqual('无 instance no-op', noInstance.status, 'skipped');

  // 已有 active space 时不因管理关系变化隐式 transfer。
  const managerA = unique('hum_a');
  const managerB = unique('hum_b');
  const agent = unique('agt_owner');
  seedActor(env, { actorId: managerA, kind: 'human' });
  seedActor(env, { actorId: managerB, kind: 'human' });
  seedActor(env, { actorId: agent, kind: 'agent' });
  seedManagement(env, { agentId: agent, managerId: managerA });
  const created = await ensureAgentSpace(env.d1, {
    agentId: agent,
    instanceId: INSTANCE,
    now: AT,
  });
  checkEqual('初始 managed 空间', created.status, 'created');
  env.db
    .prepare('UPDATE agent_managements SET manager_id = ? WHERE agent_id = ? AND status = ?')
    .run(managerB, agent, 'active');
  const afterChange = await ensureAgentSpace(env.d1, {
    agentId: agent,
    instanceId: INSTANCE,
    now: AT + 10,
  });
  checkEqual('owner 变化不新建', afterChange.status, 'existing');
  if (afterChange.status === 'existing') {
    checkEqual('owner 保持原值', afterChange.space.owner_actor_id, managerA);
    checkEqual('epoch 不 bump', afterChange.space.ownership_epoch, 1);
  }
  checkEqual('owner 变化不新增 transition', transitionCount(env, agent), 1);

  // instance 不匹配：只报告，不写任何行。
  const mismatch = await ensureAgentSpace(env.d1, {
    agentId: agent,
    instanceId: 'mni_other',
    now: AT + 11,
  });
  checkEqual('instance 不匹配 conflict', mismatch.status, 'conflict');
  if (mismatch.status === 'conflict') {
    checkEqual('instance 不匹配 reason', mismatch.reason, 'instance_mismatch');
  }
  checkEqual('instance 不匹配不新增', spaceCount(env, agent), 1);

  env.db.close();
}

async function inheritanceAndConcurrencyChecks(): Promise<void> {
  const env = createMemoryEnv();
  const agent = unique('agt_excluded');
  seedActor(env, { actorId: agent, kind: 'agent' });
  const created = await ensureAgentSpace(env.d1, {
    agentId: agent,
    instanceId: INSTANCE,
    now: AT,
  });
  checkEqual('excluded 前置创建', created.status, 'created');
  env.db
    .prepare('UPDATE memory_spaces SET active = 0, capture = ? WHERE agent_actor_id = ?')
    .run('excluded', agent);
  const inherited = await ensureAgentSpace(env.d1, {
    agentId: agent,
    instanceId: INSTANCE,
    now: AT + 10,
  });
  checkEqual('excluded 后重建', inherited.status, 'created');
  if (inherited.status === 'created') {
    checkEqual('继承 capture=excluded', inherited.space.capture, 'excluded');
    checkEqual('epoch 递增到 2', inherited.space.ownership_epoch, 2);
  }
  checkEqual('保留历史空间', spaceCount(env, agent), 2);

  const concurrentAgent = unique('agt_concurrent');
  seedActor(env, { actorId: concurrentAgent, kind: 'agent' });
  const [one, two] = await Promise.all([
    ensureAgentSpace(env.d1, { agentId: concurrentAgent, instanceId: INSTANCE, now: AT }),
    ensureAgentSpace(env.d1, {
      agentId: concurrentAgent,
      instanceId: INSTANCE,
      now: AT + 1,
    }),
  ]);
  check(
    '并发调用最多一个创建',
    [one.status, two.status].filter((status) => status === 'created').length <= 1,
    [one.status, two.status],
  );
  checkEqual('并发后恰好 1 个 active space', activeSpaceCount(env, concurrentAgent), 1);
  checkEqual('并发后恰好 1 条 transition', transitionCount(env, concurrentAgent), 1);
  env.db.close();
}

async function sweepChecks(): Promise<void> {
  const env = createMemoryEnv();
  const agents: string[] = [];
  for (let index = 0; index < 55; index += 1) {
    const agent = unique('agt_sweep');
    agents.push(agent);
    seedActor(env, { actorId: agent, kind: 'agent' });
  }
  const disabled = unique('agt_sweep_disabled');
  seedActor(env, { actorId: disabled, kind: 'agent', disabled: true });

  const provisioner = new MemoryProvisioner({
    db: env.d1,
    instanceId: 'mni_sweep',
    batchSize: 50,
    now: () => AT,
    log: () => undefined,
  });

  const first = await provisioner.runOnce();
  checkEqual('sweep 首批扫描上限 50', first.scanned, 50);
  checkEqual('sweep 首批创建 50', first.created, 50);
  checkEqual('sweep 首批 batches=1', first.batches, 1);
  checkEqual('sweep 首批未复位游标', first.cursor_reset, false);

  const second = await provisioner.runOnce();
  checkEqual('sweep 第二批扫描 5', second.scanned, 5);
  checkEqual('sweep 第二批创建 5', second.created, 5);
  checkEqual('sweep 扫尾复位游标', second.cursor_reset, true);

  const third = await provisioner.runOnce();
  checkEqual('sweep 重复扫描 0 增量', third.created, 0);
  checkEqual('sweep 重复扫描 0 existing', third.existing, 0);
  checkEqual('sweep 不改 disabled', spaceCount(env, disabled), 0);

  const totalSpaces = count(env, 'SELECT COUNT(*) AS n FROM memory_spaces');
  const totalTransitions = count(env, 'SELECT COUNT(*) AS n FROM memory_space_transitions');
  checkEqual('sweep 总数=55', totalSpaces, 55);
  checkEqual('transition 总数=55', totalTransitions, 55);

  const [a, b] = await Promise.all([provisioner.runOnce(), provisioner.runOnce()]);
  check('sweep 单轮不重入（共享 in-flight）', a === b);
  check('sweep 状态可读', provisioner.status().last_run_at !== null);
  checkEqual('sweep 状态不运行', provisioner.status().running, false);
  env.db.close();
}

async function loginChecks(): Promise<void> {
  const env = createMemoryEnv();
  await ensureMemoryInstance(env.d1, { configuredId: INSTANCE, now: AT });

  const agent = unique('agt_login');
  seedActor(env, { actorId: agent, kind: 'agent' });
  const principal = await principalOf(env, agent);
  const view = await login(loginEnv(env, { instanceId: INSTANCE }, true), principal);
  checkEqual('login 成功', view.online, true);
  checkEqual('login 创建空间', activeSpaceCount(env, agent), 1);
  await login(loginEnv(env, { instanceId: INSTANCE }, true), principal);
  checkEqual('重复 login 不新增', spaceCount(env, agent), 1);

  const offAgent = unique('agt_login_off');
  seedActor(env, { actorId: offAgent, kind: 'agent' });
  const offPrincipal = await principalOf(env, offAgent);
  await login(loginEnv(env, { instanceId: INSTANCE }, false), offPrincipal);
  checkEqual('MEMORY_PROVISION=false no-op', spaceCount(env, offAgent), 0);

  const noMemoryAgent = unique('agt_login_no_memory');
  seedActor(env, { actorId: noMemoryAgent, kind: 'agent' });
  const noMemoryPrincipal = await principalOf(env, noMemoryAgent);
  await login(loginEnv(env, null, true), noMemoryPrincipal);
  checkEqual('Memory 关闭 no-op', spaceCount(env, noMemoryAgent), 0);

  const failingAgent = unique('agt_login_fail');
  seedActor(env, { actorId: failingAgent, kind: 'agent' });
  const failingPrincipal = await principalOf(env, failingAgent);
  const failedView = await login(
    loginEnv(env, { instanceId: 'mni_absent' }, true),
    failingPrincipal,
  );
  checkEqual('provision 失败不影响 login', failedView.online, true);
  checkEqual('provision 失败不建空间', spaceCount(env, failingAgent), 0);

  const messageAgent = unique('agt_message');
  seedActor(env, { actorId: messageAgent, kind: 'agent' });
  provisionAgentAfterMessage(loginEnv(env, { instanceId: INSTANCE }, true), messageAgent);
  await waitUntil(
    '消息后异步补建空间',
    () => activeSpaceCount(env, messageAgent) === 1,
    2_000,
    10,
  );
  checkEqual('消息兜底只建 1 个空间', spaceCount(env, messageAgent), 1);

  env.db.close();
}

async function integrationWiringChecks(): Promise<void> {
  const empty: MemoryProvisionSweepResult = {
    scanned: 0,
    created: 0,
    existing: 0,
    conflicts: 0,
    skipped: 0,
    errors: 0,
    batches: 0,
    cursor_reset: true,
    failure_reasons: {},
    duration_ms: 0,
  };
  let runs = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
    provisionIntervalMs: 60_000,
    provision: {
      runOnce: async () => {
        runs += 1;
        await gate;
        return empty;
      },
    },
  });
  await integration.start();
  await waitUntil('启动立即执行 provisioning', () => runs === 1, 2_000, 10);
  checkEqual('provision 周期写入状态', integration.status().provision_interval_ms, 60_000);
  const concurrent = integration.runProvisionOnce();
  checkEqual('provision 单轮不重入', runs, 1);
  release();
  await concurrent;
  check('provision 状态可读', integration.status().last_provision_at !== null);
  await integration.stop();
  checkEqual('provision 随 integration 关闭', runs, 1);
}

async function restartIdempotencyChecks(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agentnet-provision-'));
  const path = join(root, 'provision.sqlite');
  try {
    const firstEnv = createMemoryEnv(path);
    const agents: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const agent = unique('agt_restart');
      agents.push(agent);
      seedActor(firstEnv, { actorId: agent, kind: 'agent' });
    }
    const first = new MemoryProvisioner({
      db: firstEnv.d1,
      instanceId: 'mni_restart',
      now: () => AT,
      log: () => undefined,
    });
    const created = await first.runOnce();
    checkEqual('重启前创建 3', created.created, 3);
    firstEnv.db.close();

    const secondEnv = createMemoryEnv(path);
    const second = new MemoryProvisioner({
      db: secondEnv.d1,
      instanceId: 'mni_restart',
      now: () => AT,
      log: () => undefined,
    });
    const replayed = await second.runOnce();
    checkEqual('重开数据库后 0 新增', replayed.created, 0);
    checkEqual(
      '重开数据库后 space 仍为 3',
      count(secondEnv, 'SELECT COUNT(*) AS n FROM memory_spaces'),
      3,
    );
    checkEqual(
      '重开数据库后 transition 仍为 3',
      count(secondEnv, 'SELECT COUNT(*) AS n FROM memory_space_transitions'),
      3,
    );
    secondEnv.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  console.log('memory provision: basic idempotency');
  await basicChecks();
  console.log('memory provision: skips + ownership + instance');
  await skipAndConflictChecks();
  console.log('memory provision: capture inheritance + concurrency');
  await inheritanceAndConcurrencyChecks();
  console.log('memory provision: sweep bounds + cursor');
  await sweepChecks();
  console.log('memory provision: login isolation + message fallback');
  await loginChecks();
  console.log('memory provision: integration wiring');
  await integrationWiringChecks();
  console.log('memory provision: restart idempotency');
  await restartIdempotencyChecks();
  console.log(`memory provision: ${checksPassed()} checks passed`);
}

await run().catch((error) => {
  console.error(error);
  process.exit(1);
});
