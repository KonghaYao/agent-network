/**
 * MF03：Memory 持久账本的高层读写。
 *
 * 这里只组合 access/statements 与事务边界，不包含 MCP/UI。关键不可交换点：
 * - 合格回执、准确经历与获准 retain 意图必须同事务；
 * - 预热/派发/查询返回不能走本模块的 admit 路径；
 * - 迟到回执只补最小历史，不恢复可读正文或新 owner 经历；
 * - 遗忘/撤权先在本地提交逻辑排除，再异步清后端。
 */
import { BusinessError, type BusinessErrorCode } from '../contracts/errors';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  getActiveMemorySpace,
  getLatestMemorySource,
  getMemoryContext,
  getMemoryExperienceByDedupe,
  getMemoryReceiptByIdempotencyKey,
  getMemoryReceiptByInvocation,
  getMemoryRepresentation,
  getMemorySourceRevision,
  listActiveMemoryHostBindingIds,
  memorySpaceExists,
  type D1Like,
} from '../storage/queries';
import {
  MEMORY_POLICY_VERSION,
  countsAsRawCoverage,
  decideExperienceAdmission,
  type MemoryContextDeliveryReceipt,
  type MemoryCrossRoomGrant,
  type MemoryExactRepresentation,
  type MemoryExposureReceipt,
  type MemoryOriginKind,
  type MemoryOwnershipKind,
  type MemoryProducerKind,
  type MemoryReceiptDisposition,
  type MemoryRepresentationKind,
  type MemorySpaceRef,
  type MemorySourceState,
} from './contracts';
import {
  authorizeSourceRead,
  ensureMemoryInstance,
  ensureAgentMemorySpace,
  requireCurrentMemorySpace,
} from './access';
import {
  memoryCoverageStatements,
  memoryExperienceStatements,
  memoryGovernanceCommandStatement,
  memoryJobStatement,
  memoryInitialSpaceStatements,
  memoryInvalidationStatements,
  memoryOwnershipTransferStatements,
  memoryReceiptStatement,
  memoryRetainIntentStatements,
  memorySourceMutationStatements,
  memoryWarmupStatement,
  tombstoneStatement,
  type MemoryExperienceWrite,
  type MemorySourceMutationInput,
} from './statements';
import { memoryRepresentationInsertStatements } from './representation-statements';
import type {
  MemoryGovernanceCommandRow,
  MemoryReceiptRow,
  MemorySourceRow,
  MemorySpaceRow,
} from './rows';

const MEMORY_GUARD_ERRORS: ReadonlyArray<[string, BusinessErrorCode]> = [
  ['guard_permission_denied', 'PERMISSION_DENIED'],
  ['guard_version_conflict', 'VERSION_CONFLICT'],
  ['guard_membership_stale', 'MEMBERSHIP_STALE'],
  ['guard_actor_disabled', 'ACTOR_DISABLED'],
];

/**
 * Memory 独立 batch 的守卫错误映射。
 *
 * 业务事务内的 Memory 意图仍由 `runIdempotent` 统一映射；这里覆盖接纳、
 * 遗忘与独立来源写入，避免服务层把 SQLite CHECK 文本当成未知错误。
 */
export async function runMemoryBatch(
  db: D1Like,
  statements: readonly D1PreparedStatement[],
): Promise<D1Result<unknown>[]> {
  try {
    return await db.batch([...statements]);
  } catch (error) {
    const text = String(error);
    for (const [guard, code] of MEMORY_GUARD_ERRORS) {
      if (text.includes(guard)) {
        throw new BusinessError(code, 'Memory 事务条件已变化，请刷新后重试', {
          guard,
        });
      }
    }
    throw error;
  }
}

export interface MemoryStoreOptions {
  instanceId: string;
  now?: number;
}

export interface MemoryAdmissionExperience {
  experienceId: string;
  /**
   * MF11 经验去重键；省略时沿用 raw 的 representation/range/hash 规则。
   * summary/authored 使用自己的稳定身份，避免新 representation ID 重复制造事实。
   */
  dedupeKey?: string;
  key: {
    space_id: string;
    ownership_epoch: number;
    agent_actor_id: string;
    origin_room_id: string;
    origin_member_generation: number;
    source_id: string | null;
    source_revision: number | null;
    representation_id: string;
    representation_kind: MemoryRepresentationKind;
    range: { start: number; end: number } | null;
    text_sha256: string;
  };
  originKind: MemoryOriginKind;
  producerKind: MemoryProducerKind | null;
  originRoomId: string | null;
  capture?: 'none' | 'pending' | 'extracted' | 'excluded';
}

