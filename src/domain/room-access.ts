import { BusinessError } from '../contracts/errors';
import { guardSql } from '../storage/guards';
import { getMember, getRoom, type D1Like } from '../storage/queries';
import type {
  GroupHistoryPolicy,
  GroupJoinPolicy,
  GroupMemberPolicy,
  RoomMemberRow,
  RoomRole,
  RoomRow,
} from '../storage/rows';

/**
 * 群角色授权唯一入口。
 *
 * 所有 MCP 工具与网页可见能力都从这里派生：角色只来自
 * `room_members.role`，群角色不会写入 `agent_managements`，也不会授予
 * Agent 所有权、设备或外部系统权限。写事务仍使用本模块导出的 guard
 * 语句重新判定，避免“先读后写”窗口。
 */
export type RoomCapability =
  | 'send_message'
  | 'create_task'
  | 'invite_members'
  | 'remove_members'
  | 'manage_admins'
  | 'manage_announcement'
  | 'manage_policy'
  | 'transfer_owner'
  | 'approve_joins'
  | 'mention_all'
  | 'view_role_history';

export interface RoomPolicies {
  member_message: GroupMemberPolicy;
  member_invite: GroupMemberPolicy;
  member_task: GroupMemberPolicy;
  member_history: GroupHistoryPolicy;
  member_join: GroupJoinPolicy;
  member_profile: GroupMemberPolicy;
  member_mention_all: GroupMemberPolicy;
}

export interface RoomCapabilities {
  send_message: boolean;
  create_task: boolean;
  invite_members: boolean;
  remove_members: boolean;
  manage_admins: boolean;
  manage_announcement: boolean;
  manage_policy: boolean;
  transfer_owner: boolean;
  approve_joins: boolean;
  /** 群内 `@所有人`；默认仅 owner/admin，策略可放开给普通成员。 */
  mention_all: boolean;
  view_role_history: boolean;
}

export interface MemberActions {
  can_remove: boolean;
  can_set_admin: boolean;
  can_revoke_admin: boolean;
  can_transfer_owner: boolean;
}

export interface RoomAccess {
  room: RoomRow;
  member: RoomMemberRow;
  role: RoomRole;
  policies: RoomPolicies;
  capabilities: RoomCapabilities;
}

const OWNER_ONLY: ReadonlySet<RoomCapability> = new Set([
  'manage_admins',
  'manage_policy',
  'transfer_owner',
]);

/**
 * 角色与策略的 SQL 谓词。
 *
 * JS 能力表与事务 guard 共用这些谓词，保证预检和提交时判定一致。
 * 别名固定为 `r`（rooms）和 `m`（调用者 room_members）。
 */
const CAPABILITY_PREDICATES: Record<RoomCapability, string> = {
  send_message:
    "(r.kind = 'direct' OR m.role IN ('owner', 'admin') OR r.member_message_policy = 'members')",
  create_task:
    "(r.kind = 'direct' OR m.role IN ('owner', 'admin') OR r.member_task_policy = 'members')",
  invite_members:
    "(r.kind = 'group' AND (m.role IN ('owner', 'admin') OR r.member_invite_policy = 'members'))",
  remove_members: "(r.kind = 'group' AND m.role IN ('owner', 'admin'))",
  manage_admins: "(r.kind = 'group' AND m.role = 'owner')",
  manage_announcement: "(r.kind = 'group' AND m.role IN ('owner', 'admin'))",
  manage_policy: "(r.kind = 'group' AND m.role = 'owner')",
  transfer_owner: "(r.kind = 'group' AND m.role = 'owner')",
  approve_joins: "(r.kind = 'group' AND m.role IN ('owner', 'admin'))",
  mention_all:
    "(r.kind = 'direct' OR m.role IN ('owner', 'admin') OR r.member_mention_all_policy = 'members')",
  view_role_history: "(r.kind = 'group' AND m.role IN ('owner', 'admin'))",
};

/** 目标成员移除谓词；调用者别名 m，目标别名 t。 */
const REMOVE_TARGET_PREDICATE = `t.status = 'active'
  AND t.actor_id <> m.actor_id
  AND t.role <> 'owner'
  AND (m.role = 'owner' OR (m.role = 'admin' AND t.role = 'member'))`;

/** 角色任免目标谓词；owner 可把 active member 设为 admin，或把 admin 撤回 member。 */
const ROLE_TARGET_PREDICATE = `t.status = 'active'
  AND t.actor_id <> m.actor_id
  AND t.role IN ('admin', 'member')`;

/** owner 转移目标谓词；目标必须是 active 非 owner 成员。 */
const TRANSFER_TARGET_PREDICATE = `t.status = 'active'
  AND t.actor_id <> m.actor_id
  AND t.role <> 'owner'`;

