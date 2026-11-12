/** rooms.ts 拆分模块：membership。纯移动，行为保持不变。 */

import { BusinessError } from '../../contracts/errors';
import { LIMITS } from '../../contracts/limits';
import { type RoomMembersUpdateInput } from '../../contracts/schemas';
import { nowMs, sha256Hex, sortedPairKey, stableStringify } from '../../storage/db';
import { eventStatement, inboxHeadStatement, inboxTopic, outboxStatement, roomMemberVersionStatement, roomTopic } from '../../storage/events';
import { guardSql } from '../../storage/guards';
import { getMember } from '../../storage/queries';
import { type RoomMemberRow } from '../../storage/rows';
import { operationsStatement, resolveReplay, runIdempotent } from '../../storage/transactions/runner';
import { contactBlockGuardStatement, isBlockedBetween, roomInviteRateGuardStatement } from '../contact-blocks';
import { actorId, type Principal } from '../principal';
import { capabilityGuardStatement, assertOwnerPresent, assertRoomWritable, loadRoomAccess, memberActionsFor, memberRemovalGuardStatement, ownerMissingGuardStatement, requireExpectedRoleRevision, roleRevisionGuardStatement, roomDissolvedGuardStatement } from '../room-access';
import { roomAuditStatement, type RoomAuditSpec } from '../room-audit';
import { revokeDirectInvitationStatement } from '../room-invitations';
import { ensureActors, uniqueOthers, requireJoinableTargets } from './create';
import { roomDetail } from './detail';
import { type RoomDetail } from './views';

export function cancelDeliveriesForMemberStatements(
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

export function membershipInboxStatements(
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

