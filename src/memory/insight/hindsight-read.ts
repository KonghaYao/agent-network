/**
 * Hindsight 只读 GET 客户端。
 *
 * 复用现有 transport 的超时、重试、取消和凭据处理；错误结果只保留状态/分类，
 * 丢弃上游响应体，避免把后端诊断文本透传给 MCP 客户端。所有方法都是 GET，
 * 不提供 recall/reflect 或任何写操作。
 */
import { LIMITS } from '../../contracts/limits';
import type { MemorySpaceRef } from '../contracts';
import {
  resolveHindsightConfig,
  type HindsightAdapterConfig,
  type ResolvedHindsightConfig,
} from '../adapters/hindsight-config';
import { HindsightTransport } from '../adapters/hindsight-transport';
import { bankIdFor } from '../adapters/hindsight-tags';

export type InsightReadResult =
  | { ok: true; body: unknown }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'timeout' | 'network' | 'parse' | 'cancelled' };

export interface InsightGraphQuery {
  limit: number;
  type?: string;
  q?: string;
}

export interface InsightMemoryListQuery {
  limit: number;
  offset: number;
  q?: string;
  type?: string;
  entity_id?: string;
  time_field?: string;
  start_date?: string;
  end_date?: string;
  /** 多页聚合共享同一个绝对截止时间；不传时每次请求各自按 transport 超时。 */
  deadline_at?: number | null;
}

export interface InsightEntityListQuery {
  limit: number;
  offset: number;
}

export interface InsightEntityGraphQuery {
  limit: number;
  min_count: number;
}

export interface InsightReader {
  bankFor(space: MemorySpaceRef): Promise<string>;
  stats(bank: string): Promise<InsightReadResult>;
  graph(bank: string, query: InsightGraphQuery): Promise<InsightReadResult>;
  memories(bank: string, query: InsightMemoryListQuery): Promise<InsightReadResult>;
  memory(bank: string, memoryId: string): Promise<InsightReadResult>;
  entities(bank: string, query: InsightEntityListQuery): Promise<InsightReadResult>;
  entityGraph(bank: string, query: InsightEntityGraphQuery): Promise<InsightReadResult>;
  entity(bank: string, entityId: string): Promise<InsightReadResult>;
}

function appendParams(
  path: string,
  values: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export class HindsightInsightReader implements InsightReader {
  readonly #config: ResolvedHindsightConfig;
  readonly #transport: HindsightTransport;

  constructor(config: HindsightAdapterConfig) {
    const resolved = resolveHindsightConfig({
      ...config,
      requestTimeoutMs: config.requestTimeoutMs ?? LIMITS.memoryPanelTimeoutMs,
      maxRetries: config.maxRetries ?? 1,
    });
    if (!resolved) throw new Error('Hindsight insight reader requires configuration');
    this.#config = resolved;
    this.#transport = new HindsightTransport(resolved);
  }

  cancelAll(): void {
    this.#transport.cancelAll();
  }

  async bankFor(space: MemorySpaceRef): Promise<string> {
    return bankIdFor(this.#config.bankPrefix, space);
  }

  async stats(bank: string): Promise<InsightReadResult> {
    return this.#get(this.#bankPath(bank, 'stats'));
  }

  async graph(bank: string, query: InsightGraphQuery): Promise<InsightReadResult> {
    return this.#get(
      appendParams(this.#bankPath(bank, 'graph'), {
        limit: query.limit,
        type: query.type,
        q: query.q,
      }),
    );
  }

  async memories(bank: string, query: InsightMemoryListQuery): Promise<InsightReadResult> {
    return this.#get(
      appendParams(this.#bankPath(bank, 'memories/list'), {
        limit: query.limit,
        offset: query.offset,
        q: query.q,
        type: query.type,
        entity_id: query.entity_id,
        time_field: query.time_field,
        start_date: query.start_date,
        end_date: query.end_date,
      }),
      query.deadline_at ?? null,
    );
  }

  async memory(bank: string, memoryId: string): Promise<InsightReadResult> {
    return this.#get(
      `${this.#bankPath(bank, 'memories')}/${encodeURIComponent(memoryId)}`,
    );
  }

  async entities(bank: string, query: InsightEntityListQuery): Promise<InsightReadResult> {
    return this.#get(
      appendParams(this.#bankPath(bank, 'entities'), {
        limit: query.limit,
        offset: query.offset,
      }),
    );
  }

  async entityGraph(bank: string, query: InsightEntityGraphQuery): Promise<InsightReadResult> {
    return this.#get(
      appendParams(this.#bankPath(bank, 'entities/graph'), {
        limit: query.limit,
        min_count: query.min_count,
      }),
    );
  }

  async entity(bank: string, entityId: string): Promise<InsightReadResult> {
    return this.#get(
      `${this.#bankPath(bank, 'entities')}/${encodeURIComponent(entityId)}`,
    );
  }

  #bankPath(bank: string, suffix: string): string {
    return `/v1/default/banks/${encodeURIComponent(bank)}/${suffix}`;
  }

  async #get(path: string, deadlineAt: number | null = null): Promise<InsightReadResult> {
    const outcome = await this.#transport.request('GET', path, {
      deadlineAt,
      retry: true,
    });
    switch (outcome.kind) {
      case 'ok':
        return { ok: true, body: outcome.body };
      case 'http':
        // 不保留状态码之外的响应内容。
        return { ok: false, kind: 'http', status: outcome.status };
      case 'timeout':
      case 'network':
      case 'parse':
      case 'cancelled':
        return { ok: false, kind: outcome.kind };
      case 'disabled':
        return { ok: false, kind: 'network' };
    }
  }
}
