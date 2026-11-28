import { BusinessError } from '../contracts/errors';
import type { MessageRecallInput } from '../contracts/message-recall';
import { LIMITS } from '../contracts/limits';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { outboxStatementIfEventMetadata, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getMessage } from '../storage/queries';
import { operationsStatement, resolveReplay, runIdempotent } from '../storage/transactions/runner';
import { memoryMessageRetractionStatements, type MemoryIntakeOptions } from '../memory/intake';
import {
  cancelMessageDeliveriesStatements,
  messageRecallEventKey,
  type RecallDeliveryRef,
} from './message-moderation-deliveries';
import { actorId, type Principal } from './principal';
import { messageUnpinnedStatements } from './room-message-pins';
import { roomAuditStatementIfEvent } from './room-audit';
import { historyBoundary, visibleMessage } from './room-history';
import {
  assertRoomWritable,
  capabilityGuardStatement,
  loadRoomAccess,
  messageAvailabilityGuardStatement,
  roomDissolvedGuardStatement,
} from './room-access';

const TOMBSTONE = '此消息已撤回';
export interface MessageRecallResult { message_id: string; recalled: true }

/**
 * 撤回消息。
 *
 * 两条路径：
 * - group owner：`manage_messages` 能力，不限时间、可撤回当前历史边界内任意
 *   成员（human/agent）任意类型的消息；同批取消该消息 pending/claimed 投递。
 * - 非 owner human：只撤回自己的消息，保留两分钟窗口、`send_message` 能力与
 *   “不能包含投递”的既有规则；admin 不继承 owner 的任意撤回。
 *
 * 软撤回只清空 `body`/`body_bytes` 并写 tombstone，不改变 sender、时间线与
 * 引用；已置顶消息在同一事务内取消置顶。撤回事件保留原 sender_id，
 * 另记 `recalled_by`，并保留 `body_sha256` 供发送重放校验。
 */
