/**
 * MF10 Hindsight 生命周期、写审计与外部故障检查。
 *
 * 从 verify-memory-integration.ts 原样搬出，断言强度不变。
 */
import { join } from 'node:path';

import { LIMITS } from '../../src/contracts/limits';
import { HindsightMemoryAdapter } from '../../src/memory/adapters/hindsight';
import { MemoryRuntime } from '../../src/memory/runtime';
import type { MemoryJobEvent } from '../../src/memory/runtime';
import { check, checkEqual } from './harness';
import { seedMemoryAdmission } from './memory-admission-fixture';
import { runHindsightWriteAudit } from './hindsight-write-audit';
import { FakeHindsight } from './memory-hindsight-fake';
import {
  AT,
  RejectingRetryAdapter,
  hindsightAdapter,
  jobSnapshotOf,
  jobStatusOf,
} from './memory-integration-support';

export async function hindsightLifecycleChecks(root: string): Promise<void> {
  // accepted -> completed：只有远端 completed 才写本地 completed，并写回确认证据。
  {
    const fake = new FakeHindsight(`test_hindsight_lifecycle_${crypto.randomUUID().replaceAll('-', '')}`);
    const fixture = await seedMemoryAdmission(join(root, 'hindsight-complete.sqlite'));
    const events: MemoryJobEvent[] = [];
    const clock = AT + 1_000;
    const runtime = new MemoryRuntime(fixture.env.d1, {
      adapter: hindsightAdapter(fake),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock,
      onJobEvent: (event) => events.push(event),
    });
    try {
      await runtime.start();
      const tick = await runtime.tick();
      checkEqual('HS accepted 提交计数', tick.submitted, 1);
      check(
        'HS 提交事件含 provider_job_id',
        events.some(
          (event) =>
            event.transition === 'submitted' && typeof event.provider_job_id === 'string',
        ),
      );
      const submitted = await jobSnapshotOf(fixture.env);
      checkEqual('HS 提交后 unknown', submitted.status, 'unknown');
      check(
        'HS 提交结果记录 accepted',
        submitted.result_json?.includes('"provider_state":"accepted"') === true,
      );
      check(
        'HS 提交结果不含正文',
        submitted.result_json?.includes(fixture.text) !== true,
      );
      const operationId = submitted.provider_job_id;
      check('HS 提交写入 provider_job_id', operationId !== null);
      fake.setOperationStatus(operationId!, 'completed');
      const reconciled = await runtime.reconcile();
      checkEqual('HS accepted->completed 对账', reconciled.completed, 1);
      const confirmed = await jobSnapshotOf(fixture.env);
      checkEqual('HS confirmed status', confirmed.status, 'completed');
      checkEqual('HS confirmed stage', confirmed.stage, 'source_applied');
      check(
        'HS confirmed 记录 remote_confirmed_at',
        confirmed.result_json?.includes('"remote_confirmed_at"') === true,
      );
      check(
        'HS confirmed source_applied=true',
        confirmed.result_json?.includes('"source_applied":true') === true,
      );
      check(
        'HS confirmed derived_ready=false',
        confirmed.result_json?.includes('"derived_ready":false') === true,
      );
      check(
        'HS confirmed 保留 provider_job_id',
        confirmed.result_json?.includes(operationId!) === true,
      );
      check(
        'HS completed 事件含 provider_job_id',
        events.some(
          (event) =>
            event.transition === 'remote_completed' &&
            event.provider_job_id === operationId,
        ),
      );
      const health = await runtime.health();
      checkEqual('HS 无未确认 completed', health.unconfirmed_completed, 0);
      checkEqual('HS 远端只有一条文档', fake.visibleDocumentCount(), 1);
      // 模拟旧版本只记录 accepted 就 completed 的历史行；健康检查必须可见。
      await fixture.env.d1
        .prepare(
          `UPDATE memory_jobs
              SET status = 'completed', stage = 'source_applied',
                  result_json = '{"status":"accepted","source_applied":false,"derived_ready":false}'
            WHERE operation_type = 'retain'`,
        )
        .run();
      checkEqual(
        'HS 历史未确认 completed 可见',
        (await runtime.health()).unconfirmed_completed,
        1,
      );
    } finally {
      await runtime.stop();
      fixture.env.db.close();
      await fake.stop();
    }
  }

  // 事件回调抛错只记录，不得把已写回的 completed 变回 unknown。
  {
    const fake = new FakeHindsight(`test_hindsight_event_error_${crypto.randomUUID().replaceAll('-', '')}`);
    const fixture = await seedMemoryAdmission(join(root, 'hindsight-event-error.sqlite'));
    const errors: unknown[] = [];
    const clock = AT + 1_000;
    const runtime = new MemoryRuntime(fixture.env.d1, {
      adapter: hindsightAdapter(fake),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock,
      onJobEvent: () => {
        throw new Error('job event handler failed');
      },
      onError: (error) => errors.push(error),
    });
    try {
      await runtime.start();
      const tick = await runtime.tick();
      checkEqual('HS 事件回调抛错仍受理提交', tick.submitted, 1);
      const operationId = (await jobSnapshotOf(fixture.env)).provider_job_id;
      check('HS 事件回调抛错响应后 provider_job_id 保留', operationId !== null);
      fake.setOperationStatus(operationId!, 'completed');
      const reconciled = await runtime.reconcile();
      checkEqual('HS 事件回调抛错仍完成对账', reconciled.completed, 1);
      const confirmed = await jobSnapshotOf(fixture.env);
      checkEqual('HS 事件回调抛错 job 仍 completed', confirmed.status, 'completed');
      checkEqual('HS 事件回调抛错 stage 仍 source_applied', confirmed.stage, 'source_applied');
      check(
        'HS 事件回调抛错仍写 remote_confirmed_at',
        confirmed.result_json?.includes('"remote_confirmed_at"') === true,
      );
      check('HS 事件回调异常被记录', errors.length > 0);
    } finally {
      await runtime.stop();
      fixture.env.db.close();
      await fake.stop();
    }
  }

  // accepted -> failed：先调远端 retry，再按既有本地退避回到 pending。
  {
    const fake = new FakeHindsight(`test_hindsight_retry_${crypto.randomUUID().replaceAll('-', '')}`);
    const fixture = await seedMemoryAdmission(join(root, 'hindsight-retry.sqlite'));
    let clock = AT + 1_000;
    const events: MemoryJobEvent[] = [];
    const runtime = new MemoryRuntime(fixture.env.d1, {
      adapter: hindsightAdapter(fake),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock,
      onJobEvent: (event) => events.push(event),
    });
    try {
      await runtime.start();
      await runtime.tick();
      const operationId = (await jobSnapshotOf(fixture.env)).provider_job_id;
      check('HS retry 前置 provider_job_id', operationId !== null);
      fake.setOperationStatus(operationId!, 'failed');
      const reconciled = await runtime.reconcile();
      checkEqual('HS failed 触发远端 retry', reconciled.retried, 1);
      checkEqual('HS failed 不直接本地重跑', reconciled.requeued, 0);
      checkEqual('HS failed 调 retry 端点一次', fake.retryCount(operationId!), 1);
      const retried = await jobSnapshotOf(fixture.env);
      checkEqual('HS failed 后回到 pending', retried.status, 'pending');
      check(
        'HS failed 记录 retry_outcome',
        retried.result_json?.includes('"retry_outcome":"accepted"') === true,
      );
      check(
        'HS failed 事件含 retry_outcome',
        events.some(
          (event) =>
            event.transition === 'remote_failed' &&
            event.provider_job_id === operationId &&
            event.retry_outcome === 'accepted',
        ),
      );
      check(
        'HS retry requested 事件含 provider_job_id 与 retry 结果',
        events.some(
          (event) =>
            event.transition === 'remote_retry_requested' &&
            event.provider_job_id === operationId &&
            event.retry_outcome === 'accepted',
        ),
      );
      // 退避到期后重新提交同一 operation_id；后端只返回原作业，不重复建文档。
      clock += 30_000;
      await runtime.tick();
      const resubmitted = await jobSnapshotOf(fixture.env);
      checkEqual('HS retry 后重新等待远端', resubmitted.status, 'unknown');
      checkEqual('HS retry 不重复文档', fake.visibleDocumentCount(), 1);
      fake.setOperationStatus(operationId!, 'completed');
      const completed = await runtime.reconcile();
      checkEqual('HS retry 后对账完成', completed.completed, 1);
      checkEqual('HS retry 最终 completed', (await jobSnapshotOf(fixture.env)).status, 'completed');
    } finally {
      await runtime.stop();
      fixture.env.db.close();
      await fake.stop();
    }
  }

  // attempt 上限：不再请求远端 retry，本地直接 failed，计数与状态一致。
  {
    const fake = new FakeHindsight(`test_hindsight_retry_exhausted_${crypto.randomUUID().replaceAll('-', '')}`);
    const fixture = await seedMemoryAdmission(join(root, 'hindsight-retry-exhausted.sqlite'));
    const clock = AT + 1_000;
    const events: MemoryJobEvent[] = [];
    const runtime = new MemoryRuntime(fixture.env.d1, {
      adapter: hindsightAdapter(fake),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock,
      onJobEvent: (event) => events.push(event),
    });
    try {
      await runtime.start();
      await runtime.tick();
      const operationId = (await jobSnapshotOf(fixture.env)).provider_job_id;
      check('HS retry 耗尽前置 provider_job_id', operationId !== null);
      await fixture.env.d1
        .prepare("UPDATE memory_jobs SET attempt = ? WHERE operation_type = 'retain'")
        .bind(LIMITS.memoryJobMaxAttempts)
        .run();
      fake.setOperationStatus(operationId!, 'failed');
      const reconciled = await runtime.reconcile();
      checkEqual('HS retry 耗尽不再请求 retry', fake.retryCount(operationId!), 0);
      checkEqual('HS retry 耗尽计 failed', reconciled.failed, 1);
      checkEqual('HS retry 耗尽不虚报 retried', reconciled.retried, 0);
      checkEqual('HS retry 耗尽不回到 pending', reconciled.requeued, 0);
      checkEqual('HS retry 耗尽不保持 unknown', reconciled.stillUnknown, 0);
      const exhausted = await jobSnapshotOf(fixture.env);
      checkEqual('HS retry 耗尽本地 failed', exhausted.status, 'failed');
      check(
        'HS retry 耗尽记录尝试上限分类',
        exhausted.result_json?.includes('"retry_outcome":"attempts_exhausted"') === true,
      );
      check(
        'HS retry 耗尽 remote_failed 不含重试结果',
        events.some(
          (event) =>
            event.transition === 'remote_failed' &&
            event.provider_job_id === operationId &&
            event.retry_outcome === null,
        ),
      );
      check(
        'HS retry 耗尽不发 retry requested 事件',
        events.every(
          (event) =>
            event.transition !== 'remote_retry_requested' ||
            event.provider_job_id !== operationId,
        ),
      );
    } finally {
      await runtime.stop();
      fixture.env.db.close();
      await fake.stop();
    }
  }

  // 远端拒绝 retry：保持 unknown，计数与事件都记录 rejected。
  {
    const fake = new FakeHindsight(`test_hindsight_retry_rejected_${crypto.randomUUID().replaceAll('-', '')}`);
    const fixture = await seedMemoryAdmission(join(root, 'hindsight-retry-rejected.sqlite'));
    const clock = AT + 1_000;
    const events: MemoryJobEvent[] = [];
    const runtime = new MemoryRuntime(fixture.env.d1, {
      adapter: new RejectingRetryAdapter({
        baseUrl: fake.baseUrl,
        apiKey: fake.token,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
        retryBaseMs: 1,
        sleepImpl: async () => undefined,
      }),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock,
      onJobEvent: (event) => events.push(event),
    });
    try {
      await runtime.start();
      await runtime.tick();
      const operationId = (await jobSnapshotOf(fixture.env)).provider_job_id;
      fake.setOperationStatus(operationId!, 'failed');
      const reconciled = await runtime.reconcile();
      checkEqual('HS retry 拒绝计数', reconciled.retryRejected, 1);
      checkEqual('HS retry 拒绝保持 unknown', reconciled.stillUnknown, 1);
      checkEqual('HS retry 拒绝不计 retried', reconciled.retried, 0);
      checkEqual('HS retry 拒绝不计 failed', reconciled.failed, 0);
      const rejected = await jobSnapshotOf(fixture.env);
      checkEqual('HS retry 拒绝本地 unknown', rejected.status, 'unknown');
      check(
        'HS retry 拒绝记录 retry_outcome',
        rejected.result_json?.includes('"retry_outcome":"rejected"') === true,
      );
      check(
        'HS retry 拒绝 remote_failed 事件含 retry_outcome',
        events.some(
          (event) =>
            event.transition === 'remote_failed' &&
            event.provider_job_id === operationId &&
            event.retry_outcome === 'rejected',
        ),
      );
      check(
        'HS retry 拒绝不发 retry requested 事件',
        events.every(
          (event) =>
            event.transition !== 'remote_retry_requested' ||
            event.provider_job_id !== operationId,
        ),
      );
    } finally {
      await runtime.stop();
      fixture.env.db.close();
      await fake.stop();
    }
  }

  // unknown：远端 operation 查不到时保留可见 unknown，并记录最近检查时间。
  {
    const fake = new FakeHindsight(`test_hindsight_unknown_${crypto.randomUUID().replaceAll('-', '')}`);
    const fixture = await seedMemoryAdmission(join(root, 'hindsight-unknown.sqlite'));
    let clock = AT + 1_000;
    const runtime = new MemoryRuntime(fixture.env.d1, {
      adapter: hindsightAdapter(fake),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock,
    });
    try {
      await runtime.start();
      await runtime.tick();
      const operationId = (await jobSnapshotOf(fixture.env)).provider_job_id;
      fake.setOperationStatus(operationId!, 'not_found');
      const reconciled = await runtime.reconcile();
      checkEqual('HS unknown 保持可见', reconciled.stillUnknown, 1);
      checkEqual('HS unknown 不静默完成', reconciled.completed, 0);
      const unknown = await jobSnapshotOf(fixture.env);
      checkEqual('HS unknown 状态', unknown.status, 'unknown');
      check(
        'HS unknown 记录 provider_state',
        unknown.result_json?.includes('"provider_state":"unknown"') === true,
      );
      check(
        'HS unknown 记录 last_checked_at',
        unknown.result_json?.includes('"last_checked_at"') === true,
      );
      // 查不到远端作业时保留 unknown，但对账轮次用尽后按既有退避重新提交。
      let lastReconcile = reconciled;
      for (let attempt = 2; attempt <= LIMITS.memoryJobMaxAttempts; attempt += 1) {
        lastReconcile = await runtime.reconcile();
        if (attempt < LIMITS.memoryJobMaxAttempts) {
          checkEqual(`HS unknown 第 ${attempt} 次仍可见`, lastReconcile.stillUnknown, 1);
        }
      }
      checkEqual('HS unknown 轮次用尽后重新入队', lastReconcile.requeued, 1);
      const requeuedUnknown = await jobSnapshotOf(fixture.env);
      checkEqual('HS unknown 重新入队状态', requeuedUnknown.status, 'pending');
      check(
        'HS unknown 记录重新提交原因',
        requeuedUnknown.result_json?.includes('"retry_outcome":"unknown_requeued"') === true,
      );
      fake.setOperationStatus(operationId!, 'completed');
      clock += 30_000;
      await runtime.tick();
      const recovered = await runtime.reconcile();
      checkEqual('HS unknown 恢复 completed', recovered.completed, 1);
    } finally {
      await runtime.stop();
      fixture.env.db.close();
      await fake.stop();
    }
  }

  // 重启对账：进程内定时器不是唯一路径，unknown 作业由新运行时继续确认。
  {
    const fake = new FakeHindsight(`test_hindsight_restart_${crypto.randomUUID().replaceAll('-', '')}`);
    const fixture = await seedMemoryAdmission(join(root, 'hindsight-restart.sqlite'));
    const clock = AT + 1_000;
    const first = new MemoryRuntime(fixture.env.d1, {
      adapter: hindsightAdapter(fake),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock,
    });
    await first.start();
    await first.tick();
    const submitted = await jobSnapshotOf(fixture.env);
    const operationId = submitted.provider_job_id;
    check('HS restart 前置 provider_job_id', operationId !== null);
    await first.stop();
    fake.setOperationStatus(operationId!, 'completed');

    const second = new MemoryRuntime(fixture.env.d1, {
      adapter: hindsightAdapter(fake),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock + 60_000,
    });
    try {
      await second.start();
      const before = await jobSnapshotOf(fixture.env);
      checkEqual('HS restart 保留 unknown', before.status, 'unknown');
      checkEqual('HS restart 保留 provider_job_id', before.provider_job_id, operationId);
      const reconciled = await second.reconcile();
      checkEqual('HS restart 对账完成', reconciled.completed, 1);
      const confirmed = await jobSnapshotOf(fixture.env);
      checkEqual('HS restart 最终 completed', confirmed.status, 'completed');
      check(
        'HS restart 记录 remote_confirmed_at',
        confirmed.result_json?.includes('"remote_confirmed_at"') === true,
      );
      checkEqual('HS restart 不重复文档', fake.visibleDocumentCount(), 1);
    } finally {
      await second.stop();
      fixture.env.db.close();
      await fake.stop();
    }
  }
}

