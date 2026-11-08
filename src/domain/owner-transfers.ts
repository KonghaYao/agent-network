import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  RoomOwnerTransferCancelInput,
  RoomOwnerTransferProposeInput,
  RoomOwnerTransferRespondInput,
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
import { getMember, getRoom } from '../storage/queries';
import type { RoomOwnerTransferRow } from '../storage/rows';
import {
  operationsStatement,
  resolveReplay,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import { roomAuditStatement } from './room-audit';
import {
  capabilityGuardStatement,
  assertRoomWritable,
  currentOwnerGuardStatement,
  requireExpectedRoleRevision,
  requireGroupAccess,
  requireTargetMember,
  roleRevisionGuardStatement,
  roomDissolvedGuardStatement,
} from './room-access';

/**
 * G05 群主转让确认。
 *
 * 提议本身不转移责任：`rooms.owner_id` 与双方 `room_members.role` 只在目标
 * 接受时同一事务改变。提议、接受、拒绝、取消都写 events/outbox 与 inbox，
 * 但不创建 delivery，也不增加 `pending_count`。
 */
export interface OwnerTransferView {
  transfer_id: string;
  room_id: string;
  from_owner_id: string;
  from_owner_name: string;
  to_actor_id: string;
  to_actor_name: string;
  status: RoomOwnerTransferRow['status'];
  version: number;
  expires_at: string;
  created_at: string;
  can_accept: boolean;
  can_reject: boolean;
  can_cancel: boolean;
}

export interface OwnerTransferResult {
  transfer_id: string;
  room_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
}

interface OwnerTransferJoinRow extends RoomOwnerTransferRow {
  from_owner_name: string;
  to_actor_name: string;
}

const OWNER_TRANSFER_VIEW_SQL = `SELECT t.*, f.name AS from_owner_name, u.name AS to_actor_name
  FROM room_owner_transfers t
  JOIN actors f ON f.actor_id = t.from_owner_id
  JOIN actors u ON u.actor_id = t.to_actor_id
  JOIN rooms r ON r.room_id = t.room_id
  JOIN room_members fo
    ON fo.room_id = t.room_id AND fo.actor_id = t.from_owner_id
   AND fo.status = 'active' AND fo.role = 'owner'
  JOIN room_members target
    ON target.room_id = t.room_id AND target.actor_id = t.to_actor_id
   AND target.status = 'active'
 WHERE t.room_id = ? AND t.status = 'pending' AND t.expires_at > ?
   AND r.kind = 'group' AND r.owner_id = t.from_owner_id
   AND r.dissolved_at IS NULL
 ORDER BY t.created_at DESC, t.transfer_id DESC
 LIMIT 1`;

async function getOwnerTransfer(
  db: D1Database,
  transferId: string,
): Promise<RoomOwnerTransferRow | null> {
  return db
    .prepare('SELECT * FROM room_owner_transfers WHERE transfer_id = ?')
    .bind(transferId)
    .first<RoomOwnerTransferRow>();
}

/**
 * 读取当前有效的群主转让提议。
 *
 * 过期、原群主不再是 owner 或目标已离群/被移除都视为没有有效提议；这些
 * 行由下一次发起在同一事务内收敛为 expired，读取本身不改写数据库。
 */
export async function loadOwnerTransferView(
  db: D1Database,
  roomId: string,
  viewer: string,
  at: number,
): Promise<OwnerTransferView | null> {
  const row = await db
    .prepare(OWNER_TRANSFER_VIEW_SQL)
    .bind(roomId, at)
    .first<OwnerTransferJoinRow>();
  if (!row) return null;
  return {
    transfer_id: row.transfer_id,
    room_id: row.room_id,
    from_owner_id: row.from_owner_id,
    from_owner_name: row.from_owner_name,
    to_actor_id: row.to_actor_id,
    to_actor_name: row.to_actor_name,
    status: row.status,
    version: row.version,
    expires_at: String(row.expires_at),
    created_at: String(row.created_at),
    can_accept: row.to_actor_id === viewer,
    can_reject: row.to_actor_id === viewer,
    can_cancel: row.from_owner_id === viewer,
  };
}

function requirePending(row: RoomOwnerTransferRow, at: number): void {
  if (row.status !== 'pending') {
    throw new BusinessError('CONFLICT', '群主转让提议状态已变化，请刷新后重试', {
      current_state: row.status,
      expected_state: 'pending',
    });
  }
  if (row.expires_at <= at) {
    throw new BusinessError('REQUEST_EXPIRED', '群主转让提议已过期', {
      transfer_id: row.transfer_id,
    });
  }
}

function requireExpectedVersion(row: RoomOwnerTransferRow, expected: number): void {
  if (row.version !== expected) {
    throw new BusinessError('CONFLICT', '群主转让提议版本已变化，请刷新后重试', {
      expected,
      actual: row.version,
    });
  }
}

/** 目标离群/被移除时提议失去效力；接受与发起都按同一条件判定。 */
function targetStillEligibleGuard(
  db: D1Database,
  roomId: string,
  targetActorId: string,
  expectedRoleRevision: number | null,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'ownerTransferStale',
        `NOT EXISTS (
           SELECT 1 FROM room_members
            WHERE room_id = ? AND actor_id = ? AND status = 'active'
              AND role <> 'owner'
              ${expectedRoleRevision === null ? '' : 'AND role_revision = ?'}
         )`,
      ),
    )
    .bind(
      ...(expectedRoleRevision === null
        ? [roomId, targetActorId]
        : [roomId, targetActorId, expectedRoleRevision]),
    );
}

