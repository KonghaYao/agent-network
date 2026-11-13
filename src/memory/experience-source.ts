/**
 * MF11：分群经历、稀疏原文范围与来源选择。
 *
 * 关键边界：
 * - 经历只由合格 ExposureReceipt 接纳；本模块的 SourceSelection 只是“可供输入”。
 * - 每个 Agent 的私聊/群聊按 space + ownership + origin room + member generation
 *   独立；退群重加的新代次不会复制旧游标。
 * - raw 片段必须能回放到同一 source revision 的准确 UTF-8 字节；summary /
 *   preview / memory_context 不推进原文覆盖。
 */
import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import {
  getLatestMemorySource,
  getMemoryRepresentation,
  listMemoryRepresentationDependencies,
  type D1Like,
} from '../storage/queries';
import { newId, nowMs, sha256Hex } from '../storage/db';
import {
  isValidByteRange,
  type MemoryByteRange,
  type MemoryCrossRoomGrant,
  type MemoryExactRepresentation,
  type MemoryOriginKind,
  type MemoryOriginScope,
  type MemorySourceDependency,
  type MemorySourceSelection,
  type MemorySpaceRef,
  type MemoryTargetScope,
  type MemoryRepresentation,
} from './contracts';
import {
  authorizeRepresentationRead,
  authorizeSourceRead,
  requireCurrentMemorySpace,
} from './access';
import { getSource, runMemoryBatch } from './store';
import { registerRepresentation } from './store-objects';
import type { MemoryRepresentationRow, MemorySourceRow } from './rows';

export interface MemoryExperienceStoreOptions {
  instanceId: string;
  now?: number;
}

// ---------------------------------------------------------------------------
// 准确表示与 UTF-8 字节范围
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * 解码半开 UTF-8 字节范围；端点落在码点中间时返回 null。
 *
 * 直接用 TextDecoder(fatal) 验证边界，避免用字符下标近似字节范围。
 */
export function decodeUtf8Range(text: string, range: MemoryByteRange): string | null {
  const bytes = encoder.encode(text);
  if (!isValidByteRange(range, bytes.length)) return null;
  const slice = bytes.slice(range.start, range.end);
  try {
    return fatalDecoder.decode(slice);
  } catch {
    return null;
  }
}

function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

export async function assertExactRepresentation(exact: MemoryExactRepresentation): Promise<void> {
  const representation = exact.representation;
  const actualBytes = utf8Bytes(exact.text);
  if (actualBytes !== representation.text_bytes) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '表示字节数与准确文本不一致', {
      reason: 'representation_bytes_mismatch',
    });
  }
  if ((await sha256Hex(exact.text)) !== representation.text_sha256) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '表示 hash 与准确文本不一致', {
      reason: 'representation_hash_mismatch',
    });
  }
  if (representation.kind === 'raw_full') {
    if (
      !isValidByteRange(representation.range, representation.text_bytes) ||
      representation.range.start !== 0 ||
      representation.range.end !== representation.text_bytes
    ) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'raw_full 字节范围非法', {
        reason: 'invalid_byte_range',
      });
    }
  } else if (representation.kind === 'raw_fragment' || representation.kind === 'preview') {
    // 片段 range 是来源正文的偏移，不是片段自身长度；来源核对在
    // assertRawRepresentationMatchesSource 内完成。
    if (
      !Number.isInteger(representation.range.start) ||
      !Number.isInteger(representation.range.end) ||
      representation.range.start < 0 ||
      representation.range.end <= representation.range.start
    ) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '片段字节范围非法', {
        reason: 'invalid_byte_range',
      });
    }
  }
}

/**
 * 用来源正文核对 raw 表示。
 *
 * 只有同一 source revision 的准确字节切片才能成为 raw 证据；预览无法证明
 * 为原文切片时仍可作为 preview 输入，但永远不推进原文覆盖。
 */
