/**
 * 自定义 MCP 方法在传输层的共用类型与参数校验。
 *
 * `skills/*` 与 `events/*` 不是 MCP 标准方法，mcp-use 的 `MCPServer` 没有
 * 注册入口，因此由 `src/mcp/transport.ts` 在进入 mcp-use 之前直接应答。
 * native 路径仍通过 `McpServer.setRequestHandler` 注册同一批处理器，两边
 * 共用业务实现，错误码与文案保持一致。
 */
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/** 处理器只需要 JSON-RPC 请求 id 来写阶段日志。 */
export interface MethodCallContext {
  requestId: string | number | null;
}

/** 自定义方法的业务处理器；返回 JSON-RPC `result` 的业务字段。 */
export type MethodHandler = (
  params: Record<string, unknown>,
  context: MethodCallContext,
) => Promise<Record<string, unknown>>;

/** 传输层可见的自定义方法表。 */
export interface CompatMethodTable {
  has(method: string): boolean;
  /** 返回完整 JSON-RPC 响应；调用方只负责鉴权与 mount 头。 */
  handle(method: string, params: unknown, context: MethodCallContext): Promise<Response>;
}

/**
 * 与 SDK 的请求参数校验保持同一错误分类与文案形状：
 * `Invalid params for <method>: <path>: <reason>`，code -32602。
 */
export function parseMethodParams<T>(
  method: string,
  schema: z.ZodType<T>,
  params: Record<string, unknown>,
): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    const reason = issue?.message ?? 'Invalid input';
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid params for ${method}: ${path ? `${path}: ${reason}` : reason}`,
    );
  }
  return parsed.data;
}

/** 自定义方法与 SDK 一样只在 JSON-RPC 层失败，HTTP 仍为 200。 */
export function jsonRpcResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
