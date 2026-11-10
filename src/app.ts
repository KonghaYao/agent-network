import { createMcpHandler, type McpHttpHandler, type McpRequestContext } from '@modelcontextprotocol/server';
import { FILE_ID_PATTERN, FileError, fileScopeFor, type FileMount, type FileService } from '@peri-code/mcpp/files';
import { Hono } from 'hono';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import { LIMITS } from './contracts/limits';
import { isBusinessError, type BusinessErrorBody } from './contracts/errors';
import { attachPublicUrl, publicFileHeaders } from './drive/service';
import { authorizeTicketUpload, UPLOAD_TICKET_HEADER } from './drive/upload-ticket';
import { fileTicketSecret } from './domain/file-ticket';
import { authorizeFileDownload } from './domain/file-access';
import {
  asRecord,
  callbackHostOf,
  createEventsLogger,
  type EventsLogFields,
  type EventsLogger,
} from './events/log';
import { runEventsTick, scheduleEventsTick } from './events/runtime';
import { authenticate } from './mcp/auth';
import { buildServer } from './mcp/server';
import { serveActorStream } from './mcp/stream';
import { maintain } from './maintenance';
import { scheduleOutboxDrain } from './realtime/outbox';
import { STREAM_URI } from './realtime/stream';
import { getActorBySession } from './storage/queries';
import { renderChatPage } from './web/chat';
import { renderInvalidJoinPage, renderJoinPage } from './web/join';
import { renderPairPage } from './web/pair';
import { renderHomePage, renderInvalidSharePage, renderSharePage } from './web/share';
import type { Env } from './env';

interface RpcBody {
  id?: string | number | null;
  method?: string;
  params?: {
    uri?: string;
    notifications?: { resourceSubscriptions?: string[] };
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
  };
  _meta?: Record<string, unknown>;
}

const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const MODERN_VERSION = '2026-07-28';
const FILE_ID = new RegExp(FILE_ID_PATTERN);
const INVITE_KEY = /^[A-Za-z0-9_-]{16,64}$/u;
const SKILLS_ROOT = resolve(import.meta.dir, '../public/skills');
const AGENT_ICONS_ROOT = resolve(import.meta.dir, '../public/agent-icons');

const MCP_CORS_METHODS = 'POST, GET, DELETE';
const UPLOAD_CORS_METHODS = 'POST';
const CORS_ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'mcpp-files-version',
  'mcpp-file-name',
  'mcpp-file-size',
  'mcpp-file-sha256',
  UPLOAD_TICKET_HEADER.toLowerCase(),
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
].join(', ');

/**
 * Origin 不再是认证边界。
 *
 * MCPP Files 的 `allowedOrigins` 只做精确匹配且没有 allow-all 配置；
 * 进入 mount 前移除 Origin，避免它把任意 Origin 判成 `UPLOAD_FORBIDDEN`。
 * 真正的授权仍由 Bearer 或 URL `?token=` 完成。
 */
function detachOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (origin) request.headers.delete('origin');
  return origin;
}

/**
 * MCPP 的上传元数据解析拒绝任何 query string（`parseUploadMetadata`），
 * 因此把 URL token 转成等价的 Bearer 后，再以无 query 的 URL 交给 mount。
 * 鉴权仍由同一个 `authenticate` 完成，token 不落库。
 */
function prepareUploadRequest(request: Request): {
  request: Request;
  origin: string | null;
} {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  url.search = '';
  const headers = new Headers(request.headers);
  if (origin) headers.delete('origin');
  const header = headers.get('authorization');
  if (queryToken && !(header && /^Bearer\s+\S+$/u.test(header))) {
    headers.set('authorization', `Bearer ${queryToken}`);
  }
  return {
    request: new Request(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
    }),
    origin,
  };
}

function appendVary(headers: Headers, value: string): void {
  const current = headers.get('vary');
  if (!current) {
    headers.set('vary', value);
    return;
  }
  const exists = current
    .split(',')
    .some((item) => item.trim().toLowerCase() === value.toLowerCase());
  if (!exists) headers.set('vary', `${current}, ${value}`);
}

