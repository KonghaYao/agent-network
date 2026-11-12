/**
 * MF11：稀疏经历读取、当前可用性与 derived frontier。
 *
 * 读取时逐条重验当前空间、成员代次、来源策略与遗忘屏障；summary 永远不会
 * 被合并成 raw 覆盖，frontier 通过枚举真实消息计算，不取 MAX(created_seq)。
 */
import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { getMember, getRoom } from '../storage/queries';
import { nowMs } from '../storage/db';
import type { D1Like } from '../storage/queries';
import {
  countsAsRawCoverage,
  isFullRawCoverage,
  mergeByteRanges,
  type MemoryByteRange,
  type MemoryOriginKind,
  type MemoryProducerKind,
  type MemoryRepresentation,
  type MemoryRepresentationKind,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from './contracts';
import {
  authorizeRepresentationRead,
  isTombstoned,
  requireCurrentMemorySpace,
  roomAccessVersion,
  roomArchived,
} from './access';
import { getSource } from './store';
import { historyBoundary, visibleMessage } from '../domain/room-history';
import type { MemoryExperienceRow, MemoryRepresentationRow, MemorySourceRow } from './rows';
import { loadRepresentationExact, type MemoryExperienceStoreOptions } from './experience-source';

// ---------------------------------------------------------------------------
// 经历读取与覆盖
// ---------------------------------------------------------------------------

export interface MemoryExperienceListItem {
  experience_id: string;
  origin_kind: MemoryOriginKind;
  producer_kind: MemoryProducerKind | null;
  representation_kind: MemoryRepresentationKind;
  origin_room_id: string | null;
  origin_member_generation: number;
  source_id: string | null;
  source_revision: number | null;
  range: MemoryByteRange | null;
  text_sha256: string;
  evidence: 'host_reported_submitted' | 'gateway_observed_submitted' | null;
  capture: MemoryExperienceRow['capture'];
  available: boolean;
  created_at: number;
}

export interface MemoryExperiencePage {
  items: readonly MemoryExperienceListItem[];
  next_cursor: string | null;
  has_more: boolean;
}

function evidenceRankValue(evidence: string | null): number {
  if (evidence === 'gateway_observed_submitted') return 2;
  if (evidence === 'host_reported_submitted') return 1;
  return 0;
}

function experienceListScope(input: {
  spaceId: string;
  ownershipEpoch: number;
  agentId: string;
  roomId: string | null;
  memberGeneration: number | null;
}): string {
  return [
    'memory:experience',
    input.spaceId,
    String(input.ownershipEpoch),
    input.agentId,
    input.roomId ?? '*',
    input.memberGeneration === null ? '*' : String(input.memberGeneration),
  ].join(':');
}

/**
 * 稀疏经历列表。
 *
 * 不把 summary 合并进 raw 范围，也不以最后一个 seq 填洞；这里的过滤只影响
 * 本轮展示，不改变任何消费证据。
 */
export async function listExperiences(
  db: D1Like,
  options: MemoryExperienceStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    targetScope: MemoryTargetScope;
    roomId?: string | null;
    memberGeneration?: number | null;
    originKinds?: readonly MemoryOriginKind[];
    minimumEvidence?: 'host_reported_submitted' | 'gateway_observed_submitted' | null;
    limit?: number;
    cursor?: string | null;
    callerActorId?: string | null;
  },
): Promise<MemoryExperiencePage> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    roomIds: options.roomId ? [options.roomId] : [],
    at,
  });
  if (options.callerActorId && options.callerActorId !== options.agentId) {
    throw new BusinessError('PERMISSION_DENIED', '只有 Agent 自身可读取其输入经历', {
      reason: 'content_reader_required',
    });
  }
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const scope = experienceListScope({
    spaceId: context.space.space_id,
    ownershipEpoch: context.space.ownership_epoch,
    agentId: options.agentId,
    roomId: options.roomId ?? null,
    memberGeneration: options.memberGeneration ?? null,
  });
  const cursor = options.cursor ? decodeCursor(options.cursor, scope) : null;
  const minimumRank =
    options.minimumEvidence === 'gateway_observed_submitted'
      ? 2
      : options.minimumEvidence === 'host_reported_submitted'
        ? 1
        : 0;
  const kinds = options.originKinds?.length ? options.originKinds : null;
  const kindClause = kinds ? `AND e.origin_kind IN (${kinds.map(() => '?').join(', ')})` : '';
  const binds: unknown[] = [
    context.space.space_id,
    context.space.ownership_epoch,
    options.agentId,
    ...(options.roomId ? [options.roomId] : []),
    ...(options.memberGeneration !== null && options.memberGeneration !== undefined
      ? [options.memberGeneration]
      : []),
    ...(kinds ?? []),
    minimumRank,
    ...(cursor ? [cursor.seq, cursor.seq, cursor.key ?? ''] : []),
    limit + 1,
  ];
  const roomClause = options.roomId ? 'AND e.origin_room_id = ?' : '';
  const generationClause =
    options.memberGeneration !== null && options.memberGeneration !== undefined
      ? 'AND e.origin_member_generation = ?'
      : '';
  const cursorClause = cursor
    ? 'AND (e.created_at < ? OR (e.created_at = ? AND e.experience_id < ?))'
    : '';
  const rows = await db
    .prepare(
      `SELECT e.*,
              COALESCE(
                (SELECT MAX(CASE p.evidence
                              WHEN 'gateway_observed_submitted' THEN 2
                              WHEN 'host_reported_submitted' THEN 1
                              ELSE 0 END)
                   FROM memory_experience_proofs p
                  WHERE p.experience_id = e.experience_id),
                CASE e.evidence
                  WHEN 'gateway_observed_submitted' THEN 2
                  WHEN 'host_reported_submitted' THEN 1
                  ELSE 0 END
              ) AS evidence_rank
         FROM memory_experiences e
        WHERE e.space_id = ? AND e.ownership_epoch = ? AND e.agent_actor_id = ?
          ${roomClause}
          ${generationClause}
          ${kindClause}
          AND COALESCE(
                (SELECT MAX(CASE p.evidence
                              WHEN 'gateway_observed_submitted' THEN 2
                              WHEN 'host_reported_submitted' THEN 1
                              ELSE 0 END)
                   FROM memory_experience_proofs p
                  WHERE p.experience_id = e.experience_id),
                CASE e.evidence
                  WHEN 'gateway_observed_submitted' THEN 2
                  WHEN 'host_reported_submitted' THEN 1
                  ELSE 0 END
              ) >= ?
          ${cursorClause}
        ORDER BY e.created_at DESC, e.experience_id DESC
        LIMIT ?`,
    )
    .bind(...binds)
    .all<MemoryExperienceRow & { evidence_rank: number }>();

  const items: MemoryExperienceListItem[] = [];
  for (const row of rows.results) {
    if (items.length >= limit) break;
    if (row.available !== 1) continue;
    const representation = await db
      .prepare('SELECT * FROM memory_representations WHERE representation_id = ?')
      .bind(row.representation_id)
      .first<MemoryRepresentationRow>();
    if (!representation) continue;
    if (await isTombstoned(db, { kind: 'representation', id: row.representation_id })) continue;
    const decision = await authorizeRepresentationRead(db, {
      space: context.space,
      representationId: row.representation_id,
      agentId: options.agentId,
      target_scope: options.targetScope,
      at,
    });
    if (!decision.allowed) continue;
    const maxEvidence =
      row.evidence_rank >= 2
        ? 'gateway_observed_submitted'
        : row.evidence_rank >= 1
          ? 'host_reported_submitted'
          : null;
    items.push({
      experience_id: row.experience_id,
      origin_kind: row.origin_kind,
      producer_kind: row.producer_kind,
      representation_kind: row.representation_kind,
      origin_room_id: row.origin_room_id,
      origin_member_generation: row.origin_member_generation,
      source_id: row.source_id,
      source_revision: row.source_revision,
      range:
        row.range_start === null || row.range_end === null
          ? null
          : { start: row.range_start, end: row.range_end },
      text_sha256: row.text_sha256,
      evidence: maxEvidence,
      capture: row.capture,
      available: true,
      created_at: row.created_at,
    });
  }
  const last = items.at(-1);
  const hasMore = rows.results.length > limit;
  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.experience_id,
            snapshot: at,
          })
        : null,
    has_more: hasMore,
  };
}

