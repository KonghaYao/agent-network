/**
 * Not ported from upstream: Agent Network adapter between the vendored Fenix
 * memory UI and the `network_agent_memory_graph` / `network_agent_memory_get`
 * MCP tools.
 *
 * One user action = one graph call with `include_rows: true`; the returned
 * `table_rows` + `timeline.groups` feed constellation, table and timeline
 * without further requests. `network_agent_memory_overview/list/timeline` are
 * deliberately not used by the web panel.
 */

import { LIMITS } from '../../../../contracts/limits';
import {
  availabilityKind,
  availabilityText,
  fetchMemoryDetail,
  fetchMemoryEntities,
  fetchMemoryGraph,
  memoryFailureOf,
  type MemoryEntitiesResult,
  type MemoryEntityItem,
  type MemoryGraphResult,
} from '../memory-data';
import { FenixApiError, type FenixMemoryApi, type GraphQuery } from './api';
import type {
  EntityGraphResponse,
  EntityItem,
  GraphApiData,
  MemoryDetail as FenixMemoryDetail,
  MemoryTableRow,
} from './types';
import type { FactType } from './components/data-view-model';

const NO_ABORT = new AbortController().signal;

function unavailable(reason: MemoryGraphResult['reason']): FenixApiError {
  return new FenixApiError(availabilityText(reason), 'UNAVAILABLE');
}

/**
 * 把 MCP 错误归一成 Fenix 失败分类：权限拒绝保持 `forbidden`（无重试），
 * 其余保留原文案并允许重试。
 */
function translateError(error: unknown): never {
  if (error instanceof FenixApiError) throw error;
  const failure = memoryFailureOf(error);
  if (failure.kind === 'forbidden') throw new FenixApiError(failure.message, 'forbidden');
  throw new FenixApiError(failure.message, 'REQUEST_FAILED');
}

function assertAvailable(result: { available: boolean; reason: MemoryGraphResult['reason'] }): void {
  if (result.available) return;
  throw unavailable(result.reason);
}

function toGraphData(result: MemoryGraphResult): GraphApiData {
  const rows: MemoryTableRow[] = (result.table_rows ?? []).map((row) => ({
    id: row.id,
    text: row.text,
    fact_type: row.fact_type ?? undefined,
    occurred_start: row.occurred_start,
    occurred_end: row.occurred_end,
    occurred_at: row.occurred_at,
    mentioned_at: row.mentioned_at,
    entities: row.entities,
    proof_count: row.proof_count,
    tags: row.tags,
  }));
  return {
    table_rows: rows,
    rows_truncated: result.rows_truncated,
    timeline: result.timeline,
    nodes: result.nodes.map((node) => ({
      data: { id: node.id, label: node.label },
    })),
    edges: result.edges.map((edge) => ({
      data: {
        source: edge.source,
        target: edge.target,
        linkType: edge.type,
        ...(edge.entity ? { entityName: edge.entity } : {}),
        weight: edge.weight,
      },
    })),
    total_units: result.total_units ?? undefined,
  };
}

function toFenixDetail(memory: {
  id: string;
  text: string;
  fact_type: string | null;
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  entities: string[];
  tags: string[];
  context: string | null;
}): FenixMemoryDetail {
  return {
    id: memory.id,
    text: memory.text,
    context: memory.context ?? '',
    date: memory.occurred_start ?? memory.mentioned_at ?? '',
    type: memory.fact_type ?? '',
    mentioned_at: memory.mentioned_at,
    occurred_start: memory.occurred_start,
    occurred_end: memory.occurred_end,
    entities: memory.entities,
    // 本仓库详情不返回文档/分块标识，也不展示它们；保持 null 而不是伪造。
    document_id: null,
    chunk_id: null,
    tags: memory.tags,
    observation_scopes: null,
  };
}

/**
 * 本仓库实体列表/详情字段是 `name`，上游是 `canonical_name`；只做字段改名，
 * 不补造上游没有的标签或关联记忆正文。
 */
function toFenixEntity(entity: MemoryEntityItem): EntityItem {
  return {
    id: entity.id,
    canonical_name: entity.name,
    mention_count: entity.mention_count,
    first_seen: entity.first_seen,
    last_seen: entity.last_seen,
  };
}

/** `bank_missing` 表示尚未形成可查看的记忆，按空态处理；其余不可用原因交给失败块。 */
function assertEntitiesAvailable(result: MemoryEntitiesResult): void {
  if (result.available) return;
  if (availabilityKind(result.reason) === 'empty') return;
  throw unavailable(result.reason);
}

