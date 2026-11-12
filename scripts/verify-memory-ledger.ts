/**
 * MF03 验收：持久日志、作业租约、恢复与清理保护。
 *
 * 覆盖 M11–M17、M21、I04–I06 中可由本地 SQLite + 运行时证明的部分：
 * - 回执幂等、经历/retain 同事务、遗忘屏障永久有效；
 * - 版本单调、连续确认前缀、独立 space 命令流；
 * - 租约过期只对账不重跑，迟到 ACK 不复活 Context；
 * - 进程在本地提交后/外部响应前后退出时意图可恢复；
 * - 通用 TTL 清理不删除 Memory 源/tombstone，actor 提示清理不推进 inbox 游标。
 *
 * 运行：bun run test:memory-ledger
 */

import { BusinessError } from '../src/contracts/errors';
import { LIMITS } from '../src/contracts/limits';
import type { Env } from '../src/env';
import {
  confirmedGovernancePrefix,
  countUnknownMemoryJobs,
  recoverMemoryJobs,
  MEMORY_CURSOR_KINDS,
} from '../src/memory/jobs';
import { memoryJobStatement } from '../src/memory/statements';
import { completeMemoryJob } from '../src/memory/jobs';
import { ensureMemoryInstance } from '../src/memory/access';
import { MemoryRuntime } from '../src/memory/runtime';
import {
  admitExposureReceipt,
  applyMemoryForget,
  ensureSpaceForAgent,
  getSource,
  recordContextDeliveryReceipt,
  runMemoryBatch,
  sourceMutationStatements,
  warmupStatements,
} from '../src/memory/store';
import { readMemoryContext, readMemoryExperience, registerRepresentation } from '../src/memory/store-objects';
import { maintain } from '../src/maintenance';
import { sha256Hex } from '../src/storage/db';
import { RecordingAdapter } from './lib/memory-recording-adapter';
import { check, checkEqual } from './lib/harness';
import {
  createMemoryEnv,
  experienceEntry,
  experienceKey,
  exposureReceipt,
  joinRoomMember,
  privateTarget,
  rawRepresentation,
  seedActor,
  seedManagement,
  seedRoom,
  spaceRef,
  unique,
  type MemoryTestEnv,
} from './lib/memory-unit';

const AT = 1_700_000_000_000;

async function expectCode(label: string, promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    check(label, false, 'expected BusinessError');
  } catch (error) {
    checkEqual(label, error instanceof BusinessError ? error.code : 'UNKNOWN', code);
  }
}

async function addSource(
  env: MemoryTestEnv,
  input: {
    sourceId?: string;
    sourceKey: string;
    roomId: string;
    memberGeneration?: number;
    policyRevision?: number;
    seq?: number;
    text?: string;
    revision?: number;
  },
): Promise<{ sourceId: string; text: string; row: NonNullable<Awaited<ReturnType<typeof getSource>>> }> {
  const sourceId = input.sourceId ?? unique('msrc');
  const text = input.text ?? `SOURCE-${sourceId}`;
  const hash = await sha256Hex(text);
  const revision = input.revision ?? 1;
  await runMemoryBatch(
    env.d1,
    sourceMutationStatements(env.d1, {
      instanceId: 'mni_ledger',
      sourceId,
      sourceKey: input.sourceKey,
      sourceKind: 'message',
      businessRefKind: 'message',
      businessRefJson: JSON.stringify({ message_id: input.sourceKey }),
      originRoomId: input.roomId,
      originMemberGeneration: input.memberGeneration ?? 1,
      originPolicyRevision: input.policyRevision ?? 0,
      originJoinedSeq: 0,
      originJoinedAt: 0,
      originArchiveHeadSeq: null,
      originSeq: input.seq ?? 1,
      originCreatedAt: AT + (input.seq ?? 1),
      authorActorId: null,
      revision,
      contentText: text,
      contentSha256: hash,
      contentBytes: new TextEncoder().encode(text).length,
      now: AT,
    }),
  );
  const row = await getSource(env.d1, sourceId, revision);
  if (!row) throw new Error('source seed failed');
  return { sourceId, text, row };
}

