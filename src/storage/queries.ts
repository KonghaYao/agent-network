import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import { orm, schema, toD1, type D1Queryable } from './drizzle';
import type {
  ActorRow,
  ArtifactRow,
  DeliveryRow,
  DriveFileRow,
  EventSubscriptionRow,
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
 * 4C 核心只读查询：actors / credentials / rooms / room_members 与 files/events 的
 * 简单单表读取由 Drizzle 构建 SQL，仍经 `toD1()` 回到现有 D1 shim 执行。
 * 消息、复杂 JOIN、历史边界、FTS、guard 与状态机 SQL 继续保留手写。
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
  return db.prepare('SELECT * FROM messages WHERE message_id = ?').bind(messageId).first<MessageRow>();
}

/** 按 file_id 读取绑定记录；同一 file_id 全局唯一，含墓碑。 */
export async function getRoomFile(db: D1Like, fileId: string): Promise<RoomFileRow | null> {
  const query = orm(db)
    .select()
    .from(schema.roomFiles)
    .where(eq(schema.roomFiles.file_id, fileId));
  return toD1(db, query).first<RoomFileRow>();
}

/** 按 file_id 读取应用层上传登记；旧库未登记的文件返回 null。 */
export async function getDriveFile(db: D1Like, fileId: string): Promise<DriveFileRow | null> {
  const query = orm(db)
    .select()
    .from(schema.driveFiles)
    .where(eq(schema.driveFiles.file_id, fileId));
  return toD1(db, query).first<DriveFileRow>();
}

/** 配额只统计仍有效（未过期或已保留）的行；字段顺序与 raw 聚合一致。 */
export interface FileQuotaUsageRow {
  files: number;
  bytes: number;
  retained: number;
}

/** 上传者草稿配额占用。 */
export async function driveFileQuotaUsage(
  db: D1Like,
  ownerScope: string,
  at: number,
): Promise<FileQuotaUsageRow> {
  const query = orm(db)
    .select({
      files: sql<number>`count(*)`.as('files'),
      bytes: sql<number>`coalesce(sum(${schema.driveFiles.size}), 0)`.as('bytes'),
      retained: sql<number>`coalesce(sum(case when ${schema.driveFiles.retained} = 1 then ${schema.driveFiles.size} else 0 end), 0)`.as(
        'retained',
      ),
    })
    .from(schema.driveFiles)
    .where(
      and(
        eq(schema.driveFiles.owner_scope, ownerScope),
        eq(schema.driveFiles.state, 'draft'),
        or(
          eq(schema.driveFiles.retained, 1),
          isNull(schema.driveFiles.expires_at),
          gt(schema.driveFiles.expires_at, at),
        ),
      ),
    );
  const row = await toD1(db, query).first<FileQuotaUsageRow>();
  return row ?? { files: 0, bytes: 0, retained: 0 };
}

/** 房间附件配额占用。 */
export async function roomFileQuotaUsage(
  db: D1Like,
  roomId: string,
  at: number,
): Promise<FileQuotaUsageRow> {
  const query = orm(db)
    .select({
      files: sql<number>`count(*)`.as('files'),
      bytes: sql<number>`coalesce(sum(${schema.roomFiles.size}), 0)`.as('bytes'),
      retained: sql<number>`coalesce(sum(case when ${schema.roomFiles.retained} = 1 then ${schema.roomFiles.size} else 0 end), 0)`.as(
        'retained',
      ),
    })
    .from(schema.roomFiles)
    .where(
      and(
        eq(schema.roomFiles.room_id, roomId),
        isNull(schema.roomFiles.deleted_at),
        or(eq(schema.roomFiles.retained, 1), gt(schema.roomFiles.expires_at, at)),
      ),
    );
  const row = await toD1(db, query).first<FileQuotaUsageRow>();
  return row ?? { files: 0, bytes: 0, retained: 0 };
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
  return db
    .prepare('SELECT * FROM deliveries WHERE delivery_id = ?')
    .bind(deliveryId)
    .first<DeliveryRow>();
}

export async function getDeliveryForMessage(
  db: D1Like,
  recipientId: string,
  messageId: string,
): Promise<DeliveryRow | null> {
  return db
    .prepare('SELECT * FROM deliveries WHERE recipient_id = ? AND message_id = ?')
    .bind(recipientId, messageId)
    .first<DeliveryRow>();
}

