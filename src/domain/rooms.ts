import { BusinessError, type BusinessErrorCode } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  RoomAnnouncementSetInput,
  RoomCreateInput,
  RoomLeaveInput,
  RoomMembersUpdateInput,
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
  inboxHeadStatementIfEvent,
  inboxTopic,
  outboxStatement,
  outboxStatementIfAbsent,
  roomHeadStatement,
  roomMemberSeqStatement,
  roomMemberVersionStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import {
  getActor,
  getMember,
  getMessage,
  getRoom,
  isActiveMember,
  visibleActorSql,
} from '../storage/queries';
import type {
  ActorRow,
  MessageRow,
  RoomManagementAuditRow,
  RoomMemberRow,
  RoomRow,
} from '../storage/rows';
import { operationsStatement, resolveReplay, runIdempotent } from '../storage/transactions/runner';
import { getActiveManagement } from './agent-access';
import { directRelationStatements, getActiveRelation } from './contact-relations';
import {
  contactBlockGuardStatement,
  isBlockedBetween,
  roomInviteRateGuardStatement,
} from './contact-blocks';
import { actorId, type Principal } from './principal';
import { loadOwnerTransferView, type OwnerTransferView } from './owner-transfers';
import {
  directInvitationStatements,
  invitationInboxStatements,
  loadInvitedMembers,
  revokeDirectInvitationStatement,
  type InvitedMemberView,
} from './room-invitations';
import { roomAuditStatement, type RoomAuditSpec } from './room-audit';
import {
  capabilityGuardStatement,
  assertOwnerPresent,
  assertRoomWritable,
  isOwnerMissing,
  loadRoomAccess,
  memberActionsFor,
  memberRemovalGuardStatement,
  ownerMissingGuardStatement,
  requireExpectedRoleRevision,
  requireGroupAccess,
  requireRoomAccess,
  requireTargetMember,
  roleRevisionGuardStatement,
  roleTargetGuardStatement,
  roomCapabilitiesFor,
  roomDissolvedGuardStatement,
  roomPolicies,
  type MemberActions,
  type RoomCapabilities,
  type RoomPolicies,
} from './room-access';
import { roomLeavePreview } from './room-lifecycle';
import { messagePreviewOf, type MessagePreviewView } from './views';
import {
  historyBoundary,
  historySnapshot,
  visibleMessage,
  type HistoryBoundary,
  type HistorySnapshot,
} from './room-history';

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
  /** 当前这次加入的代次；重新加入后递增。 */
  my_member_generation: number;
  /** 当前身份可见历史的消息序号下界；`0` 表示全历史。 */
  history_from_seq: string;
  /** 本次读取采用的授权快照，跨入口用于核对同一份策略/代次。 */
  authorization: HistorySnapshot;
  policy_revision: number;
  policies: RoomPolicies;
  announcement: string;
  announcement_revision: number;
  announcement_updated_at: string | null;
  announcement_updated_by: string | null;
  capabilities: RoomCapabilities;
  last_message: MessagePreviewView | null;
  /** `dissolved` 表示群已解散；成员保留只读归档资格。 */
  status: 'active' | 'dissolved';
  dissolved_at: string | null;
  dissolved_by: string | null;
  dissolve_reason: string | null;
  /** 解散时的 room scope 事件高水位；未解散为 null。 */
  archived_head_seq: string | null;
  /**
   * 遗留无主群：`owner_id IS NULL AND dissolved_at IS NULL`。
   *
   * 修复后的合法路径不会再产生该状态；为旧数据保留可见标记，禁止再邀请
   * 或加入成员，但不自动解散、不硬删已有群。
   */
  owner_missing: boolean;
  read_only: boolean;
  can_leave: boolean;
  can_dissolve: boolean;
  created_at: string;
  updated_at: string;
  /**
   * direct 会话的对端 Agent 是否已归档；仅 `rooms_list` 返回。
   *
   * 列表默认不展示已归档 Agent 的会话，但保留 direct 房间、消息与
   * `room_get` 读取能力，供网页已归档入口恢复。群聊不设置该字段。
   */
  peer_archived?: boolean;
  /**
   * direct 会话的对端展示摘要；仅 `rooms_list` 返回。
   *
   * 群聊显式为 `null`，表示服务端已确认没有可提供的对端；域层不访问
   * 通知 hub，`online` 先为 `null`，由 MCP 输出层批量补充。字段缺失
   * 只可能来自旧服务端，客户端不能把缺失当成 `null` 反复补请求。
   */
  peer?: RoomPeerView | null;
}

export interface RoomPeerView {
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
  online: boolean | null;
}