async function insertContext(
  env: MemoryTestEnv,
  input: {
    contextId: string;
    space: { space_id: string; ownership_epoch: number; backend_binding_epoch: number };
    agentId: string;
    representationId: string;
    experienceId?: string | null;
    body?: string;
    status?: 'ready' | 'invalidated' | 'expired' | 'purged';
    expiresAt?: number | null;
  },
): Promise<void> {
  const body = input.body ?? 'CONTEXT-BODY';
  await env.d1.batch([
    env.d1
      .prepare(
        `INSERT INTO memory_contexts
           (context_id, space_id, ownership_epoch, agent_actor_id, recall_id, kind,
            body, body_sha256, body_bytes, target_json, versions_json, policy_version,
            status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'lookup', ?, ?, ?, '{}', '{}', 1, ?, ?, ?, ?)`,
      )
      .bind(
        input.contextId,
        input.space.space_id,
        input.space.ownership_epoch,
        input.agentId,
        body,
        await sha256Hex(body),
        new TextEncoder().encode(body).length,
        input.status ?? 'ready',
        AT,
        input.expiresAt ?? null,
        AT,
      ),
    env.d1
      .prepare(
        `INSERT INTO memory_context_items
           (context_id, item_index, experience_id, representation_id,
            source_dependencies_json, evidence, origin_scope_json)
         VALUES (?, 0, ?, ?, '[]', NULL, '{}')`,
      )
      .bind(input.contextId, input.experienceId ?? null, input.representationId),
  ]);
}

function maintainEnv(env: MemoryTestEnv): Env {
  return {
    DB: env.d1,
    NOTIFICATION_HUB: null as unknown as Env['NOTIFICATION_HUB'],
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://memory.test',
  };
}