export interface MemoryAdmissionInput {
  agentId: string;
  space: MemorySpaceRef;
  receipt: MemoryExposureReceipt;
  representations: readonly MemoryExactRepresentation[];
  experiences: readonly MemoryAdmissionExperience[];
  retain?: readonly {
    retainId: string;
    experienceId: string | null;
    representationId: string;
    sourceId: string | null;
    sourceRevision: number | null;
    originKind: MemoryOriginKind;
    evidence: string | null;
  }[];
  minimumEvidence: 'host_reported_submitted' | 'gateway_observed_submitted';
  /** 服务端已核实的跨房披露授权；客户端不能自报。 */
  crossRoomGrant?: MemoryCrossRoomGrant | null;
  now?: number;
}

export interface MemoryAdmissionResult {
  disposition: MemoryReceiptDisposition;
  receipt_id: string;
  experience_ids: readonly string[];
  retain_ids: readonly string[];
  /** 当前权限/遗忘屏障拒绝的项；不产生可读正文或 retain。 */
  denied_experience_ids: readonly string[];
}

/** 首次启用/读取前的 lazy 初始化；业务创建路径另有同事务 statements 版本。 */
export async function ensureSpaceForAgent(
  db: D1Like,
  options: MemoryStoreOptions & { agentId: string; capture?: 'none' | 'pending' | 'excluded' },
): Promise<MemorySpaceRow> {
  return ensureAgentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    now: options.now,
    capture: options.capture,
  });
}

export async function initializeMemoryInstance(
  db: D1Like,
  options: { configuredId?: string | null; now?: number; captureDefault?: 'enabled' | 'disabled' },
): Promise<string> {
  return ensureMemoryInstance(db, options);
}

/**
 * Agent 创建/自注册事务内初始化空间。
 *
 * 调用方已确定 owner（新创建 Agent 的 manager，或自注册 Agent 自身）。
 */
export function initialSpaceStatements(
  db: D1Database,
  input: {
    instanceId: string;
    agentId: string;
    ownerActorId: string;
    ownershipKind: MemoryOwnershipKind;
    managementBindingId: string | null;
    now: number;
    capture?: 'none' | 'pending' | 'excluded';
  },
): D1PreparedStatement[] {
  return memoryInitialSpaceStatements(db, {
    spaceId: newId('msp'),
    transitionId: newId('mtr'),
    instanceId: input.instanceId,
    agentId: input.agentId,
    ownerActorId: input.ownerActorId,
    ownershipKind: input.ownershipKind,
    managementBindingId: input.managementBindingId,
    now: input.now,
    capture: input.capture,
  });
}

/**
 * 认领/管理转让事务内切换活动空间。
 *
 * 调用方应先把当前 active space 读出来；没有则为首次启用。
 */
export async function ownershipTransferStatements(
  db: D1Database,
  input: {
    instanceId: string;
    agentId: string;
    ownerActorId: string;
    ownershipKind: MemoryOwnershipKind;
    managementBindingId: string | null;
    kind: 'initial_claim' | 'management_transfer' | 'initial_enable';
    now: number;
    capture?: 'none' | 'pending' | 'excluded';
  },
): Promise<D1PreparedStatement[]> {
  const previous = await getActiveMemorySpace(db, input.agentId);
  const closed = previous ? await listActiveMemoryHostBindingIds(db, input.agentId) : [];
  return memoryOwnershipTransferStatements(db, {
    previous,
    nextSpaceId: newId('msp'),
    transitionId: newId('mtr'),
    instanceId: input.instanceId,
    agentId: input.agentId,
    ownerActorId: input.ownerActorId,
    ownershipKind: input.ownershipKind,
    managementBindingId: input.managementBindingId,
    kind: input.kind,
    closedHostBindingIds: closed.map((row) => row.binding_id),
    now: input.now,
    capture: input.capture,
  });
}

