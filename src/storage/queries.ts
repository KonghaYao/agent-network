import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';

import { orm, schema, toD1, type D1Queryable } from './drizzle';
import type {
  ActorRow,
  ArtifactRow,
  DeliveryRow,
  DriveFileRow,
  FileReferenceRow,
  MessageRow,
  RoomFileRow,
  RoomMemberRow,
  RoomRow,
} from './rows';

export interface D1Like extends D1Queryable {
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * 4C-1 核心只读查询：actors / credentials / rooms / room_members 由 Drizzle 构建 SQL，
 * 仍经 `toD1()` 回到现有 D1 shim 执行。
 *
 * 4C-4 追加 messages / deliveries 的只读查询：单条读取、历史分页、时间线物化、
 * 消息上下文、收件箱投递列表与状态聚合、提及批量读取。以下内容继续保留 raw：
 * FTS5 `MATCH` 与 `instr` 片段搜索、`messages.task_root_id` 任务查询、
 * `EXISTS`/`CASE` 权限与闸门 SQL、timeline 的 `UNION ALL`，以及全部写路径。
 */

export async function getActor(db: D1Like, actorId: string): Promise<ActorRow | null> {
  const query = orm(db)
    .select()
    .from(schema.actors)
    .where(eq(schema.actors.actor_id, actorId));
  return toD1(db, query).first<ActorRow>();
}

export async function getActorBySession(db: D1Like, sessionId: string): Promise<ActorRow | null> {
  const query = orm(db)
    .select()
    .from(schema.actors)
    .where(eq(schema.actors.agent_session_id, sessionId));
  return toD1(db, query).first<ActorRow>();
}

/** 历史/时间线只判定发送者类型；不要在这里读取 metadata 或管理字段。 */
export interface ActorKindRow {
  actor_id: string;
  kind: 'human' | 'agent';
}

/**
 * 列举 actor 时隐藏已归档 Agent 的 SQL 条件。
 *
 * `alias` 必须是代码内固定的列别名，不能来自用户输入。人类不受归档影响；
 * 未归档 Agent 与停用 Agent 仍可见。只用于成员/联系人之类的列举查询，
 * 详情读取（`network_agents_get`）与 direct 会话对端解析不得套用。
 */
export function visibleActorSql(alias: string): string {
  return `(${alias}.kind <> 'agent' OR ${alias}.archived_at IS NULL)`;
}

/** 只按已知 actor_id 批量读取展示类型；调用方负责去重与数量上限。 */
export async function getActorsByIds(
  db: D1Like,
  actorIds: string[],
): Promise<ActorKindRow[]> {
  if (actorIds.length === 0) return [];
  const query = orm(db)
    .select({ actor_id: schema.actors.actor_id, kind: schema.actors.kind })
    .from(schema.actors)
    .where(inArray(schema.actors.actor_id, actorIds));
  const result = await toD1(db, query).all<ActorKindRow>();
  return result.results;
}

/** Agent 管理摘要需要的字段；metadata 与收件箱计数不进入该列表。 */
export type ActorManagementRow = Pick<
  ActorRow,
  | 'actor_id'
  | 'kind'
  | 'agent_session_id'
  | 'name'
  | 'archived_at'
  | 'archived_by'
  | 'disabled_at'
  | 'disabled_by'
  | 'disabled_reason'
>;

/** 只按已知 actor_id 批量读取 Agent 管理摘要。 */
export async function getActorManagementByIds(
  db: D1Like,
  actorIds: string[],
): Promise<ActorManagementRow[]> {
  if (actorIds.length === 0) return [];
  const query = orm(db)
    .select({
      actor_id: schema.actors.actor_id,
      kind: schema.actors.kind,
      agent_session_id: schema.actors.agent_session_id,
      name: schema.actors.name,
      archived_at: schema.actors.archived_at,
      archived_by: schema.actors.archived_by,
      disabled_at: schema.actors.disabled_at,
      disabled_by: schema.actors.disabled_by,
      disabled_reason: schema.actors.disabled_reason,
    })
    .from(schema.actors)
    .where(inArray(schema.actors.actor_id, actorIds));
  const result = await toD1(db, query).all<ActorManagementRow>();
  return result.results;
}

export async function getRoom(db: D1Like, roomId: string): Promise<RoomRow | null> {
  const query = orm(db).select().from(schema.rooms).where(eq(schema.rooms.room_id, roomId));
  return toD1(db, query).first<RoomRow>();
}

export async function getMember(
  db: D1Like,
  roomId: string,
  actorId: string,
): Promise<RoomMemberRow | null> {
  const query = orm(db)
    .select()
    .from(schema.roomMembers)
    .where(
      and(eq(schema.roomMembers.room_id, roomId), eq(schema.roomMembers.actor_id, actorId)),
    );
  return toD1(db, query).first<RoomMemberRow>();
}

export async function isActiveMember(db: D1Like, roomId: string, actorId: string): Promise<boolean> {
  const query = orm(db)
    .select({ ok: sql<number>`1`.as('ok') })
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.room_id, roomId),
        eq(schema.roomMembers.actor_id, actorId),
        eq(schema.roomMembers.status, 'active'),
      ),
    )
    .limit(1);
  const row = await toD1(db, query).first<{ ok: number }>();
  return row !== null;
}

