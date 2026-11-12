/**
 * MF03：可在业务 db.batch 内追加的纯 SQL Memory 意图。
 *
 * 这些函数不读 env、不调用 Hindsight、不决定 UI；只把“已授权共享来源”
 * “治理命令”“预热资格”“获准 retain 意图”写成与业务提交同生共死的语句。
 * 个人经历/retain 只能由合格 ExposureReceipt 路径调用，预热函数显式标记
 * `warmup_only=1` 且没有 retain 字段。
 */
import { guardSql } from '../storage/guards';
import type { D1Like } from '../storage/queries';
import { newId } from '../storage/db';
import type {
  MemoryContextDeliveryReceipt,
  MemoryExactRepresentation,
  MemoryExperienceKey,
  MemoryExposureReceipt,
  MemoryOriginKind,
  MemoryOwnershipKind,
  MemoryProducerKind,
  MemoryRepresentationKind,
  MemorySha256,
  MemorySourceDependency,
  MemorySourceKind,
} from './contracts';

export interface MemorySourceMutationInput {
  instanceId: string;
  sourceId: string;
  sourceKey: string;
  sourceKind: MemorySourceKind;
  businessRefKind: string;
  businessRefJson: string;
  originRoomId: string | null;
  originMemberGeneration: number;
  originPolicyRevision: number;
  originJoinedSeq: number;
  originJoinedAt: number;
  originArchiveHeadSeq: number | null;
  originSeq: number | null;
  originCreatedAt: number;
  authorActorId: string | null;
  revision: number;
  contentText: string | null;
  contentSha256: MemorySha256 | null;
  contentBytes: number | null;
  now: number;
  /** retracted 时同事务写永久 tombstone；已排除版本不能被重新导入。 */
  retracted?: boolean;
  retractionReason?: 'recall' | 'forget' | 'permission' | 'file_deleted' | 'policy';
  tombstoneId?: string;
}

export interface MemoryInitialSpaceInput {
  spaceId: string;
  transitionId: string;
  instanceId: string;
  agentId: string;
  ownerActorId: string;
  ownershipKind: MemoryOwnershipKind;
  managementBindingId: string | null;
  now: number;
  capture?: 'none' | 'pending' | 'excluded';
}

export interface MemoryOwnershipTransferInput {
  previous:
    | {
        space_id: string;
        ownership_epoch: number;
        owner_actor_id: string;
        backend_binding_epoch: number;
      }
    | null;
  nextSpaceId: string;
  transitionId: string;
  instanceId: string;
  agentId: string;
  ownerActorId: string;
  ownershipKind: MemoryOwnershipKind;
  managementBindingId: string | null;
  kind: 'initial_claim' | 'management_transfer' | 'initial_enable';
  closedHostBindingIds?: readonly string[];
  now: number;
  capture?: 'none' | 'pending' | 'excluded';
}

/** 首次写入 Memory 账本时插入稳定 instance；已有行时保持原 namespace。 */
export function memoryEnsureInstanceStatement(
  db: D1Like,
  input: { instanceId: string; now: number; captureDefault?: 'enabled' | 'disabled' },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memory_instances (instance_id, capture_default, created_at, updated_at)
       SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM memory_instances)`,
    )
    .bind(input.instanceId, input.captureDefault ?? 'enabled', input.now, input.now);
}

function activeSpaceInsert(
  db: D1Like,
  input: {
    spaceId: string;
    instanceId: string;
    agentId: string;
    ownerActorId: string;
    ownershipKind: MemoryOwnershipKind;
    ownershipEpoch: number;
    managementBindingId: string | null;
    capture: 'none' | 'pending' | 'excluded';
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memory_spaces
         (space_id, instance_id, agent_actor_id, owner_actor_id, ownership_kind,
          ownership_epoch, backend_binding_epoch, management_binding_id, capture, active,
          created_at, updated_at)
       SELECT ?, (SELECT instance_id FROM memory_instances ORDER BY created_at LIMIT 1),
              ?, ?, ?, ?, 1, ?, ?, 1, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_spaces WHERE agent_actor_id = ? AND active = 1
        )`,
    )
    .bind(
      input.spaceId,
      input.agentId,
      input.ownerActorId,
      input.ownershipKind,
      input.ownershipEpoch,
      input.managementBindingId,
      input.capture,
      input.now,
      input.now,
      input.agentId,
    );
}

