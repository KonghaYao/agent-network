/**
 * MF10 集成、第二适配器与故障验收。
 *
 * 覆盖：
 * - LocalMemoryAdapter 六操作、能力声明与实际一致、准确文本/时间硬过滤/删除；
 * - 与 Hindsight（受控假服务）做同一契约不变量对照；
 * - MemoryIntegration 启动恢复、作业 drain、unknown 对账、定时 Langfuse、优雅关闭；
 * - 进程在本地提交后/外部响应前后退出，重启不丢意图、不重复 retain；
 * - 外部 500/超时/401/取消；本地事务失败不提前 ACK；
 * - 关闭采集仍执行撤回/遗忘屏障；
 * - MCP 能力目录与 UI 状态联动（enabled、engine、来源阶段）。
 *
 * 运行：bun run test:memory-integration
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureMemoryInstance } from '../src/memory/access';
import { LocalMemoryAdapter } from '../src/memory/adapters/local';
import { HindsightMemoryAdapter } from '../src/memory/adapters/hindsight';
import type {
  MemoryAdapter,
  MemoryAdapterJobRef,
  MemoryAdapterRetainItem,
  MemoryAdapterRemoveTarget,
  MemoryAdapterSearchPlan,
  RemoveRequest,
  RetainRequest,
} from '../src/memory/adapters/types';
import { memoryCapabilityCatalog, memoryEngineInfo } from '../src/memory/capability-catalog';
import { forgetMemory } from '../src/memory/governance';
import { MemoryIntegration } from '../src/memory/integration';
import { MemoryRuntime } from '../src/memory/runtime';
import { resolveLangfuseSourceConfig } from '../src/memory/sources/langfuse-config';
import { LangfuseSourceImporter } from '../src/memory/sources/langfuse-import';
import { LANGFUSE_SKIP_REASONS } from '../src/memory/sources/langfuse-mapping';
import type { LangfuseImportResult } from '../src/memory/sources/langfuse-import';
import {
  admitExposureReceipt,
  ensureSpaceForAgent,
  sourceMutationStatements,
} from '../src/memory/store';
import { registerRepresentation } from '../src/memory/store-objects';
import { sha256Hex } from '../src/storage/db';
import type { MemorySpaceRef } from '../src/memory/contracts';
import {
  check,
  checkEqual,
  checksPassed,
  callTool,
  connectClient,
  newRequestId,
  newToken,
  rawRpc,
  sleep,
  waitUntil,
} from './lib/harness';
import { MEMORY_INTEGRATION_AT, seedMemoryAdmission } from './lib/memory-admission-fixture';
import { FakeHindsight } from './lib/memory-hindsight-fake';
import { FakeLangfuse } from './lib/memory-langfuse-fake';
import {
  createMemoryEnv,
  experienceEntry,
  experienceKey,
  exposureReceipt,
  privateTarget,
  rawRepresentation,
  seedActor,
  seedManagement,
  seedRoom,
  spaceRef,
  unique,
} from './lib/memory-unit';
import { Q05Server } from './lib/q05-harness';

const AT = MEMORY_INTEGRATION_AT;
const HASH = 'a'.repeat(64);

function memorySpace(id: string): MemorySpaceRef {
  return { space_id: id, ownership_epoch: 1, backend_binding_epoch: 1 };
}

function item(
  representation: Awaited<ReturnType<typeof rawRepresentation>>,
  text: string,
  source: { source_id: string; source_revision: number } | null,
  originKind: 'experienced' | 'authored' | 'curated',
  eligibility: MemoryAdapterRetainItem['eligibility'],
): MemoryAdapterRetainItem {
  return {
    origin_kind: originKind,
    representation: { representation: representation.representation, text },
    source,
    eligibility,
  };
}

function experiencedEligibility(): MemoryAdapterRetainItem['eligibility'] {
  return {
    kind: 'experienced',
    evidence: 'host_reported_submitted',
    receipt_id: 'mrc_contract',
    proof_id: 'mpf_contract',
  };
}

function retainRequest(
  space: MemorySpaceRef,
  items: MemoryAdapterRetainItem[],
  operationKey: string,
  payloadHash = HASH,
): RetainRequest {
  return {
    space,
    operation_key: operationKey,
    payload_sha256: payloadHash,
    items,
    policy_version: 1,
    deadline_at: null,
  };
}

function searchPlan(overrides: Partial<MemoryAdapterSearchPlan> = {}): MemoryAdapterSearchPlan {
  return {
    query: null,
    hard_filters: {},
    ranking_hints: {},
    candidate_limit: 10,
    output_bytes: 64 * 1024,
    deadline_at: null,
    policy_version: 1,
    ...overrides,
  };
}

function removeRequest(
  space: MemorySpaceRef,
  targets: readonly MemoryAdapterRemoveTarget[],
  operationKey: string,
): RemoveRequest {
  return {
    space,
    operation_key: operationKey,
    payload_sha256: HASH,
    targets,
    policy_version: 1,
    deadline_at: null,
  };
}

async function jobStatusOf(
  env: { d1: D1Database },
  operation = 'retain',
): Promise<{ status: string; stage: string; provider_job_id: string | null }> {
  const row = await env.d1
    .prepare(
      `SELECT status, stage, provider_job_id FROM memory_jobs
        WHERE operation_type = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(operation)
    .first<{ status: string; stage: string; provider_job_id: string | null }>();
  if (!row) throw new Error(`memory job ${operation} missing`);
  return row;
}

/**
 * 两个真实不同的适配器必须对同一契约给出同一类结论：
 * 接受/idempotent/冲突 fenced/非法 hash 拒绝/未声明过滤 unsupported/删除确认。
 * 异步与同步写入、时间过滤能力允许不同，但必须与 capabilities 声明一致。
 */
