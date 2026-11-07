import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  RoomAnnouncementSetInput,
  RoomCreateInput,
  RoomLeaveInput,
  RoomMembersUpdateInput,
  RoomOwnerTransferInput,
  RoomPolicySetInput,
  RoomRoleHistoryInput,
  RoomRoleSetInput,
  RoomsListInput,
} from '../contracts/schemas';
import {
  newId,
  nowMs,
  sha256Hex,
  sortedPairKey,
  stableStringify,
} from '../storage/db';
import {
  eventStatement,
  eventStatementIfAbsent,
  inboxHeadStatement,
  inboxTopic,
  outboxStatement,
  outboxStatementIfAbsent,
  roomHeadStatement,
  roomMemberSeqStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, getMember, getMessage, getRoom, isActiveMember } from '../storage/queries';
import type {
  ActorRow,
  MessageRow,
  RoomManagementAuditRow,
  RoomMemberRow,
  RoomRow,
} from '../storage/rows';
import { operationsStatement, resolveReplay, runIdempotent } from '../storage/transactions/runner';
import { directRelationStatements, getActiveRelation } from './contact-relations';
import { actorId, type Principal } from './principal';
import {
  capabilityGuardStatement,
  currentOwnerGuardStatement,
  loadRoomAccess,
  memberActionsFor,
  memberRemovalGuardStatement,
  requireExpectedRoleRevision,
  requireGroupAccess,
  requireRoomAccess,
  requireTargetMember,
  roleRevisionGuardStatement,
  roleTargetGuardStatement,
  roomCapabilitiesFor,
  roomPolicies,
  transferTargetGuardStatement,
  type MemberActions,
  type RoomCapabilities,
  type RoomPolicies,
} from './room-access';
import { messagePreviewOf, type MessagePreviewView } from './views';

export type { MessagePreviewView } from './views';

export interface RoomView {
  room_id: string;
  kind: 'direct' | 'group';
  owner_id: string | null;
  title: string;
  head_seq: string;
  member_seq: string;
  member_count: number;
  my_role: 'owner' | 'admin' | 'member';
  my_role_revision: number;
  my_last_read_seq: string;
  policy_revision: number;
  policies: RoomPolicies;
  announcement: string;
  announcement_revision: number;
  announcement_updated_at: string | null;
  announcement_updated_by: string | null;
  capabilities: RoomCapabilities;
  last_message: MessagePreviewView | null;
  created_at: string;
  updated_at: string;
}

export interface MemberView {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  agent_session_id: string | null;
  role: 'owner' | 'admin' | 'member';
  role_revision: number;
  joined_seq: string;
  joined_at: string;
  last_read_seq: string;
  /**
   * Agent 的在线快照；`null` 表示未知。
   *
   * 域层不访问通知 hub，默认 `null`；`network_room_get` 出口再按需
   * 补充。人类成员恒为 `null`，页面不展示在线状态。
   */
  online: boolean | null;
  actions: MemberActions;
}

export interface RoomDetail {
  room: RoomView;
  members: MemberView[];
}

