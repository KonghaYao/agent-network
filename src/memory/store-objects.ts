/**
 * Memory 对象的读取与宿主绑定（MF03）。
 *
 * 与 store.ts 的接纳/治理窗口分开，避免单个模块超过仓库 1000 行上限。
 * 所有读取仍通过 access.ts 重验当前空间、成员代次、策略与遗忘屏障。
 */
import { BusinessError } from '../contracts/errors';
import { newId, nowMs, sha256Hex } from '../storage/db';
import type { D1Like } from '../storage/queries';
import {
  countsAsRawCoverage,
  isFullRawCoverage,
  isValidByteRange,
  mergeByteRanges,
  type MemoryExactRepresentation,
  type MemoryOwnershipKind,
  type MemorySpaceRef,
  type MemorySourceDependency,
  type MemoryTargetScope,
} from './contracts';
import {
  assertContentReaderActor,
  authorizeRepresentationRead,
  ensureAgentMemorySpace,
  isTombstoned,
  loadMemoryAccessVersions,
  requireCurrentMemorySpace,
  resolveCurrentOwner,
} from './access';
import { getActiveManagement } from '../domain/agent-access';
import { getSource } from './store';
import { memoryRepresentationInsertStatements } from './representation-statements';
import type {
  MemoryContextRow,
  MemoryExperienceRow,
  MemoryRepresentationRow,
  MemorySpaceRow,
} from './rows';

export interface MemoryStoreOptions {
  instanceId: string;
  now?: number;
}

/**
 * 写入/核对准确表示。
 *
 * hash/字节数不符直接拒绝；同一 representation_id 已绑定其他正文时冲突，
 * 不允许静默覆盖准确输入。
 */
export async function registerRepresentation(
  db: D1Like,
  options: {
    instanceId: string;
    exact: MemoryExactRepresentation;
    dependencies?: readonly MemorySourceDependency[];
    now?: number;
  },
): Promise<void> {
  const at = options.now ?? nowMs();
  const representation = options.exact.representation;
  const actualBytes = new TextEncoder().encode(options.exact.text).length;
  if (actualBytes !== representation.text_bytes) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '表示字节数与准确文本不一致', {
      reason: 'representation_bytes_mismatch',
    });
  }
  const actualHash = await sha256Hex(options.exact.text);
  if (actualHash !== representation.text_sha256) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '表示 hash 与准确文本不一致', {
      reason: 'representation_hash_mismatch',
    });
  }
  if (
    representation.kind === 'raw_full' ||
    representation.kind === 'raw_fragment' ||
    representation.kind === 'preview'
  ) {
    if (!isValidByteRange(representation.range, representation.text_bytes)) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'raw 表示的字节范围非法', {
        reason: 'invalid_byte_range',
      });
    }
  }
  const existing = await db
    .prepare('SELECT text_sha256 FROM memory_representations WHERE representation_id = ?')
    .bind(representation.representation_id)
    .first<Pick<MemoryRepresentationRow, 'text_sha256'>>();
  if (existing) {
    if (existing.text_sha256 !== representation.text_sha256) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '表示 ID 已绑定其他正文', {
        reason: 'representation_conflict',
      });
    }
    return;
  }
  const statements = memoryRepresentationInsertStatements(db, {
    instanceId: options.instanceId,
    exact: options.exact,
    dependencies: options.dependencies ?? representation.depends_on ?? [],
    now: at,
  });
  await db.batch(statements);
}

/** 当前可读的 Context；正文只在所有依赖仍获准且未被遗忘时返回。 */
export async function readMemoryContext(
  db: D1Like,
  options: MemoryStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    contextId: string;
    targetScope: MemoryTargetScope;
    callerActorId?: string;
  },
): Promise<
  | { available: true; context: MemoryContextRow }
  | { available: false; reason: string; context: MemoryContextRow | null }