export async function messageRecall(
  db: D1Database,
  principal: Principal,
  input: MessageRecallInput,
  memory?: MemoryIntakeOptions | null,
): Promise<MessageRecallResult> {
  const actor = actorId(principal);
  const message = await getMessage(db, input.message_id);
  if (!message) throw new BusinessError('NOT_FOUND', '消息不存在');
  const access = await loadRoomAccess(db, message.room_id, actor);
  const room = access.room;
  const boundary = historyBoundary(room, access.member);
  if (!visibleMessage(message, boundary)) {
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  }
  assertRoomWritable(room);

  const ownerMode = access.capabilities.manage_messages;
  if (!ownerMode) {
    if (principal.actor?.kind !== 'human' || message.sender_id !== actor) {
      throw new BusinessError('PERMISSION_DENIED', '只能撤回自己发送的消息');
    }
  }

  const at = nowMs();
  // 保持旧 hash 兼容：同一 request_id 的历史撤回请求仍能重放。
  const payloadHash = await sha256Hex(stableStringify({ message_id: input.message_id }));
  // 权限预检之后、时间/投递限制之前解析重放。
  const replay = await resolveReplay(db, actor, input.request_id, payloadHash);
  if (replay.found) return replay.result as MessageRecallResult;

  const alreadyRecalled = message.body === '' && message.preview === TOMBSTONE;
  if (!ownerMode && !alreadyRecalled) {
    const age = nowMs() - message.created_at;
    if (age > LIMITS.messageRecallWindowMs) {
      throw new BusinessError('CONFLICT', '消息已超过撤回时间');
    }
    const delivery = await db
      .prepare('SELECT 1 AS yes FROM deliveries WHERE message_id = ? LIMIT 1')
      .bind(message.message_id)
      .first();
    if (delivery) {
      throw new BusinessError('CONFLICT', '包含执行投递的消息不能撤回；请单独取消投递');
    }
  }

  const deliveries = ownerMode
    ? (
        await db
          .prepare(
            `SELECT delivery_id, recipient_id FROM deliveries
              WHERE message_id = ? ORDER BY delivery_id`,
          )
          .bind(message.message_id)
          .all<RecallDeliveryRef>()
      ).results
    : [];

  const eventKey = messageRecallEventKey(message.message_id);
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(message.body);
  const unpinKey = `message_unpinned:${message.message_id}:${nonce}`;

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result: { message_id: message.message_id, recalled: true },
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, room.room_id),
      // owner 路径必须在提交时仍是 owner，不能静默降级为 self 规则。
      ...(ownerMode
        ? [
            capabilityGuardStatement(db, room.room_id, actor, 'manage_messages'),
            messageAvailabilityGuardStatement(db, room.room_id, actor, message.message_id),
          ]
        : [
            capabilityGuardStatement(db, room.room_id, actor, 'send_message'),
            db
              .prepare(
                guardSql(
                  'permissionDenied',
                  "NOT EXISTS (SELECT 1 FROM actors WHERE actor_id = ? AND kind = 'human')",
                ),
              )
              .bind(actor),
            db
              .prepare(
                guardSql(
                  'permissionDenied',
                  `NOT EXISTS (
                     SELECT 1 FROM messages m
                     JOIN rooms r ON r.room_id = m.room_id
                     JOIN room_members rm ON rm.room_id = r.room_id AND rm.actor_id = ? AND rm.status = 'active'
                     WHERE m.message_id = ? AND m.sender_id = ?
                       AND (r.kind = 'direct' OR r.member_history_policy = 'full' OR m.created_seq >= rm.joined_seq)
                       AND (
                         (m.body = '' AND m.preview = '${TOMBSTONE}')
                         OR (
                           m.body <> '' AND m.created_at >= ?
                           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.message_id)
                         )
                       )
                   )`,
                ),
              )
              .bind(actor, message.message_id, actor, at - LIMITS.messageRecallWindowMs),
          ]),
      // 先写首次转换事件：从仍有正文的消息行读取原作者；并发第二批次读到
      // tombstone 后不会重建事件，也不能错误归属给第二个操作者。
      db
        .prepare(
          `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
           SELECT 'room', m.room_id, 'message_recalled', m.message_id,
                  json_object(
                    'room_id', m.room_id,
                    'message_id', m.message_id,
                    'sender_id', m.sender_id,
                    'recalled_by', ?,
                    'body_sha256', ?,
                    'operation_nonce', ?
                  ),
                  ?, ?
             FROM messages m
            WHERE m.message_id = ? AND m.room_id = ?
              AND m.body <> '' AND m.body_bytes > 0
              AND NOT EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
        )
        .bind(
          actor,
          bodyHash,
          nonce,
          eventKey,
          at,
          message.message_id,
          room.room_id,
          eventKey,
        ),
      // owner 路径：原子取消未结束投递；completed/failed/cancelled 原样保留。
      ...(ownerMode
        ? cancelMessageDeliveriesStatements(db, deliveries, {
            roomId: room.room_id,
            messageId: message.message_id,
            actorId: actor,
            nonce,
            at,
          })
        : []),
      // 撤回同时取消该消息的置顶；普通成员撤回自己的置顶消息同样生效。
      ...messageUnpinnedStatements(db, {
        roomId: room.room_id,
        messageId: message.message_id,
        actorId: actor,
        requestId: input.request_id,
        eventKey: unpinKey,
        at,
        reason: 'message_recalled',
        recallTransition: { eventKey, nonce },
      }),
      db
        .prepare(
          `UPDATE messages SET body = '', body_bytes = 0, preview = ?
            WHERE message_id = ? AND body <> ''`,
        )
        .bind(TOMBSTONE, message.message_id),
      // 管理审计只记 owner 的首次实际撤回，不记录正文、预览或摘要。
      ...(ownerMode
        ? [
            roomAuditStatementIfEvent(
              db,
              {
                roomId: room.room_id,
                action: 'message_recalled',
                resultingRevision: 0,
                changedBy: actor,
                requestId: input.request_id,
                detail: { message_id: message.message_id },
              },
              eventKey,
              at,
              { key: 'operation_nonce', value: nonce },
            ),
          ]
        : []),
      // 稳定 event_key 可能来自旧转换；outbox 必须绑定本次 nonce，避免 GC
      // 后对旧事件补写提示。
      outboxStatementIfEventMetadata(
        db,
        { topic: roomTopic(room.room_id), eventKey },
        'operation_nonce',
        nonce,
        at,
      ),
      // 撤回是明确的来源排除证据：与正文清空、事件和 outbox 同批提交。
      // MEMORY_CAPTURE 关闭时仍保留该屏障，避免已登记来源继续被读取。
      ...(memory
        ? memoryMessageRetractionStatements(db, memory, {
            messageId: message.message_id,
            now: at,
          })
        : []),
    ],
  });
  return { message_id: message.message_id, recalled: true };
}