export interface RoomPage {
  items: RoomView[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface RoomRoleAuditView {
  audit_id: string;
  room_id: string;
  action: RoomManagementAuditRow['action'];
  target_actor_id: string | null;
  target_name: string | null;
  previous_role: RoomManagementAuditRow['previous_role'];
  new_role: RoomManagementAuditRow['new_role'];
  previous_status: RoomManagementAuditRow['previous_status'];
  new_status: RoomManagementAuditRow['new_status'];
  expected_revision: number | null;
  resulting_revision: number;
  changed_by: string;
  changed_by_name: string | null;
  request_id: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface RoomRoleHistoryPage {
  items: RoomRoleAuditView[];
  next_cursor: string | null;
  has_more: boolean;
}

function messagePreview(row: MessageRow | null): MessagePreviewView | null {
  return messagePreviewOf(row);
}

function roomView(
  room: RoomRow,
  member: Pick<RoomMemberRow, 'role' | 'status' | 'last_read_seq' | 'role_revision'>,
  memberCount: number,
  lastMessage: MessageRow | null,
): RoomView {
  return {
    room_id: room.room_id,
    kind: room.kind,
    owner_id: room.owner_id,
    title: room.title,
    head_seq: String(room.head_seq),
    member_seq: String(room.member_seq),
    member_count: memberCount,
    my_role: member.role,
    my_role_revision: member.role_revision,
    my_last_read_seq: String(member.last_read_seq),
    policy_revision: room.policy_revision,
    policies: roomPolicies(room),
    announcement: room.announcement,
    announcement_revision: room.announcement_revision,
    announcement_updated_at:
      room.announcement_updated_at === null ? null : String(room.announcement_updated_at),
    announcement_updated_by: room.announcement_updated_by,
    capabilities: roomCapabilitiesFor(room, member),
    last_message: messagePreview(lastMessage),
    created_at: String(room.created_at),
    updated_at: String(room.updated_at),
  };
}

async function memberCount(db: D1Database, roomId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'")
    .bind(roomId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function loadRoomView(
  db: D1Database,
  room: RoomRow,
  member: RoomMemberRow,
): Promise<RoomView> {
  const [count, last] = await Promise.all([
    memberCount(db, room.room_id),
    room.last_message_id ? getMessage(db, room.last_message_id) : Promise.resolve(null),
  ]);
  return roomView(room, member, count, last);
}

async function loadMembers(
  db: D1Database,
  room: RoomRow,
  viewer: RoomMemberRow,
): Promise<MemberView[]> {
  const rows = await db
    .prepare(
      `SELECT m.*, a.kind, a.name, a.agent_session_id
         FROM room_members m
         JOIN actors a ON a.actor_id = m.actor_id
        WHERE m.room_id = ? AND m.status = 'active'
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                 m.joined_at ASC, m.actor_id ASC`,
    )
    .bind(room.room_id)
    .all<RoomMemberRow & Pick<ActorRow, 'kind' | 'name' | 'agent_session_id'>>();
  return rows.results.map((row) => ({
    actor_id: row.actor_id,
    kind: row.kind,
    name: row.name,
    agent_session_id: row.agent_session_id,
    role: row.role,
    role_revision: row.role_revision,
    joined_seq: String(row.joined_seq),
    joined_at: String(row.joined_at),
    last_read_seq: String(row.last_read_seq),
    online: null,
    actions: memberActionsFor(room, viewer, row),
  }));
}

interface RoomListRow extends RoomRow {
  my_role: 'owner' | 'admin' | 'member';
  my_role_revision: number;
  my_last_read_seq: number;
  member_count: number;
  lm_message_id: string | null;
  lm_sender_id: string | null;
  lm_preview: string | null;
  lm_body_bytes: number | null;
  lm_created_seq: number | null;
  lm_created_at: number | null;
}

export async function roomsList(
  db: D1Database,
  principal: Principal,
  input: RoomsListInput,
): Promise<RoomPage> {
  const id = actorId(principal);
  const scope = `rooms:${id}`;
  const limit = clampPage(input.limit, LIMITS.historyPageDefault, LIMITS.historyPageMax);
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const keyset = cursor
    ? 'AND (r.updated_at < ? OR (r.updated_at = ? AND r.room_id < ?))'
    : '';
  const binds: unknown[] = cursor ? [id, cursor.seq, cursor.seq, cursor.key ?? ''] : [id];

  const rows = await db
    .prepare(
      `SELECT r.*, m.role AS my_role, m.role_revision AS my_role_revision,
              m.last_read_seq AS my_last_read_seq,
              (SELECT COUNT(*) FROM room_members mm WHERE mm.room_id = r.room_id AND mm.status = 'active') AS member_count,
              lm.message_id AS lm_message_id, lm.sender_id AS lm_sender_id, lm.preview AS lm_preview,
              lm.body_bytes AS lm_body_bytes, lm.created_seq AS lm_created_seq, lm.created_at AS lm_created_at
         FROM room_members m
         JOIN rooms r ON r.room_id = m.room_id
         LEFT JOIN messages lm ON lm.message_id = r.last_message_id
        WHERE m.actor_id = ? AND m.status = 'active' ${keyset}
        ORDER BY r.updated_at DESC, r.room_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<RoomListRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  const items = page.map((row) =>
    roomView(
      row,
      {
        role: row.my_role,
        status: 'active' as const,
        last_read_seq: row.my_last_read_seq,
        role_revision: row.my_role_revision,
      },
      row.member_count,
      row.lm_message_id
        ? {
            message_id: row.lm_message_id,
            room_id: row.room_id,
            sender_id: row.lm_sender_id ?? '',
            client_message_id: '',
            created_seq: row.lm_created_seq ?? 0,
            body: '',
            body_bytes: row.lm_body_bytes ?? 0,
            preview: row.lm_preview ?? '',
            reply_to: null,
            root_id: null,
            hop: 0,
            root_invocations_used: 0,
            created_at: row.lm_created_at ?? 0,
          }
        : null,
    ),
  );

  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.updated_at,
            key: last.room_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

async function ensureActors(db: D1Database, ids: string[]): Promise<ActorRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT * FROM actors WHERE actor_id IN (${placeholders})`)
    .bind(...ids)
    .all<ActorRow>();
  const found = new Map(rows.results.map((row) => [row.actor_id, row]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BusinessError('INVALID_ARGUMENT', '成员 actor 不存在', { missing });
  }
  return ids.map((id) => found.get(id) as ActorRow);
}

function uniqueOthers(self: string, members: string[]): string[] {
  return [...new Set(members)].filter((id) => id !== self);
}

async function requireFriends(
  db: D1Database,
  owner: string,
  targets: string[],
): Promise<void> {
  for (const target of targets) {
    if (!(await getActiveRelation(db, owner, target))) {
      throw new BusinessError('FRIEND_REQUIRED', '只能把好友加入群聊', { actor_id: target });
    }
  }
}

/** 房间创建时所有参与者的 inbox 事件（含分享入口）。 */
function inboxChangeStatements(
  db: D1Database,
  actorIds: string[],
  eventKeyFor: (actor: string) => string,
  eventType: string,
  at: number,
  refId: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const actor of actorIds) {
    const eventKey = eventKeyFor(actor);
    statements.push(
      eventStatementIfAbsent(
        db,
        { eventKey, scopeKind: 'inbox', scopeId: actor, eventType, refId },
        at,
      ),
      outboxStatementIfAbsent(db, { topic: inboxTopic(actor), eventKey }, at),
      inboxHeadStatement(db, actor, eventKey, at, 0),
    );
  }
  return statements;
}

export async function roomCreate(
  db: D1Database,
  principal: Principal,
  input: RoomCreateInput,
): Promise<RoomDetail> {
  const owner = actorId(principal);
  const others = uniqueOthers(owner, input.members);
  if (others.length === 0) {
    throw new BusinessError('INVALID_ARGUMENT', '房间至少需要另一个成员');
  }
  await ensureActors(db, others);

  if (input.kind === 'direct') {
    if (others.length !== 1) {
      throw new BusinessError('INVALID_ARGUMENT', '单聊只能指定一个对方');
    }
    return createDirect(db, principal, others[0] as string, input.request_id);
  }

  await requireFriends(db, owner, others);
  if (others.length + 1 > LIMITS.groupMembersMax) {
    throw new BusinessError('ROOM_FULL', '群成员数量超过上限');
  }

  const at = nowMs();
  const roomId = newId('rm');
  const payloadHash = await sha256Hex(stableStringify(input));
  const roomRef = `room_created:${roomId}`;
  const participants = [owner, ...others];

  await runIdempotent(db, {
    actorId: owner,
    requestId: input.request_id,
    payloadHash,
    result: { room_id: roomId },
    build: (resultJson) => [
      operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'roomLimit',
            '(SELECT COUNT(*) FROM room_members WHERE actor_id = ? AND status = \'active\') >= ?',
          ),
        )
        .bind(owner, LIMITS.activeRoomsPerActor),
      db
        .prepare(
          `INSERT INTO rooms
             (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq, member_seq, last_message_id, created_at, updated_at)
           VALUES (?, 'group', ?, ?, NULL, 0, 0, 0, NULL, ?, ?)`,
        )
        .bind(roomId, owner, input.title ?? '', at, at),
      eventStatement(
        db,
        {
          eventKey: roomRef,
          scopeKind: 'room',
          scopeId: roomId,
          eventType: 'room_created',
          refId: roomId,
          metadata: { owner_id: owner, members: others },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(roomId), eventKey: roomRef }, at),
      roomHeadStatement(db, roomId, roomRef, at),
      ...participants.map((participant) =>
        db
          .prepare(
            `INSERT INTO room_members
               (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
             VALUES (?, ?, ?, 'active', (SELECT event_seq FROM events WHERE event_key = ?), 0, ?, 1, ?)`,
          )
          .bind(
            roomId,
            participant,
            participant === owner ? 'owner' : 'member',
            roomRef,
            at,
            at,
          ),
      ),
      ...inboxChangeStatements(
        db,
        participants,
        (actor) => `room_created:${roomId}:${actor}`,
        'room_created',
        at,
        roomId,
      ),
    ],
  });

  return roomDetail(db, roomId, owner);
}

async function createDirect(
  db: D1Database,
  principal: Principal,
  target: string,
  requestId: string,
): Promise<RoomDetail> {
  const owner = actorId(principal);
  const at = nowMs();
  const targetActor = await getActor(db, target);
  if (!targetActor) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  const pairKey = sortedPairKey(owner, target);
  const roomId = `rm_${(await sha256Hex(`direct:${pairKey}`)).slice(0, 32)}`;
  const roomRef = `room_created:${roomId}`;
  const participants = [owner, target];
  const payloadHash = await sha256Hex(
    stableStringify({ kind: 'direct', members: [target], request_id: requestId }),
  );

  await runIdempotent(db, {
    actorId: owner,
    requestId,
    payloadHash,
    result: { room_id: roomId },
    build: (resultJson) => [
      operationsStatement(db, owner, requestId, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'roomLimit',
            '(SELECT COUNT(*) FROM room_members WHERE actor_id = ? AND status = \'active\') >= ?',
          ),
        )
        .bind(owner, LIMITS.activeRoomsPerActor),
      ...directRelationStatements(db, owner, targetActor, at),
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
    ],
  });

  return roomDetail(db, roomId, owner);
}

async function roomDetail(db: D1Database, roomId: string, viewer: string): Promise<RoomDetail> {
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, roomId, viewer);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  const [view, members] = await Promise.all([
    loadRoomView(db, room, member),
    loadMembers(db, room, member),
  ]);
  return { room: view, members };
}

export async function roomGet(
  db: D1Database,
  principal: Principal,
  roomId: string,
): Promise<RoomDetail> {
  return roomDetail(db, roomId, actorId(principal));
}

function cancelDeliveriesForMemberStatements(
  db: D1Database,
  roomId: string,
  member: string,
  reason: string,
  at: number,
): D1PreparedStatement[] {
  return [
    // pending 才计入 pending_count；先按当前 pending 数扣减，再取消。
    db
      .prepare(
        `UPDATE actors
            SET pending_count = pending_count - (
                  SELECT COUNT(*) FROM deliveries
                   WHERE room_id = ? AND recipient_id = ? AND state = 'pending'
                ),
                updated_at = ?
          WHERE actor_id = ?`,
      )
      .bind(roomId, member, at, member),
    db
      .prepare(
        `UPDATE deliveries
            SET state = 'cancelled', error = ?, updated_at = ?
          WHERE room_id = ? AND recipient_id = ? AND state IN ('pending', 'claimed')`,
      )
      .bind(reason, at, roomId, member),
  ];
}

interface RoomAuditSpec {
  roomId: string;
  action: RoomManagementAuditRow['action'];
  targetActorId?: string | null;
  previousRole?: RoomManagementAuditRow['previous_role'];
  newRole?: RoomManagementAuditRow['new_role'];
  previousStatus?: RoomManagementAuditRow['previous_status'];
  newStatus?: RoomManagementAuditRow['new_status'];
  expectedRevision?: number | null;
  resultingRevision: number;
  changedBy: string;
  requestId: string;
  detail?: Record<string, unknown>;
}

/** 追加写管理审计；与角色/策略变更在同一事务内提交。 */
function roomAuditStatement(
  db: D1Database,
  spec: RoomAuditSpec,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO room_management_audit
         (audit_id, room_id, action, target_actor_id, previous_role, new_role,
          previous_status, new_status, expected_revision, resulting_revision,
          changed_by, request_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('raud'),
      spec.roomId,
      spec.action,
      spec.targetActorId ?? null,
      spec.previousRole ?? null,
      spec.newRole ?? null,
      spec.previousStatus ?? null,
      spec.newStatus ?? null,
      spec.expectedRevision ?? null,
      spec.resultingRevision,
      spec.changedBy,
      spec.requestId,
      JSON.stringify(spec.detail ?? {}),
      at,
    );
}

function membershipInboxStatements(
  db: D1Database,
  roomId: string,
  requestId: string,
  actors: string[],
  at: number,
): D1PreparedStatement[] {
  return [...new Set(actors)].flatMap((actor) => {
    const inboxKey = `members:${roomId}:${requestId}:${actor}`;
    return [
      eventStatement(
        db,
        {
          eventKey: inboxKey,
          scopeKind: 'inbox',
          scopeId: actor,
          eventType: 'room_members_changed',
          refId: roomId,
        },
        at,
      ),
      outboxStatement(db, { topic: inboxTopic(actor), eventKey: inboxKey }, at),
      inboxHeadStatement(db, actor, inboxKey, at, 0),
    ];
  });
}

export async function roomMembersUpdate(
  db: D1Database,
  principal: Principal,
  input: RoomMembersUpdateInput,
): Promise<RoomDetail> {
  const caller = actorId(principal);
  const access = await loadRoomAccess(db, input.room_id, caller);
  const room = access.room;
  if (room.kind !== 'group') {
    throw new BusinessError('INVALID_ARGUMENT', '单聊不支持成员变更');
  }

  const add = uniqueOthers(caller, input.add ?? []).filter((id) => id !== room.owner_id);
  const remove = uniqueOthers(caller, input.remove ?? []);
  if (add.length > LIMITS.memberChangeMax || remove.length > LIMITS.memberChangeMax) {
    throw new BusinessError('INVALID_ARGUMENT', '单次成员变更数量超过上限');
  }
  if (add.length === 0 && remove.length === 0 && !input.transfer_owner_to) {
    return roomDetail(db, room.room_id, caller);
  }
  if (add.length > 0 && !access.capabilities.invite_members) {
    throw new BusinessError('PERMISSION_DENIED', '当前群角色不能邀请成员');
  }
  if (remove.length > 0 && !access.capabilities.remove_members) {
    throw new BusinessError('PERMISSION_DENIED', '当前群角色不能移除成员');
  }
  if (remove.length > 1 && input.expected_role_revision !== undefined) {
    throw new BusinessError('INVALID_ARGUMENT', '多个移除目标不能共用一个角色版本');
  }
  const payloadHash = await sha256Hex(stableStringify(input));
  // 能力预检在前；同一 request_id 且仍有权限时不再被已变化的成员状态挡住。
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);

