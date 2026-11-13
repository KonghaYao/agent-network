/**
 * MF06：MemoryContext 的创建与读取。
 *
 * Context 是服务端组装的记忆参考数据包，不是系统指令、工具授权或已核验事实。
 * lookup 包永远没有注入许可；bound 包只有在目标、来源、受众与遗忘屏障全部
 * 通过当前重验时才标为可注入。正文写入后 immutable，失效通过状态标记表达。
 */
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { LIMITS } from '../contracts/limits';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  getMemoryContext,
  listMemoryContextItems,
  listMemoryContextSummaries,
  type D1Like,
} from '../storage/queries';
import {
  MEMORY_PAYLOAD_AUTHORITY,
  MEMORY_POLICY_VERSION,
  type MemoryContext,
  type MemoryContextEvidence,
  type MemoryContextEvidenceItem,
  type MemoryContextTarget,
  type MemoryContextValidity,
  type MemoryCoverage,
  type MemoryExposureEvidenceKind,
  type MemoryLookupContext,
  type MemoryOriginKind,
  type MemoryOriginScope,
  type MemoryRepresentation,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from './contracts';
import {
  authorizeRepresentationRead,
  isTombstoned,
  requireCurrentMemorySpace,
  sourceOriginScope,
} from './access';
import { getSource } from './store';
import { loadRepresentationExact } from './experience-source';
import { requireHostBinding } from './input-manifest';
import type { MemoryContextRow } from './rows';

export interface MemoryContextStoreOptions {
  instanceId: string;
  now?: number;
}

export interface MemoryContextSourceItem {
  exact: { representation: MemoryRepresentation; text: string };
  origin_scope: MemoryOriginScope;
  evidence: MemoryExposureEvidenceKind;
}

export interface MemoryContextView {
  context_id: string;
  recall_id: string | null;
  kind: 'lookup' | 'bound';
  context: MemoryContext;
  body: string;
  body_sha256: string;
  body_bytes: number;
  items: readonly {
    representation_id: string;
    origin_kind: MemoryOriginKind;
    origin_scope: MemoryOriginScope;
    evidence: MemoryExposureEvidenceKind;
    text: string;
    text_sha256: string;
    range: { start: number; end: number } | null;
  }[];
}

function targetScopeFromRow(row: MemoryContextRow): MemoryTargetScope | null {
  if (!row.target_json) return null;
  try {
    const parsed = JSON.parse(row.target_json) as unknown;
    if (
      row.kind === 'bound' &&
      parsed &&
      typeof parsed === 'object' &&
      'target_scope' in parsed
    ) {
      return (parsed as MemoryContextTarget).target_scope;
    }
    if (parsed && typeof parsed === 'object' && 'audience' in parsed) {
      return parsed as MemoryTargetScope;
    }
    return null;
  } catch {
    return null;
  }
}

function contextBody(items: readonly MemoryContextSourceItem[], version: number): string {
  return stableStringify({
    version,
    authority: MEMORY_PAYLOAD_AUTHORITY,
    items: items.map((item) => ({
      representation_id: item.exact.representation.representation_id,
      origin_kind: originKindFor(item.exact.representation),
      origin_scope: item.origin_scope,
      evidence: item.evidence,
      text: item.exact.text,
    })),
  });
}

function originKindFor(representation: MemoryRepresentation): MemoryOriginKind {
  if (representation.kind === 'authored') return 'authored';
  if (representation.kind === 'summary' || representation.kind === 'memory_context') {
    return 'experienced';
  }
  return 'experienced';
}

function validityOf(row: MemoryContextRow, at: number): MemoryContextValidity {
  if (row.status === 'ready') {
    return row.expires_at !== null && row.expires_at < at ? 'expired' : 'active';
  }
  if (row.status === 'invalidated') return 'revoked';
  if (row.status === 'expired') return 'expired';
  return 'excluded';
}

/**
 * 写入 lookup Context；正文和条目一次写入，之后只能整体失效或清除。
 *
 * 重复 recall 使用同一个 context_id 时返回已有包，不重新拼装不同正文。
 */
export async function createLookupMemoryContext(
  db: D1Like,
  options: MemoryContextStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    recallId: string;
    targetScope: MemoryTargetScope;
    items: readonly MemoryContextSourceItem[];
    coverage?: MemoryCoverage;
    evidenceComplete?: boolean;
    contextId?: string;
  },
): Promise<MemoryContextView | null> {
  if (options.items.length === 0) return null;
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    roomIds: [...new Set(options.items.map((item) => item.origin_scope.room_id))],
    at,
  });
  const digestInput = stableStringify({
    recall_id: options.recallId,
    scope: context.space,
    items: options.items.map((item) => ({
      representation_id: item.exact.representation.representation_id,
      text_sha256: item.exact.representation.text_sha256,
      evidence: item.evidence,
    })),
  });
  const contextId =
    options.contextId ?? `mctx_${(await sha256Hex(`lookup|${digestInput}`)).slice(0, 32)}`;
  const existing = await getMemoryContext(db, contextId);
  if (existing) {
    const view = await readMemoryContextView(db, {
      instanceId: options.instanceId,
      agentId: options.agentId,
      space: options.space,
      contextId,
      now: at,
    });
    return view.available ? view.contextView : null;
  }
  const body = contextBody(options.items, 1);
  const bodySha = await sha256Hex(body);
  const bodyBytes = new TextEncoder().encode(body).length;
  const expiresAt = at + LIMITS.memoryContextTtlMs;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO memory_contexts
           (context_id, space_id, ownership_epoch, agent_actor_id, recall_id, kind,
            body, body_sha256, body_bytes, target_json, versions_json, policy_version,
            status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'lookup', ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      )
      .bind(
        contextId,
        context.space.space_id,
        context.space.ownership_epoch,
        options.agentId,
        options.recallId,
        body,
        bodySha,
        bodyBytes,
        JSON.stringify(options.targetScope),
        JSON.stringify(context.versions),
        MEMORY_POLICY_VERSION,
        at,
        expiresAt,
        at,
      ),
  ];
  options.items.forEach((item, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_context_items
             (context_id, item_index, experience_id, representation_id,
              source_dependencies_json, evidence, origin_scope_json)
           VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        )
        .bind(
          contextId,
          index,
          item.exact.representation.representation_id,
          JSON.stringify(item.exact.representation.depends_on ?? []),
          item.evidence,
          JSON.stringify(item.origin_scope),
        ),
    );
  });
  await db.batch(statements);
  const view = await readMemoryContextView(db, {
    instanceId: options.instanceId,
    agentId: options.agentId,
    space: options.space,
    contextId,
    now: at,
  });
  return view.available ? view.contextView : null;
}

