import { createMcpHandler, type McpHttpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import { FILE_ID_PATTERN, fileScopeFor, type FileMount } from '@peri-code/mcpp/files';
import { Hono } from 'hono';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import { LIMITS } from './contracts/limits';
import { isBusinessError, type BusinessErrorBody } from './contracts/errors';
import { attachPublicUrl } from './drive/service';
import { authenticate } from './mcp/auth';
import { buildServer } from './mcp/server';
import { resolveSubscriptionTopics } from './mcp/subscriptions';
import { maintain } from './maintenance';
import { TopicEventBus } from './realtime/bus';
import { drainOutbox } from './realtime/outbox';
import { getActorBySession } from './storage/queries';
import { renderChatPage } from './web/chat';
import { renderHomePage, renderInvalidSharePage, renderSharePage } from './web/share';
import type { Env } from './env';

interface ListenBody {
  id?: string | number | null;
  method?: string;
  params?: {
    notifications?: { resourceSubscriptions?: string[] };
    _meta?: Record<string, unknown>;
  };
  _meta?: Record<string, unknown>;
}

const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const MODERN_VERSION = '2026-07-28';
const FILE_ID = new RegExp(FILE_ID_PATTERN);
const SKILLS_ROOT = resolve(import.meta.dir, '../public/skills');

/**
 * 需要移除结果级 `_meta` 的自定义方法。
 *
 * rmcp 3.5.1（Peri 当前客户端）用 untagged union 反序列化 `ServerResult`，
 * 其中 `CallToolResult` 的 known-field 判别包含 `_meta`：任何带结果级
 * `_meta` 的自定义结果都会被误判为 `CallToolResult`，`skills/list` 随即以
 * “非预期响应类型”失败。2026-07-28 中 `_meta.serverInfo` 是 SHOULD 而非
 * MUST，因此这里对技能方法去掉结果级 `_meta`，保留 `resultType` 与业务
 * 字段。客户端不再用 `_meta` 判别 `CallToolResult` 后可删除此兼容层。
 */
const CUSTOM_METHODS_WITHOUT_RESULT_META = new Set(['skills/list', 'skills/get']);

async function stripResultMeta(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response;
  const text = await response.text();
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(text, response);
  }
  const result = message.result;
  if (result === null || typeof result !== 'object') {
    return new Response(text, response);
  }
  delete (result as Record<string, unknown>)._meta;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(message), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: BusinessErrorBody,
  status = 200,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message, ...(data ? { data } : {}) },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function handlerFor(
  env: Env,
  principal: Awaited<ReturnType<typeof authenticate>>,
  mount?: FileMount,
  bus?: TopicEventBus,
): McpHttpHandler {
  const factory = (context: McpRequestContext) =>
    buildServer(
      env,
      principal,
      env.FILES && mount
        ? {
            fileService: env.FILES,
            scope: () => fileScopeFor(context),
          }
        : undefined,
    );
  return createMcpHandler(mount ? mount.wrapFactory(factory) : factory, {
    legacy: 'reject',
    maxRequestBodySize: LIMITS.httpBodyBytes,
    keepAliveMs: LIMITS.keepaliveMs,
    ...(bus ? { bus } : {}),
  });
}

async function handleMcp(request: Request, env: Env, mount?: FileMount): Promise<Response> {
  let principal: Awaited<ReturnType<typeof authenticate>>;
  try {
    principal = await authenticate(env.DB, request);
  } catch (error) {
    if (isBusinessError(error)) {
      return jsonRpcError(null, -32000, error.message, error.toBody(), 401);
    }
    throw error;
  }

  if (request.method !== 'POST') {
    const response = await handlerFor(env, principal, mount).fetch(request);
    if (response.status !== 405) return response;
    // RFC 9110 要求 405 响应声明允许的方法。
    const headers = new Headers(response.headers);
    headers.set('allow', 'POST');
    return new Response(response.body, { status: 405, statusText: response.statusText, headers });
  }

  const body = (await request.clone().json().catch(() => null)) as ListenBody | null;
  const meta = body?._meta ?? body?.params?._meta;
  const isListen =
    body !== null &&
    !Array.isArray(body) &&
    body.method === 'subscriptions/listen' &&
    meta?.[PROTOCOL_VERSION_META] === MODERN_VERSION;

  if (isListen) {
    if (!principal.actor) {
      return jsonRpcError(body.id, -32602, '建立订阅需要已注册身份', {
        code: 'CREDENTIAL_INVALID',
        message: '当前凭据尚未注册；先调用 network_register',
        retryable: false,
      });
    }
    let bus: TopicEventBus;
    try {
      const topics = await resolveSubscriptionTopics(
        env.DB,
        principal.actor.actor_id,
        body.params?.notifications?.resourceSubscriptions ?? [],
      );
      let handler: McpHttpHandler | undefined;
      bus = new TopicEventBus(env, topics, () => {
        void handler?.close();
      });
      await bus.ready();
      handler = handlerFor(env, principal, mount, bus);
      // 客户端断开 SSE 时请求信号中止；借此关闭内部 hub 订阅，让 Agent 离线。
      request.signal.addEventListener('abort', () => bus.close());
      return await handler.fetch(request);
    } catch (error) {
      if (isBusinessError(error)) {
        return jsonRpcError(body.id, -32602, error.message, error.toBody());
      }
      throw error;
    }
  }

  const handler = handlerFor(env, principal, mount);
  const response = await handler.fetch(request);
  const finalResponse =
    body !== null &&
    !Array.isArray(body) &&
    typeof body.method === 'string' &&
    CUSTOM_METHODS_WITHOUT_RESULT_META.has(body.method)
      ? await stripResultMeta(response)
      : response;
  if (body?.method === 'tools/call') {
    void drainOutbox(env).catch((error) => {
      console.error('agent-network fast-path outbox drain failed', error);
    });
  }
  return finalResponse;
}

