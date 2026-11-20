import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type { RoomMessagePinInput, RoomMessagePinResult } from '../contracts/room-message-pin';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { outboxStatementIfAbsent, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getMessage } from '../storage/queries';
import { operationsStatement, resolveReplay, runIdempotent } from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import { roomAuditStatementIfEvent } from './room-audit';
import { assertRoomWritable, capabilityGuardStatement, loadRoomAccess, messageAvailabilityGuardStatement, roomDissolvedGuardStatement } from './room-access';
import { historyBoundary, visibleMessage } from './room-history';

/**
 * 群主置顶/取消置顶消息。
 *
 * - 只允许 group owner；admin 不继承，direct 返回 INVALID_ARGUMENT。
 * - 消息必须属于该房间且位于当前查看者的 `historyBoundary` 内。
 * - 最多 `LIMITS.roomPinnedMessagesMax` 条；第 4 条返回 CONFLICT/pin_limit。
 * - 已撤回消息不能置顶，但可以取消遗留置顶。
 * - 重复置顶同一消息不改变 `pinned_at`/`pinned_by`，不重复事件/审计/outbox。
 * - pin/unpin 不推进 `head_seq`、`member_seq`、`updated_at` 或 `last_message_id`。
 */
export interface MessageUnpinSpec {
  roomId: string;
  messageId: string;
  actorId: string;
  requestId: string;
  eventKey: string;
  at: number;
  /** 自动取消置顶时标记原因；显式 unpin 不写。 */
  reason?: 'message_recalled';
  /** 撤回自动清理：只有本次撤回转换真实发生时才写事件/审计/删除。 */
  recallTransition?: { eventKey: string; nonce: string };
}