export async function assertRawRepresentationMatchesSource(
  db: D1Like,
  exact: MemoryExactRepresentation,
): Promise<MemorySourceRow> {
  const representation = exact.representation;
  if (
    representation.kind !== 'raw_full' &&
    representation.kind !== 'raw_fragment' &&
    representation.kind !== 'preview'
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '不是 raw/preview 表示', {
      reason: 'not_raw_representation',
    });
  }
  const source = await getSource(db, representation.source_id, representation.source_revision);
  if (!source) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '来源修订不存在', {
      reason: 'source_missing',
    });
  }
  if (source.state !== 'active') {
    throw new BusinessError('MEMORY_TARGET_INVALID', '来源已失效', {
      reason: 'source_not_active',
      source_state: source.state,
    });
  }
  if (source.content_text === null) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '来源没有可恢复正文，不能证明准确字节', {
      reason: 'source_content_missing',
      source_id: source.source_id,
    });
  }
  const sourceBytes = encoder.encode(source.content_text);
  if (!isValidByteRange(representation.range, sourceBytes.length)) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '片段范围超出来源正文', {
      reason: 'fragment_out_of_bounds',
      source_id: source.source_id,
    });
  }
  const slice = decodeUtf8Range(source.content_text, representation.range);
  if (slice === null) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '片段端点不在 UTF-8 码点边界', {
      reason: 'invalid_utf8_boundary',
      source_id: source.source_id,
    });
  }
  if (representation.kind === 'raw_full') {
    if (
      representation.range.start !== 0 ||
      representation.range.end !== sourceBytes.length ||
      slice !== exact.text ||
      source.content_bytes !== sourceBytes.length
    ) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'raw_full 没有覆盖完整来源正文', {
        reason: 'raw_full_mismatch',
        source_id: source.source_id,
      });
    }
    return source;
  }
  if (representation.kind === 'raw_fragment') {
    if (slice !== exact.text) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'raw_fragment 与来源字节不一致', {
        reason: 'fragment_mismatch',
        source_id: source.source_id,
      });
    }
    return source;
  }
  // preview：只有 verbatim 且是原文前缀时才可作为原文片段；否则只是变换表示。
  if (representation.verbatim) {
    if (representation.range.start !== 0 || slice !== exact.text) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'verbatim preview 不是原文前缀', {
        reason: 'preview_mismatch',
        source_id: source.source_id,
      });
    }
  }
  return source;
}

// ---------------------------------------------------------------------------
// 表示读取与去重键
// ---------------------------------------------------------------------------

function representationFromRow(
  row: MemoryRepresentationRow,
  dependsOn: readonly MemorySourceDependency[],
): MemoryRepresentation | null {
  const base = {
    representation_id: row.representation_id,
    text_bytes: row.text_bytes,
    text_sha256: row.text_sha256,
    verbatim: row.verbatim === 1,
  };
  switch (row.kind) {
    case 'raw_full':
    case 'raw_fragment':
    case 'preview':
      if (row.source_id === null || row.source_revision === null || row.range_start === null || row.range_end === null) {
        return null;
      }
      return {
        ...base,
        kind: row.kind,
        source_id: row.source_id,
        source_revision: row.source_revision,
        range: { start: row.range_start, end: row.range_end },
        depends_on: dependsOn,
      };
    case 'summary':
      if (row.summary_id === null || row.summary_revision === null) return null;
      return {
        ...base,
        kind: 'summary',
        summary_id: row.summary_id,
        revision: row.summary_revision,
        depends_on: dependsOn,
        partition_proof:
          row.partition_id === null
            ? null
            : {
                partition_id: row.partition_id,
                generation: row.partition_generation ?? 0,
                policy_revision: row.partition_policy_revision ?? 0,
                source_ids: [...new Set(dependsOn.map((dependency) => dependency.source_id))],
              },
      };
    case 'memory_context':
      if (row.source_context_id === null) return null;
      return {
        ...base,
        kind: 'memory_context',
        source_context_id: row.source_context_id,
        depends_on: dependsOn,
      };
    case 'authored':
      if (row.source_id === null || row.source_revision === null || row.producer_kind === null || row.lineage === null) {
        return null;
      }
      return {
        ...base,
        kind: 'authored',
        source_id: row.source_id,
        source_revision: row.source_revision,
        producer_kind: row.producer_kind,
        lineage: row.lineage,
        depends_on: dependsOn,
      };
    default:
      return null;
  }
}

