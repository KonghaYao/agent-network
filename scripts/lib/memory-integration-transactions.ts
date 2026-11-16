/**
 * MF10 本地事务失败、采集关闭、持久重试与完成写回失败检查。
 *
 * 从 verify-memory-integration.ts 原样搬出，断言强度不变。
 */
import { join } from 'node:path';

import { ensureMemoryInstance } from '../../src/memory/access';
import { LocalMemoryAdapter } from '../../src/memory/adapters/local';
import type { RetainRequest } from '../../src/memory/adapters/types';
import { forgetMemory } from '../../src/memory/governance';
import { MemoryIntegration } from '../../src/memory/integration';
import { MemoryRuntime } from '../../src/memory/runtime';
import type { MemoryJobEvent } from '../../src/memory/runtime';
import type { MemorySpaceRef } from '../../src/memory/contracts';
import {
  admitExposureReceipt,
  ensureSpaceForAgent,
  sourceMutationStatements,
} from '../../src/memory/store';
import { registerRepresentation } from '../../src/memory/store-objects';
import { sha256Hex } from '../../src/storage/db';
import { check, checkEqual, sleep } from './harness';
import { seedMemoryAdmission } from './memory-admission-fixture';
import { FakeHindsight } from './memory-hindsight-fake';
import {
  createMemoryEnv,
  exposureReceipt,
  experienceEntry,
  experienceKey,
  privateTarget,
  rawRepresentation,
  seedActor,
  seedManagement,
  seedRoom,
  unique,
} from './memory-unit';
import {
  AT,
  HASH,
  count,
  failCompleteWriteback,
  hindsightAdapter,
  jobSnapshotOf,
  jobStatusOf,
} from './memory-integration-support';

export async function completeWritebackChecks(root: string): Promise<void> {
  // tick 的立即完成分支：写回未生效时不能计数或发完成事件。
  {
    const fixture = await seedMemoryAdmission(join(root, 'writeback-tick.sqlite'));
    const adapter = new LocalMemoryAdapter({
      path: join(root, 'writeback-tick-local.sqlite'),
      now: () => AT + 1_000,
    });
    const events: MemoryJobEvent[] = [];
    const errors: unknown[] = [];
    const runtime = new MemoryRuntime(failCompleteWriteback(fixture.env.d1), {
      adapter,
      instanceId: fixture.instanceId,
      capture: true,
      now: () => AT + 1_000,
      onJobEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });
    try {
      await runtime.start();
      const tick = await runtime.tick();
      checkEqual('MF10 完成写回失败不计 completed', tick.completed, 0);
      checkEqual('MF10 完成写回失败计入 unknown', tick.unknown, 1);
      check(
        'MF10 完成写回失败不发完成事件',
        events.every((event) => event.transition !== 'remote_completed'),
      );
      check(
        'MF10 完成写回失败记录分类',
        errors.some(
          (error) =>
            error instanceof Error &&
            error.message === 'memory_job_complete_writeback_rejected',
        ),
      );
      checkEqual(
        'MF10 完成写回失败保持未完成状态',
        (await jobSnapshotOf(fixture.env)).status,
        'leased',
      );
    } finally {
      await runtime.stop();
      adapter.close();
      fixture.env.db.close();
    }
  }

  // 对账分支：远端 completed 但本地写回未生效时仍按 unknown 计数。
  {
    const fake = new FakeHindsight(`test_hindsight_writeback_${crypto.randomUUID().replaceAll('-', '')}`);
    const fixture = await seedMemoryAdmission(join(root, 'writeback-reconcile.sqlite'));
    const events: MemoryJobEvent[] = [];
    const errors: unknown[] = [];
    const clock = AT + 1_000;
    const runtime = new MemoryRuntime(failCompleteWriteback(fixture.env.d1), {
      adapter: hindsightAdapter(fake),
      instanceId: fixture.instanceId,
      capture: true,
      now: () => clock,
      onJobEvent: (event) => events.push(event),
      onError: (error) => errors.push(error),
    });
    try {
      await runtime.start();
      await runtime.tick();
      const operationId = (await jobSnapshotOf(fixture.env)).provider_job_id;
      fake.setOperationStatus(operationId!, 'completed');
      const reconciled = await runtime.reconcile();
      checkEqual('MF10 对账写回失败不计 completed', reconciled.completed, 0);
      checkEqual('MF10 对账写回失败保持 unknown', reconciled.stillUnknown, 1);
      checkEqual(
        'MF10 对账写回失败状态仍 unknown',
        (await jobSnapshotOf(fixture.env)).status,
        'unknown',
      );
      check(
        'MF10 对账写回失败不发完成事件',
        events.every((event) => event.transition !== 'remote_completed'),
      );
      check(
        'MF10 对账写回失败记录分类',
        errors.some(
          (error) =>
            error instanceof Error &&
            error.message === 'memory_job_complete_writeback_rejected',
        ),
      );
    } finally {
      await runtime.stop();
      fixture.env.db.close();
      await fake.stop();
    }
  }
}