function transitionInsert(
  db: D1Like,
  input: {
    transitionId: string;
    spaceId: string;
    previousSpaceId: string | null;
    agentId: string;
    kind: string;
    previousOwnerActorId: string | null;
    nextOwnerActorId: string;
    previousEpoch: number;
    nextEpoch: number;
    closedHostBindingIds: readonly string[];
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memory_space_transitions
         (transition_id, space_id, previous_space_id, agent_actor_id, kind,
          previous_owner_actor_id, next_owner_actor_id, previous_ownership_epoch,
          next_ownership_epoch, closed_host_binding_ids, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_space_transitions
           WHERE agent_actor_id = ? AND next_ownership_epoch = ?
        )`,
    )
    .bind(
      input.transitionId,
      input.spaceId,
      input.previousSpaceId,
      input.agentId,
      input.kind,
      input.previousOwnerActorId,
      input.nextOwnerActorId,
      input.previousEpoch,
      input.nextEpoch,
      JSON.stringify(input.closedHostBindingIds),
      input.now,
      input.agentId,
      input.nextEpoch,
    );
}

/** Agent 创建/自注册：初始化 self_owned 或 managed 空间。 */
export function memoryInitialSpaceStatements(
  db: D1Like,
  input: MemoryInitialSpaceInput,
): D1PreparedStatement[] {
  return [
    memoryEnsureInstanceStatement(db, {
      instanceId: input.instanceId,
      now: input.now,
    }),
    activeSpaceInsert(db, {
      spaceId: input.spaceId,
      instanceId: input.instanceId,
      agentId: input.agentId,
      ownerActorId: input.ownerActorId,
      ownershipKind: input.ownershipKind,
      ownershipEpoch: 1,
      managementBindingId: input.managementBindingId,
      capture: input.capture ?? 'pending',
      now: input.now,
    }),
    transitionInsert(db, {
      transitionId: input.transitionId,
      spaceId: input.spaceId,
      previousSpaceId: null,
      agentId: input.agentId,
      kind: 'initial_enable',
      previousOwnerActorId: null,
      nextOwnerActorId: input.ownerActorId,
      previousEpoch: 0,
      nextEpoch: 1,
      closedHostBindingIds: [],
      now: input.now,
    }),
  ];
}

/**
 * 认领/管理转让：保存旧 space，切换活动 space 并递增 ownership_epoch。
 *
 * `agent_managements.binding_id` 是否保留与本函数无关；调用方必须在同一
 * batch 内已经更新 manager_id，且这里写入的 owner 是新 manager。
 */
export function memoryOwnershipTransferStatements(
  db: D1Like,
  input: MemoryOwnershipTransferInput,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    memoryEnsureInstanceStatement(db, {
      instanceId: input.instanceId,
      now: input.now,
    }),
  ];
  const previous = input.previous;
  if (previous) {
    statements.push(
      db
        .prepare(
          `UPDATE memory_spaces
              SET active = 0,
                  capture = CASE WHEN capture = 'excluded' THEN 'excluded' ELSE 'none' END,
                  updated_at = ?
            WHERE space_id = ? AND active = 1`,
        )
        .bind(input.now, previous.space_id),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE memory_host_bindings
            SET state = 'closed', closed_at = ?, updated_at = ?
          WHERE agent_actor_id = ? AND state = 'active'`,
      )
      .bind(input.now, input.now, input.agentId),
  );
  const nextEpoch = previous ? previous.ownership_epoch + 1 : 1;
  statements.push(
    activeSpaceInsert(db, {
      spaceId: input.nextSpaceId,
      instanceId: input.instanceId,
      agentId: input.agentId,
      ownerActorId: input.ownerActorId,
      ownershipKind: input.ownershipKind,
      ownershipEpoch: nextEpoch,
      managementBindingId: input.managementBindingId,
      capture: input.capture ?? 'pending',
      now: input.now,
    }),
    transitionInsert(db, {
      transitionId: input.transitionId,
      spaceId: input.nextSpaceId,
      previousSpaceId: previous?.space_id ?? null,
      agentId: input.agentId,
      kind: input.kind,
      previousOwnerActorId: previous?.owner_actor_id ?? null,
      nextOwnerActorId: input.ownerActorId,
      previousEpoch: previous?.ownership_epoch ?? 0,
      nextEpoch,
      closedHostBindingIds: input.closedHostBindingIds ?? [],
      now: input.now,
    }),
  );
  return statements;
}