/** 会话列表的只读对端：当前页 direct 房间的另一位 active 成员。 */
export interface RoomPeerRow {
  room_id: string;
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
}

/**
 * 按当前页房间批量读取对端；不在服务端逐房间调用 roomGet。
 *
 * 同一房间若存在多个对端（遗留数据），调用方保持“按 room_id 首次命中”的原有
 * 语义；这里仍按 room_id、actor_id 排序，保证结果稳定。
 */
export async function listActiveRoomPeers(
  db: D1Like,
  roomIds: string[],
  viewerId: string,
): Promise<RoomPeerRow[]> {
  if (roomIds.length === 0) return [];
  const query = orm(db)
    .select({
      room_id: schema.roomMembers.room_id,
      actor_id: schema.actors.actor_id,
      name: schema.actors.name,
      kind: schema.actors.kind,
    })
    .from(schema.roomMembers)
    .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.roomMembers.actor_id))
    .where(
      and(
        inArray(schema.roomMembers.room_id, roomIds),
        eq(schema.roomMembers.status, 'active'),
        ne(schema.roomMembers.actor_id, viewerId),
      ),
    )
    .orderBy(schema.roomMembers.room_id, schema.actors.actor_id);
  const result = await toD1(db, query).all<RoomPeerRow>();
  return result.results;
}

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

/** 消息级投递状态聚合；调用方自己按 message_id 分组。 */
export interface DeliveryStateRow {
  message_id: string;
  state: string;
  n: number;
  max_claimed_at: number | null;
  max_updated_at: number | null;
}

