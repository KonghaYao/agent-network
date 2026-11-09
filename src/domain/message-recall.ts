import { BusinessError } from '../contracts/errors';
import type { MessageRecallInput } from '../contracts/message-recall';
import { LIMITS } from '../contracts/limits';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { outboxStatementIfAbsent, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getMember, getMessage, getRoom } from '../storage/queries';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import { historyBoundary, visibleMessage } from './room-history';
import { assertRoomWritable, capabilityGuardStatement, roomDissolvedGuardStatement } from './room-access';

const TOMBSTONE = '此消息已撤回';
export interface MessageRecallResult { message_id: string; recalled: true }

/** 普通 human 自己的消息限时撤回；只清空正文，不改变其历史定位。 */
export async function messageRecall(db: D1Database, principal: Principal, input: MessageRecallInput): Promise<MessageRecallResult> {
  const actor = actorId(principal);
  const message = await getMessage(db, input.message_id);
  if (!message) throw new BusinessError('NOT_FOUND', '消息不存在');
  const room = await getRoom(db, message.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, actor);
  if (!member || member.status !== 'active') throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  if (!visibleMessage(message, historyBoundary(room, member))) throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  assertRoomWritable(room);
  if (principal.actor?.kind !== 'human' || message.sender_id !== actor) throw new BusinessError('PERMISSION_DENIED', '只能撤回自己发送的消息');
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify({ message_id: input.message_id }));
  const alreadyRecalled = message.body === '' && message.preview === TOMBSTONE;
  if (!alreadyRecalled) {
    const age = nowMs() - message.created_at;
    if (age > LIMITS.messageRecallWindowMs) throw new BusinessError('CONFLICT', '消息已超过撤回时间');
    const delivery = await db.prepare('SELECT 1 AS yes FROM deliveries WHERE message_id = ? LIMIT 1').bind(message.message_id).first();
    if (delivery) throw new BusinessError('CONFLICT', '包含执行投递的消息不能撤回；请单独取消任务');
    const task = await db.prepare('SELECT 1 AS yes FROM tasks t LEFT JOIN task_cards c ON c.task_id = t.task_id WHERE t.source_message_id = ? OR c.message_id = ? LIMIT 1').bind(message.message_id, message.message_id).first();
    if (task) throw new BusinessError('CONFLICT', '任务引用的消息不能撤回；请单独取消任务');
  }
  const eventKey = `message_recalled:${message.message_id}`;
  const bodyHash = await sha256Hex(message.body);
  await runIdempotent(db, {
    actorId: actor, requestId: input.request_id, payloadHash,
    result: { message_id: message.message_id, recalled: true },
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, room.room_id),
      capabilityGuardStatement(db, room.room_id, actor, 'send_message'),
      db.prepare(guardSql('permissionDenied', `NOT EXISTS (
        SELECT 1 FROM messages m JOIN rooms r ON r.room_id = m.room_id
        JOIN room_members rm ON rm.room_id = r.room_id AND rm.actor_id = ? AND rm.status = 'active'
        WHERE m.message_id = ? AND m.sender_id = ?
          AND (r.kind = 'direct' OR r.member_history_policy = 'full' OR m.created_seq >= rm.joined_seq)
          AND ( (m.body = '' AND m.preview = '${TOMBSTONE}') OR (m.body <> '' AND m.created_at >= ?
          AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.message_id)
          AND NOT EXISTS (SELECT 1 FROM tasks t LEFT JOIN task_cards c ON c.task_id = t.task_id WHERE t.source_message_id = m.message_id OR c.message_id = m.message_id)) )
      )`)).bind(actor, message.message_id, actor, at - LIMITS.messageRecallWindowMs),
      db.prepare("UPDATE messages SET body = '', body_bytes = 0, preview = ? WHERE message_id = ? AND body <> ''").bind(TOMBSTONE, message.message_id),
      db.prepare(`INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
        SELECT 'room', ?, 'message_recalled', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE message_id = ? AND body = '' AND preview = ?)
          AND NOT EXISTS (SELECT 1 FROM events WHERE event_key = ?)`)
        .bind(room.room_id, message.message_id, JSON.stringify({ room_id: room.room_id, message_id: message.message_id, sender_id: actor, body_sha256: bodyHash }), eventKey, at, message.message_id, TOMBSTONE, eventKey),
      outboxStatementIfAbsent(db, { topic: roomTopic(room.room_id), eventKey }, at),
    ],
  });
  return { message_id: message.message_id, recalled: true };
}
