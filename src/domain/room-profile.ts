import { BusinessError } from '../contracts/errors';
import type { RoomRenameInput } from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement, outboxStatement, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { operationsStatement, resolveReplay, runIdempotent } from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import { capabilityGuardStatement, requireGroupAccess, roomDissolvedGuardStatement } from './room-access';
import { roomGet, type RoomDetail } from './rooms';

/** Existing title and transaction guards provide compare-and-set without a schema migration. */
export async function roomRename(
  db: D1Database, principal: Principal, input: RoomRenameInput,
): Promise<RoomDetail> {
  const caller = actorId(principal);
  const access = await requireGroupAccess(db, input.room_id, caller, 'edit_profile');
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (!replay.found && access.room.title !== input.expected_title) {
    throw new BusinessError('VERSION_CONFLICT', '群名称已变化，请重新读取后再保存');
  }
  const at = nowMs();
  const eventKey = `room-profile:${input.room_id}:${input.request_id}`;
  await runIdempotent(db, {
    actorId: caller, requestId: input.request_id, payloadHash,
    result: { room_id: input.room_id },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      capabilityGuardStatement(db, input.room_id, caller, 'edit_profile'),
      roomDissolvedGuardStatement(db, input.room_id),
      db.prepare(guardSql('versionConflict',
        'NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = ? AND title = ?)'))
        .bind(input.room_id, input.expected_title),
      db.prepare('UPDATE rooms SET title = ?, updated_at = ? WHERE room_id = ?')
        .bind(input.title, at, input.room_id),
      // Durable event records the actor and operation, without creating chat messages/unread.
      eventStatement(db, {
        eventKey, scopeKind: 'room', scopeId: input.room_id,
        eventType: 'room_profile_updated', refId: input.room_id,
        metadata: { changed_by: caller, field: 'title' },
      }, at),
      outboxStatement(db, { topic: roomTopic(input.room_id), eventKey }, at),
    ],
  });
  return roomGet(db, principal, input.room_id);
}