  const targetIds = new Set([
    ...add,
    ...remove,
    ...(input.transfer_owner_to ? [input.transfer_owner_to] : []),
  ]);
  const existing = new Map<string, RoomMemberRow>();
  for (const actor of targetIds) {
    const row = await getMember(db, room.room_id, actor);
    if (row) existing.set(actor, row);
  }

  if (!replay.found && add.length > 0) {
    await ensureActors(db, add);
    await requireFriends(db, caller, add);
  }
  if (!replay.found) {
    for (const member of remove) {
      const target = existing.get(member);
      if (!target || target.status !== 'active') continue;
      if (target.actor_id === room.owner_id) {
        throw new BusinessError('INVALID_ARGUMENT', '不能移除群 owner');
      }
      if (!memberActionsFor(room, access.member, target).can_remove) {
        throw new BusinessError('PERMISSION_DENIED', '当前群角色不能移除该成员');
      }
      if (input.expected_role_revision !== undefined) {
        requireExpectedRoleRevision(target, input.expected_role_revision);
      }
    }
  }

  let transferTarget: RoomMemberRow | null = null;
  if (input.transfer_owner_to) {
    if (!access.capabilities.transfer_owner) {
      throw new BusinessError('NOT_OWNER', '只有群 owner 可以转移 owner');
    }
    if (input.expected_role_revision === undefined) {
      throw new BusinessError('INVALID_ARGUMENT', '转移 owner 必须提供 expected_role_revision');
    }
    if (input.transfer_owner_to === caller) {
      throw new BusinessError('INVALID_ARGUMENT', 'owner 已经是当前身份');
    }
    if (remove.includes(input.transfer_owner_to)) {
      throw new BusinessError('INVALID_ARGUMENT', '不能在同一次操作中移除 owner 转移目标');
    }
    transferTarget = await requireTargetMember(db, room.room_id, input.transfer_owner_to);
    if (!replay.found) {
      requireExpectedRoleRevision(transferTarget, input.expected_role_revision);
    }
  }

