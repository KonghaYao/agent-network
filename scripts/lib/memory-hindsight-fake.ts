/**
 * MF04 受控 Hindsight 假 HTTP 服务。
 *
 * 只模拟适配器依赖的官方端点形状；用于验证请求内容、分页、清除证据与故障
 * 顺序。它不是第二适配器，也不替代真实 Hindsight 契约测试。
 */
export interface FakeHindsightRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeHindsightBehavior {
  bankFailures: number;
  retainFailures: number;
  recallFailures: number;
  deleteFailures: number;
  deleteKeepsDocument: boolean;
  bankDelayMs: number;
  retainDelayMs: number;
  recallDelayMs: number;
  deleteDelayMs: number;
  operationDelayMs: number;
  listMemoryDelayMs: number;
  listDocumentDelayMs: number;
}

export interface FakeHindsightDocument {
  id: string;
  bank: string;
  text: string;
  tags: string[];
  metadata: Record<string, string>;
}

interface FakeBank {
  documents: FakeHindsightDocument[];
}

interface FakeOperation {
  id: string;
  bank: string;
  status: string;
  bodyHash: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function tagLeafMatches(tags: readonly string[], leaf: unknown): boolean {
  if (!isRecord(leaf)) return false;
  const wanted = stringArray(leaf.tags);
  const mode = typeof leaf.match === 'string' ? leaf.match : 'any';
  if (wanted.length === 0) return mode === 'exact' ? tags.length === 0 : true;
  switch (mode) {
    case 'all':
      return tags.length === 0 || wanted.every((tag) => tags.includes(tag));
    case 'all_strict':
      return wanted.every((tag) => tags.includes(tag));
    case 'any':
      return tags.length === 0 || wanted.some((tag) => tags.includes(tag));
    case 'any_strict':
      return wanted.some((tag) => tags.includes(tag));
    case 'exact':
      return tags.length === wanted.length && wanted.every((tag) => tags.includes(tag));
    default:
      return false;
  }
}

function tagGroupMatches(tags: readonly string[], group: unknown): boolean {
  if (!isRecord(group)) return false;
  if (Array.isArray(group.or)) return group.or.some((entry) => tagGroupMatches(tags, entry));
  if (Array.isArray(group.and)) return group.and.every((entry) => tagGroupMatches(tags, entry));
  if ('not' in group) return !tagGroupMatches(tags, group.not);
  return tagLeafMatches(tags, group);
}

function matchesTagsFilter(
  tags: readonly string[],
  tagGroups: unknown,
  flatTags: readonly string[],
  flatMatch: string,
): boolean {
  if (Array.isArray(tagGroups) && tagGroups.length > 0) {
    return tagGroups.every((group) => tagGroupMatches(tags, group));
  }
  if (flatTags.length === 0) return true;
  return tagLeafMatches(tags, { tags: flatTags, match: flatMatch || 'any' });
}

export class FakeHindsight {
  readonly token: string;
  readonly behavior: FakeHindsightBehavior;
  readonly requests: FakeHindsightRequest[] = [];
  readonly documents: FakeHindsightDocument[] = [];
  readonly #banks = new Map<string, FakeBank>();
  readonly #operations = new Map<string, FakeOperation>();
  readonly #server: ReturnType<typeof Bun.serve>;
  #sequence = 0;

