import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { orm, schema, toD1, type D1Queryable } from './drizzle';
import type {
  MemoryCatchupItemRow,
  MemoryCatchupPlanRow,
  MemoryContextRow,
  MemoryExperienceRow,
  MemoryHostBindingRow,
  MemoryManifestItemRow,
  MemoryManifestRow,
  MemoryRecallRequestRow,
  MemoryReceiptRow,
  MemoryRepresentationDependencyRow,
  MemoryRepresentationRow,
  MemorySelectionRow,
  MemorySourceRow,
  MemorySpaceRow,
} from '../memory/rows';
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
  EventSubscriptionRow,
  FileReferenceRow,
  MessageRow,
  RoomFileRow,
  RoomInvitationRow,
  RoomJoinRequestRow,
  RoomManagementAuditRow,
  RoomMemberRow,
  RoomOwnerTransferRow,
  RoomRow,
} from './rows';

export interface D1Like extends D1Queryable {
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/**
 * 4C-1/4C-3/4C-4/4C-5/4C-6 核心只读查询：actors / credentials / rooms / room_members 以及
 * rooms 域的邀请、入群申请、群主转让与管理审计由 Drizzle 构建 SQL，仍经
 * `toD1()` 回到现有 D1 shim 执行。4C-4 追加 messages / deliveries 的只读查询：
 * 单条读取、历史分页、时间线物化、消息上下文、收件箱投递列表与状态聚合、
 * 提及批量读取；4C-5 追加 files/events 的简单单表读取；4C-6 追加 memory
 * 单表读取。以下内容继续保留 raw：FTS5 `MATCH` 与 `instr` 片段搜索、
 * `messages.task_root_id` 任务查询、`EXISTS`/`CASE` 权限与闸门 SQL、timeline
 * 的 `UNION ALL`，以及全部写路径；复杂 JOIN、历史边界、guard 与状态机 SQL
 * 继续保留手写。
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

/** 只按已知 actor_id 批量读取完整 actor 行；成员校验等场景需要完整字段。 */
export async function getActorRowsByIds(db: D1Like, actorIds: string[]): Promise<ActorRow[]> {
  if (actorIds.length === 0) return [];
  const query = orm(db)
    .select()
    .from(schema.actors)
    .where(inArray(schema.actors.actor_id, actorIds));
  const result = await toD1(db, query).all<ActorRow>();
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

/* ------------------------------------------------------------------ rooms 域只读 */

/** 房间有效成员数；`room_get` 与邀请容量检查共用。 */
export async function countActiveRoomMembers(db: D1Like, roomId: string): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.room_id, roomId),
        eq(schema.roomMembers.status, 'active'),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 历史策略收紧时受影响的成员数：active 且 joined_seq > 0。 */
export async function countActiveRoomMembersWithJoinHistory(
  db: D1Like,
  roomId: string,
): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.room_id, roomId),
        eq(schema.roomMembers.status, 'active'),
        gt(schema.roomMembers.joined_seq, 0),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
}

/** active owner/admin 成员；入群申请通知的接收者。原查询无 ORDER BY。 */
export async function listActiveRoomManagerIds(
  db: D1Like,
  roomId: string,
): Promise<string[]> {
  const query = orm(db)
    .select({ actor_id: schema.roomMembers.actor_id })
    .from(schema.roomMembers)
    .where(
      and(
        eq(schema.roomMembers.room_id, roomId),
        eq(schema.roomMembers.status, 'active'),
        inArray(schema.roomMembers.role, ['owner', 'admin']),
      ),
    );
  const result = await toD1(db, query).all<{ actor_id: string }>();
  return result.results.map((row) => row.actor_id);
}

export interface PendingDirectInvitationMemberRow {
  invitation_id: string;
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  invited_by: string;
  created_at: number;
  expires_at: number;
}

/**
 * 群主/管理员可见的待确认定向邀请成员。
 *
 * 只读 pending 且未过期；group 成员面板隐藏已归档 Agent，与
 * `visibleActorSql('a')` 等价（`kind <> 'agent' OR archived_at IS NULL`）。
 * 顺序保持 `created_at ASC, invitation_id ASC`。
 */
