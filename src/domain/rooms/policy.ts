/** rooms.ts 拆分模块：policy。纯移动，行为保持不变。 */

import { decodeCursor, encodeCursor } from '../../contracts/cursor';
import { BusinessError } from '../../contracts/errors';
import { clampPage, LIMITS } from '../../contracts/limits';
import { type RoomAnnouncementSetInput, type RoomPolicySetInput, type RoomRoleHistoryInput, type RoomRoleSetInput } from '../../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../../storage/db';
import { eventStatement, outboxStatement, roomMemberSeqStatement, roomTopic } from '../../storage/events';
import { guardSql } from '../../storage/guards';
import {
  countActiveRoomMembersWithJoinHistory,
  listRoomAuditRows,
  type RoomAuditListRow,
} from '../../storage/queries';
import { operationsStatement, resolveReplay, runIdempotent } from '../../storage/transactions/runner';
import { actorId, type Principal } from '../principal';
import { capabilityGuardStatement, assertRoomWritable, requireExpectedRoleRevision, requireGroupAccess, requireTargetMember, roleRevisionGuardStatement, roleTargetGuardStatement, roomDissolvedGuardStatement, roomPolicies, type RoomPolicies } from '../room-access';
import { roomAuditStatement } from '../room-audit';
import { roomDetail } from './detail';
import { membershipInboxStatements } from './membership';
import { type RoomDetail, type RoomRoleHistoryPage, type RoomPolicyImpact, type RoomPolicySetResult } from './views';

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

export async function policyImpactFor(
  db: D1Database,
  roomId: string,
  previous: RoomPolicies,
  next: RoomPolicies,
): Promise<RoomPolicyImpact> {
  const historyChanged = previous.member_history !== next.member_history;
  let affectedMembers = 0;
  let hiddenFiles = 0;

  if (historyChanged && next.member_history === 'from_join') {
    affectedMembers = await countActiveRoomMembersWithJoinHistory(db, roomId);
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

  const rows = await listRoomAuditRows(
    db,
    input.room_id,
    cursor ? { seq: cursor.seq, key: cursor.key ?? '' } : null,
    limit + 1,
  );

  const page = rows.slice(0, limit);
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
  const hasMore = rows.length > limit;
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