/** 为带 Origin 的响应补 CORS；CORS 只控制浏览器可读性，不参与授权。 */
function withCors(origin: string | null, response: Response): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  appendVary(headers, 'Origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * MCPP Files 的 mount 会给 /mcp 统一写 `cache-control: no-store`。
 * SSE 需要明确的 `no-cache, no-transform`（尤其避免代理缓冲/转换），
 * 因此在 mount 之后按 content-type 归一化；不改变 body 或其他响应。
 */
function withStreamHeaders(response: Response): Response {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-cache, no-transform');
  headers.set('x-accel-buffering', 'no');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 预检直接返回 204；允许的方法与请求头不构成授权。 */
function corsPreflight(request: Request, methods: string): Response | null {
  if (request.method !== 'OPTIONS') return null;
  const headers = new Headers({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': methods,
    'access-control-allow-headers':
      request.headers.get('access-control-request-headers') ?? CORS_ALLOW_HEADERS,
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  });
  return new Response(null, { status: 204, headers });
}

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

/**
 * 与主 MCP handler 的 SEP-2243 版本交叉校验保持一致。
 *
 * 自定义 `subscriptions/listen` SSE 路由绕过 SDK，因此必须自己拒绝
 * header/body 版本不一致或缺少 modern header 的请求。
 */
function protocolMismatch(
  id: string | number | null | undefined,
  header: string | null,
  bodyVersion: string,
): Response {
  const description =
    header === null
      ? `the body envelope names protocol version ${bodyVersion} but the required MCP-Protocol-Version header is absent`
      : `the body envelope names protocol version ${bodyVersion} but the MCP-Protocol-Version header names ${header}`;
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32020,
        message: `Bad Request: the request headers and body disagree: ${description}`,
        data: { mismatch: { header: header ?? '(missing)', body: description } },
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function handlerFor(
  env: Env,
  principal: Awaited<ReturnType<typeof authenticate>>,
  mount?: FileMount,
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
  });
}

/**
 * events/* 入站摘要：只记录字段名、host 与类型，不记录 secret、完整 URL 或
 * arguments 值。这样即使参数校验在 SDK/domain 内失败，也能证明请求是否到达。
 */
function eventsInboundFields(body: RpcBody): EventsLogFields {
  const params = asRecord(body.params) ?? {};
  const delivery = asRecord(params.delivery);
  const argumentKeys = asRecord(params.arguments);
  const secret = delivery?.secret;
  return {
    stage: 'inbound',
    params_keys: Object.keys(params).sort(),
    argument_keys: argumentKeys ? Object.keys(argumentKeys).sort() : null,
    delivery_mode: typeof delivery?.mode === 'string' ? delivery.mode : null,
    callback_host:
      delivery === null ? null : callbackHostOf(delivery.url),
    secret_present: typeof secret === 'string',
    secret_prefix_ok:
      typeof secret === 'string' ? secret.startsWith('whsec_') : null,
    cursor_kind:
      params.cursor === null || params.cursor === undefined ? 'null' : typeof params.cursor,
    ttl_kind:
      params.ttlMs === null
        ? 'null'
        : params.ttlMs === undefined
          ? 'absent'
          : typeof params.ttlMs,
  };
}

/** 响应阶段日志：JSON-RPC error code 与 result 键名，不回显 message/正文。 */
function logEventsResponse(
  log: EventsLogger,
  response: Response,
  startedAt: number,
): void {
  const status = response.status;
  const duration = () => Math.max(0, Date.now() - startedAt);
  void response
    .clone()
    .json()
    .then((payload: unknown) => {
      const message = asRecord(payload);
      const error = asRecord(message?.error);
      const data = asRecord(error?.data);
      const result = asRecord(message?.result);
      log.info('response', {
        stage: 'response',
        status,
        duration_ms: duration(),
        error_code: typeof error?.code === 'number' ? error.code : null,
        error_reason: typeof data?.reason === 'string' ? data.reason : null,
        error_detail: typeof data?.detail === 'string' ? data.detail : null,
        result_keys: result ? Object.keys(result).sort() : null,
        result_cursor_kind: result
          ? result.cursor === null
            ? 'null'
            : result.cursor === undefined
              ? 'absent'
              : typeof result.cursor
          : null,
        result_truncated:
          typeof result?.truncated === 'boolean' ? result.truncated : null,
      });
    })
    .catch(() => {
      log.info('response', {
        stage: 'response',
        status,
        duration_ms: duration(),
        error_code: null,
        result_keys: null,
      });
    });
}

async function handleMcp(request: Request, env: Env, mount?: FileMount): Promise<Response> {
  const startedAt = Date.now();
  const body =
    request.method === 'POST'
      ? ((await request.clone().json().catch(() => null)) as RpcBody | null)
      : null;
  const method =
    body !== null && !Array.isArray(body) && typeof body.method === 'string'
      ? body.method
      : null;
  const eventsLog =
    method !== null && method.startsWith('events/')
      ? createEventsLogger(method, body?.id ?? null)
      : null;
  if (eventsLog && body !== null) {
    eventsLog.info('inbound', eventsInboundFields(body));
  }

  let principal: Awaited<ReturnType<typeof authenticate>>;
  try {
    principal = await authenticate(env.DB, request);
  } catch (error) {
    if (isBusinessError(error)) {
      eventsLog?.warn('auth', {
        stage: 'auth',
        result: 'invalid',
        error_code: error.code,
      });
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

  // 可用性 presence：任意已认证 Agent 的 MCP 请求都算活动（轮询、claim、
  // 回复、history、sync、resources/read、订阅建立等）。先于业务处理写入，
  // 保证离线后的第一个动作先产生上线记录；失败只记录，不影响响应。
  if (principal.actor?.kind === 'agent') {
    try {
      await env.PRESENCE?.touch(principal.actor.actor_id);
    } catch (error) {
      console.error(
        'agent-network presence touch failed',
        error instanceof Error ? error.name : 'UnknownError',
      );
    }
  }

  const meta = body?._meta ?? body?.params?._meta;
  const requestedSubscriptions = body?.params?.notifications?.resourceSubscriptions;

  // cutover 后只保留 agentnet://stream；旧资源读取在进入 SDK 前显式拒绝，
  // 不返回“资源不存在”让客户端误以为可以回退。
  if (body !== null && !Array.isArray(body) && body.method === 'resources/read') {
    const uri = body.params?.uri;
    if (typeof uri === 'string' && uri.startsWith('agentnet://') && uri !== STREAM_URI) {
      return jsonRpcError(body.id, -32602, '旧资源 URI 已删除；只支持 agentnet://stream', {
        code: 'INVALID_ARGUMENT',
        message: `不支持的资源 URI：${uri}`,
        retryable: false,
        details: { uri, supported: [STREAM_URI] },
      });
    }
  }

  const isListen =
    body !== null &&
    !Array.isArray(body) &&
    body.method === 'subscriptions/listen';

  // 自定义 stream SSE 绕过 SDK；在 ack 前补齐版本交叉校验、空订阅拒绝、
  // 身份检查与唯一 URI 校验。旧 URI 与多 URI 一律 INVALID_ARGUMENT。
  if (body && isListen) {
    const headerVersion = request.headers.get('mcp-protocol-version');
    const bodyVersion =
      typeof meta?.[PROTOCOL_VERSION_META] === 'string'
        ? (meta[PROTOCOL_VERSION_META] as string)
        : undefined;
    if (bodyVersion !== undefined) {
      if (headerVersion === null) return protocolMismatch(body.id, null, bodyVersion);
      if (headerVersion !== bodyVersion) {
        return protocolMismatch(body.id, headerVersion, bodyVersion);
      }
    }
    if (bodyVersion !== MODERN_VERSION) {
      return jsonRpcError(body.id, -32602, '统一 stream 订阅需要 MCP 2026-07-28 协议元数据', {
        code: 'INVALID_ARGUMENT',
        message: 'subscriptions/listen 缺少 modern protocol _meta',
        retryable: false,
      });
    }
    if (!Array.isArray(requestedSubscriptions) || requestedSubscriptions.length === 0) {
      return jsonRpcError(
        body.id,
        -32602,
        'subscriptions/listen 需要非空 resourceSubscriptions',
        {
          code: 'INVALID_ARGUMENT',
          message: 'resourceSubscriptions 必须是非空数组',
          retryable: false,
          details: { resourceSubscriptions: requestedSubscriptions ?? null },
        },
      );
    }
    if (!principal.actor) {
      return jsonRpcError(body.id, -32602, '建立订阅需要已注册身份', {
        code: 'CREDENTIAL_INVALID',
        message: '当前凭据尚未注册；先调用 network_register',
        retryable: false,
      });
    }
    if (
      requestedSubscriptions.length !== LIMITS.subscriptionUrisMax ||
      requestedSubscriptions[0] !== STREAM_URI
    ) {
      return jsonRpcError(body.id, -32602, '统一 stream 只接受一个 resource URI', {
        code: 'INVALID_ARGUMENT',
        message: `resourceSubscriptions 必须且只能是 ["${STREAM_URI}"]`,
        retryable: false,
        details: { resourceSubscriptions: requestedSubscriptions },
      });
    }
    try {
      return serveActorStream(request, env, principal.actor, { id: body.id }, principal.credential?.credential_id ?? null);
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
    void scheduleOutboxDrain(env).catch((error) => {
      console.error('agent-network fast-path outbox drain failed', error);
    });
    scheduleEventsTick(env);
  } else if (body?.method === 'events/subscribe' || body?.method === 'events/unsubscribe') {
    scheduleEventsTick(env);
  }
  if (eventsLog) logEventsResponse(eventsLog, finalResponse, startedAt);
  return finalResponse;
}

export interface AppDeps {
  mount?: FileMount;
  /** 启动时构建的 AI 消息 Markdown bundle；null 表示构建失败、页面回退纯文本。 */
  markdownAsset?: string | null;
  /** bundle 内容哈希；页面用它生成带版本 URL，避免 CDN 继续命中旧缓存。 */
  markdownAssetVersion?: string | null;
  /** 启动时构建的右侧面板拖拽 bundle；null 表示构建失败、保留默认 50/50。 */
  resizerAsset?: string | null;
  /** 拖拽 bundle 内容哈希；与 Markdown 共用同样的版本化 URL 策略。 */
  resizerAssetVersion?: string | null;
  /** 按需加载的 Fabric 画板 bundle；null 表示构建失败、打开时显示可读错误。 */
  drawboardAsset?: string | null;
  /** 画板 bundle 内容哈希；只在首次打开画板时请求带版本 URL。 */
  drawboardAssetVersion?: string | null;
  /** 启动时构建的图标悬停动效 bundle；null 表示构建失败、只保留静态 SVG。 */
  iconAsset?: string | null;
  /** 图标动效 bundle 内容哈希；与其他浏览器岛共用同样的版本化 URL 策略。 */
  iconAssetVersion?: string | null;
}

interface ByteRange {
  start: number;
  end: number;
}

/**
 * 解析单段 `Range`。
 *
 * - 返回 `null` 表示忽略（多段、语法不符或空文件），按完整 200 响应处理；
 * - 返回 `'unsatisfiable'` 表示 416；
 * - 只支持 bytes 单位，避免引入 multipart/byteranges。
 */
export function parseByteRange(header: string, size: number): ByteRange | 'unsatisfiable' | null {
  if (size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable';
  return { start, end };
}

/** 跳过 start 字节后只输出 length 字节；提前关闭底层流，避免读完整个文件。 */
export function sliceReadable(
  source: Readable,
  start: number,
  length: number,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
  let skip = start;
  let remaining = length;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        while (remaining > 0) {
          const next = await iterator.next();
          if (next.done) {
            finished = true;
            controller.close();
            return;
          }
          const chunk = next.value;
          if (skip >= chunk.length) {
            skip -= chunk.length;
            continue;
          }
          const body = skip > 0 ? chunk.subarray(skip) : chunk;
          skip = 0;
          const take = body.subarray(0, remaining);
          remaining -= take.length;
          controller.enqueue(new Uint8Array(take));
          if (remaining === 0) {
            finished = true;
            void iterator.return?.();
            controller.close();
          }
          return;
        }
        finished = true;
        controller.close();
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
    async cancel() {
      finished = true;
      await iterator.return?.();
      source.destroy();
    },
  });
}

/** `If-None-Match` 只接受精确匹配或 `*`；弱比较前缀按 RFC 9110 处理。 */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//u, ''))
    .some((value) => value === '*' || value === etag);
}

async function openPayload(fileService: FileService, payloadKey: string): Promise<Readable> {
  return fileService.disk.getStream(payloadKey);
}

export function createApp(env: Env, deps: AppDeps = {}): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      env: env.ENVIRONMENT,
      drive: env.FILES ? 'enabled' : 'disabled',
      stream: env.NOTIFICATION_HUB.streamStats(),
    }),
  );

  // AI 消息 Markdown 岛：启动构建、内存缓存；构建失败或未注入时 404，
  // 页面保留纯文本回退，不影响发送、文件卡片与其他交互。
  app.get('/assets/chat-markdown.js', (c) => {
    if (!deps.markdownAsset) {
      return c.text('Not Found', 404, { 'cache-control': 'no-store' });
    }
    return c.body(deps.markdownAsset, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      ...(deps.markdownAssetVersion ? { etag: `"${deps.markdownAssetVersion}"` } : {}),
    });
  });

  // 右侧面板拖拽岛：与 Markdown 岛相同的独立 bundle 与缓存策略。
  // 构建失败时 404，页面保留 CSS 默认 50/50，分隔条不响应拖动。
  app.get('/assets/chat-resizer.js', (c) => {
    if (!deps.resizerAsset) {
      return c.text('Not Found', 404, { 'cache-control': 'no-store' });
    }
    return c.body(deps.resizerAsset, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      ...(deps.resizerAssetVersion ? { etag: `"${deps.resizerAssetVersion}"` } : {}),
    });
  });

  // Fabric 画板岛：只在打开画板时动态导入；构建失败时 404，页面显示可读错误。
  app.get('/assets/chat-drawboard.js', (c) => {
    if (!deps.drawboardAsset) {
      return c.text('Not Found', 404, { 'cache-control': 'no-store' });
    }
    return c.body(deps.drawboardAsset, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      ...(deps.drawboardAssetVersion ? { etag: `"${deps.drawboardAssetVersion}"` } : {}),
    });
  });

  // 图标悬停动效：页面先拿到服务端静态 SVG，这个 bundle 只做渐进增强。
  // 构建失败时 404，图标保持静态，页面其他脚本不受影响。
  app.get('/assets/chat-icons.js', (c) => {
    if (!deps.iconAsset) {
      return c.text('Not Found', 404, { 'cache-control': 'no-store' });
    }
    return c.body(deps.iconAsset, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      ...(deps.iconAssetVersion ? { etag: `"${deps.iconAssetVersion}"` } : {}),
    });
  });

  // 公开只读技能文档与脚本：只允许 public/skills 下的一层 .md / .sh，拒绝路径穿越。
  // 文件本身不含凭据；调用方自行通过 AGENTNET_TOKEN 提供 Bearer。
  app.get('/skills/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^[a-z0-9][a-z0-9._-]*\.(?:md|sh)$/u.test(file)) return c.notFound();
    const path = resolve(SKILLS_ROOT, file);
    if (!path.startsWith(`${SKILLS_ROOT}${sep}`)) return c.notFound();
    const body = await Bun.file(path).text().catch(() => null);
    if (body === null) return c.notFound();
    const contentType = file.endsWith('.sh')
      ? 'text/x-shellscript; charset=utf-8'
      : 'text/markdown; charset=utf-8';
    return c.body(body, 200, {
      'content-type': contentType,
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    });
  });

  // 本地品牌头像与授权说明：只允许 agent-icons 目录下的白名单文件，拒绝路径穿越。
  app.get('/agent-icons/:file', async (c) => {
    const file = c.req.param('file');
    if (!/^(?:[a-z0-9][a-z0-9-]*\.(?:svg|png)|LICENSE|ATTRIBUTION\.md)$/u.test(file)) {
      return c.notFound();
    }
    const path = resolve(AGENT_ICONS_ROOT, file);
    if (!path.startsWith(`${AGENT_ICONS_ROOT}${sep}`)) return c.notFound();
    const isPng = file.endsWith('.png');
    const body = await (isPng
      ? Bun.file(path).bytes()
      : Bun.file(path).text()
    ).catch(() => null);
    if (body === null) return c.notFound();
    return c.body(body, 200, {
      'content-type': isPng
        ? 'image/png'
        : file.endsWith('.svg')
          ? 'image/svg+xml; charset=utf-8'
          : 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
  });

  app.get('/', (c) =>
    c.html(
      renderHomePage(
        deps.markdownAssetVersion ?? null,
        deps.resizerAssetVersion ?? null,
        deps.drawboardAssetVersion ?? null,
        deps.iconAssetVersion ?? null,
      ),
      200,
      { 'cache-control': 'no-store' },
    ),
  );
  app.get('/a/:sessionId', async (c) => {
    const actor = await getActorBySession(env.DB, c.req.param('sessionId'));
    if (!actor) {
      return c.html(renderInvalidSharePage(), 404, { 'cache-control': 'no-store' });
    }
    return c.html(renderSharePage(actor), 200, { 'cache-control': 'no-store' });
  });
  app.get('/c/:roomId', (c) =>
    c.html(
      renderChatPage(
        c.req.param('roomId'),
        deps.markdownAssetVersion ?? null,
        deps.resizerAssetVersion ?? null,
        deps.drawboardAssetVersion ?? null,
        deps.iconAssetVersion ?? null,
      ),
      200,
      {
        'cache-control': 'no-store',
      },
    ),
  );

  // 新设备配对页：challenge 只在 URL fragment 中，由客户端读取并立即清除；
  // 服务端不解析 challenge，也不输出任何身份或房间数据。
  app.get('/pair', (c) =>
    c.html(renderPairPage(), 200, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    }),
  );

  // 群邀请落地页。邀请码只是加入能力，不是身份凭据：这里不解析任何群数据，
  // 由页面用浏览器 token 调工具预览与确认，权限判定全部留在工具层。
  app.get('/j/:inviteKey', (c) => {
    const inviteKey = c.req.param('inviteKey');
    if (!INVITE_KEY.test(inviteKey)) {
      return c.html(renderInvalidJoinPage(), 404, { 'cache-control': 'no-store' });
    }
    return c.html(renderJoinPage(inviteKey), 200, { 'cache-control': 'no-store' });
  });

  // 私有下载：新上传默认私有草稿；绑定房间后必须携带房间票据并在每次使用时
  // 复核成员资格、代次、策略版本与历史边界；公开链接只在显式发布后生效。
  app.get('/f/:fileId', async (c) => {
    const fileId = c.req.param('fileId');
    if (!FILE_ID.test(fileId) || !env.FILES) return c.text('Not Found', 404);
    try {
      const now = Date.now();
      const record = await env.FILES.readRecord(fileId);
      if (!record || Date.parse(record.expiresAt) <= now) return c.text('Not Found', 404);
      const access = await authorizeFileDownload(
        env.DB,
        fileId,
        record.ownerScope,
        c.req.query('t') ?? null,
        fileTicketSecret(env.FILE_TICKET_SECRET),
        now,
      );
      if (access === null) return c.text('Not Found', 404);

      const headers = new Headers(
        publicFileHeaders(record, {
          forceAttachment: c.req.query('download') === '1',
          acceptRanges: true,
        }),
      );
      const etag = headers.get('etag');
      if (etag && matchesEtag(c.req.header('if-none-match'), etag)) {
        headers.delete('content-length');
        return new Response(null, { status: 304, headers });
      }
      // Hono 把 HEAD 作为 GET 派发；这里显式跳过载荷流，避免无用的磁盘读取。
      if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });

      const rangeHeader = c.req.header('range');
      if (rangeHeader) {
        const range = parseByteRange(rangeHeader, record.size);
        if (range === 'unsatisfiable') {
          headers.set('content-range', `bytes */${record.size}`);
          headers.delete('content-length');
          return new Response(null, { status: 416, headers });
        }
        if (range) {
          const stream = await openPayload(env.FILES, record.payloadKey);
          headers.set('content-range', `bytes ${range.start}-${range.end}/${record.size}`);
          headers.set('content-length', String(range.end - range.start + 1));
          return new Response(
            sliceReadable(stream, range.start, range.end - range.start + 1),
            { status: 206, headers },
          );
        }
      }

      const stream = await openPayload(env.FILES, record.payloadKey);
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers,
      });
    } catch (error) {
      console.error('agent-network public file failed', error);
      if (error instanceof FileError && error.code === 'FILE_STORAGE_UNAVAILABLE') {
        return c.text('Service Unavailable', 503);
      }
      return c.text('Not Found', 404);
    }
  });

  app.all('/mcp', async (c) => {
    const request = c.req.raw;
    const preflight = corsPreflight(request, MCP_CORS_METHODS);
    if (preflight) return preflight;
    const origin = detachOrigin(request);
    const run = (input: Request) => handleMcp(input, env, deps.mount);
    try {
      const response = deps.mount
        ? await deps.mount.fetchMcp(request, run)
        : await run(request);
      return withCors(origin, withStreamHeaders(response));
    } catch (error) {
      console.error('agent-network MCP request failed', error);
      throw error;
    }
  });

  app.all('/mcp-upload', async (c) => {
    if (!deps.mount) return c.notFound();
    const request = c.req.raw;
    const preflight = corsPreflight(request, UPLOAD_CORS_METHODS);
    if (preflight) return preflight;
    const prepared = prepareUploadRequest(request);
    try {
      // An explicitly supplied ticket never falls back to a different Bearer identity.
      const hasTicket = prepared.request.headers.has(UPLOAD_TICKET_HEADER);
      const uploaderId = hasTicket
        ? await authorizeTicketUpload(env.DB, fileTicketSecret(env.FILE_TICKET_SECRET), prepared.request)
        : (await authenticate(env.DB, prepared.request).catch(() => null))?.actor?.actor_id ?? null;
      const response = hasTicket
        ? await env.FILES!.handleUpload(prepared.request, { scope: { key: `actor:${uploaderId}` } })
        : await deps.mount.fetchUpload(prepared.request);
      return withCors(
        prepared.origin,
        await attachPublicUrl(response, {
          publicOrigin: env.PUBLIC_ORIGIN,
          db: env.DB,
          fileService: env.FILES!,
          ticketSecret: fileTicketSecret(env.FILE_TICKET_SECRET),
          uploaderId,
        }),
      );
    } catch (error) {
      if (error instanceof FileError) {
        return withCors(prepared.origin, Response.json({
          error: { code: error.code, message: error.message, retryable: error.retryable },
        }, { status: error.status, headers: { 'cache-control': 'no-store' } }));
      }
      console.error('agent-network upload failed', error);
      throw error;
    }
  });

  return app;
}

/** 定时任务：outbox 投递、MCP Events tick 与历史清理；由 Bun 入口的 setInterval 调用。 */
export async function runScheduled(env: Env): Promise<void> {
  try {
    const result = await scheduleOutboxDrain(env);
    if (result.oldestPendingAgeMs !== null && result.oldestPendingAgeMs > 5 * 60_000) {
      console.warn('agent-network outbox backlog', result);
    }
  } catch (error) {
    console.error('agent-network outbox drain failed', error);
  }
  try {
    await runEventsTick(env);
  } catch (error) {
    console.error('agent-network events tick failed', error);
  }
  try {
    await maintain(env);
  } catch (error) {
    console.error('agent-network maintenance failed', error);
  }
}