export async function listPendingDirectInvitationMembers(
  db: D1Like,
  roomId: string,
  at: number,
): Promise<PendingDirectInvitationMemberRow[]> {
  const query = orm(db)
    .select({
      invitation_id: schema.roomInvitations.invitation_id,
      actor_id: sql<string>`${schema.roomInvitations.target_actor_id}`.as('actor_id'),
      kind: schema.actors.kind,
      name: schema.actors.name,
      invited_by: sql<string>`${schema.roomInvitations.inviter_id}`.as('invited_by'),
      created_at: schema.roomInvitations.created_at,
      expires_at: schema.roomInvitations.expires_at,
    })
    .from(schema.roomInvitations)
    .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.roomInvitations.target_actor_id))
    .where(
      and(
        eq(schema.roomInvitations.room_id, roomId),
        eq(schema.roomInvitations.kind, 'direct'),
        eq(schema.roomInvitations.status, 'pending'),
        gt(schema.roomInvitations.expires_at, at),
        or(ne(schema.actors.kind, 'agent'), isNull(schema.actors.archived_at)),
      ),
    )
    .orderBy(asc(schema.roomInvitations.created_at), asc(schema.roomInvitations.invitation_id));
  const result = await toD1(db, query).all<PendingDirectInvitationMemberRow>();
  return result.results;
}

export async function getRoomInvitationById(
  db: D1Like,
  invitationId: string,
): Promise<RoomInvitationRow | null> {
  const query = orm(db)
    .select()
    .from(schema.roomInvitations)
    .where(eq(schema.roomInvitations.invitation_id, invitationId));
  return toD1(db, query).first<RoomInvitationRow>();
}

export async function getRoomJoinRequestById(
  db: D1Like,
  joinRequestId: string,
): Promise<RoomJoinRequestRow | null> {
  const query = orm(db)
    .select()
    .from(schema.roomJoinRequests)
    .where(eq(schema.roomJoinRequests.join_request_id, joinRequestId));
  return toD1(db, query).first<RoomJoinRequestRow>();
}

/** 同一邀请对同一申请人的最新申请；重复打开链接时用于收敛状态。 */
export async function getLatestJoinRequestForApplicant(
  db: D1Like,
  invitationId: string,
  applicantId: string,
): Promise<RoomJoinRequestRow | null> {
  const query = orm(db)
    .select()
    .from(schema.roomJoinRequests)
    .where(
      and(
        eq(schema.roomJoinRequests.invitation_id, invitationId),
        eq(schema.roomJoinRequests.applicant_id, applicantId),
      ),
    )
    .orderBy(
      desc(schema.roomJoinRequests.created_at),
      desc(schema.roomJoinRequests.join_request_id),
    )
    .limit(1);
  return toD1(db, query).first<RoomJoinRequestRow>();
}

export async function getOwnerTransferById(
  db: D1Like,
  transferId: string,
): Promise<RoomOwnerTransferRow | null> {
  const query = orm(db)
    .select()
    .from(schema.roomOwnerTransfers)
    .where(eq(schema.roomOwnerTransfers.transfer_id, transferId));
  return toD1(db, query).first<RoomOwnerTransferRow>();
}

export interface JoinRequestListRow extends RoomJoinRequestRow {
  invitation_kind: 'direct' | 'link';
  invitation_status: RoomInvitationRow['status'];
  invitation_expires_at: number;
  invitation_max_uses: number;
  invitation_used_count: number;
  applicant_kind: 'human' | 'agent';
  applicant_name: string;
  applicant_session_id: string | null;
}

/**
 * 入群申请分页行（调用方传 `limit + 1` 判断 has_more）。
 *
 * keyset 与 `roomJoinRequestList` 完全一致：`created_at DESC,
 * join_request_id DESC`。
 */