async function runAdapterContract(input: {
  label: string;
  adapter: MemoryAdapter;
  space: MemorySpaceRef;
  visibleCount: () => number;
  markComplete: (jobRef: MemoryAdapterJobRef) => Promise<void> | void;
}): Promise<void> {
  const { label, adapter, space, visibleCount, markComplete } = input;
  const caps = adapter.capabilities();
  check(
    `${label} 六操作齐全`,
    ['capabilities', 'ensureSpace', 'retain', 'search', 'remove', 'jobStatus'].every(
      (name) => typeof (adapter as unknown as Record<string, unknown>)[name] === 'function',
    ),
  );
  const ensured = await adapter.ensureSpace({
    space,
    operation_key: `${label}:ensure`,
    payload_sha256: HASH,
    deadline_at: null,
  });
  checkEqual(`${label} ensureSpace ready`, ensured.status, 'ready');

  const source = { source_id: `src_contract_${label}`, source_revision: 1 };
  const text = `${label} exact contract text`;
  const representation = await rawRepresentation({
    representationId: `rep_contract_${label}`,
    sourceId: source.source_id,
    sourceRevision: 1,
    text,
  });
  const one = item(representation, text, source, 'experienced', experiencedEligibility());
  const request = retainRequest(space, [one], `${label}:retain`);
  const retained = await adapter.retain(request);
  checkEqual(`${label} retain accepted`, retained.status, 'accepted');
  check(`${label} retain 返回 JobRef`, retained.job_ref !== null);
  checkEqual(`${label} retain 后可见一条`, visibleCount(), 1);
  const replay = await adapter.retain(request);
  checkEqual(`${label} retain 同 key 重放 accepted`, replay.status, 'accepted');
  checkEqual(`${label} retain 重放不重复`, visibleCount(), 1);

  const conflictText = `${label} conflicting text`;
  const conflictRepresentation = await rawRepresentation({
    representationId: `rep_contract_${label}_conflict`,
    sourceId: source.source_id,
    sourceRevision: 1,
    text: conflictText,
  });
  const conflict = await adapter.retain(
    retainRequest(
      space,
      [item(conflictRepresentation, conflictText, source, 'experienced', experiencedEligibility())],
      `${label}:retain`,
      'b'.repeat(64),
    ),
  );
  checkEqual(`${label} 同 key 不同正文 status`, conflict.status, 'unsupported');
  checkEqual(`${label} 同 key 不同正文 reason`, conflict.reason, 'fenced');

  const brokenText = `${label} broken hash`;
  const broken = await rawRepresentation({
    representationId: `rep_contract_${label}_bad`,
    sourceId: source.source_id,
    sourceRevision: 1,
    text: brokenText,
  });
  broken.representation.text_sha256 = '0'.repeat(64);
  const invalid = await adapter.retain(
    retainRequest(
      space,
      [item(broken, brokenText, source, 'experienced', experiencedEligibility())],
      `${label}:bad-hash`,
    ),
  );
  checkEqual(`${label} 非法 hash status`, invalid.status, 'unsupported');
  checkEqual(`${label} 非法 hash reason`, invalid.reason, 'invalid_request');
  checkEqual(`${label} 非法请求不新增`, visibleCount(), 1);

  const search = await adapter.search({
    space,
    plan: searchPlan({ hard_filters: { source_ids: [source.source_id] } }),
  });
  checkEqual(`${label} search ready`, search.status, 'ready');
  checkEqual(
    `${label} search 返回准确 hash`,
    search.hits[0]?.representation.text_sha256,
    representation.representation.text_sha256,
  );
  const unsupportedFilter = await adapter.search({
    space,
    plan: searchPlan({ hard_filters: { source_kinds: ['message'] } }),
  });
  checkEqual(`${label} 未声明硬过滤 unsupported`, unsupportedFilter.status, 'unsupported');
  const timeFilter = await adapter.search({
    space,
    plan: searchPlan({ hard_filters: { time_from: AT + 10_000, time_to: AT + 20_000 } }),
  });
  if (caps.time_window === 'hard_filter') {
    checkEqual(`${label} 硬时间过滤返回空`, timeFilter.status, 'empty');
  } else {
    checkEqual(`${label} 时间过滤明确 unsupported`, timeFilter.status, 'unsupported');
  }

  if (retained.job_ref) {
    await markComplete(retained.job_ref);
    const status = await adapter.jobStatus({ space, job_ref: retained.job_ref });
    checkEqual(`${label} jobStatus completed`, status.state, 'completed');
    const crossEpoch = await adapter.jobStatus({
      space: { ...space, backend_binding_epoch: space.backend_binding_epoch + 1 },
      job_ref: retained.job_ref,
    });
    checkEqual(`${label} 跨代次 jobStatus unknown`, crossEpoch.state, 'unknown');
  }

  const target: MemoryAdapterRemoveTarget = {
    kind: 'representation',
    source,
    representation_id: representation.representation.representation_id,
    range: 'range' in representation.representation ? representation.representation.range : null,
  };
  const removed = await adapter.remove(removeRequest(space, [target], `${label}:remove`));
  checkEqual(`${label} remove accepted`, removed.status, 'accepted');
  checkEqual(`${label} remove 确认 purged`, removed.purge, 'purged');
  checkEqual(`${label} remove 后不可见`, visibleCount(), 0);
  const again = await adapter.remove(removeRequest(space, [target], `${label}:remove`));
  checkEqual(`${label} remove 重放 purged`, again.purge, 'purged');
  const partition = await adapter.remove(
    removeRequest(
      space,
      [{ kind: 'partition', partition_id: 'partition_contract', generation: 1 }],
      `${label}:partition`,
    ),
  );
  checkEqual(
    `${label} partition 粒度 unsupported`,
    partition.status,
    'unsupported_granularity',
  );
}

