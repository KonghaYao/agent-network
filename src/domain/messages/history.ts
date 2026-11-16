/** messages.ts 拆分模块：history。纯移动，行为保持不变。 */

import { encodeCursor } from '../../contracts/cursor';
import { BusinessError } from '../../contracts/errors';
import { clampPage, LIMITS } from '../../contracts/limits';
import { type HistoryListInput, type MessageReadInput, type RoomMarkReadInput } from '../../contracts/schemas';
import { newId, nowMs, sliceUtf8Chunk, truncateUtf8 } from '../../storage/db';
import { inboxHeadStatementIfEvent, inboxTopic } from '../../storage/events';
import { guardSql } from '../../storage/guards';
import {
  getActor,
  getActorsByIds,
  getMember,
  getMessage,
  listHistoryMessagesAfter,
  listHistoryMessagesBefore,
} from '../../storage/queries';
import type { ActorRow, MessageRow } from '../../storage/rows';
import { deliveryStatesFor, mentionsFor, nullableString } from '../message-view-helpers';
import { actorId, type Principal } from '../principal';
import { loadRoomAccess } from '../room-access';
import {
  decodeHistoryCursor,
  historyBoundary,
  historyCursorScope,
  historySnapshot,
  type HistoryBoundary,
  visibleMessage,
} from '../room-history';
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
    // after 游标必须单调前进：本页有消息时指向最后一条 created_seq；
    // 本页为空时推进到当前快照上界，避免下一次 after 重读同一段。
    // before 保持旧契约：只有存在下一页时才返回游标。
    next_cursor:
      direction === 'after'
        ? encodeCursor({
            v: 1,
            scope,
            dir: direction,
            seq: last?.created_seq ?? Math.max(cursor?.seq ?? 0, snapshot),
            snapshot,
          })
        : hasMore && last
          ? encodeCursor({
              v: 1,
              scope,
              dir: direction,
              seq: last.created_seq,
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
  /** 仅首次分块返回；后续分块省略，避免每块重复引用元数据。 */
  reply_to?: string | null;
  /** 首次分块的引用上下文；不可见、已撤回或发送者缺失时为 null。 */
  quote?: MessageQuote | null;
}

/** 引用消息的只读上下文；只按读取者当前历史边界判定，不扩大可见范围。 */
export interface MessageQuote {
  message_id: string;
  sender_id: string;
  sender_name: string;
  sender_kind: 'human' | 'agent';
  preview: string;
  created_at: string;
}

type QuoteParentRow = Pick<
  MessageRow,
  'message_id' | 'room_id' | 'sender_id' | 'preview' | 'body_bytes' | 'created_seq' | 'created_at'
>;

type QuoteSenderRow = Pick<ActorRow, 'name' | 'kind'>;

/**
 * 引用的纯判定：父消息必须同房间、在读取者当前边界内、未撤回且发送者仍存在。
 *
 * 任一条件失败都返回 null，不区分“不存在”“加入前”“已撤回”，避免按 ID 探测。
 */
export function quoteFromParent(
  parent: QuoteParentRow | null,
  sender: QuoteSenderRow | null,
  roomId: string,
  boundary: HistoryBoundary,
): MessageQuote | null {
  if (!parent || !sender) return null;
  if (parent.room_id !== roomId) return null;
  if (!visibleMessage(parent, boundary)) return null;
  if (parent.body_bytes <= 0) return null;
  return {
    message_id: parent.message_id,
    sender_id: parent.sender_id,
    // 名称与预览都在这里一次截断：引用不复制完整正文，也不重复发送事件。
    sender_name: truncateUtf8(
      Array.from(sender.name).slice(0, LIMITS.actorNameMax).join(''),
      LIMITS.actorNameBytes,
    ),
    sender_kind: sender.kind,
    preview: truncateUtf8(parent.preview, LIMITS.quotePreviewBytes),
    created_at: String(parent.created_at),
  };
}

/** 首次分块按主键回查父消息；不可见时仍返回 reply_to，只把 quote 置空。 */
async function resolveQuote(
  db: D1Database,
  parentId: string,
  roomId: string,
  boundary: HistoryBoundary,
): Promise<MessageQuote | null> {
  const parent = await getMessage(db, parentId);
  if (!parent) return null;
  const sender = parent.body_bytes > 0 ? await getActor(db, parent.sender_id) : null;
  return quoteFromParent(parent, sender, roomId, boundary);
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
  const boundary = historyBoundary(room, member);
  if (!visibleMessage(message, boundary)) {
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
  const firstChunk = offset === 0;
  const quote =
    firstChunk && message.reply_to
      ? await resolveQuote(db, message.reply_to, message.room_id, boundary)
      : null;
  return {
    message_id: message.message_id,
    room_id: message.room_id,
    chunk: chunk.text,
    chunk_cursor: String(offset),
    next_cursor: eof ? null : String(chunk.next),
    eof,
    body_bytes: message.body_bytes,
    created_seq: String(message.created_seq),
    ...(firstChunk ? { reply_to: message.reply_to, quote } : {}),
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
