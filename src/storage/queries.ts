import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';

import { orm, schema, toD1, type D1Queryable } from './drizzle';
import type {
  ActorRow,
  AgentManagementRow,
  ArtifactRow,
  ContactBlockRow,
  ContactRelationRow,
  ContactRequestRow,
  ContactRow,
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
 * 仍经 `toD1()` 回到现有 D1 shim 执行。消息、投递、文件等域仍保留手写 SQL，
 * 留给 4C-4/4C-5；guard/FTS/复杂权限 SQL 不进入 Drizzle。
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

/** 单侧个人收藏；不代表双向关系。 */
export async function getContact(
  db: D1Like,
  ownerActorId: string,
  targetActorId: string,
): Promise<ContactRow | null> {
  const query = orm(db)
    .select()
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.owner_actor_id, ownerActorId),
        eq(schema.contacts.target_actor_id, targetActorId),
      ),
    );
  return toD1(db, query).first<ContactRow>();
}

export async function getActiveContactRelation(
  db: D1Like,
  pairKey: string,
): Promise<ContactRelationRow | null> {
  const query = orm(db)
    .select()
    .from(schema.contactRelations)
    .where(
      and(
        eq(schema.contactRelations.pair_key, pairKey),
        eq(schema.contactRelations.status, 'active'),
      ),
    );
  return toD1(db, query).first<ContactRelationRow>();
}

export async function getContactRelation(
  db: D1Like,
  pairKey: string,
): Promise<ContactRelationRow | null> {
  const query = orm(db)
    .select()
    .from(schema.contactRelations)
    .where(eq(schema.contactRelations.pair_key, pairKey));
  return toD1(db, query).first<ContactRelationRow>();
}

export async function getPendingContactRequest(
  db: D1Like,
  pairKey: string,
): Promise<ContactRequestRow | null> {
  const query = orm(db)
    .select()
    .from(schema.contactRequests)
    .where(
      and(
        eq(schema.contactRequests.pair_key, pairKey),
        eq(schema.contactRequests.status, 'pending'),
      ),
    );
  return toD1(db, query).first<ContactRequestRow>();
}

export async function getContactRequestById(
  db: D1Like,
  contactRequestId: string,
): Promise<ContactRequestRow | null> {
  const query = orm(db)
    .select()
    .from(schema.contactRequests)
    .where(eq(schema.contactRequests.contact_request_id, contactRequestId));
  return toD1(db, query).first<ContactRequestRow>();
}

/** 同 pair 的过期 pending 申请；没有命中时返回 null。 */
export async function getExpiredPendingContactRequestForPair(
  db: D1Like,
  pairKey: string,
  at: number,
): Promise<ContactRequestRow | null> {
  const query = orm(db)
    .select()
    .from(schema.contactRequests)
    .where(
      and(
        eq(schema.contactRequests.pair_key, pairKey),
        eq(schema.contactRequests.status, 'pending'),
        lte(schema.contactRequests.expires_at, at),
      ),
    );
  return toD1(db, query).first<ContactRequestRow>();
}

/** 拉黑时取消同 pair 的全部 pending 申请。 */
export async function listPendingContactRequests(
  db: D1Like,
  pairKey: string,
): Promise<ContactRequestRow[]> {
  const query = orm(db)
    .select()
    .from(schema.contactRequests)
    .where(
      and(
        eq(schema.contactRequests.pair_key, pairKey),
        eq(schema.contactRequests.status, 'pending'),
      ),
    );
  const result = await toD1(db, query).all<ContactRequestRow>();
  return result.results;
}

/** 过期扫描：按到期时间与 id 稳定分页，结果交给逐行事务处理。 */
export async function listExpiredPendingContactRequests(
  db: D1Like,
  at: number,
  limit: number,
): Promise<ContactRequestRow[]> {
  const query = orm(db)
    .select()
    .from(schema.contactRequests)
    .where(
      and(
        eq(schema.contactRequests.status, 'pending'),
        lte(schema.contactRequests.expires_at, at),
      ),
    )
    .orderBy(asc(schema.contactRequests.expires_at), asc(schema.contactRequests.contact_request_id))
    .limit(limit);
  const result = await toD1(db, query).all<ContactRequestRow>();
  return result.results;
}

export async function getActiveContactBlock(
  db: D1Like,
  blockerActorId: string,
  blockedActorId: string,
): Promise<ContactBlockRow | null> {
  const query = orm(db)
    .select()
    .from(schema.contactBlocks)
    .where(
      and(
        eq(schema.contactBlocks.blocker_actor_id, blockerActorId),
        eq(schema.contactBlocks.blocked_actor_id, blockedActorId),
        isNull(schema.contactBlocks.released_at),
      ),
    );
  return toD1(db, query).first<ContactBlockRow>();
}