export interface MemoryExperienceDetail {
  item: MemoryExperienceListItem;
  representation: MemoryRepresentation;
  text: string;
}

/** 单条经历正文；当前授权/遗忘屏障不通过时不返回 text。 */
export async function getExperience(
  db: D1Like,
  options: MemoryExperienceStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    targetScope: MemoryTargetScope;
    experienceId: string;
    callerActorId?: string | null;
  },
): Promise<
  | { available: true; detail: MemoryExperienceDetail }
  | { available: false; reason: string }
> {
  const at = options.now ?? nowMs();
  if (options.callerActorId && options.callerActorId !== options.agentId) {
    return { available: false, reason: 'content_reader_required' };
  }
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const row = await db
    .prepare('SELECT * FROM memory_experiences WHERE experience_id = ?')
    .bind(options.experienceId)
    .first<MemoryExperienceRow>();
  if (!row) return { available: false, reason: 'not_found' };
  if (
    row.space_id !== context.space.space_id ||
    row.ownership_epoch !== context.space.ownership_epoch ||
    row.agent_actor_id !== options.agentId ||
    row.available !== 1
  ) {
    return { available: false, reason: 'ownership_changed' };
  }
  if (await isTombstoned(db, { kind: 'representation', id: row.representation_id })) {
    return { available: false, reason: 'tombstoned' };
  }
  const decision = await authorizeRepresentationRead(db, {
    space: context.space,
    representationId: row.representation_id,
    agentId: options.agentId,
    target_scope: options.targetScope,
    at,
  });
  if (!decision.allowed) return { available: false, reason: decision.reason };
  const exact = await loadRepresentationExact(db, row.representation_id);
  if (!exact) return { available: false, reason: 'representation_missing' };
  const maxEvidenceRow = await db
    .prepare(
      `SELECT MAX(CASE evidence
                  WHEN 'gateway_observed_submitted' THEN 2
                  WHEN 'host_reported_submitted' THEN 1
                  ELSE 0 END) AS rank
         FROM memory_experience_proofs WHERE experience_id = ?`,
    )
    .bind(row.experience_id)
    .first<{ rank: number | null }>();
  const rank = Math.max(evidenceRankValue(row.evidence), maxEvidenceRow?.rank ?? 0);
  return {
    available: true,
    detail: {
      item: {
        experience_id: row.experience_id,
        origin_kind: row.origin_kind,
        producer_kind: row.producer_kind,
        representation_kind: row.representation_kind,
        origin_room_id: row.origin_room_id,
        origin_member_generation: row.origin_member_generation,
        source_id: row.source_id,
        source_revision: row.source_revision,
        range:
          row.range_start === null || row.range_end === null
            ? null
            : { start: row.range_start, end: row.range_end },
        text_sha256: row.text_sha256,
        evidence:
          rank >= 2
            ? 'gateway_observed_submitted'
            : rank >= 1
              ? 'host_reported_submitted'
              : null,
        capture: row.capture,
        available: true,
        created_at: row.created_at,
      },
      representation: exact.representation,
      text: exact.text,
    },
  };
}

