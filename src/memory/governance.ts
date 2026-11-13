/**
 * MF06：人工记忆、来源列表与治理操作。
 *
 * 所有对象按当前 space/ownership 重验；source 读取仍走 authorizeSourceRead，
 * curated 只允许 Agent 自身凭据读写。forget 先本地逻辑排除，再异步清理后端；
 * 无法解析到可重放目标时返回 unsupported_granularity，不扩大删除范围。
 */
import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  getCurrentCuratedRevision,
  getMemoryExperience,
  getRoom,
  listCurrentCuratedMemories,
  type D1Like,
} from '../storage/queries';
import {
  type MemoryAvailability,
  type MemoryCuratedId,
  type MemoryGovernanceAction,
  type MemoryGovernanceResult,
  type MemoryOperationStage,
  type MemoryOperationStatus,
  type MemoryPurgeState,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from './contracts';
import type { MemoryCuratedRecord } from './experience-record';
import {
  authorizeSourceRead,
  requireCurrentMemorySpace,
  roomAccessVersion,
} from './access';
import { getSource, applyMemoryForget } from './store';
import {
  memoryGovernanceCommandStatement,
  memoryJobStatement,
  tombstoneStatement,
} from './statements';
import { targetScopeForRoom } from './target';
import type {
  MemoryExperienceRow,
  MemoryGovernanceCommandRow,
  MemorySourceRow,
} from './rows';

export interface MemoryGovernanceStoreOptions {
  instanceId: string;
  agentId: string;
  space: MemorySpaceRef;
  now?: number;
}

async function sourceScopeForRead(
  db: D1Like,
  agentId: string,
  source: MemorySourceRow,
): Promise<MemoryTargetScope[]> {
  if (!source.origin_room_id) return [];
  const room = await getRoom(db, source.origin_room_id);
  if (!room) return [];
  if (room.kind === 'direct') {
    return [
      {
        audience: 'agent_private',
        room_id: null,
        member_generation: null,
        member_seq: null,
        policy_revision: null,
      },
    ];
  }
  const version = await roomAccessVersion(db, source.origin_room_id, agentId);
  if (!version) return [];
  return [targetScopeForRoom(room, version)];
}

async function sourceReadable(
  db: D1Like,
  options: MemoryGovernanceStoreOptions,
  source: MemorySourceRow,
): Promise<boolean> {
  const scopes = await sourceScopeForRead(db, options.agentId, source);
  for (const scope of scopes) {
    const decision = await authorizeSourceRead(db, {
      space: options.space,
      source,
      agentId: options.agentId,
      target_scope: scope,
      at: options.now,
    });
    if (decision.allowed) return true;
  }
  return false;
}


async function sourceInAgentMemory(
  db: D1Like,
  options: MemoryGovernanceStoreOptions,
  sourceId: string,
  revision: number,
): Promise<boolean> {
  const hit = await db
    .prepare(
      `SELECT 1 AS hit FROM memory_experiences
        WHERE source_id = ? AND source_revision = ?
          AND space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
       UNION ALL
       SELECT 1 AS hit
         FROM memory_selections sel
         JOIN memory_representations r ON r.representation_id = sel.representation_id
        WHERE r.source_id = ? AND r.source_revision = ?
          AND sel.space_id = ? AND sel.ownership_epoch = ? AND sel.agent_actor_id = ?
       LIMIT 1`,
    )
    .bind(
      sourceId,
      revision,
      options.space.space_id,
      options.space.ownership_epoch,
      options.agentId,
      sourceId,
      revision,
      options.space.space_id,
      options.space.ownership_epoch,
      options.agentId,
    )
    .first<{ hit: number }>();
  return hit !== null;
}

// ---------------------------------------------------------------------------
// 来源与 curated 列表
// ---------------------------------------------------------------------------

export interface MemorySourceListItem {
  source_id: string;
  source_kind: string;
  revision: number;
  state: string;
  origin_room_id: string | null;
  author_actor_id: string | null;
  content_sha256: string | null;
  content_bytes: number | null;
  created_at: number;
  available: boolean;
}

export async function listMemorySources(
  db: D1Like,
  options: MemoryGovernanceStoreOptions & { limit?: number; cursor?: string | null },
): Promise<{ items: readonly MemorySourceListItem[]; next_cursor: string | null; has_more: boolean }> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const scope = `memory:sources:${context.space.space_id}:${context.space.ownership_epoch}`;
  const cursor = options.cursor ? decodeCursor(options.cursor, scope) : null;
  const cursorSql = cursor ? 'AND (s.created_at < ? OR (s.created_at = ? AND s.source_id < ?))' : '';
  const cursorBindings = cursor ? [cursor.seq, cursor.seq, cursor.key] : [];
  const rows = await db
    .prepare(
      `SELECT s.* FROM memory_sources s
        WHERE s.instance_id = ?
          AND (
            EXISTS (
              SELECT 1 FROM memory_experiences e
               WHERE e.source_id = s.source_id
                 AND e.space_id = ? AND e.ownership_epoch = ? AND e.agent_actor_id = ?
            )
            OR EXISTS (
              SELECT 1 FROM memory_selections sel
                JOIN memory_representations r ON r.representation_id = sel.representation_id
               WHERE r.source_id = s.source_id AND r.source_revision = s.revision
                 AND sel.space_id = ? AND sel.ownership_epoch = ? AND sel.agent_actor_id = ?
            )
          )
          ${cursorSql}
        ORDER BY s.created_at DESC, s.source_id DESC
        LIMIT ?`,
    )
    .bind(
      options.instanceId,
      context.space.space_id,
      context.space.ownership_epoch,
      options.agentId,
      context.space.space_id,
      context.space.ownership_epoch,
      options.agentId,
      ...cursorBindings,
      limit + 1,
    )
    .all<MemorySourceRow>();
  const hasMore = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const items: MemorySourceListItem[] = [];
  for (const source of page) {
    items.push({
      source_id: source.source_id,
      source_kind: source.source_kind,
      revision: source.revision,
      state: source.state,
      origin_room_id: source.origin_room_id,
      author_actor_id: source.author_actor_id,
      content_sha256: source.content_sha256,
      content_bytes: source.content_bytes,
      created_at: source.created_at,
      available: source.state === 'active' && (await sourceReadable(db, { ...options, now: at }, source)),
    });
  }
  const last = page.at(-1);
  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.source_id,
            snapshot: at,
          })
        : null,
    has_more: hasMore,
  };
}