  const at = nowMs();
  const eventKey = `members:${room.room_id}:${input.request_id}`;
  const affected = [
    ...new Set([
      ...add,
      ...remove,
      ...(input.transfer_owner_to ? [input.transfer_owner_to] : []),
    ]),
  ];

  const audits: RoomAuditSpec[] = [];
  for (const member of add) {
    const previous = existing.get(member);
    if (previous?.status === 'active') continue;
    audits.push({
      roomId: room.room_id,
      action: 'member_added',
      targetActorId: member,
      previousRole: previous?.role ?? null,
      newRole: 'member',
      previousStatus: previous?.status ?? null,
      newStatus: 'active',
      resultingRevision: (previous?.role_revision ?? 0) + 1,
      changedBy: caller,
      requestId: input.request_id,
    });
  }
  for (const member of remove) {
    const target = existing.get(member);
    if (!target || target.status !== 'active') continue;
    audits.push({
      roomId: room.room_id,
      action: 'member_removed',
      targetActorId: member,
      previousRole: target.role,
      newRole: target.role,
      previousStatus: 'active',
      newStatus: 'removed',
      expectedRevision: input.expected_role_revision ?? null,
      resultingRevision: target.role_revision + 1,
      changedBy: caller,
      requestId: input.request_id,
    });
  }
  if (transferTarget) {
    audits.push(
      {
        roomId: room.room_id,
        action: 'owner_transferred',
        targetActorId: transferTarget.actor_id,
        previousRole: transferTarget.role,
        newRole: 'owner',
        previousStatus: 'active',
        newStatus: 'active',
        expectedRevision: input.expected_role_revision ?? null,
        resultingRevision: transferTarget.role_revision + 1,
        changedBy: caller,
        requestId: input.request_id,
      },
      {
        roomId: room.room_id,
        action: 'owner_transferred',
        targetActorId: caller,
        previousRole: 'owner',
        newRole: 'member',
        previousStatus: 'active',
        newStatus: 'active',
        resultingRevision: access.member.role_revision + 1,
        changedBy: caller,
        requestId: input.request_id,
      },
    );
  }

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { room_id: room.room_id },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      ...(add.length > 0
        ? [capabilityGuardStatement(db, room.room_id, caller, 'invite_members')]
        : []),
      // 好友关系预检查同样有“先读后写”窗口；在提交时按 pair_key 复核。
      ...add.map((member) =>
        db
          .prepare(
            guardSql(
              'friendRequired',
              "NOT EXISTS (SELECT 1 FROM contact_relations WHERE pair_key = ? AND status = 'active')",
            ),
          )
          .bind(sortedPairKey(caller, member)),
      ),
      ...remove.map((member) =>
        memberRemovalGuardStatement(db, room.room_id, caller, member),
      ),
      ...(input.transfer_owner_to
        ? [
            capabilityGuardStatement(db, room.room_id, caller, 'transfer_owner'),
            currentOwnerGuardStatement(db, room.room_id, caller),
            transferTargetGuardStatement(db, room.room_id, caller, input.transfer_owner_to),
            roleRevisionGuardStatement(
              db,
              room.room_id,
              input.transfer_owner_to,
              input.expected_role_revision,
            ),
          ].filter((statement): statement is D1PreparedStatement => statement !== null)
        : []),
      ...(remove.length === 1 && input.expected_role_revision !== undefined
        ? [
            roleRevisionGuardStatement(
              db,
              room.room_id,
              remove[0] as string,
              input.expected_role_revision,
            ),
          ].filter((statement): statement is D1PreparedStatement => statement !== null)
        : []),
      db
        .prepare(
          guardSql(
            'roomFull',
            '(SELECT COUNT(*) FROM room_members WHERE room_id = ? AND status = \'active\') + ? > ?',
          ),
        )
        .bind(room.room_id, add.length, LIMITS.groupMembersMax),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: room.room_id,
          eventType: 'members_changed',
          refId: room.room_id,
          metadata: {
            add,
            remove,
            transfer_owner_to: input.transfer_owner_to ?? null,
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(room.room_id), eventKey }, at),
      ...add.map((member) =>
        db
          .prepare(
            `INSERT INTO room_members
               (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
             VALUES (?, ?, 'member', 'active', (SELECT event_seq FROM events WHERE event_key = ?), 0, ?, 1, ?)
             ON CONFLICT(room_id, actor_id) DO UPDATE SET
               status = 'active',
               role = CASE WHEN room_members.status = 'active' THEN room_members.role ELSE 'member' END,
               role_revision = CASE WHEN room_members.status = 'active'
                                    THEN room_members.role_revision ELSE room_members.role_revision + 1 END,
               joined_seq = CASE WHEN room_members.status = 'active'
                                 THEN room_members.joined_seq ELSE excluded.joined_seq END,
               joined_at = CASE WHEN room_members.status = 'active'
                                THEN room_members.joined_at ELSE excluded.joined_at END,
               updated_at = excluded.updated_at`,
          )
          .bind(room.room_id, member, eventKey, at, at),
      ),
      ...remove.flatMap((member) => [
        db
          .prepare(
            `UPDATE room_members
                SET status = 'removed', role_revision = role_revision + 1, updated_at = ?
              WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
          )
          .bind(at, room.room_id, member),
        ...cancelDeliveriesForMemberStatements(db, room.room_id, member, 'member_removed', at),
      ]),
      ...(input.transfer_owner_to
        ? [
            db
              .prepare(
                `UPDATE room_members
                    SET role = 'member', role_revision = role_revision + 1, updated_at = ?
                  WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
              )
              .bind(at, room.room_id, caller),
            db
              .prepare(
                `UPDATE room_members
                    SET role = 'owner', role_revision = role_revision + 1, updated_at = ?
                  WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
              )
              .bind(at, room.room_id, input.transfer_owner_to),
            db
              .prepare('UPDATE rooms SET owner_id = ?, updated_at = ? WHERE room_id = ?')
              .bind(input.transfer_owner_to, at, room.room_id),
          ]
        : []),
      roomMemberSeqStatement(db, room.room_id, eventKey, at),
      ...audits.map((audit) => roomAuditStatement(db, audit, at)),
      ...membershipInboxStatements(db, room.room_id, input.request_id, [...affected, caller], at),
    ],
  });

  return roomDetail(db, room.room_id, caller);
}

/**
 * 群主任免管理员。
 *
 * 只有 owner 可调用；目标必须是 active 非 owner 成员，且 `expected_role_revision`
 * 与目标当前版本一致。目标角色不变时视为无操作，不推进版本。
 */
export async function roomRoleSet(
  db: D1Database,
  principal: Principal,
  input: RoomRoleSetInput,
): Promise<RoomDetail> {
  const caller = actorId(principal);
  const access = await requireGroupAccess(db, input.room_id, caller, 'manage_admins');
  const target = await requireTargetMember(db, input.room_id, input.actor_id);
  const payloadHash = await sha256Hex(stableStringify(input));
  // 授权预检先于重放；当前仍具权限时，同一 request_id 不再被已推进的版本挡住。
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (!replay.found) {
    if (target.actor_id === caller) {
      throw new BusinessError('INVALID_ARGUMENT', '不能修改自己的群主角色');
    }
    requireExpectedRoleRevision(target, input.expected_role_revision);
    if (target.role === input.role) {
      return roomDetail(db, access.room.room_id, caller);
    }
  }

  const at = nowMs();
  const eventKey = `role:${access.room.room_id}:${input.request_id}`;
  const action = input.role === 'admin' ? 'admin_appointed' : 'admin_revoked';
  const resultingRevision = target.role_revision + 1;
  const revisionGuard = roleRevisionGuardStatement(
    db,
    access.room.room_id,
    target.actor_id,
    input.expected_role_revision,
  );

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { room_id: access.room.room_id },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, access.room.room_id, caller, 'manage_admins'),
      roleTargetGuardStatement(db, access.room.room_id, caller, target.actor_id),
      ...(revisionGuard ? [revisionGuard] : []),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: access.room.room_id,
          eventType: 'room_role_changed',
          refId: target.actor_id,
          metadata: {
            target_actor_id: target.actor_id,
            previous_role: target.role,
            new_role: input.role,
            role_revision: resultingRevision,
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(access.room.room_id), eventKey }, at),
      db
        .prepare(
          `UPDATE room_members
              SET role = ?, role_revision = role_revision + 1, updated_at = ?
            WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
        )
        .bind(input.role, at, access.room.room_id, target.actor_id),
      roomMemberSeqStatement(db, access.room.room_id, eventKey, at),
      roomAuditStatement(
        db,
        {
          roomId: access.room.room_id,
          action,
          targetActorId: target.actor_id,
          previousRole: target.role,
          newRole: input.role,
          previousStatus: 'active',
          newStatus: 'active',
          expectedRevision: input.expected_role_revision,
          resultingRevision,
          changedBy: caller,
          requestId: input.request_id,
        },
        at,
      ),
      ...membershipInboxStatements(
        db,
        access.room.room_id,
        input.request_id,
        [target.actor_id, caller],
        at,
      ),
    ],
  });

  return roomDetail(db, access.room.room_id, caller);
}