export async function listJoinRequestRows(
  db: D1Like,
  roomId: string,
  status: RoomJoinRequestRow['status'],
  cursor: { seq: number; key: string } | null,
  limit: number,
): Promise<JoinRequestListRow[]> {
  const conditions: SQL[] = [
    eq(schema.roomJoinRequests.room_id, roomId),
    eq(schema.roomJoinRequests.status, status),
  ];
  if (cursor) {
    conditions.push(
      or(
        lt(schema.roomJoinRequests.created_at, cursor.seq),
        and(
          eq(schema.roomJoinRequests.created_at, cursor.seq),
          lt(schema.roomJoinRequests.join_request_id, cursor.key),
        ),
      )!,
    );
  }
  const query = orm(db)
    .select({
      ...getTableColumns(schema.roomJoinRequests),
      invitation_kind: sql<'direct' | 'link'>`${schema.roomInvitations.kind}`.as('invitation_kind'),
      invitation_status: sql<RoomInvitationRow['status']>`${schema.roomInvitations.status}`.as(
        'invitation_status',
      ),
      invitation_expires_at: sql<number>`${schema.roomInvitations.expires_at}`.as(
        'invitation_expires_at',
      ),
      invitation_max_uses: sql<number>`${schema.roomInvitations.max_uses}`.as(
        'invitation_max_uses',
      ),
      invitation_used_count: sql<number>`${schema.roomInvitations.used_count}`.as(
        'invitation_used_count',
      ),
      applicant_kind: sql<'human' | 'agent'>`${schema.actors.kind}`.as('applicant_kind'),
      applicant_name: sql<string>`${schema.actors.name}`.as('applicant_name'),
      applicant_session_id: sql<string | null>`${schema.actors.agent_session_id}`.as(
        'applicant_session_id',
      ),
    })
    .from(schema.roomJoinRequests)
    .innerJoin(
      schema.roomInvitations,
      eq(schema.roomInvitations.invitation_id, schema.roomJoinRequests.invitation_id),
    )
    .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.roomJoinRequests.applicant_id))
    .where(and(...conditions))
    .orderBy(
      desc(schema.roomJoinRequests.created_at),
      desc(schema.roomJoinRequests.join_request_id),
    )
    .limit(limit);
  const result = await toD1(db, query).all<JoinRequestListRow>();
  return result.results;
}

export interface RoomAuditListRow extends RoomManagementAuditRow {
  target_name: string | null;
  changed_by_name: string | null;
}

/**
 * 角色/成员管理审计分页行（调用方传 `limit + 1` 判断 has_more）。
 *
 * keyset 与 `roomRoleHistory` 完全一致：`created_at DESC, audit_id DESC`；
 * target/changer 名称来自 LEFT JOIN，目标缺失时保持 NULL。
 */
export async function listRoomAuditRows(
  db: D1Like,
  roomId: string,
  cursor: { seq: number; key: string } | null,
  limit: number,
): Promise<RoomAuditListRow[]> {
  const target = alias(schema.actors, 'target');
  const changer = alias(schema.actors, 'changer');
  const conditions: SQL[] = [eq(schema.roomManagementAudit.room_id, roomId)];
  if (cursor) {
    conditions.push(
      or(
        lt(schema.roomManagementAudit.created_at, cursor.seq),
        and(
          eq(schema.roomManagementAudit.created_at, cursor.seq),
          lt(schema.roomManagementAudit.audit_id, cursor.key),
        ),
      )!,
    );
  }
  const query = orm(db)
    .select({
      ...getTableColumns(schema.roomManagementAudit),
      target_name: sql<string | null>`${target.name}`.as('target_name'),
      changed_by_name: sql<string | null>`${changer.name}`.as('changed_by_name'),
    })
    .from(schema.roomManagementAudit)
    .leftJoin(target, eq(target.actor_id, schema.roomManagementAudit.target_actor_id))
    .leftJoin(changer, eq(changer.actor_id, schema.roomManagementAudit.changed_by))
    .where(and(...conditions))
    .orderBy(
      desc(schema.roomManagementAudit.created_at),
      desc(schema.roomManagementAudit.audit_id),
    )
    .limit(limit);
  const result = await toD1(db, query).all<RoomAuditListRow>();
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
// ---------------------------------------------------------------------------
// 4C-6 Memory 只读查询
//
// 只迁移单表、等值/排序/分页语义明确的 SELECT；作业/租约、治理命令流、
// 复杂聚合（proof rank）、依赖递归与 `INSERT ... SELECT` 写路径继续 raw。
// 返回行类型由 schema 推导，列顺序与迁移 SQL 的物理列顺序一致。
// ---------------------------------------------------------------------------

type MemoryInstanceLookup = {
  instance_id: string;
  capture_default: 'enabled' | 'disabled';
};
type MemorySourceRecord = MemorySourceRow;
type MemoryRepresentationRecord = MemoryRepresentationRow;
type MemoryExperienceRecord = MemoryExperienceRow;
type MemoryContextRecord = MemoryContextRow;
type MemoryManifestRecord = MemoryManifestRow;
type MemorySelectionRecord = MemorySelectionRow;
type MemoryReceiptRecord = MemoryReceiptRow;
type MemoryHostBindingRecord = MemoryHostBindingRow;
type MemoryCatchupPlanRecord = MemoryCatchupPlanRow;
type MemoryCatchupItemRecord = MemoryCatchupItemRow;
type MemoryRecallRequestRecord = MemoryRecallRequestRow;

export type MemoryTombstoneTargetKind =
  (typeof schema.memoryTombstones.target_kind.enumValues)[number];

/** 部署稳定 instance；`memory_instances` 至多一行。 */
export async function getMemoryInstance(
  db: D1Like,
): Promise<MemoryInstanceLookup | null> {
  const query = orm(db)
    .select({
      instance_id: schema.memoryInstances.instance_id,
      capture_default: schema.memoryInstances.capture_default,
    })
    .from(schema.memoryInstances)
    .limit(1);
  return toD1(db, query).first<MemoryInstanceLookup>();
}

export async function getActiveMemorySpace(
  db: D1Like,
  agentId: string,
): Promise<MemorySpaceRow | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySpaces)
    .where(
      and(
        eq(schema.memorySpaces.agent_actor_id, agentId),
        eq(schema.memorySpaces.active, 1),
      ),
    );
  return toD1(db, query).first<MemorySpaceRow>();
}