export async function hindsightWriteAuditChecks(root: string): Promise<void> {
  const fake = new FakeHindsight(
    `test_hindsight_audit_${crypto.randomUUID().replaceAll('-', '')}`,
  );
  const auditEnv: Record<string, string | undefined> = {
    ...process.env,
    HINDSIGHT_URL: fake.baseUrl,
    HINDSIGHT_API_KEY: fake.token,
    HINDSIGHT_BANK_PREFIX: 'agentnet',
  };
  const writtenPath = join(root, 'audit-written.sqlite');
  const missingPath = join(root, 'audit-missing.sqlite');
  try {
    const written = await seedMemoryAdmission(writtenPath);
    const runtime = new MemoryRuntime(written.env.d1, {
      adapter: hindsightAdapter(fake),
      instanceId: written.instanceId,
      capture: true,
      now: () => AT + 1_000,
    });
    try {
      await runtime.start();
      await runtime.tick();
      const operationId = (await jobSnapshotOf(written.env)).provider_job_id;
      if (!operationId) throw new Error('audit fixture missing provider job id');
      fake.setOperationStatus(operationId, 'completed');
      await runtime.reconcile();
    } finally {
      await runtime.stop();
      written.env.db.close();
    }

    const args = {
      dbPath: writtenPath,
      bank: null,
      agent: null,
      space: null,
      dryRun: false,
      json: true,
      showBanks: true,
      failOnGap: false,
      source: 'auto' as const,
      pageSize: 100,
      maxPages: 10,
    };
    const report = await runHindsightWriteAudit(args, auditEnv);
    checkEqual('AUDIT expected 表示数', report.totals.expected, 1);
    checkEqual('AUDIT matched', report.totals.matched, 1);
    checkEqual('AUDIT missing', report.totals.missing, 0);
    checkEqual('AUDIT extra', report.totals.extra, 0);
    checkEqual('AUDIT 未确认 completed', report.totals.jobs_completed_unconfirmed, 0);
    checkEqual('AUDIT bank 映射 agent', report.spaces[0]?.agent_id, written.agent);
    check('AUDIT bank 映射 bank_id', (report.spaces[0]?.bank_id.length ?? 0) > 0);
    check('AUDIT 结果不含正文', !JSON.stringify(report).includes(written.text));
    check('AUDIT 结果不含凭据', !JSON.stringify(report).includes(fake.token));

    const cli = await runAuditCli(['--json', '--db', writtenPath], auditEnv);
    const cliText = cli.stdout;
    checkEqual('AUDIT CLI 退出码', cli.exitCode, 0);
    check('AUDIT CLI 输出 matched=1', cliText.includes('"matched": 1'), cliText.slice(0, 2400));
    check('AUDIT CLI 不含凭据', !cliText.includes(fake.token));

    // 只有本地意图、远端 bank 不存在：全部 expected 计为 missing。
    const missing = await seedMemoryAdmission(missingPath);
    missing.env.db.close();
    const missingReport = await runHindsightWriteAudit(
      { ...args, dbPath: missingPath },
      auditEnv,
    );
    checkEqual('AUDIT 缺失 expected', missingReport.totals.expected, 1);
    checkEqual('AUDIT 缺失 matched', missingReport.totals.matched, 0);
    checkEqual('AUDIT 缺失 missing', missingReport.totals.missing, 1);
    checkEqual('AUDIT 缺失 bank 状态', missingReport.spaces[0]?.remote?.state, 'not_found');
    checkEqual('AUDIT 缺失 coverage', missingReport.spaces[0]?.coverage?.missing.length, 1);

    const dryEnv: Record<string, string | undefined> = { ...process.env };
    delete dryEnv.HINDSIGHT_URL;
    delete dryEnv.HINDSIGHT_API_KEY;
    const dry = await runAuditCli(
      ['--dry-run', '--json', '--db', writtenPath],
      dryEnv,
    );
    const dryText = dry.stdout;
    checkEqual('AUDIT dry-run 退出码', dry.exitCode, 0);
    check('AUDIT dry-run 标记', dryText.includes('"dry_run": true'));
    check('AUDIT dry-run 不访问远端', dryText.includes('"hindsight_configured": false'));
  } finally {
    await fake.stop();
  }
}