/**
 * 群主转移。新旧 owner 角色和 `rooms.owner_id` 在同一事务内更新，
 * 部分唯一索引保证不会出现第二个 active owner。
 */
export async function roomOwnerTransfer(
  db: D1Database,
  principal: Principal,
  input: RoomOwnerTransferInput,
): Promise<RoomDetail> {
  const caller = actorId(principal);
  const access = await requireGroupAccess(db, input.room_id, caller, 'transfer_owner');
  if (input.target_actor_id === caller) {
    throw new BusinessError('INVALID_ARGUMENT', 'owner 已经是当前身份');
  }
  const target = await requireTargetMember(db, input.room_id, input.target_actor_id);
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (!replay.found) requireExpectedRoleRevision(target, input.expected_role_revision);

  const at = nowMs();
  const eventKey = `owner_transfer:${access.room.room_id}:${input.request_id}`;
  const revisionGuard = roleRevisionGuardStatement(
    db,
    access.room.room_id,
    target.actor_id,
    input.expected_role_revision,
  );

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { room_id: access.room.room_id },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, access.room.room_id, caller, 'transfer_owner'),
      currentOwnerGuardStatement(db, access.room.room_id, caller),
      transferTargetGuardStatement(db, access.room.room_id, caller, target.actor_id),
      ...(revisionGuard ? [revisionGuard] : []),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: access.room.room_id,
          eventType: 'owner_transferred',
          refId: target.actor_id,
          metadata: {
            previous_owner_id: caller,
            new_owner_id: target.actor_id,
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(access.room.room_id), eventKey }, at),
      db
        .prepare(
          `UPDATE room_members
              SET role = 'member', role_revision = role_revision + 1, updated_at = ?
            WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
        )
        .bind(at, access.room.room_id, caller),
      db
        .prepare(
          `UPDATE room_members
              SET role = 'owner', role_revision = role_revision + 1, updated_at = ?
            WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
        )
        .bind(at, access.room.room_id, target.actor_id),
      db
        .prepare('UPDATE rooms SET owner_id = ?, updated_at = ? WHERE room_id = ?')
        .bind(target.actor_id, at, access.room.room_id),
      roomMemberSeqStatement(db, access.room.room_id, eventKey, at),
      roomAuditStatement(
        db,
        {
          roomId: access.room.room_id,
          action: 'owner_transferred',
          targetActorId: target.actor_id,
          previousRole: target.role,
          newRole: 'owner',
          previousStatus: 'active',
          newStatus: 'active',
          expectedRevision: input.expected_role_revision,
          resultingRevision: target.role_revision + 1,
          changedBy: caller,
          requestId: input.request_id,
        },
        at,
      ),
      roomAuditStatement(
        db,
        {
          roomId: access.room.room_id,
          action: 'owner_transferred',
          targetActorId: caller,
          previousRole: 'owner',
          newRole: 'member',
          previousStatus: 'active',
          newStatus: 'active',
          resultingRevision: access.member.role_revision + 1,
          changedBy: caller,
          requestId: input.request_id,
        },
        at,
      ),
      ...membershipInboxStatements(
        db,
        access.room.room_id,
        input.request_id,
        [target.actor_id, caller],
        at,
      ),
    ],
  });

  return roomDetail(db, access.room.room_id, caller);
}

