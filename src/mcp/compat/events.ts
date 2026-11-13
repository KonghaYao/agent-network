/**
 * MCP Events 自定义方法的传输层分发。
 *
 * 业务实现只存在于 `src/mcp/events.ts`；本文件把同一批处理器暴露给
 * `src/mcp/transport.ts`，在进入 `MCPServer` 前调用。
 *
 * 未启用 Events 时不注册任何方法，客户端得到 -32601，能力目录也不声明
 * 顶层 `events`。
 */
import type { Principal } from '../../domain/principal';
import type { Env } from '../../env';
import {
  dispatchEventsMethod,
  EVENTS_METHODS,
  type EventsMethod,
} from '../events';
import type { MethodHandler } from './shared';

/**
 * 自定义方法用宽松对象接收参数，由业务层做显式校验：ChatGPT 可能发送未知
 * 字段或显式 null，这些都不应直接变成 -32602。
 */
export function eventsMethodHandlers(
  env: Env,
  principal: Principal,
): Record<EventsMethod, MethodHandler> {
  const handlers = {} as Record<EventsMethod, MethodHandler>;
  for (const method of EVENTS_METHODS) {
    handlers[method] = async (params, context) => {
      const result = await dispatchEventsMethod(
        method,
        params,
        env,
        principal,
        context.requestId,
      );
      return { ...result };
    };
  }
  return handlers;
}