async function localAdapterChecks(root: string): Promise<void> {
  const path = join(root, 'local-adapter.sqlite');
  const adapter = new LocalMemoryAdapter({ path, now: () => AT });
  const space = memorySpace('msp_local_adapter');
  const caps = adapter.capabilities();
  checkEqual('local provider', caps.provider, 'local-sqlite');
  checkEqual('local time_window 硬过滤', caps.time_window, 'hard_filter');
  checkEqual('local source_completeness exact', caps.source_completeness, 'exact');
  checkEqual('local reflect 不声明', caps.reflect, false);
  checkEqual('local native_export 不声明', caps.native_export, false);
  checkEqual(
    'local 硬过滤只含实现项',
    caps.hard_filters.join(','),
    'origin_kind,source_id,time_range',
  );
  check('local capabilities 不含文件路径', !JSON.stringify(caps).includes(path));

  await adapter.ensureSpace({
    space,
    operation_key: 'local:ensure',
    payload_sha256: HASH,
    deadline_at: null,
  });
  const source = { source_id: 'src_local_adapter', source_revision: 1 };
  const text = 'LOCAL-EXACT release Friday 中文 🦋';
  const representation = await rawRepresentation({
    representationId: 'rep_local_adapter',
    sourceId: source.source_id,
    sourceRevision: 1,
    text,
  });
  const one = item(representation, text, source, 'experienced', experiencedEligibility());
  const retained = await adapter.retain(retainRequest(space, [one], 'local:retain'));
  checkEqual('local retain accepted', retained.status, 'accepted');
  checkEqual('local 同步 source_applied', retained.source_applied, true);
  checkEqual('local 同步 derived_ready', retained.derived_ready, true);
  check('local retain JobRef', retained.job_ref !== null);
  checkEqual('local 可见记录', adapter.inspect(space).records.visible, 1);
  const replay = await adapter.retain(retainRequest(space, [one], 'local:retain'));
  checkEqual('local 重放 accepted', replay.status, 'accepted');
  checkEqual('local 重放不新增记录', adapter.inspect(space).records.visible, 1);
  checkEqual('local 重放计数 attempt', adapter.inspect(space).operations.write_attempts, 2);

  const exact = await adapter.search({
    space,
    plan: searchPlan({ query: 'release FRIDAY' }),
  });
  checkEqual('local 子串检索 ready', exact.status, 'ready');
  checkEqual('local 检索保留准确字节', exact.hits[0]?.representation.text_bytes, representation.representation.text_bytes);
  const byOrigin = await adapter.search({
    space,
    plan: searchPlan({ hard_filters: { origin_kinds: ['authored'] } }),
  });
  checkEqual('local origin 硬过滤空', byOrigin.status, 'empty');
  const budget = await adapter.search({
    space,
    plan: searchPlan({ output_bytes: 4 }),
  });
  checkEqual('local 输出预算空', budget.status, 'empty');
  checkEqual('local 预算排除计数', budget.exclusions.find((entry) => entry.reason === 'budget')?.count, 1);
  const job = await adapter.jobStatus({ space, job_ref: retained.job_ref! });
  checkEqual('local jobStatus completed', job.state, 'completed');
  checkEqual('local jobStatus stage', job.stage, 'observation_ready');

  const target: MemoryAdapterRemoveTarget = {
    kind: 'source_revision',
    source,
  };
  const removed = await adapter.remove(removeRequest(space, [target], 'local:remove'));
  checkEqual('local remove purged', removed.purge, 'purged');
  checkEqual('local remove 清空正文', adapter.inspect(space).records.visible, 0);
  check('local remove 保留审计行', adapter.inspect(space).records.revisions >= 1);
  const resurrect = await adapter.retain(retainRequest(space, [one], 'local:retain-again'));
  checkEqual('local 删除后重试仍 accepted', resurrect.status, 'accepted');
  checkEqual('local 删除后不复活', adapter.inspect(space).records.visible, 0);

  await runAdapterContract({
    label: 'local',
    adapter,
    space: memorySpace('msp_local_contract'),
    visibleCount: () => adapter.inspect(memorySpace('msp_local_contract')).records.visible,
    markComplete: () => undefined,
  });
  adapter.close();
}

async function hindsightContractChecks(root: string): Promise<void> {
  const token = `test_hindsight_mf10_${crypto.randomUUID().replaceAll('-', '')}`;
  const fake = new FakeHindsight(token);
  const adapter = new HindsightMemoryAdapter({
    baseUrl: fake.baseUrl,
    apiKey: token,
    requestTimeoutMs: 1_000,
    maxRetries: 1,
    retryBaseMs: 1,
    sleepImpl: async () => undefined,
  });
  const space = memorySpace('msp_hindsight_contract');
  try {
    await runAdapterContract({
      label: 'hindsight',
      adapter,
      space,
      visibleCount: () => fake.visibleDocumentCount(),
      markComplete: (jobRef) => fake.setOperationStatus(jobRef.provider_job_id, 'completed'),
    });
    check('hindsight 契约结果不含凭据', !JSON.stringify(adapter.capabilities()).includes(token));
  } finally {
    await fake.stop();
  }
  void root;
}

async function runtimeIntegrationChecks(root: string): Promise<void> {
  const fixture = await seedMemoryAdmission(join(root, 'integration.sqlite'));
  const adapter = new LocalMemoryAdapter({ path: join(root, 'integration-local.sqlite'), now: () => AT + 1000 });
  const runtime = new MemoryRuntime(fixture.env.d1, {
    adapter,
    instanceId: fixture.instanceId,
    capture: true,
    now: () => AT + 1000,
  });
  const integration = new MemoryIntegration({
    runtime,
    tickIntervalMs: 60_000,
    reconcileIntervalMs: 60_000,
    importIntervalMs: 60_000,
    now: () => AT + 1000,
  });
  try {
    await integration.start();
    await integration.runOnce();
    const job = await jobStatusOf(fixture.env);
    checkEqual('MF10 启动恢复后 retain completed', job.status, 'completed');
    checkEqual('MF10 本地后端写入一条', adapter.inspect(fixture.space).records.visible, 1);
    const health = await runtime.health();
    checkEqual('MF10 无待处理 retain', health.retain_pending, 0);
    check('MF10 状态记录 tick', integration.status().last_tick_at !== null);
    check('MF10 状态记录对账', integration.status().last_reconcile_at !== null);
  } finally {
    await integration.stop();
    adapter.close();
    fixture.env.db.close();
  }
}