export interface MemorySourceDetail {
  source: MemorySourceListItem;
  content_text: string | null;
  content_sha256: string | null;
  representation_kinds: readonly string[];
  reason: string | null;
}

export async function getMemorySourceDetail(
  db: D1Like,
  options: MemoryGovernanceStoreOptions & { sourceId: string; revision?: number },
): Promise<MemorySourceDetail> {
  const at = options.now ?? nowMs();
  await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const source = await getSource(db, options.sourceId, options.revision);
  if (!source) {
    throw new BusinessError('NOT_FOUND', 'Memory 来源不存在', { source_id: options.sourceId });
  }
  if (!(await sourceInAgentMemory(db, options, source.source_id, source.revision))) {
    throw new BusinessError('NOT_FOUND', 'Memory 来源不属于当前 Agent', {
      reason: 'source_not_in_agent_memory',
    });
  }
  const readable = source.state === 'active' && (await sourceReadable(db, options, source));
  const representations = await db
    .prepare(
      `SELECT DISTINCT e.representation_kind AS kind
         FROM memory_experiences e
        WHERE e.source_id = ? AND e.source_revision = ?
          AND e.space_id = ? AND e.ownership_epoch = ? AND e.agent_actor_id = ?`,
    )
    .bind(
      source.source_id,
      source.revision,
      options.space.space_id,
      options.space.ownership_epoch,
      options.agentId,
    )
    .all<{ kind: string }>();
  return {
    source: {
      source_id: source.source_id,
      source_kind: source.source_kind,
      revision: source.revision,
      state: source.state,
      origin_room_id: source.origin_room_id,
      author_actor_id: source.author_actor_id,
      content_sha256: source.content_sha256,
      content_bytes: source.content_bytes,
      created_at: source.created_at,
      available: readable,
    },
    content_text: readable ? source.content_text : null,
    content_sha256: readable ? source.content_sha256 : null,
    representation_kinds: representations.results.map((row) => row.kind),
    reason: readable ? null : source.state === 'active' ? 'permission_denied' : 'source_not_active',
  };
}

