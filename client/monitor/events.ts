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

/** jq `//` 语义：null/undefined/false 才回退，空字符串保留。 */
function pick(value: unknown, fallback: unknown): unknown {
  return value === null || value === undefined || value === false ? fallback : value;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
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
  };
}

export function deliveryEvent(
  fields: DeliveryFields,
  claim: ClaimInfo,
  source: string,
  preview: BodyPreview,
  eventFile: string,
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
