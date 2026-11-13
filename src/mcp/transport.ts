/**
 * 服务端 MCP 传输/挂载层的实现选择。
 *
 * `native` 直接使用官方 SDK 的 `createMcpHandler`；`mcp-use` 标准方法交给
 * `mcp-use` 的 `MCPServer`（工具/资源由 `buildUseServer` 注册）。
 *
 * `MCPServer` 没有公开的底层 `McpServer` 访问器，`skills/*`、`events/*` 与
 * `server/discover` 由 native 兼容服务器处理：自定义方法走 `customFactory`，
 * discover 也走兼容服务器以保留原有 capabilities、instructions 与
 * `io.mcpp/files` 扩展。鉴权、405/`Allow`、`subscriptions/listen`、结果
 * `_meta` 剥离与 CORS 仍留在 `src/app.ts`。
 */
import {
  createMcpHandler,
  isJsonContentType,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { getRequestBag, type MCPServer } from 'mcp-use';

import { LIMITS } from '../contracts/limits';
import type { McpImplementation } from '../env';

/** 只暴露调用方需要的 `fetch`，避免把 SDK handler 的 close/notify 泄漏到路由层。 */
export interface McpTransport {
  fetch(request: Request): Promise<Response>;
}

export interface McpTransportOptions {
  implementation?: McpImplementation;
  /** native 主实现；mcp-use 模式下用于非 POST 的协议错误响应。 */
  nativeFactory: McpServerFactory;
  /** mcp-use 模式下 `skills/*`、`events/*` 与 `server/discover` 的兼容工厂。 */
  customFactory?: McpServerFactory;
  /** mcp-use 模式下的 `MCPServer` 构建器；按请求创建以绑定 FileScope。 */
  buildUseServer?: (request: Request) => MCPServer;
}

/**
 * 缺省保留 native：4D-1 只提供可切换的 mcp-use 路径，生产默认值在验证一个
 * 发布周期后另行切换。非法值由 `parseMcpImplementation` 在启动期拒绝。
 */
export const DEFAULT_MCP_IMPL: McpImplementation = 'native';

export function parseMcpImplementation(value: string | undefined): McpImplementation {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === DEFAULT_MCP_IMPL) return DEFAULT_MCP_IMPL;
  if (normalized === 'mcp-use') return 'mcp-use';
  throw new Error('MCP_IMPL must be native or mcp-use');
}

/**
 * modern-only 配置对两条路径完全一致：
 * - `legacy: 'reject'` 拒绝 initialize/旧版本，不回退到 2025 会话模型；
 * - 请求体上限与 SSE keepalive 继续取自 `LIMITS`。
 */
const HANDLER_OPTIONS: CreateMcpHandlerOptions = {
  legacy: 'reject',
  maxRequestBodySize: LIMITS.httpBodyBytes,
  keepAliveMs: LIMITS.keepaliveMs,
};

/**
 * 无法在 mcp-use `MCPServer` 上注册的方法。
 *
 * `server/discover` 不是自定义方法，但由兼容服务器回答才能保持原有
 * capabilities、instructions 与文件扩展；其余为 SEP-2640 Skills 与
 * MCP Events 自定义方法。
 */
const COMPAT_METHODS: ReadonlySet<string> = new Set([
  'server/discover',
  'skills/list',
  'skills/get',
  'events/list',
  'events/subscribe',
  'events/unsubscribe',
]);

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });
}

interface ParsedBody {
  parsed: unknown;
  method: string | null;
}

/**
 * 在进入 mcp-use 前按官方入口相同的方式计数并返回 413；同时把解析结果
 * 写回 mcp-use 的 request bag，避免它再次 clone/解析已消费的请求体。
 *
 * 读取 `request.clone()`，不重建或消费原请求：MCPP Files 的 FileScope
 * 以原请求对象为 WeakMap key，兼容服务器也要拿到原始 body。
 */
async function readBody(
  request: Request,
  limit: number,
): Promise<ParsedBody | Response> {
  if (request.method !== 'POST') return { parsed: undefined, method: null };
  // 非 JSON Content-Type 由 SDK 返回 415；此时不读取/消耗 body，保持官方优先级。
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return { parsed: undefined, method: null };
  }
  if (Number(request.headers.get('content-length')) > limit) {
    return jsonRpcError(
      413,
      -32_000,
      `Payload Too Large: Request body must not exceed ${limit} bytes`,
    );
  }
  const source = request.clone();
  if (source.body === null) {
    return jsonRpcError(400, -32_700, 'Parse error: the request body is not valid JSON');
  }
  const reader = source.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        return jsonRpcError(
          413,
          -32_000,
          `Payload Too Large: Request body must not exceed ${limit} bytes`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return jsonRpcError(400, -32_700, 'Parse error: the request body could not be read');
  } finally {
    reader.releaseLock();
  }
  text += decoder.decode();
  if (text.length === 0) {
    return jsonRpcError(400, -32_700, 'Parse error: the request body is not valid JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return jsonRpcError(400, -32_700, 'Parse error: the request body is not valid JSON');
  }
  const method =
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    typeof (parsed as { method?: unknown }).method === 'string'
      ? ((parsed as { method: string }).method)
      : null;
  return { parsed, method };
}

export function createMcpTransport(options: McpTransportOptions): McpTransport {
  const implementation = options.implementation ?? DEFAULT_MCP_IMPL;
  const { nativeFactory, customFactory, buildUseServer } = options;
  if (implementation === 'native') {
    const handler: McpHttpHandler = createMcpHandler(nativeFactory, HANDLER_OPTIONS);
    return { fetch: handler.fetch };
  }
  if (!buildUseServer) {
    throw new Error('mcp-use transport requires buildUseServer');
  }
  // createMcpTransport 本身按请求创建，兼容 handler 复用同一个工厂即可。
  const compatHandler = createMcpHandler(customFactory ?? nativeFactory, HANDLER_OPTIONS);
  return {
    async fetch(request: Request): Promise<Response> {
      const body = await readBody(request, LIMITS.httpBodyBytes);
      if (body instanceof Response) return body;
      if (request.method !== 'POST') return compatHandler.fetch(request);
      if (body.method !== null && COMPAT_METHODS.has(body.method)) {
        return compatHandler.fetch(request);
      }
      if (body.parsed !== undefined) getRequestBag(request).parsedBody = body.parsed;
      return buildUseServer(request).fetch(request);
    },
  };
}
