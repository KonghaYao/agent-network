/**
 * MF09 Langfuse 来源导入器。
 *
 * 外部 trace/observation 只登记为共享来源与准确表示；不创建经历、不写
 * retain 资格，也不改变 MCP 工具契约。个人记忆仍必须走 ExposureReceipt
 * 路径，因此 Langfuse 观测不能冒充“Agent 已读过原文”。
 *
 * 安全边界：
 * - 归属/受众来自服务端 trusted binding + 当前 WeBots 成员代次；
 * - trace 自带的 userId/metadata 不作为 actor、房间或 verified 证据；
 * - 已 tombstone 的来源键永久拒绝重放；
 * - 同源键内容变化不自动升修订，返回 conflict 由显式治理处理；
 * - 摘要必须引用已核实的最终输入 manifest；memory_context 必须引用已存在
 *   的 Context，且依赖非空，避免把记忆回声当成独立事实。
 */
import { historyBoundary } from '../../domain/room-history';
import { sha256Hex } from '../../storage/db';
import { getActor, getMember, getRoom } from '../../storage/queries';
import type { D1Like } from '../../storage/queries';
import {
  isTombstoned,
  loadActiveMemorySpace,
} from '../access';
import type {
  MemoryContextRepresentation,
  MemoryRawRepresentation,
  MemorySourceDependency,
  MemorySummaryRepresentation,
} from '../contracts';
import { MEMORY_CURSOR_KINDS, advanceMemoryCursor, readMemoryCursor } from '../jobs';
import { memoryRepresentationInsertStatements } from '../representation-statements';
import type {
  MemoryContextRow,
  MemoryManifestRow,
  MemoryRepresentationDependencyRow,
  MemoryRepresentationRow,
  MemorySourceRow,
  MemorySpaceRow,
} from '../rows';
import { runMemoryBatch, sourceMutationStatements } from '../store';
import type { ResolvedLangfuseSourceConfig } from './langfuse-config';
import { langfuseSourceCapabilities } from './langfuse-config';
import { LangfuseTransport } from './langfuse-http';
import {
  LANGFUSE_SKIP_REASONS,
  mapLangfuseObservation,
  parseLangfuseObservation,
  parseLangfusePage,
  type LangfuseMappingResult,
  type LangfuseObservationRecord,
  type LangfuseSkipReason,
} from './langfuse-mapping';

export interface LangfuseImportOptions {
  signal?: AbortSignal | null;
  deadlineAt?: number | null;
  /** 调试/补跑用；正常使用持久水位。 */
  from?: number;
  to?: number;
}

export type LangfuseImportStatus =
  | 'ready'
  | 'empty'
  | 'partial'
  | 'disabled'
  | 'unavailable'
  | 'timeout'
  | 'cancelled';

export type LangfuseSkipCounts = Readonly<Record<LangfuseSkipReason, number>>;

export interface LangfuseImportResult {
  status: LangfuseImportStatus;
  /** 只含分类/状态码，不含响应正文、host 查询串或凭据。 */
  reason: string | null;
  from: number | null;
  to: number;
  fetched: number;
  imported: number;
  duplicates: number;
  conflicts: number;
  excluded: number;
  errors: number;
  skipped: LangfuseSkipCounts;
  /** 各 binding 导入后的持久水位；未推进时保持原值。 */
  watermarks: Readonly<Record<string, number | null>>;
}

export interface LangfuseSourceImporterOptions {
  db: D1Like;
  instanceId: string;
  config: ResolvedLangfuseSourceConfig | null;
  transport?: LangfuseTransport | null;
  now?: () => number;
  /** MEMORY_CAPTURE=0 时停止新增来源；已有 tombstone/撤权屏障不受影响。 */
  capture?: boolean;
}

type StoreOutcome =
  | { kind: 'imported' | 'duplicate' | 'conflict' | 'excluded' }
  | { kind: 'skipped'; reason: LangfuseSkipReason };

interface ResolvedContent {
  text: string;
  digest: string;
  bytes: number;
  dependencies: readonly MemorySourceDependency[];
}