export interface MemoryCoverageView {
  source_id: string;
  source_revision: number;
  ranges: readonly MemoryByteRange[];
  text_bytes: number | null;
  full: boolean;
}

export interface MemoryExperienceCoverage {
  room_id: string;
  member_generation: number;
  sources: readonly MemoryCoverageView[];
  /** 从最早实际消息开始、逐条完整覆盖到的最后一个 seq；没有则为 null。 */
  frontier_seq: number | null;
  first_gap: { message_id: string; created_seq: number } | null;
  actual_messages: number;
}

/**
 * 稀疏原文覆盖与 derived frontier。
 *
 * frontier 逐条枚举真实消息并检查同一 source revision 的完整原文覆盖；
 * 数值空洞不是消息，未消费的真实消息不能被 max(created_seq) 填洞。
 */
export async function experienceCoverage(
  db: D1Like,
  options: MemoryExperienceStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    roomId: string;
    memberGeneration: number;
    sourceId?: string | null;
    sourceRevision?: number | null;
  },
): Promise<MemoryExperienceCoverage> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    roomIds: [options.roomId],
    at,
  });
  const room = await getRoom(db, options.roomId);
  const member = await getMember(db, options.roomId, options.agentId);
  if (!room || !member || member.status !== 'active') {
    return {
      room_id: options.roomId,
      member_generation: options.memberGeneration,
      sources: [],
      frontier_seq: null,
      first_gap: null,
      actual_messages: 0,
    };
  }
  if (member.member_generation !== options.memberGeneration) {
    // 退群重加后旧代次的范围不复制、也不可读。
    return {
      room_id: options.roomId,
      member_generation: options.memberGeneration,
      sources: [],
      frontier_seq: null,
      first_gap: null,
      actual_messages: 0,
    };
  }
  const boundary = historyBoundary(room, member);
  const coverageRows = await db
    .prepare(
      `SELECT source_id, source_revision, range_start, range_end, text_sha256
         FROM memory_coverage_ranges
        WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
          AND origin_room_id = ? AND origin_member_generation = ?
          ${options.sourceId ? 'AND source_id = ?' : ''}
          ${options.sourceRevision === null || options.sourceRevision === undefined ? '' : 'AND source_revision = ?'}
        ORDER BY source_id, source_revision, range_start, range_end`,
    )
    .bind(
      context.space.space_id,
      context.space.ownership_epoch,
      options.agentId,
      options.roomId,
      options.memberGeneration,
      ...(options.sourceId ? [options.sourceId] : []),
      ...(options.sourceRevision === null || options.sourceRevision === undefined
        ? []
        : [options.sourceRevision]),
    )
    .all<{ source_id: string; source_revision: number; range_start: number; range_end: number }>();
  const grouped = new Map<string, { source_id: string; source_revision: number; ranges: MemoryByteRange[] }>();
  for (const row of coverageRows.results) {
    const key = `${row.source_id}|${row.source_revision}`;
    const entry =
      grouped.get(key) ??
      grouped.set(key, {
        source_id: row.source_id,
        source_revision: row.source_revision,
        ranges: [],
      }).get(key)!;
    entry.ranges.push({ start: row.range_start, end: row.range_end });
  }
  const sources: MemoryCoverageView[] = [];
  for (const entry of grouped.values()) {
    if (await isTombstoned(db, { kind: 'source', id: entry.source_id })) continue;
    const source = await getSource(db, entry.source_id, entry.source_revision);
    if (!source || source.state !== 'active') continue;
    const merged = mergeByteRanges(entry.ranges);
    sources.push({
      source_id: entry.source_id,
      source_revision: entry.source_revision,
      ranges: merged,
      text_bytes: source.content_bytes,
      full: source.content_bytes ? isFullRawCoverage(merged, source.content_bytes) : false,
    });
  }

  const messages = await db
    .prepare(
      `SELECT message_id, created_seq
         FROM messages
        WHERE room_id = ? AND created_seq >= ? AND created_seq <= ?
        ORDER BY created_seq ASC`,
    )
    .bind(
      options.roomId,
      boundary.fromSeq,
      boundary.toSeq === null ? room.head_seq : Math.min(room.head_seq, boundary.toSeq),
    )
    .all<{ message_id: string; created_seq: number }>();
  let frontierSeq: number | null = null;
  let firstGap: { message_id: string; created_seq: number } | null = null;
  for (const message of messages.results) {
    if (!visibleMessage(message, boundary)) continue;
    const source = await db
      .prepare(
        `SELECT * FROM memory_sources
          WHERE instance_id = ? AND source_key = ? AND state = 'active'
          LIMIT 1`,
      )
      .bind(context.space.instance_id, `message:${message.message_id}`)
      .first<MemorySourceRow>();
    if (!source || source.content_bytes === null) {
      firstGap = message;
      break;
    }
    const rows = await db
      .prepare(
        `SELECT range_start, range_end FROM memory_coverage_ranges
          WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
            AND origin_room_id = ? AND origin_member_generation = ?
            AND source_id = ? AND source_revision = ?`,
      )
      .bind(
        context.space.space_id,
        context.space.ownership_epoch,
        options.agentId,
        options.roomId,
        options.memberGeneration,
        source.source_id,
        source.revision,
      )
      .all<{ range_start: number; range_end: number }>();
    const complete = isFullRawCoverage(
      rows.results.map((row) => ({ start: row.range_start, end: row.range_end })),
      source.content_bytes,
    );
    if (!complete) {
      firstGap = message;
      break;
    }
    frontierSeq = message.created_seq;
  }
  return {
    room_id: options.roomId,
    member_generation: options.memberGeneration,
    sources,
    frontier_seq: frontierSeq,
    first_gap: firstGap,
    actual_messages: messages.results.length,
  };
}