/**
 * 共享来源修订。
 *
 * 同一 source_key 的旧 active 版本先标 superseded，再插入新 revision；
 * 相同 revision 不同 digest 在事务内直接失败，不允许版本倒退或静默覆盖。
 */
export function memorySourceMutationStatements(
  db: D1Like,
  input: MemorySourceMutationInput,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO memory_sources
           (source_id, instance_id, source_key, source_kind, business_ref_kind,
            business_ref_json, origin_room_id, origin_member_generation,
            origin_policy_revision, origin_joined_seq, origin_joined_at,
            origin_archive_head_seq, origin_seq, origin_created_at, author_actor_id,
            state, revision, content_text, content_sha256, content_bytes,
            superseded_by_source_id, superseded_by_revision, retracted_at,
            created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_sources
             WHERE instance_id = ? AND source_key = ? AND revision = ?
          )`,
      )
      .bind(
        input.sourceId,
        input.instanceId,
        input.sourceKey,
        input.sourceKind,
        input.businessRefKind,
        input.businessRefJson,
        input.originRoomId,
        input.originMemberGeneration,
        input.originPolicyRevision,
        input.originJoinedSeq,
        input.originJoinedAt,
        input.originArchiveHeadSeq,
        input.originSeq,
        input.originCreatedAt,
        input.authorActorId,
        input.retracted ? 'retracted' : 'active',
        input.revision,
        input.contentText,
        input.contentSha256,
        input.contentBytes,
        input.now,
        input.now,
        input.instanceId,
        input.sourceKey,
        input.revision,
      ),
  ];

  if (input.retracted) {
    statements.push(
      db
        .prepare(
          `UPDATE memory_sources
              SET state = 'retracted', retracted_at = ?, updated_at = ?
            WHERE instance_id = ? AND source_key = ? AND revision = ? AND state <> 'retracted'`,
        )
        .bind(input.now, input.now, input.instanceId, input.sourceKey, input.revision),
      db
        .prepare(guardSql(
          'versionConflict',
          `EXISTS (
             SELECT 1 FROM memory_sources
              WHERE instance_id = ? AND source_key = ? AND revision = ?
                AND content_sha256 IS NOT NULL AND content_sha256 <> ?
           )`,
        ))
        .bind(input.instanceId, input.sourceKey, input.revision, input.contentSha256),
      tombstoneStatement(db, {
        tombstoneId: input.tombstoneId ?? newId('mtb'),
        instanceId: input.instanceId,
        targetKind: 'source_key',
        targetId: input.sourceKey,
        sourceKey: input.sourceKey,
        reason: input.retractionReason ?? 'recall',
        now: input.now,
      }),
    );
  } else {
    statements.splice(
      0,
      0,
      db
        .prepare(
          `UPDATE memory_sources
              SET state = 'superseded', superseded_by_source_id = ?,
                  superseded_by_revision = ?, updated_at = ?
            WHERE instance_id = ? AND source_key = ? AND state = 'active'
              AND revision <> ?`,
        )
        .bind(
          input.sourceId,
          input.revision,
          input.now,
          input.instanceId,
          input.sourceKey,
          input.revision,
        ),
      db
        .prepare(guardSql(
          'versionConflict',
          `EXISTS (
             SELECT 1 FROM memory_sources
              WHERE instance_id = ? AND source_key = ? AND revision = ?
                AND content_sha256 IS NOT NULL AND content_sha256 <> ?
           )`,
        ))
        .bind(input.instanceId, input.sourceKey, input.revision, input.contentSha256),
      db
        .prepare(guardSql(
          'versionConflict',
          `EXISTS (
             SELECT 1 FROM memory_sources
              WHERE instance_id = ? AND source_key = ? AND revision > ?
                AND state IN ('active', 'superseded')
           )`,
        ))
        .bind(input.instanceId, input.sourceKey, input.revision),
      db
        .prepare(
          guardSql(
            'permissionDenied',
            `EXISTS (
               SELECT 1 FROM memory_tombstones
                WHERE source_key = ? AND target_kind IN ('source_key', 'source')
             )`,
          ),
        )
        .bind(input.sourceKey),
    );
  }
  return statements;
}

export function tombstoneStatement(
  db: D1Like,
  input: {
    tombstoneId: string;
    instanceId: string;
    targetKind: 'source' | 'source_key' | 'representation' | 'curated' | 'space' | 'partition' | 'context';
    targetId: string;
    sourceKey: string | null;
    reason: 'recall' | 'forget' | 'permission' | 'file_deleted' | 'transfer' | 'policy';
    commandId?: string | null;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memory_tombstones
         (tombstone_id, instance_id, target_kind, target_id, source_key, reason,
          command_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_tombstones
           WHERE target_kind = ? AND target_id = ? AND reason = ?
        )`,
    )
    .bind(
      input.tombstoneId,
      input.instanceId,
      input.targetKind,
      input.targetId,
      input.sourceKey,
      input.reason,
      input.commandId ?? null,
      input.now,
      input.targetKind,
      input.targetId,
      input.reason,
    );
}