export async function memorySpaceExists(db: D1Like, spaceId: string): Promise<boolean> {
  const query = orm(db)
    .select({ space_id: schema.memorySpaces.space_id })
    .from(schema.memorySpaces)
    .where(eq(schema.memorySpaces.space_id, spaceId))
    .limit(1);
  return (await toD1(db, query).first<{ space_id: string }>()) !== null;
}

export async function getMemorySpaceById(
  db: D1Like,
  spaceId: string,
): Promise<MemorySpaceRow | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySpaces)
    .where(eq(schema.memorySpaces.space_id, spaceId));
  return toD1(db, query).first<MemorySpaceRow>();
}

export async function isMemoryTombstonedBySourceKey(
  db: D1Like,
  sourceKey: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ tombstone_id: schema.memoryTombstones.tombstone_id })
    .from(schema.memoryTombstones)
    .where(
      and(
        eq(schema.memoryTombstones.source_key, sourceKey),
        inArray(schema.memoryTombstones.target_kind, ['source_key', 'source']),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ tombstone_id: string }>()) !== null;
}

export async function isMemoryTargetTombstoned(
  db: D1Like,
  kind: MemoryTombstoneTargetKind,
  targetId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ tombstone_id: schema.memoryTombstones.tombstone_id })
    .from(schema.memoryTombstones)
    .where(
      and(
        eq(schema.memoryTombstones.target_kind, kind),
        eq(schema.memoryTombstones.target_id, targetId),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ tombstone_id: string }>()) !== null;
}

export async function getMemorySourceRevision(
  db: D1Like,
  sourceId: string,
  revision: number,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(
      and(
        eq(schema.memorySources.source_id, sourceId),
        eq(schema.memorySources.revision, revision),
      ),
    );
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getLatestMemorySource(
  db: D1Like,
  sourceId: string,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(eq(schema.memorySources.source_id, sourceId))
    .orderBy(desc(schema.memorySources.revision))
    .limit(1);
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getActiveMemorySourceByKey(
  db: D1Like,
  instanceId: string,
  sourceKey: string,
): Promise<MemorySourceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySources)
    .where(
      and(
        eq(schema.memorySources.instance_id, instanceId),
        eq(schema.memorySources.source_key, sourceKey),
        eq(schema.memorySources.state, 'active'),
      ),
    )
    .limit(1);
  return toD1(db, query).first<MemorySourceRecord>();
}

export async function getMemoryRepresentation(
  db: D1Like,
  representationId: string,
): Promise<MemoryRepresentationRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRepresentations)
    .where(eq(schema.memoryRepresentations.representation_id, representationId));
  return toD1(db, query).first<MemoryRepresentationRecord>();
}

export async function getMemoryRepresentationSourceId(
  db: D1Like,
  representationId: string,
): Promise<{ source_id: string | null } | null> {
  const query = orm(db)
    .select({ source_id: schema.memoryRepresentations.source_id })
    .from(schema.memoryRepresentations)
    .where(eq(schema.memoryRepresentations.representation_id, representationId));
  return toD1(db, query).first<{ source_id: string | null }>();
}