async function main(): Promise<void> {
  const env = createMemoryEnv();
  const instanceId = await ensureMemoryInstance(env.d1, { configuredId: 'mni_ledger', now: AT });
  const human = unique('usr_ledger_h');
  const agent = unique('agt_ledger_a');
  seedActor(env, { actorId: human, kind: 'human' });
  seedActor(env, { actorId: agent, kind: 'agent' });
  seedManagement(env, { agentId: agent, managerId: human });
  const room = unique('rm_ledger_direct');
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

  const requiredTables = [
    'memory_instances',
    'memory_spaces',
    'memory_space_transitions',
    'memory_sources',
    'memory_curated',
    'memory_representations',
    'memory_representation_dependencies',
    'memory_governance_commands',
    'memory_cursors',
    'memory_jobs',
    'memory_retain_intents',
    'memory_host_bindings',
    'memory_selections',
    'memory_manifests',
    'memory_manifest_items',
    'memory_recall_requests',
    'memory_contexts',
    'memory_context_items',
    'memory_experiences',
    'memory_experience_proofs',
    'memory_coverage_ranges',
    'memory_receipts',
    'memory_projections',
    'memory_catchup_plans',
    'memory_catchup_items',
    'memory_tombstones',
  ];
  const tables = new Set(
    (
      env.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  check(
    'MF03 长期对象物理表齐全',
    requiredTables.every((table) => tables.has(table)),
    requiredTables.filter((table) => !tables.has(table)),
  );

  const source = await addSource(env, {
    sourceKey: `msg_${room}_ledger`,
    roomId: room,
    text: 'LEDGER-SECRET-ALPHA',
  });
  const representation = await rawRepresentation({
    sourceId: source.sourceId,
    sourceRevision: 1,
    text: source.text,
  });
  const receipt = exposureReceipt({
    receiptId: 'mrc_ledger_1',
    space: spaceRef(space),
    agentId: agent,
    targetScope: privateTarget(),
    originScopes: [
      {
        room_id: room,
        member_generation: 1,
        policy_revision: 0,
        joined_seq: 0,
        joined_at: 0,
        archive_head_seq: null,
      },
    ],
    invocationId: 'inv_ledger_1',
    idempotencyKey: 'idem_ledger_1',
  });
  const admitted = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    receipt,
    representations: [representation],
    experiences: [
      experienceEntry({
        experienceId: 'mexp_ledger_1',
        key: experienceKey({
          space: spaceRef(space),
          agentId: agent,
          originRoomId: room,
          originMemberGeneration: 1,
          sourceId: source.sourceId,
          sourceRevision: 1,
          representation,
        }),
        originRoomId: room,
      }),
    ],
    retain: [
      {
        retainId: 'mrt_ledger_1',
        experienceId: 'mexp_ledger_1',
        representationId: representation.representation.representation_id,
        sourceId: source.sourceId,
        sourceRevision: 1,
        originKind: 'experienced',
        evidence: 'host_reported_submitted',
      },
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT,
  });
  checkEqual('回执/经历/retain 已同事务接纳', admitted.disposition.disposition, 'applied');
  const retainRow = await env.d1
    .prepare('SELECT * FROM memory_retain_intents WHERE retain_id = ?')
    .bind('mrt_ledger_1')
    .first<{ status: string; job_id: string }>();
  checkEqual('retain 意图 pending', retainRow?.status, 'pending');
  check('retain 意图生成持久作业', Boolean(retainRow?.job_id));

  // 幂等回执：同键同内容只对账，不改写经历数量。
  const duplicate = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    receipt,
    representations: [representation],
    experiences: [],
    minimumEvidence: 'host_reported_submitted',
    now: AT + 1,
  });
  checkEqual('幂等回执返回原结果', duplicate.disposition.disposition, 'applied');
  const experienceCount = (
    env.db.prepare('SELECT COUNT(*) AS n FROM memory_experiences').get() as { n: number }
  ).n;
  checkEqual('幂等回执不重复经历', experienceCount, 1);
  const invocationConflict = exposureReceipt({
    receiptId: 'mrc_ledger_inv_conflict',
    space: spaceRef(space),
    agentId: agent,
    targetScope: privateTarget(),
    originScopes: [
      {
        room_id: room,
        member_generation: 1,
        policy_revision: 0,
        joined_seq: 0,
        joined_at: 0,
        archive_head_seq: null,
      },
    ],
    invocationId: 'inv_ledger_1',
    idempotencyKey: 'idem_ledger_inv_conflict',
    manifestHash: 'd'.repeat(64),
  });
  await expectCode(
    '同一 invocation 换 manifest 冲突',
    admitExposureReceipt(env.d1, {
      instanceId,
      agentId: agent,
      space: spaceRef(space),
      receipt: invocationConflict,
      representations: [representation],
      experiences: [],
      minimumEvidence: 'host_reported_submitted',
      now: AT + 2,
    }),
    'IDEMPOTENCY_CONFLICT',
  );
  await expectCode(
    '同幂等键不同 manifest 冲突',
    admitExposureReceipt(env.d1, {
      instanceId,
      agentId: agent,
      space: spaceRef(space),
      receipt: { ...receipt, manifest_sha256: 'c'.repeat(64) },
      representations: [representation],
      experiences: [],
      minimumEvidence: 'host_reported_submitted',
      now: AT + 2,
    }),
    'IDEMPOTENCY_CONFLICT',
  );

  // 伪造表示 hash/范围不接纳，避免把未交付字节写成经历。
  const forgedKey = experienceKey({
    space: spaceRef(space),
    agentId: agent,
    originRoomId: room,
    originMemberGeneration: 1,
    sourceId: source.sourceId,
    sourceRevision: 1,
    representation,
  });
  const forged = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    receipt: exposureReceipt({
      receiptId: 'mrc_forged',
      space: spaceRef(space),
      agentId: agent,
      targetScope: privateTarget(),
      originScopes: [
        {
          room_id: room,
          member_generation: 1,
          policy_revision: 0,
          joined_seq: 0,
          joined_at: 0,
          archive_head_seq: null,
        },
      ],
      invocationId: 'inv_forged',
      idempotencyKey: 'idem_forged',
    }),
    representations: [representation],
    experiences: [
      experienceEntry({
        experienceId: 'mexp_forged',
        key: { ...forgedKey, text_sha256: 'f'.repeat(64) },
        originRoomId: room,
      }),
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT + 2,
  });
  checkEqual('伪造准确表示只补历史', forged.disposition.disposition, 'history_only');
  checkEqual('伪造表示不产生经历', forged.experience_ids.length, 0);

  // M11：Context 生成后遗忘源，旧 Context/经历不能再次读取。
  await insertContext(env, {
    contextId: 'mctx_ledger_1',
    space,
    agentId: agent,
    representationId: representation.representation.representation_id,
    experienceId: 'mexp_ledger_1',
  });
  const beforeForget = await readMemoryContext(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    contextId: 'mctx_ledger_1',
    targetScope: privateTarget(),
    now: AT + 3,
  });
  check('M11 遗忘前 Context 可读', beforeForget.available);

  const forget = await applyMemoryForget(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    sourceId: source.sourceId,
    sourceKey: source.row.source_key,
    reason: 'forget',
    now: AT + 4,
  });
  checkEqual('M11 遗忘写入治理命令', forget.disposition, 'applied');
  const afterForgetContext = await readMemoryContext(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    contextId: 'mctx_ledger_1',
    targetScope: privateTarget(),
    now: AT + 5,
  });
  check('M11 遗忘后旧 Context 不可读', !afterForgetContext.available, afterForgetContext);
  const afterForgetExperience = await readMemoryExperience(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    experienceId: 'mexp_ledger_1',
    targetScope: privateTarget(),
    now: AT + 5,
  });
  check('M11 遗忘后经历不可读', !afterForgetExperience.available, afterForgetExperience);
  const tombstone = env.db
    .prepare("SELECT * FROM memory_tombstones WHERE target_id = ?")
    .get(source.sourceId) as { tombstone_id: string; target_kind: string } | undefined;
  check('M11 保留最小审计 tombstone', Boolean(tombstone));
  let deleteBlocked = false;
  try {
    env.db.prepare('DELETE FROM memory_tombstones WHERE tombstone_id = ?').run(tombstone!.tombstone_id);
  } catch (error) {
    deleteBlocked = String(error).includes('memory_tombstone_permanent');
  }
  check('M11 tombstone 永久不可删除', deleteBlocked);

  // M14：已知被排除来源的再导入被拒绝；跨过 TTL 仍保留屏障。
  await expectCode(
    'M14 已排除来源不能重新导入',
    runMemoryBatch(
      env.d1,
      sourceMutationStatements(env.d1, {
        instanceId: 'mni_ledger',
        sourceId: unique('msrc_reimport'),
        sourceKey: source.row.source_key,
        sourceKind: 'message',
        businessRefKind: 'message',
        businessRefJson: JSON.stringify({ message_id: source.row.source_key }),
        originRoomId: room,
        originMemberGeneration: 1,
        originPolicyRevision: 0,
        originJoinedSeq: 0,
        originJoinedAt: 0,
        originArchiveHeadSeq: null,
        originSeq: 99,
        originCreatedAt: AT + 99,
        authorActorId: null,
        revision: 2,
        contentText: 'REIMPORTED',
        contentSha256: await sha256Hex('REIMPORTED'),
        contentBytes: 10,
        now: AT + 6,
      }),
    ),
    'PERMISSION_DENIED',
  );

  const old = Date.now() - LIMITS.eventsRetentionMs - 60_000;
  env.db.prepare('UPDATE memory_sources SET created_at = ?, updated_at = ?').run(old, old);
  env.db.prepare('UPDATE memory_tombstones SET created_at = ?').run(old);
  env.db
    .prepare("INSERT INTO operations (actor_id, request_id, payload_hash, write_nonce, result_json, created_at) VALUES (?, ?, 'h', 'n', '{}', ?)")
    .run(human, 'req_old', old);
  await maintain(maintainEnv(env));
  checkEqual(
    'M14 通用 TTL 清理不删除 Memory 源',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_sources').get() as { n: number }).n >= 1,
    true,
  );
  checkEqual(
    'M14 通用 TTL 清理不删除 tombstone',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_tombstones').get() as { n: number }).n >= 1,
    true,
  );
  checkEqual(
    '通用 operations 清理仍生效',
    (env.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE request_id = 'req_old'").get() as {
      n: number;
    }).n,
    0,
  );

  // M15：版本不倒退、同操作幂等、不同内容冲突。
  const versioned = await addSource(env, {
    sourceKey: 'msg_versioned',
    roomId: room,
    revision: 1,
    text: 'VERSION-ONE',
  });
  const versioned2 = await addSource(env, {
    sourceKey: 'msg_versioned',
    roomId: room,
    revision: 2,
    text: 'VERSION-TWO',
  });
  await expectCode(
    'M15 旧 revision 不能覆盖新 revision',
    runMemoryBatch(
      env.d1,
      sourceMutationStatements(env.d1, {
        instanceId: 'mni_ledger',
        sourceId: versioned.sourceId,
        sourceKey: 'msg_versioned',
        sourceKind: 'message',
        businessRefKind: 'message',
        businessRefJson: '{}',
        originRoomId: room,
        originMemberGeneration: 1,
        originPolicyRevision: 0,
        originJoinedSeq: 0,
        originJoinedAt: 0,
        originArchiveHeadSeq: null,
        originSeq: 3,
        originCreatedAt: AT + 3,
        authorActorId: null,
        revision: 1,
        contentText: 'VERSION-ONE',
        contentSha256: await sha256Hex('VERSION-ONE'),
        contentBytes: 11,
        now: AT + 7,
      }),
    ),
    'VERSION_CONFLICT',
  );
  await expectCode(
    'M15 同 revision 不同正文冲突',
    runMemoryBatch(
      env.d1,
      sourceMutationStatements(env.d1, {
        instanceId: 'mni_ledger',
        sourceId: versioned2.sourceId,
        sourceKey: 'msg_versioned',
        sourceKind: 'message',
        businessRefKind: 'message',
        businessRefJson: '{}',
        originRoomId: room,
        originMemberGeneration: 1,
        originPolicyRevision: 0,
        originJoinedSeq: 0,
        originJoinedAt: 0,
        originArchiveHeadSeq: null,
        originSeq: 3,
        originCreatedAt: AT + 3,
        authorActorId: null,
        revision: 2,
        contentText: 'VERSION-TWO-CHANGED',
        contentSha256: await sha256Hex('VERSION-TWO-CHANGED'),
        contentBytes: 19,
        now: AT + 8,
      }),
    ),
    'VERSION_CONFLICT',
  );

  // 同 revision 同内容重试只对账，不新增版本行。
  const beforeRetry = (
    env.db.prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE source_key = 'msg_versioned'").get() as {
      n: number;
    }
  ).n;
  await runMemoryBatch(
    env.d1,
    sourceMutationStatements(env.d1, {
      instanceId: 'mni_ledger',
      sourceId: versioned2.sourceId,
      sourceKey: 'msg_versioned',
      sourceKind: 'message',
      businessRefKind: 'message',
      businessRefJson: '{}',
      originRoomId: room,
      originMemberGeneration: 1,
      originPolicyRevision: 0,
      originJoinedSeq: 0,
      originJoinedAt: 0,
      originArchiveHeadSeq: null,
      originSeq: 3,
      originCreatedAt: AT + 3,
      authorActorId: null,
      revision: 2,
      contentText: 'VERSION-TWO',
      contentSha256: await sha256Hex('VERSION-TWO'),
      contentBytes: 11,
      now: AT + 8,
    }),
  );
  const afterRetry = (
    env.db.prepare("SELECT COUNT(*) AS n FROM memory_sources WHERE source_key = 'msg_versioned'").get() as {
      n: number;
    }
  ).n;
  checkEqual('M15 同 revision 同内容重试幂等', afterRetry, beforeRetry);

  // 连续确认前缀：seq 3 已应用也不能越过 seq 2。
  env.db
    .prepare(
      `INSERT INTO memory_governance_commands
         (space_id, command_seq, command_id, mutation_kind, target_kind, target_id,
          target_revision, payload_sha256, idempotency_key, status, result_json,
          created_at, applied_at)
       VALUES (?, 2, 'mcmd_gap', 'forget', 'source', 'x', NULL, 'h', 'idem_gap', 'pending', NULL, ?, NULL),
              (?, 3, 'mcmd_after_gap', 'forget', 'source', 'y', NULL, 'h', 'idem_after_gap', 'applied', NULL, ?, ?)`,
    )
    .run(space.space_id, AT, space.space_id, AT, AT);
  const prefix = await confirmedGovernancePrefix(env.d1, space.space_id);
  checkEqual('M15 连续确认前缀停在缺口', prefix.prefix, 1);
  checkEqual('M15 首个未确认序号', prefix.first_unconfirmed, 2);
  env.db
    .prepare("UPDATE memory_governance_commands SET status = 'applied', applied_at = ? WHERE space_id = ? AND command_seq = 2")
    .run(AT + 9, space.space_id);
  const prefixAfter = await confirmedGovernancePrefix(env.d1, space.space_id);
  checkEqual('M15 缺口补齐后前缀推进', prefixAfter.prefix, 3);
  const cursor = await env.d1
    .prepare(
      'SELECT value FROM memory_cursors WHERE scope_kind = ? AND scope_id = ? AND cursor_kind = ?',
    )
    .bind('space', space.space_id, MEMORY_CURSOR_KINDS.sourceApplied)
    .first<{ value: number }>();
  checkEqual('M15 前缀水位持久化', cursor?.value, 3);

  // M16：独立 space 命令流互不等待。
  const otherAgent = unique('agt_ledger_b');
  seedActor(env, { actorId: otherAgent, kind: 'agent' });
  seedManagement(env, { agentId: otherAgent, managerId: human });
  const otherSpace = await ensureSpaceForAgent(env.d1, { instanceId, agentId: otherAgent, now: AT });
  env.db
    .prepare(
      `INSERT INTO memory_governance_commands
         (space_id, command_seq, command_id, mutation_kind, target_kind, target_id,
          target_revision, payload_sha256, idempotency_key, status, result_json,
          created_at, applied_at)
       VALUES (?, 1, 'mcmd_other', 'forget', 'source', 'z', NULL, 'h', 'idem_other', 'applied', NULL, ?, ?)`,
    )
    .run(otherSpace.space_id, AT, AT);
  const otherPrefix = await confirmedGovernancePrefix(env.d1, otherSpace.space_id);
  checkEqual('M16 独立 space 前缀独立', otherPrefix.prefix, 1);
  checkEqual('M16 不等待其他 space 的缺口', otherPrefix.first_unconfirmed, null);

  // M13/M17：rebuild 完成不越过遗忘屏障；交错写入保留全部来源修订与唯一操作键。
  const rebuildSource = await addSource(env, {
    sourceKey: 'msg_rebuild',
    roomId: room,
    text: 'REBUILD-SECRET',
  });
  const rebuildRep = await rawRepresentation({
    sourceId: rebuildSource.sourceId,
    sourceRevision: 1,
    text: rebuildSource.text,
  });
  const rebuildReceipt = exposureReceipt({
    receiptId: 'mrc_rebuild',
    space: spaceRef(space),
    agentId: agent,
    targetScope: privateTarget(),
    originScopes: [
      {
        room_id: room,
        member_generation: 1,
        policy_revision: 0,
        joined_seq: 0,
        joined_at: 0,
        archive_head_seq: null,
      },
    ],
    invocationId: 'inv_rebuild',
    idempotencyKey: 'idem_rebuild',
  });
  const rebuildAdmission = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    receipt: rebuildReceipt,
    representations: [rebuildRep],
    experiences: [
      experienceEntry({
        experienceId: 'mexp_rebuild',
        key: experienceKey({
          space: spaceRef(space),
          agentId: agent,
          originRoomId: room,
          originMemberGeneration: 1,
          sourceId: rebuildSource.sourceId,
          sourceRevision: 1,
          representation: rebuildRep,
        }),
        originRoomId: room,
      }),
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT + 12,
  });
  checkEqual('M13 rebuild 前经历已接纳', rebuildAdmission.disposition.disposition, 'applied');
  await applyMemoryForget(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    sourceId: rebuildSource.sourceId,
    sourceKey: rebuildSource.row.source_key,
    reason: 'forget',
    now: AT + 13,
  });
  const rebuildJobId = 'mjb_rebuild';
  await runMemoryBatch(env.d1, [
    memoryJobStatement(env.d1, {
      jobId: rebuildJobId,
      spaceId: space.space_id,
      ownershipEpoch: space.ownership_epoch,
      agentActorId: agent,
      operationType: 'rebuild',
      operationKey: 'rebuild:msg_rebuild',
      payloadSha256: 'r'.repeat(64),
      backendBindingEpoch: space.backend_binding_epoch,
      now: AT + 14,
    }),
  ]);
  await completeMemoryJob(env.d1, { jobId: rebuildJobId, stage: 'derived_ready', now: AT + 15 });
  const rebuildRead = await readMemoryExperience(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    experienceId: 'mexp_rebuild',
    targetScope: privateTarget(),
    now: AT + 16,
  });
  check('M13 rebuild 完成不越过遗忘屏障', !rebuildRead.available, rebuildRead);

  // 同 operation_key 重复入队只保留一个作业。
  for (let i = 0; i < 2; i += 1) {
    await runMemoryBatch(env.d1, [
      memoryJobStatement(env.d1, {
        jobId: `mjb_idem_${i}`,
        spaceId: space.space_id,
        ownershipEpoch: space.ownership_epoch,
        agentActorId: agent,
        operationType: 'ensure_space',
        operationKey: 'ensure:test',
        payloadSha256: 'i'.repeat(64),
        backendBindingEpoch: space.backend_binding_epoch,
        now: AT + 17,
      }),
    ]);
  }
  const idemJobs = (
    env.db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE operation_key = 'ensure:test'").get() as {
      n: number;
    }
  ).n;
  checkEqual('M17 同 operation_key 只保留一个作业', idemJobs, 1);

  // M21：迟到 ACK 只补历史，不复活过期 Context。
  await insertContext(env, {
    contextId: 'mctx_expired',
    space,
    agentId: agent,
    representationId: representation.representation.representation_id,
    experienceId: 'mexp_ledger_1',
    status: 'expired',
    expiresAt: AT - 1,
  });
  const contextReceipt = {
    receipt_id: 'mrc_context_late',
    kind: 'context_delivery' as const,
    context_id: 'mctx_expired',
    context_sha256: await sha256Hex('expired'),
    invocation: {
      host_binding_id: 'mhb_test',
      host_generation: 1,
      session_incarnation: 'sess_test',
      run_id: 'run_test',
      input_id: 'input_test',
      input_revision: 1,
      invocation_id: 'inv_context_late',
    },
    space: spaceRef(space),
    agent_actor_id: agent,
    evidence: 'served' as const,
    proof_id: 'mpf_context_late',
    delivered_at: AT + 10,
    idempotency_key: 'idem_context_late',
  };
  const lateAck = await recordContextDeliveryReceipt(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    receipt: contextReceipt,
    now: AT + 10,
  });
  checkEqual('M21 迟到 ACK 只补历史', lateAck.disposition, 'history_only');
  checkEqual('M21 原因是 Context 过期', lateAck.reason, 'context_expired');
  const expiredRead = await readMemoryContext(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    contextId: 'mctx_expired',
    targetScope: privateTarget(),
    now: AT + 11,
  });
  check('M21 迟到 ACK 不复活 Context', !expiredRead.available);

  // M21/M12：租约过期且已有远端 JobRef 只标 unknown，不自动重跑。
  const retainJobId = retainRow!.job_id;
  await env.d1
    .prepare(
      `UPDATE memory_jobs
          SET status = 'leased', attempt = 1, lease_id = 'lease_ledger',
              lease_until = ?, provider_job_id = 'remote_ledger', stage = 'source_applied',
              updated_at = ?
        WHERE job_id = ?`,
    )
    .bind(AT + 1, AT + 1, retainJobId)
    .run();
  const recovered = await recoverMemoryJobs(env.d1, { now: AT + 100 });
  checkEqual('M12 已提交远端作业标 unknown', recovered.unknown, 1);
  checkEqual('M12 unknown 不自动重跑', await countUnknownMemoryJobs(env.d1), 1);
  const jobAfterRecovery = await env.db
    .prepare('SELECT status, last_error FROM memory_jobs WHERE job_id = ?')
    .get(retainJobId) as { status: string; last_error: string | null };
  checkEqual('M12 unknown 状态保留', jobAfterRecovery.status, 'unknown');
  // 旧值/派生不会因 unknown 重新可见。
  const stillForgotten = await readMemoryExperience(env.d1, {
    instanceId,
    agentId: agent,
    space: spaceRef(space),
    experienceId: 'mexp_ledger_1',
    targetScope: privateTarget(),
    now: AT + 101,
  });
  check('M12 未知作业不复活被遗忘内容', !stillForgotten.available);

  // I05：recall/预热不撤回、不产生 tombstone；空正文不自行生成撤回证据。
  const tombstonesBeforeRecall = (
    env.db.prepare('SELECT COUNT(*) AS n FROM memory_tombstones').get() as { n: number }
  ).n;
  await env.d1.batch([
    ...warmupStatements(env.d1, {
      space,
      agentId: agent,
      requestKey: 'warm:test',
      mode: 'related',
      dispatch: 'auto',
      targetJson: '{}',
      now: AT + 20,
    }),
  ]);
  const warmRows = env.db
    .prepare('SELECT COUNT(*) AS n FROM memory_recall_requests WHERE warmup_only = 1')
    .get() as { n: number };
  check('I05 预热只写 warmup_only 请求', warmRows.n >= 1);
  const tombstoneCount = (
    env.db.prepare('SELECT COUNT(*) AS n FROM memory_tombstones').get() as { n: number }
  ).n;
  checkEqual('I05 recall/预热不产生 tombstone', tombstoneCount, tombstonesBeforeRecall);
  const emptySource = await addSource(env, {
    sourceKey: 'msg_empty',
    roomId: room,
    text: '',
  });
  const emptyTombstone = env.db
    .prepare("SELECT COUNT(*) AS n FROM memory_tombstones WHERE target_id = ?")
    .get(emptySource.sourceId) as { n: number };
  checkEqual('I05 空正文不产生 tombstone', emptyTombstone.n, 0);

  // I06：actor 范围 memory 提示清理不推进 inbox_min_seq。
  const inboxActor = unique('usr_inbox');
  seedActor(env, { actorId: inboxActor, kind: 'human' });
  env.db.prepare('UPDATE actors SET inbox_head_seq = 10 WHERE actor_id = ?').run(inboxActor);
  env.db
    .prepare(
      `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
       VALUES ('actor', ?, 'memory.context.ready', NULL, '{}', ?, ?)`,
    )
    .run(inboxActor, 'evt_memory_actor', old);
  await maintain(maintainEnv(env));
  const inboxAfterMemory = await env.db
    .prepare('SELECT inbox_min_seq FROM actors WHERE actor_id = ?')
    .get(inboxActor) as { inbox_min_seq: number };
  checkEqual('I06 memory 提示清理不推进 inbox_min_seq', inboxAfterMemory.inbox_min_seq, 0);
  const memoryEventLeft = env.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE event_key = 'evt_memory_actor'")
    .get() as { n: number };
  checkEqual('I06 memory 提示本身可清理', memoryEventLeft.n, 0);

  // 关闭采集：新 retain 被显式抑制，但删除/遗忘屏障仍执行。
  const captureAgent = unique('agt_capture_off');
  seedActor(env, { actorId: captureAgent, kind: 'agent' });
  seedManagement(env, { agentId: captureAgent, managerId: human });
  const captureSpace = await ensureSpaceForAgent(env.d1, {
    instanceId,
    agentId: captureAgent,
    now: AT + 30,
  });
  const captureSource = await addSource(env, {
    sourceKey: 'msg_capture_off',
    roomId: room,
    text: 'CAPTURE-OFF-SECRET',
  });
  const captureRep = await rawRepresentation({
    sourceId: captureSource.sourceId,
    sourceRevision: 1,
    text: captureSource.text,
  });
  await joinRoomMember(env, room, {
    actorId: captureAgent,
    joinedSeq: 0,
    memberGeneration: 1,
    memberSeq: 3,
    at: AT + 30,
  });
  const captureAdmission = await admitExposureReceipt(env.d1, {
    instanceId,
    agentId: captureAgent,
    space: spaceRef(captureSpace),
    receipt: exposureReceipt({
      receiptId: 'mrc_capture_off',
      space: spaceRef(captureSpace),
      agentId: captureAgent,
      targetScope: privateTarget(),
      originScopes: [
        {
          room_id: room,
          member_generation: 1,
          policy_revision: 0,
          joined_seq: 0,
          joined_at: 0,
          archive_head_seq: null,
        },
      ],
      invocationId: 'inv_capture_off',
      idempotencyKey: 'idem_capture_off',
    }),
    representations: [captureRep],
    experiences: [
      experienceEntry({
        experienceId: 'mexp_capture_off',
        key: experienceKey({
          space: spaceRef(captureSpace),
          agentId: captureAgent,
          originRoomId: room,
          originMemberGeneration: 1,
          sourceId: captureSource.sourceId,
          sourceRevision: 1,
          representation: captureRep,
        }),
        originRoomId: room,
      }),
    ],
    retain: [
      {
        retainId: 'mrt_capture_off',
        experienceId: 'mexp_capture_off',
        representationId: captureRep.representation.representation_id,
        sourceId: captureSource.sourceId,
        sourceRevision: 1,
        originKind: 'experienced',
        evidence: 'host_reported_submitted',
      },
    ],
    minimumEvidence: 'host_reported_submitted',
    now: AT + 31,
  });
  checkEqual('关闭采集夹具回执已接纳', captureAdmission.disposition.disposition, 'applied');
  await applyMemoryForget(env.d1, {
    instanceId,
    agentId: captureAgent,
    space: spaceRef(captureSpace),
    sourceId: captureSource.sourceId,
    sourceKey: captureSource.row.source_key,
    reason: 'forget',
    now: AT + 32,
  });
  const captureAdapter = new RecordingAdapter();
  const captureRuntime = new MemoryRuntime(env.d1, {
    adapter: captureAdapter,
    instanceId,
    capture: false,
    now: () => AT + 33,
  });
  await captureRuntime.start();
  const captureTick = await captureRuntime.tick();
  check('关闭采集仍执行删除屏障', captureTick.completed >= 1, captureTick);
  check('关闭采集抑制新 retain', captureTick.suppressed >= 1, captureTick);
  const suppressedIntent = await env.db
    .prepare('SELECT status FROM memory_retain_intents WHERE retain_id = ?')
    .get('mrt_capture_off') as { status: string };
  checkEqual('关闭采集 retain 状态显式 suppressed', suppressedIntent.status, 'suppressed');
  checkEqual(
    '关闭采集不清除既有 tombstone',
    (env.db.prepare('SELECT COUNT(*) AS n FROM memory_tombstones WHERE target_id = ?').get(captureSource.sourceId) as { n: number }).n,
    1,
  );
  await captureRuntime.stop();

  env.db.close();
}

main()
  .then(() => {
    console.log('memory ledger checks passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