/** space-scoped 治理命令；序列在同一事务内按当前 MAX+1 生成。 */
export function memoryGovernanceCommandStatement(
  db: D1Like,
  input: {
    commandId: string;
    spaceId: string;
    mutationKind:
      | 'source_register'
      | 'source_retract'
      | 'source_correct'
      | 'curated_put'
      | 'curated_correct'
      | 'forget'
      | 'space_close';
    targetKind: string;
    targetId: string;
    targetRevision: number | null;
    payloadSha256: string;
    idempotencyKey: string;
    status?: 'pending' | 'applied' | 'unknown' | 'failed';
    resultJson?: string | null;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memory_governance_commands
         (space_id, command_seq, command_id, mutation_kind, target_kind, target_id,
          target_revision, payload_sha256, idempotency_key, status, result_json,
          created_at, applied_at)
       SELECT ?, COALESCE((SELECT MAX(command_seq) FROM memory_governance_commands WHERE space_id = ?), 0) + 1,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_governance_commands
           WHERE space_id = ? AND idempotency_key = ?
        )`,
    )
    .bind(
      input.spaceId,
      input.spaceId,
      input.commandId,
      input.mutationKind,
      input.targetKind,
      input.targetId,
      input.targetRevision,
      input.payloadSha256,
      input.idempotencyKey,
      input.status ?? 'pending',
      input.resultJson ?? null,
      input.now,
      input.status === 'applied' ? input.now : null,
      input.spaceId,
      input.idempotencyKey,
    );
}

/** 预热资格：只创建 RecallRequest，不产生个人经历或 retain。 */
export function memoryWarmupStatement(
  db: D1Like,
  input: {
    recallId: string;
    spaceId: string;
    ownershipEpoch: number;
    agentActorId: string;
    requestKey: string;
    mode: string;
    dispatch: 'explicit' | 'auto';
    targetJson: string;
    planJson?: string | null;
    budgetJson?: string | null;
    now: number;
    expiresAt?: number | null;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memory_recall_requests
         (recall_id, space_id, ownership_epoch, agent_actor_id, request_key, mode,
          dispatch, status, target_json, plan_json, budget_json, warmup_only,
          created_at, updated_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_recall_requests WHERE space_id = ? AND request_key = ?
        )`,
    )
    .bind(
      input.recallId,
      input.spaceId,
      input.ownershipEpoch,
      input.agentActorId,
      input.requestKey,
      input.mode,
      input.dispatch,
      input.targetJson,
      input.planJson ?? null,
      input.budgetJson ?? null,
      input.now,
      input.now,
      input.expiresAt ?? null,
      input.spaceId,
      input.requestKey,
    );
}

export interface MemoryExperienceWrite {
  experienceId: string;
  dedupeKey: string;
  key: MemoryExperienceKey;
  originKind: MemoryOriginKind;
  producerKind: MemoryProducerKind | null;
  representationId: string;
  representationKind: MemoryRepresentationKind;
  receiptId: string | null;
  evidence: string | null;
  capture: 'none' | 'pending' | 'extracted' | 'excluded';
  originRoomId: string | null;
  now: number;
}

export function memoryExperienceStatements(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentActorId: string;
    items: readonly MemoryExperienceWrite[];
  },
): D1PreparedStatement[] {
  return input.items.map((item) =>
    db
      .prepare(
        `INSERT INTO memory_experiences
           (experience_id, dedupe_key, space_id, ownership_epoch, agent_actor_id,
            origin_room_id, origin_member_generation, origin_kind, producer_kind,
            source_id, source_revision, representation_id, representation_kind,
            range_start, range_end, text_sha256, receipt_id, evidence, capture,
            available, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM memory_experiences WHERE dedupe_key = ?)`,
      )
      .bind(
        item.experienceId,
        item.dedupeKey,
        input.spaceId,
        input.ownershipEpoch,
        input.agentActorId,
        item.originRoomId,
        item.key.origin_member_generation,
        item.originKind,
        item.producerKind,
        item.key.source_id,
        item.key.source_revision,
        item.representationId,
        item.representationKind,
        item.key.range?.start ?? null,
        item.key.range?.end ?? null,
        item.key.text_sha256,
        item.receiptId,
        item.evidence,
        item.capture,
        item.now,
        item.now,
        item.dedupeKey,
      ),
  );
}