export async function loadRepresentationExact(
  db: D1Like,
  representationId: string,
): Promise<MemoryExactRepresentation | null> {
  const row = await getMemoryRepresentation(db, representationId);
  if (!row) return null;
  const dependencies = await listMemoryRepresentationDependencies(db, representationId);
  const dependsOn: MemorySourceDependency[] = dependencies.map((dependency) => ({
    source_id: dependency.source_id,
    source_revision: dependency.source_revision,
    representation_id: dependency.depends_on_representation_id,
    range:
      dependency.range_start === null || dependency.range_end === null
        ? null
        : { start: dependency.range_start, end: dependency.range_end },
  }));
  const representation = representationFromRow(row, dependsOn);
  if (!representation) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '表示行缺少必要字段', {
      reason: 'representation_corrupt',
      representation_id: representationId,
    });
  }
  return { representation, text: row.text };
}

/**
 * 经历去重键。
 *
 * raw 使用 representation/range/hash；summary 使用自己的 summary_id/revision；
 * authored 使用来源修订与 producer；memory_context 使用来源 context。这样
 * 同一摘要多次代表不会因新的 representation ID 重复制造独立事实。
 */
export function experienceDedupeKey(input: {
  spaceId: string;
  ownershipEpoch: number;
  agentId: string;
  originRoomId: string | null;
  memberGeneration: number;
  originKind: MemoryOriginKind;
  representation: MemoryRepresentation;
}) {
  const representation = input.representation;
  const identity =
    representation.kind === 'summary'
      ? ['summary', representation.summary_id, String(representation.revision)]
      : representation.kind === 'memory_context'
        ? ['context', representation.source_context_id]
        : representation.kind === 'authored'
          ? [
              'authored',
              representation.source_id,
              String(representation.source_revision),
              representation.producer_kind,
            ]
          : [
              'raw',
              representation.source_id,
              String(representation.source_revision),
              representation.kind,
              representation.representation_id,
              String(representation.range.start),
              String(representation.range.end),
            ];
  return [
    'exp',
    input.spaceId,
    String(input.ownershipEpoch),
    input.agentId,
    input.originRoomId ?? '',
    String(input.memberGeneration),
    input.originKind,
    ...identity,
    representation.text_sha256,
  ].join('|');
}

// ---------------------------------------------------------------------------
// 可供输入的选择（不是消费）
// ---------------------------------------------------------------------------

export interface MemoryCreateSelectionsInput {
  instanceId: string;
  agentId: string;
  space: MemorySpaceRef;
  targetScope: MemoryTargetScope;
  representations: readonly MemoryExactRepresentation[];
  recallId?: string | null;
  grant?: MemoryCrossRoomGrant | null;
  now?: number;
}