export function roomPolicies(room: Pick<
  RoomRow,
  | 'member_message_policy'
  | 'member_invite_policy'
  | 'member_task_policy'
  | 'member_history_policy'
  | 'member_join_policy'
  | 'member_profile_policy'
  | 'member_mention_all_policy'
>): RoomPolicies {
  return {
    member_message: room.member_message_policy,
    member_invite: room.member_invite_policy,
    member_task: room.member_task_policy,
    member_history: room.member_history_policy,
    member_join: room.member_join_policy,
    member_profile: room.member_profile_policy,
    member_mention_all: room.member_mention_all_policy,
  };
}

function isAdmin(role: RoomRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** 只按房间策略与调用者角色计算能力；不读取联系人、Agent 管理或 localStorage。 */
export function roomCapabilitiesFor(
  room: Pick<
    RoomRow,
    | 'kind'
    | 'member_message_policy'
    | 'member_invite_policy'
    | 'member_task_policy'
    | 'member_mention_all_policy'
    | 'dissolved_at'
  >,
  member: Pick<RoomMemberRow, 'role' | 'status'>,
): RoomCapabilities {
  const active = member.status === 'active';
  const group = room.kind === 'group';
  // 解散后成员保留只读归档资格，但所有写入能力关闭；`view_role_history`
  // 是读能力，仍按 owner/admin 返回，便于查看解散审计。
  const writable = !(group && room.dissolved_at !== null);
  const admin = active && isAdmin(member.role);
  const owner = active && member.role === 'owner';
  return {
    send_message:
      writable &&
      active &&
      (!group || admin || room.member_message_policy === 'members'),
    create_task:
      writable &&
      active &&
      (!group || admin || room.member_task_policy === 'members'),
    invite_members:
      writable && active && group && (admin || room.member_invite_policy === 'members'),
    remove_members: writable && active && group && admin,
    manage_admins: writable && active && group && owner,
    manage_announcement: writable && active && group && admin,
    manage_policy: writable && active && group && owner,
    transfer_owner: writable && active && group && owner,
    approve_joins: writable && active && group && admin,
    mention_all:
      writable &&
      active &&
      (!group || admin || room.member_mention_all_policy === 'members'),
    view_role_history: active && group && admin,
  };
}

export function memberActionsFor(
  room: Pick<RoomRow, 'kind' | 'owner_id' | 'dissolved_at'>,
  caller: Pick<RoomMemberRow, 'actor_id' | 'role' | 'status'>,
  target: Pick<RoomMemberRow, 'actor_id' | 'role' | 'status'>,
): MemberActions {
  const group = room.kind === 'group';
  const active =
    !(group && room.dissolved_at !== null) &&
    caller.status === 'active' &&
    target.status === 'active';
  const owner = active && caller.role === 'owner';
  const admin = active && caller.role === 'admin';
  const other = active && caller.actor_id !== target.actor_id;
  const ordinary = target.role === 'member';
  return {
    can_remove:
      group &&
      active &&
      other &&
      target.role !== 'owner' &&
      (owner || (admin && ordinary)),
    can_set_admin: group && owner && other && ordinary,
    can_revoke_admin: group && owner && active && target.role === 'admin',
    can_transfer_owner: group && owner && other && target.role !== 'owner',
  };
}

export async function loadRoomAccess(
  db: D1Like,
  roomId: string,
  actorId: string,
): Promise<RoomAccess> {
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, roomId, actorId);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  return {
    room,
    member,
    role: member.role,
    policies: roomPolicies(room),
    capabilities: roomCapabilitiesFor(room, member),
  };
}

/**
 * 预检授权；所有后端入口在进入幂等重放前调用。
 *
 * 先鉴权再重放，撤销管理员后重放旧 request_id 也不会返回成功。
 */
export async function requireRoomAccess(
  db: D1Like,
  roomId: string,
  actorId: string,
  capability: RoomCapability,
): Promise<RoomAccess> {
  const access = await loadRoomAccess(db, roomId, actorId);
  if (!access.capabilities[capability]) {
    if (OWNER_ONLY.has(capability)) {
      throw new BusinessError('NOT_OWNER', '只有群 owner 可以执行该操作');
    }
    throw new BusinessError('PERMISSION_DENIED', '当前群角色没有执行该操作的权限');
  }
  return access;
}

/** 群管理工具只能作用于 group；direct 返回 INVALID_ARGUMENT。 */
export async function requireGroupAccess(
  db: D1Like,
  roomId: string,
  actorId: string,
  capability: RoomCapability,
): Promise<RoomAccess> {
  const access = await requireRoomAccess(db, roomId, actorId, capability);
  if (access.room.kind !== 'group') {
    throw new BusinessError('INVALID_ARGUMENT', '单聊不支持群管理操作');
  }
  return access;
}

/** 群解散后只允许读取；所有业务写入都在进入事务前返回 CONFLICT。 */
export function assertRoomWritable(room: Pick<RoomRow, 'room_id' | 'dissolved_at'>): void {
  if (room.dissolved_at === null) return;
  throw new BusinessError('CONFLICT', '群已解散，当前为只读归档，不能继续写入', {
    room_id: room.room_id,
    dissolved_at: String(room.dissolved_at),
    read_only: true,
  });
}