export function memoryCoverageStatements(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentActorId: string;
    experienceId: string;
    key: MemoryExperienceKey;
    originRoomId: string;
    sourceId: string;
    sourceRevision: number;
    routeKey: string;
    now: number;
  },
): D1PreparedStatement[] {
  if (!input.key.range || input.key.representation_kind !== 'raw_full' && input.key.representation_kind !== 'raw_fragment') {
    return [];
  }
  const dedupeKey = [
    'cov',
    input.spaceId,
    String(input.ownershipEpoch),
    input.agentActorId,
    input.originRoomId,
    String(input.key.origin_member_generation),
    input.sourceId,
    String(input.sourceRevision),
    String(input.key.range.start),
    String(input.key.range.end),
    input.key.text_sha256,
  ].join('|');
  return [
    db
      .prepare(
        `INSERT INTO memory_coverage_ranges
           (coverage_id, dedupe_key, space_id, ownership_epoch, agent_actor_id,
            origin_room_id, origin_member_generation, source_id, source_revision,
            range_start, range_end, text_sha256, experience_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM memory_coverage_ranges WHERE dedupe_key = ?)`,
      )
      .bind(
        newId('mcv'),
        dedupeKey,
        input.spaceId,
        input.ownershipEpoch,
        input.agentActorId,
        input.originRoomId,
        input.key.origin_member_generation,
        input.sourceId,
        input.sourceRevision,
        input.key.range.start,
        input.key.range.end,
        input.key.text_sha256,
        input.experienceId,
        input.now,
        dedupeKey,
      ),
  ];
}