/**
 * 读取 Context 并重验当前权限。
 *
 * 不依赖创建时的缓存正文；任一条目当前不可读就整体不可注入，但历史回执
 * 仍保留。返回 `body` 仅为当下获准的参考数据。
 */
export async function readMemoryContextView(
  db: D1Like,
  options: MemoryContextStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    contextId: string;
  },
): Promise<
  | { available: true; contextView: MemoryContextView }
  | { available: false; reason: string; context_row: MemoryContextRow | null }
> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const row = await getMemoryContext(db, options.contextId);
  if (!row) return { available: false, reason: 'not_found', context_row: null };
  if (
    row.space_id !== context.space.space_id ||
    row.ownership_epoch !== context.space.ownership_epoch ||
    row.agent_actor_id !== options.agentId
  ) {
    return { available: false, reason: 'ownership_changed', context_row: row };
  }
  if (row.status !== 'ready') return { available: false, reason: row.status, context_row: row };
  if (row.expires_at !== null && row.expires_at < at) {
    return { available: false, reason: 'expired', context_row: row };
  }
  if (await isTombstoned(db, { kind: 'context', id: row.context_id })) {
    return { available: false, reason: 'tombstoned', context_row: row };
  }
  const targetScope = targetScopeFromRow(row);
  if (!targetScope) {
    return { available: false, reason: 'invalid_target', context_row: row };
  }
  const itemRows = await listMemoryContextItems(db, row.context_id);
  const items: MemoryContextView['items'][number][] = [];
  const evidenceItems: MemoryContextEvidenceItem[] = [];
  for (const item of itemRows) {
    const decision = await authorizeRepresentationRead(db, {
      space: context.space,
      representationId: item.representation_id,
      agentId: options.agentId,
      target_scope: targetScope,
      at,
    });
    if (!decision.allowed) {
      return { available: false, reason: decision.reason, context_row: row };
    }
    const exact = await loadRepresentationExact(db, item.representation_id);
    if (!exact) return { available: false, reason: 'representation_missing', context_row: row };
    let originScope: MemoryOriginScope;
    try {
      originScope = JSON.parse(item.origin_scope_json) as MemoryOriginScope;
    } catch {
      return { available: false, reason: 'origin_scope_corrupt', context_row: row };
    }
    const evidence =
      item.evidence === 'gateway_observed_submitted' ||
      item.evidence === 'host_reported_submitted'
        ? item.evidence
        : null;
    if (!evidence) return { available: false, reason: 'evidence_missing', context_row: row };
    items.push({
      representation_id: item.representation_id,
      origin_kind: originKindFor(exact.representation),
      origin_scope: originScope,
      evidence,
      text: exact.text,
      text_sha256: exact.representation.text_sha256,
      range:
        exact.representation.kind === 'raw_full' ||
        exact.representation.kind === 'raw_fragment' ||
        exact.representation.kind === 'preview'
          ? exact.representation.range
          : null,
    });
    evidenceItems.push({
      origin_kind: originKindFor(exact.representation),
      evidence,
      source:
        exact.representation.kind === 'raw_full' ||
        exact.representation.kind === 'raw_fragment' ||
        exact.representation.kind === 'preview'
          ? {
              source_id: exact.representation.source_id,
              source_revision: exact.representation.source_revision,
            }
          : null,
      representation_id: item.representation_id,
    });
  }
  const body = row.body;
  const evidence: MemoryContextEvidence = {
    coverage: 'bounded',
    evidence_complete: false,
    minimum_evidence: null,
    items: evidenceItems,
  };
  const base = {
    context_id: row.context_id,
    space: context.space,
    agent_actor_id: row.agent_actor_id,
    body: {
      version: 1,
      sha256: row.body_sha256,
      bytes: row.body_bytes,
      authority: MEMORY_PAYLOAD_AUTHORITY,
    },
    evidence,
    validity: validityOf(row, at),
    created_at: row.created_at,
    expires_at: row.expires_at ?? at,
  };
  let memoryContext: MemoryContext;
  if (row.kind === 'lookup') {
    memoryContext = {
      ...base,
      kind: 'lookup',
      target: null,
      target_scope: targetScope,
      injection: { eligible: false, admit_required: true, reason: 'lookup_only' },
    } satisfies MemoryLookupContext;
  } else {
    let target: MemoryContextTarget | null = null;
    try {
      target = row.target_json ? (JSON.parse(row.target_json) as MemoryContextTarget) : null;
    } catch {
      target = null;
    }
    if (!target) return { available: false, reason: 'invalid_target', context_row: row };
    try {
      await requireHostBinding(db, {
        bindingId: target.host_binding_id,
        generation: target.host_generation,
        space: context.space,
        agentId: options.agentId,
        at,
      });
    } catch {
      return { available: false, reason: 'host_binding_inactive', context_row: row };
    }
    memoryContext = {
      ...base,
      kind: 'bound',
      target,
      target_scope: targetScope,
      injection: {
        eligible: base.validity === 'active',
        admit_required: true,
        reason: base.validity === 'active' ? 'active' : base.validity,
      },
    };
  }
  return {
    available: true,
    contextView: {
      context_id: row.context_id,
      recall_id: row.recall_id,
      kind: row.kind,
      context: memoryContext,
      body,
      body_sha256: row.body_sha256,
      body_bytes: row.body_bytes,
      items,
    },
  };
}