export interface MemberView {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  agent_session_id: string | null;
  role: 'owner' | 'admin' | 'member';
  role_revision: number;
  /** 成员代次；重新加入后递增，旧游标/旧票据不能跨代次。 */
  member_generation: number;
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
  /**
   * 待确认的定向邀请成员；仅 `approve_joins` 能力持有者可见。
   * 邀请不是成员，不计入 `member_count`，也不能渲染成已加入。
   */
  invited: InvitedMemberView[];
  /**
   * 当前有效的群主转让提议；没有 pending 或已过期/目标失效时为 null。
   * 提议不改变 `owner_id` 与成员角色，接受前原群主继续负责。
   */
  owner_transfer: OwnerTransferView | null;
  /**
   * 建群时每个候选成员的逐对象结果；只有 `network_room_create` 返回。
   *
   * `failed` 只可能来自提交时的竞态（预检不合格会在提交前整体拒绝），
   * 已成功写入的成员/邀请不会因为同批其他目标失败而回滚。
   */
  results?: RoomCreateMemberResult[];
}

export type RoomCreateMemberStatus = 'active' | 'invited' | 'failed';

export interface RoomCreateMemberResult {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  status: RoomCreateMemberStatus;
  /** 失败时的稳定错误码；成功加入或邀请为 null。 */
  code: BusinessErrorCode | null;
  message: string | null;
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

/**
 * 策略变更的影响说明。
 *
 * 历史策略收紧会让成员失去对加入前消息/文件/任务的读取；任务或发言权限
 * 收紧会阻止普通成员继续使用现有材料。服务端把“材料失权”显式返回给群主，
 * 避免把失败当成成功验收。
 */
export interface RoomPolicyImpact {
  history_policy: RoomRow['member_history_policy'];
  /** 历史改为 from_join 后会失去部分历史的 active 普通成员数。 */
  affected_members: number;
  /** 至少对一名 active 成员变为不可见的文件数。 */
  hidden_files: number;
  /** 现有文件材料是否失权。 */
  material_loss: boolean;
  message: string;
}

export interface RoomPolicySetResult extends RoomDetail {
  /** 只在 `network_room_policy_set` 返回；`room_get` 不重复携带。 */
  policy_impact?: RoomPolicyImpact;
}

function messagePreview(row: MessageRow | null): MessagePreviewView | null {
  return messagePreviewOf(row);
}

function roomView(
  room: RoomRow,
  member: Pick<
    RoomMemberRow,
    'role' | 'status' | 'last_read_seq' | 'role_revision' | 'joined_seq' | 'joined_at' | 'member_generation'
  >,
  memberCount: number,
  lastMessage: MessageRow | null,
  boundary: HistoryBoundary,
  peerArchived?: boolean,
): RoomView {
  const lastVisible = lastMessage && visibleMessage(lastMessage, boundary) ? lastMessage : null;
  const dissolved = room.kind === 'group' && room.dissolved_at !== null;
  const ownerMissing = isOwnerMissing(room);
  const view: RoomView = {
    room_id: room.room_id,
    kind: room.kind,
    owner_id: room.owner_id,
    title: room.title,
    head_seq: String(room.head_seq),
    member_seq: String(room.member_seq),
    member_count: memberCount,
    my_role: member.role,
    my_role_revision: member.role_revision,
    my_last_read_seq: String(Math.max(member.last_read_seq, member.joined_seq)),
    my_member_generation: member.member_generation,
    history_from_seq: String(boundary.fromSeq),
    authorization: historySnapshot(boundary),
    policy_revision: room.policy_revision,
    policies: roomPolicies(room),
    announcement: room.announcement,
    announcement_revision: room.announcement_revision,
    announcement_updated_at:
      room.announcement_updated_at === null ? null : String(room.announcement_updated_at),
    announcement_updated_by: room.announcement_updated_by,
    capabilities: roomCapabilitiesFor(room, member),
    last_message: messagePreview(lastVisible),
    status: dissolved ? 'dissolved' : 'active',
    dissolved_at: room.dissolved_at === null ? null : String(room.dissolved_at),
    dissolved_by: room.dissolved_by,
    dissolve_reason: room.dissolve_reason,
    archived_head_seq:
      room.archive_head_seq === null ? null : String(room.archive_head_seq),
    owner_missing: ownerMissing,
    read_only: dissolved,
    // 群主在未解散群中不能直接退群，即使只剩自己一人；必须先转移或解散。
    can_leave: room.kind === 'group' && (dissolved || member.role !== 'owner'),
    can_dissolve: room.kind === 'group' && !dissolved && member.role === 'owner',
    created_at: String(room.created_at),
    updated_at: String(room.updated_at),
  };
  if (peerArchived !== undefined) view.peer_archived = peerArchived;
  return view;
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
  return roomView(room, member, count, last, historyBoundary(room, member));
}

async function loadMembers(
  db: D1Database,
  room: RoomRow,
  viewer: RoomMemberRow,
): Promise<MemberView[]> {
  // direct 的唯一对端是会话身份与网页归档入口，必须保留；group 的成员面板
  // 属于列举面，隐藏已归档 Agent。人类成员不受影响。
  const archivedFilter = room.kind === 'group' ? `AND ${visibleActorSql('a')}` : '';
  const rows = await db
    .prepare(
      `SELECT m.*, a.kind, a.name, a.agent_session_id
         FROM room_members m
         JOIN actors a ON a.actor_id = m.actor_id
        WHERE m.room_id = ? AND m.status = 'active' ${archivedFilter}
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
    member_generation: row.member_generation,
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
  my_joined_seq: number;
  my_joined_at: number;
  my_member_generation: number;
  member_count: number;
  lm_message_id: string | null;
  lm_sender_id: string | null;
  lm_preview: string | null;
  lm_body_bytes: number | null;
  lm_created_seq: number | null;
  lm_created_at: number | null;
  peer_archived: number;
}

/**
 * 只为当前页 direct 房间批量读取对端，避免在服务端逐房间调用 roomGet。
 *
 * 主查询已按成员资格、游标和 limit+1 选出当前页；这里再发一条 IN 查询，
 * 不改变分页顺序。归档的 Agent 仍返回摘要，`peer_archived` 单独表达归档。
 */
async function listRoomPeers(
  db: D1Database,
  viewerId: string,
  roomIds: string[],
): Promise<Map<string, RoomPeerView>> {
  if (roomIds.length === 0) return new Map();
  const placeholders = roomIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT rm.room_id, a.actor_id, a.name, a.kind
         FROM room_members rm
         JOIN actors a ON a.actor_id = rm.actor_id
        WHERE rm.room_id IN (${placeholders})
          AND rm.status = 'active'
          AND rm.actor_id <> ?
        ORDER BY rm.room_id, a.actor_id`,
    )
    .bind(...roomIds, viewerId)
    .all<{ room_id: string; actor_id: string; name: string; kind: 'human' | 'agent' }>();
  const peers = new Map<string, RoomPeerView>();
  for (const row of rows.results) {
    if (peers.has(row.room_id)) continue;
    peers.set(row.room_id, {
      actor_id: row.actor_id,
      name: row.name,
      kind: row.kind,
      online: null,
    });
  }
  return peers;
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
              m.last_read_seq AS my_last_read_seq, m.joined_seq AS my_joined_seq,
              m.joined_at AS my_joined_at, m.member_generation AS my_member_generation,
              (SELECT COUNT(*) FROM room_members mm WHERE mm.room_id = r.room_id AND mm.status = 'active') AS member_count,
              lm.message_id AS lm_message_id, lm.sender_id AS lm_sender_id, lm.preview AS lm_preview,
              lm.body_bytes AS lm_body_bytes, lm.created_seq AS lm_created_seq, lm.created_at AS lm_created_at,
              (r.kind = 'direct' AND EXISTS (
                SELECT 1
                  FROM room_members pm
                  JOIN actors pa ON pa.actor_id = pm.actor_id
                 WHERE pm.room_id = r.room_id
                   AND pm.status = 'active'
                   AND pm.actor_id <> m.actor_id
                   AND pa.kind = 'agent'
                   AND pa.archived_at IS NOT NULL
              )) AS peer_archived
         FROM room_members m
         JOIN rooms r ON r.room_id = m.room_id
         LEFT JOIN messages lm ON lm.message_id = r.last_message_id
        WHERE m.actor_id = ? AND m.status = 'active' AND r.dissolved_at IS NULL ${keyset}
        ORDER BY r.updated_at DESC, r.room_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<RoomListRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  // 只对当前页的 direct 房间取对端；群聊显式返回 peer: null。
  const directRoomIds = page
    .filter((row) => row.kind === 'direct')
    .map((row) => row.room_id);
  const peers = await listRoomPeers(db, id, directRoomIds);
  const items = page.map((row) => {
    const member = {
      role: row.my_role,
      status: 'active' as const,
      last_read_seq: row.my_last_read_seq,
      role_revision: row.my_role_revision,
      joined_seq: row.my_joined_seq,
      joined_at: row.my_joined_at,
      member_generation: row.my_member_generation,
    };
    const view = roomView(
      row,
      member,
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
            task_root_id: null,
            task_marked_by: null,
            task_marked_at: null,
            hop: 0,
            root_invocations_used: 0,
            created_at: row.lm_created_at ?? 0,
          }
        : null,
      historyBoundary(row, member),
      Boolean(row.peer_archived),
    );
    view.peer = row.kind === 'direct' ? peers.get(row.room_id) ?? null : null;
    return view;
  });

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

/**
 * Agent 无需好友关系也能直接入群的两个条件：尚未被认领，或由调用者管理。
 *
 * unclaimed Agent 没有可确认邀请的管理者，生成 pending 邀请只会永远等待；
 * 因此与自有 Agent 一样直接 active。已被其他人管理的 Agent 仍须好友关系。
 */
async function agentJoinsWithoutRelation(
  db: D1Database,
  owner: string,
  target: ActorRow,
): Promise<boolean> {
  if (target.kind !== 'agent') return false;
  const management = await getActiveManagement(db, target.actor_id);
  return management === null || management.manager_id === owner;
}

/**
 * 加成员预检：人类仍须 active 好友关系；Agent 额外允许 unclaimed / 自有管理者。
 *
 * 拉黑由调用方先裁决，保证 BLOCKED 优先于 FRIEND_REQUIRED。事务内还有等价
 * 的 guard，这里只负责提交前给出稳定错误。
 */
async function requireJoinableTargets(
  db: D1Database,
  owner: string,
  targets: ActorRow[],
): Promise<void> {
  for (const target of targets) {
    if (await getActiveRelation(db, owner, target.actor_id)) continue;
    if (await agentJoinsWithoutRelation(db, owner, target)) continue;
    throw new BusinessError('FRIEND_REQUIRED', '只能把好友加入群聊', {
      actor_id: target.actor_id,
    });
  }
}

interface CreateTargetEvaluation {
  actor: ActorRow;
  status: 'active' | 'invited' | 'failed';
  code: BusinessErrorCode | null;
  message: string | null;
}

/**
 * 建群候选的提交前判定：拉黑优先，其次 Agent 管理关系，最后好友关系。
 *
 * unclaimed Agent 无法确认邀请，与自有 Agent 一样直接 active；其他管理者
 * 的 Agent 仍需好友关系，好友则走既有 pending 邀请。失败的候选不会静默
 * 剔除：调用方把逐对象结果返回给客户端，整次建群在提交前终止。
 */
async function evaluateCreateTargets(
  db: D1Database,
  owner: string,
  actors: ActorRow[],
): Promise<CreateTargetEvaluation[]> {
  const evaluations: CreateTargetEvaluation[] = [];
  for (const actor of actors) {
    if (await isBlockedBetween(db, owner, actor.actor_id)) {
      evaluations.push({
        actor,
        status: 'failed',
        code: 'BLOCKED',
        message: '双方存在拉黑关系，不能邀请对方加入群聊',
      });
      continue;
    }
    if (await agentJoinsWithoutRelation(db, owner, actor)) {
      evaluations.push({ actor, status: 'active', code: null, message: null });
      continue;
    }
    if (await getActiveRelation(db, owner, actor.actor_id)) {
      evaluations.push({ actor, status: 'invited', code: null, message: null });
      continue;
    }
    evaluations.push({
      actor,
      status: 'failed',
      code: 'FRIEND_REQUIRED',
      message: '只能把好友加入群聊',
    });
  }
  return evaluations;
}

function evaluationResult(evaluation: CreateTargetEvaluation): RoomCreateMemberResult {
  return {
    actor_id: evaluation.actor.actor_id,
    kind: evaluation.actor.kind,
    name: evaluation.actor.name,
    status: evaluation.status,
    code: evaluation.code,
    message: evaluation.message,
  };
}

/** 提交后按真实成员/邀请状态生成逐对象结果，竞态失败给出可读原因。 */
async function deriveCreateResults(
  db: D1Database,
  owner: string,
  evaluations: CreateTargetEvaluation[],
  detail: RoomDetail,
): Promise<RoomCreateMemberResult[]> {
  const active = new Set(detail.members.map((member) => member.actor_id));
  const invited = new Set(detail.invited.map((invitation) => invitation.actor_id));
  return Promise.all(
    evaluations.map(async (evaluation) => {
      if (active.has(evaluation.actor.actor_id)) {
        return { ...evaluationResult(evaluation), status: 'active', code: null, message: null };
      }
      if (invited.has(evaluation.actor.actor_id)) {
        return { ...evaluationResult(evaluation), status: 'invited', code: null, message: null };
      }
      if (await isBlockedBetween(db, owner, evaluation.actor.actor_id)) {
        return {
          ...evaluationResult(evaluation),
          status: 'failed',
          code: 'BLOCKED',
          message: '提交时双方已建立拉黑关系，未加入群聊',
        };
      }
      return {
        ...evaluationResult(evaluation),
        status: 'failed',
        code: 'CONFLICT',
        message: '提交时成员资格已变化，未加入群聊',
      };
    }),
  );
}

/** 房间创建时所有参与者的 inbox 事件（含分享入口）。 */
function inboxChangeStatements(
  db: D1Database,
  actorIds: string[],
  eventKeyFor: (actor: string) => string,
  eventType: string,
  at: number,
  refId: string,
  onlyIfMember = false,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const actor of actorIds) {
    const eventKey = eventKeyFor(actor);
    statements.push(
      onlyIfMember
        ? db
            .prepare(
              `INSERT INTO events
                 (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
               SELECT 'inbox', ?, ?, ?, ?, ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM room_members
                   WHERE room_id = ? AND actor_id = ? AND status = 'active'
                )
               ON CONFLICT(event_key) DO NOTHING`,
            )
            .bind(actor, eventType, refId, JSON.stringify({}), eventKey, at, refId, actor)
        : eventStatementIfAbsent(
            db,
            { eventKey, scopeKind: 'inbox', scopeId: actor, eventType, refId },
            at,
          ),
      outboxStatementIfAbsent(db, { topic: inboxTopic(actor), eventKey }, at),
      inboxHeadStatementIfEvent(db, actor, eventKey, at, 0),
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
  const targetActors = await ensureActors(db, others);

  if (input.kind === 'direct') {
    if (others.length !== 1) {
      throw new BusinessError('INVALID_ARGUMENT', '单聊只能指定一个对方');
    }
    return createDirect(db, principal, others[0] as string, input.request_id);
  }

  // 拉黑优先于好友关系裁决，返回稳定的 BLOCKED 而不是 FRIEND_REQUIRED。
  const evaluations = await evaluateCreateTargets(db, owner, targetActors);
  const failedEvaluations = evaluations.filter((evaluation) => evaluation.status === 'failed');
  const memberResults = evaluations.map(evaluationResult);
  if (failedEvaluations.length > 0) {
    // 提交前解释所有不合格对象，不创建半成品群。
    const first = failedEvaluations[0] as CreateTargetEvaluation;
    const detailText = failedEvaluations
      .map((evaluation) => `${evaluation.actor.name}（${evaluation.message}）`)
      .join('、');
    throw new BusinessError(
      first.code ?? 'INVALID_ARGUMENT',
      `以下成员不能加入群聊：${detailText}`,
      { results: memberResults },
    );
  }

  // 建群者与自有 Agent 直接 active；其他成员生成 pending 邀请，
  // 邀请不是成员，不进入 room_members，也不计入 100 人上限。
  const activeOthers = evaluations
    .filter((evaluation) => evaluation.status === 'active')
    .map((evaluation) => evaluation.actor.actor_id);
  const inviteTargets = evaluations
    .filter((evaluation) => evaluation.status === 'invited')
    .map((evaluation) => evaluation.actor.actor_id);

  if (activeOthers.length + 1 > LIMITS.groupMembersMax) {
    throw new BusinessError('ROOM_FULL', '群成员数量超过上限', {
      limit: LIMITS.groupMembersMax,
      results: memberResults,
    });
  }

  const at = nowMs();
  const roomId = newId('rm');
  const payloadHash = await sha256Hex(stableStringify(input));
  const roomRef = `room_created:${roomId}`;
  const participants = [owner, ...activeOthers];
  const { invitations, statements: invitationStatements } = directInvitationStatements(db, {
    roomId,
    inviterId: owner,
    targets: inviteTargets,
    at,
    expiresAt: at + LIMITS.roomInviteTtlMs,
  });

  let outcome: unknown;
  try {
    outcome = await runIdempotent(db, {
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
            metadata: {
              owner_id: owner,
              members: activeOthers,
              invited: inviteTargets,
            },
          },
          at,
        ),
        outboxStatement(db, { topic: roomTopic(roomId), eventKey: roomRef }, at),
        roomHeadStatement(db, roomId, roomRef, at),
        db
          .prepare(
            `INSERT INTO room_members
               (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
             VALUES (?, ?, 'owner', 'active', (SELECT event_seq FROM events WHERE event_key = ?), 0, ?, 1, ?)`,
          )
          .bind(roomId, owner, roomRef, at, at),
        // 自有 Agent 直接 active；插入时复核拉黑/管理关系，竞态失败只影响该目标。
        ...activeOthers.map((member) =>
          db
            .prepare(
              `INSERT INTO room_members
                 (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
               SELECT ?, ?, 'member', 'active',
                      (SELECT event_seq FROM events WHERE event_key = ?), 0, ?, 1, ?
                WHERE NOT EXISTS (
                        SELECT 1 FROM contact_blocks
                         WHERE released_at IS NULL
                           AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
                             OR (blocker_actor_id = ? AND blocked_actor_id = ?))
                      )
                  AND (
                    EXISTS (
                      SELECT 1 FROM contact_relations
                       WHERE pair_key = ? AND status = 'active'
                    )
                    OR (
                      EXISTS (
                        SELECT 1 FROM actors
                         WHERE actor_id = ? AND kind = 'agent'
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM agent_managements
                         WHERE agent_id = ? AND status = 'active' AND manager_id <> ?
                      )
                    )
                  )`,
            )
            .bind(
              roomId,
              member,
              roomRef,
              at,
              at,
              owner,
              member,
              member,
              owner,
              sortedPairKey(owner, member),
              member,
              member,
              owner,
            ),
        ),
        ...invitationStatements,
        // 预检合格的候选在提交时全部失效时整批回滚，不能留下只有 owner 的群。
        db
          .prepare(
            guardSql(
              'inviteTargetsMissing',
              `NOT EXISTS (
                 SELECT 1 FROM room_members WHERE room_id = ? AND actor_id <> ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM room_invitations
                  WHERE room_id = ? AND kind = 'direct' AND status = 'pending'
               )`,
            ),
          )
          .bind(roomId, owner, roomId),
        ...invitationInboxStatements(db, invitations, at),
        ...inboxChangeStatements(
          db,
          participants,
          (actor) => `room_created:${roomId}:${actor}`,
          'room_created',
          at,
          roomId,
          true,
        ),
      ],
    });
  } catch (error) {
    if (
      error instanceof BusinessError &&
      error.details?.reason === 'invite_targets_missing'
    ) {
      const detail = {
        room: { room_id: roomId },
        members: [],
        invited: [],
      } as unknown as RoomDetail;
      const results = await deriveCreateResults(db, owner, evaluations, detail);
      throw new BusinessError(
        firstFailureCode(results),
        '成员资格在提交时已变化，群未创建',
        { results, reason: 'invite_targets_missing' },
      );
    }
    throw error;
  }

  // 重放同一 request_id 时 runIdempotent 返回首次提交的 {room_id}；不能再用
  // 本次随机生成的 roomId 读取详情，否则重放会得到 NOT_FOUND。
  const committed = outcome as { room_id?: string } | undefined;
  const committedRoomId =
    typeof committed?.room_id === 'string' ? committed.room_id : roomId;
  const detail = await roomDetail(db, committedRoomId, owner);
  return {
    ...detail,
    results: await deriveCreateResults(db, owner, evaluations, detail),
  };
}