async function crashChecks(root: string): Promise<void> {
  const modes = ['before_external', 'after_external', 'after_external_ref'] as const;
  for (const mode of modes) {
    const dbPath = join(root, `crash-${mode}.sqlite`);
    const localPath = join(root, `crash-${mode}-local.sqlite`);
    const child = Bun.spawnSync({
      cmd: ['bun', 'scripts/lib/memory-integration-child.ts', dbPath, localPath, mode],
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    checkEqual(`MF10 ${mode} 子进程退出码`, child.exitCode, 0);
    const probe = new LocalMemoryAdapter({ path: localPath, now: () => AT + 120_000 });
    const before = probe.inspect({
      space_id: (await firstSpaceId(dbPath)),
      ownership_epoch: 1,
      backend_binding_epoch: 1,
    });
    if (mode === 'before_external') {
      checkEqual(`MF10 ${mode} 外部尚无记录`, before.records.visible, 0);
    } else {
      checkEqual(`MF10 ${mode} 外部已写入一条`, before.records.visible, 1);
    }
    probe.close();

    const env = createMemoryEnv(dbPath);
    const adapter = new LocalMemoryAdapter({ path: localPath, now: () => AT + 120_000 });
    const space = {
      space_id: await firstSpaceId(dbPath),
      ownership_epoch: 1,
      backend_binding_epoch: 1,
    };
    const runtime = new MemoryRuntime(env.d1, {
      adapter,
      instanceId: await firstInstanceId(dbPath),
      capture: true,
      now: () => AT + 120_000,
    });
    const integration = new MemoryIntegration({
      runtime,
      tickIntervalMs: 60_000,
      reconcileIntervalMs: 60_000,
      importIntervalMs: 60_000,
      now: () => AT + 120_000,
    });
    try {
      await runtime.start();
      const recovered = await jobStatusOf(env);
      if (mode === 'after_external_ref') {
        checkEqual(`MF10 ${mode} 重启标 unknown`, recovered.status, 'unknown');
      } else {
        checkEqual(`MF10 ${mode} 重启回 pending`, recovered.status, 'pending');
      }
      await integration.start();
      const run = await integration.runOnce();
      const job = await jobStatusOf(env);
      checkEqual(`MF10 ${mode} 重启后完成`, job.status, 'completed');
      const inspected = adapter.inspect(space);
      checkEqual(`MF10 ${mode} 外部仍只有一条`, inspected.records.visible, 1);
      if (mode === 'after_external_ref') {
        checkEqual(`MF10 ${mode} 对账完成一条`, run.reconcile?.completed, 1);
        checkEqual(`MF10 ${mode} 不重复 retain`, inspected.operations.write_attempts, 1);
      } else if (mode === 'after_external') {
        checkEqual(`MF10 ${mode} 重试命中幂等`, inspected.operations.write_attempts, 2);
      } else {
        checkEqual(`MF10 ${mode} 首次写入`, inspected.operations.write_attempts, 1);
      }
      check('MF10 恢复后无重复记录', inspected.records.visible === 1);
    } finally {
      await integration.stop();
      adapter.close();
      env.db.close();
    }
  }
}

async function firstSpaceId(dbPath: string): Promise<string> {
  const env = createMemoryEnv(dbPath);
  const row = await env.d1
    .prepare('SELECT space_id FROM memory_spaces ORDER BY created_at, space_id LIMIT 1')
    .first<{ space_id: string }>();
  env.db.close();
  if (!row) throw new Error('memory space missing');
  return row.space_id;
}

async function firstInstanceId(dbPath: string): Promise<string> {
  const env = createMemoryEnv(dbPath);
  const row = await env.d1
    .prepare('SELECT instance_id FROM memory_instances ORDER BY created_at, instance_id LIMIT 1')
    .first<{ instance_id: string }>();
  env.db.close();
  if (!row) throw new Error('memory instance missing');
  return row.instance_id;
}

function hindsightAdapter(
  fake: FakeHindsight,
  overrides: Partial<ConstructorParameters<typeof HindsightMemoryAdapter>[0]> = {},
): HindsightMemoryAdapter {
  return new HindsightMemoryAdapter({
    baseUrl: fake.baseUrl,
    apiKey: fake.token,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryBaseMs: 1,
    sleepImpl: async () => undefined,
    ...(overrides as Record<string, unknown>),
  });
}

async function externalFailureChecks(root: string): Promise<void> {
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

async function seedSpaceOnly(dbPath: string): Promise<{
  env: ReturnType<typeof createMemoryEnv>;
  instanceId: string;
  agent: string;
  human: string;
  room: string;
  space: MemorySpaceRef;
  sourceId: string;
  text: string;
  representation: Awaited<ReturnType<typeof rawRepresentation>>;
}> {
  const env = createMemoryEnv(dbPath);
  const instanceId = `mni_tx_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const human = unique('usr_tx');
  const agent = unique('agt_tx');
  const room = unique('rm_tx');
  await ensureMemoryInstance(env.d1, { configuredId: instanceId, now: AT });
  seedActor(env, { actorId: human, kind: 'human' });
  seedActor(env, { actorId: agent, kind: 'agent' });
  seedManagement(env, { agentId: agent, managerId: human });
  seedRoom(env, {
    roomId: room,
    kind: 'direct',
    ownerId: human,
    members: [
      { actorId: agent, memberGeneration: 1 },
      { actorId: human, memberGeneration: 1 },
    ],
    policyRevision: 0,
  });
  const space = await ensureSpaceForAgent(env.d1, { instanceId, agentId: agent, now: AT });
  const sourceId = unique('msrc_tx');
  const text = `TX-FAIL-${sourceId}`;
  const hash = await sha256Hex(text);
  await env.d1.batch(
    sourceMutationStatements(env.d1, {
      instanceId,
      sourceId,
      sourceKey: `msg:${sourceId}`,
      sourceKind: 'message',
      businessRefKind: 'message',
      businessRefJson: JSON.stringify({ message_id: sourceId }),
      originRoomId: room,
      originMemberGeneration: 1,
      originPolicyRevision: 0,
      originJoinedSeq: 0,
      originJoinedAt: 0,
      originArchiveHeadSeq: null,
      originSeq: 1,
      originCreatedAt: AT + 1,
      authorActorId: human,
      revision: 1,
      contentText: text,
      contentSha256: hash,
      contentBytes: new TextEncoder().encode(text).length,
      now: AT,
    }),
  );
  const representation = await rawRepresentation({
    sourceId,
    sourceRevision: 1,
    text,
  });
  await registerRepresentation(env.d1, { instanceId, exact: representation, now: AT + 1 });
  return { env, instanceId, agent, human, room, space, sourceId, text, representation };
}

async function expectRejected(label: string, operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    check(label, false);
  } catch {
    check(label, true);
  }
}

async function count(env: ReturnType<typeof createMemoryEnv>, table: string): Promise<number> {
  const row = await env.d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function transactionFailureChecks(root: string): Promise<void> {
  const seeded = await seedSpaceOnly(join(root, 'tx-failure.sqlite'));
  const adapter = new LocalMemoryAdapter({ path: join(root, 'tx-failure-local.sqlite'), now: () => AT + 100 });
  const runtime = new MemoryRuntime(seeded.env.d1, {
    adapter,
    instanceId: seeded.instanceId,
    capture: true,
    now: () => AT + 100,
  });
  try {
    let failBatch = true;
    const failingD1 = new Proxy(seeded.env.d1, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (failBatch) {
              failBatch = false;
              throw new Error('simulated local transaction failure');
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const receipt = exposureReceipt({
      receiptId: unique('mrc_tx'),
      space: seeded.space,
      agentId: seeded.agent,
      targetScope: privateTarget(),
      originScopes: [
        {
          room_id: seeded.room,
          member_generation: 1,
          policy_revision: 0,
          joined_seq: 0,
          joined_at: 0,
          archive_head_seq: null,
        },
      ],
      invocationId: unique('inv_tx'),
    });
    const experience = experienceEntry({
      experienceId: unique('mexp_tx'),
      key: experienceKey({
        space: seeded.space,
        agentId: seeded.agent,
        originRoomId: seeded.room,
        originMemberGeneration: 1,
        sourceId: seeded.sourceId,
        sourceRevision: 1,
        representation: seeded.representation,
      }),
      originRoomId: seeded.room,
    });
    const admission = {
      instanceId: seeded.instanceId,
      agentId: seeded.agent,
      space: seeded.space,
      receipt,
      representations: [seeded.representation],
      experiences: [experience],
      retain: [
        {
          retainId: unique('mrt_tx'),
          experienceId: experience.experienceId,
          representationId: seeded.representation.representation.representation_id,
          sourceId: seeded.sourceId,
          sourceRevision: 1,
          originKind: 'experienced' as const,
          evidence: 'host_reported_submitted' as const,
        },
      ],
      minimumEvidence: 'host_reported_submitted' as const,
      now: AT + 2,
    };
    const before = {
      receipts: await count(seeded.env, 'memory_receipts'),
      experiences: await count(seeded.env, 'memory_experiences'),
      intents: await count(seeded.env, 'memory_retain_intents'),
      jobs: await count(seeded.env, 'memory_jobs'),
    };
    await expectRejected(
      'MF10 本地事务失败拒绝回执',
      admitExposureReceipt(failingD1, admission),
    );
    checkEqual('MF10 失败不加回执', await count(seeded.env, 'memory_receipts'), before.receipts);
    checkEqual('MF10 失败不加经历', await count(seeded.env, 'memory_experiences'), before.experiences);
    checkEqual('MF10 失败不加 retain 意图', await count(seeded.env, 'memory_retain_intents'), before.intents);
    checkEqual('MF10 失败不加作业', await count(seeded.env, 'memory_jobs'), before.jobs);
    await runtime.start();
    const emptyTick = await runtime.tick();
    checkEqual('MF10 失败事务不派发外部调用', emptyTick.claimed, 0);
    checkEqual('MF10 失败事务适配器零写入', adapter.inspect(seeded.space).operations.total, 0);

    // SQLite batch 中途失败必须整体回滚业务消息与共享来源。
    const messageId = unique('msg_tx');
    const failingStatement = {
      executeSync() {
        throw new Error('simulated statement failure');
      },
    } as unknown as D1PreparedStatement;
    await expectRejected(
      'MF10 业务 batch 中途失败抛出',
      seeded.env.d1.batch([
        seeded.env.d1
          .prepare(
            `INSERT INTO messages
               (message_id, room_id, sender_id, client_message_id, created_seq, body,
                body_bytes, preview, reply_to, root_id, hop, root_invocations_used, created_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
          )
          .bind(
            messageId,
            seeded.room,
            seeded.human,
            unique('client_tx'),
            seeded.text,
            seeded.text.length,
            seeded.text.slice(0, 8),
            AT,
          ),
        ...sourceMutationStatements(seeded.env.d1, {
          instanceId: seeded.instanceId,
          sourceId: unique('msrc_tx_rollback'),
          sourceKey: `msg:${messageId}`,
          sourceKind: 'message',
          businessRefKind: 'message',
          businessRefJson: JSON.stringify({ message_id: messageId }),
          originRoomId: seeded.room,
          originMemberGeneration: 1,
          originPolicyRevision: 0,
          originJoinedSeq: 0,
          originJoinedAt: 0,
          originArchiveHeadSeq: null,
          originSeq: 1,
          originCreatedAt: AT + 1,
          authorActorId: seeded.human,
          revision: 1,
          contentText: seeded.text,
          contentSha256: await sha256Hex(seeded.text),
          contentBytes: new TextEncoder().encode(seeded.text).length,
          now: AT,
        }),
        failingStatement,
      ]),
    );
    checkEqual(
      'MF10 batch 回滚业务消息',
      (
        await seeded.env.d1
          .prepare('SELECT COUNT(*) AS n FROM messages WHERE message_id = ?')
          .bind(messageId)
          .first<{ n: number }>()
      )?.n,
      0,
    );

    const admitted = await admitExposureReceipt(seeded.env.d1, admission);
    checkEqual('MF10 重试本地事务 applied', admitted.disposition.disposition, 'applied');
    await runtime.tick();
    checkEqual('MF10 重试后外部写入一次', adapter.inspect(seeded.space).records.visible, 1);
  } finally {
    await runtime.stop();
    adapter.close();
    seeded.env.db.close();
  }
}

