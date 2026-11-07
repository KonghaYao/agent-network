/** MCP Events 的稳定标识与错误码。 */

export const MESSAGE_CREATED_EVENT_NAME = 'agentnet.message.created';

/** claimed 投递长时间没有 report 时写入 recipient inbox 的提醒事件。 */
export const DELIVERY_REMINDER_EVENT = 'delivery_reminder';
/** 提醒在统一 stream 中的 source；不等于普通 delivery 回执。 */
export const DELIVERY_REMINDER_SOURCE = 'delivery.reminder';
/** human 被提及（含 @所有人）时写入 recipient inbox 的个人提醒。 */
export const MENTION_REMINDER_EVENT = 'mention_reminder';
/** 提及提醒在统一 stream 中的 source；不产生 delivery 或待办。 */
export const MENTION_REMINDER_SOURCE = 'mention.reminder';

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