interface DriveRecordView {
  mimeType: string;
  size: number;
  expiresAt: string;
  name: string;
  sha256: string;
}

function driveHeaders(record: DriveRecordView): Record<string, string> {
  const expiresIn = Math.max(0, Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1000));
  return {
    'content-type': record.mimeType,
    'content-length': String(record.size),
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    'cache-control': `public, max-age=${expiresIn}`,
    etag: `"${record.sha256}"`,
    'x-content-type-options': 'nosniff',
  };
}

export interface AppDeps {
  mount?: FileMount;
}

export function createApp(env: Env, deps: AppDeps = {}): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({ ok: true, env: env.ENVIRONMENT, drive: env.FILES ? 'enabled' : 'disabled' }),
  );

  // 公开只读技能文档：只允许 public/skills 下的一层 .md，拒绝路径穿越。
  // 文档本身不含凭据；调用方自行通过 AGENTNET_TOKEN 提供 Bearer。
  app.get('/skills/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9][a-z0-9._-]*\.md$/u.test(file)) return c.notFound();
    const path = resolve(SKILLS_ROOT, file);
    if (!path.startsWith(`${SKILLS_ROOT}${sep}`)) return c.notFound();
    const body = await Bun.file(path).text().catch(() => null);
    if (body === null) return c.notFound();
    return c.body(body, 200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    });
  });

  app.get('/', (c) => c.html(renderHomePage(), 200, { 'cache-control': 'no-store' }));
  app.get('/a/:sessionId', async (c) => {
    const actor = await getActorBySession(env.DB, c.req.param('sessionId'));
    if (!actor) {
      return c.html(renderInvalidSharePage(), 404, { 'cache-control': 'no-store' });
    }
    return c.html(renderSharePage(actor), 200, { 'cache-control': 'no-store' });
  });
  app.get('/c/:roomId', (c) =>
    c.html(renderChatPage(c.req.param('roomId')), 200, { 'cache-control': 'no-store' }),
  );

  // 公开下载：文件 ID 是唯一地址，不做目录遍历；过期后直接 404。
  app.get('/f/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    if (!FILE_ID.test(fileId) || !env.FILES) return c.text('Not Found', 404);
    const record = await env.FILES.readRecord(fileId);
    if (!record || Date.parse(record.expiresAt) <= Date.now()) return c.text('Not Found', 404);
    const stream = await env.FILES.disk.getStream(record.payloadKey);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: driveHeaders(record),
    });
  });

  app.all('/mcp', async (c) => {
    const request = c.req.raw;
    const run = (input: Request) => handleMcp(input, env, deps.mount);
    try {
      return deps.mount ? await deps.mount.fetchMcp(request, run) : await run(request);
    } catch (error) {
      console.error('agent-network MCP request failed', error);
      throw error;
    }
  });

  app.all('/mcp-upload', async (c) => {
    if (!deps.mount) return c.notFound();
    try {
      const response = await deps.mount.fetchUpload(c.req.raw);
      return await attachPublicUrl(response, env.PUBLIC_ORIGIN);
    } catch (error) {
      console.error('agent-network upload failed', error);
      throw error;
    }
  });

  return app;
}

/** 定时任务：outbox 投递与历史清理；由 Bun 入口的 setInterval 调用。 */
export async function runScheduled(env: Env): Promise<void> {
  try {
    const result = await drainOutbox(env);
    if (result.oldestPendingAgeMs !== null && result.oldestPendingAgeMs > 5 * 60_000) {
      console.warn('agent-network outbox backlog', result);
    }
  } catch (error) {
    console.error('agent-network outbox drain failed', error);
  }
  try {
    await maintain(env);
  } catch (error) {
    console.error('agent-network maintenance failed', error);
  }
}
