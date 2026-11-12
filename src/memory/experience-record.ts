/**
 * MF11：authored 与 curated 独立类别（从 experience.ts 拆出，保持 1000 行上限）。
 *
 * 只处理自身发布与人工保存，不产生 input_exposure，也不推进原文覆盖。
 */
import { BusinessError } from '../contracts/errors';
import { newId, nowMs, sha256Hex } from '../storage/db';
import type { D1Like } from '../storage/queries';
import type {
  MemoryExactRepresentation,
  MemorySpaceRef,
  MemoryTargetScope,
} from './contracts';
import { authorizeSourceRead, requireCurrentMemorySpace } from './access';
import { getSource, runMemoryBatch } from './store';
import { memoryRepresentationInsertStatements } from './representation-statements';
import { assertExactRepresentation, experienceDedupeKey, type MemoryExperienceStoreOptions } from './experience-source';

// ---------------------------------------------------------------------------
// authored / curated 独立类别
// ---------------------------------------------------------------------------

/**
 * 自身发布记录。
 *
 * 只有 source.author 与本 Agent 一致、producer_kind 明确的 authored 表示才能
 * 写入；它不推进原文覆盖，也不伪造 input_exposure。
 */
export async function recordAuthoredExperience(
  db: D1Like,
  options: MemoryExperienceStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    targetScope: MemoryTargetScope;
    exact: MemoryExactRepresentation;
    sourceId: string;
    sourceRevision: number;
    originRoomId: string;
    originMemberGeneration: number;
    experienceId?: string;
  },
): Promise<string> {
  const at = options.now ?? nowMs();
  const representation = options.exact.representation;
  if (representation.kind !== 'authored') {
    throw new BusinessError('MEMORY_TARGET_INVALID', '只有 authored 表示可写发布记录', {
      reason: 'not_authored_representation',
    });
  }
  await assertExactRepresentation(options.exact);
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    roomIds: [options.originRoomId],
    at,
  });
  const source = await getSource(db, options.sourceId, options.sourceRevision);
  if (!source) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '发布来源不存在', { reason: 'source_missing' });
  }
  if (source.author_actor_id !== options.agentId) {
    throw new BusinessError('PERMISSION_DENIED', '只能登记本 Agent 自身发布的记录', {
      reason: 'author_mismatch',
    });
  }
  const decision = await authorizeSourceRead(db, {
    space: context.space,
    source,
    agentId: options.agentId,
    target_scope: options.targetScope,
    at,
  });
  if (!decision.allowed) {
    throw new BusinessError('PERMISSION_DENIED', '当前无权登记该发布记录', {
      reason: decision.reason,
    });
  }
  const dedupeKey = experienceDedupeKey({
    spaceId: context.space.space_id,
    ownershipEpoch: context.space.ownership_epoch,
    agentId: options.agentId,
    originRoomId: options.originRoomId,
    memberGeneration: options.originMemberGeneration,
    originKind: 'authored',
    representation,
  });
  const existing = await db
    .prepare('SELECT experience_id FROM memory_experiences WHERE dedupe_key = ?')
    .bind(dedupeKey)
    .first<{ experience_id: string }>();
  if (existing) return existing.experience_id;
  const experienceId = options.experienceId ?? newId('mexp');
  await runMemoryBatch(db, [
    ...memoryRepresentationInsertStatements(db, {
      instanceId: options.instanceId,
      exact: options.exact,
      dependencies: representation.depends_on,
      now: at,
    }),
    db
      .prepare(
        `INSERT INTO memory_experiences
           (experience_id, dedupe_key, space_id, ownership_epoch, agent_actor_id,
            origin_room_id, origin_member_generation, origin_kind, producer_kind,
            source_id, source_revision, representation_id, representation_kind,
            range_start, range_end, text_sha256, receipt_id, evidence, capture,
            available, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'authored', ?, ?, ?, ?, 'authored',
                NULL, NULL, ?, NULL, NULL, 'none', 1, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM memory_experiences WHERE dedupe_key = ?)`,
      )
      .bind(
        experienceId,
        dedupeKey,
        context.space.space_id,
        context.space.ownership_epoch,
        options.agentId,
        options.originRoomId,
        options.originMemberGeneration,
        representation.producer_kind,
        options.sourceId,
        options.sourceRevision,
        representation.representation_id,
        representation.text_sha256,
        at,
        at,
        dedupeKey,
      ),
  ]);
  const stored = await db
    .prepare('SELECT experience_id FROM memory_experiences WHERE dedupe_key = ?')
    .bind(dedupeKey)
    .first<{ experience_id: string }>();
  return stored?.experience_id ?? experienceId;
}

export interface MemoryCuratedRecord {
  curated_id: string;
  revision: number;
  title: string;
  content: string;
  content_sha256: string;
  origin: 'manual' | 'imported_external_knowledge';
  created_at: number;
  updated_at: number;
}

/**
 * 人工明确保存的资料。
 *
 * curated 不属于 experienced；它不产生原文覆盖，也不冒充 Agent 曾阅读群消息。
 * 该函数只维护 memory_curated，不创建 memory_experiences。
 */
export async function saveCuratedMemory(
  db: D1Like,
  options: MemoryExperienceStoreOptions & {
    agentId: string;
    ownerActorId: string;
    space: MemorySpaceRef;
    curatedId?: string;
    expectedRevision?: number;
    title: string;
    content: string;
    origin?: 'manual' | 'imported_external_knowledge';
  },
): Promise<MemoryCuratedRecord> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const curatedId = options.curatedId ?? newId('mcur');
  const current = await db
    .prepare('SELECT revision FROM memory_curated WHERE curated_id = ? AND current = 1')
    .bind(curatedId)
    .first<{ revision: number }>();
  const nextRevision = (current?.revision ?? 0) + 1;
  if (options.expectedRevision !== undefined && options.expectedRevision !== (current?.revision ?? 0)) {
    throw new BusinessError('VERSION_CONFLICT', 'curated 修订已变化', {
      expected: options.expectedRevision,
      actual: current?.revision ?? 0,
    });
  }
  const contentSha = await sha256Hex(options.content);
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
        options.origin ?? 'manual',
        options.title,
        options.content,
        contentSha,
        options.ownerActorId,
        at,
        at,
      ),
  );
  await runMemoryBatch(db, statements);
  return {
    curated_id: curatedId,
    revision: nextRevision,
    title: options.title,
    content: options.content,
    content_sha256: contentSha,
    origin: options.origin ?? 'manual',
    created_at: at,
    updated_at: at,
  };
}

/** 当前有效的 curated 列表；与 experienced 稀疏经历分开返回。 */
export async function listCuratedMemories(
  db: D1Like,
  options: MemoryExperienceStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
  },
): Promise<readonly MemoryCuratedRecord[]> {
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
  });
  const rows = await db
    .prepare(
      `SELECT curated_id, revision, title, content, content_sha256, origin, created_at, updated_at
         FROM memory_curated
        WHERE space_id = ? AND ownership_epoch = ? AND current = 1
        ORDER BY updated_at DESC`,
    )
    .bind(context.space.space_id, context.space.ownership_epoch)
    .all<{
      curated_id: string;
      revision: number;
      title: string;
      content: string;
      content_sha256: string;
      origin: 'manual' | 'imported_external_knowledge';
      created_at: number;
      updated_at: number;
    }>();
  return rows.results;
}

/** 兼容旧读取路径：当前成员代次与策略是否仍与计划/范围一致。 */