async function captureDisabledChecks(root: string): Promise<void> {
  const fixture = await seedMemoryAdmission(join(root, 'capture-off.sqlite'));
  const adapter = new LocalMemoryAdapter({ path: join(root, 'capture-off-local.sqlite'), now: () => AT + 100 });
  await adapter.ensureSpace({
    space: fixture.space,
    operation_key: 'capture-off:ensure',
    payload_sha256: HASH,
    deadline_at: null,
  });
  const forgetting = await forgetMemory(fixture.env.d1, {
    instanceId: fixture.instanceId,
    agentId: fixture.agent,
    space: fixture.space,
    request_id: unique('forget'),
    target: { kind: 'source', source_id: fixture.sourceId, source_revision: 1 },
    now: AT + 10,
  });
  check('MF10 遗忘建立 remove 作业', forgetting.operation_id !== null);

  const runtime = new MemoryRuntime(fixture.env.d1, {
    adapter,
    instanceId: fixture.instanceId,
    capture: false,
    now: () => AT + 100,
  });
  let importerCalls = 0;
  const disabledResult: LangfuseImportResult = {
    status: 'disabled',
    reason: 'capture_disabled',
    from: null,
    to: AT,
    fetched: 0,
    imported: 0,
    duplicates: 0,
    conflicts: 0,
    excluded: 0,
    errors: 0,
    skipped: Object.fromEntries(
      LANGFUSE_SKIP_REASONS.map((reason) => [reason, 0]),
    ) as LangfuseImportResult['skipped'],
    watermarks: {},
  };
  const integration = new MemoryIntegration({
    runtime,
    langfuse: {
      importOnce: async () => {
        importerCalls += 1;
        return disabledResult;
      },
    },
    tickIntervalMs: 60_000,
    reconcileIntervalMs: 60_000,
    importIntervalMs: 1,
    now: () => AT + 100,
  });
  try {
    await integration.start();
    await integration.runOnce({ import: true });
    checkEqual('MF10 capture 关闭仍执行 remove', (await jobStatusOf(fixture.env, 'remove')).status, 'completed');
    checkEqual('MF10 capture 关闭 suppress retain', (await jobStatusOf(fixture.env, 'retain')).status, 'cancelled');
    const intent = await fixture.env.d1
      .prepare('SELECT status FROM memory_retain_intents ORDER BY created_at DESC LIMIT 1')
      .first<{ status: string }>();
    checkEqual('MF10 retain 意图 suppressed', intent?.status, 'suppressed');
    checkEqual('MF10 capture 关闭不拉取 Langfuse', importerCalls, 0);
    checkEqual('MF10 remove 后不可见', adapter.inspect(fixture.space).records.visible, 0);
  } finally {
    await integration.stop();
    adapter.close();
    fixture.env.db.close();
  }
}

