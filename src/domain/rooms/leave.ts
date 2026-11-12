/** rooms.ts 拆分模块：leave。纯移动，行为保持不变。 */

import { BusinessError } from '../../contracts/errors';
import { type RoomLeaveInput } from '../../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../../storage/db';
import { eventStatement, inboxHeadStatement, inboxTopic, outboxStatement, roomMemberVersionStatement, roomTopic } from '../../storage/events';
import { guardSql } from '../../storage/guards';
import { getRoom } from '../../storage/queries';
import { operationsStatement, runIdempotent } from '../../storage/transactions/runner';
import { actorId, type Principal } from '../principal';
import { loadRoomAccess, requireExpectedRoleRevision, roleRevisionGuardStatement } from '../room-access';
import { roomAuditStatement } from '../room-audit';
import { roomLeavePreview } from '../room-lifecycle';
import { cancelDeliveriesForMemberStatements } from './membership';

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
  const { member } = await loadRoomAccess(db, room.room_id, caller);
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
