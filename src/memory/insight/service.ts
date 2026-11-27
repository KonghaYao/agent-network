/**
 * 只读 Agent 记忆 insight 编排。
 *
 * 每次调用都先做目标 actor 解析与授权，再读 active memory space，最后由服务端
 * 派生 bank 并访问 Hindsight。没有 active space 时返回 no_space，绝不创建空间；
 * 上游故障与真空白分开，不把超时/5xx 伪装成空库。
 */
import { BusinessError, isBusinessError } from '../../contracts/errors';
import { LIMITS } from '../../contracts/limits';
import { stableStringify } from '../../storage/db';
import type { D1Like } from '../../storage/queries';
import type { ActorRow } from '../../storage/rows';
import type { MemorySpaceRow } from '../rows';
import {
  auditInsightAccess,
  authorizeInsightViewer,
  loadInsightSpace,
  resolveInsightTarget,
} from './access';
import { InsightCache } from './cache';
import {
  insightBusinessError,
  type InsightActorView,
  type InsightAvailabilityReason,
  type InsightBackfillState,
  type InsightEntitiesInput,
  type InsightEntitiesResult,
  type InsightGetInput,
  type InsightGetResult,
  type InsightGraphInput,
  type InsightGraphResult,
  type InsightListInput,
  type InsightListResult,
  type InsightOverviewInput,
  type InsightOverviewResult,
  type InsightTimelineInput,
  type InsightTimelineItem,
  type InsightTimelineResult,
  type InsightViewer,
  type InsightView,
} from './contracts';
import {
  type InsightReadResult,
  type InsightReader,
} from './hindsight-read';
import {
  fitGraphBytes,
  fitItemsToBytes,
  jsonBytes,
  normalizeEntityDetail,
  normalizeEntityGraph,
  normalizeEntityList,
  normalizeGraphRows,
  normalizeMemoryDetail,
  normalizeMemoryGraph,
  normalizeMemoryList,
  normalizeStats,
  normalizeTimelineItem,
} from './normalize';
import { MEMORY_CURSOR_KINDS, readMemoryCursor } from '../jobs';
import { resolveTimelineZone, type TimelineZone } from './timeline-zone';
import { graphTimeline, sortTimelineItems, timelineGroups, timelineSummary } from './timeline-projection';

export type FailedInsightRead = Extract<InsightReadResult, { ok: false }>;

function httpStatusOf(outcome: InsightReadResult): number | null {
  return !outcome.ok && outcome.kind === 'http' ? outcome.status : null;
}

export interface MemoryInsightServiceOptions {
  db: D1Like;
  reader: InsightReader | null;
  memoryEnabled: boolean;
  /** 空间首次 catch-up 是否启用；只用于只读状态展示。 */
  spaceCatchupEnabled?: boolean;
  /** 整点窗口回填是否启用；只用于只读状态展示。 */
  windowEnabled?: boolean;
  cache?: InsightCache;
  now?: () => number;
}

interface BaseView {
  actor: InsightActorView;
  fetched_at: number;
  backfill: InsightBackfillState;
}

function actorView(target: ActorRow): InsightActorView {  return {
    actor_id: target.actor_id,
    name: target.name,
    kind: 'agent',
    archived: target.archived_at !== null,
    disabled: target.disabled_at !== null,
  };
}

function spaceRef(space: MemorySpaceRow): {
  space_id: string;
  ownership_epoch: number;
  backend_binding_epoch: number;
} {
  return {
    space_id: space.space_id,
    ownership_epoch: space.ownership_epoch,
    backend_binding_epoch: space.backend_binding_epoch,
  };
}

function parseDateMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/u.test(value)) {
    throw new BusinessError('INVALID_ARGUMENT', '日期格式无效', { reason: 'invalid_date' });
  }
  return parsed;
}

function validateDateRange(startDate?: string, endDate?: string): void {
  if (!startDate && !endDate) return;
  const start = startDate ? parseDateMs(startDate) : null;
  const end = endDate ? parseDateMs(endDate) : null;
  if (start !== null && end !== null) {
    if (start >= end) {
      throw new BusinessError('INVALID_ARGUMENT', 'start_date 必须早于 end_date', {
        reason: 'invalid_date_range',
      });
    }
    if (end - start > LIMITS.memoryPanelDateSpanDays * 24 * 60 * 60_000) {
      throw new BusinessError('INVALID_ARGUMENT', '时间过滤跨度超过上限', {
        reason: 'date_range_too_wide',
        max_days: LIMITS.memoryPanelDateSpanDays,
      });
    }
  }
}

