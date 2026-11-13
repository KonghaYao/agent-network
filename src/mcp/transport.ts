/**
 * 服务端 MCP 传输/挂载层的实现选择。
 *
 * `native` 直接使用官方 SDK 的 `createMcpHandler`；`mcp-use` 交给
 * `mcp-use` 的 `createMcpMount`。两者最终都调用同一个 `McpServerFactory`，
 * 因此工具/资源注册、工具清单与 schema 不随实现改变。
 *
 * 兼容层保留在 `src/app.ts`：鉴权、405/`Allow`、`subscriptions/listen`、
 * `events/*`、`skills/*`、结果 `_meta` 剥离与 CORS 都不进入 transport。
 */
import {
  createMcpHandler,
  isJsonContentType,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { createMcpMount, getRequestBag } from 'mcp-use';

import { LIMITS } from '../contracts/limits';
import type { McpImplementation } from '../env';

/** 只暴露调用方需要的 `fetch`，避免把 SDK handler 的 close/notify 泄漏到路由层。 */
export interface McpTransport {
  fetch(request: Request): Promise<Response>;
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
 * `mcp-use` 的 Node/Bun 入口内联了一份官方 SDK，`instanceof McpServer`
 * 无法跨包成立；它真正需要的是 `McpServer.server` 这个低层 `Server`。
 * 传低层实例对 `mcp-use` 的 import/node 两种入口都成立，也不改变注册结果。
 */
function lowLevelFactory(factory: McpServerFactory): McpServerFactory {
  return async (context) => {
    const product = await factory(context);
    return 'server' in product ? product.server : product;
  };
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });
}

/**
 * mcp-use 的 mount 会先解析 body 再交给 SDK；SDK 对 `parsedBody` 跳过
 * `maxRequestBodySize` 检查（见 CreateMcpHandlerOptions 文档）。这里在进入
 * mount 前按官方入口相同的方式计数并返回 413，同时把解析结果写回 mcp-use
 * 的 request bag，避免它再次 clone/解析已消费的请求体。
 *
 * 不重建 `Request`：MCPP Files 的 FileScope 以请求对象为 WeakMap key，替换
 * 对象会让文件工具丢失身份。
 */
async function readBody(
  request: Request,
  limit: number,
): Promise<{ parsed: unknown } | Response> {
  if (request.method !== 'POST') return { parsed: undefined };
  // 非 JSON Content-Type 由 SDK 返回 415；此时不读取/消耗 body，保持官方优先级。
  if (!isJsonContentType(request.headers.get('content-type'))) return { parsed: undefined };
  if (Number(request.headers.get('content-length')) > limit) {
    return jsonRpcError(
      413,
      -32_000,
      `Payload Too Large: Request body must not exceed ${limit} bytes`,
    );
  }
  if (request.body === null) {
    return jsonRpcError(400, -32_700, 'Parse error: the request body is not valid JSON');
  }
  const reader = request.body.getReader();
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
  try {
    return { parsed: JSON.parse(text) as unknown };
  } catch {
    return jsonRpcError(400, -32_700, 'Parse error: the request body is not valid JSON');
  }
}

export function createMcpTransport(
  factory: McpServerFactory,
  implementation: McpImplementation = DEFAULT_MCP_IMPL,
): McpTransport {
  if (implementation === 'mcp-use') {
    const mount = createMcpMount(lowLevelFactory(factory), {
      path: '/mcp',
      handler: HANDLER_OPTIONS,
    });
    return {
      async fetch(request: Request): Promise<Response> {
        const body = await readBody(request, LIMITS.httpBodyBytes);
        if (body instanceof Response) return body;
        if (body.parsed !== undefined) getRequestBag(request).parsedBody = body.parsed;
        return mount.fetch(request);
      },
    };
  }
  const handler: McpHttpHandler = createMcpHandler(factory, HANDLER_OPTIONS);
  return { fetch: handler.fetch };
}