async function langfuseChecks(root: string): Promise<void> {
  const fixture = await seedMemoryAdmission(join(root, 'langfuse.sqlite'));
  const fake = new FakeLangfuse('pk-mf10-test', 'sk-mf10-test');
  fake.addObservation({
    id: 'obs-mf10',
    traceId: 'trace-mf10',
    projectId: 'proj-mf10',
    type: 'GENERATION',
    name: 'user input',
    startTime: new Date(AT + 1_000).toISOString(),
    input: `LANGFUSE-MF10-${crypto.randomUUID()}`,
  });
  const config = resolveLangfuseSourceConfig({
    host: fake.baseUrl,
    publicKey: fake.publicKey,
    secretKey: fake.secretKey,
    bindings: [
      {
        binding_id: 'lfb_mf10',
        project_id: 'proj-mf10',
        agent_actor_id: fixture.agent,
        origin: { room_id: fixture.room },
        author_actor_id: fixture.agent,
        observations: {
          'user input': { class: 'original_input', field: 'input' },
        },
      },
    ],
    requestTimeoutMs: 500,
    maxRetries: 0,
    retryBaseMs: 1,
    pageSize: 100,
    maxPages: 5,
    initialFrom: AT,
    now: () => AT + 5_000,
  });
  if (!config) throw new Error('langfuse config unexpectedly disabled');
  const importer = new LangfuseSourceImporter({
    db: fixture.env.d1,
    instanceId: fixture.instanceId,
    config,
  });
  const adapter = new LocalMemoryAdapter({ path: join(root, 'langfuse-local.sqlite'), now: () => AT + 100 });
  const runtime = new MemoryRuntime(fixture.env.d1, {
    adapter,
    instanceId: fixture.instanceId,
    capture: true,
    now: () => AT + 5_000,
  });
  const integration = new MemoryIntegration({
    runtime,
    langfuse: importer,
    tickIntervalMs: 60_000,
    reconcileIntervalMs: 60_000,
    importIntervalMs: 60_000,
    now: () => AT + 5_000,
  });
  try {
    await integration.start();
    await waitUntil(
      'MF10 初始 tick',
      () => integration.status().last_tick_at !== null && !integration.status().running,
      2_000,
      10,
    );
    const run = await integration.runOnce({ import: true });
    checkEqual('MF10 Langfuse 导入一条', run.langfuse?.imported, 1);
    checkEqual('MF10 Langfuse 状态 ready', integration.status().langfuse.last_status, 'ready');
    checkEqual('MF10 Langfuse 上次导入数', integration.status().langfuse.last_imported, 1);
    const sources = await count(fixture.env, 'memory_sources');
    check('MF10 Langfuse 来源已入库', sources >= 2, sources);
    const watermark = await fixture.env.d1
      .prepare("SELECT COUNT(*) AS n FROM memory_cursors WHERE cursor_kind LIKE 'langfuse_import:%'")
      .first<{ n: number }>();
    check('MF10 Langfuse 水位已推进', Number(watermark?.n ?? 0) >= 1);
    check('MF10 状态不泄露 key', !JSON.stringify(integration.status()).includes('sk-mf10-test'));
  } finally {
    await integration.stop();
    adapter.close();
    await fake.stop();
  }
}

