/** MCP Events 的稳定标识与错误码。 */

export const MESSAGE_CREATED_EVENT_NAME = 'agentnet.message.created';

/**
 * Callback endpoint 验证失败的错误码。
 *
 * OpenAI MCP Events 集成文档使用 `-32015`；draft spec 当前写 `-32027`。
 * 以 OpenAI 文档为准，集中在这里便于 Phase 0 后单点切换。
 */
export const EVENTS_CALLBACK_ERROR_CODE = -32015;

export const EVENTS_ERROR_CODES = {
  unknownEvent: -32023,
  unauthorized: -32024,
  limit: -32025,
  unsupportedDelivery: -32026,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type EventsCallbackFailureReason =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'challenge_failed';
