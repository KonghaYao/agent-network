import type { EventsCallbackFailureReason } from '../contracts/events';

export type EventsErrorKind =
  | 'unauthorized'
  | 'invalid'
  | 'unknown_event'
  | 'limit'
  | 'delivery_mode'
  | 'callback';

/** MCP Events 层的协议错误；由 `src/mcp/events.ts` 映射为 JSON-RPC error。 */
export class EventsError extends Error {
  readonly kind: EventsErrorKind;
  readonly data: Record<string, unknown>;

  constructor(kind: EventsErrorKind, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EventsError';
    this.kind = kind;
    this.data = data;
  }
}

export function invalidEventsArgument(
  message: string,
  details?: Record<string, unknown>,
): EventsError {
  return new EventsError('invalid', message, details ? { details } : {});
}

/**
 * `reason` 保持 OpenAI 文档 / 草案的固定分类；`detail` 提供更细的失败阶段，
 * 例如 timeout、http_status、challenge_mismatch、invalid_signature。
 */
export function callbackFailure(
  reason: EventsCallbackFailureReason,
  detail?: string,
  status?: number,
): EventsError {
  return new EventsError('callback', 'callback endpoint verification failed', {
    reason,
    ...(detail !== undefined ? { detail } : {}),
    ...(status !== undefined ? { status } : {}),
  });
}
