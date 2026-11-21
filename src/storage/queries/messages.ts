import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';

import { orm, schema, toD1 } from '../drizzle';
import type { D1Like } from '../queries';
import type {
  MessageRow,
  PinnedMessageListRow,
} from '../rows';

export async function getMessage(db: D1Like, messageId: string): Promise<MessageRow | null> {
  const query = orm(db)
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.message_id, messageId));
  return toD1(db, query).first<MessageRow>();
}

/** 历史/时间线列表所需的消息列；顺序与迁移表定义一致，绝不包含 body。 */
const historyMessageSelection = {
  message_id: schema.messages.message_id,
  room_id: schema.messages.room_id,
  sender_id: schema.messages.sender_id,
  created_seq: schema.messages.created_seq,
  preview: schema.messages.preview,
  body_bytes: schema.messages.body_bytes,
  created_at: schema.messages.created_at,
  reply_to: schema.messages.reply_to,
  root_id: schema.messages.root_id,
  task_root_id: schema.messages.task_root_id,
  hop: schema.messages.hop,
} as const;

export type HistoryMessageRow = Pick<MessageRow, keyof typeof historyMessageSelection>;

export interface HistoryBeforeQuery {
  roomId: string;
  /** 本次请求的授权快照上界（含）。 */
  snapshot: number;
  /** 加入/策略下界（含）。 */
  fromSeq: number;
  /** 上一页游标（不含）；null 表示首屏。 */
  beforeSeq: number | null;
  limit: number;
}

/** 历史页向前翻旧：`created_seq DESC`，谓词与游标边界逐项对应旧 SQL。 */
export async function listHistoryMessagesBefore(
  db: D1Like,
  query: HistoryBeforeQuery,
): Promise<HistoryMessageRow[]> {
  const statement = orm(db)
    .select(historyMessageSelection)
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.room_id, query.roomId),
        lte(schema.messages.created_seq, query.snapshot),
        gte(schema.messages.created_seq, query.fromSeq),
        query.beforeSeq === null ? undefined : lt(schema.messages.created_seq, query.beforeSeq),
      ),
    )
    .orderBy(desc(schema.messages.created_seq))
    .limit(query.limit);
  const result = await toD1(db, statement).all<HistoryMessageRow>();
  return result.results;
}

export interface HistoryAfterQuery {
  roomId: string;
  snapshot: number;
  fromSeq: number;
  /** 已经读到的序号（不含）；调用方传入 `max(fromSeq, cursor.seq ?? snapshot)`。 */
  afterSeq: number;
  limit: number;
}

/** 历史页 after 追新：`created_seq ASC`，允许超过首次查询时的 head。 */
export async function listHistoryMessagesAfter(
  db: D1Like,
  query: HistoryAfterQuery,
): Promise<HistoryMessageRow[]> {
  const statement = orm(db)
    .select(historyMessageSelection)
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.room_id, query.roomId),
        lte(schema.messages.created_seq, query.snapshot),
        gt(schema.messages.created_seq, query.afterSeq),
        gte(schema.messages.created_seq, query.fromSeq),
      ),
    )
    .orderBy(asc(schema.messages.created_seq))
    .limit(query.limit);
  const result = await toD1(db, statement).all<HistoryMessageRow>();
  return result.results;
}

/** timeline 按键页物化消息行；调用方保持 keys 的展示顺序。 */
export async function listHistoryMessagesByIds(
  db: D1Like,
  messageIds: string[],
): Promise<HistoryMessageRow[]> {
  if (messageIds.length === 0) return [];
  const statement = orm(db)
    .select(historyMessageSelection)
    .from(schema.messages)
    .where(inArray(schema.messages.message_id, messageIds));
  const result = await toD1(db, statement).all<HistoryMessageRow>();
  return result.results;
}

/** 消息上下文投影；`sender_name`/`sender_kind` 依赖 actors 内连接。 */
export interface MessageContextRow {
  message_id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  sender_kind: 'human' | 'agent';
  body_bytes: number;
  preview: string;
  created_at: number;
  created_seq: number;
  reply_to: string | null;
}

const messageContextSelection = {
  message_id: schema.messages.message_id,
  room_id: schema.messages.room_id,
  sender_id: schema.messages.sender_id,
  sender_name: sql<string>`${schema.actors.name}`.as('sender_name'),
  sender_kind: sql<string>`${schema.actors.kind}`.as('sender_kind'),
  body_bytes: schema.messages.body_bytes,
  preview: schema.messages.preview,
  created_at: schema.messages.created_at,
  created_seq: schema.messages.created_seq,
  reply_to: schema.messages.reply_to,
} as const;

/** `message_context` 的锚点消息；可见性仍由域层按历史边界裁决。 */
export async function getMessageContextAnchor(
  db: D1Like,
  roomId: string,
  messageId: string,
): Promise<MessageContextRow | null> {
  const statement = orm(db)
    .select(messageContextSelection)
    .from(schema.messages)
    .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.messages.sender_id))
    .where(
      and(eq(schema.messages.room_id, roomId), eq(schema.messages.message_id, messageId)),
    );
  return toD1(db, statement).first<MessageContextRow>();
}

export interface MessageContextWindowQuery {
  roomId: string;
  /** 锚点序号；窗口不包含锚点自身。 */
  pivotSeq: number;
  direction: 'before' | 'after';
  /** 加入/策略下界；null 表示 full 策略不加谓词。 */
  fromSeq: number | null;
  /** 解散归档上界；只作用于 after 窗口，before 只会向下读取。 */
  toSeq: number | null;
  limit: number;
}

