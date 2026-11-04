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

export function callbackFailure(reason: EventsCallbackFailureReason): EventsError {
  return new EventsError('callback', 'callback endpoint verification failed', { reason });
}