export async function listDeliveryStates(
  db: D1Like,
  messageIds: string[],
): Promise<DeliveryStateRow[]> {
  if (messageIds.length === 0) return [];
  const statement = orm(db)
    .select({
      message_id: schema.deliveries.message_id,
      state: schema.deliveries.state,
      n: sql<number>`count(*)`.as('n'),
      max_claimed_at: sql<number | null>`max(case when ${schema.deliveries.state} = 'claimed' then ${schema.deliveries.claimed_at} end)`.as(
        'max_claimed_at',
      ),
      max_updated_at: sql<number | null>`max(case when ${schema.deliveries.state} = 'claimed' then ${schema.deliveries.updated_at} end)`.as(
        'max_updated_at',
      ),
    })
    .from(schema.deliveries)
    .where(inArray(schema.deliveries.message_id, messageIds))
    .groupBy(schema.deliveries.message_id, schema.deliveries.state);
  const result = await toD1(db, statement).all<DeliveryStateRow>();
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

/** 收件箱投递列表行：`d.*` 加消息摘要与发送者展示身份。 */
export interface InboxDeliveryRow extends DeliveryRow {
  m_preview: string;
  m_body_bytes: number;
  m_sender_id: string;
  m_sender_name: string | null;
  m_sender_kind: 'human' | 'agent' | null;
  m_created_at: number;
}

export interface InboxDeliveryQuery {
  recipientId: string;
  /** null 表示不限状态；非空时按 `state IN (...)` 过滤。 */
  states: readonly DeliveryRow['state'][] | null;
  /** 上一页游标（不含）；null 表示首屏。 */
  afterSeq: number | null;
  limit: number;
}

export async function listInboxDeliveries(
  db: D1Like,
  query: InboxDeliveryQuery,
): Promise<InboxDeliveryRow[]> {
  const statement = orm(db)
    .select({
      delivery_id: schema.deliveries.delivery_id,
      recipient_id: schema.deliveries.recipient_id,
      message_id: schema.deliveries.message_id,
      room_id: schema.deliveries.room_id,
      state: schema.deliveries.state,
      attempt: schema.deliveries.attempt,
      claim_id: schema.deliveries.claim_id,
      claimed_at: schema.deliveries.claimed_at,
      progress_at: schema.deliveries.progress_at,
      result_message_id: schema.deliveries.result_message_id,
      error: schema.deliveries.error,
      created_seq: schema.deliveries.created_seq,
      created_at: schema.deliveries.created_at,
      updated_at: schema.deliveries.updated_at,
      last_reminded_at: schema.deliveries.last_reminded_at,
      m_preview: sql<string>`${schema.messages.preview}`.as('m_preview'),
      m_body_bytes: sql<number>`${schema.messages.body_bytes}`.as('m_body_bytes'),
      m_sender_id: sql<string>`${schema.messages.sender_id}`.as('m_sender_id'),
      m_created_at: sql<number>`${schema.messages.created_at}`.as('m_created_at'),
      m_sender_name: sql<string | null>`${schema.actors.name}`.as('m_sender_name'),
      m_sender_kind: sql<string | null>`${schema.actors.kind}`.as('m_sender_kind'),
    })
    .from(schema.deliveries)
    .innerJoin(schema.messages, eq(schema.messages.message_id, schema.deliveries.message_id))
    .leftJoin(schema.actors, eq(schema.actors.actor_id, schema.messages.sender_id))
    .where(
      and(
        eq(schema.deliveries.recipient_id, query.recipientId),
        query.states === null ? undefined : inArray(schema.deliveries.state, [...query.states]),
        query.afterSeq === null ? undefined : gt(schema.deliveries.created_seq, query.afterSeq),
      ),
    )
    .orderBy(asc(schema.deliveries.created_seq))
    .limit(query.limit);
  const result = await toD1(db, statement).all<InboxDeliveryRow>();
  return result.results;
}

/** 按 file_id 读取绑定记录；同一 file_id 全局唯一，含墓碑。 */
export async function getRoomFile(db: D1Like, fileId: string): Promise<RoomFileRow | null> {
  return db
    .prepare('SELECT * FROM room_files WHERE file_id = ?')
    .bind(fileId)
    .first<RoomFileRow>();
}

/** 按 file_id 读取应用层上传登记；旧库未登记的文件返回 null。 */
export async function getDriveFile(db: D1Like, fileId: string): Promise<DriveFileRow | null> {
  return db
    .prepare('SELECT * FROM drive_files WHERE file_id = ?')
    .bind(fileId)
    .first<DriveFileRow>();
}

/** 按 artifact_id 读取成果版本。 */
export async function getArtifact(db: D1Like, artifactId: string): Promise<ArtifactRow | null> {
  return db
    .prepare('SELECT * FROM artifacts WHERE artifact_id = ?')
    .bind(artifactId)
    .first<ArtifactRow>();
}

/** 按 file_id 读取成果版本；一个文件至多一个成果。 */
export async function getArtifactByFile(db: D1Like, fileId: string): Promise<ArtifactRow | null> {
  return db
    .prepare('SELECT * FROM artifacts WHERE file_id = ?')
    .bind(fileId)
    .first<ArtifactRow>();
}

/** 读取某文件的一条有效保留引用。 */
export async function getActiveFileReference(
  db: D1Like,
  fileId: string,
  kind: FileReferenceRow['kind'],
  refId: string,
): Promise<FileReferenceRow | null> {
  return db
    .prepare(
      "SELECT * FROM file_references WHERE file_id = ? AND kind = ? AND ref_id = ? AND state = 'active'",
    )
    .bind(fileId, kind, refId)
    .first<FileReferenceRow>();
}

/** 读取当前 actor 在房间内的网页监控配置；无行表示未配置。 */
export async function getActorRoomMonitor(
  db: D1Like,
  actorId: string,
  roomId: string,
): Promise<import('./rows').ActorRoomMonitorRow | null> {
  return db
    .prepare('SELECT * FROM actor_room_monitors WHERE actor_id = ? AND room_id = ?')
    .bind(actorId, roomId)
    .first<import('./rows').ActorRoomMonitorRow>();
}

export async function getDelivery(db: D1Like, deliveryId: string): Promise<DeliveryRow | null> {
  const query = orm(db)
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.delivery_id, deliveryId));
  return toD1(db, query).first<DeliveryRow>();
}