export async function listMemoryCurated(
  db: D1Like,
  options: MemoryGovernanceStoreOptions & { limit?: number },
): Promise<readonly MemoryCuratedRecord[]> {
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at: options.now,
  });
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const rows = await listCurrentCuratedMemories(
    db,
    context.space.space_id,
    context.space.ownership_epoch,
    limit,
  );
  return rows;
}

export async function getMemoryCurated(
  db: D1Like,
  options: MemoryGovernanceStoreOptions & { curatedId: string; revision?: number },
): Promise<MemoryCuratedRecord | null> {
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at: options.now,
  });
  const row = await db
    .prepare(
      `SELECT curated_id, revision, title, content, content_sha256, origin, created_at, updated_at
         FROM memory_curated
        WHERE curated_id = ? AND space_id = ? AND ownership_epoch = ?
          AND (? IS NULL OR revision = ?)
        ORDER BY revision DESC LIMIT 1`,
    )
    .bind(
      options.curatedId,
      context.space.space_id,
      context.space.ownership_epoch,
      options.revision ?? null,
      options.revision ?? null,
    )
    .first<MemoryCuratedRecord>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// put / correct
// ---------------------------------------------------------------------------

export interface MemoryPutCuratedInput {
  request_id: string;
  title: string;
  content: string;
  curated_id?: MemoryCuratedId;
  expected_revision?: number;
  origin?: 'manual' | 'imported_external_knowledge';
}

interface GovernanceCommandResultRow {
  command_id: string;
  payload_sha256: string;
  status: string;
  result_json: string | null;
}

async function findCommand(
  db: D1Like,
  spaceId: string,
  idempotencyKey: string,
): Promise<GovernanceCommandResultRow | null> {
  return db
    .prepare(
      `SELECT command_id, payload_sha256, status, result_json
         FROM memory_governance_commands
        WHERE space_id = ? AND idempotency_key = ?`,
    )
    .bind(spaceId, idempotencyKey)
    .first<GovernanceCommandResultRow>();
}

