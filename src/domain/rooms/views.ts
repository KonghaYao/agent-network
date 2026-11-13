/** rooms.ts 拆分模块：views。纯移动，行为保持不变。 */

import { decodeCursor, encodeCursor } from '../../contracts/cursor';
import { type BusinessErrorCode } from '../../contracts/errors';
import { clampPage, LIMITS } from '../../contracts/limits';
import { type RoomsListInput } from '../../contracts/schemas';
import { nowMs } from '../../storage/db';
import { getMessage, listActiveRoomPeers, visibleActorSql } from '../../storage/queries';
import { type ActorRow, type MessageRow, type RoomManagementAuditRow, type RoomMemberRow, type RoomRow } from '../../storage/rows';
import { manageableAgentIds } from '../agent-access';
import { relationEndedByBlockSql } from '../contact-relations';
import { type OwnerTransferView } from '../owner-transfers';
import { actorId, type Principal } from '../principal';
import { isOwnerMissing, memberActionsFor, roomCapabilitiesFor, roomPolicies, type MemberActions, type RoomCapabilities, type RoomPolicies } from '../room-access';
import { historyBoundary, historySnapshot, visibleMessage, type HistoryBoundary, type HistorySnapshot } from '../room-history';
import { type InvitedMemberView } from '../room-invitations';
import { messagePreviewOf, type MessagePreviewView } from '../views';
import { roomGet } from './detail';

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
   * direct 会话对端 Agent 的查看者权限；仅 direct 房间返回。
   *
   * 只表示当前调用者能否管理该对端 Agent，不暴露 manager_id；群聊不设置，
   * direct 人类对端恒为 false。客户端可据此即时渲染管理动作，无需额外请求。
   */
  peer_can_manage?: boolean;
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

export function messagePreview(row: MessageRow | null): MessagePreviewView | null {
  return messagePreviewOf(row);
}

export function roomView(
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

export async function memberCount(db: D1Database, roomId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'")
    .bind(roomId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function loadRoomView(
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

export async function loadMembers(
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

export interface RoomListRow extends RoomRow {
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
export async function listRoomPeers(
  db: D1Database,
  viewerId: string,
  roomIds: string[],
): Promise<Map<string, RoomPeerView>> {
  if (roomIds.length === 0) return new Map();
  const rows = await listActiveRoomPeers(db, roomIds, viewerId);
  const peers = new Map<string, RoomPeerView>();
  for (const row of rows) {
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

  // 删除好友会同时结束双向关系；无论哪一方发起，双方默认列表都不再展示
  // 该 direct 会话（历史仍可用 `room_get`/`history_list` 显式读取）。拉黑
  // 也结束关系但保留收藏，双方仍可打开会话解除拉黑。
  //
  // 关系表建立前创建的旧 direct 房间可能没有 contact_relations 行，删除好友
  // 只会删掉自己的 contacts 行。此时不能依赖 ended 关系隐藏，否则刷新会把
  // 已删除好友的会话带回列表；改为以调用者自己的收藏作为最后闸门，收藏也
  // 不存在时视为已解除好友并隐藏。
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
        WHERE m.actor_id = ? AND m.status = 'active' AND r.dissolved_at IS NULL
          AND NOT (
            r.kind = 'direct'
            AND (
              EXISTS (
                SELECT 1
                  FROM contact_relations cr
                 WHERE cr.pair_key = r.direct_pair_key
                   AND cr.status = 'ended'
                   AND NOT ${relationEndedByBlockSql(
                     'm.actor_id',
                     '(CASE WHEN cr.actor_a = m.actor_id THEN cr.actor_b ELSE cr.actor_a END)',
                     'cr.ended_at',
                   )}
                   AND (
                     COALESCE(cr.ended_by, '') <> m.actor_id
                     OR NOT EXISTS (
                       SELECT 1
                         FROM contacts c
                        WHERE c.owner_actor_id = m.actor_id
                          AND c.target_actor_id = CASE
                                WHEN cr.actor_a = m.actor_id THEN cr.actor_b ELSE cr.actor_a
                              END
                     )
                   )
              )
              OR (
                NOT EXISTS (
                  SELECT 1
                    FROM contact_relations any_relation
                   WHERE any_relation.pair_key = r.direct_pair_key
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM contacts legacy_contact
                   WHERE legacy_contact.owner_actor_id = m.actor_id
                     AND legacy_contact.target_actor_id = (
                       SELECT peer.actor_id
                         FROM room_members peer
                        WHERE peer.room_id = r.room_id
                          AND peer.status = 'active'
                          AND peer.actor_id <> m.actor_id
                        LIMIT 1
                     )
                )
              )
            )
          )
          ${keyset}
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
  const peerAgentIds = [...peers.values()]
    .filter((peer) => peer.kind === 'agent')
    .map((peer) => peer.actor_id);
  const manageablePeers = await manageableAgentIds(db, id, peerAgentIds, nowMs());
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
    if (row.kind === 'direct') {
      view.peer_can_manage = Boolean(
        view.peer && view.peer.kind === 'agent' && manageablePeers.has(view.peer.actor_id),
      );
    }
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

