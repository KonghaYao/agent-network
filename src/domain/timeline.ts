import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type { HistoryListInput } from '../contracts/schemas';
import { getActorsByIds } from '../storage/queries';
import type { MessageRow, RoomRow } from '../storage/rows';
import {
  deliveryStatesFor,
  mentionsFor,
  nullableString,
} from './message-view-helpers';
import type { HistoryMessageView } from './messages';
import {
  decodeHistoryCursor,
  historyCursorScope,
  historySnapshot,
  type HistoryBoundary,
  type HistorySnapshot,
} from './room-history';

/**
 * 人类可见的房间时间线：普通消息与 Agent 上下线系统消息共用展示顺序。
 *
 * 展示 key 为 `(occurred_at, commit_seq)`：
 * - 普通消息使用 `created_at` / `created_seq`；
 * - presence 使用 `occurred_at` / `timeline_seq`。
 * before 固定 snapshot 后按展示 key 降序；after 按提交序号升序补读。
 * Agent 默认仍走 messages 视图，显式 timeline 会被拒绝。
 */

export interface TimelinePresenceItem {
  kind: 'presence';
  presence_event_id: string;
  room_id: string;
  agent_id: string;
  transition: 'online' | 'offline';
  occurred_at: string;
  recorded_at: string;
  timeline_seq: string;
  time_basis: 'observed' | 'inferred';
}

export type TimelineMessageItem = HistoryMessageView & { kind: 'message' };
export type TimelineItem = TimelineMessageItem | TimelinePresenceItem;

export interface TimelinePage {
  items: [];
  next_cursor: null;
  has_more: false;
  snapshot: string;
  head_seq: string;
  view: 'timeline';
  timeline_items: TimelineItem[];
  timeline_next_cursor: string | null;
  timeline_has_more: boolean;
  timeline_snapshot: string;
  timeline_resume_cursor: string;
  /** 本次读取采用的授权快照；与消息、文件、任务读取一致。 */
  authorization: HistorySnapshot;
}

interface TimelineKeyRow {
  kind: 'message' | 'presence';
  item_id: string;
  occurred_at: number;
  commit_seq: number;
}

interface PresenceRow {
  presence_event_id: string;
  room_id: string;
  agent_id: string;
  transition: 'online' | 'offline';
  occurred_at: number;
  recorded_at: number;
  timeline_seq: number;
  time_basis: 'observed' | 'inferred';
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

async function currentMaxSeq(db: D1Database, room: RoomRow): Promise<number> {
  const row = await db
    .prepare(
      `SELECT MAX(seq) AS seq FROM (
         SELECT ? AS seq
         UNION ALL
         SELECT MAX(timeline_seq) AS seq FROM room_presence_events WHERE room_id = ?
       )`,
    )
    .bind(room.head_seq, room.room_id)
    .first<{ seq: number | null }>();
  return row?.seq ?? 0;
}

function cursorCommit(cursor: ReturnType<typeof decodeCursor>): number {
  const value = Number(cursor.key);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BusinessError('INVALID_ARGUMENT', 'timeline cursor 缺少有效的提交序号');
  }
  return value;
}

function beforeCursor(
  scope: string,
  occurredAt: number,
  commitSeq: number,
  snapshot: number,
): string {
  return encodeCursor({
    v: 1,
    scope,
    dir: 'before',
    seq: occurredAt,
    key: String(commitSeq),
    snapshot,
  });
}

function afterCursor(scope: string, commitSeq: number, snapshot: number): string {
  return encodeCursor({
    v: 1,
    scope,
    dir: 'after',
    seq: commitSeq,
    snapshot,
  });
}

async function keyPage(
  db: D1Database,
  room: RoomRow,
  direction: 'before' | 'after',
  cursor: ReturnType<typeof decodeCursor> | null,
  snapshot: number,
  limit: number,
  boundary: HistoryBoundary,
): Promise<TimelineKeyRow[]> {
  const union = `
    SELECT 'message' AS kind, message_id AS item_id, created_at AS occurred_at, created_seq AS commit_seq
      FROM messages
     WHERE room_id = ? AND created_seq <= ? AND created_seq >= ?
    UNION ALL
    SELECT 'presence' AS kind, presence_event_id AS item_id, occurred_at, timeline_seq AS commit_seq
      FROM room_presence_events
     WHERE room_id = ? AND timeline_seq <= ? AND timeline_seq >= ?`;

  if (direction === 'before') {
    const predicate = cursor
      ? 'WHERE occurred_at < ? OR (occurred_at = ? AND commit_seq < ?)'
      : '';
    const binds: unknown[] = [
      room.room_id,
      snapshot,
      boundary.fromSeq,
      room.room_id,
      snapshot,
      boundary.fromSeq,
    ];
    if (cursor) binds.push(cursor.seq, cursor.seq, cursorCommit(cursor));
    binds.push(limit + 1);
    const rows = await db
      .prepare(
        `SELECT kind, item_id, occurred_at, commit_seq
           FROM (${union}) AS timeline
           ${predicate}
          ORDER BY occurred_at DESC, commit_seq DESC
          LIMIT ?`,
      )
      .bind(...binds)
      .all<TimelineKeyRow>();
    return rows.results;
  }

  const start = Math.max(cursor?.seq ?? snapshot, boundary.fromSeq);
  const rows = await db
    .prepare(
      `SELECT kind, item_id, occurred_at, commit_seq
         FROM (${union}) AS timeline
        WHERE commit_seq > ? AND commit_seq <= ?
        ORDER BY commit_seq ASC
        LIMIT ?`,
    )
    .bind(
      room.room_id,
      snapshot,
      boundary.fromSeq,
      room.room_id,
      snapshot,
      boundary.fromSeq,
      start,
      snapshot,
      limit + 1,
    )
    .all<TimelineKeyRow>();
  return rows.results;
}

