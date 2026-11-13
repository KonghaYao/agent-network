/** messages.ts 拆分模块：history。纯移动，行为保持不变。 */

import { encodeCursor } from '../../contracts/cursor';
import { BusinessError } from '../../contracts/errors';
import { clampPage, LIMITS } from '../../contracts/limits';
import { type HistoryListInput, type MessageReadInput, type RoomMarkReadInput } from '../../contracts/schemas';
import { newId, nowMs, sliceUtf8Chunk } from '../../storage/db';
import { inboxHeadStatementIfEvent, inboxTopic } from '../../storage/events';
import { guardSql } from '../../storage/guards';
import {
  getActorsByIds,
  getMember,
  getMessage,
  listHistoryMessagesAfter,
  listHistoryMessagesBefore,
} from '../../storage/queries';
import { deliveryStatesFor, mentionsFor, nullableString } from '../message-view-helpers';
import { actorId, type Principal } from '../principal';
import { loadRoomAccess } from '../room-access';
import { decodeHistoryCursor, historyBoundary, historyCursorScope, historySnapshot, visibleMessage } from '../room-history';
import { timelineList, type TimelinePage } from '../timeline';
import { type MessagePage } from './view';

export async function historyList(
  db: D1Database,
  principal: Principal,
  input: HistoryListInput,
): Promise<MessagePage | TimelinePage> {
  const viewer = actorId(principal);
  const { room, member } = await loadRoomAccess(db, input.room_id, viewer);
  // 本次请求只使用这一份授权快照：即使策略在查询期间变化，列表、游标与
  // 返回的 authorization 仍按同一代次/边界解释；下一次请求重新计算。
  const boundary = historyBoundary(room, member);
  const authorization = historySnapshot(boundary);

  if (input.view === 'timeline') {
    if (principal.actor?.kind !== 'human') {
      throw new BusinessError('INVALID_ARGUMENT', 'timeline 视图仅对人类身份开放');
    }
    return timelineList(db, room, input, boundary);
  }

  const scope = historyCursorScope('history', room.room_id, boundary.memberGeneration);
  const limit = clampPage(input.limit, LIMITS.historyPageDefault, LIMITS.historyPageMax);
  const cursor = input.cursor
    ? decodeHistoryCursor(input.cursor, scope, room.room_id)
    : null;
  const direction = input.direction ?? 'before';
  // 解散归档固定读取上界；after 追新也不能越过 archived_head_seq。
  const readHead =
    boundary.toSeq === null ? room.head_seq : Math.min(room.head_seq, boundary.toSeq);
  // 快照上界只用于向前翻旧页；after 是追新，必须允许超过首次查询时的 head。
  const snapshot =
    direction === 'after'
      ? readHead
      : Math.max(boundary.fromSeq, cursor?.snapshot ?? readHead);

  const rows =
    direction === 'before'
      ? await listHistoryMessagesBefore(db, {
          roomId: room.room_id,
          snapshot,
          fromSeq: boundary.fromSeq,
          beforeSeq: cursor?.seq ?? null,
          limit: limit + 1,
        })
      : await listHistoryMessagesAfter(db, {
          roomId: room.room_id,
          snapshot,
          fromSeq: boundary.fromSeq,
          afterSeq: Math.max(boundary.fromSeq, cursor?.seq ?? snapshot),
          limit: limit + 1,
        });

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page.at(-1);
  const states = await deliveryStatesFor(
    db,
    page.map((row) => row.message_id),
  );
  const mentions = await mentionsFor(
    db,
    page.map((row) => row.message_id),
  );
  // 一次 IN 查询取权威 kind，避免网页依赖成员列表或在成员被移出后丢失 AI 属性。
  const senderIds = [...new Set(page.map((row) => row.sender_id))];
  const senders = await getActorsByIds(db, senderIds);
  const senderKinds = new Map(senders.map((actor) => [actor.actor_id, actor.kind]));

  const items = page.map((row) => {
    const summary = states.get(row.message_id);
    return {
      message_id: row.message_id,
      room_id: row.room_id,
      sender_id: row.sender_id,
      sender_kind: senderKinds.get(row.sender_id) ?? null,
      created_seq: String(row.created_seq),
      preview: row.preview,
      body_bytes: row.body_bytes,
      created_at: String(row.created_at),
      reply_to: row.reply_to,
      root_id: row.root_id,
      task_root_id: row.task_root_id,
      hop: row.hop,
      delivery_states: summary?.states ?? {},
      mentions: mentions.get(row.message_id) ?? [],
      delivery_claimed_at: nullableString(summary?.claimedAt ?? null),
      delivery_updated_at: nullableString(summary?.updatedAt ?? null),
    };
  });

  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: direction,
            seq: last.created_seq,
            snapshot,
          })
        : direction === 'after'
          ? encodeCursor({
              v: 1,
              scope,
              dir: direction,
              seq: cursor?.seq ?? snapshot,
              snapshot,
            })
          : null,
    has_more: hasMore,
    snapshot: String(snapshot),
    head_seq: String(room.head_seq),
    authorization,
  };
}

