/**
 * 监听事件的 JSON 信封。
 *
 * 字段与旧 shell 监听保持兼容：宿主和技能文档按这些键
 * 判断事件类型、claim 状态与正文预览。这里只做纯函数构造，不读写文件、
 * 不访问网络，便于验收脚本直接断言格式。
 */

import { asNumber, asString } from '../output';
import type { JsonObject } from './rpc';

/** stdout 的 delivery 事件最多携带的正文码点数；完整正文始终在 event_file。 */
export const BODY_PREVIEW_CHARS = 4000;

export const DEFERRED_HINT =
  '先 complete/fail 当前 claim；watcher 会按退避自动重试并补领，也可手动 claim 或重连快照';
export const CONFLICT_HINT = '跳过，不要处理；如需重新处理，由接收者用 network_delivery_retry 放回 pending';
export const CLAIM_FAILED_HINT = '不要处理；按 code 修复或等待人工核对后重试';
export const READ_FAILED_REASON = '投递已 claim，但读取正文或写事件文件失败';
export const READ_FAILED_HINT = 'claim 已占用；先重试读取，或 complete/fail 释放；不要当成可处理投递';
export const REMINDER_HINT =
  '先调用 network_delivery_report 报告当前阶段进度；完成则 complete，阻塞则 fail 或由接收者 retry';

export interface DeliveryFields {
  deliveryId: string;
  roomId: string;
  messageId: string;
  senderId: string;
  eventId: string;
  seq: string;
  attempt: number;
}

export interface ClaimInfo {
  deliveryId: string;
  attempt: number;
  claimedAt: string;
  claimId: string;
}

export interface ClaimFailure {
  deliveryId: string;
  code: string;
  message: string;
  kind: 'deferred' | 'conflict' | 'failed';
  claimedDeliveryId?: string;
  /** deferred 自动重试轮次与等待毫秒；终态失败为 undefined。 */
  retryAttempt?: number;
  retryInMs?: number;
}

export interface BodyPreview {
  body: string;
  bodyBytes: number;
  bodyTruncated: boolean;
}

/** 首次分块返回的引用上下文；只作为结构化字段，不拼进正文。 */
export interface MessageQuote {
  message_id: string;
  sender_id: string;
  sender_name: string;
  sender_kind: string;
  preview: string;
  created_at: string;
}

/** 引用字段容错：缺失或关键字段不完整时返回 null，不阻塞正文投递。 */
export function quoteOf(value: unknown): MessageQuote | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as JsonObject;
  const messageId = asString(record.message_id);
  const senderId = asString(record.sender_id);
  const senderName = asString(record.sender_name);
  if (messageId.length === 0 || senderId.length === 0 || senderName.length === 0) return null;
  return {
    message_id: messageId,
    sender_id: senderId,
    sender_name: senderName,
    sender_kind: asString(record.sender_kind),
    preview: asString(record.preview),
    created_at: asString(record.created_at),
  };
}