/** 共享的 unpin 事件/审计/删除/outbox；自动清理与显式 unpin 使用同一形态。 */
export function messageUnpinnedStatements(
  db: D1Database,
  spec: MessageUnpinSpec,
): D1PreparedStatement[] {
  const metadata = spec.reason
    ? `json_object('room_id', p.room_id, 'message_id', p.message_id, 'changed_by', ?, 'reason', '${spec.reason}')`
    : `json_object('room_id', p.room_id, 'message_id', p.message_id, 'changed_by', ?)`;
  const transitionCondition = spec.recallTransition
    ? `AND EXISTS (SELECT 1 FROM events WHERE event_key = ? AND json_extract(metadata, '$.operation_nonce') = ?)`
    : '';
  const eventBinds: unknown[] = [
    spec.actorId,
    spec.eventKey,
    spec.at,
    spec.roomId,
    spec.messageId,
    spec.eventKey,
  ];
  if (spec.recallTransition) {
    eventBinds.push(spec.recallTransition.eventKey, spec.recallTransition.nonce);
  }
  return [
    db
      .prepare(
        `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
         SELECT 'room', p.room_id, 'message_unpinned', p.message_id, ${metadata}, ?, ?
           FROM room_pinned_messages p
          WHERE p.room_id = ? AND p.message_id = ?
            AND NOT EXISTS (SELECT 1 FROM events WHERE event_key = ?)
            ${transitionCondition}`,
      )
      .bind(...eventBinds),
    roomAuditStatementIfEvent(
      db,
      {
        roomId: spec.roomId,
        action: 'message_unpinned',
        resultingRevision: 0,
        changedBy: spec.actorId,
        requestId: spec.requestId,
        detail: { message_id: spec.messageId },
      },
      spec.eventKey,
      spec.at,
    ),
    db
      .prepare(
        `DELETE FROM room_pinned_messages
          WHERE room_id = ? AND message_id = ?
            AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
      )
      .bind(spec.roomId, spec.messageId, spec.eventKey),
    outboxStatementIfAbsent(
      db,
      { topic: roomTopic(spec.roomId), eventKey: spec.eventKey },
      spec.at,
    ),
  ];
}

function pinLimitGuard(db: D1Database, roomId: string, messageId: string): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'roomMessagePinLimit',
        `NOT EXISTS (SELECT 1 FROM room_pinned_messages WHERE room_id = ? AND message_id = ?)
         AND (SELECT COUNT(*) FROM room_pinned_messages WHERE room_id = ?) >= ?`,
      ),
    )
    .bind(roomId, messageId, roomId, LIMITS.roomPinnedMessagesMax);
}

function messageRecalledGuard(db: D1Database, roomId: string, messageId: string): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'messageRecalled',
        `EXISTS (
           SELECT 1 FROM messages
            WHERE message_id = ? AND room_id = ? AND (body_bytes = 0 OR body = '')
         )`,
      ),
    )
    .bind(messageId, roomId);
}

function pinStatements(
  db: D1Database,
  spec: { roomId: string; messageId: string; actor: string; requestId: string; eventKey: string; at: number },
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
         SELECT 'room', m.room_id, 'message_pinned', m.message_id,
                json_object('room_id', m.room_id, 'message_id', m.message_id, 'changed_by', ?),
                ?, ?
           FROM messages m
           JOIN rooms r ON r.room_id = m.room_id
           JOIN room_members rm ON rm.room_id = r.room_id AND rm.actor_id = ? AND rm.status = 'active'
          WHERE m.message_id = ? AND m.room_id = ?
            AND m.body_bytes > 0 AND m.body <> ''
            AND (r.member_history_policy = 'full' OR m.created_seq >= rm.joined_seq)
            AND NOT EXISTS (
              SELECT 1 FROM room_pinned_messages p
               WHERE p.room_id = ? AND p.message_id = ?
            )
            AND NOT EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
      )
      .bind(
        spec.actor,
        spec.eventKey,
        spec.at,
        spec.actor,
        spec.messageId,
        spec.roomId,
        spec.roomId,
        spec.messageId,
        spec.eventKey,
      ),
    // 容量已在闸门与 UNIQUE/CHECK 兜底；slot 由 batch 现场选第一个空位。
    db
      .prepare(
        `INSERT INTO room_pinned_messages (room_id, message_id, slot, pinned_by, pinned_at)
         SELECT ?, ?, slots.slot, ?, ?
           FROM (SELECT 1 AS slot UNION ALL SELECT 2 UNION ALL SELECT 3) slots
          WHERE slots.slot <= ?
            AND NOT EXISTS (
              SELECT 1 FROM room_pinned_messages p WHERE p.room_id = ? AND p.slot = slots.slot
            )
            AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)
          ORDER BY slots.slot
          LIMIT 1`,
      )
      .bind(
        spec.roomId,
        spec.messageId,
        spec.actor,
        spec.at,
        LIMITS.roomPinnedMessagesMax,
        spec.roomId,
        spec.eventKey,
      ),
    roomAuditStatementIfEvent(
      db,
      {
        roomId: spec.roomId,
        action: 'message_pinned',
        resultingRevision: 0,
        changedBy: spec.actor,
        requestId: spec.requestId,
        detail: { message_id: spec.messageId },
      },
      spec.eventKey,
      spec.at,
    ),
    outboxStatementIfAbsent(db, { topic: roomTopic(spec.roomId), eventKey: spec.eventKey }, spec.at),
  ];
}

export async function roomMessagePin(
  db: D1Database,
  principal: Principal,
  input: RoomMessagePinInput,
): Promise<RoomMessagePinResult> {
  const actor = actorId(principal);
  const access = await loadRoomAccess(db, input.room_id, actor);
  if (access.room.kind !== 'group') {
    throw new BusinessError('INVALID_ARGUMENT', '单聊不支持消息置顶');
  }
  assertRoomWritable(access.room);
  if (!access.capabilities.manage_messages) {
    throw new BusinessError('PERMISSION_DENIED', '只有群主可以置顶或取消置顶消息');
  }

  const message = await getMessage(db, input.message_id);
  if (!message || message.room_id !== input.room_id) {
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  }
  const boundary = historyBoundary(access.room, access.member);
  if (!visibleMessage(message, boundary)) {
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  }

  const result: RoomMessagePinResult = {
    room_id: input.room_id,
    message_id: input.message_id,
    pinned: input.pinned,
  };
  // 与其他幂等操作区分：同 request_id 跨工具调用不能共享 payload hash。
  const payloadHash = await sha256Hex(
    stableStringify({
      operation: 'room_message_pin',
      room_id: input.room_id,
      message_id: input.message_id,
      pinned: input.pinned,
    }),
  );
  // 权限与消息可见性预检之后、撤回状态与容量检查之前解析重放。
  const replay = await resolveReplay(db, actor, input.request_id, payloadHash);
  if (replay.found) return replay.result as RoomMessagePinResult;

  const recalled = message.body_bytes === 0 || message.body === '';
  if (input.pinned && recalled) {
    throw new BusinessError('CONFLICT', '消息已撤回，不能置顶', {
      reason: 'message_recalled',
    });
  }

  const at = nowMs();
  const nonce = crypto.randomUUID();
  const eventKey = `${input.pinned ? 'message_pinned' : 'message_unpinned'}:${input.message_id}:${nonce}`;

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, input.room_id),
      capabilityGuardStatement(db, input.room_id, actor, 'manage_messages'),
      messageAvailabilityGuardStatement(db, input.room_id, actor, input.message_id),
      ...(input.pinned
        ? [
            messageRecalledGuard(db, input.room_id, input.message_id),
            pinLimitGuard(db, input.room_id, input.message_id),
            ...pinStatements(db, {
              roomId: input.room_id,
              messageId: input.message_id,
              actor,
              requestId: input.request_id,
              eventKey,
              at,
            }),
          ]
        : messageUnpinnedStatements(db, {
            roomId: input.room_id,
            messageId: input.message_id,
            actorId: actor,
            requestId: input.request_id,
            eventKey,
            at,
          })),
    ],
  });

  return result;
}