/** 原群主仍是 rooms.owner_id 与 active owner；转让/离开前使用。 */
function ownerStillResponsibleGuard(
  db: D1Database,
  roomId: string,
  fromOwnerId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'ownerTransferStale',
        `NOT EXISTS (
           SELECT 1
             FROM rooms r
             JOIN room_members m ON m.room_id = r.room_id
            WHERE r.room_id = ? AND r.kind = 'group' AND r.owner_id = ?
              AND m.actor_id = ? AND m.status = 'active' AND m.role = 'owner'
         )`,
      ),
    )
    .bind(roomId, fromOwnerId, fromOwnerId);
}

function pendingTransferVersionGuard(
  db: D1Database,
  transferId: string,
  expectedVersion: number,
  actorColumn: 'to_actor_id' | 'from_owner_id',
  actor: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'ownerTransferStale',
        `NOT EXISTS (
           SELECT 1 FROM room_owner_transfers
            WHERE transfer_id = ? AND status = 'pending' AND version = ?
              AND ${actorColumn} = ? AND expires_at > ?
         )`,
      ),
    )
    .bind(transferId, expectedVersion, actor, at);
}

function requestExpiredGuard(
  db: D1Database,
  transferId: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'requestExpired',
        'EXISTS (SELECT 1 FROM room_owner_transfers WHERE transfer_id = ? AND expires_at <= ?)',
      ),
    )
    .bind(transferId, at);
}

