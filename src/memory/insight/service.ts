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
  normalizeEntityDetail,
  normalizeEntityGraph,
  normalizeEntityList,
  normalizeMemoryDetail,
  normalizeMemoryGraph,
  normalizeMemoryList,
  normalizeStats,
} from './normalize';

export type FailedInsightRead = Extract<InsightReadResult, { ok: false }>;

function httpStatusOf(outcome: InsightReadResult): number | null {
  return !outcome.ok && outcome.kind === 'http' ? outcome.status : null;
}

export interface MemoryInsightServiceOptions {
  db: D1Like;
  reader: InsightReader | null;
  memoryEnabled: boolean;
  cache?: InsightCache;
  now?: () => number;
}

interface BaseView {
  actor: InsightActorView;
  fetched_at: number;
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

export class MemoryInsightService {
  readonly #db: D1Like;
  readonly #reader: InsightReader | null;
  readonly #memoryEnabled: boolean;
  readonly #cache: InsightCache;
  readonly #now: () => number;

  constructor(options: MemoryInsightServiceOptions) {
    this.#db = options.db;
    this.#reader = options.reader;
    this.#memoryEnabled = options.memoryEnabled;
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
      const base = this.#base(target);
      const gate = this.#gate();
      if (gate) return { ...base, available: false, reason: gate, stats: null };
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return { ...base, available: false, reason: 'no_space', stats: null };
      const bank = await reader.bankFor(spaceRef(space));
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'overview', {}),
        async () => {
          const outcome = await reader.stats(bank);
          return this.#overviewResult(target, outcome);
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
      const base = this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyGraph(base, gate, limit);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyGraph(base, 'no_space', limit);
      const bank = await reader.bankFor(spaceRef(space));
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'graph', { limit, type: input.type, q: input.q }),
        async () => {
          const outcome = await reader.graph(bank, {
            limit,
            type: input.type,
            q: input.q,
          });
          if (httpStatusOf(outcome) === 404) {
            return this.#emptyGraph(base, 'bank_missing', limit);
          }
          if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
            return this.#emptyGraph(base, 'backend_unsupported', limit);
          }
          if (!outcome.ok) this.#throwReadFailure(outcome);
          const graph = normalizeMemoryGraph(outcome.body, {
            nodeLimit: limit,
            edgeLimit: LIMITS.memoryPanelGraphEdgesMax,
            textChars: LIMITS.memoryPanelGraphTextChars,
          });
          if (!graph) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
          const result: InsightGraphResult = {
            ...base,
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
          if (fitGraphBytes(result)) result.truncated = true;
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
      const base = this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyList(base, gate, limit, offset);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyList(base, 'no_space', limit, offset);
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
      };
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'list', params),
        async () => {
          const outcome = await reader.memories(bank, params);
          if (httpStatusOf(outcome) === 404) {
            return this.#emptyList(base, 'bank_missing', limit, offset);
          }
          if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
            return this.#emptyList(base, 'backend_unsupported', limit, offset);
          }
          if (!outcome.ok) this.#throwReadFailure(outcome);
          const normalized = normalizeMemoryList(outcome.body);
          if (!normalized) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
          const hasMore =
            normalized.raw_count > 0 &&
            (normalized.total !== null
              ? offset + normalized.raw_count < normalized.total
              : normalized.raw_count === limit);
          const result: InsightListResult = {
            ...base,
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

  async get(viewer: InsightViewer, input: InsightGetInput): Promise<InsightGetResult> {
    return this.#run(viewer, input.actor_id, 'get', async (target) => {
      const base = this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyGet(base, gate);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyGet(base, 'no_space');
      const bank = await reader.bankFor(spaceRef(space));
      return this.#cache.getOrLoad(
        this.#cacheKey(space, 'get', { memory_id: input.memory_id }),
        async () => {
          const outcome = await reader.memory(bank, input.memory_id);
          if (httpStatusOf(outcome) === 404) {
            throw insightBusinessError('NOT_FOUND');
          }
          if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
            return this.#emptyGet(base, 'backend_unsupported');
          }
          if (!outcome.ok) this.#throwReadFailure(outcome);
          const memory = normalizeMemoryDetail(outcome.body, input.memory_id);
          if (!memory) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
          return { ...base, available: true, reason: 'ok', memory };
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
      const base = this.#base(target);
      const gate = this.#gate();
      if (gate) return this.#emptyEntities(base, gate, view, input.limit ?? 0);
      const reader = this.#reader!;
      const space = await loadInsightSpace(this.#db, target.actor_id);
      if (!space) return this.#emptyEntities(base, 'no_space', view, input.limit ?? 0);
      const bank = await reader.bankFor(spaceRef(space));
      if (view === 'detail') {
        return this.#cache.getOrLoad(
          this.#cacheKey(space, 'entities', {
            view,
            entity_id: input.entity_id,
          }),
          async () =>
            this.#entityDetailResult(reader, bank, base, input.entity_id!),
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
              return this.#emptyEntities(base, 'bank_missing', view, limit);
            }
            if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
              return this.#emptyEntities(base, 'backend_unsupported', view, limit);
            }
            if (!outcome.ok) this.#throwReadFailure(outcome);
            const graph = normalizeEntityGraph(outcome.body, {
              edgeLimit: limit,
              nodeLimit: LIMITS.memoryPanelEntityGraphNodesMax,
              bytes: LIMITS.memoryPanelGraphBytes,
            });
            if (!graph) throw insightBusinessError('UPSTREAM_UNAVAILABLE');
            return {
              ...base,
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
            return this.#emptyEntities(base, 'bank_missing', 'list', limit, offset);
          }
          if (httpStatusOf(outcome) === 405 || httpStatusOf(outcome) === 410) {
            return this.#emptyEntities(base, 'backend_unsupported', 'list', limit, offset);
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
            ...base,
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

  #base(target: ActorRow): BaseView {
    return { actor: actorView(target), fetched_at: this.#now() };
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

  #overviewResult(target: ActorRow, outcome: InsightReadResult): InsightOverviewResult {
    const base = this.#base(target);
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
  ): InsightGraphResult {
    return {
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
