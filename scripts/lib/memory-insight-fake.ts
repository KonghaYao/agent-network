/**
 * 只读 insight 的受控 Hindsight HTTP 假服务。
 *
 * 只实现面板读取的 GET 端点；记录方法/路径/查询，便于验证服务端没有调用
 * recall/reflect 或任何写操作，也便于断言 bank 映射与过滤参数。
 */
export interface FakeInsightRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

export interface FakeInsightBank {
  stats?: Record<string, unknown>;
  graph?: Record<string, unknown>;
  entityGraph?: Record<string, unknown>;
  memories?: Record<string, unknown>[];
  memoryDetails?: Record<string, Record<string, unknown>>;
  entities?: Record<string, unknown>[];
  entityDetails?: Record<string, Record<string, unknown>>;
}

interface FailureRule {
  status: number;
  remaining: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export class FakeHindsightInsight {
  readonly token: string;
  readonly requests: FakeInsightRequest[] = [];
  readonly #banks = new Map<string, FakeInsightBank>();
  readonly #failures = new Map<string, FailureRule>();
  readonly #delays = new Map<string, number>();
  readonly #malformed = new Set<string>();
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor(token: string) {
    this.token = token;
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => this.#handle(request),
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  seedBank(bank: string, fixture: FakeInsightBank): void {
    this.#banks.set(bank, fixture);
  }

  fail(pathContains: string, status: number, count = 1): void {
    this.#failures.set(pathContains, { status, remaining: count });
  }

  delay(pathContains: string, ms: number): void {
    this.#delays.set(pathContains, ms);
  }

  malformed(pathContains: string): void {
    this.#malformed.add(pathContains);
  }

  resetRequests(): void {
    this.requests.length = 0;
  }

  requestCount(method?: string, pathContains?: string): number {
    return this.requests.filter(
      (request) =>
        (method === undefined || request.method === method) &&
        (pathContains === undefined || request.path.includes(pathContains)),
    ).length;
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers,
    });

    const authorization = headers.authorization ?? '';
    if (authorization !== `Bearer ${this.token}`) {
      return json({ error: 'unauthorized' }, 401);
    }
    if (request.method !== 'GET') {
      return json({ detail: 'read only' }, 405);
    }

    for (const [needle, delayMs] of this.#delays) {
      if (url.pathname.includes(needle)) await Bun.sleep(delayMs);
    }
    for (const needle of this.#malformed) {
      if (url.pathname.includes(needle)) {
        return new Response('not-json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    for (const [needle, rule] of this.#failures) {
      if (url.pathname.includes(needle) && rule.remaining > 0) {
        rule.remaining -= 1;
        return json({ detail: 'upstream-secret-body' }, rule.status);
      }
    }

    const match = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)(?:\/(.*))?$/u);
    if (!match) return json({ detail: 'not found' }, 404);
    const bankId = decodeURIComponent(match[1] ?? '');
    const rest = match[2] ?? '';
    const bank = this.#banks.get(bankId);
    if (!bank) return json({ detail: "Bank not found" }, 404);

    if (rest === 'stats') {
      return json(bank.stats ?? {});
    }
    if (rest === 'graph') {
      return this.#graphPage(bank, url.searchParams);
    }
    if (rest === 'memories/list') {
      return this.#listMemories(bank, url.searchParams);
    }
    if (rest.startsWith('memories/')) {
      const id = decodeURIComponent(rest.slice('memories/'.length));
      const detail = bank.memoryDetails?.[id];
      return detail ? json(detail) : json({ detail: 'not found' }, 404);
    }
    if (rest === 'entities/graph') {
      return json(bank.entityGraph ?? { nodes: [], edges: [] });
    }
    if (rest === 'entities') {
      const limit = this.#intParam(url.searchParams.get('limit'), 50);
      const offset = this.#intParam(url.searchParams.get('offset'), 0);
      const all = bank.entities ?? [];
      const items = all.slice(offset, offset + limit);
      return json({ items, total: all.length });
    }
    if (rest.startsWith('entities/')) {
      const id = decodeURIComponent(rest.slice('entities/'.length));
      const detail = bank.entityDetails?.[id];
      return detail ? json(detail) : json({ detail: 'not found' }, 404);
    }
    return json({ detail: 'not found' }, 404);
  }

  /**
   * 模拟 Hindsight v1.2.1 的 graph 语义：nodes 与 table_rows 来自同一个
   * `graph_units(limit)` 结果页，边的两个端点都必须在可见页内。
   */
  #graphPage(bank: FakeInsightBank, query: URLSearchParams): Response {
    const fixture = bank.graph ?? { nodes: [], edges: [], table_rows: [] };
    const limit = this.#intParam(query.get('limit'), 1_000);
    const nodes = Array.isArray(fixture.nodes) ? fixture.nodes.slice(0, limit) : [];
    const tableRows = Array.isArray(fixture.table_rows)
      ? fixture.table_rows.slice(0, limit)
      : [];
    const visible = new Set<string>();
    for (const entry of nodes) {
      const record = this.#unwrap(entry);
      const id = this.#string(record?.id);
      if (id) visible.add(id);
    }
    const edges = (Array.isArray(fixture.edges) ? fixture.edges : []).filter((entry) => {
      const edge = this.#unwrap(entry);
      const source = this.#string(edge?.source);
      const target = this.#string(edge?.target);
      return source !== null && target !== null && visible.has(source) && visible.has(target);
    });
    return json({ ...fixture, nodes, edges, table_rows: tableRows });
  }

  /** Hindsight 的节点/边可能包在 `{ data: ... }` 里；两种形状都要能读。 */
  #unwrap(value: unknown): Record<string, unknown> | null {
    const record = this.#record(value);
    return this.#record(record?.data) ?? record;
  }

  #record(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  #string(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  #listMemories(bank: FakeInsightBank, query: URLSearchParams): Response {
    const limit = this.#intParam(query.get('limit'), 20);
    const offset = this.#intParam(query.get('offset'), 0);
    const q = query.get('q')?.toLowerCase() ?? null;
    const type = query.get('type');
    const entityId = query.get('entity_id');
    let items = bank.memories ?? [];
    if (q) items = items.filter((item) => String(item.text ?? '').toLowerCase().includes(q));
    if (type) items = items.filter((item) => item.fact_type === type);
    if (entityId) {
      items = items.filter((item) => {
        const raw = item.entities;
        const entities =
          typeof raw === 'string'
            ? raw.split(',').map((entry) => entry.trim())
            : stringArray(raw);
        return entities.includes(entityId) || stringArray(item.entity_ids).includes(entityId);
      });
    }
    const page = items.slice(offset, offset + limit);
    return json({ items: page, total: items.length });
  }

  #intParam(value: string | null, fallback: number): number {
    if (value === null) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }
}
