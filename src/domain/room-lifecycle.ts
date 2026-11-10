import { BusinessError } from '../contracts/errors';
import type { RoomDissolveInput, RoomLeavePreviewInput } from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  eventStatement,
  outboxStatement,
  roomMemberVersionStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getMember, getRoom } from '../storage/queries';
import {
  operationsStatement,
  resolveReplay,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import {
  capabilityGuardStatement,
  roomDissolvedGuardStatement,
} from './room-access';
import { roomAuditStatement } from './room-audit';

/**
 * G06 群生命周期：退群预览与群解散。
 *
 * - 解散是单一事务：冻结房间、取消未完成投递、撤销邀请/申请/交接、
 *   固定归档边界并写审计；不删除任何业务行。
 * - 退群预览只读，供网页在确认前列出该成员的待处理投递；实际退群仍由
 *   `roomLeave` 在同一事务内撤销投递。
 * - 解散不调用媒体层；`room_dissolved` 事件携带 `media_revoke: true`，作为
 *   未来 M09 通话模块的明确撤权钩子，不能据此声称已终止媒体。
 */

export interface RoomLeavePreview {
  room_id: string;
  actor_id: string;
  pending_deliveries: number;
  claimed_deliveries: number;
  can_leave: boolean;
  can_dissolve: boolean;
  owner_transfer_required: boolean;
  dissolved: boolean;
  read_only: boolean;
}

export interface RoomDissolveSummary {
  room_id: string;
  dissolved_at: string;
  archived_head_seq: string;
  archive_member_seq: string;
  cancelled_deliveries: number;
  revoked_invitations: number;
  cancelled_join_requests: number;
  cancelled_transfers: number;
}

async function deliveryCounts(
  db: D1Database,
  roomId: string,
  actor: string,
): Promise<{ pending: number; claimed: number }> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN state = 'claimed' THEN 1 ELSE 0 END), 0) AS claimed
       FROM deliveries WHERE room_id = ? AND recipient_id = ?`,
    )
    .bind(roomId, actor)
    .first<{ pending: number; claimed: number }>();
  return { pending: row?.pending ?? 0, claimed: row?.claimed ?? 0 };
}

export async function roomLeavePreview(
  db: D1Database,
  principal: Principal,
  input: RoomLeavePreviewInput,
): Promise<RoomLeavePreview> {
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
  const deliveries = await deliveryCounts(db, room.room_id, caller);
  const dissolved = room.dissolved_at !== null;
  // 群主在任何未解散群里都不能直接退群，即使只剩自己一人：否则会留下
  // `owner_id = NULL AND dissolved_at = NULL` 的无主活跃群。先转移或解散，
  // 与群内是否还有其他 active 成员无关。
  const ownerTransferRequired =
    !dissolved && (member.role === 'owner' || room.owner_id === caller);
  return {
    room_id: room.room_id,
    actor_id: caller,
    pending_deliveries: deliveries.pending,
    claimed_deliveries: deliveries.claimed,
    can_leave: !ownerTransferRequired,
    can_dissolve: !dissolved && member.role === 'owner',
    owner_transfer_required: ownerTransferRequired,
    dissolved,
    read_only: dissolved,
  };
}

/** 解散时关闭房间内所有仍可唤醒的普通 delivery；任务投递已由任务路径处理。 */
function cancelRoomDeliveriesStatements(
  db: D1Database,
  roomId: string,
  at: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE actors
            SET pending_count = pending_count - (
                  SELECT COUNT(*) FROM deliveries
                   WHERE room_id = ? AND recipient_id = actors.actor_id AND state = 'pending'
                ),
                updated_at = ?
          WHERE actor_id IN (
            SELECT DISTINCT recipient_id FROM deliveries
             WHERE room_id = ? AND state = 'pending'
          )`,
      )
      .bind(roomId, at, roomId),
    db
      .prepare(
        `UPDATE deliveries
            SET state = 'cancelled', error = 'room_dissolved', updated_at = ?
          WHERE room_id = ? AND state IN ('pending', 'claimed')`,
      )
      .bind(at, roomId),
  ];
}

/**
 * 解散群聊（owner only）。
 *
 * 事务内先取消未结束任务与投递、撤销邀请/申请/交接，再写 `room_dissolved`
 * 事件、推进 member_seq（不推进 head_seq）、冻结 `dissolved_at` 与归档边界。
 * 审计动作 `room_dissolved` 保留；消息、任务、成果、文件与提交行不删除。
 */