const DAY_MS = 24 * 60 * 60_000;

export class MemoryInsightService {
  readonly #db: D1Like;
  readonly #reader: InsightReader | null;
  readonly #memoryEnabled: boolean;
  readonly #spaceCatchupEnabled: boolean;
  readonly #windowEnabled: boolean;
  readonly #cache: InsightCache;
  readonly #now: () => number;

  constructor(options: MemoryInsightServiceOptions) {
    this.#db = options.db;
    this.#reader = options.reader;
    this.#memoryEnabled = options.memoryEnabled;
    this.#spaceCatchupEnabled = options.spaceCatchupEnabled ?? false;
    this.#windowEnabled = options.windowEnabled ?? false;
    this.#now = options.now ?? Date.now;
    this.#cache =
      options.cache ??
      new InsightCache({
        ttlMs: LIMITS.memoryPanelCacheTtlMs,
        maxEntries: LIMITS.memoryPanelCacheEntries,
        now: this.#now,
      });
  }

  async overview(
    viewer: InsightViewer,
    input: InsightOverviewInput,
  ): Promise<InsightOverviewResult> {
    return this.#run(viewer, input.actor_id, 'overview', async (target) => {
      const base = await this.#base(target);
      const gate = this.#gate();
      if (gate) return { ...base, available: false, reason: gate, stats: null };
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return { ...base, available: false, reason: 'no_space', stats: null };
      const spaceBase = await this.#base(target, space);
      const bank = await reader.bankFor(spaceRef(space));
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'overview', {}),
        async () => {
          const outcome = await reader.stats(bank);
          return this.#overviewResult(spaceBase, outcome);
        },
        { refresh: input.refresh },
      );
    });
  }

  async graph(viewer: InsightViewer, input: InsightGraphInput): Promise<InsightGraphResult> {
    return this.#run(viewer, input.actor_id, 'graph', async (target) => {
      const limit = Math.min(
        input.limit ?? LIMITS.memoryPanelGraphNodesDefault,
        LIMITS.memoryPanelGraphNodesMax,
      );
      const includeRows = input.include_rows === true;
      const rowsLimit = Math.min(
        input.rows_limit ?? LIMITS.memoryPanelRowsDefault,
        LIMITS.memoryPanelRowsMax,
      );
      const rowsTextChars = Math.min(
        input.rows_text_chars ?? LIMITS.memoryPanelRowsTextCharsDefault,
        LIMITS.memoryPanelRowsTextCharsMax,
      );
      const zone = resolveTimelineZone(input);
      // 上游 graph 的 table_rows 与 nodes 来自同一个 units 页；提高 limit 才能在同一
      // 快照里拿到 rows_limit 行，而输出节点数仍由本地 limit 裁剪。
      const upstreamLimit = includeRows
        ? Math.min(Math.max(limit, rowsLimit), LIMITS.memoryPanelRowsMax)
        : limit;
      const base = await this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyGraph(base, gate, limit, includeRows, zone);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyGraph(base, 'no_space', limit, includeRows, zone);
      const spaceBase = await this.#base(target, space);
      const bank = await reader.bankFor(spaceRef(space));
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'graph', {
          limit,
          type: input.type,
          q: input.q,
          include_rows: includeRows,
          ...(includeRows
            ? {
                rows_limit: rowsLimit,
                rows_text_chars: rowsTextChars,
                timezone: zone.timeZone,
                tz_offset_minutes: zone.offsetMinutes,
              }
            : {}),
        }),
        async () => {
          const outcome = await reader.graph(bank, {
            limit: upstreamLimit,
            type: input.type,
            q: input.q,
          });
          if (httpStatusOf(outcome) === 404) {
            return this.#emptyGraph(spaceBase, 'bank_missing', limit, includeRows, zone);
          }
          if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
            return this.#emptyGraph(spaceBase, 'backend_unsupported', limit, includeRows, zone);
          }
          if (!outcome.ok) this.#throwReadFailure(outcome);
          const graph = normalizeMemoryGraph(outcome.body, {
            nodeLimit: limit,
            edgeLimit: LIMITS.memoryPanelGraphEdgesMax,
            textChars: LIMITS.memoryPanelGraphTextChars,
          });
          if (!graph) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
          const result: InsightGraphResult = {
            ...spaceBase,
            available: true,
            reason: 'ok',
            nodes: graph.nodes,
            edges: graph.edges,
            total_units: graph.total_units,
            total_edges: graph.total_edges,
            raw_node_count: graph.raw_node_count,
            raw_edge_count: graph.raw_edge_count,
            limit,
            truncated: graph.truncated,
          };
          // include_rows 时先只按图核心预算裁剪 nodes/edges，保证星座图可用；
          // table_rows/timeline 随后由 #fitGraphResponse 在单一总预算内处理。
          // fitGraphBytes 原地修改 nodes/edges，裁剪结果直接落在 result 上。
          if (fitGraphBytes(result, LIMITS.memoryPanelGraphCoreBytes)) result.truncated = true;
          if (includeRows) {
            const normalizedRows = normalizeGraphRows(outcome.body, {
              limit: rowsLimit,
              textChars: rowsTextChars,
            });
            if (!normalizedRows) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
            result.table_rows = normalizedRows.rows;
            result.rows_truncated = normalizedRows.truncated;
            result.timeline = graphTimeline(normalizedRows.rows, graph.total_units, zone);
            this.#fitGraphResponse(result, graph.total_units, zone);
          }
          return result;
        },
        { refresh: input.refresh },
      );
    });
  }

  async list(viewer: InsightViewer, input: InsightListInput): Promise<InsightListResult> {
    return this.#run(viewer, input.actor_id, 'list', async (target) => {
      validateDateRange(input.start_date, input.end_date);
      const limit = Math.min(
        input.limit ?? LIMITS.memoryPanelFactsPageDefault,
        LIMITS.memoryPanelFactsPageMax,
      );
      const offset = input.offset ?? 0;
      const textChars = input.text_chars ?? LIMITS.memoryPanelFactsTextChars;
      const base = await this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyList(base, gate, limit, offset);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyList(base, 'no_space', limit, offset);
      const spaceBase = await this.#base(target, space);
      const bank = await reader.bankFor(spaceRef(space));
      const params = {
        limit,
        offset,
        q: input.q,
        type: input.type,
        entity_id: input.entity_id,
        time_field: input.time_field,
        start_date: input.start_date,
        end_date: input.end_date,
        text_chars: textChars,
      };
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'list', params),
        async () => {
          const outcome = await reader.memories(bank, params);
          if (httpStatusOf(outcome) === 404) {
            return this.#emptyList(spaceBase, 'bank_missing', limit, offset);
          }
          if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
            return this.#emptyList(spaceBase, 'backend_unsupported', limit, offset);
          }
          if (!outcome.ok) this.#throwReadFailure(outcome);
          const normalized = normalizeMemoryList(outcome.body, { textChars });
          if (!normalized) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
          const hasMore =
            normalized.raw_count > 0 &&
            (normalized.total !== null
              ? offset + normalized.raw_count < normalized.total
              : normalized.raw_count === limit);
          const result: InsightListResult = {
            ...spaceBase,
            available: true,
            reason: 'ok',
            items: normalized.items,
            total: normalized.total,
            limit,
            offset,
            has_more: hasMore,
            next_offset: hasMore ? offset + normalized.raw_count : null,
            truncated: false,
          };
          const dropped = fitItemsToBytes(result);
          if (dropped > 0) {
            result.truncated = true;
            result.has_more = true;
            result.next_offset =
              offset + Math.max(result.items.length, normalized.raw_count - dropped);
          }
          return result;
        },
        { refresh: input.refresh },
      );
    });
  }

  async timeline(
    viewer: InsightViewer,
    input: InsightTimelineInput,
  ): Promise<InsightTimelineResult> {
    return this.#run(viewer, input.actor_id, 'timeline', async (target) => {
      const days = input.days ?? LIMITS.memoryPanelTimelineDaysDefault;
      const limit = Math.min(
        input.limit ?? LIMITS.memoryPanelTimelineLimitDefault,
        LIMITS.memoryPanelTimelineLimitMax,
      );
      const zone = resolveTimelineZone(input);
      const base = await this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyTimeline(base, gate, days, limit);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyTimeline(base, 'no_space', days, limit);
      const spaceBase = await this.#base(target, space);
      const bank = await reader.bankFor(spaceRef(space));
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'timeline', {
          days,
          type: input.type,
          limit,
          timezone: zone.timeZone,
          tz_offset_minutes: zone.offsetMinutes,
        }),
        async () => {
          const deadlineAt = this.#now() + LIMITS.memoryPanelTimeoutMs;
          const end = new Date(this.#now());
          const start = new Date(end.getTime() - days * DAY_MS);
          const collected: InsightTimelineItem[] = [];
          const seen = new Set<string>();
          let total: number | null = null;
          let offset = 0;
          let hasMore = false;

          for (let page = 0; page < LIMITS.memoryPanelTimelinePagesMax; page += 1) {
            const remaining = limit - collected.length;
            if (remaining <= 0) break;
            if (this.#now() >= deadlineAt) throw insightBusinessError('UPSTREAM_TIMEOUT');
            const pageLimit = Math.min(remaining, LIMITS.memoryPanelTimelinePageMax);
            const outcome = await reader.memories(bank, {
              limit: pageLimit,
              offset,
              type: input.type,
              time_field: 'mentioned_at',
              start_date: start.toISOString(),
              end_date: end.toISOString(),
              deadline_at: deadlineAt,
            });
            if (httpStatusOf(outcome) === 404) {
              return this.#emptyTimeline(spaceBase, 'bank_missing', days, limit);
            }
            if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
              return this.#emptyTimeline(spaceBase, 'backend_unsupported', days, limit);
            }
            if (!outcome.ok) this.#throwReadFailure(outcome);
            const normalized = normalizeMemoryList(outcome.body);
            if (!normalized) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
            total = normalized.total;
            const rawItems = Array.isArray((outcome.body as { items?: unknown }).items)
              ? ((outcome.body as { items: unknown[] }).items)
              : [];
            for (const entry of rawItems) {
              const item = normalizeTimelineItem(entry);
              if (!item || seen.has(item.id)) continue;
              seen.add(item.id);
              collected.push(item);
              if (collected.length >= limit) break;
            }
            offset += normalized.raw_count;
            if (normalized.raw_count === 0) break;
            const knownMore = total !== null ? offset < total : normalized.raw_count >= pageLimit;
            if (!knownMore) break;
            if (page === LIMITS.memoryPanelTimelinePagesMax - 1) {
              hasMore = true;
              break;
            }
            if (collected.length >= limit) {
              hasMore = true;
              break;
            }
            if (this.#now() >= deadlineAt) throw insightBusinessError('UPSTREAM_TIMEOUT');
          }

          if (total !== null) hasMore = total > collected.length;
          const sorted = sortTimelineItems(collected);
          const result: InsightTimelineResult = {
            ...spaceBase,
            available: true,
            reason: 'ok',
            items: sorted,
            groups: timelineGroups(sorted, zone),
            summary: timelineSummary(sorted, total),
            days,
            limit,
            truncated: hasMore,
          };
          if (this.#fitTimelineBytes(result, zone)) result.truncated = true;
          return result;
        },
        { refresh: input.refresh },
      );
    });
  }

  async get(viewer: InsightViewer, input: InsightGetInput): Promise<InsightGetResult> {
    return this.#run(viewer, input.actor_id, 'get', async (target) => {
      const base = await this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyGet(base, gate);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyGet(base, 'no_space');
      const spaceBase = await this.#base(target, space);
      const bank = await reader.bankFor(spaceRef(space));
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'get', { memory_id: input.memory_id }),
        async () => {
          const outcome = await reader.memory(bank, input.memory_id);
          if (httpStatusOf(outcome) === 404) {
            throw insightBusinessError('NOT_FOUND');
          }
          if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
            return this.#emptyGet(spaceBase, 'backend_unsupported');
          }
          if (!outcome.ok) this.#throwReadFailure(outcome);
          const memory = normalizeMemoryDetail(outcome.body, input.memory_id);
          if (!memory) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
          return { ...spaceBase, available: true, reason: 'ok', memory };
        },
        { refresh: input.refresh },
      );
    });
  }

  async entities(
    viewer: InsightViewer,
    input: InsightEntitiesInput,
  ): Promise<InsightEntitiesResult> {
    return this.#run(viewer, input.actor_id, 'entities', async (target) => {
      const view = input.entity_id ? 'detail' : (input.view ?? 'list');
      const base = await this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyEntities(base, gate, view, input.limit ?? 0);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyEntities(base, 'no_space', view, input.limit ?? 0);
      const spaceBase = await this.#base(target, space);
      const bank = await reader.bankFor(spaceRef(space));
      if (view === 'detail') {
        return this.#cache.getOrLoad(
          this.#cacheKey(space, 'entities', {
            view,
            entity_id: input.entity_id,
          }),
          async () =>
            this.#entityDetailResult(reader, bank, spaceBase, input.entity_id!),
          { refresh: input.refresh },
        );
      }
      if (view === 'graph') {
        const limit = Math.min(
          input.limit ?? LIMITS.memoryPanelEntityGraphEdgesMax,
          LIMITS.memoryPanelEntityGraphEdgesMax,
        );
        const minCount = input.min_count ?? 2;
        return this.#cache.getOrLoad(
          this.#cacheKey(space, 'entities', { view, limit, min_count: minCount }),
          async () => {
            const outcome = await reader.entityGraph(bank, { limit, min_count: minCount });
            if (httpStatusOf(outcome) === 404) {
              return this.#emptyEntities(spaceBase, 'bank_missing', view, limit);
            }
            if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
              return this.#emptyEntities(spaceBase, 'backend_unsupported', view, limit);
            }
            if (!outcome.ok) this.#throwReadFailure(outcome);
            const graph = normalizeEntityGraph(outcome.body, {
              edgeLimit: limit,
              nodeLimit: LIMITS.memoryPanelEntityGraphNodesMax,
              bytes: LIMITS.memoryPanelGraphCoreBytes,
            });
            if (!graph) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
            return {
              ...spaceBase,
              available: true,
              reason: 'ok' as const,
              view: 'graph' as const,
              items: [],
              total: null,
              limit,
              offset: 0,
              has_more: false,
              next_offset: null,
              entity: null,
              graph,
              truncated: graph.truncated,
              partial: false,
            };
          },
          { refresh: input.refresh },
        );
      }
      const limit = Math.min(
        input.limit ?? LIMITS.memoryPanelEntitiesPageDefault,
        LIMITS.memoryPanelEntitiesPageMax,
      );
      const offset = input.offset ?? 0;
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'entities', { view: 'list', limit, offset }),
        async () => {
          const outcome = await reader.entities(bank, { limit, offset });
          if (httpStatusOf(outcome) === 404) {
            return this.#emptyEntities(spaceBase, 'bank_missing', 'list', limit, offset);
          }
          if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
            return this.#emptyEntities(spaceBase, 'backend_unsupported', 'list', limit, offset);
          }
          if (!outcome.ok) this.#throwReadFailure(outcome);
          const normalized = normalizeEntityList(outcome.body);
          if (!normalized) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
          const hasMore =
            normalized.raw_count > 0 &&
            (normalized.total !== null
              ? offset + normalized.raw_count < normalized.total
              : normalized.raw_count === limit);
          const result: InsightEntitiesResult = {
            ...spaceBase,
            available: true,
            reason: 'ok',
            view: 'list',
            items: normalized.items,
            total: normalized.total,
            limit,
            offset,
            has_more: hasMore,
            next_offset: hasMore ? offset + normalized.raw_count : null,
            entity: null,
            graph: null,
            truncated: false,
            partial: false,
          };
          const dropped = fitItemsToBytes(result);
          if (dropped > 0) {
            result.truncated = true;
            result.has_more = true;
            result.next_offset =
              offset + Math.max(result.items.length, normalized.raw_count - dropped);
          }
          return result;
        },
        { refresh: input.refresh },
      );
    });
  }

  async #entityDetailResult(
    reader: InsightReader,
    bank: string,
    base: BaseView,
    entityId: string,
  ): Promise<InsightEntitiesResult> {
    const [entityOutcome, memoriesOutcome] = await Promise.all([
      reader.entity(bank, entityId),
      reader.memories(bank, {
        limit: 10,
        offset: 0,
        entity_id: entityId,
        time_field: 'mentioned_at',
      }),
    ]);
    if (httpStatusOf(entityOutcome) === 404) {
      throw insightBusinessError('NOT_FOUND');
    }
    if (httpStatusOf(entityOutcome) === 405 || httpStatusOf(entityOutcome) === 410) {
      return this.#emptyEntities(base, 'backend_unsupported', 'detail', 0);
    }
    if (!entityOutcome.ok) this.#throwReadFailure(entityOutcome);
    const entity = normalizeEntityDetail(entityOutcome.body, entityId);
    if (!entity) throw insightBusinessError('UPSTREAM_UNAVAILABLE');

    let partial = false;
    if (memoriesOutcome.ok) {
      const related = normalizeMemoryList(memoriesOutcome.body, { textChars: 500 });
      if (related) {
        entity.memories = related.items.map((item) => ({
          id: item.id,
          text_preview: item.text,
          fact_type: item.fact_type,
          mentioned_at: item.mentioned_at,
        }));
      } else {
        partial = true;
      }
    } else {
      partial = true;
    }
    return {
      ...base,
      available: true,
      reason: 'ok',
      view: 'detail',
      items: [],
      total: null,
      limit: 0,
      offset: 0,
      has_more: false,
      next_offset: null,
      entity,
      graph: null,
      truncated: false,
      partial,
    };
  }

  async #run<T extends { available: boolean; reason: string }>(
    viewer: InsightViewer,
    targetActorId: string,
    view: InsightView,
    run: (target: ActorRow) => Promise<T>,
  ): Promise<T> {
    const target = await resolveInsightTarget(this.#db, targetActorId);
    const crossActor = viewer.actor_id !== target.actor_id;
    try {
      await authorizeInsightViewer(this.#db, viewer, target);
      const result = await run(target);
      if (crossActor) {
        auditInsightAccess({
          viewer,
          targetActorId: target.actor_id,
          view,
          result: result.available ? 'ok' : 'unavailable',
        });
      }
      return result;
    } catch (error) {
      if (crossActor) {
        auditInsightAccess({
          viewer,
          targetActorId: target.actor_id,
          view,
          result:
            isBusinessError(error) && error.code === 'PERMISSION_DENIED' ? 'denied' : 'error',
        });
      }
      throw error;
    }
  }

  #gate(): 'panel_disabled' | 'backend_not_configured' | null {
    if (!this.#memoryEnabled) return 'panel_disabled';
    if (!this.#reader) return 'backend_not_configured';
    return null;
  }

  async #base(target: ActorRow, space?: MemorySpaceRow | null): Promise<BaseView> {
    const done = space
      ? await readMemoryCursor(this.#db, {
          scopeKind: 'space',
          scopeId: space.space_id,
          cursorKind: MEMORY_CURSOR_KINDS.spaceCatchupDone,
        })
      : null;
    const state: InsightBackfillState['space_catchup'] = !this.#spaceCatchupEnabled
      ? 'disabled'
      : done === 1
        ? 'completed'
        : 'pending';
    return {
      actor: actorView(target),
      fetched_at: this.#now(),
      backfill: { space_catchup: state, window_enabled: this.#windowEnabled },
    };
  }

  #cacheKey(space: MemorySpaceRow, view: InsightView, params: unknown): string {
    return [
      space.space_id,
      space.ownership_epoch,
      space.backend_binding_epoch,
      view,
      stableStringify(params),
    ].join(':');
  }

  #overviewResult(base: BaseView, outcome: InsightReadResult): InsightOverviewResult {
    if (outcome.ok) {
      const stats = normalizeStats(outcome.body);
      if (!stats) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
      return { ...base, available: true, reason: 'ok', stats };
    }
    if (httpStatusOf(outcome) === 404) {
      return { ...base, available: false, reason: 'bank_missing', stats: null };
    }
    if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
      return { ...base, available: false, reason: 'backend_unsupported', stats: null };
    }
    this.#throwReadFailure(outcome);
  }

  #emptyGraph(
    base: BaseView,
    reason: InsightAvailabilityReason,
    limit: number,
    includeRows = false,
    zone: TimelineZone = { timeZone: null, offsetMinutes: 0 },
  ): InsightGraphResult {
    const result: InsightGraphResult = {
      ...base,
      available: false,
      reason,
      nodes: [],
      edges: [],
      total_units: null,
      total_edges: 0,
      raw_node_count: 0,
      raw_edge_count: 0,
      limit,
      truncated: false,
    };
    if (includeRows) {
      result.table_rows = [];
      result.rows_truncated = false;
      result.timeline = graphTimeline([], null, zone);
    }
    return result;
  }

  #emptyList(
    base: BaseView,
    reason: InsightAvailabilityReason,
    limit: number,
    offset: number,
  ): InsightListResult {
    return {
      ...base,
      available: false,
      reason,
      items: [],
      total: null,
      limit,
      offset,
      has_more: false,
      next_offset: null,
      truncated: false,
    };
  }

  #emptyTimeline(
    base: BaseView,
    reason: InsightAvailabilityReason,
    days: number,
    limit: number,
  ): InsightTimelineResult {
    return {
      ...base,
      available: false,
      reason,
      items: [],
      groups: { day: [], week: [], month: [] },
      summary: timelineSummary([], null),
      days,
      limit,
      truncated: false,
    };
  }

  /** 超出 JSON 预算时从尾部（最旧事件）移除，并重建分组索引。 */
  #fitTimelineBytes(result: InsightTimelineResult, zone: TimelineZone): boolean {
    let trimmed = false;
    while (jsonBytes(result) > LIMITS.memoryPanelTimelineBytes && result.items.length > 0) {
      const nextLength = Math.max(0, result.items.length - 16);
      result.items.splice(nextLength);
      this.#refreshTimeline(result, zone);
      trimmed = true;
    }
    return trimmed;
  }

  #refreshTimeline(result: InsightTimelineResult, zone: TimelineZone): void {
    result.groups = timelineGroups(result.items, zone);
    result.summary = timelineSummary(result.items, result.summary.total);
  }

  /**
   * graph 响应的单一总预算：以完整结果（base/nodes/edges/table_rows/timeline）
   * 序列化后的 JSON 字节数为准。
   *
   * 优先级：图核心已先按 memoryPanelGraphCoreBytes 裁剪；仍超总预算时先按最旧行
   * 成块丢弃并重建 timeline，图核心不受行影响；只有行裁空后仍超限，才兜底裁剪
   * 图：先压节点正文到下限，再在边保留下限内删边，然后继续压正文并置
   * truncated=true。上游 total 大于返回行数时也标记 rows_truncated，避免把子集
   * 当完整数据。
   */
  #fitGraphResponse(
    result: InsightGraphResult,
    total: number | null,
    zone: TimelineZone,
  ): boolean {
    const rows = result.table_rows;
    let rowsTrimmed = false;
    if (rows && total !== null && total > rows.length) result.rows_truncated = true;
    while (rows && rows.length > 0 && jsonBytes(result) > LIMITS.memoryPanelGraphResponseBytes) {
      const keep = Math.max(0, rows.length - Math.max(1, Math.ceil(rows.length / 8)));
      rows.splice(keep);
      result.timeline = graphTimeline(rows, total, zone);
      result.rows_truncated = true;
      rowsTrimmed = true;
    }
    if (jsonBytes(result) > LIMITS.memoryPanelGraphResponseBytes) {
      if (fitGraphBytes(result, LIMITS.memoryPanelGraphResponseBytes)) result.truncated = true;
    }
    return rowsTrimmed;
  }

  #emptyGet(base: BaseView, reason: InsightAvailabilityReason): InsightGetResult {
    return { ...base, available: false, reason, memory: null };
  }

  #emptyEntities(
    base: BaseView,
    reason: InsightAvailabilityReason,
    view: 'list' | 'graph' | 'detail',
    limit: number,
    offset = 0,
  ): InsightEntitiesResult {
    return {
      ...base,
      available: false,
      reason,
      view,
      items: [],
      total: null,
      limit,
      offset,
      has_more: false,
      next_offset: null,
      entity: null,
      graph: null,
      truncated: false,
      partial: false,
    };
  }

  #throwReadFailure(outcome: FailedInsightRead): never {
    if (outcome.kind === 'timeout') throw insightBusinessError('UPSTREAM_TIMEOUT');
    throw insightBusinessError('UPSTREAM_UNAVAILABLE');
  }
}