async function schedulerChecks(root: string): Promise<void> {
  const fixture = await seedMemoryAdmission(join(root, 'scheduler.sqlite'));
  const adapter = new LocalMemoryAdapter({ path: join(root, 'scheduler-local.sqlite'), now: () => Date.now() });
  const runtime = new MemoryRuntime(fixture.env.d1, {
    adapter,
    instanceId: fixture.instanceId,
    capture: true,
  });
  const skipped: LangfuseImportResult = {
    status: 'disabled',
    reason: 'test',
    from: null,
    to: Date.now(),
    fetched: 0,
    imported: 0,
    duplicates: 0,
    conflicts: 0,
    excluded: 0,
    errors: 0,
    skipped: Object.fromEntries(
      LANGFUSE_SKIP_REASONS.map((reason) => [reason, 0]),
    ) as LangfuseImportResult['skipped'],
    watermarks: {},
  };
  let calls = 0;
  const integration = new MemoryIntegration({
    runtime,
    langfuse: {
      importOnce: async () => {
        calls += 1;
        return skipped;
      },
    },
    tickIntervalMs: 10,
    reconcileIntervalMs: 60_000,
    importIntervalMs: 1,
  });
  try {
    await integration.start();
    await waitUntil('MF10 定时 importer 调用', () => calls >= 2, 3_000, 10);
    const seen = calls;
    await integration.stop();
    await sleep(80);
    checkEqual('MF10 stop 后停止定时拉取', calls, seen);
    checkEqual('MF10 stop 后状态 stopped', integration.started, false);
  } finally {
    await integration.stop();
    adapter.close();
    fixture.env.db.close();
  }

  const cancelFixture = await seedMemoryAdmission(join(root, 'scheduler-cancel.sqlite'));
  const cancelAdapter = new LocalMemoryAdapter({
    path: join(root, 'scheduler-cancel-local.sqlite'),
    now: () => Date.now(),
  });
  const cancelRuntime = new MemoryRuntime(cancelFixture.env.d1, {
    adapter: cancelAdapter,
    instanceId: cancelFixture.instanceId,
    capture: true,
  });
  let aborted = false;
  let markCalled: (() => void) | null = null;
  const called = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  const hanging = {
    importOnce: ({ signal }: { signal: AbortSignal }) =>
      new Promise<LangfuseImportResult>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve(skipped);
          },
          { once: true },
        );
        markCalled?.();
      }),
  };
  const cancelIntegration = new MemoryIntegration({
    runtime: cancelRuntime,
    langfuse: hanging,
    tickIntervalMs: 10,
    reconcileIntervalMs: 60_000,
    importIntervalMs: 1,
  });
  try {
    await cancelIntegration.start();
    await called;
    await cancelIntegration.stop();
    check('MF10 stop 中止在途 importer', aborted);
  } finally {
    await cancelIntegration.stop();
    cancelAdapter.close();
    cancelFixture.env.db.close();
  }
}

function catalogChecks(): void {
  const local = new LocalMemoryAdapter({ path: ':memory:' });
  const localEngine = memoryEngineInfo(local, 'ready');
  const localCatalog = memoryCapabilityCatalog({
    enabled: true,
    capture: true,
    policy: { trust_level: 'tool_only' },
    tools: ['network_memory_recall', 'network_memory_status'],
    engine: localEngine,
  });
  checkEqual('catalog local engine ready', localCatalog.engine_status, 'ready');
  check('catalog local 支持显式召回', localCatalog.supported.includes('explicit_lookup'));
  check('catalog local 支持硬时间过滤', localCatalog.supported.includes('hard_time_filter'));
  check('catalog local 不支持 native reflect', localCatalog.unsupported.includes('native_reflect'));
  check('catalog local 不支持 native export', localCatalog.unsupported.includes('native_export'));
  checkEqual(
    'catalog tools 排序',
    localCatalog.tools.join(','),
    'network_memory_recall,network_memory_status',
  );
  const weak = memoryCapabilityCatalog({
    enabled: true,
    capture: true,
    policy: { trust_level: 'tool_only' },
    tools: [],
    engine: { ...localEngine, status: 'unsupported' },
  });
  checkEqual('catalog 弱引擎状态', weak.engine_status, 'unsupported');
  check('catalog 弱引擎不声明显式召回', !weak.supported.includes('explicit_lookup'));
  check('catalog 弱引擎明确 engine_recall 不支持', weak.unsupported.includes('engine_recall'));
  checkEqual('catalog 弱引擎 reason', weak.reason, 'engine_unsupported');
  const disabled = memoryCapabilityCatalog({
    enabled: false,
    capture: false,
    policy: { trust_level: 'tool_only' },
    tools: [],
    engine: localEngine,
  });
  checkEqual('catalog disabled 状态', disabled.engine_status, 'unavailable');
  checkEqual('catalog disabled 支持为空', disabled.supported.length, 0);
  check('catalog disabled unsupported=all', disabled.unsupported.includes('all'));
  checkEqual('catalog disabled reason', disabled.reason, 'memory_disabled');
  local.close();
}

interface MemoryMeView {
  service: { memory: { enabled: boolean; engine_status: string; supported: string[]; unsupported: string[]; tools: string[] } };
}