> {
  const at = options.now ?? nowMs();
  if (options.callerActorId) {
    await assertContentReaderActor(db, options.callerActorId, options.agentId);
  }
  const context = await db
    .prepare('SELECT * FROM memory_contexts WHERE context_id = ?')
    .bind(options.contextId)
    .first<MemoryContextRow>();
  if (!context) return { available: false, reason: 'not_found', context: null };
  const spatial = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  if (
    context.space_id !== spatial.space.space_id ||
    context.ownership_epoch !== spatial.space.ownership_epoch ||
    context.agent_actor_id !== options.agentId
  ) {
    return { available: false, reason: 'ownership_changed', context };
  }
  if (context.status !== 'ready') return { available: false, reason: context.status, context };
  if (context.expires_at !== null && context.expires_at < at) {
    return { available: false, reason: 'expired', context };
  }
  // 受众切换必须使用干净分支：私聊 Context 不能因一次请求改投群，反之亦然。
  let storedTarget: Partial<MemoryTargetScope> = {};
  try {
    storedTarget = context.target_json ? (JSON.parse(context.target_json) as MemoryTargetScope) : {};
  } catch {
    storedTarget = {};
  }
  if (options.targetScope.audience === 'room') {
    if (
      storedTarget.audience !== 'room' ||
      storedTarget.room_id !== options.targetScope.room_id ||
      storedTarget.member_generation !== options.targetScope.member_generation ||
      storedTarget.policy_revision !== options.targetScope.policy_revision
    ) {
      return { available: false, reason: 'invalid_target', context };
    }
  } else if (storedTarget.audience === 'room') {
    return { available: false, reason: 'invalid_target', context };
  }
  if (await isTombstoned(db, { kind: 'context', id: context.context_id })) {
    return { available: false, reason: 'tombstoned', context };
  }
  const items = await db
    .prepare(
      'SELECT representation_id FROM memory_context_items WHERE context_id = ? ORDER BY item_index',
    )
    .bind(context.context_id)
    .all<{ representation_id: string }>();
  for (const item of items.results) {
    const decision = await authorizeRepresentationRead(db, {
      space: spatial.space,
      representationId: item.representation_id,
      agentId: options.agentId,
      target_scope: options.targetScope,
      at,
    });
    if (!decision.allowed) return { available: false, reason: decision.reason, context };
  }
  return { available: true, context };
}

/** 经历读取；summary-only 不会显示成原文全读。 */
export async function readMemoryExperience(
  db: D1Like,
  options: MemoryStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    experienceId: string;
    targetScope: MemoryTargetScope;
    callerActorId?: string;
  },
): Promise<
  | { available: true; experience: MemoryExperienceRow; representation: MemoryRepresentationRow }
  | { available: false; reason: string; experience: MemoryExperienceRow | null }
> {
  const at = options.now ?? nowMs();
  if (options.callerActorId) {
    await assertContentReaderActor(db, options.callerActorId, options.agentId);
  }
  const experience = await db
    .prepare('SELECT * FROM memory_experiences WHERE experience_id = ?')
    .bind(options.experienceId)
    .first<MemoryExperienceRow>();
  if (!experience) return { available: false, reason: 'not_found', experience: null };
  const spatial = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  if (
    experience.space_id !== spatial.space.space_id ||
    experience.ownership_epoch !== spatial.space.ownership_epoch ||
    experience.agent_actor_id !== options.agentId ||
    experience.available !== 1
  ) {
    return { available: false, reason: 'ownership_changed', experience };
  }
  const representation = await db
    .prepare('SELECT * FROM memory_representations WHERE representation_id = ?')
    .bind(experience.representation_id)
    .first<MemoryRepresentationRow>();
  if (!representation) return { available: false, reason: 'representation_missing', experience };
  if (await isTombstoned(db, { kind: 'representation', id: representation.representation_id })) {
    return { available: false, reason: 'tombstoned', experience };
  }
  const decision = await authorizeRepresentationRead(db, {
    space: spatial.space,
    representationId: representation.representation_id,
    agentId: options.agentId,
    target_scope: options.targetScope,
    at,
  });
  if (!decision.allowed) return { available: false, reason: decision.reason, experience };
  return { available: true, experience, representation };
}

export interface MemoryCoverageSummary {
  source_id: string;
  source_revision: number;
  origin_room_id: string;
  origin_member_generation: number;
  ranges: readonly { start: number; end: number }[];
  text_bytes: number | null;
  full: boolean;
}

/**
 * 稀疏覆盖按 member generation 隔离。
 *
 * 权限扩张不会回填历史消费；退群重加使用新 generation，旧范围不会复制
 * 到新代次。返回的是已证明提交的 raw 范围，不含 preview/summary。
 */