function toEntityGraph(result: MemoryEntitiesResult): EntityGraphResponse {
  const graph = result.graph;
  if (!graph) throw new FenixApiError('实体图谱暂不可用。', 'REQUEST_FAILED');
  return {
    nodes: graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.label,
        ...(node.mention_count !== undefined ? { mention_count: node.mention_count } : {}),
        ...(node.date ? { date: node.date } : {}),
      },
    })),
    edges: graph.edges.map((edge) => ({
      data: {
        source: edge.source,
        target: edge.target,
        weight: edge.weight,
        lastCooccurred: edge.last_cooccurred ?? null,
      },
    })),
  };
}

export interface CreateMemoryFenixApiOptions {
  actorId: string;
  token: string;
}

/** 每个弹窗一个适配器；调用方在渲染前注入，卸载时恢复默认拒绝实现。 */
export function createMemoryFenixApi({ actorId, token }: CreateMemoryFenixApiOptions): FenixMemoryApi {
  return {
    getStatus: async () => ({ enabled: true }),
    getGraph: async (params: GraphQuery) => {
      try {
        const result = await fetchMemoryGraph(
          actorId,
          token,
          {
            type: params.type as FactType,
            q: params.q,
            includeRows: true,
            rowsLimit: LIMITS.memoryPanelRowsDefault,
            rowsTextChars: LIMITS.memoryPanelRowsTextCharsDefault,
          },
          NO_ABORT,
        );
        // `bank_missing` 表示「还没有形成可查看的记忆」，且服务端已在同一响应里返回
        // 空 nodes/edges/table_rows；按空态渲染，不要归入「记忆暂不可用」。
        if (!result.available && availabilityKind(result.reason) === 'empty') {
          return toGraphData(result);
        }
        assertAvailable(result);
        return toGraphData(result);
      } catch (error) {
        translateError(error);
      }
    },
    // Observations no longer request bank stats: the panel's single-call contract
    // keeps graph as the only request per user action.
    getBankStats: async () => {
      throw new FenixApiError('bank stats are not available in the web panel', 'FENIX_NOT_WIRED');
    },
    getMemory: async (id: string) => {
      try {
        const result = await fetchMemoryDetail(actorId, id, token, NO_ABORT);
        assertAvailable(result);
        if (!result.memory) {
          throw new FenixApiError('记忆不存在或已不可用。', 'NOT_FOUND');
        }
        return toFenixDetail(result.memory);
      } catch (error) {
        translateError(error);
      }
    },
    // 实体列表严格服务端分页：`EntitiesView` 每次页码变化只发一次 list 请求，
    // 返回当前页并替换上一页；不做客户端多页累加。
    listEntities: async (params?: { limit?: number; offset?: number }) => {
      try {
        const result = await fetchMemoryEntities(
          actorId,
          token,
          {
            view: 'list',
            limit: params?.limit ?? LIMITS.memoryPanelEntitiesPageDefault,
            offset: params?.offset ?? 0,
          },
          NO_ABORT,
        );
        assertEntitiesAvailable(result);
        if (!result.available) {
          // `bank_missing`：没有可浏览的记忆，按空列表渲染。
          return { items: [], total: 0 };
        }
        return {
          items: result.items.map(toFenixEntity),
          // 上游可能不返回 total；用服务端的 `has_more` 保证至少还能翻到下一页，
          // 不把推断值当作精确总数（每次请求仍以服务端返回的页为准）。
          total:
            result.total ??
            result.offset + result.items.length + (result.has_more ? 1 : 0),
        };
      } catch (error) {
        translateError(error);
      }
    },
    getEntity: async (id: string): Promise<EntityItem> => {
      try {
        const result = await fetchMemoryEntities(
          actorId,
          token,
          { view: 'detail', entity_id: id },
          NO_ABORT,
        );
        assertEntitiesAvailable(result);
        if (!result.available || !result.entity) {
          throw new FenixApiError('实体不存在或已不可用。', 'NOT_FOUND');
        }
        return toFenixEntity(result.entity);
      } catch (error) {
        translateError(error);
      }
    },
    // 关系图一次取数：`min_count` 由视图固定为 1，边上限使用服务端上限，
    // 避免把上游默认的 2000 原样发给 MCP 工具。
    getEntityGraph: async (params?: { limit?: number; min_count?: number }) => {
      try {
        const result = await fetchMemoryEntities(
          actorId,
          token,
          {
            view: 'graph',
            limit: Math.min(
              params?.limit ?? LIMITS.memoryPanelEntityGraphEdgesMax,
              LIMITS.memoryPanelEntityGraphEdgesMax,
            ),
            min_count: params?.min_count ?? 1,
          },
          NO_ABORT,
        );
        assertEntitiesAvailable(result);
        if (!result.available) return { nodes: [], edges: [] };
        return toEntityGraph(result);
      } catch (error) {
        translateError(error);
      }
    },
  };
}