/** 群主设置普通成员的发言、邀请与创建任务策略。 */
export async function roomPolicySet(
  db: D1Database,
  principal: Principal,
  input: RoomPolicySetInput,
): Promise<RoomDetail> {
  const caller = actorId(principal);
  const access = await requireGroupAccess(db, input.room_id, caller, 'manage_policy');
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (!replay.found && access.room.policy_revision !== input.expected_policy_revision) {
    throw new BusinessError('VERSION_CONFLICT', '群策略版本已变化，请刷新后重试', {
      expected: input.expected_policy_revision,
      actual: access.room.policy_revision,
    });
  }

  const previous = roomPolicies(access.room);
  const next: RoomPolicies = {
    member_message: input.member_message_policy ?? previous.member_message,
    member_invite: input.member_invite_policy ?? previous.member_invite,
    member_task: input.member_task_policy ?? previous.member_task,
  };
  const at = nowMs();
  const eventKey = `policy:${access.room.room_id}:${input.request_id}`;

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { room_id: access.room.room_id },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, access.room.room_id, caller, 'manage_policy'),
      db
        .prepare(
          guardSql(
            'policyRevision',
            'NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = ? AND policy_revision = ?)',
          ),
        )
        .bind(access.room.room_id, input.expected_policy_revision),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: access.room.room_id,
          eventType: 'room_policy_changed',
          refId: access.room.room_id,
          metadata: {
            policies: next,
            previous_policies: previous,
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(access.room.room_id), eventKey }, at),
      db
        .prepare(
          `UPDATE rooms
              SET member_message_policy = ?, member_invite_policy = ?, member_task_policy = ?,
                  policy_revision = policy_revision + 1, updated_at = ?
            WHERE room_id = ?`,
        )
        .bind(
          next.member_message,
          next.member_invite,
          next.member_task,
          at,
          access.room.room_id,
        ),
      roomAuditStatement(
        db,
        {
          roomId: access.room.room_id,
          action: 'policy_updated',
          expectedRevision: input.expected_policy_revision,
          resultingRevision: access.room.policy_revision + 1,
          changedBy: caller,
          requestId: input.request_id,
          detail: { previous, next },
        },
        at,
      ),
    ],
  });

  return roomDetail(db, access.room.room_id, caller);
}