export async function listMemoryRepresentationDependencyLinks(
  db: D1Like,
  representationId: string,
): Promise<{ source_id: string; depends_on_representation_id: string | null }[]> {
  const query = orm(db)
    .select({
      source_id: schema.memoryRepresentationDependencies.source_id,
      depends_on_representation_id:
        schema.memoryRepresentationDependencies.depends_on_representation_id,
    })
    .from(schema.memoryRepresentationDependencies)
    .where(
      eq(
        schema.memoryRepresentationDependencies.representation_id,
        representationId,
      ),
    );
  const result = await toD1(db, query).all<{
    source_id: string;
    depends_on_representation_id: string | null;
  }>();
  return result.results;
}

export async function listMemoryRepresentationDependencies(
  db: D1Like,
  representationId: string,
): Promise<MemoryRepresentationDependencyRow[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryRepresentationDependencies)
    .where(
      eq(
        schema.memoryRepresentationDependencies.representation_id,
        representationId,
      ),
    )
    .orderBy(schema.memoryRepresentationDependencies.dependency_index);
  const result = await toD1(db, query).all<MemoryRepresentationDependencyRow>();
  return result.results;
}

export async function getMemoryExperience(
  db: D1Like,
  experienceId: string,
): Promise<MemoryExperienceRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryExperiences)
    .where(eq(schema.memoryExperiences.experience_id, experienceId));
  return toD1(db, query).first<MemoryExperienceRecord>();
}

export async function getMemoryExperienceByDedupe(
  db: D1Like,
  dedupeKey: string,
): Promise<{ experience_id: string } | null> {
  const query = orm(db)
    .select({ experience_id: schema.memoryExperiences.experience_id })
    .from(schema.memoryExperiences)
    .where(eq(schema.memoryExperiences.dedupe_key, dedupeKey));
  return toD1(db, query).first<{ experience_id: string }>();
}

export async function getMemoryContext(
  db: D1Like,
  contextId: string,
): Promise<MemoryContextRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryContexts)
    .where(eq(schema.memoryContexts.context_id, contextId));
  return toD1(db, query).first<MemoryContextRecord>();
}

export async function listMemoryContextItems(
  db: D1Like,
  contextId: string,
): Promise<{ representation_id: string; evidence: string | null; origin_scope_json: string }[]> {
  const query = orm(db)
    .select({
      representation_id: schema.memoryContextItems.representation_id,
      evidence: schema.memoryContextItems.evidence,
      origin_scope_json: schema.memoryContextItems.origin_scope_json,
    })
    .from(schema.memoryContextItems)
    .where(eq(schema.memoryContextItems.context_id, contextId))
    .orderBy(schema.memoryContextItems.item_index);
  const result = await toD1(db, query).all<{
    representation_id: string;
    evidence: string | null;
    origin_scope_json: string;
  }>();
  return result.results;
}

export interface MemoryContextPageQuery {
  spaceId: string;
  ownershipEpoch: number;
  agentId: string;
  kind?: 'lookup' | 'bound' | null;
  cursor?: { seq: number; key: string } | null;
  limit: number;
}

export interface MemoryContextSummaryRow {
  context_id: string;
  recall_id: string | null;
  kind: 'lookup' | 'bound';
  body_sha256: string;
  body_bytes: number;
  status: 'ready' | 'invalidated' | 'expired' | 'purged';
  created_at: number;
  expires_at: number | null;
}

export async function listMemoryContextSummaries(
  db: D1Like,
  input: MemoryContextPageQuery,
): Promise<MemoryContextSummaryRow[]> {
  const conditions = [
    eq(schema.memoryContexts.space_id, input.spaceId),
    eq(schema.memoryContexts.ownership_epoch, input.ownershipEpoch),
    eq(schema.memoryContexts.agent_actor_id, input.agentId),
  ];
  if (input.kind) conditions.push(eq(schema.memoryContexts.kind, input.kind));
  if (input.cursor) {
    conditions.push(
      or(
        lt(schema.memoryContexts.created_at, input.cursor.seq),
        and(
          eq(schema.memoryContexts.created_at, input.cursor.seq),
          lt(schema.memoryContexts.context_id, input.cursor.key),
        ),
      )!,
    );
  }
  const query = orm(db)
    .select({
      context_id: schema.memoryContexts.context_id,
      recall_id: schema.memoryContexts.recall_id,
      kind: schema.memoryContexts.kind,
      body_sha256: schema.memoryContexts.body_sha256,
      body_bytes: schema.memoryContexts.body_bytes,
      status: schema.memoryContexts.status,
      created_at: schema.memoryContexts.created_at,
      expires_at: schema.memoryContexts.expires_at,
    })
    .from(schema.memoryContexts)
    .where(and(...conditions))
    .orderBy(desc(schema.memoryContexts.created_at), desc(schema.memoryContexts.context_id))
    .limit(input.limit);
  const result = await toD1(db, query).all<MemoryContextSummaryRow>();
  return result.results;
}