async function materialize(
  db: D1Database,
  room: RoomRow,
  keys: TimelineKeyRow[],
): Promise<TimelineItem[]> {
  const messageIds = keys
    .filter((key) => key.kind === 'message')
    .map((key) => key.item_id);
  const presenceIds = keys
    .filter((key) => key.kind === 'presence')
    .map((key) => key.item_id);

  const messageRows =
    messageIds.length === 0
      ? []
      : (
          await db
            .prepare(`SELECT * FROM messages WHERE message_id IN (${placeholders(messageIds.length)})`)
            .bind(...messageIds)
            .all<MessageRow>()
        ).results;
  const presenceRows =
    presenceIds.length === 0
      ? []
      : (
          await db
            .prepare(
              `SELECT * FROM room_presence_events WHERE presence_event_id IN (${placeholders(presenceIds.length)})`,
            )
            .bind(...presenceIds)
            .all<PresenceRow>()
        ).results;

  const messageById = new Map(messageRows.map((row) => [row.message_id, row]));
  const presenceById = new Map(presenceRows.map((row) => [row.presence_event_id, row]));
  const senderIds = [...new Set(messageRows.map((row) => row.sender_id))];
  const senders = await getActorsByIds(db, senderIds);
  const senderKinds = new Map(senders.map((actor) => [actor.actor_id, actor.kind]));
  const states = await deliveryStatesFor(db, messageIds);
  const mentions = await mentionsFor(db, messageIds);

  const items: TimelineItem[] = [];
  for (const key of keys) {
    if (key.kind === 'presence') {
      const row = presenceById.get(key.item_id);
      if (!row) continue;
      items.push({
        kind: 'presence',
        presence_event_id: row.presence_event_id,
        room_id: row.room_id,
        agent_id: row.agent_id,
        transition: row.transition,
        occurred_at: String(row.occurred_at),
        recorded_at: String(row.recorded_at),
        timeline_seq: String(row.timeline_seq),
        time_basis: row.time_basis,
      });
      continue;
    }
    const row = messageById.get(key.item_id);
    if (!row) continue;
    const summary = states.get(row.message_id);
    items.push({
      kind: 'message',
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
      hop: row.hop,
      delivery_states: summary?.states ?? {},
      mentions: mentions.get(row.message_id) ?? [],
      delivery_claimed_at: nullableString(summary?.claimedAt ?? null),
      delivery_updated_at: nullableString(summary?.updatedAt ?? null),
    });
  }
  return items;
}

export async function timelineList(
  db: D1Database,
  room: RoomRow,
  input: HistoryListInput,
  boundary: HistoryBoundary,
): Promise<TimelinePage> {
  const scope = historyCursorScope('timeline', room.room_id, boundary.memberGeneration);
  const limit = clampPage(input.limit, LIMITS.historyPageDefault, LIMITS.historyPageMax);
  const cursor = input.cursor
    ? decodeHistoryCursor(input.cursor, scope, room.room_id)
    : null;
  const direction = input.direction ?? 'before';
  if (cursor && cursor.dir !== direction) {
    throw new BusinessError('INVALID_ARGUMENT', 'cursor 方向与请求不一致');
  }

  const max = await currentMaxSeq(db, room);
  const snapshot =
    direction === 'after'
      ? Math.max(max, boundary.fromSeq)
      : Math.max(cursor?.snapshot ?? max, boundary.fromSeq);
  const rows = await keyPage(db, room, direction, cursor, snapshot, limit, boundary);
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const items = await materialize(db, room, page);
  const last = page.at(-1);

  let nextCursor: string | null = null;
  let resumeCursor: string;
  if (direction === 'before') {
    if (hasMore && last) {
      nextCursor = beforeCursor(scope, last.occurred_at, last.commit_seq, snapshot);
    }
    resumeCursor = afterCursor(scope, snapshot, snapshot);
  } else {
    const lastCommit = last?.commit_seq ?? (cursor?.seq ?? snapshot);
    if (hasMore) nextCursor = afterCursor(scope, lastCommit, snapshot);
    resumeCursor = afterCursor(scope, lastCommit, Math.max(snapshot, lastCommit));
  }

  return {
    items: [],
    next_cursor: null,
    has_more: false,
    snapshot: String(snapshot),
    head_seq: String(room.head_seq),
    view: 'timeline',
    timeline_items: items,
    timeline_next_cursor: nextCursor,
    timeline_has_more: hasMore,
    timeline_snapshot: String(snapshot),
    timeline_resume_cursor: resumeCursor,
    authorization: historySnapshot(boundary),
  };
}
