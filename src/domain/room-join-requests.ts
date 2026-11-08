import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  RoomJoinRequestListInput,
  RoomJoinRequestRespondInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  eventStatement,
  inboxHeadStatement,
  inboxTopic,
  outboxStatement,
  roomMemberVersionStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, getMember, getOperation, getRoom } from '../storage/queries';
import type { RoomInvitationRow, RoomJoinRequestRow } from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { contactBlockGuardStatement, isBlockedBetween } from './contact-blocks';
import { capabilityGuardStatement, assertOwnerPresent, assertRoomWritable, requireGroupAccess, ownerMissingGuardStatement, roomDissolvedGuardStatement } from './room-access';
import { roomAuditStatement } from './room-audit';
import { actorId, type Principal } from './principal';

/**
 * G02 入群申请：邀请确认与审批是同一授权链的两段。
 *
 * - `requestJoinApproval` 由邀请接受路径调用：群策略为 `approval` 时，
 *   确认邀请只创建 pending 申请，不写 `room_members`、不消费邀请次数。
 * - `roomJoinRequestRespond` 由 owner/admin 调用：批准时在同一事务重新
 *   检查邀请状态、有效期、次数、拉黑、移除状态与 100 人容量，然后消费
 *   一次邀请并写入 active 成员；申请 pending 永远不等于成员。
 */

export interface JoinRequestCreationResult {
  join_request_id: string;
  status: 'pending';
}

export interface JoinRequestView {
  join_request_id: string;
  invitation_id: string;
  room_id: string;
  invitation_kind: 'direct' | 'link';
  applicant: {
    actor_id: string;
    kind: 'human' | 'agent';
    name: string;
    agent_session_id: string | null;
  };
  status: RoomJoinRequestRow['status'];
  message: string;
  revision: number;
  created_at: string;
  expires_at: string;
  can_approve: boolean;
  can_reject: boolean;
}