// ---------------------------------------------------------------------------
// 列表（只返回元数据，不返回正文）
// ---------------------------------------------------------------------------

export interface MemoryContextListInput {
  limit?: number;
  cursor?: string | null;
  kind?: 'lookup' | 'bound';
}

export async function listMemoryContexts(
  db: D1Like,
  options: MemoryContextStoreOptions & {
    agentId: string;
    space: MemorySpaceRef;
    input?: MemoryContextListInput;
  },
): Promise<{
  items: readonly {
    context_id: string;
    recall_id: string | null;
    kind: 'lookup' | 'bound';
    validity: MemoryContextValidity;
    body_sha256: string;
    body_bytes: number;
    created_at: number;
    expires_at: number | null;
  }[];
  next_cursor: string | null;
  has_more: boolean;
}> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const limit = Math.max(1, Math.min(options.input?.limit ?? 20, 100));
  const scope = `memory:context:${context.space.space_id}:${context.space.ownership_epoch}`;
  const cursor = options.input?.cursor ? decodeCursor(options.input.cursor, scope) : null;
  const rows = await listMemoryContextSummaries(db, {
    spaceId: context.space.space_id,
    ownershipEpoch: context.space.ownership_epoch,
    agentId: options.agentId,
    kind: options.input?.kind ?? null,
    cursor: cursor ? { seq: cursor.seq, key: cursor.key ?? '' } : null,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      context_id: row.context_id,
      recall_id: row.recall_id,
      kind: row.kind,
      validity: validityOf(
        { status: row.status, expires_at: row.expires_at } as MemoryContextRow,
        at,
      ),
      body_sha256: row.body_sha256,
      body_bytes: row.body_bytes,
      created_at: row.created_at,
      expires_at: row.expires_at,
    })),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.context_id,
            snapshot: at,
          })
        : null,
    has_more: hasMore,
  };
}

/**
 * 组装一个可注入的 bound Context 所需的来源范围。
 *
 * 这里不创建 Context；只有 HostBridge 在 claim 后绑定准确 target 时才能调用，
 * 避免把预热结果误记为已注入。
 */
export async function resolveContextOriginScope(
  db: D1Like,
  representation: MemoryRepresentation,
  fallbackSource?: { source_id: string; source_revision: number } | null,
): Promise<MemoryOriginScope | null> {
  const sourceRef =
    'source_id' in representation
      ? { source_id: representation.source_id, source_revision: representation.source_revision }
      : fallbackSource;
  if (sourceRef) {
    const source = await getSource(db, sourceRef.source_id, sourceRef.source_revision);
    if (source) return sourceOriginScope(source);
  }
  for (const dependency of representation.depends_on ?? []) {
    const source = await getSource(db, dependency.source_id, dependency.source_revision);
    if (source) {
      const scope = sourceOriginScope(source);
      if (scope) return scope;
    }
  }
  if (fallbackSource) {
    const source = await getSource(db, fallbackSource.source_id, fallbackSource.source_revision);
    if (source) return sourceOriginScope(source);
  }
  return null;
}