export async function roomDissolve(
  db: D1Database,
  principal: Principal,
  input: RoomDissolveInput,
): Promise<RoomDissolveSummary> {
  const caller = actorId(principal);
  const room = await getRoom(db, input.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  if (room.kind !== 'group') {
    throw new BusinessError('INVALID_ARGUMENT', '单聊不支持解散');
  }
  const member = await getMember(db, room.room_id, caller);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  if (member.role !== 'owner') {
    throw new BusinessError('NOT_OWNER', '只有群 owner 可以解散群聊');
  }
  const payloadHash = await sha256Hex(stableStringify(input));
  // 授权预检在前；同 request_id 重放仍返回首次结果。
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) {
    const saved = replay.result as RoomDissolveSummary;
    const snapshot = await dissolveSnapshot(db, room.room_id);
    return { ...saved, ...snapshot };
  }
  if (room.dissolved_at !== null) {
    throw new BusinessError('CONFLICT', '群已解散，当前为只读归档', {
      room_id: room.room_id,
      dissolved_at: String(room.dissolved_at),
      read_only: true,
    });
  }

  const at = nowMs();
  const eventKey = `room_dissolved:${room.room_id}:${input.request_id}`;
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM deliveries
           WHERE room_id = ? AND state IN ('pending', 'claimed')) AS deliveries,
         (SELECT COUNT(*) FROM room_invitations
           WHERE room_id = ? AND status = 'pending') AS invitations,
         (SELECT COUNT(*) FROM room_join_requests
           WHERE room_id = ? AND status = 'pending') AS join_requests,
         (SELECT COUNT(*) FROM room_owner_transfers
           WHERE room_id = ? AND status = 'pending') AS transfers`,
    )
    .bind(room.room_id, room.room_id, room.room_id, room.room_id)
    .first<{
      deliveries: number;
      invitations: number;
      join_requests: number;
      transfers: number;
    }>();
  const reason = input.reason?.trim() || 'owner_dissolved';
  const auditRequestId = input.request_id;

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: {
      room_id: room.room_id,
      dissolved_at: String(at),
      archived_head_seq: '0',
      archive_member_seq: '0',
      cancelled_deliveries: counts?.deliveries ?? 0,
      revoked_invitations: counts?.invitations ?? 0,
      cancelled_join_requests: counts?.join_requests ?? 0,
      cancelled_transfers: counts?.transfers ?? 0,
    } satisfies RoomDissolveSummary,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, room.room_id, caller, 'manage_policy'),
      roomDissolvedGuardStatement(db, room.room_id),
      ...cancelRoomDeliveriesStatements(db, room.room_id, at),
      db
        .prepare(
          `UPDATE room_invitations
              SET status = 'revoked', revision = revision + 1, updated_at = ?
            WHERE room_id = ? AND status = 'pending'`,
        )
        .bind(at, room.room_id),
      db
        .prepare(
          `UPDATE room_join_requests
              SET status = 'cancelled', revision = revision + 1,
                  decided_at = ?, decided_by = ?, updated_at = ?
            WHERE room_id = ? AND status = 'pending'`,
        )
        .bind(at, caller, at, room.room_id),
      db
        .prepare(
          `UPDATE room_owner_transfers
              SET status = 'cancelled', responded_at = ?, responded_by = ?,
                  invalid_reason = 'room_dissolved', updated_at = ?
            WHERE room_id = ? AND status = 'pending'`,
        )
        .bind(at, caller, at, room.room_id),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: room.room_id,
          eventType: 'room_dissolved',
          refId: room.room_id,
          metadata: {
            room_id: room.room_id,
            changed_by: caller,
            reason,
            // 给未来 M09 媒体层的明确撤权信号；本任务不实现媒体终止。
            media_revoke: true,
            cancelled_deliveries: counts?.deliveries ?? 0,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(room.room_id), eventKey }, at),
      roomMemberVersionStatement(db, room.room_id, eventKey, at),
      db
        .prepare(
          `UPDATE rooms
              SET dissolved_at = ?, dissolved_by = ?, dissolve_reason = ?,
                  archive_head_seq = (SELECT event_seq FROM events WHERE event_key = ?),
                  archive_member_seq = (SELECT member_seq FROM rooms WHERE room_id = ?),
                  updated_at = ?
            WHERE room_id = ? AND dissolved_at IS NULL`,
        )
        .bind(at, caller, reason, eventKey, room.room_id, at, room.room_id),
      roomAuditStatement(
        db,
        {
          roomId: room.room_id,
          action: 'room_dissolved',
          targetActorId: null,
          resultingRevision: room.member_seq + 1,
          changedBy: caller,
          requestId: auditRequestId,
          detail: {
            reason,
            cancelled_deliveries: counts?.deliveries ?? 0,
          },
        },
        at,
      ),
    ],
  });

  // 结果中的归档边界来自事务内实际写入值；重放路径已在上面合并同一快照。
  const saved = await dissolveSnapshot(db, room.room_id);
  return {
    room_id: room.room_id,
    dissolved_at: String(at),
    archived_head_seq: saved.archived_head_seq,
    archive_member_seq: saved.archive_member_seq,
    cancelled_deliveries: counts?.deliveries ?? 0,
    revoked_invitations: counts?.invitations ?? 0,
    cancelled_join_requests: counts?.join_requests ?? 0,
    cancelled_transfers: counts?.transfers ?? 0,
  };
}

async function dissolveSnapshot(
  db: D1Database,
  roomId: string,
): Promise<{ archived_head_seq: string; archive_member_seq: string }> {
  const row = await db
    .prepare(
      `SELECT archive_head_seq, archive_member_seq FROM rooms
        WHERE room_id = ? AND dissolved_at IS NOT NULL`,
    )
    .bind(roomId)
    .first<{ archive_head_seq: number | null; archive_member_seq: number | null }>();
  return {
    archived_head_seq: String(row?.archive_head_seq ?? 0),
    archive_member_seq: String(row?.archive_member_seq ?? 0),
  };
}