export async function getMemoryManifest(
  db: D1Like,
  manifestId: string,
): Promise<MemoryManifestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifests)
    .where(eq(schema.memoryManifests.manifest_id, manifestId));
  return toD1(db, query).first<MemoryManifestRecord>();
}

export async function getMemoryManifestByInvocation(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    hostBindingId: string;
    invocationId: string;
  },
): Promise<MemoryManifestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifests)
    .where(
      and(
        eq(schema.memoryManifests.space_id, input.spaceId),
        eq(schema.memoryManifests.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryManifests.agent_actor_id, input.agentId),
        eq(schema.memoryManifests.host_binding_id, input.hostBindingId),
        eq(schema.memoryManifests.invocation_id, input.invocationId),
      ),
    );
  return toD1(db, query).first<MemoryManifestRecord>();
}

export async function listMemoryManifestItems(
  db: D1Like,
  manifestId: string,
): Promise<MemoryManifestItemRow[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryManifestItems)
    .where(eq(schema.memoryManifestItems.manifest_id, manifestId))
    .orderBy(schema.memoryManifestItems.item_index);
  const result = await toD1(db, query).all<MemoryManifestItemRow>();
  return result.results;
}

export async function getMemorySelection(
  db: D1Like,
  selectionId: string,
): Promise<MemorySelectionRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memorySelections)
    .where(eq(schema.memorySelections.selection_id, selectionId));
  return toD1(db, query).first<MemorySelectionRecord>();
}

export async function getMemoryReceiptByIdempotencyKey(
  db: D1Like,
  idempotencyKey: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(eq(schema.memoryReceipts.idempotency_key, idempotencyKey));
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function getMemoryReceipt(
  db: D1Like,
  receiptId: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(eq(schema.memoryReceipts.receipt_id, receiptId));
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function getMemoryReceiptByInvocation(
  db: D1Like,
  input: {
    kind: 'input_exposure' | 'context_delivery';
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    hostBindingId: string;
    invocationId: string;
  },
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, input.kind),
        eq(schema.memoryReceipts.space_id, input.spaceId),
        eq(schema.memoryReceipts.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryReceipts.agent_actor_id, input.agentId),
        eq(schema.memoryReceipts.host_binding_id, input.hostBindingId),
        eq(schema.memoryReceipts.invocation_id, input.invocationId),
      ),
    );
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function hasMemoryReceiptForManifest(
  db: D1Like,
  manifestId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ receipt_id: schema.memoryReceipts.receipt_id })
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, 'input_exposure'),
        eq(schema.memoryReceipts.manifest_id, manifestId),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ receipt_id: string }>()) !== null;
}

export async function getLatestMemoryReceiptForManifest(
  db: D1Like,
  manifestId: string,
): Promise<MemoryReceiptRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryReceipts)
    .where(
      and(
        eq(schema.memoryReceipts.kind, 'input_exposure'),
        eq(schema.memoryReceipts.manifest_id, manifestId),
      ),
    )
    .orderBy(desc(schema.memoryReceipts.recorded_at))
    .limit(1);
  return toD1(db, query).first<MemoryReceiptRecord>();
}

export async function hasMemoryGatewayProof(
  db: D1Like,
  manifestId: string,
): Promise<boolean> {
  const query = orm(db)
    .select({ proof_id: schema.memoryExperienceProofs.proof_id })
    .from(schema.memoryExperienceProofs)
    .where(
      and(
        eq(schema.memoryExperienceProofs.manifest_id, manifestId),
        eq(schema.memoryExperienceProofs.evidence, 'gateway_observed_submitted'),
      ),
    )
    .limit(1);
  return (await toD1(db, query).first<{ proof_id: string }>()) !== null;
}