export async function getDeliveryForMessage(
  db: D1Like,
  recipientId: string,
  messageId: string,
): Promise<DeliveryRow | null> {
  const query = orm(db)
    .select()
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.recipient_id, recipientId),
        eq(schema.deliveries.message_id, messageId),
      ),
    );
  return toD1(db, query).first<DeliveryRow>();
}

export async function getClaimedDelivery(
  db: D1Like,
  recipientId: string,
): Promise<DeliveryRow | null> {
  const query = orm(db)
    .select()
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.recipient_id, recipientId),
        eq(schema.deliveries.state, 'claimed'),
      ),
    )
    .limit(1);
  return toD1(db, query).first<DeliveryRow>();
}

/** 收件箱只需 claimed 的存在性与 ID；避免把整行投递读进响应路径。 */
export async function getClaimedDeliveryId(
  db: D1Like,
  recipientId: string,
): Promise<string | null> {
  const query = orm(db)
    .select({ delivery_id: schema.deliveries.delivery_id })
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.recipient_id, recipientId),
        eq(schema.deliveries.state, 'claimed'),
      ),
    )
    .limit(1);
  const row = await toD1(db, query).first<{ delivery_id: string }>();
  return row?.delivery_id ?? null;
}

export async function getOperation(
  db: D1Like,
  actorId: string,
  requestId: string,
): Promise<import('./rows').OperationRow | null> {
  return db
    .prepare('SELECT * FROM operations WHERE actor_id = ? AND request_id = ?')
    .bind(actorId, requestId)
    .first<import('./rows').OperationRow>();
}

export async function getCredentialByHash(
  db: D1Like,
  tokenHash: string,
): Promise<import('./rows').CredentialRow | null> {
  const query = orm(db)
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.token_hash, tokenHash));
  return toD1(db, query).first<import('./rows').CredentialRow>();
}

export async function activeRoomCount(db: D1Like, actorId: string): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.actor_id, actorId),
        eq(schema.roomMembers.status, 'active'),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getEventsMinSeq(
  db: D1Like,
  scopeKind: 'room' | 'inbox' | 'actor',
  scopeId: string,
): Promise<number> {
  if (scopeKind === 'room') {
    const room = await getRoom(db, scopeId);
    return room?.events_min_seq ?? 0;
  }
  if (scopeKind === 'inbox') {
    const actor = await getActor(db, scopeId);
    return actor?.inbox_min_seq ?? 0;
  }
  return 0;
}
