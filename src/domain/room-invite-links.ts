import { BusinessError } from '../contracts/errors';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  RoomInviteCreateInput,
  RoomInviteGetInput,
  RoomInviteRevokeInput,
} from '../contracts/schemas';
import { newId, nowMs, randomToken, sha256Hex, sortedPairKey, stableStringify } from '../storage/db';
import { eventStatement, outboxStatement, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, getMember, getOperation } from '../storage/queries';
import type { RoomInvitationRow } from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { contactBlockGuardStatement } from './contact-blocks';
import {
  assertOwnerPresent,
  assertRoomWritable,
  capabilityGuardStatement,
  ownerMissingGuardStatement,
  requireGroupAccess,
  roomDissolvedGuardStatement,
} from './room-access';
import { roomAuditStatement } from './room-audit';
import {
  directInvitationStatements,
  hashRoomInviteKey,
  invitationInboxStatements,
  invitationView,
  type InvitationJoinRow,
  type RoomInvitationPage,
  type RoomInvitationView,
} from './room-invitations';
import { actorId, type Principal } from './principal';

/**
 * G02 邀请链接、二维码与撤销。
 *
 * 链接与定向邀请共用 `room_invitations`：链接保存 key 的 SHA-256 摘要，
 * 明文只在创建响应返回一次；之后任何设备打开的旧二维码都只是同一个
 * URL，撤销/过期/用尽后统一失效，不能从服务端恢复原文。
 */

export interface RoomInviteCreateResult {
  invitation: RoomInvitationView;
  invite_key: string | null;
  share_url: string | null;
}

/**
 * `operations.result_json` 只保存非秘密字段。
 *
 * 明文 key 与分享 URL 只在首次响应出现；重放时读取该快照也只能拿到邀请
 * 状态，不会恢复或伪造明文链接。
 */
interface RoomInviteCreateStored {
  invitation: RoomInvitationView;
}

const INVITATION_SELECT = `SELECT i.*, r.title AS room_title, a.name AS inviter_name,
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
   JOIN actors a ON a.actor_id = i.inviter_id`;

async function selectInvitationRows(
  db: D1Database,
  viewer: string,
  where: string,
  binds: unknown[],
  limit = 1,
): Promise<InvitationJoinRow[]> {
  const rows = await db
    .prepare(
      `${INVITATION_SELECT}
       WHERE ${where}
       ORDER BY i.created_at DESC, i.invitation_id DESC
       LIMIT ?`,
    )
    .bind(viewer, viewer, viewer, viewer, viewer, ...binds, limit)
    .all<InvitationJoinRow>();
  return rows.results;
}

async function loadInvitationView(
  db: D1Database,
  viewer: string,
  invitationId: string,
  at: number,
): Promise<RoomInvitationView> {
  const [row] = await selectInvitationRows(
    db,
    viewer,
    'i.invitation_id = ?',
    [invitationId],
  );
  if (!row) throw new BusinessError('NOT_FOUND', '邀请不存在');
  return invitationView(row, at);
}

/** 创建者不是待加入目标；链接创建者拿到的下一步是分享。 */
function creatorView(view: RoomInvitationView): RoomInvitationView {
  return {
    ...view,
    next_step: view.kind === 'link' ? 'share' : 'invalid',
    can_respond: false,
  };
}