export interface ReadChunk {
  message_id: string;
  room_id: string;
  chunk: string;
  chunk_cursor: string;
  next_cursor: string | null;
  eof: boolean;
  body_bytes: number;
  created_seq: string;
}

export async function messageRead(
  db: D1Database,
  principal: Principal,
  input: MessageReadInput,
): Promise<ReadChunk> {
  const viewer = actorId(principal);
  const message = await getMessage(db, input.message_id);
  if (!message) throw new BusinessError('NOT_FOUND', '消息不存在');
  const { room, member } = await loadRoomAccess(db, message.room_id, viewer);
  if (!visibleMessage(message, historyBoundary(room, member))) {
    // 按 ID 直读与列表共用同一可见性；不区分“不存在”和“加入前”，避免探测。
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  }

  let offset = 0;
  if (input.chunk_cursor) {
    if (!/^\d{1,12}$/u.test(input.chunk_cursor)) {
      throw new BusinessError('INVALID_ARGUMENT', 'chunk_cursor 必须是字节偏移');
    }
    offset = Number(input.chunk_cursor);
  }
  if (offset > message.body_bytes) {
    throw new BusinessError('INVALID_ARGUMENT', 'chunk_cursor 超出正文长度');
  }
  const chunk = sliceUtf8Chunk(message.body, offset, LIMITS.bodyChunkBytes);
  const eof = chunk.next >= chunk.total;
  return {
    message_id: message.message_id,
    room_id: message.room_id,
    chunk: chunk.text,
    chunk_cursor: String(offset),
    next_cursor: eof ? null : String(chunk.next),
    eof,
    body_bytes: message.body_bytes,
    created_seq: String(message.created_seq),
  };
}

export async function roomMarkRead(
  db: D1Database,
  principal: Principal,
  input: RoomMarkReadInput,
): Promise<{ room_id: string; last_read_seq: string }> {
  const viewer = actorId(principal);
  const through = Number(input.through_seq);
  if (!Number.isSafeInteger(through) || through < 0) {
    throw new BusinessError('INVALID_ARGUMENT', 'through_seq 必须是非负整数');
  }
  const { room, member: current } = await loadRoomAccess(db, input.room_id, viewer);
  // 加入前的内容不属于当前代次，阅读水位不能低于本次加入边界。
  const floor = historyBoundary(room, current).fromSeq;
  const clampThrough = Math.max(through, floor);

  const at = nowMs();
  const eventKey = newId('room_read');
  await db.batch([
    db
      .prepare(
        guardSql(
          'notMember',
          "NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active')",
        ),
      )
      .bind(room.room_id, viewer),
    db
      .prepare(
        `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
         SELECT 'inbox', ?, 'room_read', ?, ?, ?, ?
           FROM room_members m JOIN rooms r ON r.room_id = m.room_id
          WHERE m.room_id = ? AND m.actor_id = ? AND m.status = 'active'
            AND m.last_read_seq < MIN(?, r.head_seq)`,
      )
      .bind(
        viewer,
        room.room_id,
        JSON.stringify({ room_id: room.room_id }),
        eventKey,
        at,
        room.room_id,
        viewer,
        clampThrough,
      ),
    db
      .prepare(
        `UPDATE room_members
            SET last_read_seq = MAX(last_read_seq, MIN(?, (SELECT head_seq FROM rooms WHERE room_id = ?)))
          WHERE room_id = ? AND actor_id = ? AND status = 'active'
            AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
      )
      .bind(clampThrough, room.room_id, room.room_id, viewer, eventKey),
    db
      .prepare(
        `INSERT INTO outbox (outbox_id, topic, event_seq, status, attempts, next_attempt_at, created_at)
         SELECT ?, ?, event_seq, 'pending', 0, ?, ? FROM events WHERE event_key = ?`,
      )
      .bind(newId('obx'), inboxTopic(viewer), at, at, eventKey),
    inboxHeadStatementIfEvent(db, viewer, eventKey, at, 0),
  ]);

  const member = await getMember(db, room.room_id, viewer);
  return { room_id: room.room_id, last_read_seq: String(member?.last_read_seq ?? 0) };
}