export interface JoinRequestPage {
  items: JoinRequestView[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface JoinRequestRespondResult {
  join_request_id: string;
  invitation_id: string;
  room_id: string;
  status: 'approved' | 'rejected';
}

interface JoinRequestJoinRow extends RoomJoinRequestRow {
  invitation_kind: 'direct' | 'link';
  invitation_status: RoomInvitationRow['status'];
  invitation_expires_at: number;
  invitation_max_uses: number;
  invitation_used_count: number;
  applicant_kind: 'human' | 'agent';
  applicant_name: string;
  applicant_session_id: string | null;
}

function derivedRequestStatus(
  row: Pick<
    JoinRequestJoinRow,
    'status' | 'invitation_status' | 'invitation_expires_at' | 'invitation_used_count' | 'invitation_max_uses'
  >,
  at: number,
): RoomJoinRequestRow['status'] {
  if (row.status !== 'pending') return row.status;
  if (row.invitation_status !== 'pending') return 'expired';
  if (row.invitation_expires_at <= at) return 'expired';
  if (row.invitation_used_count >= row.invitation_max_uses) return 'expired';
  return 'pending';
}

function joinRequestView(row: JoinRequestJoinRow, at: number): JoinRequestView {
  const status = derivedRequestStatus(row, at);
  return {
    join_request_id: row.join_request_id,
    invitation_id: row.invitation_id,
    room_id: row.room_id,
    invitation_kind: row.invitation_kind,
    applicant: {
      actor_id: row.applicant_id,
      kind: row.applicant_kind,
      name: row.applicant_name,
      agent_session_id: row.applicant_session_id,
    },
    status,
    message: row.message,
    revision: row.revision,
    created_at: String(row.created_at),
    expires_at: String(row.invitation_expires_at),
    can_approve: status === 'pending',
    can_reject: status === 'pending',
  };
}

/** 事务内复核对申请人成员状态：active 或“移除后未获新定向邀请”一律拒绝。 */
function joinMembershipGuardStatement(
  db: D1Database,
  roomId: string,
  applicantId: string,
  invitationId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'invitationStale',
        `EXISTS (
           SELECT 1 FROM room_members
            WHERE room_id = ? AND actor_id = ? AND status = 'active'
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
    .bind(roomId, applicantId, roomId, applicantId, invitationId);
}

/** 消费一次邀请：链接达到上限时置 exhausted，定向邀请置 accepted。 */
function consumeInvitationStatement(
  db: D1Database,
  invitationId: string,
  at: number,
): D1PreparedStatement {
  return db
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
    .bind(at, invitationId);
}

function invitationUsableGuards(
  db: D1Database,
  invitationId: string,
  at: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        guardSql(
          'invitationStale',
          `NOT EXISTS (
             SELECT 1 FROM room_invitations
              WHERE invitation_id = ? AND status = 'pending'
           )`,
        ),
      )
      .bind(invitationId),
    db
      .prepare(
        guardSql(
          'requestExpired',
          'EXISTS (SELECT 1 FROM room_invitations WHERE invitation_id = ? AND expires_at <= ?)',
        ),
      )
      .bind(invitationId, at),
    db
      .prepare(
        guardSql(
          'inviteExhausted',
          'EXISTS (SELECT 1 FROM room_invitations WHERE invitation_id = ? AND used_count >= max_uses)',
        ),
      )
      .bind(invitationId),
  ];
}

/**
 * 群策略为 approval 时，确认邀请只创建 pending 申请。
 *
 * 重复确认收敛到同一条 pending 申请；被拒绝后不能再刷申请，必须由
 * owner/admin 重新邀请。申请本身不占用容量，批准时再检查。
 */
export async function requestJoinApproval(
  db: D1Database,
  input: {
    principal: Principal;
    invitation: RoomInvitationRow;
    at: number;
    requestId: string;
    payloadHash: string;
  },
): Promise<JoinRequestCreationResult> {
  const applicant = actorId(input.principal);
  const { invitation, at } = input;
  const latest = await db
    .prepare(
      `SELECT * FROM room_join_requests
        WHERE invitation_id = ? AND applicant_id = ?
        ORDER BY created_at DESC, join_request_id DESC LIMIT 1`,
    )
    .bind(invitation.invitation_id, applicant)
    .first<RoomJoinRequestRow>();
  if (latest?.status === 'pending') {
    return { join_request_id: latest.join_request_id, status: 'pending' };
  }
  if (latest?.status === 'rejected') {
    throw new BusinessError('CONFLICT', '入群申请已被拒绝，请等待管理员重新邀请', {
      current_state: 'rejected',
      expected_state: 'pending',
    });
  }

  const joinRequestId = newId('jrq');
  const eventKey = `room_join_requested:${joinRequestId}`;
  const result: JoinRequestCreationResult = {
    join_request_id: joinRequestId,
    status: 'pending',
  };
  const admins = await db
    .prepare(
      `SELECT actor_id FROM room_members
        WHERE room_id = ? AND status = 'active' AND role IN ('owner', 'admin')`,
    )
    .bind(invitation.room_id)
    .all<{ actor_id: string }>();

  const inboxStatements = admins.results.flatMap((admin) => {
    const inboxKey = `${eventKey}:${admin.actor_id}`;
    return [
      eventStatement(
        db,
        {
          eventKey: inboxKey,
          scopeKind: 'inbox',
          scopeId: admin.actor_id,
          eventType: 'room_join_requested',
          refId: invitation.room_id,
          metadata: {
            room_id: invitation.room_id,
            invitation_id: invitation.invitation_id,
            join_request_id: joinRequestId,
            applicant_id: applicant,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: inboxTopic(admin.actor_id), eventKey: inboxKey }, at),
      inboxHeadStatement(db, admin.actor_id, inboxKey, at, 0),
    ];
  });

  await runIdempotent(db, {
    actorId: applicant,
    requestId: input.requestId,
    payloadHash: input.payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, applicant, input.requestId, input.payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, invitation.room_id),
      ownerMissingGuardStatement(db, invitation.room_id),
      contactBlockGuardStatement(db, invitation.inviter_id, applicant),
      ...invitationUsableGuards(db, invitation.invitation_id, at),
      joinMembershipGuardStatement(
        db,
        invitation.room_id,
        applicant,
        invitation.invitation_id,
      ),
      db
        .prepare(
          `INSERT INTO room_join_requests
             (join_request_id, invitation_id, room_id, applicant_id, status, message,
              revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', '', 1, ?, ?)`,
        )
        .bind(
          joinRequestId,
          invitation.invitation_id,
          invitation.room_id,
          applicant,
          at,
          at,
        ),
      roomAuditStatement(
        db,
        {
          roomId: invitation.room_id,
          action: 'join_requested',
          targetActorId: applicant,
          resultingRevision: 1,
          changedBy: applicant,
          requestId: input.requestId,
          detail: {
            invitation_id: invitation.invitation_id,
            invitation_kind: invitation.kind,
            join_request_id: joinRequestId,
          },
        },
        at,
      ),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: invitation.room_id,
          eventType: 'room_join_requested',
          refId: invitation.room_id,
          metadata: {
            invitation_id: invitation.invitation_id,
            join_request_id: joinRequestId,
            applicant_id: applicant,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(invitation.room_id), eventKey }, at),
      ...inboxStatements,
    ],
    onUniqueConflict: async (error) => {
      const text = String(error);
      if (!text.includes('room_join_requests.invitation_id')) return undefined;
      const pending = await db
        .prepare(
          `SELECT join_request_id FROM room_join_requests
            WHERE invitation_id = ? AND applicant_id = ? AND status = 'pending'`,
        )
        .bind(invitation.invitation_id, applicant)
        .first<{ join_request_id: string }>();
      return pending
        ? { join_request_id: pending.join_request_id, status: 'pending' }
        : undefined;
    },
  });
  return result;
}