function firstFailureCode(results: RoomCreateMemberResult[]): BusinessErrorCode {
  return results.find((result) => result.status === 'failed')?.code ?? 'FRIEND_REQUIRED';
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
  if (await isBlockedBetween(db, owner, target)) {
    throw new BusinessError('BLOCKED', '双方存在拉黑关系，不能创建单聊');
  }
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
  const [view, members, invited, ownerTransfer] = await Promise.all([
    loadRoomView(db, room, member),
    loadMembers(db, room, member),
    roomCapabilitiesFor(room, member).approve_joins && room.dissolved_at === null
      ? loadInvitedMembers(db, room.room_id, nowMs())
      : Promise.resolve([] as InvitedMemberView[]),
    loadOwnerTransferView(db, room.room_id, viewer, nowMs()),
  ]);
  return { room: view, members, invited, owner_transfer: ownerTransfer };
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
  assertRoomWritable(room);
  // G05：直接切换 owner 已移除。旧字段仍可被客户端传入，但必须明确失败，
  // 不能静默降级成未经目标确认的转让。
  if (input.transfer_owner_to) {
    throw new BusinessError(
      'INVALID_ARGUMENT',
      '直接转移群主已移除，请使用 network_room_owner_transfer_propose 发起待确认转让',
    );
  }

  const add = uniqueOthers(caller, input.add ?? []).filter((id) => id !== room.owner_id);
  const remove = uniqueOthers(caller, input.remove ?? []);
  if (add.length > LIMITS.memberChangeMax || remove.length > LIMITS.memberChangeMax) {
    throw new BusinessError('INVALID_ARGUMENT', '单次成员变更数量超过上限');
  }
  if (add.length === 0 && remove.length === 0) {
    return roomDetail(db, room.room_id, caller);
  }
  // 遗留无主群不再接受任何“加人”路径；事务 guard 仍是最终裁决。
  if (add.length > 0) assertOwnerPresent(room);
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

  const targetIds = new Set([...add, ...remove]);
  const existing = new Map<string, RoomMemberRow>();
  for (const actor of targetIds) {
    const row = await getMember(db, room.room_id, actor);
    if (row) existing.set(actor, row);
  }

  if (!replay.found && add.length > 0) {
    const addTargets = await ensureActors(db, add);
    for (const member of add) {
      if (await isBlockedBetween(db, caller, member)) {
        throw new BusinessError('BLOCKED', '双方存在拉黑关系，不能邀请对方加入群聊', {
          actor_id: member,
        });
      }
    }
    await requireJoinableTargets(db, caller, addTargets);
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

  const at = nowMs();
  const eventKey = `members:${room.room_id}:${input.request_id}`;
  const affected = [...new Set([...add, ...remove])];

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
  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { room_id: room.room_id },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, room.room_id),
      ...(add.length > 0
        ? [
            ownerMissingGuardStatement(db, room.room_id),
            capabilityGuardStatement(db, room.room_id, caller, 'invite_members'),
          ]
        : []),
      // 拉黑先于好友关系裁决；邀请窗口限额只统计显式成员添加。
      ...add.map((member) => contactBlockGuardStatement(db, caller, member)),
      ...(add.length > 0 ? [roomInviteRateGuardStatement(db, caller, at)] : []),
      // 好友关系预检查同样有“先读后写”窗口；在提交时按 pair_key 复核。
      // Agent 例外与预检一致：unclaimed 或由调用者管理的 Agent 可直接加入，
      // 已被其他人管理的 Agent 仍要求 active 关系。
      ...add.map((member) =>
        db
          .prepare(
            guardSql(
              'friendRequired',
              `NOT EXISTS (
                 SELECT 1 FROM contact_relations WHERE pair_key = ? AND status = 'active'
               )
               AND NOT (
                 EXISTS (
                   SELECT 1 FROM actors
                    WHERE actor_id = ? AND kind = 'agent'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM agent_managements
                    WHERE agent_id = ? AND status = 'active' AND manager_id <> ?
                 )
               )`,
            ),
          )
          .bind(sortedPairKey(caller, member), member, member, caller),
      ),
      ...remove.map((member) =>
        memberRemovalGuardStatement(db, room.room_id, caller, member),
      ),
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
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(room.room_id), eventKey }, at),
      // G06：每个被移除成员单独写 member_removed，作为成员失权/未来媒体层
      // 撤权的稳定事件；不创建 delivery、不增加 pending_count、不推进 head。
      ...remove.flatMap((member) => {
        if (existing.get(member)?.status !== 'active') return [];
        const removedKey = `member_removed:${room.room_id}:${input.request_id}:${member}`;
        return [
          eventStatement(
            db,
            {
              eventKey: removedKey,
              scopeKind: 'room',
              scopeId: room.room_id,
              eventType: 'member_removed',
              refId: member,
              metadata: {
                room_id: room.room_id,
                actor_id: member,
                changed_by: caller,
                reason: 'member_removed',
                media_revoke: true,
              },
            },
            at,
          ),
          outboxStatement(db, { topic: roomTopic(room.room_id), eventKey: removedKey }, at),
        ];
      }),
      ...add.map((member) =>
        db
          .prepare(
            `INSERT INTO room_members
               (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
                member_generation, role_revision, updated_at)
             VALUES (?, ?, 'member', 'active', (SELECT event_seq FROM events WHERE event_key = ?),
                     (SELECT event_seq FROM events WHERE event_key = ?), ?, 1, 1, ?)
             ON CONFLICT(room_id, actor_id) DO UPDATE SET
               status = 'active',
               role = CASE WHEN room_members.status = 'active' THEN room_members.role ELSE 'member' END,
               role_revision = CASE WHEN room_members.status = 'active'
                                    THEN room_members.role_revision ELSE room_members.role_revision + 1 END,
               joined_seq = CASE WHEN room_members.status = 'active'
                                 THEN room_members.joined_seq ELSE excluded.joined_seq END,
               -- 重新加入是新代次的开始：加入前内容不成为未读，阅读水位从
               -- 新加入事件起算。
               last_read_seq = CASE WHEN room_members.status = 'active'
                                    THEN room_members.last_read_seq ELSE excluded.joined_seq END,
               joined_at = CASE WHEN room_members.status = 'active'
                                THEN room_members.joined_at ELSE excluded.joined_at END,
               -- 只有非 active → active 的重新加入才递增代次；active 成员
               -- 的重复添加保持原代次与阅读水位。
               member_generation = CASE WHEN room_members.status = 'active'
                                        THEN room_members.member_generation
                                        ELSE room_members.member_generation + 1 END,
               updated_at = excluded.updated_at`,
          )
          .bind(room.room_id, member, eventKey, eventKey, at, at),
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
      // 直接加人已绕过邀请，移除成员会让旧邀请变成重入后门；两者都在
      // 同一事务撤销该目标的 pending 定向邀请。
      ...add.map((member) =>
        revokeDirectInvitationStatement(db, room.room_id, member, at),
      ),
      ...remove.map((member) =>
        revokeDirectInvitationStatement(db, room.room_id, member, at),
      ),
      // 成员变化只推进 member_seq；不发消息时不能制造没有内容的聊天未读。
      roomMemberVersionStatement(db, room.room_id, eventKey, at),
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
  assertRoomWritable(access.room);
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
      roomDissolvedGuardStatement(db, access.room.room_id),
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

async function policyImpactFor(
  db: D1Database,
  roomId: string,
  previous: RoomPolicies,
  next: RoomPolicies,
): Promise<RoomPolicyImpact> {
  const historyChanged = previous.member_history !== next.member_history;
  let affectedMembers = 0;
  let hiddenFiles = 0;

  if (historyChanged && next.member_history === 'from_join') {
    const memberRow = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM room_members
          WHERE room_id = ? AND status = 'active' AND joined_seq > 0`,
      )
      .bind(roomId)
      .first<{ n: number }>();
    affectedMembers = memberRow?.n ?? 0;
    const fileRow = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM room_files rf
          WHERE rf.room_id = ?
            AND EXISTS (
              SELECT 1 FROM room_members m
               WHERE m.room_id = rf.room_id AND m.status = 'active' AND m.joined_seq > 0
                 AND ((rf.created_seq IS NOT NULL AND rf.created_seq < m.joined_seq)
                   OR (rf.created_seq IS NULL AND rf.created_at < m.joined_at))
            )`,
      )
      .bind(roomId)
      .first<{ n: number }>();
    hiddenFiles = fileRow?.n ?? 0;
  }

  const materialLoss = hiddenFiles > 0;
  let message: string;
  if (historyChanged && next.member_history === 'full') {
    message = '已开启全历史：成员可读取加入前消息与文件；已复制内容无法回收。';
  } else if (historyChanged) {
    message =
      '已收紧为本次加入后历史：加入前内容立即不可见；已复制内容无法回收。' +
      (materialLoss
        ? `有 ${hiddenFiles} 个文件失去访问。`
        : '');
  } else {
    message = '策略已更新；只影响后续操作，不追溯已复制内容。';
  }

  return {
    history_policy: next.member_history,
    affected_members: affectedMembers,
    hidden_files: hiddenFiles,
    material_loss: materialLoss,
    message,
  };
}