async function memberCount(db: D1Database, roomId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS total FROM room_members WHERE room_id = ? AND status = 'active'",
    )
    .bind(roomId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * 创建链接或定向邀请。
 *
 * - 链接：默认 7 天、20 次成功加入；返回明文 key 与 `/j/<key>` 分享 URL。
 * - 定向：目标必须是好友、不能已是成员；固定 1 次，移除后新建的邀请
 *   是重新加入的唯一入口。
 */
export async function roomInviteCreate(
  db: D1Database,
  principal: Principal,
  input: RoomInviteCreateInput,
  origin: string,
): Promise<RoomInviteCreateResult> {
  const viewer = actorId(principal);
  const at = nowMs();
  const access = await requireGroupAccess(db, input.room_id, viewer, 'invite_members');
  assertRoomWritable(access.room);
  // 遗留无主群不再产生新邀请（定向或链接）；事务 guard 在提交时复核。
  assertOwnerPresent(access.room);
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await getOperation(db, viewer, input.request_id);
  if (replay) {
    const replayed = resolveOperation(replay, payloadHash) as RoomInviteCreateStored;
    // 链接明文只在首次响应出现一次；撤销后也不能由重放恢复旧 key/旧状态。
    if (!input.target_actor_id) {
      throw new BusinessError(
        'TOKEN_NOT_REPLAYABLE',
        '邀请链接明文只在首次响应返回一次；请使用新的 request_id 重新创建',
      );
    }
    return { ...replayed, invite_key: null, share_url: null };
  }

  const expiresAt = at + (input.expires_in_ms ?? LIMITS.roomInviteTtlMs);
  const inviterName = (await getActor(db, viewer))?.name ?? '';
  const count = await memberCount(db, input.room_id);
  const requiresApproval = access.room.member_join_policy === 'approval';

  const viewFor = (invitation: RoomInvitationRow): RoomInvitationView =>
    creatorView(
      invitationView(
        {
          ...invitation,
          room_title: access.room.title,
          inviter_name: inviterName,
          member_count: count,
          member_join_policy: access.room.member_join_policy,
          my_member_status: 'active',
          member_updated_at: at,
          blocked: 0,
          join_request_status: null,
        },
        at,
      ),
    );

  if (input.target_actor_id) {
    const target = input.target_actor_id;
    if (target === viewer) {
      throw new BusinessError('INVALID_ARGUMENT', '不能邀请自己');
    }
    if (!(await getActor(db, target))) {
      throw new BusinessError('NOT_FOUND', '目标不存在');
    }
    if ((await getMember(db, input.room_id, target))?.status === 'active') {
      throw new BusinessError('CONFLICT', '目标已经是该群成员', {
        current_state: 'active',
        expected_state: 'invited',
      });
    }
    const relation = await db
      .prepare(
        "SELECT 1 AS ok FROM contact_relations WHERE pair_key = ? AND status = 'active'",
      )
      .bind(sortedPairKey(viewer, target))
      .first<{ ok: number }>();
    if (!relation) throw new BusinessError('FRIEND_REQUIRED', '只能邀请好友加入群聊');
    const existing = await db
      .prepare(
        `SELECT invitation_id FROM room_invitations
          WHERE room_id = ? AND target_actor_id = ? AND kind = 'direct' AND status = 'pending'`,
      )
      .bind(input.room_id, target)
      .first<{ invitation_id: string }>();
    if (existing) {
      const view = await loadInvitationView(db, target, existing.invitation_id, at);
      return { invitation: creatorView(view), invite_key: null, share_url: null };
    }

    const { invitations, statements } = directInvitationStatements(db, {
      roomId: input.room_id,
      inviterId: viewer,
      targets: [target],
      at,
      expiresAt,
    });
    const invitation = invitations[0]!;
    const stored: RoomInviteCreateStored = { invitation: viewFor(invitation) };
    await runIdempotent(db, {
      actorId: viewer,
      requestId: input.request_id,
      payloadHash,
      result: stored,
      build: (resultJson) => [
        operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, at),
        capabilityGuardStatement(db, input.room_id, viewer, 'invite_members'),
        roomDissolvedGuardStatement(db, input.room_id),
        ownerMissingGuardStatement(db, input.room_id),
        db
          .prepare(
            guardSql(
              'friendRequired',
              `NOT EXISTS (
                 SELECT 1 FROM contact_relations
                  WHERE pair_key = ? AND status = 'active'
               )`,
            ),
          )
          .bind(sortedPairKey(viewer, target)),
        contactBlockGuardStatement(db, viewer, target),
        db
          .prepare(
            guardSql(
              'invitationStale',
              `EXISTS (
                 SELECT 1 FROM room_invitations
                  WHERE room_id = ? AND target_actor_id = ? AND kind = 'direct'
                    AND status = 'pending'
               )`,
            ),
          )
          .bind(input.room_id, target),
        ...statements,
        roomAuditStatement(
          db,
          {
            roomId: input.room_id,
            action: 'invite_created',
            targetActorId: target,
            resultingRevision: 1,
            changedBy: viewer,
            requestId: input.request_id,
            detail: {
              invitation_id: invitation.invitation_id,
              kind: 'direct',
              expires_at: expiresAt,
            },
          },
          at,
        ),
        ...invitationInboxStatements(db, invitations, at),
      ],
    });
    return { ...stored, invite_key: null, share_url: null };
  }

  const inviteKey = randomToken(LIMITS.roomInviteKeyBytes);
  const invitation: RoomInvitationRow = {
    invitation_id: newId('rinv'),
    room_id: input.room_id,
    inviter_id: viewer,
    target_actor_id: null,
    token_hash: await hashRoomInviteKey(inviteKey),
    kind: 'link',
    status: 'pending',
    max_uses: input.max_uses ?? LIMITS.roomInviteLinkDefaultUses,
    used_count: 0,
    expires_at: expiresAt,
    revision: 1,
    created_at: at,
    updated_at: at,
  };
  const shareUrl = `${origin.replace(/\/+$/u, '')}/j/${inviteKey}`;
  const stored: RoomInviteCreateStored = { invitation: viewFor(invitation) };
  const outcome = await runIdempotent(db, {
    actorId: viewer,
    requestId: input.request_id,
    payloadHash,
    result: stored,
    build: (resultJson) => [
      operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, input.room_id, viewer, 'invite_members'),
      roomDissolvedGuardStatement(db, input.room_id),
      ownerMissingGuardStatement(db, input.room_id),
      db
        .prepare(
          guardSql(
            'roomInviteLimit',
            `(SELECT COUNT(*) FROM room_invitations
               WHERE room_id = ? AND kind = 'link' AND status = 'pending'
                 AND expires_at > ?) >= ?`,
          ),
        )
        .bind(input.room_id, at, LIMITS.roomInviteLinksPerRoom),
      db
        .prepare(
          `INSERT INTO room_invitations
             (invitation_id, room_id, inviter_id, target_actor_id, token_hash, kind,
              status, max_uses, used_count, expires_at, revision, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, 'link', 'pending', ?, 0, ?, 1, ?, ?)`,
        )
        .bind(
          invitation.invitation_id,
          input.room_id,
          viewer,
          invitation.token_hash,
          invitation.max_uses,
          expiresAt,
          at,
          at,
        ),
      roomAuditStatement(
        db,
        {
          roomId: input.room_id,
          action: 'invite_created',
          targetActorId: null,
          resultingRevision: 1,
          changedBy: viewer,
          requestId: input.request_id,
          detail: {
            invitation_id: invitation.invitation_id,
            kind: 'link',
            max_uses: invitation.max_uses,
            expires_at: expiresAt,
          },
        },
        at,
      ),
    ],
  });
  // 首次写入返回 stored 本身；重放返回 JSON.parse 出的新对象，不能重放明文。
  if (outcome !== stored) {
    throw new BusinessError(
      'TOKEN_NOT_REPLAYABLE',
      '邀请链接明文只在首次响应返回一次；请使用新的 request_id 重新创建',
    );
  }
  return { ...stored, invite_key: inviteKey, share_url: shareUrl };
}