export function memoryRetainIntentStatements(
  db: D1Like,
  input: {
    retainId: string;
    jobId: string;
    spaceId: string;
    ownershipEpoch: number;
    agentActorId: string;
    originKind: MemoryOriginKind;
    experienceId: string | null;
    representationId: string;
    sourceId: string | null;
    sourceRevision: number | null;
    receiptId: string | null;
    curatedId?: string | null;
    curatedRevision?: number | null;
    evidence: string | null;
    policyVersion: number;
    operationKey: string;
    payloadSha256: string;
    backendBindingEpoch: number;
    now: number;
  },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO memory_retain_intents
           (retain_id, space_id, ownership_epoch, agent_actor_id, origin_kind,
            experience_id, representation_id, source_id, source_revision, receipt_id,
            curated_id, curated_revision, evidence, policy_version, operation_key,
            payload_sha256, status, job_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_retain_intents WHERE space_id = ? AND operation_key = ?
          )`,
      )
      .bind(
        input.retainId,
        input.spaceId,
        input.ownershipEpoch,
        input.agentActorId,
        input.originKind,
        input.experienceId,
        input.representationId,
        input.sourceId,
        input.sourceRevision,
        input.receiptId,
        input.curatedId ?? null,
        input.curatedRevision ?? null,
        input.evidence,
        input.policyVersion,
        input.operationKey,
        input.payloadSha256,
        input.jobId,
        input.now,
        input.now,
        input.spaceId,
        input.operationKey,
      ),
    memoryJobStatement(db, {
      jobId: input.jobId,
      spaceId: input.spaceId,
      ownershipEpoch: input.ownershipEpoch,
      agentActorId: input.agentActorId,
      operationType: 'retain',
      operationKey: `retain-job:${input.operationKey}`,
      payloadSha256: input.payloadSha256,
      retainIntentId: input.retainId,
      backendBindingEpoch: input.backendBindingEpoch,
      now: input.now,
    }),
  ];
}

export function memoryReceiptStatement(
  db: D1Like,
  receipt: MemoryExposureReceipt | MemoryContextDeliveryReceipt,
  input: {
    disposition: 'applied' | 'history_only' | 'rejected';
    reason: string | null;
    recordedAt: number;
  },
): D1PreparedStatement {
  const isExposure = receipt.kind === 'input_exposure';
  const invocation = receipt.invocation;
  return db
    .prepare(
      `INSERT INTO memory_receipts
         (receipt_id, kind, space_id, ownership_epoch, agent_actor_id,
          host_binding_id, host_generation, session_incarnation, run_id, input_id,
          input_revision, invocation_id, manifest_id, manifest_sha256, payload_sha256,
          context_id, context_sha256, target_scope_json, origin_scopes_json,
          evidence, proof_id, idempotency_key, disposition, reason, recorded_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_receipts WHERE idempotency_key = ?
        )`,
    )
    .bind(
      receipt.receipt_id,
      receipt.kind,
      receipt.space.space_id,
      receipt.space.ownership_epoch,
      receipt.agent_actor_id,
      invocation.host_binding_id,
      invocation.host_generation,
      invocation.session_incarnation,
      invocation.run_id,
      invocation.input_id,
      invocation.input_revision,
      invocation.invocation_id,
      isExposure ? receipt.manifest_id : null,
      isExposure ? receipt.manifest_sha256 : null,
      isExposure ? receipt.payload_sha256 : null,
      isExposure ? null : receipt.context_id,
      isExposure ? null : receipt.context_sha256,
      isExposure ? JSON.stringify(receipt.target_scope) : JSON.stringify({}),
      isExposure ? JSON.stringify(receipt.origin_scopes) : JSON.stringify([]),
      receipt.evidence,
      receipt.proof_id,
      receipt.idempotency_key,
      input.disposition,
      input.reason,
      input.recordedAt,
      input.recordedAt,
      receipt.idempotency_key,
    );
}

export function memoryJobStatement(
  db: D1Like,
  input: {
    jobId: string;
    spaceId: string;
    ownershipEpoch: number;
    agentActorId: string;
    operationType: 'ensure_space' | 'source_apply' | 'retain' | 'remove' | 'recall' | 'rebuild';
    operationKey: string;
    payloadSha256: string;
    sourceCommandId?: string | null;
    recallId?: string | null;
    retainIntentId?: string | null;
    targetJson?: string | null;
    resultJson?: string | null;
    backendBindingEpoch: number;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO memory_jobs
         (job_id, space_id, ownership_epoch, agent_actor_id, operation_type,
          operation_key, payload_sha256, source_command_id, recall_id, retain_intent_id,
          target_json, result_json, backend_binding_epoch, provider_job_id, status,
          stage, attempt, lease_id, lease_until, next_attempt_at, unknown_since,
          last_error, created_at, updated_at, completed_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 'accepted', 0,
              NULL, NULL, ?, NULL, NULL, ?, ?, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_jobs WHERE space_id = ? AND operation_key = ?
        )`,
    )
    .bind(
      input.jobId,
      input.spaceId,
      input.ownershipEpoch,
      input.agentActorId,
      input.operationType,
      input.operationKey,
      input.payloadSha256,
      input.sourceCommandId ?? null,
      input.recallId ?? null,
      input.retainIntentId ?? null,
      input.targetJson ?? null,
      input.resultJson ?? null,
      input.backendBindingEpoch,
      input.now,
      input.now,
      input.now,
      input.spaceId,
      input.operationKey,
    );
}

/**
 * 遗忘/撤回的即时本地屏障：逻辑排除先于异步后端清理。
 *
 * 不删除来源行；同事务追加 tombstone 并让已生成 Context/经历不可再读。
 */
export function memoryInvalidationStatements(
  db: D1Like,
  input: {
    tombstoneId: string;
    instanceId: string;
    sourceId: string;
    sourceKey: string | null;
    reason: 'recall' | 'forget' | 'permission' | 'file_deleted' | 'policy';
    commandId?: string | null;
    now: number;
  },
): D1PreparedStatement[] {
  return [
    tombstoneStatement(db, {
      tombstoneId: input.tombstoneId,
      instanceId: input.instanceId,
      targetKind: 'source',
      targetId: input.sourceId,
      sourceKey: input.sourceKey,
      reason: input.reason,
      commandId: input.commandId ?? null,
      now: input.now,
    }),
    db
      .prepare(
        `UPDATE memory_experiences
            SET available = 0, updated_at = ?
          WHERE source_id = ? AND available = 1`,
      )
      .bind(input.now, input.sourceId),
    db
      .prepare(
        `UPDATE memory_contexts
            SET status = 'invalidated', updated_at = ?
          WHERE status = 'ready'
            AND context_id IN (
              SELECT ci.context_id
                FROM memory_context_items ci
                JOIN memory_experiences e ON e.experience_id = ci.experience_id
               WHERE e.source_id = ?
            )`,
      )
      .bind(input.now, input.sourceId),
  ];
}