/** 事务内复核群未解散；与写路径的预检查共同防止先读后写窗口。 */
export function roomDissolvedGuardStatement(
  db: D1Database,
  roomId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'roomDissolved',
        'EXISTS (SELECT 1 FROM rooms WHERE room_id = ? AND dissolved_at IS NOT NULL)',
      ),
    )
    .bind(roomId);
}

export async function requireTargetMember(
  db: D1Like,
  roomId: string,
  targetActorId: string,
): Promise<RoomMemberRow> {
  const target = await getMember(db, roomId, targetActorId);
  if (!target || target.status !== 'active') {
    throw new BusinessError('INVALID_ARGUMENT', '目标不是当前群的有效成员');
  }
  return target;
}

export function requireExpectedRoleRevision(
  target: Pick<RoomMemberRow, 'role_revision'>,
  expected: number | undefined,
): void {
  if (expected !== undefined && target.role_revision !== expected) {
    throw new BusinessError('VERSION_CONFLICT', '群角色版本已变化，请刷新后重试', {
      expected,
      actual: target.role_revision,
    });
  }
}

/** 事务内复核调用者能力；owner-only 能力映射 NOT_OWNER，其余映射 PERMISSION_DENIED。 */
export function capabilityGuardStatement(
  db: D1Database,
  roomId: string,
  actorId: string,
  capability: RoomCapability,
): D1PreparedStatement {
  const ownerOnly = OWNER_ONLY.has(capability);
  return db
    .prepare(
      guardSql(
        ownerOnly ? 'notOwner' : 'permissionDenied',
        `NOT EXISTS (
           SELECT 1 FROM rooms r JOIN room_members m ON m.room_id = r.room_id
            WHERE r.room_id = ? AND m.actor_id = ? AND m.status = 'active'
              AND ${CAPABILITY_PREDICATES[capability]}
         )`,
      ),
    )
    .bind(roomId, actorId);
}

/** 事务内复核目标成员角色版本。 */
export function roleRevisionGuardStatement(
  db: D1Database,
  roomId: string,
  actorId: string,
  expected: number | undefined,
): D1PreparedStatement | null {
  if (expected === undefined) return null;
  return db
    .prepare(
      guardSql(
        'roleRevision',
        `NOT EXISTS (
           SELECT 1 FROM room_members
            WHERE room_id = ? AND actor_id = ? AND status = 'active' AND role_revision = ?
         )`,
      ),
    )
    .bind(roomId, actorId, expected);
}

/** 事务内复核移除目标仍可被当前调用者移除。 */
export function memberRemovalGuardStatement(
  db: D1Database,
  roomId: string,
  actorId: string,
  targetActorId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'permissionDenied',
        `NOT EXISTS (
           SELECT 1
             FROM rooms r
             JOIN room_members m ON m.room_id = r.room_id
             JOIN room_members t ON t.room_id = r.room_id
            WHERE r.room_id = ? AND m.actor_id = ? AND m.status = 'active'
              AND t.actor_id = ? AND ${REMOVE_TARGET_PREDICATE}
         )`,
      ),
    )
    .bind(roomId, actorId, targetActorId);
}

/** 事务内复核角色任免目标仍是 active、非 owner 的成员。 */
export function roleTargetGuardStatement(
  db: D1Database,
  roomId: string,
  actorId: string,
  targetActorId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'invalidTarget',
        `NOT EXISTS (
           SELECT 1
             FROM room_members m
             JOIN room_members t ON t.room_id = m.room_id
            WHERE m.room_id = ? AND m.actor_id = ? AND m.status = 'active'
              AND m.role = 'owner'
              AND t.actor_id = ? AND ${ROLE_TARGET_PREDICATE}
         )`,
      ),
    )
    .bind(roomId, actorId, targetActorId);
}

/** 事务内复核 owner 转移目标仍是 active 非 owner 成员，且 rooms.owner_id 未变。 */
export function transferTargetGuardStatement(
  db: D1Database,
  roomId: string,
  actorId: string,
  targetActorId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'invalidTarget',
        `NOT EXISTS (
           SELECT 1
             FROM rooms r
             JOIN room_members m ON m.room_id = r.room_id
             JOIN room_members t ON t.room_id = r.room_id
            WHERE r.room_id = ? AND r.owner_id = ? AND m.actor_id = ? AND m.status = 'active'
              AND m.role = 'owner' AND t.actor_id = ? AND ${TRANSFER_TARGET_PREDICATE}
         )`,
      ),
    )
    .bind(roomId, actorId, actorId, targetActorId);
}

/** 当前 owner 身份仍与 `rooms.owner_id` 一致；转移/离开前使用。 */
export function currentOwnerGuardStatement(
  db: D1Database,
  roomId: string,
  actorId: string,
): D1PreparedStatement {
  return db
    .prepare(guardSql('notOwner', 'NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = ? AND owner_id = ?)'))
    .bind(roomId, actorId);
}