export async function createSourceSelections(
  db: D1Like,
  input: MemoryCreateSelectionsInput,
): Promise<MemorySourceSelection[]> {
  const at = input.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: input.agentId,
    instanceId: input.instanceId,
    expected: input.space,
    at,
  });
  const roomScopes = new Set<string>();
  const selections: MemorySourceSelection[] = [];

  for (const exact of input.representations) {
    await assertExactRepresentation(exact);
    const representation = exact.representation;
    let storedRepresentation = representation;
    if (representation.kind === 'authored') {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'authored 走独立发布记录，不能作为来源选择', {
        reason: 'authored_selection_not_allowed',
      });
    }
    let originScope: MemoryOriginScope;
    if (
      representation.kind === 'raw_full' ||
      representation.kind === 'raw_fragment' ||
      representation.kind === 'preview'
    ) {
      const source = await assertRawRepresentationMatchesSource(db, exact);
      if (!source.origin_room_id) {
        throw new BusinessError('MEMORY_TARGET_INVALID', 'raw 表示缺少来源房间', {
          reason: 'origin_room_missing',
        });
      }
      roomScopes.add(source.origin_room_id);
      const decision = await authorizeSourceRead(db, {
        space: context.space,
        source,
        agentId: input.agentId,
        target_scope: input.targetScope,
        grant: input.grant ?? null,
        at,
      });
      if (!decision.allowed) {
        throw new BusinessError('PERMISSION_DENIED', '当前无权读取或披露该来源', {
          reason: decision.reason,
          source_id: source.source_id,
        });
      }
      await registerRepresentation(db, {
        instanceId: input.instanceId,
        exact,
        dependencies: representation.depends_on,
        now: at,
      });
      const stored = await loadRepresentationExact(db, representation.representation_id);
      if (!stored) {
        throw new BusinessError('MEMORY_UNAVAILABLE', '准确表示写入后无法读取');
      }
      storedRepresentation = stored.representation;
      originScope = {
        room_id: source.origin_room_id,
        member_generation: source.origin_member_generation,
        policy_revision: source.origin_policy_revision,
        joined_seq: source.origin_joined_seq,
        joined_at: source.origin_joined_at,
        archive_head_seq: source.origin_archive_head_seq,
      };
    } else {
      // 先按当前授权检查全部来源依赖，避免未授权调用先写入派生正文。
      for (const dependency of representation.depends_on) {
        const dependencySource = await getSource(
          db,
          dependency.source_id,
          dependency.source_revision,
        );
        if (!dependencySource) {
          throw new BusinessError('MEMORY_TARGET_INVALID', '派生表示的来源依赖不存在', {
            reason: 'dependency_missing',
            source_id: dependency.source_id,
          });
        }
        const dependencyDecision = await authorizeSourceRead(db, {
          space: context.space,
          source: dependencySource,
          agentId: input.agentId,
          target_scope: input.targetScope,
          grant: input.grant ?? null,
          at,
        });
        if (!dependencyDecision.allowed) {
          throw new BusinessError('PERMISSION_DENIED', '当前无权读取或披露派生表示的来源', {
            reason: dependencyDecision.reason,
            source_id: dependency.source_id,
          });
        }
      }
      await registerRepresentation(db, {
        instanceId: input.instanceId,
        exact,
        dependencies: representation.depends_on,
        now: at,
      });
      const stored = await loadRepresentationExact(db, representation.representation_id);
      if (!stored) {
        throw new BusinessError('MEMORY_UNAVAILABLE', '派生表示写入后无法读取');
      }
      storedRepresentation = stored.representation;
      const decision = await authorizeRepresentationRead(db, {
        space: context.space,
        representationId: storedRepresentation.representation_id,
        agentId: input.agentId,
        target_scope: input.targetScope,
        grant: input.grant ?? null,
        at,
      });
      if (!decision.allowed) {
        throw new BusinessError('PERMISSION_DENIED', '当前无权读取或披露该派生表示', {
          reason: decision.reason,
        });
      }
      const scope = await originScopeForDerived(db, storedRepresentation);
      if (!scope) {
        throw new BusinessError('MEMORY_TARGET_INVALID', '派生表示没有可定位的来源范围', {
          reason: 'origin_scope_missing',
        });
      }
      originScope = scope;
      roomScopes.add(scope.room_id);
    }

    const versions = await requireCurrentMemorySpace(db, {
      agentId: input.agentId,
      instanceId: input.instanceId,
      expected: input.space,
      roomIds: [...roomScopes],
      at,
    });
    const selection: MemorySourceSelection = {
      selection_id: newId('msel'),
      representation: storedRepresentation,
      origin_scope: originScope,
      target_scope: input.targetScope,
      versions: versions.versions,
      issued_at: at,
      expires_at: at + LIMITS.memoryPreparedTtlMs,
      consumption: 'not_consumed',
    };
    await runMemoryBatch(db, [
      db
        .prepare(
          `INSERT INTO memory_selections
             (selection_id, space_id, ownership_epoch, agent_actor_id, recall_id,
              representation_id, origin_scope_json, target_scope_json, versions_json,
              consumption, state, issued_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_consumed', 'available', ?, ?)`,
        )
        .bind(
          selection.selection_id,
          context.space.space_id,
          context.space.ownership_epoch,
          input.agentId,
          input.recallId ?? null,
          representation.representation_id,
          JSON.stringify(originScope),
          JSON.stringify(input.targetScope),
          JSON.stringify(versions.versions),
          at,
          selection.expires_at,
        ),
    ]);
    selections.push(selection);
  }
  return selections;
}

async function originScopeForDerived(
  db: D1Like,
  representation: MemoryRepresentation,
): Promise<MemoryOriginScope | null> {
  const sourceIds = new Set<string>();
  if ('source_id' in representation) sourceIds.add(representation.source_id);
  for (const dependency of representation.depends_on) sourceIds.add(dependency.source_id);
  for (const sourceId of sourceIds) {
    const source = await getLatestMemorySource(db, sourceId);
    if (source?.origin_room_id) {
      return {
        room_id: source.origin_room_id,
        member_generation: source.origin_member_generation,
        policy_revision: source.origin_policy_revision,
        joined_seq: source.origin_joined_seq,
        joined_at: source.origin_joined_at,
        archive_head_seq: source.origin_archive_head_seq,
      };
    }
  }
  return null;
}

