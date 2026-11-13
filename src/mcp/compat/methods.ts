/**
 * 传输层自定义方法表。
 *
 * mcp-use 的 `MCPServer` 只公开工具/资源/提示注册，无法注册 `skills/*` 与
 * `events/*`；4D-2 曾用一个不注册工具/资源的 native 兼容服务器应答这些
 * 方法与 `server/discover`。4D-3 改为在传输层直接分发：
 *
 * - 不复制工具/资源定义，也不为每个请求额外构建第二个 MCP 服务器；
 * - `server/discover` 由 mcp-use 应答后仅修正 capabilities（见
 *   `capabilities.ts`）；
 * - 结果信封补齐 `resultType: 'complete'` 与 `_meta.serverInfo`，与 SDK
 *   的 `setRequestHandler` 输出一致；
 * - 错误沿用 `ProtocolError` 的 code/message/data，未知错误映射为 -32603。
 */
import { ProtocolError } from '@modelcontextprotocol/server';

import { asRecord } from '../../events/log';
import type { Principal } from '../../domain/principal';
import type { Env } from '../../env';
import { SERVER_IDENTITY, SERVER_INFO_META_KEY } from '../identity';
import { eventsMethodHandlers } from './events';
import {
  jsonRpcResponse,
  type CompatMethodTable,
  type MethodCallContext,
  type MethodHandler,
} from './shared';
import { skillsMethodHandlers } from './skills';

function resultBody(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ...result,
    resultType: 'complete',
    _meta: { [SERVER_INFO_META_KEY]: SERVER_IDENTITY },
  };
}

function errorBody(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function createCompatMethods(
  env: Env,
  principal: Principal,
): CompatMethodTable {
  const handlers = new Map<string, MethodHandler>([
    ...Object.entries(skillsMethodHandlers()),
    ...(env.EVENTS ? Object.entries(eventsMethodHandlers(env, principal)) : []),
  ]);

  return {
    has: (method) => handlers.has(method),
    async handle(method, params, context: MethodCallContext) {
      const handler = handlers.get(method);
      if (handler === undefined) {
        return jsonRpcResponse(
          errorBody(context.requestId, -32601, `Method not found: ${method}`),
        );
      }
      try {
        const result = await handler(asRecord(params) ?? {}, context);
        return jsonRpcResponse({
          jsonrpc: '2.0',
          id: context.requestId,
          result: resultBody(result),
        });
      } catch (error) {
        if (error instanceof ProtocolError) {
          return jsonRpcResponse(
            errorBody(context.requestId, error.code, error.message, error.data),
          );
        }
        console.error(
          'mcp compat method failed',
          method,
          error instanceof Error ? error.name : 'UnknownError',
        );
        return jsonRpcResponse(
          errorBody(context.requestId, -32603, 'Internal server error'),
        );
      }
    },
  };
}
