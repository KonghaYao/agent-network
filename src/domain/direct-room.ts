import { sha256Hex, sortedPairKey } from '../storage/db';
import {
  eventStatementIfAbsent,
  inboxChangeStatements,
  outboxStatementIfAbsent,
  roomHeadStatement,
  roomTopic,
} from '../storage/events';

/**
 * direct 单聊房间的确定性身份与创建语句。
 *
 * 显式 `network_room_create` 与好友关系激活共用这一份实现：房间 id 只由
 * `pair_key` 决定，重复接受、幂等重放或并发建联都会落到同一行，不会生成
 * 第二个单聊。语句全部幂等；调用方负责把它们与关系写入放进同一事务。
 */

export async function directRoomIdFor(actorA: string, actorB: string): Promise<string> {
  const pairKey = sortedPairKey(actorA, actorB);
  return `rm_${(await sha256Hex(`direct:${pairKey}`)).slice(0, 32)}`;
}

export function directRoomStatements(
  db: D1Database,
  actorA: string,
  actorB: string,
  roomId: string,
  at: number,
): D1PreparedStatement[] {
  const pairKey = sortedPairKey(actorA, actorB);
  const participants = [actorA, actorB];
  const roomRef = `room_created:${roomId}`;
  return [
    db
      .prepare(
        `INSERT INTO rooms
           (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq, member_seq, last_message_id, created_at, updated_at)
         VALUES (?, 'direct', NULL, '', ?, 0, 0, 0, NULL, ?, ?)
         ON CONFLICT(room_id) DO NOTHING`,
      )
      .bind(roomId, pairKey, at, at),
    eventStatementIfAbsent(
      db,
      {
        eventKey: roomRef,
        scopeKind: 'room',
        scopeId: roomId,
        eventType: 'room_created',
        refId: roomId,
        metadata: { pair: participants },
      },
      at,
    ),
    outboxStatementIfAbsent(db, { topic: roomTopic(roomId), eventKey: roomRef }, at),
    roomHeadStatement(db, roomId, roomRef, at),
    ...participants.map((participant) =>
      db
        .prepare(
          `INSERT INTO room_members
             (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
           VALUES (?, ?, 'member', 'active', (SELECT event_seq FROM events WHERE event_key = ?), 0, ?, 1, ?)
           ON CONFLICT(room_id, actor_id) DO UPDATE SET
             status = 'active', role = 'member', updated_at = excluded.updated_at`,
        )
        .bind(roomId, participant, roomRef, at, at),
    ),
    ...inboxChangeStatements(
      db,
      participants,
      (actor) => `room_created:${roomId}:${actor}`,
      'room_created',
      at,
      roomId,
    ),
  ];
}
