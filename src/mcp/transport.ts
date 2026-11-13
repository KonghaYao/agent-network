/**
 * 服务端 MCP 传输/挂载层的实现选择。
 *
 * `native` 直接使用官方 SDK 的 `createMcpHandler`；`mcp-use` 标准方法交给
 * `mcp-use` 的 `MCPServer`（工具/资源由 `buildUseServer` 注册）。
 *
 * `MCPServer` 没有公开的底层 `McpServer` 访问器，无法注册 `skills/*` 与
 * `events/*`。4D-3 起这些自定义方法由本层在处理请求前直接分发
 * （`src/mcp/compat/methods.ts`），不再构建第二个 native 兼容服务器；
 * `server/discover` 仍由 mcp-use 应答，只在响应上修正 capabilities。
 * 鉴权、405/`Allow`、`subscriptions/listen`、结果 `_meta` 剥离与 CORS
 * 仍在 `src/app.ts`。
 */
import './telemetry';

import {
  createMcpHandler,
  isJsonContentType,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { getRequestBag, type MCPServer } from 'mcp-use';

import { LIMITS } from '../contracts/limits';
import { asRecord } from '../events/log';
import type { McpImplementation } from '../env';
import {
  patchDiscoverResponse,
  type DiscoverCapabilities,
} from './compat/capabilities';
import type { CompatMethodTable } from './compat/shared';

/** 只暴露调用方需要的 `fetch`，避免把 SDK handler 的 close/notify 泄漏到路由层。 */
export interface McpTransport {
  fetch(request: Request): Promise<Response>;
}

interface McpTransportOptions {
  implementation?: McpImplementation;
  /** native 实现；`mcp-use` 模式只使用 `buildUseServer`。 */
  nativeFactory: McpServerFactory;
  /** mcp-use 模式下的 `MCPServer` 构建器；按请求创建以绑定 FileScope。 */
  buildUseServer?: (request: Request) => MCPServer;
  /** `skills/*`、`events/*` 的传输层处理器。 */
  compat?: CompatMethodTable;
  /** mcp-use 的 `server/discover` 能力修正参数。 */
  capabilities?: DiscoverCapabilities;
}

/**
 * 缺省保留 native：4D-1 只提供可切换的 mcp-use 路径，生产默认值在验证一个
 * 发布周期后另行切换。非法值由 `parseMcpImplementation` 在启动期拒绝。
 */
const DEFAULT_MCP_IMPL: McpImplementation = 'native';

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
 * 读取 `request.clone()`，不重建或消费原始请求：MCPP Files 的 FileScope
 * 以原请求对象为 WeakMap key，自定义方法也要拿到原始 body。
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
  const record = asRecord(parsed);
  const method = typeof record?.method === 'string' ? record.method : null;
  return { parsed, method };
}

function requestIdOf(parsed: unknown): string | number | null {
  const id = asRecord(parsed)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export function createMcpTransport(options: McpTransportOptions): McpTransport {
  const implementation = options.implementation ?? DEFAULT_MCP_IMPL;
  const { nativeFactory, buildUseServer, compat, capabilities } = options;
  if (implementation === 'native') {
    const handler: McpHttpHandler = createMcpHandler(nativeFactory, HANDLER_OPTIONS);
    return { fetch: handler.fetch };
  }
  if (!buildUseServer) {
    throw new Error('mcp-use transport requires buildUseServer');
  }
  return {
    async fetch(request: Request): Promise<Response> {
      const body = await readBody(request, LIMITS.httpBodyBytes);
      if (body instanceof Response) return body;
      // 自定义方法在进入 mcp-use 前应答，避免构建第二个服务端。
      if (compat !== undefined && body.method !== null && compat.has(body.method)) {
        return compat.handle(body.method, asRecord(body.parsed)?.params, {
          requestId: requestIdOf(body.parsed),
        });
      }
      if (body.parsed !== undefined) getRequestBag(request).parsedBody = body.parsed;
      const response = await buildUseServer(request).fetch(request);
      if (
        capabilities !== undefined &&
        body.method === 'server/discover' &&
        response.status === 200
      ) {
        return patchDiscoverResponse(response, capabilities);
      }
      return response;
    },
  };
}