export async function putMemoryCurated(
  db: D1Like,
  options: MemoryGovernanceStoreOptions & MemoryPutCuratedInput,
): Promise<{
  curated: MemoryCuratedRecord;
  operation_id: string | null;
  status: MemoryAvailability;
  duplicate: boolean;
}> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const isCorrect = options.curated_id !== undefined;
  const idempotencyKey = `${isCorrect ? 'correct' : 'put'}:${options.request_id}`;
  const payloadHash = await sha256Hex(
    stableStringify({
      title: options.title,
      content: options.content,
      curated_id: options.curated_id ?? null,
      expected_revision: options.expected_revision ?? null,
    }),
  );
  const existing = await findCommand(db, context.space.space_id, idempotencyKey);
  if (existing) {
    if (existing.payload_sha256 !== payloadHash) {
      throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一 request_id 绑定了不同记忆内容', {
        command_id: existing.command_id,
      });
    }
    if (existing.result_json) {
      try {
        const result = JSON.parse(existing.result_json) as {
          curated: MemoryCuratedRecord;
          operation_id: string | null;
        };
        return {
          curated: result.curated,
          operation_id: result.operation_id ?? existing.command_id,
          status: existing.status === 'applied' ? 'ready' : 'pending',
          duplicate: true,
        };
      } catch {
        // 回退到当前行
      }
    }
  }
  const curatedId = options.curated_id ?? newId('mcur');
  const current = await getCurrentCuratedRevision(db, curatedId);
  if (isCorrect && !current) {
    throw new BusinessError('NOT_FOUND', 'curated 记忆不存在', { curated_id: curatedId });
  }
  if (options.expected_revision !== undefined && options.expected_revision !== (current?.revision ?? 0)) {
    throw new BusinessError('VERSION_CONFLICT', 'curated 修订已变化', {
      expected: options.expected_revision,
      actual: current?.revision ?? 0,
    });
  }
  const nextRevision = (current?.revision ?? 0) + 1;
  const contentSha = await sha256Hex(options.content);
  const commandId = newId('mcmd');
  const record: MemoryCuratedRecord = {
    curated_id: curatedId,
    revision: nextRevision,
    title: options.title,
    content: options.content,
    content_sha256: contentSha,
    origin: options.origin ?? 'manual',
    created_at: at,
    updated_at: at,
  };
  const statements: D1PreparedStatement[] = [];
  if (current) {
    statements.push(
      db
        .prepare('UPDATE memory_curated SET current = 0, updated_at = ? WHERE curated_id = ? AND current = 1')
        .bind(at, curatedId),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO memory_curated
           (curated_id, revision, space_id, ownership_epoch, origin, title, content,
            content_sha256, current, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        curatedId,
        nextRevision,
        context.space.space_id,
        context.space.ownership_epoch,
        record.origin,
        record.title,
        record.content,
        contentSha,
        options.agentId,
        at,
        at,
      ),
    memoryGovernanceCommandStatement(db, {
      commandId,
      spaceId: context.space.space_id,
      mutationKind: isCorrect ? 'curated_correct' : 'curated_put',
      targetKind: 'curated',
      targetId: curatedId,
      targetRevision: nextRevision,
      payloadSha256: payloadHash,
      idempotencyKey,
      status: 'applied',
      resultJson: JSON.stringify({ curated: record, operation_id: commandId }),
      now: at,
    }),
  );
  await db.batch(statements);
  return {
    curated: record,
    operation_id: commandId,
    status: 'ready',
    duplicate: false,
  };
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

export type MemoryForgetTargetInput =
  | { kind: 'source'; source_id: string; source_revision?: number }
  | { kind: 'curated'; curated_id: string; revision: number }
  | { kind: 'experience'; experience_id: string };

async function representationRemoveTarget(
  db: D1Like,
  experience: MemoryExperienceRow,
): Promise<{
  kind: 'representation';
  source: { source_id: string; source_revision: number };
  representation_id: string;
  range: { start: number; end: number } | null;
} | null> {
  if (
    experience.representation_kind !== 'raw_full' &&
    experience.representation_kind !== 'raw_fragment' &&
    experience.representation_kind !== 'preview'
  ) {
    return null;
  }
  if (!experience.source_id || experience.source_revision === null) return null;
  const source = await getSource(db, experience.source_id, experience.source_revision);
  if (!source) return null;
  return {
    kind: 'representation',
    source: { source_id: source.source_id, source_revision: source.revision },
    representation_id: experience.representation_id,
    range:
      experience.range_start === null || experience.range_end === null
        ? null
        : { start: experience.range_start, end: experience.range_end },
  };
}

export async function forgetMemory(
  db: D1Like,
  options: MemoryGovernanceStoreOptions & {
    request_id: string;
    target: MemoryForgetTargetInput;
  },
): Promise<MemoryGovernanceResult> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const idempotencyKey = `forget:${options.request_id}`;
  const existing = await findCommand(db, context.space.space_id, idempotencyKey);
  if (existing) {
    return {
      request_id: options.request_id,
      operation_id: existing.command_id,
      status: existing.status === 'applied' ? 'pending' : 'pending',
      purge: 'unknown',
    };
  }
  if (options.target.kind === 'source') {
    const source = await getSource(db, options.target.source_id, options.target.source_revision);
    if (!source) {
      throw new BusinessError('MEMORY_UNSUPPORTED_GRANULARITY', '无法解析到可重放的来源目标', {
        reason: 'source_target_missing',
      });
    }
    if (!(await sourceInAgentMemory(db, options, source.source_id, source.revision))) {
      throw new BusinessError('MEMORY_UNSUPPORTED_GRANULARITY', '来源不属于当前 Agent 的记忆', {
        reason: 'source_not_in_agent_memory',
      });
    }
    if (!(await sourceReadable(db, options, source))) {
      throw new BusinessError('PERMISSION_DENIED', '当前无权遗忘该来源');
    }
    const commandId = newId('mcmd');
    const result = await applyMemoryForget(db, {
      instanceId: options.instanceId,
      agentId: options.agentId,
      space: context.space,
      sourceId: source.source_id,
      sourceKey: source.source_key,
      reason: 'forget',
      commandId,
      now: at,
    });
    const job = await db
      .prepare(
        `SELECT job_id FROM memory_jobs
          WHERE space_id = ? AND operation_key = ? LIMIT 1`,
      )
      .bind(context.space.space_id, `remove:${source.source_id}:forget`)
      .first<{ job_id: string }>();
    return {
      request_id: options.request_id,
      operation_id: job?.job_id ?? result.command_id,
      status: 'pending',
      purge: 'unknown',
    };
  }
  if (options.target.kind === 'curated') {
    const row = await db
      .prepare(
        `SELECT curated_id, revision FROM memory_curated
          WHERE curated_id = ? AND space_id = ? AND ownership_epoch = ? AND current = 1`,
      )
      .bind(options.target.curated_id, context.space.space_id, context.space.ownership_epoch)
      .first<{ curated_id: string; revision: number }>();
    if (!row || row.revision !== options.target.revision) {
      throw new BusinessError('MEMORY_UNSUPPORTED_GRANULARITY', 'curated 目标无法精确解析', {
        reason: 'curated_revision_mismatch',
      });
    }
    const commandId = newId('mcmd');
    const jobId = newId('mjb');
    const payloadHash = await sha256Hex(
      stableStringify({ curated_id: row.curated_id, revision: row.revision, action: 'forget' }),
    );
    await db.batch([
      memoryGovernanceCommandStatement(db, {
        commandId,
        spaceId: context.space.space_id,
        mutationKind: 'forget',
        targetKind: 'curated',
        targetId: row.curated_id,
        targetRevision: row.revision,
        payloadSha256: payloadHash,
        idempotencyKey,
        status: 'applied',
        resultJson: JSON.stringify({ operation_id: jobId }),
        now: at,
      }),
      tombstoneStatement(db, {
        tombstoneId: newId('mtb'),
        instanceId: options.instanceId,
        targetKind: 'curated',
        targetId: row.curated_id,
        sourceKey: null,
        reason: 'forget',
        commandId,
        now: at,
      }),
      db
        .prepare('UPDATE memory_curated SET current = 0, updated_at = ? WHERE curated_id = ? AND current = 1')
        .bind(at, row.curated_id),
      memoryJobStatement(db, {
        jobId,
        spaceId: context.space.space_id,
        ownershipEpoch: context.space.ownership_epoch,
        agentActorId: options.agentId,
        operationType: 'remove',
        operationKey: `remove:curated:${row.curated_id}:${row.revision}`,
        payloadSha256: payloadHash,
        sourceCommandId: commandId,
        targetJson: JSON.stringify([
          { kind: 'curated', curated_id: row.curated_id, revision: row.revision },
        ]),
        backendBindingEpoch: context.space.backend_binding_epoch,
        now: at,
      }),
    ]);
    return {
      request_id: options.request_id,
      operation_id: jobId,
      status: 'pending',
      purge: 'unknown',
    };
  }
  const experience = await getMemoryExperience(db, options.target.experience_id);
  if (
    !experience ||
    experience.space_id !== context.space.space_id ||
    experience.ownership_epoch !== context.space.ownership_epoch ||
    experience.agent_actor_id !== options.agentId
  ) {
    throw new BusinessError('MEMORY_UNSUPPORTED_GRANULARITY', '经历目标无法精确解析', {
      reason: 'experience_target_missing',
    });
  }
  const removeTarget = await representationRemoveTarget(db, experience);
  if (!removeTarget) {
    throw new BusinessError('MEMORY_UNSUPPORTED_GRANULARITY', '该经历类型不能精确清除到来源/片段', {
      reason: 'unsupported_representation_granularity',
      representation_kind: experience.representation_kind,
    });
  }
  const commandId = newId('mcmd');
  const jobId = newId('mjb');
  const payloadHash = await sha256Hex(
    stableStringify({ representation_id: experience.representation_id, action: 'forget' }),
  );
  await db.batch([
    memoryGovernanceCommandStatement(db, {
      commandId,
      spaceId: context.space.space_id,
      mutationKind: 'forget',
      targetKind: 'representation',
      targetId: experience.representation_id,
      targetRevision: experience.source_revision,
      payloadSha256: payloadHash,
      idempotencyKey,
      status: 'applied',
      resultJson: JSON.stringify({ operation_id: jobId }),
      now: at,
    }),
    tombstoneStatement(db, {
      tombstoneId: newId('mtb'),
      instanceId: options.instanceId,
      targetKind: 'representation',
      targetId: experience.representation_id,
      sourceKey: null,
      reason: 'forget',
      commandId,
      now: at,
    }),
    db
      .prepare(
        `UPDATE memory_experiences
            SET available = 0, updated_at = ?
          WHERE representation_id = ?
            AND space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?`,
      )
      .bind(
        at,
        experience.representation_id,
        context.space.space_id,
        context.space.ownership_epoch,
        options.agentId,
      ),
    db
      .prepare(
        `UPDATE memory_contexts
            SET status = 'invalidated', updated_at = ?
          WHERE status = 'ready'
            AND space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
            AND context_id IN (
              SELECT context_id FROM memory_context_items WHERE representation_id = ?
            )`,
      )
      .bind(
        at,
        context.space.space_id,
        context.space.ownership_epoch,
        options.agentId,
        experience.representation_id,
      ),
    memoryJobStatement(db, {
      jobId,
      spaceId: context.space.space_id,
      ownershipEpoch: context.space.ownership_epoch,
      agentActorId: options.agentId,
      operationType: 'remove',
      operationKey: `remove:representation:${experience.representation_id}`,
      payloadSha256: payloadHash,
      sourceCommandId: commandId,
      targetJson: JSON.stringify([removeTarget]),
      backendBindingEpoch: context.space.backend_binding_epoch,
      now: at,
    }),
  ]);
  return {
    request_id: options.request_id,
    operation_id: jobId,
    status: 'pending',
    purge: 'unknown',
  };
}