  constructor(token: string) {
    this.token = token;
    this.behavior = {
      bankFailures: 0,
      retainFailures: 0,
      recallFailures: 0,
      deleteFailures: 0,
      deleteKeepsDocument: false,
      bankDelayMs: 0,
      retainDelayMs: 0,
      recallDelayMs: 0,
      deleteDelayMs: 0,
      operationDelayMs: 0,
      listMemoryDelayMs: 0,
      listDocumentDelayMs: 0,
    };
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => this.handle(request),
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  setOperationStatus(id: string, status: string): void {
    const operation = this.#operations.get(id);
    if (operation) operation.status = status;
  }

  lastOperationId(): string | null {
    const ids = [...this.#operations.keys()];
    return ids[ids.length - 1] ?? null;
  }

  requestCount(method: string, pathContains: string): number {
    return this.requests.filter(
      (request) => request.method === method && request.path.includes(pathContains),
    ).length;
  }

  async waitForRequest(
    method: string,
    pathContains: string,
    count = 1,
    timeoutMs = 2_000,
  ): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.requestCount(method, pathContains) >= count) return;
      await Bun.sleep(5);
    }
    throw new Error(`fake hindsight timed out waiting for ${method} ${pathContains}`);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers) headers[key.toLowerCase()] = value;
    let body: unknown = null;
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      const text = await request.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          return json({ detail: 'invalid json' }, 400);
        }
      }
    }
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    });

    if (url.pathname === '/healthz') return new Response('ok');
    const authorization = headers.authorization ?? '';
    const apiKey = headers['x-api-key'] ?? '';
    if (authorization !== `Bearer ${this.token}` && apiKey !== this.token) {
      return json({ error: 'unauthorized' }, 401);
    }

    const bankPath = url.pathname.match(/^\/v1\/default\/banks\/([^/]+)(?:\/(.*))?$/u);
    if (!bankPath) return json({ detail: 'not found' }, 404);
    const bankId = decodeURIComponent(bankPath[1] ?? '');
    const rest = bankPath[2] ?? '';

    if (request.method === 'PUT' && rest === '') {
      await this.delay(this.behavior.bankDelayMs);
      if (this.behavior.bankFailures > 0) {
        this.behavior.bankFailures -= 1;
        return json({ error: 'bank unavailable' }, 503);
      }
      this.ensureBank(bankId);
      return json({ success: true, bank_id: bankId });
    }
    if (!this.#banks.has(bankId)) return json({ detail: 'bank not found' }, 404);

    if (request.method === 'POST' && rest === 'memories') {
      return this.retain(bankId, body);
    }
    if (request.method === 'POST' && rest === 'memories/recall') {
      return this.recall(bankId, body);
    }
    if (request.method === 'GET' && rest === 'memories/list') {
      return this.listMemories(bankId, url.searchParams);
    }
    if (request.method === 'GET' && rest.startsWith('operations/')) {
      return this.operationStatus(rest.slice('operations/'.length));
    }
    if (request.method === 'GET' && rest === 'documents') {
      return this.listDocuments(bankId, url.searchParams);
    }
    if (request.method === 'GET' && rest.startsWith('documents/')) {
      return this.getDocument(bankId, decodeURIComponent(rest.slice('documents/'.length)));
    }
    if (request.method === 'DELETE' && rest.startsWith('documents/')) {
      return this.deleteDocument(bankId, decodeURIComponent(rest.slice('documents/'.length)));
    }
    return json({ detail: 'not found' }, 404);
  }

  private ensureBank(bankId: string): FakeBank {
    let bank = this.#banks.get(bankId);
    if (!bank) {
      bank = { documents: [] };
      this.#banks.set(bankId, bank);
    }
    return bank;
  }

  private async retain(bankId: string, body: unknown): Promise<Response> {
    await this.delay(this.behavior.retainDelayMs);
    if (this.behavior.retainFailures > 0) {
      this.behavior.retainFailures -= 1;
      return json({ error: 'retain unavailable' }, 503);
    }
    if (!isRecord(body) || !Array.isArray(body.items)) {
      return json({ detail: 'items required' }, 422);
    }
    const operationId =
      typeof body.operation_id === 'string' && body.operation_id.length > 0
        ? body.operation_id
        : `op_${++this.#sequence}`;
    const bodyHash = JSON.stringify(body);
    const existing = this.#operations.get(operationId);
    if (existing) {
      if (existing.bodyHash !== bodyHash) return json({ error: 'operation conflict' }, 409);
      return json({
        success: true,
        bank_id: bankId,
        items_count: body.items.length,
        async: true,
        operation_id: operationId,
      });
    }
    const bank = this.ensureBank(bankId);
    for (const rawItem of body.items) {
      if (!isRecord(rawItem) || typeof rawItem.content !== 'string') {
        return json({ detail: 'content required' }, 422);
      }
      const documentId =
        typeof rawItem.document_id === 'string' && rawItem.document_id.length > 0
          ? rawItem.document_id
          : `doc_${++this.#sequence}`;
      bank.documents.push({
        id: documentId,
        bank: bankId,
        text: rawItem.content,
        tags: stringArray(rawItem.tags),
        metadata: stringRecord(rawItem.metadata),
      });
      this.documents.push(bank.documents[bank.documents.length - 1]!);
    }
    this.#operations.set(operationId, {
      id: operationId,
      bank: bankId,
      status: 'pending',
      bodyHash,
    });
    return json({
      success: true,
      bank_id: bankId,
      items_count: body.items.length,
      async: true,
      operation_id: operationId,
    });
  }

  private async recall(bankId: string, body: unknown): Promise<Response> {
    await this.delay(this.behavior.recallDelayMs);
    if (this.behavior.recallFailures > 0) {
      this.behavior.recallFailures -= 1;
      return json({ error: 'recall unavailable' }, 503);
    }
    if (!isRecord(body) || typeof body.query !== 'string') {
      return json({ detail: 'query required' }, 422);
    }
    const bank = this.#banks.get(bankId);
    if (!bank) return json({ detail: 'bank not found' }, 404);
    const tagGroups = body.tag_groups;
    const flatTags = stringArray(body.tags);
    const flatMatch = typeof body.tags_match === 'string' ? body.tags_match : 'any';
    const results = bank.documents
      .filter((document) => matchesTagsFilter(document.tags, tagGroups, flatTags, flatMatch))
      .map((document) => this.fact(document));
    return json({ results });
  }

  private async listMemories(bankId: string, query: URLSearchParams): Promise<Response> {
    await this.delay(this.behavior.listMemoryDelayMs);
    const bank = this.#banks.get(bankId);
    if (!bank) return json({ detail: 'bank not found' }, 404);
    const limit = this.limit(query, 100);
    const offset = this.offset(query);
    const items = bank.documents
      .slice(offset, offset + limit)
      .map((document) => this.fact(document));
    return json({ items, total: bank.documents.length, limit, offset });
  }

  private async operationStatus(operationId: string): Promise<Response> {
    await this.delay(this.behavior.operationDelayMs);
    const operation = this.#operations.get(operationId);
    if (!operation) return json({ detail: 'operation not found' }, 404);
    return json({
      id: operation.id,
      status: operation.status,
      operation_type: 'retain',
    });
  }

  private async listDocuments(bankId: string, query: URLSearchParams): Promise<Response> {
    await this.delay(this.behavior.listDocumentDelayMs);
    const bank = this.#banks.get(bankId);
    if (!bank) return json({ detail: 'bank not found' }, 404);
    const tags = query.getAll('tags');
    const match = query.get('tags_match') ?? 'all_strict';
    const filtered = bank.documents.filter((document) =>
      tags.length === 0
        ? true
        : tagLeafMatches(document.tags, { tags, match }),
    );
    const limit = this.limit(query, 100);
    const offset = this.offset(query);
    return json({
      items: filtered.slice(offset, offset + limit).map((document) => ({
        id: document.id,
        tags: document.tags,
      })),
      total: filtered.length,
      limit,
      offset,
    });
  }

  private async getDocument(bankId: string, documentId: string): Promise<Response> {
    const bank = this.#banks.get(bankId);
    const document = bank?.documents.find((entry) => entry.id === documentId);
    return document
      ? json({ id: document.id, tags: document.tags })
      : json({ detail: 'document not found' }, 404);
  }

  private async deleteDocument(bankId: string, documentId: string): Promise<Response> {
    await this.delay(this.behavior.deleteDelayMs);
    if (this.behavior.deleteFailures > 0) {
      this.behavior.deleteFailures -= 1;
      return json({ error: 'delete unavailable' }, 503);
    }
    const bank = this.#banks.get(bankId);
    if (!bank) return json({ detail: 'bank not found' }, 404);
    if (this.behavior.deleteKeepsDocument) {
      return json({ success: true, memory_units_deleted: 1 });
    }
    const before = bank.documents.length;
    bank.documents = bank.documents.filter((document) => document.id !== documentId);
    return json({
      success: true,
      memory_units_deleted: before - bank.documents.length,
    });
  }

  private fact(document: FakeHindsightDocument): Record<string, unknown> {
    return {
      id: `fact_${document.id}`,
      text: document.text,
      type: 'experience',
      metadata: document.metadata,
      tags: document.tags,
      document_id: document.id,
      scores: { final: 1 },
    };
  }

  private limit(query: URLSearchParams, fallback: number): number {
    const value = Number(query.get('limit') ?? String(fallback));
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : fallback;
  }

  private offset(query: URLSearchParams): number {
    const value = Number(query.get('offset') ?? '0');
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private async delay(ms: number): Promise<void> {
    if (ms > 0) await Bun.sleep(ms);
  }
}