/** 过期或目标已失效的 pending 行在发起前收敛，避免阻挡新提议。 */
function expireStaleProposalsStatement(
  db: D1Database,
  roomId: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE room_owner_transfers
          SET status = 'expired', version = version + 1, updated_at = ?,
              invalid_reason = CASE
                WHEN expires_at <= ? THEN 'expired'
                ELSE 'target_inactive'
              END
        WHERE room_id = ? AND status = 'pending'
          AND (
            expires_at <= ?
            OR NOT EXISTS (
              SELECT 1 FROM room_members
               WHERE room_id = room_owner_transfers.room_id
                 AND actor_id = room_owner_transfers.to_actor_id
                 AND status = 'active'
            )
          )`,
    )
    .bind(at, at, roomId, at);
}

/** inbox 提示：不创建 delivery，也不增加 pending_count。 */
function transferInboxStatement(
  db: D1Database,
  input: {
    roomId: string;
    actor: string;
    eventType: string;
    transferId: string;
    metadata: Record<string, unknown>;
    eventKey: string;
  },
  at: number,
): D1PreparedStatement[] {
  return [
    eventStatement(
      db,
      {
        eventKey: input.eventKey,
        scopeKind: 'inbox',
        scopeId: input.actor,
        eventType: input.eventType,
        refId: input.roomId,
        metadata: {
          room_id: input.roomId,
          transfer_id: input.transferId,
          ...input.metadata,
        },
      },
      at,
    ),
    outboxStatement(db, { topic: inboxTopic(input.actor), eventKey: input.eventKey }, at),
    inboxHeadStatement(db, input.actor, input.eventKey, at, 0),
  ];
}

/**
 * 发起群主转让提议。
 *
 * 只有当前 owner 可发起；目标必须是 active 非 owner 成员。同一群已有
 * 有效 pending 时返回 CONFLICT；同一 request_id 重放返回同一提议。
 */
export async function roomOwnerTransferPropose(
  db: D1Database,
  principal: Principal,
  input: RoomOwnerTransferProposeInput,
): Promise<OwnerTransferResult> {
  const caller = actorId(principal);
  const access = await requireGroupAccess(db, input.room_id, caller, 'transfer_owner');
  assertRoomWritable(access.room);
  if (input.target_actor_id === caller) {
    throw new BusinessError('INVALID_ARGUMENT', 'owner 不能把群主转让给自己');
  }
  const target = await requireTargetMember(db, input.room_id, input.target_actor_id);
  if (target.role === 'owner') {
    throw new BusinessError('INVALID_ARGUMENT', '目标已经是群 owner');
  }
  if (input.expected_role_revision !== undefined) {
    requireExpectedRoleRevision(target, input.expected_role_revision);
  }

  const payloadHash = await sha256Hex(stableStringify(input));
  // 授权预检先于重放：被撤销 owner 后重放旧 request_id 也不能得到成功。
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) return replay.result as OwnerTransferResult;

  const at = nowMs();
  const transferId = newId('rot');
  const expiresAt = at + LIMITS.roomOwnerTransferTtlMs;
  const eventKey = `owner_transfer_proposed:${transferId}`;
  const revisionGuard = roleRevisionGuardStatement(
    db,
    input.room_id,
    target.actor_id,
    input.expected_role_revision,
  );

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { transfer_id: transferId, room_id: input.room_id, status: 'pending' },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, input.room_id, caller, 'transfer_owner'),
      roomDissolvedGuardStatement(db, input.room_id),
      currentOwnerGuardStatement(db, input.room_id, caller),
      targetStillEligibleGuard(db, input.room_id, target.actor_id, null),
      ...(revisionGuard ? [revisionGuard] : []),
      expireStaleProposalsStatement(db, input.room_id, at),
      db
        .prepare(
          guardSql(
            'ownerTransferStale',
            "EXISTS (SELECT 1 FROM room_owner_transfers WHERE room_id = ? AND status = 'pending')",
          ),
        )
        .bind(input.room_id),
      db
        .prepare(
          `INSERT INTO room_owner_transfers
             (transfer_id, room_id, from_owner_id, to_actor_id, status, version,
              target_role_revision, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
        )
        .bind(
          transferId,
          input.room_id,
          caller,
          target.actor_id,
          target.role_revision,
          at,
          at,
          expiresAt,
        ),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: input.room_id,
          eventType: 'room_owner_transfer_proposed',
          refId: transferId,
          metadata: {
            room_id: input.room_id,
            transfer_id: transferId,
            from_owner_id: caller,
            to_actor_id: target.actor_id,
            expires_at: String(expiresAt),
            changed_by: caller,
          },
        },
        at,
      ),
      outboxStatement(db, { topic: roomTopic(input.room_id), eventKey }, at),
      ...transferInboxStatement(
        db,
        {
          roomId: input.room_id,
          actor: target.actor_id,
          eventType: 'room_owner_transfer_proposed',
          transferId,
          eventKey: `${eventKey}:inbox:${target.actor_id}`,
          metadata: {
            from_owner_id: caller,
            expires_at: String(expiresAt),
            changed_by: caller,
          },
        },
        at,
      ),
      roomMemberVersionStatement(db, input.room_id, eventKey, at),
      roomAuditStatement(
        db,
        {
          roomId: input.room_id,
          action: 'owner_transfer_proposed',
          targetActorId: target.actor_id,
          previousRole: target.role,
          newRole: target.role,
          previousStatus: 'active',
          newStatus: 'active',
          expectedRevision: input.expected_role_revision ?? null,
          resultingRevision: target.role_revision,
          changedBy: caller,
          requestId: input.request_id,
          detail: {
            transfer_id: transferId,
            from_owner_id: caller,
            expires_at: String(expiresAt),
          },
        },
        at,
      ),
    ],
  });

  return { transfer_id: transferId, room_id: input.room_id, status: 'pending' };
}