/** 群主/管理员维护公告；空字符串表示清除。 */
export async function roomAnnouncementSet(
  db: D1Database,
  principal: Principal,
  input: RoomAnnouncementSetInput,
): Promise<RoomDetail> {
  const caller = actorId(principal);
  const access = await requireGroupAccess(db, input.room_id, caller, 'manage_announcement');
  const bytes = new TextEncoder().encode(input.announcement).byteLength;
  if (bytes > LIMITS.roomAnnouncementBytes) {
    throw new BusinessError('INVALID_ARGUMENT', '群公告超过长度上限', {
      bytes,
      max: LIMITS.roomAnnouncementBytes,
    });
  }
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (
    !replay.found &&
    access.room.announcement_revision !== input.expected_announcement_revision
  ) {
    throw new BusinessError('VERSION_CONFLICT', '群公告版本已变化，请刷新后重试', {
      expected: input.expected_announcement_revision,
      actual: access.room.announcement_revision,
    });
  }

  const at = nowMs();
  const eventKey = `announcement:${access.room.room_id}:${input.request_id}`;

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { room_id: access.room.room_id },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, access.room.room_id, caller, 'manage_announcement'),
      db
        .prepare(
          guardSql(
            'announcementRevision',
            'NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = ? AND announcement_revision = ?)',
          ),
        )
        .bind(access.room.room_id, input.expected_announcement_revision),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: access.room.room_id,
          eventType: 'room_announcement_updated',
          refId: access.room.room_id,
          metadata: { changed_by: caller, announcement_bytes: bytes },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(access.room.room_id), eventKey }, at),
      db
        .prepare(
          `UPDATE rooms
              SET announcement = ?, announcement_revision = announcement_revision + 1,
                  announcement_updated_at = ?, announcement_updated_by = ?, updated_at = ?
            WHERE room_id = ?`,
        )
        .bind(input.announcement, at, caller, at, access.room.room_id),
      roomAuditStatement(
        db,
        {
          roomId: access.room.room_id,
          action: 'announcement_updated',
          expectedRevision: input.expected_announcement_revision,
          resultingRevision: access.room.announcement_revision + 1,
          changedBy: caller,
          requestId: input.request_id,
          detail: { announcement_bytes: bytes, cleared: input.announcement.length === 0 },
        },
        at,
      ),
    ],
  });

  return roomDetail(db, access.room.room_id, caller);
}

interface RoomAuditListRow extends RoomManagementAuditRow {
  target_name: string | null;
  changed_by_name: string | null;
}

