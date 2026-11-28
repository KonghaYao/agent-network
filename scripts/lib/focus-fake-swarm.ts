/**
 * 测试用假 Peri-Swarm。
 *
 * 只实现 WeBots SDK 客户端实际调用的 `/v1/agents/sessions*` 路由，记录每次
 * 请求（方法、路径、查询、头、body）供断言；不访问网络、不记录真实凭据。
 * 响应形状对齐官方 `openai@7.60.0` 的 Agents API 与 Peri 的扩展字段。
 */

export interface FakeSwarmRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  idempotencyKey: string | null;
}

export interface FakeSwarmOptions {
  /** 首次 create 返回的根会话 ID。 */
  rootSessionId?: string;
  /** `null` 表示未配置；数字表示 retrieve/create 直接返回该状态码。 */
  retrieveStatus?: number | null;
  createStatus?: number | null;
  submitStatus?: number | null;
}

export interface FakeSwarmBehavior {
  retrieveStatus: number | null;
  createStatus: number | null;
  submitStatus: number | null;
  /** retrieve 返回的根 ID；null 表示沿用首次创建的根。 */
  rootOverride: string | null;
  /** 响应体附加字段，用于验证错误分类不会泄露正文。 */
  errorBody: string;
  /** 事件流中发送的终态事件。 */
  streamEvent: Record<string, unknown>;
}

export interface FakeSwarm {
  /** 以 `/v1` 结尾，可直接作为 baseURL。 */
  url: string;
  requests: FakeSwarmRequest[];
  behavior: FakeSwarmBehavior;
  close(): Promise<void>;
}

interface FakeSession {
  id: string;
  rootSessionId: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function startFocusFakeSwarm(options: FakeSwarmOptions = {}): FakeSwarm {
  const requests: FakeSwarmRequest[] = [];
  const sessions = new Map<string, FakeSession>();
  const idempotentSessions = new Map<string, FakeSession>();
  let sessionCount = 0;

  const behavior: FakeSwarmBehavior = {
    retrieveStatus: options.retrieveStatus ?? null,
    createStatus: options.createStatus ?? null,
    submitStatus: options.submitStatus ?? null,
    rootOverride: null,
    errorBody: 'upstream-secret-text',
    streamEvent: { type: 'agent.session.idle', turn_id: 'turn_fake_1', seq: 7 },
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/v1/u, '');
      const query = Object.fromEntries(url.searchParams.entries());
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      let body: unknown = null;
      if (request.method === 'POST') {
        body = await request.json().catch(() => null);
      }
      requests.push({
        method: request.method,
        path,
        query,
        headers,
        body,
        idempotencyKey: headers['idempotency-key'] ?? null,
      });

      if (path === '/agents/sessions' && request.method === 'POST') {
        if (behavior.createStatus !== null) {
          return json({ error: { message: behavior.errorBody } }, behavior.createStatus);
        }
        const key = headers['idempotency-key'] ?? '';
        const existing = key ? idempotentSessions.get(key) : undefined;
        if (existing) {
          return json({
            id: existing.id,
            object: 'agent.session',
            status: 'idle',
            rootSessionId: existing.rootSessionId,
          });
        }
        sessionCount += 1;
        const session: FakeSession = {
          id: `sess_fake_${sessionCount}`,
          rootSessionId: options.rootSessionId ?? `root_fake_${sessionCount}`,
        };
        sessions.set(session.id, session);
        if (key) idempotentSessions.set(key, session);
        return json({
          id: session.id,
          object: 'agent.session',
          status: 'idle',
          rootSessionId: session.rootSessionId,
        });
      }

      const sessionMatch = path.match(/^\/agents\/sessions\/([^/]+)(?:\/(.*))?$/u);
      if (!sessionMatch) return json({ error: { message: 'not found' } }, 404);
      const sessionId = sessionMatch[1] as string;
      const rest = sessionMatch[2] ?? '';
      const session = sessions.get(sessionId);

      if (rest === '' && request.method === 'GET') {
        if (behavior.retrieveStatus !== null) {
          return json({ error: { message: behavior.errorBody } }, behavior.retrieveStatus);
        }
        if (!session) return json({ error: { message: behavior.errorBody } }, 404);
        return json({
          id: session.id,
          object: 'agent.session',
          status: 'idle',
          rootSessionId: behavior.rootOverride ?? session.rootSessionId,
        });
      }

      if (rest === 'events' && request.method === 'POST') {
        if (behavior.submitStatus !== null) {
          return json({ error: { message: behavior.errorBody } }, behavior.submitStatus);
        }
        if (!session) return json({ error: { message: behavior.errorBody } }, 404);
        return json(
          {
            inputId: `inp_fake_${requests.length}`,
            accepted: true,
            disposition: 'accepted',
            mode: 'queued',
            lastItemSeq: 7,
          },
          202,
        );
      }

      if (rest === 'events' && request.method === 'GET') {
        if (!session) return json({ error: { message: behavior.errorBody } }, 404);
        const payload = `data: ${JSON.stringify(behavior.streamEvent)}\n\n`;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(payload));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store',
            },
          },
        );
      }

      if (rest === 'items' && request.method === 'GET') {
        if (!session) return json({ error: { message: behavior.errorBody } }, 404);
        return json({
          object: 'list',
          data: [
            { id: 'item_fake_1', type: 'message' },
            { id: 'item_fake_2', type: 'message' },
          ],
          has_more: true,
          nextCursor: 'item_fake_2',
        });
      }

      const turnMatch = rest.match(/^turns\/([^/]+)$/u);
      if (turnMatch && request.method === 'GET') {
        if (!session) return json({ error: { message: behavior.errorBody } }, 404);
        return json({
          id: turnMatch[1],
          status: 'completed',
          error: null,
          object: 'agent.session.turn',
        });
      }

      return json({ error: { message: 'not found' } }, 404);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    behavior,
    async close() {
      await server.stop(true);
    },
  };
}

/** 读取最后一次指定路径的请求；测试断言用。 */
export function lastRequest(
  fake: FakeSwarm,
  path: string,
  method = 'POST',
): FakeSwarmRequest | undefined {
  for (let index = fake.requests.length - 1; index >= 0; index -= 1) {
    const request = fake.requests[index];
    if (request && request.method === method && request.path === path) return request;
  }
  return undefined;
}
