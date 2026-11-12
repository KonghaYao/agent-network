import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  RoomInviteGetInput,
  RoomInviteRespondInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  eventStatement,
  eventStatementIfAbsent,
  inboxTopic,
  outboxStatement,
  outboxStatementIfAbsent,
  roomMemberVersionStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, getMember, getOperation, getRoom, visibleActorSql } from '../storage/queries';
import type { ActorRow, RoomInvitationRow, RoomRow } from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { contactBlockGuardStatement } from './contact-blocks';
import { assertRoomWritable, assertOwnerPresent, ownerMissingGuardStatement, roomDissolvedGuardStatement } from './room-access';
import { requestJoinApproval } from './room-join-requests';
import { actorId, type Principal } from './principal';
import { hashSecret } from './secrets';

/**
 * 群邀请兼容层。
 *
 * 人拉人已改为直接加入：`network_room_create`、`network_room_members_update`
 * 与 `network_room_invite_create { target_actor_id }` 都不再产生定向邀请。
 * 本模块保留历史 pending 定向邀请的读取、接受与拒绝，供升级前的数据库行
 * 继续收敛；链接邀请仍由 `room-invite-links` 创建并通过本模块预览与确认。
 * 邀请不是成员：pending 不进入 `room_members`、不计入 `member_count`。
 */

export interface RoomInvitationView {
  invitation_id: string;
  room_id: string;
  room_title: string;
  inviter_id: string;
  inviter_name: string;
  target_actor_id: string | null;
  kind: 'direct' | 'link';
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired' | 'exhausted';
  expires_at: string;
  created_at: string;
  revision: number;
  max_uses: number;
  used_count: number;
  member_count: number;
  requires_approval: boolean;
  next_step:
    | 'join'
    | 'request'
    | 'pending_approval'
    | 'member'
    | 'removed'
    | 'blocked'
    | 'invalid'
    | 'share';
  join_request_status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'expired'
    | null;
  /** 仅当前目标、pending 且未过期时为 true。 */
  can_respond: boolean;
}