export async function runAuditCli(
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // 必须异步 spawn：父进程内的 FakeHindsight 需要事件循环继续响应子进程请求。
  const child = Bun.spawn({
    cmd: ['bun', 'scripts/verify-hindsight-writes.ts', ...args],
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function externalFailureChecks(root: string): Promise<void> {
  const fake = new FakeHindsight(`test_hindsight_failures_${crypto.randomUUID().replaceAll('-', '')}`);
  try {
    // 500：作业保持 pending，不标记 completed。
    const failed = await seedMemoryAdmission(join(root, 'fail-500.sqlite'));
    let clock = AT + 1_000;
    fake.behavior.retainFailures = 1;
    const adapter500 = hindsightAdapter(fake);
    const runtime500 = new MemoryRuntime(failed.env.d1, {
      adapter: adapter500,
      instanceId: failed.instanceId,
      capture: true,
      now: () => clock,
    });
    try {
      await runtime500.start();
      const tick = await runtime500.tick();
      check('MF10 500 作业被 requeued', tick.requeued >= 1, tick);
      checkEqual('MF10 500 不提前完成', (await jobStatusOf(failed.env)).status, 'pending');
      clock += 10_000;
      await runtime500.tick();
      checkEqual('MF10 500 重试后等待远端作业', (await jobStatusOf(failed.env)).status, 'unknown');
      const operation = fake.lastOperationId();
      check('MF10 远端 operation 存在', operation !== null);
      fake.setOperationStatus(operation!, 'completed');
      const reconciled = await runtime500.reconcile();
      checkEqual('MF10 对账完成 unknown', reconciled.completed, 1);
      checkEqual('MF10 对账后 completed', (await jobStatusOf(failed.env)).status, 'completed');
    } finally {
      await runtime500.stop();
      failed.env.db.close();
    }

    // 超时：显式 pending，不把 timeout 当失败或成功。
    const timed = await seedMemoryAdmission(join(root, 'fail-timeout.sqlite'));
    fake.behavior.retainDelayMs = 300;
    const timeoutAdapter = hindsightAdapter(fake, { requestTimeoutMs: 50 });
    const timeoutRuntime = new MemoryRuntime(timed.env.d1, {
      adapter: timeoutAdapter,
      instanceId: timed.instanceId,
      capture: true,
      now: () => AT + 1_000,
    });
    try {
      await timeoutRuntime.start();
      await timeoutRuntime.tick();
      checkEqual('MF10 超时保持 pending', (await jobStatusOf(timed.env)).status, 'pending');
      const timedOut = await jobSnapshotOf(timed.env);
      check(
        'MF10 超时保留可观测分类',
        timedOut.result_json?.includes('"reason":"timeout"') === true,
      );
      check(
        'MF10 超时不写 completed',
        timedOut.result_json?.includes('"status":"completed"') !== true,
      );
    } finally {
      fake.behavior.retainDelayMs = 0;
      await timeoutRuntime.stop();
      timed.env.db.close();
    }

    // 401：fail closed，不伪装成空库或成功。
    const denied = await seedMemoryAdmission(join(root, 'fail-401.sqlite'));
    const wrongKeyAdapter = new HindsightMemoryAdapter({
      baseUrl: fake.baseUrl,
      apiKey: 'wrong-key',
      requestTimeoutMs: 500,
      maxRetries: 0,
      retryBaseMs: 1,
      sleepImpl: async () => undefined,
    });
    const deniedRuntime = new MemoryRuntime(denied.env.d1, {
      adapter: wrongKeyAdapter,
      instanceId: denied.instanceId,
      capture: true,
      now: () => AT + 1_000,
    });
    try {
      await deniedRuntime.start();
      await deniedRuntime.tick();
      checkEqual('MF10 401 保持 pending', (await jobStatusOf(denied.env)).status, 'pending');
    } finally {
      await deniedRuntime.stop();
      denied.env.db.close();
    }

    // 取消：stop 中止在途请求，不能留下 completed 的假 ACK。
    const cancelled = await seedMemoryAdmission(join(root, 'fail-cancel.sqlite'));
    fake.behavior.retainDelayMs = 2_000;
    const cancelAdapter = hindsightAdapter(fake, { requestTimeoutMs: 5_000 });
    const cancelRuntime = new MemoryRuntime(cancelled.env.d1, {
      adapter: cancelAdapter,
      instanceId: cancelled.instanceId,
      capture: true,
      now: () => AT + 1_000,
    });
    try {
      await cancelRuntime.start();
      const ticking = cancelRuntime.tick();
      await fake.waitForRequest('POST', '/memories', 1, 3_000);
      const started = Date.now();
      await cancelRuntime.stop();
      const elapsed = Date.now() - started;
      await ticking;
      check('MF10 stop 及时中止在途请求', elapsed < 2_000, elapsed);
      checkEqual('MF10 取消后作业回到 pending', (await jobStatusOf(cancelled.env)).status, 'pending');
    } finally {
      fake.behavior.retainDelayMs = 0;
      cancelled.env.db.close();
    }
  } finally {
    await fake.stop();
  }
}