function emptySkipCounts(): Record<LangfuseSkipReason, number> {
  const counts = {} as Record<LangfuseSkipReason, number>;
  for (const reason of LANGFUSE_SKIP_REASONS) counts[reason] = 0;
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只解析我们写入的 dependency JSON；损坏时保守返回 null，不扩大依赖。 */
function parseDependenciesJSON(raw: string): MemorySourceDependency[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const dependencies: MemorySourceDependency[] = [];
  for (const value of parsed) {
    if (!isRecord(value)) return null;
    const sourceId = value.source_id;
    const sourceRevision = value.source_revision;
    if (typeof sourceId !== 'string' || sourceId.length === 0) return null;
    if (!Number.isSafeInteger(sourceRevision) || (sourceRevision as number) < 1) {
      return null;
    }
    const representationId = value.representation_id;
    if (
      representationId !== null &&
      representationId !== undefined &&
      typeof representationId !== 'string'
    ) {
      return null;
    }
    const range = value.range;
    if (range !== null && range !== undefined) {
      if (
        !isRecord(range) ||
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        (range.start as number) < 0 ||
        (range.end as number) <= (range.start as number)
      ) {
        return null;
      }
    }
    dependencies.push({
      source_id: sourceId,
      source_revision: sourceRevision as number,
      representation_id: typeof representationId === 'string' ? representationId : null,
      range:
        isRecord(range) && typeof range.start === 'number' && typeof range.end === 'number'
          ? { start: range.start, end: range.end }
          : null,
    });
  }
  return dependencies;
}

function dependencyKey(dependency: MemorySourceDependency): string {
  return [
    dependency.source_id,
    dependency.source_revision,
    dependency.representation_id ?? '',
    dependency.range ? `${dependency.range.start}-${dependency.range.end}` : '',
  ].join(':');
}

export class LangfuseSourceImporter {
  readonly #db: D1Like;
  readonly #instanceId: string;
  readonly #config: ResolvedLangfuseSourceConfig | null;
  readonly #transport: LangfuseTransport | null;
  readonly #now: () => number;
  readonly #capture: boolean;

  constructor(options: LangfuseSourceImporterOptions) {
    this.#db = options.db;
    this.#instanceId = options.instanceId;
    this.#config = options.config;
    this.#transport =
      options.transport !== undefined
        ? options.transport
        : options.config
          ? new LangfuseTransport(options.config)
          : null;
    this.#now = options.now ?? options.config?.now ?? Date.now;
    this.#capture = options.capture ?? true;
  }

  capabilities() {
    return langfuseSourceCapabilities(this.#transport ? this.#config : null);
  }

  async importOnce(options: LangfuseImportOptions = {}): Promise<LangfuseImportResult> {
    const config = this.#config;
    const transport = this.#transport;
    const to = options.to ?? this.#now();
    if (!config || !transport) {
      return {
        status: 'disabled',
        reason: 'langfuse_not_configured',
        from: null,
        to,
        fetched: 0,
        imported: 0,
        duplicates: 0,
        conflicts: 0,
        excluded: 0,
        errors: 0,
        skipped: emptySkipCounts(),
        watermarks: {},
      };
    }
    if (!this.#capture) {
      // 停止新增采集时不拉取；已有来源的 tombstone/撤权仍由 MF03 屏障执行。
      return {
        status: 'disabled',
        reason: 'capture_disabled',
        from: null,
        to,
        fetched: 0,
        imported: 0,
        duplicates: 0,
        conflicts: 0,
        excluded: 0,
        errors: 0,
        skipped: emptySkipCounts(),
        watermarks: {},
      };
    }
    const watermarks = await this.#readWatermarks(config);
    // 显式 from 是补跑/重放：仍按 source key 去重，但不再用水位跳过旧观测。
    const replay = options.from !== undefined;
    const from =
      options.from ??
      Math.min(
        ...config.bindings.map(
          (binding) => watermarks.get(binding.binding_id) ?? config.initialFrom,
        ),
      );
    if (from >= to) {
      return {
        status: 'empty',
        reason: null,
        from,
        to,
        fetched: 0,
        imported: 0,
        duplicates: 0,
        conflicts: 0,
        excluded: 0,
        errors: 0,
        skipped: emptySkipCounts(),
        watermarks: Object.fromEntries(watermarks),
      };
    }

    const collected: LangfuseObservationRecord[] = [];
    const skipped = emptySkipCounts();
    let fetched = 0;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 0; ; page += 1) {
      if (page >= config.maxPages) {
        return this.#fetchFailure('unavailable', 'page_limit', from, to, fetched, skipped, watermarks);
      }
      const outcome = await transport.listObservations({
        from,
        to,
        cursor,
        deadlineAt: options.deadlineAt ?? null,
        signal: options.signal ?? null,
      });
      if (outcome.kind !== 'ok') {
        const failure =
          outcome.kind === 'timeout'
            ? { status: 'timeout' as const, reason: 'timeout' }
            : outcome.kind === 'cancelled'
              ? { status: 'cancelled' as const, reason: 'cancelled' }
              : outcome.kind === 'http'
                ? {
                    status: 'unavailable' as const,
                    reason:
                      outcome.status === 401 || outcome.status === 403
                        ? 'unauthorized'
                        : outcome.status === 404
                          ? 'endpoint_not_found'
                          : outcome.status === 400 || outcome.status === 422
                            ? 'invalid_request'
                            : `http_${outcome.status}`,
                  }
                : outcome.kind === 'parse'
                  ? { status: 'unavailable' as const, reason: 'invalid_response' }
                  : { status: 'unavailable' as const, reason: 'network' };
        return this.#fetchFailure(
          failure.status,
          failure.reason,
          from,
          to,
          fetched,
          skipped,
          watermarks,
        );
      }
      const parsed = parseLangfusePage(outcome.body);
      if (!parsed.ok) {
        return this.#fetchFailure(
          'unavailable',
          'invalid_response',
          from,
          to,
          fetched,
          skipped,
          watermarks,
        );
      }
      fetched += parsed.page.observations.length;
      for (const raw of parsed.page.observations) {
        const observation = parseLangfuseObservation(raw);
        if (!observation.ok) {
          skipped.invalid_observation += 1;
          continue;
        }
        collected.push(observation.observation);
      }
      if (!parsed.page.cursor) break;
      if (seenCursors.has(parsed.page.cursor)) {
        return this.#fetchFailure(
          'unavailable',
          'cursor_loop',
          from,
          to,
          fetched,
          skipped,
          watermarks,
        );
      }
      seenCursors.add(parsed.page.cursor);
      cursor = parsed.page.cursor;
    }

    collected.sort((left, right) => left.startTimeMs - right.startTimeMs);
    let imported = 0;
    let duplicates = 0;
    let conflicts = 0;
    let excluded = 0;
    let errors = 0;
    for (const observation of collected) {
      if (options.signal?.aborted) {
        return {
          status: 'cancelled',
          reason: 'cancelled',
          from,
          to,
          fetched,
          imported,
          duplicates,
          conflicts,
          excluded,
          errors,
          skipped,
          watermarks: Object.fromEntries(watermarks),
        };
      }
      const mapped = await mapLangfuseObservation(observation, config.bindings);
      if (mapped.kind === 'skipped') {
        skipped[mapped.reason] += 1;
        continue;
      }
      const bindingFrom = watermarks.get(mapped.binding.binding_id) ?? config.initialFrom;
      if (!replay && mapped.occurredAt < bindingFrom) {
        // 多个 binding 共用拉取窗口时，较晚 binding 的旧数据已经处理过。
        continue;
      }
      const outcome = await this.#storeSource(mapped).catch(
        (): StoreOutcome => ({ kind: 'skipped', reason: 'store_error' }),
      );
      switch (outcome.kind) {
        case 'imported':
          imported += 1;
          break;
        case 'duplicate':
          duplicates += 1;
          break;
        case 'conflict':
          conflicts += 1;
          break;
        case 'excluded':
          excluded += 1;
          break;
        case 'skipped':
          if (outcome.reason === 'store_error') errors += 1;
          skipped[outcome.reason] += 1;
          break;
      }
    }
    if (errors > 0) {
      // 本地写入失败可能是瞬时的；不推进水位，下一轮按幂等键重放。
      return {
        status: 'partial',
        reason: 'store_error',
        from,
        to,
        fetched,
        imported,
        duplicates,
        conflicts,
        excluded,
        errors,
        skipped,
        watermarks: Object.fromEntries(watermarks),
      };
    }
    if (options.signal?.aborted) {
      return {
        status: 'cancelled',
        reason: 'cancelled',
        from,
        to,
        fetched,
        imported,
        duplicates,
        conflicts,
        excluded,
        errors,
        skipped,
        watermarks: Object.fromEntries(watermarks),
      };
    }
    for (const binding of config.bindings) {
      await advanceMemoryCursor(this.#db, {
        scopeKind: 'agent',
        scopeId: binding.agent_actor_id,
        cursorKind: this.#cursorKind(binding.binding_id),
        value: to,
        now: to,
      });
      const previous = watermarks.get(binding.binding_id) ?? config.initialFrom;
      watermarks.set(binding.binding_id, Math.max(previous, to));
    }
    return {
      status: fetched === 0 ? 'empty' : 'ready',
      reason: null,
      from,
      to,
      fetched,
      imported,
      duplicates,
      conflicts,
      excluded,
      errors,
      skipped,
      watermarks: Object.fromEntries(watermarks),
    };
  }

  #fetchFailure(
    status: LangfuseImportStatus,
    reason: string,
    from: number,
    to: number,
    fetched: number,
    skipped: Record<LangfuseSkipReason, number>,
    watermarks: Map<string, number>,
  ): LangfuseImportResult {
    return {
      status,
      reason,
      from,
      to,
      fetched,
      imported: 0,
      duplicates: 0,
      conflicts: 0,
      excluded: 0,
      errors: 0,
      skipped,
      watermarks: Object.fromEntries(watermarks),
    };
  }

  #cursorKind(bindingId: string): string {
    return `${MEMORY_CURSOR_KINDS.langfuseImport}:${bindingId}`;
  }

  async #readWatermarks(
    config: ResolvedLangfuseSourceConfig,
  ): Promise<Map<string, number>> {
    const watermarks = new Map<string, number>();
    for (const binding of config.bindings) {
      const value = await readMemoryCursor(this.#db, {
        scopeKind: 'agent',
        scopeId: binding.agent_actor_id,
        cursorKind: this.#cursorKind(binding.binding_id),
      });
      watermarks.set(binding.binding_id, value ?? config.initialFrom);
    }
    return watermarks;
  }

  async #storeSource(mapped: Extract<LangfuseMappingResult, { kind: 'source' }>): Promise<StoreOutcome> {
    const binding = mapped.binding;
    const actor = await getActor(this.#db, binding.agent_actor_id);
    if (!actor || actor.kind !== 'agent' || actor.disabled_at !== null) {
      return { kind: 'skipped', reason: 'binding_agent_disabled' };
    }
    const room = await getRoom(this.#db, binding.origin.room_id);
    const member = room
      ? await getMember(this.#db, binding.origin.room_id, binding.agent_actor_id)
      : null;
    if (!room || !member || member.status !== 'active') {
      return { kind: 'skipped', reason: 'mapping_stale' };
    }
    if (
      binding.origin.member_generation !== undefined &&
      binding.origin.member_generation !== member.member_generation
    ) {
      return { kind: 'skipped', reason: 'mapping_stale' };
    }
    if (
      binding.origin.policy_revision !== undefined &&
      binding.origin.policy_revision !== room.policy_revision
    ) {
      return { kind: 'skipped', reason: 'mapping_stale' };
    }
    const space = await loadActiveMemorySpace(this.#db, binding.agent_actor_id);
    if (!space || space.instance_id !== this.#instanceId) {
      return { kind: 'skipped', reason: 'space_missing' };
    }
    if (await isTombstoned(this.#db, { sourceKey: mapped.sourceKey })) {
      return { kind: 'excluded' };
    }
    const existing = await this.#db
      .prepare(
        `SELECT * FROM memory_sources
          WHERE instance_id = ? AND source_key = ?
          ORDER BY revision DESC LIMIT 1`,
      )
      .bind(this.#instanceId, mapped.sourceKey)
      .first<MemorySourceRow>();
    if (
      existing &&
      (existing.state === 'retracted' ||
        (await isTombstoned(this.#db, { kind: 'source', id: existing.source_id })))
    ) {
      return { kind: 'excluded' };
    }
    const content = await this.#resolveContent(mapped, space);
    if ('reason' in content) return { kind: 'skipped', reason: content.reason };
    if (mapped.representationKind === 'memory_context' && !mapped.contextId) {
      return { kind: 'skipped', reason: 'unverified_context' };
    }
    if (existing) {
      // 同修订的内容变化不自动升版本：外部 trace 更新不是显式纠正。
      if (existing.content_sha256 === null || existing.content_sha256 !== content.digest) {
        return { kind: 'conflict' };
      }
    }
    const revision = existing?.revision ?? 1;
    const sourceId =
      existing?.source_id ??
      `msrc_lf_${(await sha256Hex(`${this.#instanceId}:${mapped.sourceKey}`)).slice(0, 32)}`;
    const summaryId =
      mapped.representationKind === 'summary'
        ? `lfsum_${(
            await sha256Hex(`${this.#instanceId}:${mapped.sourceKey}`)
          ).slice(0, 32)}`
        : null;
    const boundary = historyBoundary(room, member);
    const now = this.#now();
    // summary/context 表示没有 source_id 列，必须把自身来源也列为依赖，
    // 否则来源 tombstone/撤权不会自动撤销派生表示。
    const dependencies: readonly MemorySourceDependency[] =
      mapped.representationKind === 'raw_fragment'
        ? content.dependencies
        : [
            {
              source_id: sourceId,
              source_revision: revision,
              representation_id: null,
              range: null,
            },
            ...content.dependencies,
          ];
    const representationId = `mrep_lf_${(
      await sha256Hex(
        `${this.#instanceId}:${mapped.sourceKey}:${revision}:${mapped.representationKind}:${content.digest}`,
      )
    ).slice(0, 32)}`;
    const representation = this.#representation(
      mapped,
      sourceId,
      summaryId,
      representationId,
      revision,
      content,
      dependencies,
    );
    try {
      await runMemoryBatch(this.#db, [
        ...sourceMutationStatements(this.#db, {
          sourceId,
          instanceId: this.#instanceId,
          sourceKey: mapped.sourceKey,
          sourceKind: 'langfuse_observation',
          businessRefKind: 'langfuse',
          businessRefJson: mapped.businessRefJson,
          originRoomId: room.room_id,
          originMemberGeneration: member.member_generation,
          originPolicyRevision: boundary.policyRevision,
          originJoinedSeq: member.joined_seq,
          originJoinedAt: member.joined_at,
          originArchiveHeadSeq: room.archive_head_seq,
          originSeq: null,
          originCreatedAt: mapped.occurredAt,
          authorActorId: binding.author_actor_id ?? null,
          revision,
          contentText: content.text,
          contentSha256: content.digest,
          contentBytes: content.bytes,
          now,
        }),
        ...memoryRepresentationInsertStatements(this.#db, {
          instanceId: this.#instanceId,
          exact: { representation, text: content.text },
          dependencies,
          now,
        }),
      ]);
    } catch {
      return { kind: 'skipped', reason: 'store_error' };
    }
    return { kind: existing ? 'duplicate' : 'imported' };
  }

  #representation(
    mapped: Extract<LangfuseMappingResult, { kind: 'source' }>,
    sourceId: string,
    summaryId: string | null,
    representationId: string,
    revision: number,
    content: ResolvedContent,
    dependencies: readonly MemorySourceDependency[],
  ): MemoryRawRepresentation | MemorySummaryRepresentation | MemoryContextRepresentation {
    const base = {
      representation_id: representationId,
      text_bytes: content.bytes,
      text_sha256: content.digest,
    };
    if (mapped.representationKind === 'summary') {
      if (!summaryId) throw new Error('summary observation missing summary id');
      return {
        ...base,
        kind: 'summary',
        summary_id: summaryId,
        revision,
        depends_on: dependencies,
        partition_proof: null,
        verbatim: false,
      };
    }
    if (mapped.representationKind === 'memory_context') {
      if (!mapped.contextId) {
        // mapping 已保证 contextId 非空；这里保留显式失败而不是编造引用。
        throw new Error('memory_context observation missing context id');
      }
      return {
        ...base,
        kind: 'memory_context',
        source_context_id: mapped.contextId,
        depends_on: dependencies,
        verbatim: false,
      };
    }
    return {
      ...base,
      kind: 'raw_fragment',
      source_id: sourceId,
      source_revision: revision,
      range: { start: 0, end: content.bytes },
      depends_on: [],
      verbatim: true,
    };
  }

  async #resolveContent(
    mapped: Extract<LangfuseMappingResult, { kind: 'source' }>,
    space: MemorySpaceRow,
  ): Promise<ResolvedContent | { reason: LangfuseSkipReason }> {
    if (mapped.representationKind === 'raw_fragment') {
      if (!mapped.digest) return { reason: 'invalid_observation' };
      if (await this.#isMemoryEcho(space, mapped.digest)) {
        return { reason: 'echo_suppressed' };
      }
      return {
        text: mapped.text,
        digest: mapped.digest,
        bytes: mapped.bytes,
        dependencies: [],
      };
    }
    if (mapped.representationKind === 'summary') {
      if (!mapped.digest || !mapped.manifestId) return { reason: 'unverified_summary' };
      if (await this.#isMemoryEcho(space, mapped.digest)) {
        return { reason: 'echo_suppressed' };
      }
      const dependencies = await this.#loadManifestDependencies(
        mapped.manifestId,
        space,
        mapped.binding.agent_actor_id,
      );
      if (!dependencies) return { reason: 'unverified_summary' };
      return {
        text: mapped.text,
        digest: mapped.digest,
        bytes: mapped.bytes,
        dependencies,
      };
    }
    if (!mapped.contextId) return { reason: 'unverified_context' };
    const context = await this.#loadContextReference(
      mapped.contextId,
      space,
      mapped.binding.agent_actor_id,
    );
    if (!context) return { reason: 'unverified_context' };
    return {
      text: context.body,
      digest: context.digest,
      bytes: context.bytes,
      dependencies: context.dependencies,
    };
  }

  async #isMemoryEcho(space: MemorySpaceRow, digest: string): Promise<boolean> {
    const row = await this.#db
      .prepare(
        `SELECT 1 AS hit
           FROM memory_contexts
          WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
            AND body_sha256 = ?
          UNION ALL
         SELECT 1
           FROM memory_manifest_items mi
           JOIN memory_manifests m ON m.manifest_id = mi.manifest_id
          WHERE m.space_id = ? AND m.ownership_epoch = ? AND m.agent_actor_id = ?
            AND mi.text_sha256 = ?
          UNION ALL
         SELECT 1
           FROM memory_representations r
          WHERE r.kind IN ('summary', 'memory_context') AND r.text_sha256 = ?
            AND (
              EXISTS (
                SELECT 1 FROM memory_experiences e
                 WHERE e.representation_id = r.representation_id
                   AND e.space_id = ? AND e.ownership_epoch = ? AND e.agent_actor_id = ?
              )
              OR EXISTS (
                SELECT 1 FROM memory_selections s
                 WHERE s.representation_id = r.representation_id
                   AND s.space_id = ? AND s.ownership_epoch = ? AND s.agent_actor_id = ?
              )
            )
          LIMIT 1`,
      )
      .bind(
        space.space_id,
        space.ownership_epoch,
        space.agent_actor_id,
        digest,
        space.space_id,
        space.ownership_epoch,
        space.agent_actor_id,
        digest,
        digest,
        space.space_id,
        space.ownership_epoch,
        space.agent_actor_id,
        space.space_id,
        space.ownership_epoch,
        space.agent_actor_id,
      )
      .first<{ hit: number }>();
    return row !== null;
  }

  async #loadManifestDependencies(
    manifestId: string,
    space: MemorySpaceRow,
    agentId: string,
  ): Promise<MemorySourceDependency[] | null> {
    const manifest = await this.#db
      .prepare('SELECT * FROM memory_manifests WHERE manifest_id = ?')
      .bind(manifestId)
      .first<MemoryManifestRow>();
    if (
      !manifest ||
      manifest.space_id !== space.space_id ||
      manifest.ownership_epoch !== space.ownership_epoch ||
      manifest.agent_actor_id !== agentId
    ) {
      return null;
    }
    const items = await this.#db
      .prepare(
        'SELECT representation_id FROM memory_manifest_items WHERE manifest_id = ? ORDER BY item_index',
      )
      .bind(manifestId)
      .all<{ representation_id: string }>();
    if (items.results.length === 0) return null;
    const deduped = new Map<string, MemorySourceDependency>();
    for (const item of items.results) {
      const dependencies = await this.#collectRepresentationDependencies(
        item.representation_id,
        new Set(),
        0,
      );
      if (!dependencies) return null;
      for (const dependency of dependencies) {
        deduped.set(dependencyKey(dependency), dependency);
      }
    }
    return deduped.size > 0 ? [...deduped.values()] : null;
  }

  /**
   * 递归收集一个表示的来源依赖。任何一环缺失/成环都返回 null，不猜测代替。
   */
  async #collectRepresentationDependencies(
    representationId: string,
    visiting: Set<string>,
    depth: number,
  ): Promise<MemorySourceDependency[] | null> {
    if (depth > 8 || visiting.has(representationId)) return null;
    visiting.add(representationId);
    try {
      const representation = await this.#db
        .prepare('SELECT * FROM memory_representations WHERE representation_id = ?')
        .bind(representationId)
        .first<MemoryRepresentationRow>();
      if (!representation) return null;
      const dependencies: MemorySourceDependency[] = [];
      if (
        representation.source_id !== null &&
        representation.source_revision !== null
      ) {
        dependencies.push({
          source_id: representation.source_id,
          source_revision: representation.source_revision,
          representation_id: representation.representation_id,
          range:
            representation.range_start !== null && representation.range_end !== null
              ? { start: representation.range_start, end: representation.range_end }
              : null,
        });
      }
      const rows = await this.#db
        .prepare(
          `SELECT * FROM memory_representation_dependencies
            WHERE representation_id = ?
            ORDER BY dependency_index`,
        )
        .bind(representationId)
        .all<MemoryRepresentationDependencyRow>();
      for (const row of rows.results) {
        dependencies.push({
          source_id: row.source_id,
          source_revision: row.source_revision,
          representation_id: row.depends_on_representation_id,
          range:
            row.range_start !== null && row.range_end !== null
              ? { start: row.range_start, end: row.range_end }
              : null,
        });
        if (row.depends_on_representation_id) {
          const nested = await this.#collectRepresentationDependencies(
            row.depends_on_representation_id,
            visiting,
            depth + 1,
          );
          if (!nested) return null;
          dependencies.push(...nested);
        }
      }
      if (representation.kind === 'memory_context' && representation.source_context_id) {
        const contextDependencies = await this.#contextDependencies(
          representation.source_context_id,
          visiting,
          depth + 1,
        );
        if (!contextDependencies) return null;
        dependencies.push(...contextDependencies);
      }
      return dependencies;
    } finally {
      visiting.delete(representationId);
    }
  }

  async #contextDependencies(
    contextId: string,
    visiting: Set<string>,
    depth: number,
  ): Promise<MemorySourceDependency[] | null> {
    if (depth > 8) return null;
    const items = await this.#db
      .prepare(
        'SELECT representation_id, source_dependencies_json FROM memory_context_items WHERE context_id = ? ORDER BY item_index',
      )
      .bind(contextId)
      .all<{ representation_id: string; source_dependencies_json: string }>();
    if (items.results.length === 0) return null;
    const dependencies: MemorySourceDependency[] = [];
    for (const item of items.results) {
      const parsed = parseDependenciesJSON(item.source_dependencies_json);
      if (!parsed) return null;
      dependencies.push(...parsed);
      const nested = await this.#collectRepresentationDependencies(
        item.representation_id,
        visiting,
        depth + 1,
      );
      if (!nested) return null;
      dependencies.push(...nested);
    }
    return dependencies;
  }

  async #loadContextReference(
    contextId: string,
    space: MemorySpaceRow,
    agentId: string,
  ): Promise<{ body: string; digest: string; bytes: number; dependencies: MemorySourceDependency[] } | null> {
    const context = await this.#db
      .prepare('SELECT * FROM memory_contexts WHERE context_id = ?')
      .bind(contextId)
      .first<MemoryContextRow>();
    if (
      !context ||
      context.space_id !== space.space_id ||
      context.ownership_epoch !== space.ownership_epoch ||
      context.agent_actor_id !== agentId ||
      context.status !== 'ready'
    ) {
      return null;
    }
    if (context.expires_at !== null && context.expires_at <= this.#now()) return null;
    const dependencies = await this.#contextDependencies(contextId, new Set(), 0);
    if (!dependencies) return null;
    const deduped = new Map<string, MemorySourceDependency>();
    for (const dependency of dependencies) {
      deduped.set(dependencyKey(dependency), dependency);
    }
    if (deduped.size === 0) return null;
    return {
      body: context.body,
      digest: context.body_sha256,
      bytes: context.body_bytes,
      dependencies: [...deduped.values()],
    };
  }
}

/** 便捷构造：没有配置时返回 disabled importer，不发起任何请求。 */
export function createLangfuseSourceImporter(
  options: LangfuseSourceImporterOptions,
): LangfuseSourceImporter {
  return new LangfuseSourceImporter(options);
}