// ---------------------------------------------------------------------------
// 操作状态
// ---------------------------------------------------------------------------

interface MemoryJobStatusRow {
  job_id: string;
  operation_type: 'ensure_space' | 'source_apply' | 'retain' | 'remove' | 'recall' | 'rebuild';
  status: 'pending' | 'leased' | 'completed' | 'failed' | 'unknown' | 'cancelled';
  stage: 'accepted' | 'source_applied' | 'derived_ready' | 'unknown';
  attempt: number;
  last_error: string | null;
  result_json: string | null;
  updated_at: number;
}

export async function getMemoryOperation(
  db: D1Like,
  options: MemoryGovernanceStoreOptions & { operationId: string },
): Promise<MemoryOperationStatus | null> {
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at: options.now,
  });
  const job = await db
    .prepare(
      `SELECT job_id, operation_type, status, stage, attempt, last_error, result_json, updated_at
         FROM memory_jobs
        WHERE job_id = ? AND space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?`,
    )
    .bind(
      options.operationId,
      context.space.space_id,
      context.space.ownership_epoch,
      options.agentId,
    )
    .first<MemoryJobStatusRow>();
  if (job) {
    if (job.operation_type === 'rebuild' || job.operation_type === 'source_apply') {
      return null;
    }
    let purge: MemoryPurgeState | null = null;
    if (job.result_json) {
      try {
        const parsed = JSON.parse(job.result_json) as { purge?: MemoryPurgeState };
        purge = parsed.purge ?? null;
      } catch {
        purge = null;
      }
    }
    const unsupported = job.last_error?.includes('unsupported') ?? false;
    const availability: MemoryAvailability =
      job.status === 'completed'
        ? 'ready'
        : job.status === 'pending' || job.status === 'leased'
          ? 'pending'
          : unsupported
            ? 'unsupported'
            : 'unavailable';
    return {
      operation_id: job.job_id,
      action: job.operation_type,
      stage: job.stage as MemoryOperationStage,
      availability,
      purge,
      retryable: job.status === 'failed' && job.attempt < LIMITS.memoryJobMaxAttempts,
      error: job.status === 'failed' ? (unsupported ? 'MEMORY_UNSUPPORTED' : 'MEMORY_UNAVAILABLE') : null,
    };
  }
  const command = await db
    .prepare(
      `SELECT command_id, mutation_kind, status, target_kind, target_id
         FROM memory_governance_commands
        WHERE command_id = ? AND space_id = ?`,
    )
    .bind(options.operationId, context.space.space_id)
    .first<MemoryGovernanceCommandRow>();
  if (!command) return null;
  const action: MemoryGovernanceAction | 'ensure_space' | 'retain' | 'recall' | 'remove' =
    command.mutation_kind === 'curated_put'
      ? 'put'
      : command.mutation_kind === 'curated_correct'
        ? 'correct'
        : command.mutation_kind === 'forget' || command.mutation_kind === 'source_retract'
          ? 'forget'
          : 'put';
  return {
    operation_id: command.command_id,
    action,
    stage: command.status === 'applied' ? 'source_applied' : 'accepted',
    availability: command.status === 'applied' ? 'ready' : 'pending',
    purge: null,
    retryable: false,
    error: command.status === 'failed' ? 'MEMORY_UNAVAILABLE' : null,
  };
}

