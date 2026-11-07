import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  RoomInviteGetInput,
  RoomInviteRespondInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, sortedPairKey, stableStringify } from '../storage/db';
import {
  eventStatement,
  eventStatementIfAbsent,
  inboxHeadStatementIfEvent,
  inboxTopic,
  outboxStatement,
  outboxStatementIfAbsent,
  roomMemberVersionStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, getMember, getOperation, getRoom } from '../storage/queries';
import type { ActorRow, RoomInvitationRow, RoomRow } from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { contactBlockGuardStatement } from './contact-blocks';
import { actorId, type Principal } from './principal';

/**
 * G01 最小定向群邀请。
 *
 * 邀请不是成员：`room_invitations` 单独存储，pending 不进入
 * `room_members`、不计入 `room.member_count`、不占 100 人容量。
 * 本模块只实现定向邀请的读取、接受和拒绝；开放链接、二维码、
 * 审批与撤销由 G02 在同一对象上扩展。
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
  status: 'accepted' | 'rejected';
}

interface InvitationJoinRow extends RoomInvitationRow {
  room_title: string;
  inviter_name: string;
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
          AND i.expires_at > ?
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
 * 为群创建写入定向邀请语句。
 *
 * 返回的邀请对象只用于事务内的 target 集合；调用方必须在同一 batch 中
 * 同时插入邀请行、目标 inbox 事件与 outbox，任何一步失败整批回滚。
 *
 * 插入时重新检查好友关系与拉黑，而不是只依赖提交前的预检：并发解除
 * 好友或拉黑会让该目标的邀请不落库，由调用方按逐对象结果返回，其他
 * 成员的邀请不受影响。
 */