/** 群主设置普通成员的发言、邀请、任务、历史、审批与 @所有人 策略。 */
export async function roomPolicySet(
  db: D1Database,
  principal: Principal,
  input: RoomPolicySetInput,
): Promise<RoomPolicySetResult> {
  const caller = actorId(principal);
  const access = await requireGroupAccess(db, input.room_id, caller, 'manage_policy');
  assertRoomWritable(access.room);
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
    member_history: input.member_history_policy ?? previous.member_history,
    member_join: input.member_join_policy ?? previous.member_join,
    member_profile: input.member_profile_policy ?? previous.member_profile,
    member_mention_all: input.member_mention_all_policy ?? previous.member_mention_all,
  };
  const impact = await policyImpactFor(db, access.room.room_id, previous, next);
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
      roomDissolvedGuardStatement(db, access.room.room_id),
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
            impact,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(access.room.room_id), eventKey }, at),
      db
        .prepare(
          `UPDATE rooms
              SET member_message_policy = ?, member_invite_policy = ?,
                  member_history_policy = ?, member_join_policy = ?, member_profile_policy = ?,
                  member_mention_all_policy = ?, policy_revision = policy_revision + 1,
                  updated_at = ?
            WHERE room_id = ?`,
        )
        .bind(
          next.member_message,
          next.member_invite,
          next.member_history,
          next.member_join,
          next.member_profile,
          next.member_mention_all,
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
          detail: { previous, next, impact },
        },
        at,
      ),
    ],
  });

  const detail = await roomDetail(db, access.room.room_id, caller);
  return { ...detail, policy_impact: impact };
}