export async function getClaimedDelivery(
  db: D1Like,
  recipientId: string,
): Promise<DeliveryRow | null> {
  return db
    .prepare("SELECT * FROM deliveries WHERE recipient_id = ? AND state = 'claimed' LIMIT 1")
    .bind(recipientId)
    .first<DeliveryRow>();
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

/** 按订阅 ID 读取完整订阅；缺失返回 null。 */
export async function getEventSubscription(
  db: D1Like,
  subscriptionId: string,
): Promise<EventSubscriptionRow | null> {
  const query = orm(db)
    .select()
    .from(schema.mcpEventSubscriptions)
    .where(eq(schema.mcpEventSubscriptions.subscription_id, subscriptionId));
  return toD1(db, query).first<EventSubscriptionRow>();
}

/** 扫描器按稳定 ID 分页读取活跃订阅；调用方负责截断探针行。 */
export async function listEventSubscriptionsForScan(
  db: D1Like,
  now: number,
  afterId: string,
  limit: number,
): Promise<EventSubscriptionRow[]> {
  const query = orm(db)
    .select()
    .from(schema.mcpEventSubscriptions)
    .where(
      and(
        eq(schema.mcpEventSubscriptions.active, 1),
        gt(schema.mcpEventSubscriptions.refresh_before, now),
        gt(schema.mcpEventSubscriptions.subscription_id, afterId),
      ),
    )
    .orderBy(asc(schema.mcpEventSubscriptions.subscription_id))
    .limit(limit);
  const result = await toD1(db, query).all<EventSubscriptionRow>();
  return result.results;
}

/** 投递前复核订阅所需字段；字段顺序与 raw 查询保持一致。 */
export interface EventSubscriptionRefreshRow {
  active: number;
  refresh_before: number;
  credential_id: string;
  secret_ciphertext: string;
  secret_nonce: string;
  previous_secret_ciphertext: string | null;
  previous_secret_nonce: string | null;
  previous_secret_expires_at: number | null;
}

/** 投递前复核订阅状态、密钥轮换与凭据。 */
export async function getEventSubscriptionRefresh(
  db: D1Like,
  subscriptionId: string,
): Promise<EventSubscriptionRefreshRow | null> {
  const query = orm(db)
    .select({
      active: schema.mcpEventSubscriptions.active,
      refresh_before: schema.mcpEventSubscriptions.refresh_before,
      credential_id: schema.mcpEventSubscriptions.credential_id,
      secret_ciphertext: schema.mcpEventSubscriptions.secret_ciphertext,
      secret_nonce: schema.mcpEventSubscriptions.secret_nonce,
      previous_secret_ciphertext: schema.mcpEventSubscriptions.previous_secret_ciphertext,
      previous_secret_nonce: schema.mcpEventSubscriptions.previous_secret_nonce,
      previous_secret_expires_at: schema.mcpEventSubscriptions.previous_secret_expires_at,
    })
    .from(schema.mcpEventSubscriptions)
    .where(eq(schema.mcpEventSubscriptions.subscription_id, subscriptionId));
  return toD1(db, query).first<EventSubscriptionRefreshRow>();
}

/** 订阅队列中待处理/处理中的投递数。 */
export async function countPendingEventDeliveries(
  db: D1Like,
  subscriptionId: string,
): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.mcpEventDeliveries)
    .where(
      and(
        eq(schema.mcpEventDeliveries.subscription_id, subscriptionId),
        inArray(schema.mcpEventDeliveries.status, ['pending', 'processing']),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 订阅队首的待处理/处理中事件序号；没有积压返回 null。 */
export async function earliestPendingEventDeliverySeq(
  db: D1Like,
  subscriptionId: string,
): Promise<number | null> {
  const query = orm(db)
    .select({ seq: sql<number | null>`min(${schema.mcpEventDeliveries.event_seq})`.as('seq') })
    .from(schema.mcpEventDeliveries)
    .where(
      and(
        eq(schema.mcpEventDeliveries.subscription_id, subscriptionId),
        inArray(schema.mcpEventDeliveries.status, ['pending', 'processing']),
      ),
    );
  const row = await toD1(db, query).first<{ seq: number | null }>();
  return row?.seq ?? null;
}