export function directInvitationStatements(
  db: D1Database,
  input: {
    roomId: string;
    inviterId: string;
    targets: string[];
    at: number;
    expiresAt: number;
  },
): { invitations: RoomInvitationRow[]; statements: D1PreparedStatement[] } {
  const invitations: RoomInvitationRow[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const target of input.targets) {
    const invitation: RoomInvitationRow = {
      invitation_id: newId('rinv'),
      room_id: input.roomId,
      inviter_id: input.inviterId,
      target_actor_id: target,
      token_hash: null,
      kind: 'direct',
      status: 'pending',
      max_uses: 1,
      used_count: 0,
      expires_at: input.expiresAt,
      revision: 1,
      created_at: input.at,
      updated_at: input.at,
    };
    invitations.push(invitation);
    statements.push(
      db
        .prepare(
          `INSERT INTO room_invitations
             (invitation_id, room_id, inviter_id, target_actor_id, token_hash, kind, status,
              max_uses, used_count, expires_at, revision, created_at, updated_at)
           SELECT ?, ?, ?, ?, NULL, 'direct', 'pending', 1, 0, ?, 1, ?, ?
            WHERE NOT EXISTS (
                    SELECT 1 FROM contact_blocks
                     WHERE released_at IS NULL
                       AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
                         OR (blocker_actor_id = ? AND blocked_actor_id = ?))
                  )
              AND EXISTS (
                    SELECT 1 FROM contact_relations
                     WHERE pair_key = ? AND status = 'active'
                  )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          invitation.invitation_id,
          invitation.room_id,
          invitation.inviter_id,
          target,
          input.expiresAt,
          input.at,
          input.at,
          input.inviterId,
          target,
          target,
          input.inviterId,
          sortedPairKey(input.inviterId, target),
        ),
    );
  }
  return { invitations, statements };
}

/**
 * 撤销单个目标在该群的 pending 定向邀请。
 *
 * 直接加人后邀请已被绕过，移除成员后旧邀请必须失效；两者都在
 * `roomMembersUpdate` 的同一事务里撤销，避免旧 invitation_id 之后
 * 把 removed 成员重新激活。没有 pending 邀请时是空操作。
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

/**
 * 邀请目标的 inbox 提示；不增加 pending_count，也不创建 delivery。
 *
 * 事件、outbox 与 inbox head 都以邀请行真实落库为前提：并发下定向邀请
 * 可能因关系失效而未写入，此时不能留下指向不存在邀请的提示。
 */
export function invitationInboxStatements(
  db: D1Database,
  invitations: RoomInvitationRow[],
  at: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const invitation of invitations) {
    if (!invitation.target_actor_id) continue;
    const eventKey = `room_invited:${invitation.invitation_id}`;
    statements.push(
      db
        .prepare(
          `INSERT INTO events
             (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
           SELECT 'inbox', ?, 'room_invited', ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM room_invitations WHERE invitation_id = ?
            )
           ON CONFLICT(event_key) DO NOTHING`,
        )
        .bind(
          invitation.target_actor_id,
          invitation.room_id,
          JSON.stringify({
            room_id: invitation.room_id,
            invitation_id: invitation.invitation_id,
            inviter_id: invitation.inviter_id,
            expires_at: String(invitation.expires_at),
          }),
          eventKey,
          at,
          invitation.invitation_id,
        ),
      outboxStatementIfAbsent(
        db,
        { topic: inboxTopic(invitation.target_actor_id), eventKey },
        at,
      ),
      inboxHeadStatementIfEvent(db, invitation.target_actor_id, eventKey, at, 0),
    );
  }
  return statements;
}

function invitationStatus(
  row: Pick<RoomInvitationRow, 'status' | 'expires_at'>,
  at: number,
): RoomInvitationView['status'] {
  if (row.status === 'pending' && row.expires_at <= at) return 'expired';
  return row.status;
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
      `SELECT i.*, r.title AS room_title, a.name AS inviter_name
         FROM room_invitations i
         JOIN rooms r ON r.room_id = i.room_id
         JOIN actors a ON a.actor_id = i.inviter_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.created_at DESC, i.invitation_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<InvitationJoinRow>();
  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      invitation_id: row.invitation_id,
      room_id: row.room_id,
      room_title: row.room_title,
      inviter_id: row.inviter_id,
      inviter_name: row.inviter_name,
      target_actor_id: row.target_actor_id,
      kind: row.kind,
      status: invitationStatus(row, at),
      expires_at: String(row.expires_at),
      created_at: String(row.created_at),
      can_respond: row.status === 'pending' && row.expires_at > at,
    })),
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

async function requireTargetInvitation(
  db: D1Database,
  viewer: string,
  invitationId: string,
): Promise<RoomInvitationRow> {
  const row = await db
    .prepare("SELECT * FROM room_invitations WHERE invitation_id = ? AND kind = 'direct'")
    .bind(invitationId)
    .first<RoomInvitationRow>();
  // 目标不匹配同样返回 NOT_FOUND，避免枚举其他 actor 的邀请。
  if (!row || row.target_actor_id !== viewer) {
    throw new BusinessError('NOT_FOUND', '邀请不存在或不属于当前身份');
  }
  return row;
}

function requirePending(row: RoomInvitationRow, at: number): void {
  if (row.status !== 'pending') {
    throw new BusinessError('CONFLICT', '邀请状态已变化，请刷新后重试', {
      current_state: row.status,
      expected_state: 'pending',
    });
  }
  if (row.expires_at <= at) {
    throw new BusinessError('REQUEST_EXPIRED', '邀请已过期', {
      invitation_id: row.invitation_id,
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
    throw new BusinessError('CONFLICT', '你已被移出该群，不能使用旧邀请重新加入', {
      current_state: 'removed',
      expected_state: 'invited',
    });
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
  const row = await requireTargetInvitation(db, viewer, input.invitation_id);
  requirePending(row, at);
  await requireAcceptTarget(db, principal, row, at);
  const eventKey = `room_invitation_accepted:${row.invitation_id}`;

  const outcome = await runIdempotent(db, {
    actorId: viewer,
    requestId: input.request_id,
    payloadHash,
    result: { invitation_id: row.invitation_id, room_id: row.room_id, status: 'accepted' },
    build: (resultJson) => [
      operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, at),
      // 拉黑必须在事务内复核：预检后、提交前对方可能刚拉黑。
      contactBlockGuardStatement(db, row.inviter_id, viewer),
      db
        .prepare(
          guardSql(
            'invitationStale',
            `EXISTS (
               SELECT 1 FROM room_members
                WHERE room_id = ? AND actor_id = ? AND status IN ('active', 'removed')
             )`,
          ),
        )
        .bind(row.room_id, viewer),
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
              SET status = 'accepted', used_count = used_count + 1,
                  revision = revision + 1, updated_at = ?
            WHERE invitation_id = ? AND status = 'pending'`,
        )
        .bind(at, row.invitation_id),
      db
        .prepare(
          `INSERT INTO room_members
             (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
              role_revision, updated_at)
           VALUES (?, ?, 'member', 'active', (SELECT event_seq FROM events WHERE event_key = ?),
                   0, ?, 1, ?)
           ON CONFLICT(room_id, actor_id) DO UPDATE SET
             status = 'active',
             role = 'member',
             role_revision = room_members.role_revision + 1,
             joined_seq = excluded.joined_seq,
             joined_at = excluded.joined_at,
             updated_at = excluded.updated_at
           WHERE room_members.status <> 'active'`,
        )
        .bind(row.room_id, viewer, eventKey, at, at),
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
          JSON.stringify({ invitation_id: row.invitation_id, via: 'invitation' }),
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
  const row = await requireTargetInvitation(db, viewer, input.invitation_id);
  requirePending(row, at);
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