/** 共享来源登记；业务 batch 与测试共用。 */
export function sourceMutationStatements(
  db: D1Like,
  input: Omit<MemorySourceMutationInput, 'sourceId'> & { sourceId?: string },
): D1PreparedStatement[] {
  return memorySourceMutationStatements(db, {
    ...input,
    sourceId: input.sourceId ?? newId('msrc'),
  });
}

function receiptReasonToDisposition(reason: string | null): MemoryReceiptDisposition['reason'] {
  switch (reason) {
    case 'ownership_changed':
    case 'context_expired':
    case 'source_excluded':
    case 'permission_revoked':
    case 'agent_disabled':
    case 'conflict':
    case 'duplicate':
      return reason;
    default:
      return null;
  }
}

async function loadReceiptByIdempotencyKey(
  db: D1Like,
  key: string,
): Promise<MemoryReceiptRow | null> {
  return getMemoryReceiptByIdempotencyKey(db, key);
}

/**
 * 接纳最终输入回执。
 *
 * 调用前必须先有准确 invariant/manifest；本函数不信任客户端自报的
 * space/evidence。任何当前权限或遗忘屏障拒绝都降级为 history_only/rejected，
 * 不产生可读正文、经历或 retain。
 */
export async function admitExposureReceipt(
  db: D1Like,
  options: MemoryStoreOptions & MemoryAdmissionInput,
): Promise<MemoryAdmissionResult> {
  const at = options.now ?? nowMs();
  const receipt = options.receipt;
  if (receipt.space.space_id !== options.space.space_id) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '回执空间与目标空间不一致', {
      reason: 'space_mismatch',
    });
  }
  const existing = await loadReceiptByIdempotencyKey(db, receipt.idempotency_key);
  if (existing) {
    if (
      existing.receipt_id !== receipt.receipt_id ||
      existing.manifest_sha256 !== receipt.manifest_sha256 ||
      existing.payload_sha256 !== receipt.payload_sha256 ||
      existing.evidence !== receipt.evidence
    ) {
      throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一回执幂等键绑定了不同内容', {
        receipt_id: existing.receipt_id,
      });
    }
    return {
      disposition: {
        receipt_id: existing.receipt_id,
        disposition: existing.disposition,
        reason: existing.reason as MemoryReceiptDisposition['reason'],
      },
      receipt_id: existing.receipt_id,
      experience_ids: [],
      retain_ids: [],
      denied_experience_ids: [],
    };
  }

  const existingInvocation = await getMemoryReceiptByInvocation(db, {
    kind: 'input_exposure',
    spaceId: receipt.space.space_id,
    ownershipEpoch: receipt.space.ownership_epoch,
    agentId: options.agentId,
    hostBindingId: receipt.invocation.host_binding_id,
    invocationId: receipt.invocation.invocation_id,
  });
  if (existingInvocation) {
    if (
      existingInvocation.manifest_sha256 === receipt.manifest_sha256 &&
      existingInvocation.payload_sha256 === receipt.payload_sha256 &&
      existingInvocation.evidence === receipt.evidence
    ) {
      return {
        disposition: {
          receipt_id: existingInvocation.receipt_id,
          disposition: existingInvocation.disposition,
          reason: existingInvocation.reason as MemoryReceiptDisposition['reason'],
        },
        receipt_id: existingInvocation.receipt_id,
        experience_ids: [],
        retain_ids: [],
        denied_experience_ids: [],
      };
    }
    throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一 invocation 已绑定其他输入清单', {
      reason: 'invocation_conflict',
      receipt_id: existingInvocation.receipt_id,
    });
  }

  // 每次接纳都重验当前空间、归属、凭据与成员资格。
  let context;
  try {
    context = await requireCurrentMemorySpace(db, {
      agentId: options.agentId,
      instanceId: options.instanceId,
      expected: options.space,
      roomIds: receipt.origin_scopes.map((scope) => scope.room_id),
      at,
    });
  } catch (error) {
    // 迟到回执只补最小历史，不产生新 owner 可读正文或 retain。
    if (
      error instanceof BusinessError &&
      (error.code === 'MEMORY_TARGET_INVALID' || error.code === 'ACTOR_DISABLED')
    ) {
      const spaceExists = await memorySpaceExists(db, receipt.space.space_id);
      if (!spaceExists) throw error;
      const reason = error.code === 'ACTOR_DISABLED' ? 'agent_disabled' : 'ownership_changed';
      const disposition: MemoryReceiptDisposition = {
        receipt_id: receipt.receipt_id,
        disposition: 'history_only',
        reason,
      };
      await runMemoryBatch(db, [
        memoryReceiptStatement(db, receipt, {
          disposition: disposition.disposition,
          reason: disposition.reason,
          recordedAt: at,
        }),
      ]);
      return {
        disposition,
        receipt_id: receipt.receipt_id,
        experience_ids: [],
        retain_ids: [],
        denied_experience_ids: options.experiences.map((item) => item.experienceId),
      };
    }
    throw error;
  }
  const current = context.space;
  const ownershipCurrent =
    current.space_id === receipt.space.space_id &&
    current.ownership_epoch === receipt.space.ownership_epoch;
  const agentEnabled = context.agent.disabled_at === null;

  const denied: string[] = [];
  const admitted: Array<{
    experience: MemoryAdmissionExperience;
    source: MemorySourceRow | null;
    evidence: string;
  }> = [];
  const exactRepresentations = new Map(
    options.representations.map((exact) => [exact.representation.representation_id, exact.representation]),
  );
  for (const experience of options.experiences) {
    if (experience.key.space_id !== current.space_id || experience.key.ownership_epoch !== current.ownership_epoch) {
      denied.push(experience.experienceId);
      continue;
    }
    const supplied = exactRepresentations.get(experience.key.representation_id);
    const storedRepresentation = supplied
      ? null
      : await getMemoryRepresentation(db, experience.key.representation_id);
    const representation = supplied ?? storedRepresentation;
    if (
      !representation ||
      representation.kind !== experience.key.representation_kind ||
      representation.text_sha256 !== experience.key.text_sha256
    ) {
      denied.push(experience.experienceId);
      continue;
    }
    if (
      (experience.key.representation_kind === 'raw_full' ||
        experience.key.representation_kind === 'raw_fragment' ||
        experience.key.representation_kind === 'preview') &&
      (storedRepresentation
        ? storedRepresentation.source_id !== experience.key.source_id ||
          storedRepresentation.source_revision !== experience.key.source_revision ||
          storedRepresentation.range_start !== (experience.key.range?.start ?? null) ||
          storedRepresentation.range_end !== (experience.key.range?.end ?? null)
        : 'range' in representation &&
          (representation.source_id !== experience.key.source_id ||
            representation.source_revision !== experience.key.source_revision ||
            representation.range.start !== experience.key.range?.start ||
            representation.range.end !== experience.key.range?.end))
    ) {
      denied.push(experience.experienceId);
      continue;
    }
    let source: MemorySourceRow | null = null;
    let sourceState: MemorySourceState = 'active';
    if (experience.key.source_id) {
      source = await getMemorySourceRevision(
        db,
        experience.key.source_id,
        experience.key.source_revision ?? -1,
      );
      if (source) {
        sourceState = source.state;
        const sourceAccess = await authorizeSourceRead(db, {
          space: current,
          source,
          agentId: options.agentId,
          target_scope: receipt.target_scope,
          grant: options.crossRoomGrant ?? null,
          at,
        });
        if (!sourceAccess.allowed) {
          denied.push(experience.experienceId);
          continue;
        }
      } else {
        denied.push(experience.experienceId);
        continue;
      }
    }
    const admission = decideExperienceAdmission({
      origin_kind: experience.originKind,
      submission_state: receipt.evidence,
      minimum_evidence: options.minimumEvidence,
      source_state: sourceState,
      ownership_current: ownershipCurrent,
      agent_enabled: agentEnabled,
      producer_kind: experience.producerKind,
    });
    if (!admission.admitted || !admission.retain_allowed) {
      denied.push(experience.experienceId);
      continue;
    }
    admitted.push({ experience, source, evidence: receipt.evidence });
  }

  const applied = admitted.length > 0;
  const disposition: MemoryReceiptDisposition = {
    receipt_id: receipt.receipt_id,
    disposition: applied ? 'applied' : denied.length > 0 ? 'history_only' : 'rejected',
    reason: applied
      ? null
      : !agentEnabled
        ? 'agent_disabled'
        : !ownershipCurrent
          ? 'ownership_changed'
          : denied.length > 0
            ? 'permission_revoked'
            : null,
  };

  const statements: D1PreparedStatement[] = [
    memoryReceiptStatement(db, receipt, {
      disposition: disposition.disposition,
      reason: disposition.reason,
      recordedAt: at,
    }),
  ];
  for (const exact of options.representations) {
    const representation = exact.representation;
    const bytes = new TextEncoder().encode(exact.text).length;
    if (bytes !== representation.text_bytes || (await sha256Hex(exact.text)) !== representation.text_sha256) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '准确表示与 hash/字节数不一致', {
        reason: 'representation_mismatch',
      });
    }
    const existingRepresentation = await db
      .prepare('SELECT text_sha256 FROM memory_representations WHERE representation_id = ?')
      .bind(representation.representation_id)
      .first<{ text_sha256: string }>();
    if (existingRepresentation && existingRepresentation.text_sha256 !== representation.text_sha256) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '表示 ID 已绑定其他正文', {
        reason: 'representation_conflict',
      });
    }
    statements.push(
      ...memoryRepresentationInsertStatements(db, {
        instanceId: options.instanceId,
        exact,
        dependencies: representation.depends_on,
        now: at,
      }),
    );
  }
  const experienceIds: string[] = [];
  const retainIds: string[] = [];
  const experienceWrites: MemoryExperienceWrite[] = [];
  const coverageWrites: D1PreparedStatement[] = [];
  /** 请求中的临时 experienceId -> 实际持久 experienceId。 */
  const admittedIdMap = new Map<string, string>();
  for (const item of admitted) {
    const experience = item.experience;
    const dedupeKey =
      experience.dedupeKey ??
      [
        'exp',
        current.space_id,
        String(current.ownership_epoch),
        options.agentId,
        experience.originRoomId ?? '',
        String(experience.key.origin_member_generation),
        experience.key.source_id ?? '',
        String(experience.key.source_revision ?? ''),
        experience.key.representation_kind,
        experience.key.representation_id,
        String(experience.key.range?.start ?? ''),
        String(experience.key.range?.end ?? ''),
        experience.key.text_sha256,
      ].join('|');
    const existing = await getMemoryExperienceByDedupe(db, dedupeKey);
    const storedExperienceId = existing?.experience_id ?? experience.experienceId;
    admittedIdMap.set(experience.experienceId, storedExperienceId);
    experienceIds.push(storedExperienceId);
    if (!existing) {
      experienceWrites.push({
        experienceId: experience.experienceId,
        dedupeKey,
        key: experience.key,
        originKind: experience.originKind,
        producerKind: experience.producerKind,
        representationId: experience.key.representation_id,
        representationKind: experience.key.representation_kind,
        receiptId: receipt.receipt_id,
        evidence: item.evidence,
        capture: experience.capture ?? 'pending',
        originRoomId: experience.originRoomId,
        now: at,
      });
    }
    if (
      item.source &&
      experience.originRoomId &&
      experience.key.source_id &&
      experience.key.range &&
      countsAsRawCoverage(experience.key.representation_kind)
    ) {
      coverageWrites.push(
        ...memoryCoverageStatements(db, {
          spaceId: current.space_id,
          ownershipEpoch: current.ownership_epoch,
          agentActorId: options.agentId,
          experienceId: storedExperienceId,
          key: experience.key,
          originRoomId: experience.originRoomId,
          sourceId: experience.key.source_id,
          sourceRevision: experience.key.source_revision ?? 1,
          routeKey: dedupeKey,
          now: at,
        }),
      );
    }
  }
  statements.push(
    ...memoryExperienceStatements(db, {
      spaceId: current.space_id,
      ownershipEpoch: current.ownership_epoch,
      agentActorId: options.agentId,
      items: experienceWrites,
    }),
    ...coverageWrites,
  );

  const admittedIds = new Set(experienceIds);
  for (const intent of options.retain ?? []) {
    if (intent.experienceId && !admittedIdMap.has(intent.experienceId) && !admittedIds.has(intent.experienceId)) {
      continue;
    }
    const storedExperienceId = intent.experienceId
      ? admittedIdMap.get(intent.experienceId) ?? intent.experienceId
      : null;
    const retainId = intent.retainId;
    const payloadHash = await sha256Hex(
      stableStringify({
        space_id: current.space_id,
        ownership_epoch: current.ownership_epoch,
        representation_id: intent.representationId,
        source_id: intent.sourceId,
        source_revision: intent.sourceRevision,
        origin_kind: intent.originKind,
        receipt_id: receipt.receipt_id,
      }),
    );
    retainIds.push(retainId);
    statements.push(
      ...memoryRetainIntentStatements(db, {
        retainId,
        jobId: newId('mjb'),
        spaceId: current.space_id,
        ownershipEpoch: current.ownership_epoch,
        agentActorId: options.agentId,
        originKind: intent.originKind,
        experienceId: storedExperienceId,
        representationId: intent.representationId,
        sourceId: intent.sourceId,
        sourceRevision: intent.sourceRevision,
        receiptId: receipt.receipt_id,
        evidence: intent.evidence,
        policyVersion: MEMORY_POLICY_VERSION,
        operationKey: `${receipt.invocation.invocation_id}:${intent.representationId}:${intent.originKind}`,
        payloadSha256: payloadHash,
        backendBindingEpoch: current.backend_binding_epoch,
        now: at,
      }),
    );
  }

  await runMemoryBatch(db, statements);
  return {
    disposition,
    receipt_id: receipt.receipt_id,
    experience_ids: experienceIds,
    retain_ids: retainIds,
    denied_experience_ids: denied,
  };
}