/** 分页读取入群申请；只有 owner/admin 能读取。 */
export async function roomJoinRequestList(
  db: D1Database,
  principal: Principal,
  input: RoomJoinRequestListInput,
): Promise<JoinRequestPage> {
  const viewer = actorId(principal);
  await requireGroupAccess(db, input.room_id, viewer, 'approve_joins');
  const at = nowMs();
  const status = input.status ?? 'pending';
  const scope = `room_join_requests:${input.room_id}:${status}`;
  const limit = clampPage(
    input.limit,
    LIMITS.roomJoinRequestsPageDefault,
    LIMITS.roomJoinRequestsPageMax,
  );
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const where = ['jr.room_id = ?', 'jr.status = ?'];
  const binds: unknown[] = [input.room_id, status];
  if (cursor) {
    where.push('(jr.created_at < ? OR (jr.created_at = ? AND jr.join_request_id < ?))');
    binds.push(cursor.seq, cursor.seq, cursor.key ?? '');
  }
  const rows = await db
    .prepare(
      `SELECT jr.*, i.kind AS invitation_kind, i.status AS invitation_status,
              i.expires_at AS invitation_expires_at,
              i.max_uses AS invitation_max_uses,
              i.used_count AS invitation_used_count,
              a.kind AS applicant_kind, a.name AS applicant_name,
              a.agent_session_id AS applicant_session_id
         FROM room_join_requests jr
         JOIN room_invitations i ON i.invitation_id = jr.invitation_id
         JOIN actors a ON a.actor_id = jr.applicant_id
        WHERE ${where.join(' AND ')}
        ORDER BY jr.created_at DESC, jr.join_request_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<JoinRequestJoinRow>();
  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((row) => joinRequestView(row, at)),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.join_request_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

async function loadJoinRequest(
  db: D1Database,
  joinRequestId: string,
): Promise<RoomJoinRequestRow> {
  const row = await db
    .prepare('SELECT * FROM room_join_requests WHERE join_request_id = ?')
    .bind(joinRequestId)
    .first<RoomJoinRequestRow>();
  if (!row) throw new BusinessError('NOT_FOUND', '入群申请不存在');
  return row;
}

async function loadInvitation(
  db: D1Database,
  invitationId: string,
): Promise<RoomInvitationRow> {
  const row = await db
    .prepare('SELECT * FROM room_invitations WHERE invitation_id = ?')
    .bind(invitationId)
    .first<RoomInvitationRow>();
  if (!row) throw new BusinessError('NOT_FOUND', '邀请不存在');
  return row;
}

/** 申请人是群成员时提示申请人本人，而不是把责任推给审批人。 */
function requireApplicantCanJoin(
  member: Awaited<ReturnType<typeof getMember>>,
  invitation: RoomInvitationRow,
): void {
  if (member?.status === 'active') {
    throw new BusinessError('CONFLICT', '申请人已经是该群成员', {
      current_state: 'active',
      expected_state: 'pending',
    });
  }
  if (member?.status === 'removed') {
    const freshDirect =
      invitation.kind === 'direct' && invitation.created_at >= member.updated_at;
    if (!freshDirect) {
      throw new BusinessError('CONFLICT', '申请人已被移出该群，旧邀请不能再用于加入', {
        current_state: 'removed',
        expected_state: 'pending',
      });
    }
  }
}

/**
 * 批准/拒绝入群申请。
 *
 * 批准是唯一把 pending 申请变成 active 成员的入口；容量、邀请次数、
 * 有效期、拉黑与移除状态都在同一 batch 内重新判定，并发批准同一申请
 * 只有一个成功，失败方整批回滚。
 */
export async function roomJoinRequestRespond(
  db: D1Database,
  principal: Principal,
  input: RoomJoinRequestRespondInput,
): Promise<JoinRequestRespondResult> {
  const caller = actorId(principal);
  const row = await loadJoinRequest(db, input.join_request_id);
  // 先鉴权再重放：撤销管理员后，旧 request_id 不能返回成功。
  await requireGroupAccess(db, row.room_id, caller, 'approve_joins');
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as JoinRequestRespondResult;

  const at = nowMs();
  if (row.status !== 'pending') {
    throw new BusinessError('CONFLICT', '入群申请状态已变化，请刷新后重试', {
      current_state: row.status,
      expected_state: 'pending',
    });
  }
  if (
    input.expected_revision !== undefined &&
    row.revision !== input.expected_revision
  ) {
    throw new BusinessError('VERSION_CONFLICT', '入群申请版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      actual: row.revision,
    });
  }
  const invitation = await loadInvitation(db, row.invitation_id);
  const applicant = await getActor(db, row.applicant_id);
  if (!applicant) throw new BusinessError('NOT_FOUND', '申请人不存在');
  const room = await getRoom(db, row.room_id);
  if (!room || room.kind !== 'group') {
    throw new BusinessError('INVALID_ARGUMENT', '只有群聊支持入群申请');
  }
  assertRoomWritable(room);

  const action = input.action;
  if (action === 'approve') {
    // 遗留无主群不再通过批准入群申请增加成员；拒绝仍允许用于清理。
    assertOwnerPresent(room);
    const member = await getMember(db, row.room_id, row.applicant_id);
    requireApplicantCanJoin(member, invitation);
    if (await isBlockedBetween(db, invitation.inviter_id, row.applicant_id)) {
      throw new BusinessError('BLOCKED', '申请人或邀请人已拉黑，不能批准入群');
    }
  }

  const eventKey = `room_join_${action === 'approve' ? 'approved' : 'rejected'}:${row.join_request_id}`;
  const result: JoinRequestRespondResult = {
    join_request_id: row.join_request_id,
    invitation_id: row.invitation_id,
    room_id: row.room_id,
    status: action === 'approve' ? 'approved' : 'rejected',
  };
  const revisionGuard =
    input.expected_revision === undefined
      ? []
      : [
          db
            .prepare(
              guardSql(
                'joinRequestStale',
                `NOT EXISTS (
                   SELECT 1 FROM room_join_requests
                    WHERE join_request_id = ? AND status = 'pending' AND revision = ?
                 )`,
              ),
            )
            .bind(row.join_request_id, input.expected_revision),
        ];
  const staleGuard = db
    .prepare(
      guardSql(
        'joinRequestStale',
        `NOT EXISTS (
           SELECT 1 FROM room_join_requests
            WHERE join_request_id = ? AND status = 'pending'
         )`,
      ),
    )
    .bind(row.join_request_id);
  const applicantInboxKey = `${eventKey}:applicant`;

  const statements: D1PreparedStatement[] = [
    capabilityGuardStatement(db, row.room_id, caller, 'approve_joins'),
    roomDissolvedGuardStatement(db, row.room_id),
    staleGuard,
    ...revisionGuard,
  ];

  if (action === 'approve') {
    statements.push(
      ownerMissingGuardStatement(db, row.room_id),
      ...invitationUsableGuards(db, row.invitation_id, at),
      joinMembershipGuardStatement(
        db,
        row.room_id,
        row.applicant_id,
        row.invitation_id,
      ),
      contactBlockGuardStatement(db, invitation.inviter_id, row.applicant_id),
      db
        .prepare(
          guardSql(
            'roomFull',
            `(SELECT COUNT(*) FROM room_members
               WHERE room_id = ? AND status = 'active') >= ?`,
          ),
        )
        .bind(row.room_id, LIMITS.groupMembersMax),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: row.room_id,
          eventType: 'room_join_approved',
          refId: row.room_id,
          metadata: {
            join_request_id: row.join_request_id,
            invitation_id: row.invitation_id,
            actor_id: row.applicant_id,
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(row.room_id), eventKey }, at),
      consumeInvitationStatement(db, row.invitation_id, at),
      db
        .prepare(
          `INSERT INTO room_members
             (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
              member_generation, role_revision, updated_at)
           VALUES (?, ?, 'member', 'active',
                   (SELECT event_seq FROM events WHERE event_key = ?),
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
        .bind(row.room_id, row.applicant_id, eventKey, eventKey, at, at),
      roomAuditStatement(
        db,
        {
          roomId: row.room_id,
          action: 'join_approved',
          targetActorId: row.applicant_id,
          previousRole: null,
          newRole: 'member',
          previousStatus: null,
          newStatus: 'active',
          expectedRevision: input.expected_revision ?? null,
          resultingRevision: row.revision + 1,
          changedBy: caller,
          requestId: input.request_id,
          detail: {
            join_request_id: row.join_request_id,
            invitation_id: row.invitation_id,
            invitation_kind: invitation.kind,
            via: 'approval',
          },
        },
        at,
      ),
      roomMemberVersionStatement(db, row.room_id, eventKey, at),
      db
        .prepare(
          `UPDATE room_join_requests
              SET status = 'approved', revision = revision + 1,
                  decided_at = ?, decided_by = ?, updated_at = ?
            WHERE join_request_id = ? AND status = 'pending'`,
        )
        .bind(at, caller, at, row.join_request_id),
      eventStatement(
        db,
        {
          eventKey: applicantInboxKey,
          scopeKind: 'inbox',
          scopeId: row.applicant_id,
          eventType: 'room_join_approved',
          refId: row.room_id,
          metadata: {
            room_id: row.room_id,
            join_request_id: row.join_request_id,
            invitation_id: row.invitation_id,
            decided_by: caller,
          },
        },
        at,
      ),
      outboxStatement(
        db,
        { topic: inboxTopic(row.applicant_id), eventKey: applicantInboxKey },
        at,
      ),
      inboxHeadStatement(db, row.applicant_id, applicantInboxKey, at, 0),
    );
  } else {
    statements.push(
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: row.room_id,
          eventType: 'room_join_rejected',
          refId: row.room_id,
          metadata: {
            join_request_id: row.join_request_id,
            invitation_id: row.invitation_id,
            actor_id: row.applicant_id,
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(row.room_id), eventKey }, at),
      roomAuditStatement(
        db,
        {
          roomId: row.room_id,
          action: 'join_rejected',
          targetActorId: row.applicant_id,
          previousStatus: null,
          newStatus: null,
          expectedRevision: input.expected_revision ?? null,
          resultingRevision: row.revision + 1,
          changedBy: caller,
          requestId: input.request_id,
          detail: {
            join_request_id: row.join_request_id,
            invitation_id: row.invitation_id,
          },
        },
        at,
      ),
      db
        .prepare(
          `UPDATE room_join_requests
              SET status = 'rejected', revision = revision + 1,
                  decided_at = ?, decided_by = ?, updated_at = ?
            WHERE join_request_id = ? AND status = 'pending'`,
        )
        .bind(at, caller, at, row.join_request_id),
      eventStatement(
        db,
        {
          eventKey: applicantInboxKey,
          scopeKind: 'inbox',
          scopeId: row.applicant_id,
          eventType: 'room_join_rejected',
          refId: row.room_id,
          metadata: {
            room_id: row.room_id,
            join_request_id: row.join_request_id,
            invitation_id: row.invitation_id,
            decided_by: caller,
          },
        },
        at,
      ),
      outboxStatement(
        db,
        { topic: inboxTopic(row.applicant_id), eventKey: applicantInboxKey },
        at,
      ),
      inboxHeadStatement(db, row.applicant_id, applicantInboxKey, at, 0),
    );
  }

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      ...statements,
    ],
  });
  return result;
}