export async function currentRoomScope(
  db: D1Like,
  roomId: string,
  agentId: string,
): Promise<{ member_generation: number; policy_revision: number; archived: boolean } | null> {
  const version = await roomAccessVersion(db, roomId, agentId);
  if (!version) return null;
  const room = await getRoom(db, roomId);
  return {
    member_generation: version.member_generation,
    policy_revision: version.policy_revision,
    archived: room ? roomArchived(room) : false,
  };
}

/** 原文片段覆盖是否完整；供 UI/补读判断，不从 summary 推断。 */
export async function sourceRawCoverage(
  db: D1Like,
  options: MemoryExperienceStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    sourceId: string;
    sourceRevision: number;
    originRoomId: string;
    memberGeneration: number;
  },
): Promise<MemoryCoverageView> {
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    roomIds: [options.originRoomId],
    at: options.now,
  });
  const room = await getRoom(db, options.originRoomId);
  const member = await getMember(db, options.originRoomId, options.agentId);
  if (
    !room ||
    !member ||
    member.status !== 'active' ||
    member.member_generation !== options.memberGeneration ||
    (await isTombstoned(db, { kind: 'source', id: options.sourceId }))
  ) {
    return {
      source_id: options.sourceId,
      source_revision: options.sourceRevision,
      ranges: [],
      text_bytes: null,
      full: false,
    };
  }
  const rows = await db
    .prepare(
      `SELECT range_start, range_end FROM memory_coverage_ranges
        WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
          AND origin_room_id = ? AND origin_member_generation = ?
          AND source_id = ? AND source_revision = ?
        ORDER BY range_start, range_end`,
    )
    .bind(
      context.space.space_id,
      context.space.ownership_epoch,
      options.agentId,
      options.originRoomId,
      options.memberGeneration,
      options.sourceId,
      options.sourceRevision,
    )
    .all<{ range_start: number; range_end: number }>();
  const ranges = mergeByteRanges(
    rows.results.map((row) => ({ start: row.range_start, end: row.range_end })),
  );
  const source = await getSource(db, options.sourceId, options.sourceRevision);
  if (!source || source.state !== 'active') {
    return {
      source_id: options.sourceId,
      source_revision: options.sourceRevision,
      ranges: [],
      text_bytes: null,
      full: false,
    };
  }
  return {
    source_id: options.sourceId,
    source_revision: options.sourceRevision,
    ranges,
    text_bytes: source.content_bytes,
    full: source.content_bytes ? isFullRawCoverage(ranges, source.content_bytes) : false,
  };
}

/** 是否只有 raw_* 表示能推进覆盖；供断言与后续模块复用。 */
export function representationAdvancesRawCoverage(kind: MemoryRepresentationKind): boolean {
  return countsAsRawCoverage(kind);
}