/** 交付回执只证明宿主拿到包，不产生源输入经历。 */
export async function recordContextDeliveryReceipt(
  db: D1Like,
  options: MemoryStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    receipt: MemoryContextDeliveryReceipt;
    now?: number;
  },
): Promise<MemoryReceiptDisposition> {
  const at = options.now ?? nowMs();
  const existing = await loadReceiptByIdempotencyKey(db, options.receipt.idempotency_key);
  if (existing) {
    if (existing.receipt_id !== options.receipt.receipt_id) {
      throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一交付回执幂等键绑定了不同回执');
    }
    return {
      receipt_id: existing.receipt_id,
      disposition: existing.disposition,
      reason: receiptReasonToDisposition(existing.reason),
    };
  }
  const existingInvocation = await getMemoryReceiptByInvocation(db, {
    kind: 'context_delivery',
    spaceId: options.space.space_id,
    ownershipEpoch: options.space.ownership_epoch,
    agentId: options.agentId,
    hostBindingId: options.receipt.invocation.host_binding_id,
    invocationId: options.receipt.invocation.invocation_id,
  });
  if (existingInvocation) {
    if (
      existingInvocation.context_id === options.receipt.context_id &&
      existingInvocation.context_sha256 === options.receipt.context_sha256
    ) {
      return {
        receipt_id: existingInvocation.receipt_id,
        disposition: existingInvocation.disposition,
        reason: receiptReasonToDisposition(existingInvocation.reason),
      };
    }
    throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一 invocation 已绑定其他 Context', {
      reason: 'invocation_conflict',
      receipt_id: existingInvocation.receipt_id,
    });
  }
  try {
    await requireCurrentMemorySpace(db, {
      agentId: options.agentId,
      instanceId: options.instanceId,
      expected: options.space,
      at,
    });
  } catch (error) {
    if (
      error instanceof BusinessError &&
      (error.code === 'MEMORY_TARGET_INVALID' || error.code === 'ACTOR_DISABLED')
    ) {
      const spaceExists = await memorySpaceExists(db, options.receipt.space.space_id);
      if (!spaceExists) throw error;
      const reason = error.code === 'ACTOR_DISABLED' ? 'agent_disabled' : 'ownership_changed';
      const disposition: MemoryReceiptDisposition = {
        receipt_id: options.receipt.receipt_id,
        disposition: 'history_only',
        reason,
      };
      await runMemoryBatch(db, [
        memoryReceiptStatement(db, options.receipt, {
          disposition: disposition.disposition,
          reason: disposition.reason,
          recordedAt: at,
        }),
      ]);
      return disposition;
    }
    throw error;
  }
  const context = await getMemoryContext(db, options.receipt.context_id);
  const expired =
    !context || context.status !== 'ready' || (context.expires_at !== null && context.expires_at < at);
  const disposition: MemoryReceiptDisposition = {
    receipt_id: options.receipt.receipt_id,
    disposition: expired ? 'history_only' : 'applied',
    reason: expired ? 'context_expired' : null,
  };
  await runMemoryBatch(db, [
    memoryReceiptStatement(db, options.receipt, {
      disposition: disposition.disposition,
      reason: disposition.reason,
      recordedAt: at,
    }),
  ]);
  return disposition;
}