/** 任一方向的 active 拉黑；命中顺序与既有索引扫描一致。 */
export async function findActiveContactBlockBetween(
  db: D1Like,
  actorA: string,
  actorB: string,
): Promise<ContactBlockRow | null> {
  const query = orm(db)
    .select()
    .from(schema.contactBlocks)
    .where(
      and(
        isNull(schema.contactBlocks.released_at),
        or(
          and(
            eq(schema.contactBlocks.blocker_actor_id, actorA),
            eq(schema.contactBlocks.blocked_actor_id, actorB),
          ),
          and(
            eq(schema.contactBlocks.blocker_actor_id, actorB),
            eq(schema.contactBlocks.blocked_actor_id, actorA),
          ),
        ),
      ),
    )
    .limit(1);
  return toD1(db, query).first<ContactBlockRow>();
}

/** 群内定向 @ 静默：只返回拉黑发送者且 mute_mentions=1 的目标。 */
export async function listMutedMentionBlockers(
  db: D1Like,
  senderActorId: string,
  targetActorIds: string[],
): Promise<string[]> {
  if (targetActorIds.length === 0) return [];
  const query = orm(db)
    .select({ blocker_actor_id: schema.contactBlocks.blocker_actor_id })
    .from(schema.contactBlocks)
    .where(
      and(
        isNull(schema.contactBlocks.released_at),
        eq(schema.contactBlocks.mute_mentions, 1),
        eq(schema.contactBlocks.blocked_actor_id, senderActorId),
        inArray(schema.contactBlocks.blocker_actor_id, targetActorIds),
      ),
    );
  const result = await toD1(db, query).all<{ blocker_actor_id: string }>();
  return result.results.map((row) => row.blocker_actor_id);
}

export interface ContactBlockJoinRow extends ContactBlockRow {
  blocked_kind: 'human' | 'agent';
  blocked_name: string;
  blocked_session: string | null;
}

/** 拉黑列表：按 (created_at DESC, block_id ASC) 的复合 keyset。 */
export async function listContactBlocks(
  db: D1Like,
  blockerActorId: string,
  limit: number,
  cursor: { createdAt: number; blockId: string } | null,
): Promise<ContactBlockJoinRow[]> {
  const where = cursor
    ? and(
        eq(schema.contactBlocks.blocker_actor_id, blockerActorId),
        or(
          lt(schema.contactBlocks.created_at, cursor.createdAt),
          and(
            eq(schema.contactBlocks.created_at, cursor.createdAt),
            gt(schema.contactBlocks.block_id, cursor.blockId),
          ),
        ),
      )
    : eq(schema.contactBlocks.blocker_actor_id, blockerActorId);
  const query = orm(db)
    .select({
      block_id: schema.contactBlocks.block_id,
      blocker_actor_id: schema.contactBlocks.blocker_actor_id,
      blocked_actor_id: schema.contactBlocks.blocked_actor_id,
      reason: schema.contactBlocks.reason,
      mute_mentions: schema.contactBlocks.mute_mentions,
      created_at: schema.contactBlocks.created_at,
      released_at: schema.contactBlocks.released_at,
      released_by: schema.contactBlocks.released_by,
      blocked_kind: sql<'human' | 'agent'>`${schema.actors.kind}`.as('blocked_kind'),
      blocked_name: sql<string>`${schema.actors.name}`.as('blocked_name'),
      blocked_session: sql<string | null>`${schema.actors.agent_session_id}`.as(
        'blocked_session',
      ),
    })
    .from(schema.contactBlocks)
    .innerJoin(
      schema.actors,
      eq(schema.actors.actor_id, schema.contactBlocks.blocked_actor_id),
    )
    .where(where)
    .orderBy(desc(schema.contactBlocks.created_at), asc(schema.contactBlocks.block_id))
    .limit(limit);
  const result = await toD1(db, query).all<ContactBlockJoinRow>();
  return result.results;
}

export async function getActiveAgentManagement(
  db: D1Like,
  agentId: string,
): Promise<AgentManagementRow | null> {
  const query = orm(db)
    .select()
    .from(schema.agentManagements)
    .where(
      and(
        eq(schema.agentManagements.agent_id, agentId),
        eq(schema.agentManagements.status, 'active'),
      ),
    );
  return toD1(db, query).first<AgentManagementRow>();
}

export interface AgentManagementBindingRow {
  agent_id: string;
  manager_id: string;
}

/** 批量读取 active 管理权；只用于判定调用者本人是否为 manager。 */
export async function listActiveManagementBindings(
  db: D1Like,
  agentIds: string[],
): Promise<AgentManagementBindingRow[]> {
  if (agentIds.length === 0) return [];
  const query = orm(db)
    .select({
      agent_id: schema.agentManagements.agent_id,
      manager_id: schema.agentManagements.manager_id,
    })
    .from(schema.agentManagements)
    .where(
      and(
        eq(schema.agentManagements.status, 'active'),
        inArray(schema.agentManagements.agent_id, agentIds),
      ),
    );
  const result = await toD1(db, query).all<AgentManagementBindingRow>();
  return result.results;
}

export async function countActiveCredentials(db: D1Like, actorId: string): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.actor_id, actorId),
        isNull(schema.credentials.revoked_at),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
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