/** 群主/管理员维护公告；空字符串表示清除。 */
export async function roomAnnouncementSet(
  db: D1Database,
  principal: Principal,
  input: RoomAnnouncementSetInput,
): Promise<RoomDetail> {
  const caller = actorId(principal);
  const access = await requireGroupAccess(db, input.room_id, caller, 'manage_announcement');
  assertRoomWritable(access.room);
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
      roomDissolvedGuardStatement(db, access.room.room_id),
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

export interface RoomLeaveResult {
  room_id: string;
  left: true;
  pending_deliveries: number;
  claimed_deliveries: number;
}

export async function roomLeave(
  db: D1Database,
  principal: Principal,
  input: RoomLeaveInput,
): Promise<RoomLeaveResult> {
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
  // 群主在任何未解散群中都不能直接退群，即使只剩自己一人：否则会留下
  // `owner_id = NULL AND dissolved_at = NULL` 的无主活跃群，旧邀请还能
  // 让外部用户加入。先完成 G05 转移或调用 network_room_dissolve。
  if (room.dissolved_at === null && (room.owner_id === caller || member.role === 'owner')) {
    throw new BusinessError('CONFLICT', '群 owner 不能直接退群；请先转移群 owner 或解散群聊', {
      room_id: room.room_id,
      reason: 'owner_transfer_required',
      owner_transfer_required: true,
      can_dissolve: member.role === 'owner',
    });
  }
  const preview = await roomLeavePreview(db, principal, { room_id: room.room_id });
  if (preview.pending_deliveries > 0 || preview.claimed_deliveries > 0) {
    if (input.confirm_in_flight !== true) {
      throw new BusinessError(
        'CONFLICT',
        '退群会撤销你在该群的待处理投递；请先确认',
        {
          reason: 'in_flight_work',
          pending_deliveries: preview.pending_deliveries,
          claimed_deliveries: preview.claimed_deliveries,
        },
      );
    }
  }

  const at = nowMs();
  const eventKey = `leave:${room.room_id}:${input.request_id}`;
  const payloadHash = await sha256Hex(stableStringify(input));
  const result = {
    room_id: room.room_id,
    left: true as const,
    pending_deliveries: preview.pending_deliveries,
    claimed_deliveries: preview.claimed_deliveries,
  } satisfies RoomLeaveResult;

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      // 无论群内是否还有其他 active 成员，owner 都不能在未解散群退群；
      // 预检查只负责可读错误，提交时按 rooms.owner_id 重新裁决并发。
      db
        .prepare(
          guardSql(
            'ownerTransferRequired',
            'EXISTS (SELECT 1 FROM rooms WHERE room_id = ? AND owner_id = ? AND dissolved_at IS NULL)',
          ),
        )
        .bind(room.room_id, caller),
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
          metadata: {
            room_id: room.room_id,
            actor_id: caller,
            changed_by: caller,
            member_generation: member.member_generation,
            reason: 'member_left',
            // 未来 M09 媒体层据此立即撤销该成员的发布/订阅资格；本任务不实现媒体。
            media_revoke: true,
          },
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
      // 防御性保留：合法路径已经在 guard 中拒绝 owner 退群，因此本语句
      // 不应再被触发。若历史/异常数据仍走到这里，至少不会把并发转移后的
      // 新 owner 置空；非 owner 退群时是空操作。已解散群保留 owner_id
      // 作为归档审计事实。
      db
        .prepare(
          'UPDATE rooms SET owner_id = NULL WHERE room_id = ? AND owner_id = ? AND dissolved_at IS NULL',
        )
        .bind(room.room_id, caller),
      roomMemberVersionStatement(db, room.room_id, eventKey, at),
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

  return result;
}