/**
 * 接受或拒绝群主转让。
 *
 * 只有目标本人可响应；接受时在同一事务内复核提议版本、有效期、原群主
 * 仍负责、目标仍 active 且 `role_revision` 未漂移，然后原子换 owner。
 */
export async function roomOwnerTransferRespond(
  db: D1Database,
  principal: Principal,
  input: RoomOwnerTransferRespondInput,
): Promise<OwnerTransferResult> {
  const viewer = actorId(principal);
  const at = nowMs();
  const row = await getOwnerTransfer(db, input.transfer_id);
  if (!row || row.to_actor_id !== viewer) {
    throw new BusinessError('NOT_FOUND', '群主转让提议不存在或不属于当前身份');
  }
  const payloadHash = await sha256Hex(stableStringify(input));
  // 同一 request_id 的重放先返回已提交结果：接受后提议已不是 pending，
  // 不能再用状态预检把重试误报成 CONFLICT。
  const replay = await resolveReplay(db, viewer, input.request_id, payloadHash);
  if (replay.found) return replay.result as OwnerTransferResult;
  requirePending(row, at);
  requireExpectedVersion(row, input.expected_version);

  const room = await getRoom(db, row.room_id);
  if (!room || room.kind !== 'group') {
    throw new BusinessError('NOT_FOUND', '转让提议对应的群不存在');
  }
  assertRoomWritable(room);
  if (room.owner_id !== row.from_owner_id) {
    throw new BusinessError('CONFLICT', '原群主已不再是群 owner，提议已失效');
  }
  const target = await getMember(db, row.room_id, viewer);
  if (!target || target.status !== 'active') {
    throw new BusinessError('CONFLICT', '目标已不是该群的有效成员，提议已失效');
  }
  if (target.role === 'owner') {
    throw new BusinessError('CONFLICT', '目标已经是群 owner');
  }
  if (target.role_revision !== row.target_role_revision) {
    throw new BusinessError('VERSION_CONFLICT', '目标群角色版本已变化，请刷新后重试', {
      expected: row.target_role_revision,
      actual: target.role_revision,
    });
  }
  const fromMember = await getMember(db, row.room_id, row.from_owner_id);
  if (!fromMember || fromMember.status !== 'active' || fromMember.role !== 'owner') {
    throw new BusinessError('NOT_OWNER', '原群主已失去 owner 角色，提议已失效');
  }

  const atAccept = nowMs();
  const status = input.action === 'accept' ? 'accepted' : 'rejected';
  const eventKey = `owner_transfer_${status}:${row.transfer_id}:${input.request_id}`;
  const result: OwnerTransferResult = {
    transfer_id: row.transfer_id,
    room_id: row.room_id,
    status,
  };
  const metadata = {
    room_id: row.room_id,
    transfer_id: row.transfer_id,
    from_owner_id: row.from_owner_id,
    to_actor_id: row.to_actor_id,
    changed_by: viewer,
  };

  const build = (resultJson: string): D1PreparedStatement[] => {
    const statements: D1PreparedStatement[] = [
      operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, atAccept),
      roomDissolvedGuardStatement(db, row.room_id),
      requestExpiredGuard(db, row.transfer_id, atAccept),
      pendingTransferVersionGuard(
        db,
        row.transfer_id,
        input.expected_version,
        'to_actor_id',
        viewer,
        atAccept,
      ),
      ownerStillResponsibleGuard(db, row.room_id, row.from_owner_id),
      targetStillEligibleGuard(db, row.room_id, viewer, row.target_role_revision),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: row.room_id,
          eventType: `room_owner_transfer_${status}`,
          refId: row.transfer_id,
          metadata,
        },
        atAccept,
      ),
      outboxStatement(db, { topic: roomTopic(row.room_id), eventKey }, atAccept),
      db
        .prepare(
          `UPDATE room_owner_transfers
              SET status = ?, version = version + 1, responded_at = ?, responded_by = ?,
                  updated_at = ?
            WHERE transfer_id = ? AND status = 'pending' AND version = ?`,
        )
        .bind(status, atAccept, viewer, atAccept, row.transfer_id, input.expected_version),
      roomMemberVersionStatement(db, row.room_id, eventKey, atAccept),
    ];

    if (status === 'accepted') {
      statements.push(
        db
          .prepare(
            `UPDATE room_members
                SET role = 'member', role_revision = role_revision + 1, updated_at = ?
              WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
          )
          .bind(atAccept, row.room_id, row.from_owner_id),
        db
          .prepare(
            `UPDATE room_members
                SET role = 'owner', role_revision = role_revision + 1, updated_at = ?
              WHERE room_id = ? AND actor_id = ? AND status = 'active'`,
          )
          .bind(atAccept, row.room_id, row.to_actor_id),
        db
          .prepare('UPDATE rooms SET owner_id = ?, updated_at = ? WHERE room_id = ?')
          .bind(row.to_actor_id, atAccept, row.room_id),
        roomAuditStatement(
          db,
          {
            roomId: row.room_id,
            action: 'owner_transfer_accepted',
            targetActorId: row.to_actor_id,
            previousRole: target.role,
            newRole: 'owner',
            previousStatus: 'active',
            newStatus: 'active',
            expectedRevision: row.target_role_revision,
            resultingRevision: target.role_revision + 1,
            changedBy: viewer,
            requestId: input.request_id,
            detail: { transfer_id: row.transfer_id, from_owner_id: row.from_owner_id },
          },
          atAccept,
        ),
        roomAuditStatement(
          db,
          {
            roomId: row.room_id,
            action: 'owner_transfer_accepted',
            targetActorId: row.from_owner_id,
            previousRole: 'owner',
            newRole: 'member',
            previousStatus: 'active',
            newStatus: 'active',
            resultingRevision: fromMember.role_revision + 1,
            changedBy: viewer,
            requestId: input.request_id,
            detail: { transfer_id: row.transfer_id, to_actor_id: row.to_actor_id },
          },
          atAccept,
        ),
        ...transferInboxStatement(
          db,
          {
            roomId: row.room_id,
            actor: row.from_owner_id,
            eventType: 'room_owner_transfer_accepted',
            transferId: row.transfer_id,
            eventKey: `${eventKey}:inbox:${row.from_owner_id}`,
            metadata: { to_actor_id: row.to_actor_id, changed_by: viewer },
          },
          atAccept,
        ),
        ...transferInboxStatement(
          db,
          {
            roomId: row.room_id,
            actor: row.to_actor_id,
            eventType: 'room_owner_transfer_accepted',
            transferId: row.transfer_id,
            eventKey: `${eventKey}:inbox:${row.to_actor_id}`,
            metadata: { from_owner_id: row.from_owner_id, changed_by: viewer },
          },
          atAccept,
        ),
      );
    } else {
      statements.push(
        roomAuditStatement(
          db,
          {
            roomId: row.room_id,
            action: 'owner_transfer_rejected',
            targetActorId: row.to_actor_id,
            previousRole: target.role,
            newRole: target.role,
            previousStatus: 'active',
            newStatus: 'active',
            resultingRevision: target.role_revision,
            changedBy: viewer,
            requestId: input.request_id,
            detail: { transfer_id: row.transfer_id, from_owner_id: row.from_owner_id },
          },
          atAccept,
        ),
        ...transferInboxStatement(
          db,
          {
            roomId: row.room_id,
            actor: row.from_owner_id,
            eventType: 'room_owner_transfer_rejected',
            transferId: row.transfer_id,
            eventKey: `${eventKey}:inbox:${row.from_owner_id}`,
            metadata: { to_actor_id: row.to_actor_id, changed_by: viewer },
          },
          atAccept,
        ),
      );
    }
    return statements;
  };

  await runIdempotent(db, {
    actorId: viewer,
    requestId: input.request_id,
    payloadHash,
    result,
    build,
  });
  return result;
}

/** 发起人取消 pending 提议；取消不改变任何角色。 */
export async function roomOwnerTransferCancel(
  db: D1Database,
  principal: Principal,
  input: RoomOwnerTransferCancelInput,
): Promise<OwnerTransferResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const row = await getOwnerTransfer(db, input.transfer_id);
  if (!row || row.from_owner_id !== caller) {
    throw new BusinessError('NOT_FOUND', '群主转让提议不存在或不属于当前身份');
  }
  await requireGroupAccess(db, row.room_id, caller, 'transfer_owner');
  const room = await getRoom(db, row.room_id);
  if (room) assertRoomWritable(room);
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) return replay.result as OwnerTransferResult;
  requirePending(row, at);
  requireExpectedVersion(row, input.expected_version);

  const atCancel = nowMs();
  const eventKey = `owner_transfer_cancelled:${row.transfer_id}:${input.request_id}`;
  const result: OwnerTransferResult = {
    transfer_id: row.transfer_id,
    room_id: row.room_id,
    status: 'cancelled',
  };
  const target = await getMember(db, row.room_id, row.to_actor_id);

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, atCancel),
      roomDissolvedGuardStatement(db, row.room_id),
      requestExpiredGuard(db, row.transfer_id, atCancel),
      pendingTransferVersionGuard(
        db,
        row.transfer_id,
        input.expected_version,
        'from_owner_id',
        caller,
        atCancel,
      ),
      ownerStillResponsibleGuard(db, row.room_id, caller),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'room',
          scopeId: row.room_id,
          eventType: 'room_owner_transfer_cancelled',
          refId: row.transfer_id,
          metadata: {
            room_id: row.room_id,
            transfer_id: row.transfer_id,
            from_owner_id: row.from_owner_id,
            to_actor_id: row.to_actor_id,
            changed_by: caller,
          },
        },
        atCancel,
      ),
      outboxStatement(db, { topic: roomTopic(row.room_id), eventKey }, atCancel),
      db
        .prepare(
          `UPDATE room_owner_transfers
              SET status = 'cancelled', version = version + 1, responded_at = ?,
                  responded_by = ?, updated_at = ?
            WHERE transfer_id = ? AND status = 'pending' AND version = ?`,
        )
        .bind(atCancel, caller, atCancel, row.transfer_id, input.expected_version),
      ...transferInboxStatement(
        db,
        {
          roomId: row.room_id,
          actor: row.to_actor_id,
          eventType: 'room_owner_transfer_cancelled',
          transferId: row.transfer_id,
          eventKey: `${eventKey}:inbox:${row.to_actor_id}`,
          metadata: { from_owner_id: row.from_owner_id, changed_by: caller },
        },
        atCancel,
      ),
      roomMemberVersionStatement(db, row.room_id, eventKey, atCancel),
      roomAuditStatement(
        db,
        {
          roomId: row.room_id,
          action: 'owner_transfer_cancelled',
          targetActorId: row.to_actor_id,
          previousRole: target?.role ?? null,
          newRole: target?.role ?? null,
          previousStatus: target?.status ?? null,
          newStatus: target?.status ?? null,
          resultingRevision: target?.role_revision ?? 0,
          changedBy: caller,
          requestId: input.request_id,
          detail: { transfer_id: row.transfer_id },
        },
        atCancel,
      ),
    ],
  });
  return result;
}
