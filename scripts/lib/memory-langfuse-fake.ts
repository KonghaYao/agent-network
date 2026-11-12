/**
 * MF09 受控 Langfuse 假 HTTP 服务。
 *
 * 只模拟 Public API Observations v2 的读取形状：Basic Auth、ISO 时间窗口、
 * cursor 分页与 `{ data, meta: { cursor } }`。用于验证请求形状、故障顺序和
 * 凭据不泄漏；不是真实 Langfuse 契约测试。
 */
export interface FakeLangfuseObservation {
  id: string;
  traceId: string;
  projectId: string;
  type: string;
  name: string | null;
  startTime: string;
  endTime?: string | null;
  traceName?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  input?: string | null;
  output?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FakeLangfuseRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
}

export interface FakeLangfuseBehavior {
  /** 前 N 个请求返回 500，用于重试测试。 */
  failures: number;
  /** 固定状态码；null 表示正常处理。 */
  status: number | null;
  delayMs: number;
  /** 挂起直到客户端取消。 */
  hang: boolean;
  /** 200 但响应不可解析。 */
  malformed: 'json' | 'shape' | null;
  /** 重复返回同一 cursor，用于死循环保护测试。 */
  cursorLoop: boolean;
  /** 即使客户端要求更大页，也最多返回这么多条。 */
  pageSizeOverride: number | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function basic(publicKey: string, secretKey: string): string {
  return `Basic ${btoa(`${publicKey}:${secretKey}`)}`;
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class FakeLangfuse {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly behavior: FakeLangfuseBehavior = {
    failures: 0,
    status: null,
    delayMs: 0,
    hang: false,
    malformed: null,
    cursorLoop: false,
    pageSizeOverride: null,
  };
  readonly requests: FakeLangfuseRequest[] = [];
  readonly observations: FakeLangfuseObservation[] = [];
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor(publicKey: string, secretKey: string) {
    this.publicKey = publicKey;
    this.secretKey = secretKey;
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => this.handle(request),
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  get requestCount(): number {
    return this.requests.length;
  }

  addObservation(observation: FakeLangfuseObservation): void {
    this.observations.push(observation);
  }

  resetRequests(): void {
    this.requests.length = 0;
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of request.headers.entries()) headers[key.toLowerCase()] = value;
    this.requests.push({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers,
    });
    if (this.behavior.hang) {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 5_000);
        request.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      return new Response('', { status: 499 });
    }
    if (this.behavior.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.behavior.delayMs));
    }
    if (this.behavior.failures > 0) {
      this.behavior.failures -= 1;
      // 故意把凭据放进错误正文，验证客户端不会把正文写进结果/日志。
      return json({ error: `upstream failure ${this.publicKey}:${this.secretKey}` }, 500);
    }
    if (this.behavior.status !== null) {
      return json({ error: `status ${this.behavior.status}` }, this.behavior.status);
    }
    if (headers.authorization !== basic(this.publicKey, this.secretKey)) {
      return json({ error: 'unauthorized' }, 401);
    }
    if (request.method !== 'GET' || url.pathname !== '/api/public/v2/observations') {
      return json({ error: 'not found' }, 404);
    }
    if (this.behavior.malformed === 'json') {
      return new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (this.behavior.malformed === 'shape') {
      return json({ data: { not: 'an array' }, meta: {} });
    }
    const from = parseTime(url.searchParams.get('fromStartTime'));
    const to = parseTime(url.searchParams.get('toStartTime'));
    if (from === null || to === null || from >= to) {
      return json({ error: 'invalid time window' }, 400);
    }
    const requestedLimit = Number(url.searchParams.get('limit') ?? '50');
    const limit = Math.max(
      1,
      Math.min(
        Number.isSafeInteger(requestedLimit) ? requestedLimit : 50,
        1_000,
        this.behavior.pageSizeOverride ?? 1_000,
      ),
    );
    const cursor = url.searchParams.get('cursor');
    let offset = 0;
    if (cursor !== null) {
      if (this.behavior.cursorLoop) {
        offset = 0;
      } else {
        const parsed = Number(cursor);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          return json({ error: 'invalid cursor' }, 400);
        }
        offset = parsed;
      }
    }
    const matching = this.observations
      .filter((observation) => {
        const start = parseTime(observation.startTime);
        return start !== null && start >= from && start < to;
      })
      .sort((left, right) => {
        const byTime = Date.parse(right.startTime) - Date.parse(left.startTime);
        return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
      });
    const page = matching.slice(offset, offset + limit);
    const hasMore = offset + page.length < matching.length;
    const nextCursor = hasMore
      ? this.behavior.cursorLoop
        ? 'loop'
        : String(offset + page.length)
      : null;
    return json({ data: page, meta: { cursor: nextCursor } });
  }
}