/**
 * 撤销邀请。
 *
 * 邀请人或 owner/admin 可立即撤销；同一事务把所有 pending 申请置为
 * expired。链接明文不可恢复，撤销后所有设备上的旧二维码都失效。
 */
export async function roomInviteRevoke(
  db: D1Database,
  principal: Principal,
  input: RoomInviteRevokeInput,
): Promise<RoomInvitationView> {
  const caller = actorId(principal);
  const at = nowMs();
  const invitation = await db
    .prepare('SELECT * FROM room_invitations WHERE invitation_id = ?')
    .bind(input.invitation_id)
    .first<RoomInvitationRow>();
  if (!invitation) throw new BusinessError('NOT_FOUND', '邀请不存在');
  const access = await requireGroupAccess(db, invitation.room_id, caller, 'invite_members');
  assertRoomWritable(access.room);
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as RoomInvitationView;
  if (invitation.status !== 'pending') {
    throw new BusinessError('CONFLICT', '邀请状态已变化，请刷新后重试', {
      current_state: invitation.status,
      expected_state: 'pending',
    });
  }
  if (
    input.expected_revision !== undefined &&
    invitation.revision !== input.expected_revision
  ) {
    throw new BusinessError('VERSION_CONFLICT', '邀请版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      actual: invitation.revision,
    });
  }

  const result = await loadInvitationView(db, caller, invitation.invitation_id, at);
  result.status = 'revoked';
  result.revision = invitation.revision + 1;
  result.next_step = 'invalid';
  result.can_respond = false;
  const eventKey = `room_invitation_revoked:${invitation.invitation_id}`;

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, invitation.room_id, caller, 'invite_members'),
      roomDissolvedGuardStatement(db, invitation.room_id),
      // 撤销权限独立于建链权限：普通成员可以创建，但只有邀请人或
      // owner/admin 能撤销别人的链接。
      db
        .prepare(
          guardSql(
            'permissionDenied',
            `NOT EXISTS (
               SELECT 1
                 FROM room_invitations i
                 JOIN rooms r ON r.room_id = i.room_id
                 JOIN room_members m ON m.room_id = r.room_id AND m.actor_id = ?
                WHERE i.invitation_id = ? AND i.room_id = ? AND m.status = 'active'
                  AND (
                    m.role IN ('owner', 'admin')
                    OR (i.inviter_id = m.actor_id AND r.member_invite_policy = 'members')
                  )
             )`,
          ),
        )
        .bind(caller, invitation.invitation_id, invitation.room_id),
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
        .bind(invitation.invitation_id),
      db
        .prepare(
          `UPDATE room_join_requests
              SET status = 'expired', revision = revision + 1, updated_at = ?
            WHERE invitation_id = ? AND status = 'pending'`,
        )
        .bind(at, invitation.invitation_id),
      db
        .prepare(
          `UPDATE room_invitations
              SET status = 'revoked', revision = revision + 1, updated_at = ?
            WHERE invitation_id = ? AND status = 'pending'`,
        )
        .bind(at, invitation.invitation_id),
      roomAuditStatement(
        db,
        {
          roomId: invitation.room_id,
          action: 'invite_revoked',
          targetActorId: invitation.target_actor_id,
          expectedRevision: input.expected_revision ?? null,
          resultingRevision: invitation.revision + 1,
          changedBy: caller,
          requestId: input.request_id,
          detail: {
            invitation_id: invitation.invitation_id,
            kind: invitation.kind,
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
          eventType: 'room_invitation_revoked',
          refId: invitation.room_id,
          metadata: {
            invitation_id: invitation.invitation_id,
            kind: invitation.kind,
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(invitation.room_id), eventKey }, at),
    ],
  });
  return result;
}