export async function coverageForSource(
  db: D1Like,
  options: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    sourceId: string;
    sourceRevision: number;
    originRoomId: string;
    originMemberGeneration: number;
  },
): Promise<MemoryCoverageSummary> {
  const rows = await db
    .prepare(
      `SELECT range_start, range_end
         FROM memory_coverage_ranges
        WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
          AND origin_room_id = ? AND origin_member_generation = ?
          AND source_id = ? AND source_revision = ?
        ORDER BY range_start, range_end`,
    )
    .bind(
      options.spaceId,
      options.ownershipEpoch,
      options.agentId,
      options.originRoomId,
      options.originMemberGeneration,
      options.sourceId,
      options.sourceRevision,
    )
    .all<{ range_start: number; range_end: number }>();
  const ranges = mergeByteRanges(
    rows.results.map((row) => ({ start: row.range_start, end: row.range_end })),
  );
  const source = await getSource(db, options.sourceId, options.sourceRevision);
  return {
    source_id: options.sourceId,
    source_revision: options.sourceRevision,
    origin_room_id: options.originRoomId,
    origin_member_generation: options.originMemberGeneration,
    ranges,
    text_bytes: source?.content_bytes ?? null,
    full: source?.content_bytes ? isFullRawCoverage(ranges, source.content_bytes) : false,
  };
}

/**
 * 宿主绑定由服务端签发；能力声明只协商能力，不提高信任等级。
 * 该函数只供服务端代码路径调用，不接收 MCP 客户端自报 trusted 布尔值。
 */
export async function bindMemoryHost(
  db: D1Like,
  options: MemoryStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    credentialId: string;
    sessionIncarnation: string;
    declaredCapabilities: readonly string[];
    trustLevel: 'api_tool_only' | 'adapted_host' | 'controlled_gateway';
    leaseUntil: number | null;
  },
): Promise<{ binding_id: string; generation: number }> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const previous = await db
    .prepare(
      "SELECT binding_id, generation FROM memory_host_bindings WHERE space_id = ? AND session_incarnation = ? AND state = 'active'",
    )
    .bind(context.space.space_id, options.sessionIncarnation)
    .first<{ binding_id: string; generation: number }>();
  const bindingId = newId('mhb');
  const generation = (previous?.generation ?? 0) + 1;
  const statements: D1PreparedStatement[] = [];
  if (previous) {
    statements.push(
      db
        .prepare(
          "UPDATE memory_host_bindings SET state = 'closed', closed_at = ?, updated_at = ? WHERE binding_id = ?",
        )
        .bind(at, at, previous.binding_id),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO memory_host_bindings
           (binding_id, space_id, ownership_epoch, agent_actor_id, credential_id,
            generation, session_incarnation, declared_capabilities_json, trust_level,
            state, lease_until, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
      )
      .bind(
        bindingId,
        context.space.space_id,
        context.space.ownership_epoch,
        options.agentId,
        options.credentialId,
        generation,
        options.sessionIncarnation,
        JSON.stringify(options.declaredCapabilities),
        options.trustLevel,
        options.leaseUntil,
        at,
        at,
      ),
  );
  await db.batch(statements);
  return { binding_id: bindingId, generation };
}

export async function closeMemoryHostBindings(
  db: D1Like,
  options: { agentId: string; spaceId?: string; now?: number },
): Promise<number> {
  const at = options.now ?? nowMs();
  const result = await db
    .prepare(
      `UPDATE memory_host_bindings
          SET state = 'closed', closed_at = ?, updated_at = ?
        WHERE agent_actor_id = ? AND state = 'active'
          AND (? IS NULL OR space_id = ?)`,
    )
    .bind(at, at, options.agentId, options.spaceId ?? null, options.spaceId ?? null)
    .run();
  return result.meta.changes;
}

/** 管理快照只返回元数据；不含正文、摘要或来源标题。 */
export async function memorySpaceSnapshot(
  db: D1Like,
  options: MemoryStoreOptions & { agentId: string },
): Promise<{
  space_id: string;
  ownership_epoch: number;
  owner_actor_id: string;
  ownership_kind: MemoryOwnershipKind;
  capture: string;
  active: boolean;
  current_owner: string;
}> {
  const management = await getActiveManagement(db, options.agentId);
  const owner = resolveCurrentOwner(options.agentId, management);
  const space = await ensureAgentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    now: options.now,
  });
  const versions = await loadMemoryAccessVersions(db, {
    agentId: options.agentId,
    management,
    credentialRevokedAt: null,
    roomIds: [],
  });
  void versions;
  return {
    space_id: space.space_id,
    ownership_epoch: space.ownership_epoch,
    owner_actor_id: space.owner_actor_id,
    ownership_kind: space.ownership_kind,
    capture: space.capture,
    active: space.active === 1,
    current_owner: owner.owner_actor_id,
  };
}

/** 测试/诊断：当前 active space 的元数据。 */
export async function currentSpaceRow(
  db: D1Like,
  agentId: string,
): Promise<MemorySpaceRow | null> {
  return db
    .prepare('SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1')
    .bind(agentId)
    .first<MemorySpaceRow>();
}