/** jq `//` 语义：null/undefined/false 才回退，空字符串保留。 */
function pick(value: unknown, fallback: unknown): unknown {
  return value === null || value === undefined || value === false ? fallback : value;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 事件字段缺失时写 null，避免宿主把空字符串误当成真实 ID。 */
function nullableText(value: unknown): string | null {
  const text = asText(value);
  return text.length > 0 ? text : null;
}

export function deliveryFields(item: JsonObject): DeliveryFields {
  const message = (item.message ?? {}) as JsonObject;
  return {
    deliveryId: asText(pick(item.delivery_id, '')),
    roomId: asText(pick(item.room_id, pick(message.room_id, ''))),
    messageId: asText(pick(item.message_id, pick(message.message_id, ''))),
    senderId: asText(pick(item.sender_id, pick(message.sender_id, ''))),
    eventId: asText(pick(item.event_id, '')),
    seq: asText(pick(item.seq, pick(item.created_seq, ''))),
    attempt: asNumber(pick(item.attempt, 0), 0),
  };
}

/** 按 Unicode 码点截断，不会切出非法 UTF-8；body_bytes 始终描述完整正文。 */
export function previewBody(body: string, limit = BODY_PREVIEW_CHARS): BodyPreview {
  const chars = Array.from(body);
  return {
    body: chars.slice(0, limit).join(''),
    bodyBytes: Buffer.byteLength(body, 'utf8'),
    bodyTruncated: chars.length > limit,
  };
}

export function eventFilePayload(
  fields: DeliveryFields,
  claim: ClaimInfo,
  source: string,
  body: string,
  quote: MessageQuote | null = null,
): JsonObject {
  return {
    type: 'delivery',
    delivery_id: fields.deliveryId,
    room_id: fields.roomId,
    message_id: fields.messageId,
    sender_id: fields.senderId,
    event_id: fields.eventId,
    seq: fields.seq,
    attempt: claim.attempt,
    claim_id: claim.claimId,
    claimed_at: claim.claimedAt,
    auto_claimed: true,
    claim_state: 'claimed',
    claim: {
      delivery_id: fields.deliveryId,
      attempt: claim.attempt,
      claim_id: claim.claimId,
    },
    source,
    body,
    ...(quote ? { quote } : {}),
  };
}

export function deliveryEvent(
  fields: DeliveryFields,
  claim: ClaimInfo,
  source: string,
  preview: BodyPreview,
  eventFile: string,
  quote: MessageQuote | null = null,
): JsonObject {
  return {
    type: 'delivery',
    delivery_id: fields.deliveryId,
    room_id: fields.roomId,
    message_id: fields.messageId,
    sender_id: fields.senderId,
    event_id: fields.eventId,
    seq: fields.seq,
    attempt: claim.attempt,
    claim_id: claim.claimId,
    claimed_at: claim.claimedAt,
    auto_claimed: true,
    claim_state: 'claimed',
    claim: {
      delivery_id: fields.deliveryId,
      attempt: claim.attempt,
      claim_id: claim.claimId,
    },
    source,
    body: preview.body,
    body_bytes: preview.bodyBytes,
    body_truncated: preview.bodyTruncated,
    event_file: eventFile,
    ...(quote ? { quote } : {}),
  };
}

export function claimNoticeEvent(
  fields: DeliveryFields,
  failure: ClaimFailure,
  source: string,
): JsonObject {
  const type =
    failure.kind === 'deferred'
      ? 'delivery_deferred'
      : failure.kind === 'conflict'
        ? 'delivery_conflict'
        : 'delivery_claim_failed';
  const hint =
    failure.kind === 'deferred'
      ? DEFERRED_HINT
      : failure.kind === 'conflict'
        ? CONFLICT_HINT
        : CLAIM_FAILED_HINT;
  return {
    type,
    source,
    delivery_id: failure.deliveryId,
    room_id: fields.roomId,
    message_id: fields.messageId,
    sender_id: fields.senderId,
    event_id: fields.eventId,
    seq: fields.seq,
    attempt: fields.attempt,
    code: failure.code,
    reason: failure.message,
    claim_state: failure.kind,
    claimed_delivery_id: failure.kind === 'deferred' ? (failure.claimedDeliveryId ?? null) : null,
    ...(failure.kind === 'deferred'
      ? {
          retry_attempt: failure.retryAttempt ?? null,
          retry_in_ms: failure.retryInMs ?? null,
        }
      : {}),
    hint,
  };
}

export function readFailedEvent(fields: DeliveryFields, claim: ClaimInfo, source: string): JsonObject {
  return {
    type: 'delivery_claim_failed',
    source,
    delivery_id: fields.deliveryId,
    room_id: fields.roomId,
    message_id: fields.messageId,
    event_id: fields.eventId,
    seq: fields.seq,
    attempt: claim.attempt,
    claim_id: claim.claimId,
    claimed_at: claim.claimedAt,
    auto_claimed: true,
    claim_state: 'failed',
    code: 'READ_FAILED',
    reason: READ_FAILED_REASON,
    claim: {
      delivery_id: fields.deliveryId,
      attempt: claim.attempt,
      claim_id: claim.claimId,
    },
    hint: READ_FAILED_HINT,
  };
}

/**
 * informational room 消息只携带定位字段，不携带正文或 preview。
 * 宿主需要正文时按 message_id 调用 network_message_read。
 *
 * `change` 覆盖撤回（`recalled`）等变更；`sender_name`/`sender_kind`
 * 让宿主无需额外查询即可判断发送者。
 */
export function roomMessageEvent(item: JsonObject, source: string): JsonObject {
  return {
    type: 'room_message',
    source,
    item_kind: asText(pick(item.kind, 'message')) || 'message',
    attention: asText(pick(item.attention, 'informational')) || 'informational',
    room_id: asText(pick(item.room_id, '')),
    message_id: asText(pick(item.message_id, '')),
    sender_id: asText(pick(item.sender_id, '')),
    sender_name: nullableText(item.sender_name),
    sender_kind: nullableText(item.sender_kind),
    change: nullableText(item.change),
    ref_id: nullableText(item.ref_id),
    event_id: asText(pick(item.event_id, '')),
    seq: asText(pick(item.seq, pick(item.created_seq, ''))),
  };
}

/**
 * 其他 informational stream item 的通用信封：房间成员/文件/在线状态、
 * Task、已读、好友、设备、资料与未知类型都走这里。只带定位与变更字段，
 * 不带正文、preview 或 error。
 *
 * `delivery_state` 是同一构造器的回执变体：claimed/progress/completed/
 * failed/cancelled 可见，但绝不进入 claim。
 */
export function streamItemEvent(item: JsonObject, source: string, type = 'stream_event'): JsonObject {
  return {
    type,
    source,
    kind: asText(pick(item.kind, 'unknown')) || 'unknown',
    item_kind: asText(pick(item.kind, 'unknown')) || 'unknown',
    attention: asText(pick(item.attention, 'informational')) || 'informational',
    change: nullableText(item.change),
    ref_id: nullableText(item.ref_id),
    room_id: asText(pick(item.room_id, '')),
    message_id: asText(pick(item.message_id, '')),
    delivery_id: asText(pick(item.delivery_id, '')),
    sender_id: asText(pick(item.sender_id, '')),
    sender_name: nullableText(item.sender_name),
    sender_kind: nullableText(item.sender_kind),
    event_id: asText(pick(item.event_id, '')),
    seq: asText(pick(item.seq, pick(item.created_seq, ''))),
    state: nullableText(item.state),
    attempt: item.attempt === undefined || item.attempt === null ? null : asNumber(item.attempt, 0),
    subject_id: nullableText(item.subject_id),
    changed_by: nullableText(item.changed_by),
    file_id: nullableText(item.file_id),
    mention_all: item.mention_all === true,
    transition: nullableText(item.transition),
  };
}

export function deliveryStateEvent(item: JsonObject, source: string): JsonObject {
  return streamItemEvent(item, source, 'delivery_state');
}

/**
 * `--no-room-events` 只抑制 informational 房间噪音。
 *
 * 服务端把发送方的 `delivery_completed` / `delivery_failed` 标为
 * `action_required`；`mention.reminder` 是人类的个人提醒，`delivery.reminder`
 * 是已领取投递的进度提醒。它们都不是房间广播，关闭 informational 房间事件时
 * 仍必须输出，否则发送方看不到回执、人类看不到 @ 提醒。
 */
export function visibleWithoutRoomEvents(item: JsonObject): boolean {
  if (item.attention === 'action_required') return true;
  const source = asString(item.source);
  return source === 'mention.reminder' || source === 'delivery.reminder';
}

export function reminderEvent(item: JsonObject): JsonObject {
  const message = (item.message ?? {}) as JsonObject;
  return {
    type: 'reminder',
    source: 'stream',
    delivery_id: asString(item.delivery_id),
    room_id: asText(pick(item.room_id, pick(message.room_id, ''))),
    message_id: asText(pick(item.message_id, pick(message.message_id, ''))),
    attempt: asNumber(item.attempt, 0),
    progress_at: item.progress_at ?? null,
    event_id: asText(pick(item.event_id, '')),
    seq: asText(pick(item.seq, '')),
    created_at: item.created_at ?? null,
    hint: REMINDER_HINT,
  };
}