export async function getMemoryHostBinding(
  db: D1Like,
  bindingId: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(eq(schema.memoryHostBindings.binding_id, bindingId));
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function getActiveMemoryHostBindingBySession(
  db: D1Like,
  spaceId: string,
  sessionIncarnation: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.session_incarnation, sessionIncarnation),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function getLatestActiveMemoryHostBinding(
  db: D1Like,
  spaceId: string,
  agentId: string,
): Promise<MemoryHostBindingRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.agent_actor_id, agentId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    )
    .orderBy(desc(schema.memoryHostBindings.created_at))
    .limit(1);
  return toD1(db, query).first<MemoryHostBindingRecord>();
}

export async function listActiveMemoryHostBindingIds(
  db: D1Like,
  agentId: string,
): Promise<{ binding_id: string }[]> {
  const query = orm(db)
    .select({ binding_id: schema.memoryHostBindings.binding_id })
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.agent_actor_id, agentId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  const result = await toD1(db, query).all<{ binding_id: string }>();
  return result.results;
}

export async function countActiveMemoryHostBindings(
  db: D1Like,
  spaceId: string,
): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.memoryHostBindings)
    .where(
      and(
        eq(schema.memoryHostBindings.space_id, spaceId),
        eq(schema.memoryHostBindings.state, 'active'),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function getCurrentCuratedRevision(
  db: D1Like,
  curatedId: string,
): Promise<{ revision: number } | null> {
  const query = orm(db)
    .select({ revision: schema.memoryCurated.revision })
    .from(schema.memoryCurated)
    .where(
      and(
        eq(schema.memoryCurated.curated_id, curatedId),
        eq(schema.memoryCurated.current, 1),
      ),
    );
  return toD1(db, query).first<{ revision: number }>();
}

export interface MemoryCuratedListRow {
  curated_id: string;
  revision: number;
  title: string;
  content: string;
  content_sha256: string;
  origin: 'manual' | 'imported_external_knowledge';
  created_at: number;
  updated_at: number;
}

export async function listCurrentCuratedMemories(
  db: D1Like,
  spaceId: string,
  ownershipEpoch: number,
  limit?: number,
): Promise<MemoryCuratedListRow[]> {
  const base = orm(db)
    .select({
      curated_id: schema.memoryCurated.curated_id,
      revision: schema.memoryCurated.revision,
      title: schema.memoryCurated.title,
      content: schema.memoryCurated.content,
      content_sha256: schema.memoryCurated.content_sha256,
      origin: schema.memoryCurated.origin,
      created_at: schema.memoryCurated.created_at,
      updated_at: schema.memoryCurated.updated_at,
    })
    .from(schema.memoryCurated)
    .where(
      and(
        eq(schema.memoryCurated.space_id, spaceId),
        eq(schema.memoryCurated.ownership_epoch, ownershipEpoch),
        eq(schema.memoryCurated.current, 1),
      ),
    );
  const query =
    limit === undefined
      ? base.orderBy(desc(schema.memoryCurated.updated_at))
      : base
          .orderBy(desc(schema.memoryCurated.updated_at), schema.memoryCurated.curated_id)
          .limit(limit);
  const result = await toD1(db, query).all<MemoryCuratedListRow>();
  return result.results;
}

export async function getMemoryCatchupPlan(
  db: D1Like,
  planId: string,
): Promise<MemoryCatchupPlanRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupPlans)
    .where(eq(schema.memoryCatchupPlans.plan_id, planId));
  return toD1(db, query).first<MemoryCatchupPlanRecord>();
}

export async function getMemoryCatchupPlanByRequestKey(
  db: D1Like,
  spaceId: string,
  agentId: string,
  requestKey: string,
): Promise<MemoryCatchupPlanRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupPlans)
    .where(
      and(
        eq(schema.memoryCatchupPlans.space_id, spaceId),
        eq(schema.memoryCatchupPlans.agent_actor_id, agentId),
        eq(schema.memoryCatchupPlans.request_key, requestKey),
      ),
    );
  return toD1(db, query).first<MemoryCatchupPlanRecord>();
}

export async function listMemoryCatchupItems(
  db: D1Like,
  planId: string,
): Promise<MemoryCatchupItemRecord[]> {
  const query = orm(db)
    .select()
    .from(schema.memoryCatchupItems)
    .where(eq(schema.memoryCatchupItems.plan_id, planId))
    .orderBy(schema.memoryCatchupItems.item_index);
  const result = await toD1(db, query).all<MemoryCatchupItemRecord>();
  return result.results;
}

