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
  availabilityText,
  fetchMemoryDetail,
  fetchMemoryGraph,
  memoryFailureOf,
  type MemoryGraphResult,
} from '../memory-data';
import { FenixApiError, type FenixMemoryApi, type GraphQuery } from './api';
import type {
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
    // 实体视角本阶段沿用既有 MemoryEntities；Fenix EntitiesView 的取数
    // 适配留到下一阶段（不提前伪造数据）。
    listEntities: async () => {
      throw new FenixApiError('Fenix entities adapter is not enabled in this phase', 'FENIX_NOT_WIRED');
    },
    getEntity: async (): Promise<EntityItem> => {
      throw new FenixApiError('Fenix entities adapter is not enabled in this phase', 'FENIX_NOT_WIRED');
    },
    getEntityGraph: async () => {
      throw new FenixApiError('Fenix entities adapter is not enabled in this phase', 'FENIX_NOT_WIRED');
    },
  };
}