/** 锚点前/后的有界窗口；与旧 SQL 一样只做范围扫描与 limit。 */
export async function listMessageContextWindow(
  db: D1Like,
  query: MessageContextWindowQuery,
): Promise<MessageContextRow[]> {
  const conditions = [
    eq(schema.messages.room_id, query.roomId),
    query.direction === 'before'
      ? lt(schema.messages.created_seq, query.pivotSeq)
      : gt(schema.messages.created_seq, query.pivotSeq),
    query.fromSeq === null ? undefined : gte(schema.messages.created_seq, query.fromSeq),
    query.direction === 'after' && query.toSeq !== null
      ? lte(schema.messages.created_seq, query.toSeq)
      : undefined,
  ];
  const statement = orm(db)
    .select(messageContextSelection)
    .from(schema.messages)
    .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.messages.sender_id))
    .where(and(...conditions))
    .orderBy(
      query.direction === 'before'
        ? desc(schema.messages.created_seq)
        : asc(schema.messages.created_seq),
    )
    .limit(query.limit);
  const result = await toD1(db, statement).all<MessageContextRow>();
  return result.results;
}

/** 单条消息的历史列表投影 + 发送者展示身份；供投递视图与 stream 回执复用。 */
export interface MessageSenderSummaryRow {
  message_id: string;
  sender_id: string;
  created_seq: number;
  preview: string;
  body_bytes: number;
  created_at: number;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
}

export async function getMessageSenderSummary(
  db: D1Like,
  messageId: string,
): Promise<MessageSenderSummaryRow | null> {
  const statement = orm(db)
    .select({
      message_id: schema.messages.message_id,
      sender_id: schema.messages.sender_id,
      created_seq: schema.messages.created_seq,
      preview: schema.messages.preview,
      body_bytes: schema.messages.body_bytes,
      created_at: schema.messages.created_at,
      sender_name: sql<string | null>`${schema.actors.name}`.as('sender_name'),
      sender_kind: sql<string | null>`${schema.actors.kind}`.as('sender_kind'),
    })
    .from(schema.messages)
    .leftJoin(schema.actors, eq(schema.actors.actor_id, schema.messages.sender_id))
    .where(eq(schema.messages.message_id, messageId));
  return toD1(db, statement).first<MessageSenderSummaryRow>();
}

export interface RoomPinnedMessageQuery {
  /** 当前查看者的历史下界（含）；`full` 时为 0。 */
  fromSeq: number;
  /** 解散归档上界（含）；未归档为 null。 */
  toSeq: number | null;
  limit: number;
}

/**
 * 读取当前查看者可见的房间置顶消息。
 *
 * 预览与发送者永远取当前 `messages`/`actors` 行，不复制 pin 时快照；
 * 已撤回消息（`body_bytes = 0`）由 SQL 直接排除，避免墓碑出现在置顶区。
 * 排序固定为 `pinned_at DESC, message_id ASC`，只返回最多 `limit` 条，
 * 不泄露被历史边界隐藏的条数。
 */
export async function listRoomPinnedMessages(
  db: D1Like,
  roomId: string,
  query: RoomPinnedMessageQuery,
): Promise<PinnedMessageListRow[]> {
  const conditions: SQL[] = [
    eq(schema.roomPinnedMessages.room_id, roomId),
    gt(schema.messages.body_bytes, 0),
    gte(schema.messages.created_seq, query.fromSeq),
  ];
  if (query.toSeq !== null) {
    conditions.push(lte(schema.messages.created_seq, query.toSeq));
  }
  const statement = orm(db)
    .select({
      message_id: schema.roomPinnedMessages.message_id,
      preview: schema.messages.preview,
      sender_id: schema.messages.sender_id,
      sender_name: sql<string | null>`${schema.actors.name}`.as('sender_name'),
      sender_kind: sql<string | null>`${schema.actors.kind}`.as('sender_kind'),
      created_seq: schema.messages.created_seq,
      pinned_at: schema.roomPinnedMessages.pinned_at,
    })
    .from(schema.roomPinnedMessages)
    .innerJoin(
      schema.messages,
      and(
        eq(schema.messages.message_id, schema.roomPinnedMessages.message_id),
        eq(schema.messages.room_id, schema.roomPinnedMessages.room_id),
      ),
    )
    .leftJoin(schema.actors, eq(schema.actors.actor_id, schema.messages.sender_id))
    .where(and(...conditions))
    .orderBy(desc(schema.roomPinnedMessages.pinned_at), asc(schema.roomPinnedMessages.message_id))
    .limit(query.limit);
  const result = await toD1(db, statement).all<PinnedMessageListRow>();
  return result.results;
}

export interface MessageMentionRow {
  message_id: string;
  actor_id: string;
  actor_kind: 'human' | 'agent';
  source: 'explicit' | 'text' | 'all';
}

export async function listMessageMentions(
  db: D1Like,
  messageIds: string[],
): Promise<MessageMentionRow[]> {
  if (messageIds.length === 0) return [];
  const statement = orm(db)
    .select({
      message_id: schema.messageMentions.message_id,
      actor_id: schema.messageMentions.actor_id,
      actor_kind: schema.messageMentions.actor_kind,
      source: schema.messageMentions.source,
    })
    .from(schema.messageMentions)
    .where(inArray(schema.messageMentions.message_id, messageIds))
    .orderBy(schema.messageMentions.message_id, schema.messageMentions.actor_id);
  const result = await toD1(db, statement).all<MessageMentionRow>();
  return result.results;
}