interface MemoryStatusView {
  enabled: boolean;
  engine_status: string;
  capture: boolean;
  sources: { langfuse: { configured: boolean; status: string } };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function mcpServerChecks(): Promise<void> {
  const keys = [
    'MEMORY_ENABLED',
    'MEMORY_ADAPTER',
    'MEMORY_LOCAL_PATH',
    'MEMORY_CAPTURE',
    'MEMORY_INSTANCE_ID',
    'LANGFUSE_ENABLED',
    'LANGFUSE_HOST',
    'LANGFUSE_PUBLIC_KEY',
    'LANGFUSE_SECRET_KEY',
    'LANGFUSE_BINDINGS_JSON',
    'LANGFUSE_INITIAL_FROM',
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const langfuseFake = new FakeLangfuse('pk-mf10-server', 'sk-mf10-server');
  let enabledServer: Q05Server | null = null;
  let disabledServer: Q05Server | null = null;
  try {
    for (const key of keys) delete process.env[key];
    process.env.MEMORY_ENABLED = '1';
    process.env.MEMORY_ADAPTER = 'local';
    process.env.LANGFUSE_ENABLED = '1';
    process.env.LANGFUSE_HOST = langfuseFake.baseUrl;
    process.env.LANGFUSE_PUBLIC_KEY = langfuseFake.publicKey;
    process.env.LANGFUSE_SECRET_KEY = langfuseFake.secretKey;
    process.env.LANGFUSE_BINDINGS_JSON = JSON.stringify([
      {
        binding_id: 'lfb_mf10_server',
        project_id: 'proj-mf10-server',
        agent_actor_id: 'agt_mf10_server_binding',
        origin: { room_id: 'rm_mf10_server_binding' },
        observations: { 'user input': { class: 'original_input', field: 'input' } },
      },
    ]);
    process.env.LANGFUSE_INITIAL_FROM = String(Date.now());
    enabledServer = await Q05Server.start();
    const token = newToken();
    const connection = await connectClient(token);
    try {
      await callTool(connection.client, 'network_register', {
        request_id: newRequestId('reg'),
        kind: 'agent',
        name: 'MF10 local agent',
        agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
      });
      const me = await callTool<MemoryMeView>(connection.client, 'network_me', {});
      checkEqual('MF10 MCP memory enabled', me.service.memory.enabled, true);
      checkEqual('MF10 MCP engine ready', me.service.memory.engine_status, 'ready');
      check('MF10 MCP 能力支持显式召回', me.service.memory.supported.includes('explicit_lookup'));
      check('MF10 MCP 能力声明硬时间过滤', me.service.memory.supported.includes('hard_time_filter'));
      check('MF10 MCP 明确不支持自动注入', me.service.memory.unsupported.includes('auto_injection'));
      const listed = (await rawRpc('tools/list')).body.result as {
        tools: Array<{ name: string }>;
      };
      const liveMemoryTools = listed.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('network_memory_'))
        .sort();
      checkEqual('MF10 MCP 工具目录一致', me.service.memory.tools.join(','), liveMemoryTools.join(','));
      const status = await callTool<MemoryStatusView>(connection.client, 'network_memory_status', {});
      checkEqual('MF10 状态 enabled', status.enabled, true);
      checkEqual('MF10 状态 engine ready', status.engine_status, 'ready');
      checkEqual('MF10 状态 capture', status.capture, true);
      checkEqual('MF10 状态 Langfuse 已配置', status.sources.langfuse.configured, true);
      checkEqual('MF10 状态 Langfuse 等待首轮', status.sources.langfuse.status, 'pending');
      check(
        'MF10 Langfuse 状态不含 key',
        !JSON.stringify(status).includes(langfuseFake.secretKey),
      );
      const recall = await callTool<{ status: string }>(connection.client, 'network_memory_recall', {
        request_id: newRequestId('recall'),
        mode: 'lookup',
        dispatch: 'explicit',
        query: 'mf10-local',
        budget: { candidate_limit: 5, output_bytes: 4096 },
      });
      check(
        'MF10 local 召回不是 unavailable/unsupported',
        recall.status !== 'unavailable' && recall.status !== 'unsupported' && recall.status !== 'disabled',
        recall.status,
      );
    } finally {
      await connection.close();
    }
    await enabledServer.destroy();
    enabledServer = null;

    delete process.env.MEMORY_ENABLED;
    delete process.env.MEMORY_ADAPTER;
    disabledServer = await Q05Server.start();
    const disabledToken = newToken();
    const disabledConnection = await connectClient(disabledToken);
    try {
      await callTool(disabledConnection.client, 'network_register', {
        request_id: newRequestId('reg'),
        kind: 'agent',
        name: 'MF10 disabled agent',
        agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
      });
      const me = await callTool<MemoryMeView>(disabledConnection.client, 'network_me', {});
      checkEqual('MF10 部署关闭 catalog enabled=false', me.service.memory.enabled, false);
      checkEqual('MF10 部署关闭 engine_status', me.service.memory.engine_status, 'unavailable');
      check('MF10 部署关闭 supported 为空', me.service.memory.supported.length === 0);
      check('MF10 部署关闭 unsupported=all', me.service.memory.unsupported.includes('all'));
      const status = await callTool<MemoryStatusView>(
        disabledConnection.client,
        'network_memory_status',
        {},
      );
      checkEqual('MF10 部署关闭状态 enabled=false', status.enabled, false);
      checkEqual('MF10 部署关闭状态 engine', status.engine_status, 'unavailable');
    } finally {
      await disabledConnection.close();
    }
  } finally {
    await enabledServer?.destroy().catch(() => undefined);
    await disabledServer?.destroy().catch(() => undefined);
    await langfuseFake.stop().catch(() => undefined);
    for (const key of keys) restoreEnv(key, saved.get(key));
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'memory-mf10-'));
  try {
    await localAdapterChecks(root);
    await hindsightContractChecks(root);
    await runtimeIntegrationChecks(root);
    await crashChecks(root);
    await externalFailureChecks(root);
    await transactionFailureChecks(root);
    await captureDisabledChecks(root);
    await langfuseChecks(root);
    await schedulerChecks(root);
    catalogChecks();
    await mcpServerChecks();
    console.log(`memory integration checks passed (${checksPassed()} assertions)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