export async function seedSpaceOnly(dbPath: string): Promise<{
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

export async function expectRejected(label: string, operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    check(label, false);
  } catch {
    check(label, true);
  }
}


export async function transactionFailureChecks(root: string): Promise<void> {
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

export async function captureDisabledChecks(root: string): Promise<void> {
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
  const integration = new MemoryIntegration({
    runtime,
    tickIntervalMs: 60_000,
    reconcileIntervalMs: 60_000,
    now: () => AT + 100,
  });
  try {
    await integration.start();
    await integration.runOnce();
    checkEqual('MF10 capture 关闭仍执行 remove', (await jobStatusOf(fixture.env, 'remove')).status, 'completed');
    checkEqual('MF10 capture 关闭 suppress retain', (await jobStatusOf(fixture.env, 'retain')).status, 'cancelled');
    const intent = await fixture.env.d1
      .prepare('SELECT status FROM memory_retain_intents ORDER BY created_at DESC LIMIT 1')
      .first<{ status: string }>();
    checkEqual('MF10 retain 意图 suppressed', intent?.status, 'suppressed');
    checkEqual('MF10 remove 后不可见', adapter.inspect(fixture.space).records.visible, 0);
  } finally {
    await integration.stop();
    adapter.close();
    fixture.env.db.close();
  }
}

export class FlakyRetainAdapter extends LocalMemoryAdapter {
  #failures: number;
  retainCalls = 0;

  constructor(options: { path: string; now?: () => number }, failures: number) {
    super(options);
    this.#failures = failures;
  }

  override async retain(request: RetainRequest): Promise<Awaited<ReturnType<LocalMemoryAdapter['retain']>>> {
    this.retainCalls += 1;
    if (this.#failures > 0) {
      this.#failures -= 1;
      throw new Error('injected local retain failure');
    }
    return super.retain(request);
  }
}

/**
 * 持久作业重试：失败只改作业状态与退避时间，attempt/next_attempt_at 落在
 * SQLite；进程重启后由新的集成实例继续领取，不重复写入已成功的表示。
 */

export async function persistentRetryChecks(root: string): Promise<void> {
  const fixture = await seedMemoryAdmission(join(root, 'persistent-retry.sqlite'));
  const localPath = join(root, 'persistent-retry-local.sqlite');
  let clock = AT + 100;
  const first = new FlakyRetainAdapter({ path: localPath, now: () => clock }, 1);
  const firstRuntime = new MemoryRuntime(fixture.env.d1, {
    adapter: first,
    instanceId: fixture.instanceId,
    capture: true,
    now: () => clock,
  });
  const firstIntegration = new MemoryIntegration({
    runtime: firstRuntime,
    tickIntervalMs: 60_000,
    reconcileIntervalMs: 60_000,
    now: () => clock,
  });
  let nextAttemptAt = 0;
  try {
    await firstIntegration.start();
    await firstIntegration.runOnce();
    const failed = await fixture.env.d1
      .prepare(
        `SELECT status, attempt, next_attempt_at FROM memory_jobs
          WHERE operation_type = 'retain' ORDER BY created_at DESC LIMIT 1`,
      )
      .first<{ status: string; attempt: number; next_attempt_at: number }>();
    checkEqual('MF10 持久重试：失败保持 pending', failed?.status, 'pending');
    checkEqual('MF10 持久重试：attempt 落库', failed?.attempt, 1);
    nextAttemptAt = Number(failed?.next_attempt_at ?? 0);
    check('MF10 持久重试：退避写入数据库', nextAttemptAt > clock, nextAttemptAt - clock);
    const callsAfterFailure = first.retainCalls;
    await firstIntegration.stop();
    await sleep(80);
    checkEqual('MF10 持久重试：stop 后不再调度', first.retainCalls, callsAfterFailure);
    checkEqual('MF10 持久重试：stop 后状态 stopped', firstIntegration.started, false);
  } finally {
    await firstIntegration.stop();
    first.close();
  }

  clock = nextAttemptAt + 1;
  const second = new FlakyRetainAdapter({ path: localPath, now: () => clock }, 0);
  const secondRuntime = new MemoryRuntime(fixture.env.d1, {
    adapter: second,
    instanceId: fixture.instanceId,
    capture: true,
    now: () => clock,
  });
  const secondIntegration = new MemoryIntegration({
    runtime: secondRuntime,
    tickIntervalMs: 60_000,
    reconcileIntervalMs: 60_000,
    now: () => clock,
  });
  try {
    await secondIntegration.start();
    await secondIntegration.runOnce();
    const completed = await fixture.env.d1
      .prepare(
        `SELECT status, attempt FROM memory_jobs
          WHERE operation_type = 'retain' ORDER BY created_at DESC LIMIT 1`,
      )
      .first<{ status: string; attempt: number }>();
    checkEqual('MF10 持久重试：重启后完成', completed?.status, 'completed');
    checkEqual('MF10 持久重试：沿用持久 attempt', completed?.attempt, 2);
    checkEqual('MF10 持久重试：只写一次', second.inspect(fixture.space).records.visible, 1);
  } finally {
    await secondIntegration.stop();
    second.close();
    fixture.env.db.close();
  }
}