/** 当前空间的状态摘要；不返回正文、来源或 provider 路由。 */
export async function memoryStatusSnapshot(
  db: D1Like,
  options: MemoryGovernanceStoreOptions & {
    captureEnabled: boolean;
    runtimeAvailable: boolean;
    hostLevel: string;
    supportedHostModes: readonly string[];
  },
): Promise<{
  enabled: boolean;
  capture: boolean;
  space_id: string;
  ownership_epoch: number;
  backend_binding_epoch: number;
  host_level: string;
  supported_host_modes: readonly string[];
  modes: readonly string[];
  counts: { jobs_pending: number; jobs_unknown: number; jobs_failed: number; retain_pending: number; contexts_ready: number };
  unsupported: readonly string[];
}> {
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at: options.now,
  });
  const jobs = await db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM memory_jobs
        WHERE space_id = ? AND ownership_epoch = ?
        GROUP BY status`,
    )
    .bind(context.space.space_id, context.space.ownership_epoch)
    .all<{ status: string; n: number }>();
  const byStatus = new Map(jobs.results.map((row) => [row.status, row.n]));
  const retain = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM memory_retain_intents
        WHERE space_id = ? AND ownership_epoch = ? AND status IN ('pending','leased')`,
    )
    .bind(context.space.space_id, context.space.ownership_epoch)
    .first<{ n: number }>();
  const contexts = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM memory_contexts
        WHERE space_id = ? AND ownership_epoch = ? AND status = 'ready'`,
    )
    .bind(context.space.space_id, context.space.ownership_epoch)
    .first<{ n: number }>();
  return {
    enabled: options.runtimeAvailable,
    capture: options.captureEnabled,
    space_id: context.space.space_id,
    ownership_epoch: context.space.ownership_epoch,
    backend_binding_epoch: context.space.backend_binding_epoch,
    host_level: options.hostLevel,
    supported_host_modes: options.supportedHostModes,
    modes: ['bootstrap', 'related', 'task', 'lookup', 'reflect'],
    counts: {
      jobs_pending: (byStatus.get('pending') ?? 0) + (byStatus.get('leased') ?? 0),
      jobs_unknown: byStatus.get('unknown') ?? 0,
      jobs_failed: byStatus.get('failed') ?? 0,
      retain_pending: retain?.n ?? 0,
      contexts_ready: contexts?.n ?? 0,
    },
    unsupported: options.runtimeAvailable ? ['task_target', 'auto_injection'] : ['all'],
  };
}