export async function getMemoryRecallRequest(
  db: D1Like,
  recallId: string,
): Promise<MemoryRecallRequestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRecallRequests)
    .where(eq(schema.memoryRecallRequests.recall_id, recallId));
  return toD1(db, query).first<MemoryRecallRequestRecord>();
}

export async function getMemoryRecallRequestByKey(
  db: D1Like,
  spaceId: string,
  requestKey: string,
): Promise<MemoryRecallRequestRecord | null> {
  const query = orm(db)
    .select()
    .from(schema.memoryRecallRequests)
    .where(
      and(
        eq(schema.memoryRecallRequests.space_id, spaceId),
        eq(schema.memoryRecallRequests.request_key, requestKey),
      ),
    );
  return toD1(db, query).first<MemoryRecallRequestRecord>();
}

export interface MemoryRecallCandidateRow {
  experience_id: string;
  origin_room_id: string | null;
  origin_member_generation: number;
  representation_id: string;
  evidence: string | null;
  created_at: number;
}

export async function listMemoryRecallCandidates(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    limit: number;
  },
): Promise<MemoryRecallCandidateRow[]> {
  const query = orm(db)
    .select({
      experience_id: schema.memoryExperiences.experience_id,
      origin_room_id: schema.memoryExperiences.origin_room_id,
      origin_member_generation: schema.memoryExperiences.origin_member_generation,
      representation_id: schema.memoryExperiences.representation_id,
      evidence: schema.memoryExperiences.evidence,
      created_at: schema.memoryExperiences.created_at,
    })
    .from(schema.memoryExperiences)
    .where(
      and(
        eq(schema.memoryExperiences.space_id, input.spaceId),
        eq(schema.memoryExperiences.ownership_epoch, input.ownershipEpoch),
        eq(schema.memoryExperiences.agent_actor_id, input.agentId),
        eq(schema.memoryExperiences.available, 1),
        eq(schema.memoryExperiences.origin_kind, 'experienced'),
      ),
    )
    .orderBy(desc(schema.memoryExperiences.created_at))
    .limit(input.limit);
  const result = await toD1(db, query).all<MemoryRecallCandidateRow>();
  return result.results;
}

export interface MemoryCoverageRangeRow {
  source_id: string;
  source_revision: number;
  range_start: number;
  range_end: number;
  text_sha256: string;
}

export async function listMemoryCoverageRanges(
  db: D1Like,
  input: {
    spaceId: string;
    ownershipEpoch: number;
    agentId: string;
    roomId: string;
    memberGeneration: number;
    sourceId?: string | null;
    sourceRevision?: number | null;
  },
): Promise<MemoryCoverageRangeRow[]> {
  const conditions = [
    eq(schema.memoryCoverageRanges.space_id, input.spaceId),
    eq(schema.memoryCoverageRanges.ownership_epoch, input.ownershipEpoch),
    eq(schema.memoryCoverageRanges.agent_actor_id, input.agentId),
    eq(schema.memoryCoverageRanges.origin_room_id, input.roomId),
    eq(schema.memoryCoverageRanges.origin_member_generation, input.memberGeneration),
  ];
  if (input.sourceId) {
    conditions.push(eq(schema.memoryCoverageRanges.source_id, input.sourceId));
  }
  if (input.sourceRevision !== null && input.sourceRevision !== undefined) {
    conditions.push(eq(schema.memoryCoverageRanges.source_revision, input.sourceRevision));
  }
  const query = orm(db)
    .select({
      source_id: schema.memoryCoverageRanges.source_id,
      source_revision: schema.memoryCoverageRanges.source_revision,
      range_start: schema.memoryCoverageRanges.range_start,
      range_end: schema.memoryCoverageRanges.range_end,
      text_sha256: schema.memoryCoverageRanges.text_sha256,
    })
    .from(schema.memoryCoverageRanges)
    .where(and(...conditions))
    .orderBy(
      schema.memoryCoverageRanges.source_id,
      schema.memoryCoverageRanges.source_revision,
      schema.memoryCoverageRanges.range_start,
      schema.memoryCoverageRanges.range_end,
    );
  const result = await toD1(db, query).all<MemoryCoverageRangeRow>();
  return result.results;
}