export interface RoomInvitationPage {
  items: RoomInvitationView[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface InvitedMemberView {
  invitation_id: string;
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  invited_by: string;
  invited_at: string;
  expires_at: string;
}

export interface RoomInvitationRespondResult {
  invitation_id: string;
  room_id: string;
  status: 'accepted' | 'rejected' | 'requested';
  /** 进入审批流程时返回申请 id；直接加入/拒绝为 null。 */
  join_request_id?: string | null;
}

export interface InvitationJoinRow extends RoomInvitationRow {
  room_title: string;
  inviter_name: string;
  member_count: number;
  member_join_policy: 'open' | 'approval';
  my_member_status: 'active' | 'left' | 'removed' | null;
  member_updated_at: number | null;
  blocked: number;
  join_request_status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'expired'
    | null;
}

/** 群主/管理员可见的待确认成员；普通成员不读取邀请目标。 */
export async function loadInvitedMembers(
  db: D1Database,
  roomId: string,
  at: number,
): Promise<InvitedMemberView[]> {
  const rows = await db
    .prepare(
      `SELECT i.invitation_id, i.target_actor_id AS actor_id, a.kind, a.name,
              i.inviter_id AS invited_by, i.created_at, i.expires_at
         FROM room_invitations i
         JOIN actors a ON a.actor_id = i.target_actor_id
        WHERE i.room_id = ? AND i.kind = 'direct' AND i.status = 'pending'
          AND i.expires_at > ? AND ${visibleActorSql('a')}
        ORDER BY i.created_at ASC, i.invitation_id ASC`,
    )
    .bind(roomId, at)
    .all<{
      invitation_id: string;
      actor_id: string;
      kind: 'human' | 'agent';
      name: string;
      invited_by: string;
      created_at: number;
      expires_at: number;
    }>();
  return rows.results.map((row) => ({
    invitation_id: row.invitation_id,
    actor_id: row.actor_id,
    kind: row.kind,
    name: row.name,
    invited_by: row.invited_by,
    invited_at: String(row.created_at),
    expires_at: String(row.expires_at),
  }));
}

/**
 * 撤销单个目标在该群的 pending 定向邀请。
 *
 * 旧版定向邀请已不再创建，但历史行仍可能存在于升级前的数据库；移除成员
 * 后旧邀请必须失效。两者都在 `roomMembersUpdate` 的同一事务里撤销，避免
 * 旧 invitation_id 之后把 removed 成员重新激活。没有 pending 邀请时是空操作。
 */
export function revokeDirectInvitationStatement(
  db: D1Database,
  roomId: string,
  targetActorId: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE room_invitations
          SET status = 'revoked', revision = revision + 1, updated_at = ?
        WHERE room_id = ? AND target_actor_id = ? AND kind = 'direct' AND status = 'pending'`,
    )
    .bind(at, roomId, targetActorId);
}

function invitationStatus(
  row: Pick<RoomInvitationRow, 'status' | 'expires_at' | 'used_count' | 'max_uses'>,
  at: number,
): RoomInvitationView['status'] {
  if (row.status === 'pending' && row.expires_at <= at) return 'expired';
  if (row.status === 'pending' && row.used_count >= row.max_uses) return 'exhausted';
  return row.status;
}

/**
 * 邀请视图的唯一出口。
 *
 * `share` 用于管理员查看本群链接：next_step 固定为 share，避免把管理员
 * 自己显示成可以加入的目标。其余场景按当前身份、拉黑与审批策略计算。
 */
export function invitationView(
  row: InvitationJoinRow,
  at: number,
  options: { share?: boolean } = {},
): RoomInvitationView {
  const status = invitationStatus(row, at);
  const requiresApproval = row.member_join_policy === 'approval';
  let nextStep: RoomInvitationView['next_step'];
  if (options.share) {
    nextStep = status === 'pending' ? 'share' : 'invalid';
  } else if (status !== 'pending') {
    nextStep = 'invalid';
  } else if (row.my_member_status === 'active') {
    nextStep = 'member';
  } else if (row.my_member_status === 'removed') {
    // 定向邀请只有在移除后新建才有效；链接永远不能绕过移除。
    nextStep =
      row.kind === 'direct' && row.created_at >= (row.member_updated_at ?? row.created_at)
        ? requiresApproval
          ? 'request'
          : 'join'
        : 'removed';
  } else if (row.blocked > 0) {
    nextStep = 'blocked';
  } else if (row.join_request_status === 'pending') {
    nextStep = 'pending_approval';
  } else if (requiresApproval) {
    nextStep = 'request';
  } else {
    nextStep = 'join';
  }
  return {
    invitation_id: row.invitation_id,
    room_id: row.room_id,
    room_title: row.room_title,
    inviter_id: row.inviter_id,
    inviter_name: row.inviter_name,
    target_actor_id: row.target_actor_id,
    kind: row.kind,
    status,
    expires_at: String(row.expires_at),
    created_at: String(row.created_at),
    revision: row.revision,
    max_uses: row.max_uses,
    used_count: row.used_count,
    member_count: row.member_count,
    requires_approval: requiresApproval,
    next_step: nextStep,
    join_request_status: row.join_request_status,
    can_respond:
      status === 'pending' &&
      nextStep !== 'member' &&
      nextStep !== 'removed' &&
      nextStep !== 'blocked' &&
      nextStep !== 'invalid',
  };
}

export async function roomInvitationList(
  db: D1Database,
  principal: Principal,
  input: RoomInviteGetInput,
): Promise<RoomInvitationPage> {
  const viewer = actorId(principal);
  const at = nowMs();
  const scope = `room_invitations:${viewer}`;
  const limit = clampPage(
    input.limit,
    LIMITS.roomInvitationsPageDefault,
    LIMITS.roomInvitationsPageMax,
  );
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const where: string[] = ["i.target_actor_id = ?", "i.kind = 'direct'"];
  const binds: unknown[] = [viewer];
  if (input.invitation_id) {
    where.push('i.invitation_id = ?');
    binds.push(input.invitation_id);
  }
  if (input.status === 'expired') {
    // 过期是读取时计算的派生状态，数据库仍保存 pending。
    where.push("i.status = 'pending'", 'i.expires_at <= ?');
    binds.push(at);
  } else if (input.status === 'pending') {
    where.push("i.status = 'pending'", 'i.expires_at > ?');
    binds.push(at);
  } else if (input.status) {
    where.push('i.status = ?');
    binds.push(input.status);
  }
  if (cursor) {
    where.push('(i.created_at < ? OR (i.created_at = ? AND i.invitation_id < ?))');
    binds.push(cursor.seq, cursor.seq, cursor.key ?? '');
  }
  const rows = await db
    .prepare(
      `SELECT i.*, r.title AS room_title, a.name AS inviter_name,
              r.member_join_policy,
              (SELECT COUNT(*) FROM room_members mm
                WHERE mm.room_id = i.room_id AND mm.status = 'active') AS member_count,
              (SELECT mm.status FROM room_members mm
                WHERE mm.room_id = i.room_id AND mm.actor_id = ?) AS my_member_status,
              (SELECT mm.updated_at FROM room_members mm
                WHERE mm.room_id = i.room_id AND mm.actor_id = ?) AS member_updated_at,
              EXISTS (
                SELECT 1 FROM contact_blocks b
                 WHERE b.released_at IS NULL
                   AND ((b.blocker_actor_id = i.inviter_id AND b.blocked_actor_id = ?)
                     OR (b.blocker_actor_id = ? AND b.blocked_actor_id = i.inviter_id))
              ) AS blocked,
              (SELECT jr.status FROM room_join_requests jr
                WHERE jr.invitation_id = i.invitation_id AND jr.applicant_id = ?
                ORDER BY jr.created_at DESC LIMIT 1) AS join_request_status
         FROM room_invitations i
         JOIN rooms r ON r.room_id = i.room_id
         JOIN actors a ON a.actor_id = i.inviter_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC, i.invitation_id DESC
        LIMIT ?`,
    )
    .bind(viewer, viewer, viewer, viewer, viewer, ...binds, limit + 1)
    .all<InvitationJoinRow>();
  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((row) => invitationView(row, at)),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.invitation_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

/** 邀请链接 key 的域分隔摘要；数据库只保存该值，原文只在创建响应出现一次。 */
export function hashRoomInviteKey(key: string): Promise<string> {
  return hashSecret('room-invite', key);
}

async function requireInvitationForRespondent(
  db: D1Database,
  viewer: string,
  invitationId: string,
  inviteKey: string | undefined,
): Promise<RoomInvitationRow> {
  const row = await db
    .prepare('SELECT * FROM room_invitations WHERE invitation_id = ?')
    .bind(invitationId)
    .first<RoomInvitationRow>();
  if (!row) {
    throw new BusinessError('NOT_FOUND', '邀请不存在或不属于当前身份');
  }
  if (row.kind === 'direct') {
    // 目标不匹配同样返回 NOT_FOUND，避免枚举其他 actor 的邀请。
    if (row.target_actor_id !== viewer) {
      throw new BusinessError('NOT_FOUND', '邀请不存在或不属于当前身份');
    }
    return row;
  }
  // 链接是持有者能力：必须同时出示与摘要匹配的明文 key，单独猜中内部
  // invitation_id 不能加入，也不能读取邀请人身份。
  if (!inviteKey || !row.token_hash) {
    throw new BusinessError('NOT_FOUND', '邀请链接无效或已失效');
  }
  const digest = await hashRoomInviteKey(inviteKey);
  if (digest !== row.token_hash) {
    throw new BusinessError('NOT_FOUND', '邀请链接无效或已失效');
  }
  return row;
}

function requirePending(row: RoomInvitationRow, at: number): void {
  if (row.expires_at <= at) {
    throw new BusinessError('REQUEST_EXPIRED', '邀请已过期', {
      invitation_id: row.invitation_id,
    });
  }
  // 链接用尽后状态落库为 exhausted；用尽与撤销/拒绝要返回不同错误码，
  // 客户端才能区分“换新链接”与“状态已变化”。
  if (row.kind === 'link' && (row.status === 'exhausted' || row.used_count >= row.max_uses)) {
    throw new BusinessError('INVITE_EXHAUSTED', '邀请次数已用尽', {
      invitation_id: row.invitation_id,
    });
  }
  if (row.status !== 'pending') {
    throw new BusinessError('CONFLICT', '邀请状态已变化，请刷新后重试', {
      current_state: row.status,
      expected_state: 'pending',
    });
  }
}

async function requireAcceptTarget(
  db: D1Database,
  principal: Principal,
  row: RoomInvitationRow,
  at: number,
): Promise<{ room: RoomRow; actor: ActorRow }> {
  const viewer = actorId(principal);
  const room = await getRoom(db, row.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '邀请对应的群不存在');
  if (room.kind !== 'group') {
    throw new BusinessError('INVALID_ARGUMENT', '只有群聊支持邀请');
  }
  const actor = await getActor(db, viewer);
  if (!actor) throw new BusinessError('NOT_FOUND', '当前身份不存在');
  if (actor.disabled_at !== null) {
    throw new BusinessError('ACTOR_DISABLED', '当前身份已停用，不能接受邀请');
  }
  const member = await getMember(db, row.room_id, viewer);
  if (member?.status === 'removed') {
    // 移除会在同一事务撤销该目标的全部 pending 定向邀请，因此仍存在的
    // 定向邀请只可能是移除后由 owner/admin 新建的批准入口；链接永远
    // 不能作为移除后的重入后门。
    const freshDirect = row.kind === 'direct' && row.created_at >= member.updated_at;
    if (!freshDirect) {
      throw new BusinessError('CONFLICT', '你已被移出该群，不能使用旧邀请重新加入', {
        current_state: 'removed',
        expected_state: 'invited',
      });
    }
  }
  if (member?.status === 'active') {
    throw new BusinessError('CONFLICT', '你已经是该群成员', {
      current_state: 'active',
      expected_state: 'invited',
    });
  }
  return { room, actor };
}

/**
 * 接受定向邀请。
 *
 * 容量、邀请状态、有效期与目标资格都在同一 batch 内重新判定：
 * 并发接受同一邀请只有一个成功；100 人上限只允许合法数量进入。
 */
export async function roomInvitationAccept(
  db: D1Database,
  principal: Principal,
  input: RoomInviteRespondInput,
): Promise<RoomInvitationRespondResult> {
  const viewer = actorId(principal);
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  // 先回放已提交结果：接受后状态已变、成员已生效，不能再用前置校验拒绝重试。
  const replay = await getOperation(db, viewer, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as RoomInvitationRespondResult;
  const row = await requireInvitationForRespondent(
    db,
    viewer,
    input.invitation_id,
    input.invite_key,
  );
  requirePending(row, at);
  const { room } = await requireAcceptTarget(db, principal, row, at);
  assertRoomWritable(room);
  // 遗留无主群不再接受任何邀请加入；事务 guard 在提交时复核。
  assertOwnerPresent(room);
  if (room.member_join_policy === 'approval') {
    // G07 的审批策略在邀请接受路径强制执行：确认后先进入申请列表，
    // 不是成员；邀请本身保持 pending，由批准事务消费次数。
    const request = await requestJoinApproval(db, {
      principal,
      invitation: row,
      at,
      requestId: input.request_id,
      payloadHash,
      expectedPolicyRevision: room.policy_revision,
    });
    return {
      invitation_id: row.invitation_id,
      room_id: row.room_id,
      status: 'requested',
      join_request_id: request.join_request_id,
    };
  }
  const eventKey = `room_invitation_accepted:${row.invitation_id}`;

  const outcome = await runIdempotent(db, {
    actorId: viewer,
    requestId: input.request_id,
    payloadHash,
    result: { invitation_id: row.invitation_id, room_id: row.room_id, status: 'accepted' },
    build: (resultJson) => [
      operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, row.room_id),
      ownerMissingGuardStatement(db, row.room_id),
      db
        .prepare(
          guardSql(
            'policyRevision',
            "NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = ? AND policy_revision = ? AND member_join_policy = 'open')",
          ),
        )
        .bind(row.room_id, room.policy_revision),
      // 拉黑必须在事务内复核：预检后、提交前对方可能刚拉黑。
      contactBlockGuardStatement(db, row.inviter_id, viewer),
      db
        .prepare(
          guardSql(
            'invitationStale',
            `EXISTS (
               SELECT 1 FROM room_members
                WHERE room_id = ? AND actor_id = ?
                  AND status = 'active'
             )
             OR EXISTS (
               SELECT 1 FROM room_members
                WHERE room_id = ? AND actor_id = ? AND status = 'removed'
                  AND NOT EXISTS (
                    SELECT 1 FROM room_invitations
                     WHERE invitation_id = ? AND kind = 'direct'
                       AND created_at >= room_members.updated_at
                  )
             )`,
          ),
        )
        .bind(row.room_id, viewer, row.room_id, viewer, row.invitation_id),
      db
        .prepare(
          guardSql(
            'invitationStale',
            `NOT EXISTS (
               SELECT 1 FROM room_invitations
                WHERE invitation_id = ? AND status = 'pending'
                  AND (
                    (kind = 'direct' AND target_actor_id = ?)
                    OR kind = 'link'
                  )
             )`,
          ),
        )
        .bind(row.invitation_id, viewer),
      db
        .prepare(
          guardSql(
            'inviteExhausted',
            'EXISTS (SELECT 1 FROM room_invitations WHERE invitation_id = ? AND used_count >= max_uses)',
          ),
        )
        .bind(row.invitation_id),
      db
        .prepare(
          guardSql(
            'requestExpired',
            'EXISTS (SELECT 1 FROM room_invitations WHERE invitation_id = ? AND expires_at <= ?)',
          ),
        )
        .bind(row.invitation_id, at),
      db
        .prepare(
          guardSql(
            'roomFull',
            '(SELECT COUNT(*) FROM room_members WHERE room_id = ? AND status = \'active\') >= ?',
          ),
        )
        .bind(row.room_id, LIMITS.groupMembersMax),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: row.room_id,
          eventType: 'room_invitation_accepted',
          refId: row.room_id,
          metadata: {
            invitation_id: row.invitation_id,
            actor_id: viewer,
            inviter_id: row.inviter_id,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(row.room_id), eventKey }, at),
      db
        .prepare(
          `UPDATE room_invitations
              SET used_count = used_count + 1,
                  status = CASE
                    WHEN kind = 'link' AND used_count + 1 < max_uses THEN 'pending'
                    WHEN kind = 'link' THEN 'exhausted'
                    ELSE 'accepted'
                  END,
                  revision = revision + 1, updated_at = ?
            WHERE invitation_id = ? AND status = 'pending'`,
        )
        .bind(at, row.invitation_id),
      db
        .prepare(
          `INSERT INTO room_members
             (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
              member_generation, role_revision, updated_at)
           VALUES (?, ?, 'member', 'active', (SELECT event_seq FROM events WHERE event_key = ?),
                    (SELECT event_seq FROM events WHERE event_key = ?), ?, 1, 1, ?)
           ON CONFLICT(room_id, actor_id) DO UPDATE SET
             status = 'active',
             role = 'member',
             role_revision = room_members.role_revision + 1,
             joined_seq = excluded.joined_seq,
             last_read_seq = excluded.joined_seq,
             joined_at = excluded.joined_at,
             member_generation = room_members.member_generation + 1,
             updated_at = excluded.updated_at
           WHERE room_members.status <> 'active'`,
        )
        .bind(row.room_id, viewer, eventKey, eventKey, at, at),
      db
        .prepare(
          `INSERT INTO room_management_audit
             (audit_id, room_id, action, target_actor_id, previous_role, new_role,
              previous_status, new_status, expected_revision, resulting_revision,
              changed_by, request_id, detail_json, created_at)
           VALUES (?, ?, 'member_added', ?, NULL, 'member', NULL, 'active', NULL, 1, ?, ?, ?, ?)`,
        )
        .bind(
          newId('raud'),
          row.room_id,
          viewer,
          viewer,
          input.request_id,
          JSON.stringify({
            invitation_id: row.invitation_id,
            invitation_kind: row.kind,
            via: 'invitation',
          }),
          at,
        ),
      roomMemberVersionStatement(db, row.room_id, eventKey, at),
      eventStatementIfAbsent(
        db,
        {
          eventKey: `${eventKey}:inviter`,
          scopeKind: 'inbox',
          scopeId: row.inviter_id,
          eventType: 'room_invitation_accepted',
          refId: row.room_id,
          metadata: { invitation_id: row.invitation_id, actor_id: viewer },
        },
        at,
      ),
      outboxStatementIfAbsent(
        db,
        { topic: inboxTopic(row.inviter_id), eventKey: `${eventKey}:inviter` },
        at,
      ),
      db
        .prepare(
          `UPDATE actors
              SET inbox_head_seq = MAX(inbox_head_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
                  updated_at = ?
            WHERE actor_id = ?`,
        )
        .bind(`${eventKey}:inviter`, at, row.inviter_id),
    ],
  });
  return outcome as RoomInvitationRespondResult;
}

/** 拒绝定向邀请；重复拒绝返回同一 request_id 的首次结果。 */
export async function roomInvitationReject(
  db: D1Database,
  principal: Principal,
  input: RoomInviteRespondInput,
): Promise<RoomInvitationRespondResult> {
  const viewer = actorId(principal);
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await getOperation(db, viewer, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as RoomInvitationRespondResult;
  const row = await requireInvitationForRespondent(
    db,
    viewer,
    input.invitation_id,
    input.invite_key,
  );
  requirePending(row, at);
  if (row.kind === 'link') {
    // 链接是共享入口：打开者拒绝只代表自己不加入，不能把所有人的链接
    // 置为 rejected。仅记录幂等结果，邀请保持 pending。
    const result: RoomInvitationRespondResult = {
      invitation_id: row.invitation_id,
      room_id: row.room_id,
      status: 'rejected',
      join_request_id: null,
    };
    await runIdempotent(db, {
      actorId: viewer,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, nowMs()),
      ],
    });
    return result;
  }
  const eventKey = `room_invitation_rejected:${row.invitation_id}`;
  const outcome = await runIdempotent(db, {
    actorId: viewer,
    requestId: input.request_id,
    payloadHash,
    result: { invitation_id: row.invitation_id, room_id: row.room_id, status: 'rejected' },
    build: (resultJson) => [
      operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'invitationStale',
            `NOT EXISTS (
               SELECT 1 FROM room_invitations
                WHERE invitation_id = ? AND status = 'pending' AND target_actor_id = ?
             )`,
          ),
        )
        .bind(row.invitation_id, viewer),
      db
        .prepare(
          guardSql(
            'requestExpired',
            'EXISTS (SELECT 1 FROM room_invitations WHERE invitation_id = ? AND expires_at <= ?)',
          ),
        )
        .bind(row.invitation_id, at),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: row.room_id,
          eventType: 'room_invitation_rejected',
          refId: row.room_id,
          metadata: { invitation_id: row.invitation_id, actor_id: viewer },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(row.room_id), eventKey }, at),
      db
        .prepare(
          `UPDATE room_invitations
              SET status = 'rejected', revision = revision + 1, updated_at = ?
            WHERE invitation_id = ? AND status = 'pending'`,
        )
        .bind(at, row.invitation_id),
      eventStatementIfAbsent(
        db,
        {
          eventKey: `${eventKey}:inviter`,
          scopeKind: 'inbox',
          scopeId: row.inviter_id,
          eventType: 'room_invitation_rejected',
          refId: row.room_id,
          metadata: { invitation_id: row.invitation_id },
        },
        at,
      ),
      outboxStatementIfAbsent(
        db,
        { topic: inboxTopic(row.inviter_id), eventKey: `${eventKey}:inviter` },
        at,
      ),
      db
        .prepare(
          `UPDATE actors
              SET inbox_head_seq = MAX(inbox_head_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
                  updated_at = ?
            WHERE actor_id = ?`,
        )
        .bind(`${eventKey}:inviter`, at, row.inviter_id),
    ],
  });
  return outcome as RoomInvitationRespondResult;
}
