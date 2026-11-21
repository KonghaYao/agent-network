/**
 * MF03 恢复验收：进程在本地提交后、外部响应前后退出。
 *
 * 运行：bun run test:memory-recovery
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureMemoryInstance } from '../src/memory/access';
import { BackendSpaceCache } from '../src/memory/backend-space-cache';
import type { EnsureSpaceResult, MemoryAdapterSearchPlan } from '../src/memory/adapters/types';
import { MemoryRuntime } from '../src/memory/runtime';
import { ensureSpaceForAgent } from '../src/memory/store';
import { recoverMemoryJobs } from '../src/memory/jobs';
import { RecordingAdapter } from './lib/memory-recording-adapter';
import { check, checkEqual } from './lib/harness';
import { createMemoryEnv, seedActor, unique } from './lib/memory-unit';

const AT = 1_700_000_000_000;

async function verifySpaceCache(): Promise<void> {
  const space = { space_id: 'msp_cache', ownership_epoch: 1, backend_binding_epoch: 1 };
  const ready: EnsureSpaceResult = { status: 'ready', job_ref: null, backend_ref: null, reason: null };
  let calls = 0;
  const cache = new BackendSpaceCache({
    async ensureSpace() {
      calls += 1;
      if (calls === 1) throw new Error('upstream reset');
      return calls === 2 ? { ...ready, status: 'unavailable' } : ready;
    },
  }, 2);
  const first = await Promise.allSettled([cache.ensure(space), cache.ensure(space)]);
  check('同代次并发共享失败', calls === 1 && first.every((result) => result.status === 'rejected'));
  checkEqual('不可用响应不缓存', await cache.ensure(space), false);
  checkEqual('失败后再次确认', await cache.ensure(space), true);
  await cache.ensure(space);
  checkEqual('成功复用', calls, 3);
  await cache.ensure({ ...space, backend_binding_epoch: 2 });
  await cache.ensure({ ...space, ownership_epoch: 2 });
  checkEqual('两类 epoch 分别确认', calls, 5);
  await cache.ensure(space);
  checkEqual('超出容量重新确认最早代次', calls, 6);
  cache.close();
  checkEqual('关闭后不触发远端', await cache.ensure(space), false);

  const env = createMemoryEnv();
  const adapter = new RecordingAdapter();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let probes = 0;
  adapter.ensureSpace = async () => {
    probes += 1;
    if (probes === 1) {
      entered();
      await gate;
    }
    return { status: 'ready', backend_ref: null, job_ref: null, reason: null };
  };
  const runtime = new MemoryRuntime(env.d1, { adapter });
  const plan: MemoryAdapterSearchPlan = {
    query: null, hard_filters: {}, ranking_hints: {}, candidate_limit: 1,
    output_bytes: 256, deadline_at: null, policy_version: 1,
  };
  try {
    await runtime.start();
    const oldRead = Promise.allSettled([runtime.searchNow(space, plan)]);
    await started;
    await runtime.stop();
    await runtime.start();
    const newRead = await runtime.searchNow(space, plan);
    release();
    checkEqual('旧探测不能在重启后发起检索', (await oldRead)[0]?.status, 'rejected');
    checkEqual('重启从当前代次检索', newRead.status, 'empty');
    await runtime.searchNow(space, plan);
    checkEqual('旧探测结束不影响新缓存', probes, 2);
  } finally {
    release();
    await runtime.stop();
    env.db.close();
  }
}

async function main(): Promise<void> {
  await verifySpaceCache();
  // I04：子进程在本地提交后/外部响应前后退出，重启仍可恢复意图。
  const root = mkdtempSync(join(tmpdir(), 'memory-mf03-'));
  try {
    const businessPath = join(root, 'business.sqlite');
    const businessChild = Bun.spawnSync({
      cmd: ['bun', 'scripts/lib/memory-crash-child.ts', businessPath, 'business'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    checkEqual('I04 业务提交后子进程正常退出', businessChild.exitCode, 0);
    const businessEnv = createMemoryEnv(businessPath);
    checkEqual(
      'I04 已提交消息保留',
      (businessEnv.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE message_id = 'msg_rm_crash_direct_crash'").get() as { n: number }).n,
      1,
    );
    checkEqual(
      'I04 共享来源意图可恢复',
      (businessEnv.db.prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE source_key = 'msg_rm_crash_direct_crash'").get() as { n: number }).n,
      1,
    );
    checkEqual(
      'I04 无 ExposureReceipt 不产生个人经历',
      (businessEnv.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }).n,
      0,
    );
    checkEqual(
      'I04 无证据不产生个人 retain',
      (businessEnv.db.prepare('SELECT COUNT(*) AS n FROM memory_retain_intents').get() as { n: number }).n,
      0,
    );
    businessEnv.db.close();

    const beforePath = join(root, 'before.sqlite');
    const beforeChild = Bun.spawnSync({
      cmd: ['bun', 'scripts/lib/memory-crash-child.ts', beforePath, 'before_external'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    checkEqual('I04 外部响应前退出子进程', beforeChild.exitCode, 0);
    const beforeEnv = createMemoryEnv(beforePath);
    const beforeAdapter = new RecordingAdapter();
    const beforeRuntime = new MemoryRuntime(beforeEnv.d1, {
      adapter: beforeAdapter,
      instanceId: 'mni_crash',
      capture: true,
      now: () => AT + 200,
    });
    await beforeRuntime.start();
    const beforeTick = await beforeRuntime.tick();
    checkEqual('I04 重启恢复 pending retain 作业', beforeAdapter.retainCalls, 1);
    check('I04 恢复后作业完成', beforeTick.completed >= 1, beforeTick);
    const beforeJob = await beforeEnv.db
      .prepare("SELECT status FROM memory_jobs WHERE operation_type = 'retain'")
      .get() as { status: string };
    checkEqual('I04 恢复后 job completed', beforeJob.status, 'completed');
    await beforeRuntime.stop();
    beforeEnv.db.close();

    const afterPath = join(root, 'after.sqlite');
    const afterChild = Bun.spawnSync({
      cmd: ['bun', 'scripts/lib/memory-crash-child.ts', afterPath, 'after_external'],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    checkEqual('I04 外部响应后退出子进程', afterChild.exitCode, 0);
    const afterEnv = createMemoryEnv(afterPath);
    const afterAdapter = new RecordingAdapter();
    const afterRuntime = new MemoryRuntime(afterEnv.d1, {
      adapter: afterAdapter,
      instanceId: 'mni_crash',
      capture: true,
      now: () => AT + 300,
    });
    await afterRuntime.start();
    const afterRecovered = await afterEnv.db
      .prepare("SELECT status FROM memory_jobs WHERE operation_type = 'retain'")
      .get() as { status: string };
    checkEqual('I04 远端已受理时重启标 unknown', afterRecovered.status, 'unknown');
    const reconciled = await afterRuntime.reconcile();
    checkEqual('I04 unknown 通过对账完成', reconciled.completed, 1);
    checkEqual('I04 对账不重复调用 retain', afterAdapter.retainCalls, 0);
    check('I04 对账查询原 JobRef', afterAdapter.jobStatusCalls >= 1);
    const afterJob = await afterEnv.db
      .prepare("SELECT status FROM memory_jobs WHERE operation_type = 'retain'")
      .get() as { status: string };
    checkEqual('I04 对账后 job completed', afterJob.status, 'completed');
    await afterRuntime.stop();
    afterEnv.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // 启动恢复：过期租约且无 JobRef 回 pending。
  const pendingEnv = createMemoryEnv();
  const pendingInstance = await ensureMemoryInstance(pendingEnv.d1, {
    configuredId: 'mni_recover',
    now: AT,
  });
  const pendingAgent = unique('agt_recover');
  seedActor(pendingEnv, { actorId: pendingAgent, kind: 'agent' });
  const pendingSpace = await ensureSpaceForAgent(pendingEnv.d1, {
    instanceId: pendingInstance,
    agentId: pendingAgent,
    now: AT,
  });
  pendingEnv.db
    .prepare(
      `INSERT INTO memory_jobs
         (job_id, space_id, ownership_epoch, agent_actor_id, operation_type,
          operation_key, payload_sha256, backend_binding_epoch, status, stage,
          attempt, lease_id, lease_until, next_attempt_at, created_at, updated_at)
       VALUES ('mjb_recover', ?, 1, ?, 'ensure_space', 'recover_key', 'h', 1,
               'leased', 'accepted', 1, 'lease_recover', ?, ?, ?, ?)`,
    )
    .run(pendingSpace.space_id, pendingAgent, AT + 1, AT + 1, AT, AT);
  const requeued = await recoverMemoryJobs(pendingEnv.d1, { now: AT + 100 });
  checkEqual('启动恢复无远端 ref 的作业回 pending', requeued.requeued, 1);
  pendingEnv.db.close();

}

main()
  .then(() => {
    console.log('memory recovery checks passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