/** 链接持有者的最小群介绍；不返回消息正文、成员列表或邀请人凭据。 */
export async function roomInvitePreview(
  db: D1Database,
  principal: Principal,
  input: RoomInviteGetInput,
): Promise<RoomInvitationPage> {
  const viewer = actorId(principal);
  const at = nowMs();
  const tokenHash = await hashRoomInviteKey(input.invite_key!);
  const [row] = await selectInvitationRows(
    db,
    viewer,
    `i.token_hash = ? AND i.kind = 'link'`,
    [tokenHash],
  );
  if (!row) throw new BusinessError('NOT_FOUND', '邀请链接无效或已失效');
  return { items: [invitationView(row, at)], next_cursor: null, has_more: false };
}

/** owner/admin 或可邀请成员读取本群链接；只返回状态，不返回明文 key。 */
export async function roomInviteLinkList(
  db: D1Database,
  principal: Principal,
  input: RoomInviteGetInput,
): Promise<RoomInvitationPage> {
  const viewer = actorId(principal);
  await requireGroupAccess(db, input.room_id!, viewer, 'invite_members');
  const at = nowMs();
  const limit = clampPage(
    input.limit,
    LIMITS.roomInvitationsPageDefault,
    LIMITS.roomInvitationsPageMax,
  );
  const where = ['i.room_id = ?', "i.kind = 'link'"];
  const binds: unknown[] = [input.room_id];
  if (input.status === 'pending') {
    where.push("i.status = 'pending'", 'i.expires_at > ?', 'i.used_count < i.max_uses');
    binds.push(at);
  } else if (input.status === 'expired') {
    where.push("i.status = 'pending'", 'i.expires_at <= ?');
    binds.push(at);
  } else if (input.status) {
    where.push('i.status = ?');
    binds.push(input.status);
  }
  const rows = await selectInvitationRows(
    db,
    viewer,
    where.join(' AND '),
    binds,
    limit + 1,
  );
  return {
    items: rows.slice(0, limit).map((row) => invitationView(row, at, { share: true })),
    // 群内链接数量由 LIMITS.roomInviteLinksPerRoom 限制，单页即可覆盖；
    // 仍保留分页字段以维持统一页面契约。
    next_cursor: null,
    has_more: rows.length > limit,
  };
}