export async function getSource(
  db: D1Like,
  sourceId: string,
  revision?: number,
): Promise<MemorySourceRow | null> {
  if (revision !== undefined) {
    return getMemorySourceRevision(db, sourceId, revision);
  }
  return getLatestMemorySource(db, sourceId);
}

/**
 * 遗忘/撤回：本地逻辑排除与治理命令同事务。
 *
 * 不删除来源行或回执；tombstone 永久保留，后端清理异步进行。
 */
export async function applyMemoryForget(
  db: D1Like,
  options: MemoryStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    sourceId: string;
    sourceKey: string | null;
    reason: 'recall' | 'forget' | 'permission' | 'file_deleted' | 'policy';
    commandId?: string;
    tombstoneId?: string;
    now?: number;
  },
): Promise<{ command_id: string; disposition: 'applied' | 'duplicate' }> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const commandId = options.commandId ?? newId('mcmd');
  const idempotencyKey = `forget:${options.sourceId}:${options.reason}`;
  const existing = await db
    .prepare(
      'SELECT command_id, status FROM memory_governance_commands WHERE space_id = ? AND idempotency_key = ?',
    )
    .bind(context.space.space_id, idempotencyKey)
    .first<Pick<MemoryGovernanceCommandRow, 'command_id' | 'status'>>();
  if (existing) {
    return {
      command_id: existing.command_id,
      disposition: existing.status === 'applied' ? 'duplicate' : 'applied',
    };
  }
  const payloadHash = await sha256Hex(
    stableStringify({
      source_id: options.sourceId,
      source_key: options.sourceKey,
      reason: options.reason,
    }),
  );
  const source = await getSource(db, options.sourceId);
  const removeTarget =
    source?.source_id && source.revision
      ? [
          {
            kind: 'source_revision' as const,
            source: { source_id: source.source_id, source_revision: source.revision },
          },
        ]
      : null;
  await runMemoryBatch(db, [
    memoryGovernanceCommandStatement(db, {
      commandId,
      spaceId: context.space.space_id,
      mutationKind: options.reason === 'recall' ? 'source_retract' : 'forget',
      targetKind: 'source',
      targetId: options.sourceId,
      targetRevision: source?.revision ?? null,
      payloadSha256: payloadHash,
      idempotencyKey,
      status: 'applied',
      now: at,
    }),
    ...memoryInvalidationStatements(db, {
      tombstoneId: options.tombstoneId ?? newId('mtb'),
      instanceId: options.instanceId,
      sourceId: options.sourceId,
      sourceKey: options.sourceKey,
      reason: options.reason,
      commandId,
      now: at,
    }),
    memoryJobStatement(db, {
      jobId: newId('mjb'),
      spaceId: context.space.space_id,
      ownershipEpoch: context.space.ownership_epoch,
      agentActorId: options.agentId,
      operationType: 'remove',
      operationKey: `remove:${options.sourceId}:${options.reason}`,
      payloadSha256: payloadHash,
      sourceCommandId: commandId,
      targetJson: removeTarget ? JSON.stringify(removeTarget) : null,
      backendBindingEpoch: context.space.backend_binding_epoch,
      now: at,
    }),
  ]);
  return { command_id: commandId, disposition: 'applied' };
}

/** 当前可读的 Context；正文只在所有依赖仍获准且未被遗忘时返回。 */
/** 预热资格写入；不产生个人经历或 retain。 */
export function warmupStatements(
  db: D1Database,
  input: {
    space: MemorySpaceRow;
    agentId: string;
    requestKey: string;
    mode: string;
    dispatch: 'explicit' | 'auto';
    targetJson: string;
    now: number;
  },
): D1PreparedStatement[] {
  return [
    memoryWarmupStatement(db, {
      recallId: newId('mrc'),
      spaceId: input.space.space_id,
      ownershipEpoch: input.space.ownership_epoch,
      agentActorId: input.agentId,
      requestKey: input.requestKey,
      mode: input.mode,
      dispatch: input.dispatch,
      targetJson: input.targetJson,
      now: input.now,
    }),
  ];
}

export { tombstoneStatement };
