/**
 * MF03 恢复验收：进程在本地提交后、外部响应前后退出。
 *
 * 运行：bun run test:memory-recovery
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureMemoryInstance } from '../src/memory/access';
import { MemoryRuntime } from '../src/memory/runtime';
import { ensureSpaceForAgent } from '../src/memory/store';
import { recoverMemoryJobs } from '../src/memory/jobs';
import { RecordingAdapter } from './lib/memory-recording-adapter';
import { check, checkEqual } from './lib/harness';
import { createMemoryEnv, seedActor, unique } from './lib/memory-unit';

const AT = 1_700_000_000_000;

async function main(): Promise<void> {
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