/** 管理审计分页；只有 owner/admin 可读。 */
export async function roomRoleHistory(
  db: D1Database,
  principal: Principal,
  input: RoomRoleHistoryInput,
): Promise<RoomRoleHistoryPage> {
  const caller = actorId(principal);
  await requireGroupAccess(db, input.room_id, caller, 'view_role_history');
  const scope = `room_role_history:${input.room_id}`;
  const limit = clampPage(
    input.limit,
    LIMITS.roomRoleHistoryPageDefault,
    LIMITS.roomRoleHistoryPageMax,
  );
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const keyset = cursor
    ? 'AND (a.created_at < ? OR (a.created_at = ? AND a.audit_id < ?))'
    : '';
  const binds: unknown[] = cursor
    ? [input.room_id, cursor.seq, cursor.seq, cursor.key ?? '']
    : [input.room_id];

  const rows = await db
    .prepare(
      `SELECT a.*, target.name AS target_name, changer.name AS changed_by_name
         FROM room_management_audit a
         LEFT JOIN actors target ON target.actor_id = a.target_actor_id
         LEFT JOIN actors changer ON changer.actor_id = a.changed_by
        WHERE a.room_id = ? ${keyset}
        ORDER BY a.created_at DESC, a.audit_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<RoomAuditListRow>();

  const page = rows.results.slice(0, limit);
  let detail: Record<string, unknown> = {};
  const items = page.map((row) => {
    try {
      const parsed = JSON.parse(row.detail_json) as unknown;
      detail =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      detail = {};
    }
    return {
      audit_id: row.audit_id,
      room_id: row.room_id,
      action: row.action,
      target_actor_id: row.target_actor_id,
      target_name: row.target_name,
      previous_role: row.previous_role,
      new_role: row.new_role,
      previous_status: row.previous_status,
      new_status: row.new_status,
      expected_revision: row.expected_revision,
      resulting_revision: row.resulting_revision,
      changed_by: row.changed_by,
      changed_by_name: row.changed_by_name,
      request_id: row.request_id,
      detail,
      created_at: String(row.created_at),
    };
  });
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.audit_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

export async function roomLeave(
  db: D1Database,
  principal: Principal,
  input: RoomLeaveInput,
): Promise<{ room_id: string; left: true }> {
  const caller = actorId(principal);
  const room = await getRoom(db, input.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  if (room.kind !== 'group') {
    throw new BusinessError('INVALID_ARGUMENT', '单聊不支持离开');
  }
  const member = await getMember(db, room.room_id, caller);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  requireExpectedRoleRevision(member, input.expected_role_revision);
  if (room.owner_id === caller) {
    const others = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active' AND actor_id <> ?",
      )
      .bind(room.room_id, caller)
      .first<{ n: number }>();
    if ((others?.n ?? 0) > 0) {
      throw new BusinessError('CONFLICT', '群 owner 离开前必须转移 owner');
    }
  }

  const at = nowMs();
  const eventKey = `leave:${room.room_id}:${input.request_id}`;
  const payloadHash = await sha256Hex(stableStringify(input));

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { room_id: room.room_id, left: true as const },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      // 预检查只负责可读错误；并发 add 可能在本事务提交前加入成员，
      // 因此 owner 是否仍是唯一 active 成员必须在提交时重新判定。
      db
        .prepare(
          guardSql(
            'ownerTransferRequired',
            `EXISTS (SELECT 1 FROM rooms WHERE room_id = ? AND owner_id = ?)
             AND EXISTS (
               SELECT 1 FROM room_members
                WHERE room_id = ? AND status = 'active' AND actor_id <> ?
             )`,
          ),
        )
        .bind(room.room_id, caller, room.room_id, caller),
      db
        .prepare(
          guardSql(
            'notMember',
            "NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active')",
          ),
        )
        .bind(room.room_id, caller),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: room.room_id,
          eventType: 'member_left',
          refId: caller,
          metadata: { changed_by: caller },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(room.room_id), eventKey }, at),
      ...(input.expected_role_revision !== undefined
        ? [
            roleRevisionGuardStatement(
              db,
              room.room_id,
              caller,
              input.expected_role_revision,
            ),
          ].filter((statement): statement is D1PreparedStatement => statement !== null)
        : []),
      db
        .prepare(
          `UPDATE room_members
              SET status = 'left', role_revision = role_revision + 1, updated_at = ?
            WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
        )
        .bind(at, room.room_id, caller),
      ...cancelDeliveriesForMemberStatements(db, room.room_id, caller, 'member_left', at),
      // 无条件按 owner_id=caller 清理：即使 owner 在预检查后被并发转移，
      // 也不会把新 owner 的 rooms.owner_id 置空；非 owner 退群时是空操作。
      db
        .prepare('UPDATE rooms SET owner_id = NULL WHERE room_id = ? AND owner_id = ?')
        .bind(room.room_id, caller),
      roomMemberSeqStatement(db, room.room_id, eventKey, at),
      roomAuditStatement(
        db,
        {
          roomId: room.room_id,
          action: 'member_left',
          targetActorId: caller,
          previousRole: member.role,
          newRole: member.role,
          previousStatus: 'active',
          newStatus: 'left',
          expectedRevision: input.expected_role_revision ?? null,
          resultingRevision: member.role_revision + 1,
          changedBy: caller,
          requestId: input.request_id,
        },
        at,
      ),
      ...(() => {
        const inboxKey = `leave:${room.room_id}:${input.request_id}:inbox`;
        return [
          eventStatement(
            db,
            {
              eventKey: inboxKey,
              scopeKind: 'inbox',
              scopeId: caller,
              eventType: 'room_left',
              refId: room.room_id,
            },
            at,
          ),
          outboxStatement(db, { topic: inboxTopic(caller), eventKey: inboxKey }, at),
          inboxHeadStatement(db, caller, inboxKey, at, 0),
        ];
      })(),
    ],
  });

  return { room_id: room.room_id, left: true };
}
