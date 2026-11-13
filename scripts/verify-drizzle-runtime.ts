/**
 * 4C-1 Drizzle 只读查询运行时对比。
 *
 * 对 `src/storage/queries.ts` 中已迁移到 Drizzle 的核心读查询，逐条执行：
 * 1. 手写 SQL（迁移前的原语句）与 Drizzle 构建结果逐行比较，包含字段顺序；
 * 2. 比较 `EXPLAIN QUERY PLAN`，确认索引选择与扫描顺序不变；
 * 3. 记录 raw / Drizzle 构建+执行的基准耗时。
 *
 * 只读内存库，不触碰真实 DATA_DIR；执行仍走生产同款 `createD1()` shim。
 *
 * 用法：`bun scripts/verify-drizzle-runtime.ts`
 */

import { Database } from 'bun:sqlite';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { orm, schema } from '../src/storage/drizzle';
import {
  activeRoomCount,
  countActiveRoomMembers,
  countActiveRoomMembersWithJoinHistory,
  getActor,
  getActorBySession,
  getActorManagementByIds,
  getActorRowsByIds,
  getActorsByIds,
  getCredentialByHash,
  getEventsMinSeq,
  getLatestJoinRequestForApplicant,
  getMember,
  getOwnerTransferById,
  getRoom,
  getRoomInvitationById,
  getRoomJoinRequestById,
  isActiveMember,
  listActiveRoomManagerIds,
  listActiveRoomPeers,
  listJoinRequestRows,
  listPendingDirectInvitationMembers,
  listRoomAuditRows,
} from '../src/storage/queries';
import { check, checkEqual, checksPassed } from './lib/harness';

const ROOT = resolve(import.meta.dir, '..');
const MIGRATIONS = resolve(ROOT, 'migrations');

function seed(sqlite: Database): void {
  const actor = sqlite.prepare(
    `INSERT INTO actors
       (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
        pending_count, created_at, updated_at, archived_at, archived_by,
        disabled_at, disabled_by, disabled_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const actors: [string, string, string | null, string, number, number, number, number][] = [
    ['act_human_1', 'human', null, 'Alice', 11, 7, 0, 100],
    ['act_human_2', 'human', null, 'Bob', 0, 0, 0, 101],
    ['act_agent_1', 'agent', 'sess_atlas', 'Atlas', 0, 0, 2, 102],
    ['act_agent_2', 'agent', 'sess_bravo', 'Bravo', 0, 3, 0, 103],
    ['act_agent_3', 'agent', null, 'Charlie', 0, 0, 0, 104],
  ];
  for (const [id, kind, session, name, head, min, pending, created] of actors) {
    const archived = id === 'act_agent_2' ? 1_000 : null;
    const archivedBy = id === 'act_agent_2' ? 'act_human_1' : null;
    const disabled = id === 'act_agent_3' ? 2_000 : null;
    const disabledBy = id === 'act_agent_3' ? 'act_human_1' : null;
    const reason = id === 'act_agent_3' ? 'retired' : null;
    actor.run(
      id,
      kind,
      session,
      name,
      '{}',
      head,
      min,
      pending,
      created,
      created + 1,
      archived,
      archivedBy,
      disabled,
      disabledBy,
      reason,
    );
  }

  const credential = sqlite.prepare(
    `INSERT INTO credentials
       (credential_id, actor_id, device_id, token_hash, revoked_at, created_at,
        last_used_at, revoked_by, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  credential.run('cred_h1', 'act_human_1', 'dev_1', 'hash_h1', null, 10, 12, null, 'laptop');
  credential.run(
    'cred_a1',
    'act_agent_1',
    'dev_2',
    'hash_a1',
    20,
    11,
    null,
    'act_human_1',
    null,
  );
  credential.run('cred_a2', 'act_agent_2', 'dev_3', 'hash_a2', null, 12, null, null, null);

  const room = sqlite.prepare(
    `INSERT INTO rooms
       (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
        member_seq, last_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  room.run('room_direct_1', 'direct', null, '', 'pair_h1_a1', 5, 3, 2, null, 200, 300);
  room.run('room_direct_2', 'direct', null, '', 'pair_h1_a2', 2, 1, 2, null, 201, 200);
  room.run('room_group_1', 'group', 'act_human_1', 'Team', null, 9, 4, 4, null, 202, 400);

  const member = sqlite.prepare(
    `INSERT INTO room_members
       (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
        role_revision, updated_at, member_generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  member.run('room_direct_1', 'act_human_1', 'owner', 'active', 1, 2, 210, 1, 210, 1);
  member.run('room_direct_1', 'act_agent_1', 'member', 'active', 1, 1, 211, 1, 211, 1);
  member.run('room_direct_2', 'act_human_1', 'owner', 'active', 1, 2, 212, 1, 212, 1);
  member.run('room_direct_2', 'act_agent_2', 'member', 'active', 1, 1, 213, 1, 213, 1);
  member.run('room_group_1', 'act_human_1', 'owner', 'active', 1, 9, 214, 2, 214, 1);
  member.run('room_group_1', 'act_agent_1', 'admin', 'active', 2, 9, 215, 1, 215, 2);
  member.run('room_group_1', 'act_human_2', 'member', 'left', 3, 3, 216, 1, 216, 1);
  member.run('room_group_1', 'act_agent_3', 'member', 'active', 4, 4, 217, 1, 217, 3);

  const invitation = sqlite.prepare(
    `INSERT INTO room_invitations
       (invitation_id, room_id, inviter_id, target_actor_id, token_hash, kind, status,
        max_uses, used_count, expires_at, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  invitation.run('inv_direct_h2', 'room_group_1', 'act_human_1', 'act_human_2', null, 'direct', 'pending', 1, 0, 5_000, 1, 220, 220);
  invitation.run('inv_direct_archived', 'room_group_1', 'act_human_1', 'act_agent_2', null, 'direct', 'pending', 1, 0, 5_000, 1, 221, 221);
  invitation.run('inv_direct_expired', 'room_group_1', 'act_human_1', 'act_agent_3', null, 'direct', 'pending', 1, 0, 900, 1, 219, 219);
  invitation.run('inv_link_1', 'room_group_1', 'act_human_1', null, 'tok_hash_link_1', 'link', 'pending', 20, 3, 9_000, 1, 222, 222);

  const joinRequest = sqlite.prepare(
    `INSERT INTO room_join_requests
       (join_request_id, invitation_id, room_id, applicant_id, status, message, revision,
        created_at, updated_at, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  joinRequest.run('jrq_0', 'inv_link_1', 'room_group_1', 'act_agent_1', 'rejected', '', 2, 250, 250, 251, 'act_human_1');
  joinRequest.run('jrq_1', 'inv_link_1', 'room_group_1', 'act_human_2', 'pending', '', 1, 300, 300, null, null);
  joinRequest.run('jrq_2', 'inv_link_1', 'room_group_1', 'act_agent_3', 'approved', 'hi', 2, 299, 299, 299, 'act_human_1');
  joinRequest.run('jrq_3', 'inv_link_1', 'room_group_1', 'act_agent_1', 'pending', '', 1, 300, 300, null, null);

  sqlite
    .prepare(
      `INSERT INTO room_owner_transfers
         (transfer_id, room_id, from_owner_id, to_actor_id, status, version,
          target_role_revision, invalid_reason, created_at, updated_at, expires_at,
          responded_at, responded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('tr_1', 'room_group_1', 'act_human_1', 'act_agent_1', 'pending', 1, 1, null, 400, 400, 9_000, null, null);

  const audit = sqlite.prepare(
    `INSERT INTO room_management_audit
       (audit_id, room_id, action, target_actor_id, previous_role, new_role,
        previous_status, new_status, expected_revision, resulting_revision, changed_by,
        request_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  audit.run('aud_3', 'room_group_1', 'member_added', 'act_agent_1', null, 'admin', null, 'active', null, 2, 'act_human_1', 'req_3', '{"note":"c"}', 500);
  audit.run('aud_2', 'room_group_1', 'admin_appointed', 'act_agent_1', 'member', 'admin', 'active', 'active', 1, 2, 'act_human_1', 'req_2', '{"note":"b"}', 500);
  audit.run('aud_1', 'room_group_1', 'policy_updated', null, null, null, null, null, null, 2, 'act_human_1', 'req_1', '{"note":"a"}', 499);
}

function rawFirst<T>(sqlite: Database, sql: string, params: unknown[]): T | null {
  return (sqlite.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function rawAll<T>(sqlite: Database, sql: string, params: unknown[]): T[] {
  return sqlite.prepare(sql).all(...(params as never[])) as T[];
}

function plan(sqlite: Database, sql: string, params: unknown[]): string[] {
  return (
    sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
      detail: string;
    }[]
  ).map((row) => row.detail.replace(/\s+/gu, ' ').trim());
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

async function rowParityChecks(sqlite: Database, db: D1Database): Promise<void> {
  const actorIds = ['act_human_1', 'act_agent_2', 'act_agent_3'];
  checkEqual(
    'getActor human',
    JSON.stringify(await getActor(db, 'act_human_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_human_1'])),
  );
  checkEqual(
    'getActor agent',
    JSON.stringify(await getActor(db, 'act_agent_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_1'])),
  );
  checkEqual(
    'getActor archived',
    JSON.stringify(await getActor(db, 'act_agent_2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_2'])),
  );
  checkEqual('getActor missing', await getActor(db, 'missing'), null);

  checkEqual(
    'getActorBySession',
    JSON.stringify(await getActorBySession(db, 'sess_atlas')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM actors WHERE agent_session_id = ?', ['sess_atlas']),
    ),
  );
  checkEqual('getActorBySession missing', await getActorBySession(db, 'sess_missing'), null);

  checkEqual('getActorsByIds empty', JSON.stringify(await getActorsByIds(db, [])), '[]');
  checkEqual(
    'getActorsByIds many',
    JSON.stringify(await getActorsByIds(db, actorIds)),
    JSON.stringify(
      rawAll(sqlite, `SELECT actor_id, kind FROM actors WHERE actor_id IN (${placeholders(actorIds)})`, actorIds),
    ),
  );
  checkEqual(
    'getActorsByIds duplicates collapsed',
    JSON.stringify(await getActorsByIds(db, ['act_agent_1', 'act_agent_1'])),
    JSON.stringify(
      rawAll(sqlite, 'SELECT actor_id, kind FROM actors WHERE actor_id IN (?, ?)', [
        'act_agent_1',
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getActorsByIds missing ids',
    JSON.stringify(await getActorsByIds(db, ['act_human_1', 'missing'])),
    JSON.stringify(
      rawAll(sqlite, 'SELECT actor_id, kind FROM actors WHERE actor_id IN (?, ?)', [
        'act_human_1',
        'missing',
      ]),
    ),
  );

  const managementSql = `SELECT actor_id, kind, agent_session_id, name, archived_at, archived_by,
              disabled_at, disabled_by, disabled_reason
         FROM actors WHERE actor_id IN (${placeholders(actorIds)})`;
  checkEqual(
    'getActorManagementByIds',
    JSON.stringify(await getActorManagementByIds(db, actorIds)),
    JSON.stringify(rawAll(sqlite, managementSql, actorIds)),
  );
  checkEqual('getActorManagementByIds empty', JSON.stringify(await getActorManagementByIds(db, [])), '[]');

  checkEqual(
    'getRoom direct',
    JSON.stringify(await getRoom(db, 'room_direct_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM rooms WHERE room_id = ?', ['room_direct_1'])),
  );
  checkEqual(
    'getRoom group',
    JSON.stringify(await getRoom(db, 'room_group_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM rooms WHERE room_id = ?', ['room_group_1'])),
  );
  checkEqual('getRoom missing', await getRoom(db, 'room_missing'), null);

  checkEqual(
    'getMember active',
    JSON.stringify(await getMember(db, 'room_group_1', 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
        'room_group_1',
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getMember left',
    JSON.stringify(await getMember(db, 'room_group_1', 'act_human_2')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
        'room_group_1',
        'act_human_2',
      ]),
    ),
  );
  checkEqual('getMember missing', await getMember(db, 'room_group_1', 'missing'), null);

  checkEqual('isActiveMember true', await isActiveMember(db, 'room_group_1', 'act_agent_1'), true);
  checkEqual('isActiveMember left', await isActiveMember(db, 'room_group_1', 'act_human_2'), false);
  checkEqual('isActiveMember missing', await isActiveMember(db, 'room_group_1', 'missing'), false);

  checkEqual(
    'activeRoomCount human',
    await activeRoomCount(db, 'act_human_1'),
    rawFirst<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'", [
      'act_human_1',
    ])?.n ?? 0,
  );
  checkEqual('activeRoomCount agent', await activeRoomCount(db, 'act_agent_1'), 2);
  checkEqual('activeRoomCount missing', await activeRoomCount(db, 'missing'), 0);

  checkEqual(
    'getCredentialByHash active',
    JSON.stringify(await getCredentialByHash(db, 'hash_h1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM credentials WHERE token_hash = ?', ['hash_h1'])),
  );
  checkEqual(
    'getCredentialByHash revoked',
    JSON.stringify(await getCredentialByHash(db, 'hash_a1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM credentials WHERE token_hash = ?', ['hash_a1'])),
  );
  checkEqual('getCredentialByHash missing', await getCredentialByHash(db, 'missing'), null);

  const peerSql = (roomIds: string[]): string =>
    `SELECT rm.room_id, a.actor_id, a.name, a.kind
       FROM room_members rm
       JOIN actors a ON a.actor_id = rm.actor_id
      WHERE rm.room_id IN (${placeholders(roomIds)})
        AND rm.status = 'active'
        AND rm.actor_id <> ?
      ORDER BY rm.room_id, a.actor_id`;
  checkEqual('listActiveRoomPeers empty', JSON.stringify(await listActiveRoomPeers(db, [], 'act_human_1')), '[]');
  const peerRooms = ['room_direct_1', 'room_direct_2', 'room_group_1'];
  checkEqual(
    'listActiveRoomPeers page',
    JSON.stringify(await listActiveRoomPeers(db, peerRooms, 'act_human_1')),
    JSON.stringify(rawAll(sqlite, peerSql(peerRooms), [...peerRooms, 'act_human_1'])),
  );
  checkEqual(
    'listActiveRoomPeers single',
    JSON.stringify(await listActiveRoomPeers(db, ['room_direct_1'], 'act_agent_1')),
    JSON.stringify(rawAll(sqlite, peerSql(['room_direct_1']), ['room_direct_1', 'act_agent_1'])),
  );

  checkEqual(
    'getEventsMinSeq room',
    await getEventsMinSeq(db, 'room', 'room_group_1'),
    rawFirst<{ events_min_seq: number }>(sqlite, 'SELECT events_min_seq FROM rooms WHERE room_id = ?', [
      'room_group_1',
    ])?.events_min_seq ?? 0,
  );
  checkEqual(
    'getEventsMinSeq inbox',
    await getEventsMinSeq(db, 'inbox', 'act_human_1'),
    rawFirst<{ inbox_min_seq: number }>(sqlite, 'SELECT inbox_min_seq FROM actors WHERE actor_id = ?', [
      'act_human_1',
    ])?.inbox_min_seq ?? 0,
  );
  checkEqual('getEventsMinSeq actor', await getEventsMinSeq(db, 'actor', 'act_human_1'), 0);

  // 4C-3 rooms 域只读查询：逐行与迁移前手写 SQL 对比。
  checkEqual('getActorRowsByIds empty', JSON.stringify(await getActorRowsByIds(db, [])), '[]');
  checkEqual(
    'getActorRowsByIds many',
    JSON.stringify(await getActorRowsByIds(db, actorIds)),
    JSON.stringify(
      rawAll(sqlite, `SELECT * FROM actors WHERE actor_id IN (${placeholders(actorIds)})`, actorIds),
    ),
  );

  checkEqual(
    'countActiveRoomMembers group',
    await countActiveRoomMembers(db, 'room_group_1'),
    rawFirst<{ n: number }>(
      sqlite,
      "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'",
      ['room_group_1'],
    )?.n ?? 0,
  );
  checkEqual('countActiveRoomMembers missing', await countActiveRoomMembers(db, 'room_missing'), 0);
  checkEqual(
    'countActiveRoomMembersWithJoinHistory group',
    await countActiveRoomMembersWithJoinHistory(db, 'room_group_1'),
    rawFirst<{ n: number }>(
      sqlite,
      "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active' AND joined_seq > 0",
      ['room_group_1'],
    )?.n ?? 0,
  );
  checkEqual(
    'countActiveRoomMembersWithJoinHistory missing',
    await countActiveRoomMembersWithJoinHistory(db, 'room_missing'),
    0,
  );

  const managerSql = "SELECT actor_id FROM room_members WHERE room_id = ? AND status = 'active' AND role IN ('owner', 'admin')";
  checkEqual(
    'listActiveRoomManagerIds group',
    JSON.stringify([...(await listActiveRoomManagerIds(db, 'room_group_1'))].sort()),
    JSON.stringify(
      (rawAll<{ actor_id: string }>(sqlite, managerSql, ['room_group_1']) as { actor_id: string }[])
        .map((row) => row.actor_id)
        .sort(),
    ),
  );
  checkEqual('listActiveRoomManagerIds missing', JSON.stringify(await listActiveRoomManagerIds(db, 'room_missing')), '[]');

  const invitedSql = `SELECT i.invitation_id, i.target_actor_id AS actor_id, a.kind, a.name,
              i.inviter_id AS invited_by, i.created_at, i.expires_at
         FROM room_invitations i
         JOIN actors a ON a.actor_id = i.target_actor_id
        WHERE i.room_id = ? AND i.kind = 'direct' AND i.status = 'pending'
          AND i.expires_at > ? AND (a.kind <> 'agent' OR a.archived_at IS NULL)
        ORDER BY i.created_at ASC, i.invitation_id ASC`;
  checkEqual(
    'listPendingDirectInvitationMembers group',
    JSON.stringify(await listPendingDirectInvitationMembers(db, 'room_group_1', 1_000)),
    JSON.stringify(rawAll(sqlite, invitedSql, ['room_group_1', 1_000])),
  );
  checkEqual(
    'listPendingDirectInvitationMembers hides archived agent',
    JSON.stringify(await listPendingDirectInvitationMembers(db, 'room_group_1', 1_000)),
    JSON.stringify(
      rawAll(sqlite, invitedSql, ['room_group_1', 1_000]).filter(
        (row) => (row as { actor_id: string }).actor_id !== 'act_agent_2',
      ),
    ),
  );
  checkEqual(
    'listPendingDirectInvitationMembers later cutoff',
    JSON.stringify(await listPendingDirectInvitationMembers(db, 'room_group_1', 5_000)),
    JSON.stringify(rawAll(sqlite, invitedSql, ['room_group_1', 5_000])),
  );

  checkEqual(
    'getRoomInvitationById direct',
    JSON.stringify(await getRoomInvitationById(db, 'inv_direct_h2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_invitations WHERE invitation_id = ?', ['inv_direct_h2'])),
  );
  checkEqual(
    'getRoomInvitationById link',
    JSON.stringify(await getRoomInvitationById(db, 'inv_link_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_invitations WHERE invitation_id = ?', ['inv_link_1'])),
  );
  checkEqual('getRoomInvitationById missing', await getRoomInvitationById(db, 'missing'), null);

  checkEqual(
    'getRoomJoinRequestById',
    JSON.stringify(await getRoomJoinRequestById(db, 'jrq_2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_join_requests WHERE join_request_id = ?', ['jrq_2'])),
  );
  checkEqual('getRoomJoinRequestById missing', await getRoomJoinRequestById(db, 'missing'), null);

  const latestSql = `SELECT * FROM room_join_requests
        WHERE invitation_id = ? AND applicant_id = ?
        ORDER BY created_at DESC, join_request_id DESC LIMIT 1`;
  checkEqual(
    'getLatestJoinRequestForApplicant',
    JSON.stringify(await getLatestJoinRequestForApplicant(db, 'inv_link_1', 'act_agent_1')),
    JSON.stringify(rawFirst(sqlite, latestSql, ['inv_link_1', 'act_agent_1'])),
  );
  checkEqual(
    'getLatestJoinRequestForApplicant missing',
    await getLatestJoinRequestForApplicant(db, 'inv_link_1', 'act_human_1'),
    null,
  );

  checkEqual(
    'getOwnerTransferById',
    JSON.stringify(await getOwnerTransferById(db, 'tr_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_owner_transfers WHERE transfer_id = ?', ['tr_1'])),
  );
  checkEqual('getOwnerTransferById missing', await getOwnerTransferById(db, 'missing'), null);

  const joinRequestListSql = `SELECT jr.*, i.kind AS invitation_kind, i.status AS invitation_status,
              i.expires_at AS invitation_expires_at,
              i.max_uses AS invitation_max_uses,
              i.used_count AS invitation_used_count,
              a.kind AS applicant_kind, a.name AS applicant_name,
              a.agent_session_id AS applicant_session_id
         FROM room_join_requests jr
         JOIN room_invitations i ON i.invitation_id = jr.invitation_id
         JOIN actors a ON a.actor_id = jr.applicant_id
        WHERE jr.room_id = ? AND jr.status = ?
        ORDER BY jr.created_at DESC, jr.join_request_id DESC
        LIMIT ?`;
  checkEqual(
    'listJoinRequestRows pending',
    JSON.stringify(await listJoinRequestRows(db, 'room_group_1', 'pending', null, 10)),
    JSON.stringify(rawAll(sqlite, joinRequestListSql, ['room_group_1', 'pending', 10])),
  );
  checkEqual(
    'listJoinRequestRows page limit',
    JSON.stringify(await listJoinRequestRows(db, 'room_group_1', 'pending', null, 2)),
    JSON.stringify(rawAll(sqlite, joinRequestListSql, ['room_group_1', 'pending', 2])),
  );
  const joinRequestCursorSql = `SELECT jr.*, i.kind AS invitation_kind, i.status AS invitation_status,
              i.expires_at AS invitation_expires_at,
              i.max_uses AS invitation_max_uses,
              i.used_count AS invitation_used_count,
              a.kind AS applicant_kind, a.name AS applicant_name,
              a.agent_session_id AS applicant_session_id
         FROM room_join_requests jr
         JOIN room_invitations i ON i.invitation_id = jr.invitation_id
         JOIN actors a ON a.actor_id = jr.applicant_id
        WHERE jr.room_id = ? AND jr.status = ?
          AND (jr.created_at < ? OR (jr.created_at = ? AND jr.join_request_id < ?))
        ORDER BY jr.created_at DESC, jr.join_request_id DESC
        LIMIT ?`;
  checkEqual(
    'listJoinRequestRows cursor tie-break',
    JSON.stringify(
      await listJoinRequestRows(db, 'room_group_1', 'pending', { seq: 300, key: 'jrq_3' }, 10),
    ),
    JSON.stringify(rawAll(sqlite, joinRequestCursorSql, ['room_group_1', 'pending', 300, 300, 'jrq_3', 10])),
  );
  checkEqual(
    'listJoinRequestRows approved',
    JSON.stringify(await listJoinRequestRows(db, 'room_group_1', 'approved', null, 10)),
    JSON.stringify(rawAll(sqlite, joinRequestListSql, ['room_group_1', 'approved', 10])),
  );

  const auditListSql = `SELECT a.*, target.name AS target_name, changer.name AS changed_by_name
         FROM room_management_audit a
         LEFT JOIN actors target ON target.actor_id = a.target_actor_id
         LEFT JOIN actors changer ON changer.actor_id = a.changed_by
        WHERE a.room_id = ?
        ORDER BY a.created_at DESC, a.audit_id DESC
        LIMIT ?`;
  checkEqual(
    'listRoomAuditRows page',
    JSON.stringify(await listRoomAuditRows(db, 'room_group_1', null, 10)),
    JSON.stringify(rawAll(sqlite, auditListSql, ['room_group_1', 10])),
  );
  checkEqual(
    'listRoomAuditRows limit',
    JSON.stringify(await listRoomAuditRows(db, 'room_group_1', null, 2)),
    JSON.stringify(rawAll(sqlite, auditListSql, ['room_group_1', 2])),
  );
  const auditCursorSql = `SELECT a.*, target.name AS target_name, changer.name AS changed_by_name
         FROM room_management_audit a
         LEFT JOIN actors target ON target.actor_id = a.target_actor_id
         LEFT JOIN actors changer ON changer.actor_id = a.changed_by
        WHERE a.room_id = ?
          AND (a.created_at < ? OR (a.created_at = ? AND a.audit_id < ?))
        ORDER BY a.created_at DESC, a.audit_id DESC
        LIMIT ?`;
  checkEqual(
    'listRoomAuditRows cursor tie-break',
    JSON.stringify(await listRoomAuditRows(db, 'room_group_1', { seq: 500, key: 'aud_2' }, 10)),
    JSON.stringify(rawAll(sqlite, auditCursorSql, ['room_group_1', 500, 500, 'aud_2', 10])),
  );
  checkEqual(
    'listRoomAuditRows empty',
    JSON.stringify(await listRoomAuditRows(db, 'room_missing', null, 10)),
    '[]',
  );
}

function explainChecks(sqlite: Database, db: D1Database): void {
  const auditTarget = alias(schema.actors, 'target');
  const auditChanger = alias(schema.actors, 'changer');
  const cases: { label: string; raw: string; params: unknown[]; query: { toSQL(): { sql: string; params: unknown[] } } }[] = [
    {
      label: 'getActor',
      raw: 'SELECT * FROM actors WHERE actor_id = ?',
      params: ['act_agent_1'],
      query: orm(db).select().from(schema.actors).where(eq(schema.actors.actor_id, 'act_agent_1')),
    },
    {
      label: 'getActorBySession',
      raw: 'SELECT * FROM actors WHERE agent_session_id = ?',
      params: ['sess_atlas'],
      query: orm(db)
        .select()
        .from(schema.actors)
        .where(eq(schema.actors.agent_session_id, 'sess_atlas')),
    },
    {
      label: 'getRoom',
      raw: 'SELECT * FROM rooms WHERE room_id = ?',
      params: ['room_direct_1'],
      query: orm(db).select().from(schema.rooms).where(eq(schema.rooms.room_id, 'room_direct_1')),
    },
    {
      label: 'getMember',
      raw: 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?',
      params: ['room_group_1', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.actor_id, 'act_agent_1'),
          ),
        ),
    },
    {
      label: 'isActiveMember',
      raw: "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
      params: ['room_group_1', 'act_agent_1'],
      query: orm(db)
        .select({ ok: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.actor_id, 'act_agent_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        )
        .limit(1),
    },
    {
      label: 'activeRoomCount',
      raw: "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'",
      params: ['act_human_1'],
      query: orm(db)
        .select({ n: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.actor_id, 'act_human_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        ),
    },
    {
      label: 'getCredentialByHash',
      raw: 'SELECT * FROM credentials WHERE token_hash = ?',
      params: ['hash_h1'],
      query: orm(db)
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.token_hash, 'hash_h1')),
    },
    {
      label: 'listActiveRoomPeers',
      raw: `SELECT room_members.room_id, actors.actor_id, actors.name, actors.kind
              FROM room_members
              JOIN actors ON actors.actor_id = room_members.actor_id
             WHERE room_members.room_id IN (?, ?, ?)
               AND room_members.status = 'active'
               AND room_members.actor_id <> ?
             ORDER BY room_members.room_id, actors.actor_id`,
      params: ['room_direct_1', 'room_direct_2', 'room_group_1', 'act_human_1'],
      query: orm(db)
        .select({
          room_id: schema.roomMembers.room_id,
          actor_id: schema.actors.actor_id,
          name: schema.actors.name,
          kind: schema.actors.kind,
        })
        .from(schema.roomMembers)
        .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.roomMembers.actor_id))
        .where(
          and(
            inArray(schema.roomMembers.room_id, [
              'room_direct_1',
              'room_direct_2',
              'room_group_1',
            ]),
            eq(schema.roomMembers.status, 'active'),
            ne(schema.roomMembers.actor_id, 'act_human_1'),
          ),
        )
        .orderBy(schema.roomMembers.room_id, schema.actors.actor_id),
    },
    {
      label: 'getActorRowsByIds',
      raw: 'SELECT * FROM actors WHERE actor_id IN (?, ?, ?)',
      params: ['act_human_1', 'act_agent_2', 'act_agent_3'],
      query: orm(db)
        .select()
        .from(schema.actors)
        .where(inArray(schema.actors.actor_id, ['act_human_1', 'act_agent_2', 'act_agent_3'])),
    },
    {
      label: 'countActiveRoomMembers',
      raw: "SELECT count(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'",
      params: ['room_group_1'],
      query: orm(db)
        .select({ n: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        ),
    },
    {
      label: 'countActiveRoomMembersWithJoinHistory',
      raw: "SELECT count(*) AS n FROM room_members WHERE room_id = ? AND status = 'active' AND joined_seq > 0",
      params: ['room_group_1'],
      query: orm(db)
        .select({ n: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.status, 'active'),
            gt(schema.roomMembers.joined_seq, 0),
          ),
        ),
    },
    {
      label: 'listActiveRoomManagerIds',
      raw: "SELECT actor_id FROM room_members WHERE room_id = ? AND status = 'active' AND role IN ('owner', 'admin')",
      params: ['room_group_1'],
      query: orm(db)
        .select({ actor_id: schema.roomMembers.actor_id })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.status, 'active'),
            inArray(schema.roomMembers.role, ['owner', 'admin']),
          ),
        ),
    },
    {
      label: 'listPendingDirectInvitationMembers',
      raw: `SELECT room_invitations.invitation_id, room_invitations.target_actor_id AS actor_id,
              actors.kind, actors.name,
              room_invitations.inviter_id AS invited_by,
              room_invitations.created_at, room_invitations.expires_at
         FROM room_invitations
         JOIN actors ON actors.actor_id = room_invitations.target_actor_id
        WHERE room_invitations.room_id = ? AND room_invitations.kind = 'direct'
          AND room_invitations.status = 'pending'
          AND room_invitations.expires_at > ?
          AND (actors.kind <> 'agent' OR actors.archived_at IS NULL)
        ORDER BY room_invitations.created_at ASC, room_invitations.invitation_id ASC`,
      params: ['room_group_1', 1_000],
      query: orm(db)
        .select({
          invitation_id: schema.roomInvitations.invitation_id,
          actor_id: schema.roomInvitations.target_actor_id,
          kind: schema.actors.kind,
          name: schema.actors.name,
          invited_by: schema.roomInvitations.inviter_id,
          created_at: schema.roomInvitations.created_at,
          expires_at: schema.roomInvitations.expires_at,
        })
        .from(schema.roomInvitations)
        .innerJoin(
          schema.actors,
          eq(schema.actors.actor_id, schema.roomInvitations.target_actor_id),
        )
        .where(
          and(
            eq(schema.roomInvitations.room_id, 'room_group_1'),
            eq(schema.roomInvitations.kind, 'direct'),
            eq(schema.roomInvitations.status, 'pending'),
            gt(schema.roomInvitations.expires_at, 1_000),
            or(ne(schema.actors.kind, 'agent'), isNull(schema.actors.archived_at)),
          ),
        )
        .orderBy(asc(schema.roomInvitations.created_at), asc(schema.roomInvitations.invitation_id)),
    },
    {
      label: 'getRoomInvitationById',
      raw: 'SELECT * FROM room_invitations WHERE invitation_id = ?',
      params: ['inv_link_1'],
      query: orm(db)
        .select()
        .from(schema.roomInvitations)
        .where(eq(schema.roomInvitations.invitation_id, 'inv_link_1')),
    },
    {
      label: 'getRoomJoinRequestById',
      raw: 'SELECT * FROM room_join_requests WHERE join_request_id = ?',
      params: ['jrq_2'],
      query: orm(db)
        .select()
        .from(schema.roomJoinRequests)
        .where(eq(schema.roomJoinRequests.join_request_id, 'jrq_2')),
    },
    {
      label: 'getLatestJoinRequestForApplicant',
      raw: `SELECT * FROM room_join_requests
        WHERE invitation_id = ? AND applicant_id = ?
        ORDER BY created_at DESC, join_request_id DESC LIMIT 1`,
      params: ['inv_link_1', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.roomJoinRequests)
        .where(
          and(
            eq(schema.roomJoinRequests.invitation_id, 'inv_link_1'),
            eq(schema.roomJoinRequests.applicant_id, 'act_agent_1'),
          ),
        )
        .orderBy(
          desc(schema.roomJoinRequests.created_at),
          desc(schema.roomJoinRequests.join_request_id),
        )
        .limit(1),
    },
    {
      label: 'getOwnerTransferById',
      raw: 'SELECT * FROM room_owner_transfers WHERE transfer_id = ?',
      params: ['tr_1'],
      query: orm(db)
        .select()
        .from(schema.roomOwnerTransfers)
        .where(eq(schema.roomOwnerTransfers.transfer_id, 'tr_1')),
    },
    {
      label: 'listJoinRequestRows',
      raw: `SELECT room_join_requests.*,
              room_invitations.kind AS invitation_kind,
              room_invitations.status AS invitation_status,
              room_invitations.expires_at AS invitation_expires_at,
              room_invitations.max_uses AS invitation_max_uses,
              room_invitations.used_count AS invitation_used_count,
              actors.kind AS applicant_kind, actors.name AS applicant_name,
              actors.agent_session_id AS applicant_session_id
         FROM room_join_requests
         JOIN room_invitations
           ON room_invitations.invitation_id = room_join_requests.invitation_id
         JOIN actors ON actors.actor_id = room_join_requests.applicant_id
        WHERE room_join_requests.room_id = ? AND room_join_requests.status = ?
        ORDER BY room_join_requests.created_at DESC, room_join_requests.join_request_id DESC
        LIMIT ?`,
      params: ['room_group_1', 'pending', 10],
      query: orm(db)
        .select({
          join_request_id: schema.roomJoinRequests.join_request_id,
          invitation_kind: schema.roomInvitations.kind,
          applicant_name: schema.actors.name,
        })
        .from(schema.roomJoinRequests)
        .innerJoin(
          schema.roomInvitations,
          eq(schema.roomInvitations.invitation_id, schema.roomJoinRequests.invitation_id),
        )
        .innerJoin(
          schema.actors,
          eq(schema.actors.actor_id, schema.roomJoinRequests.applicant_id),
        )
        .where(
          and(
            eq(schema.roomJoinRequests.room_id, 'room_group_1'),
            eq(schema.roomJoinRequests.status, 'pending'),
          ),
        )
        .orderBy(
          desc(schema.roomJoinRequests.created_at),
          desc(schema.roomJoinRequests.join_request_id),
        )
        .limit(10),
    },
    {
      label: 'listJoinRequestRows cursor',
      raw: `SELECT room_join_requests.*,
              room_invitations.kind AS invitation_kind,
              room_invitations.status AS invitation_status,
              room_invitations.expires_at AS invitation_expires_at,
              room_invitations.max_uses AS invitation_max_uses,
              room_invitations.used_count AS invitation_used_count,
              actors.kind AS applicant_kind, actors.name AS applicant_name,
              actors.agent_session_id AS applicant_session_id
         FROM room_join_requests
         JOIN room_invitations
           ON room_invitations.invitation_id = room_join_requests.invitation_id
         JOIN actors ON actors.actor_id = room_join_requests.applicant_id
        WHERE room_join_requests.room_id = ? AND room_join_requests.status = ?
          AND (room_join_requests.created_at < ?
               OR (room_join_requests.created_at = ?
                   AND room_join_requests.join_request_id < ?))
        ORDER BY room_join_requests.created_at DESC, room_join_requests.join_request_id DESC
        LIMIT ?`,
      params: ['room_group_1', 'pending', 300, 300, 'jrq_3', 10],
      query: orm(db)
        .select({
          join_request_id: schema.roomJoinRequests.join_request_id,
          invitation_kind: schema.roomInvitations.kind,
          applicant_name: schema.actors.name,
        })
        .from(schema.roomJoinRequests)
        .innerJoin(
          schema.roomInvitations,
          eq(schema.roomInvitations.invitation_id, schema.roomJoinRequests.invitation_id),
        )
        .innerJoin(
          schema.actors,
          eq(schema.actors.actor_id, schema.roomJoinRequests.applicant_id),
        )
        .where(
          and(
            eq(schema.roomJoinRequests.room_id, 'room_group_1'),
            eq(schema.roomJoinRequests.status, 'pending'),
            or(
              lt(schema.roomJoinRequests.created_at, 300),
              and(
                eq(schema.roomJoinRequests.created_at, 300),
                lt(schema.roomJoinRequests.join_request_id, 'jrq_3'),
              ),
            )!,
          ),
        )
        .orderBy(
          desc(schema.roomJoinRequests.created_at),
          desc(schema.roomJoinRequests.join_request_id),
        )
        .limit(10),
    },
    {
      label: 'listRoomAuditRows',
      raw: `SELECT room_management_audit.*, target.name AS target_name,
              changer.name AS changed_by_name
         FROM room_management_audit
         LEFT JOIN actors target
           ON target.actor_id = room_management_audit.target_actor_id
         LEFT JOIN actors changer
           ON changer.actor_id = room_management_audit.changed_by
        WHERE room_management_audit.room_id = ?
        ORDER BY room_management_audit.created_at DESC, room_management_audit.audit_id DESC
        LIMIT ?`,
      params: ['room_group_1', 10],
      query: orm(db)
        .select({
          audit_id: schema.roomManagementAudit.audit_id,
          target_name: auditTarget.name,
          changed_by_name: auditChanger.name,
        })
        .from(schema.roomManagementAudit)
        .leftJoin(
          auditTarget,
          eq(auditTarget.actor_id, schema.roomManagementAudit.target_actor_id),
        )
        .leftJoin(
          auditChanger,
          eq(auditChanger.actor_id, schema.roomManagementAudit.changed_by),
        )
        .where(eq(schema.roomManagementAudit.room_id, 'room_group_1'))
        .orderBy(
          desc(schema.roomManagementAudit.created_at),
          desc(schema.roomManagementAudit.audit_id),
        )
        .limit(10),
    },
  ];

  for (const item of cases) {
    const compiled = item.query.toSQL();
    checkEqual(
      `EXPLAIN ${item.label}`,
      JSON.stringify(plan(sqlite, compiled.sql, compiled.params)),
      JSON.stringify(plan(sqlite, item.raw, item.params)),
    );
  }
}

async function bench(label: string, fn: () => Promise<unknown>, iterations = 3_000): Promise<string> {
  for (let index = 0; index < 200; index += 1) await fn();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) await fn();
  const elapsed = performance.now() - started;
  return `${label}: ${elapsed.toFixed(1)}ms / ${iterations} (${(elapsed / iterations * 1000).toFixed(1)}µs/op)`;
}

async function benchmark(sqlite: Database, db: D1Database): Promise<void> {
  const rawActor = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_1']);
  const ormActor = async (): Promise<unknown> => getActor(db, 'act_agent_1');
  const rawMember = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
      'room_group_1',
      'act_agent_1',
    ]);
  const ormMember = async (): Promise<unknown> => getMember(db, 'room_group_1', 'act_agent_1');
  const rawCount = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'", [
      'act_human_1',
    ]);
  const ormCount = async (): Promise<unknown> => activeRoomCount(db, 'act_human_1');
  const rawIdentity = async (): Promise<unknown> => {
    const credential = rawFirst<{ actor_id: string }>(
      sqlite,
      'SELECT * FROM credentials WHERE token_hash = ?',
      ['hash_h1'],
    );
    if (!credential) return null;
    return rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', [credential.actor_id]);
  };
  const ormIdentity = async (): Promise<unknown> => {
    const credential = await getCredentialByHash(db, 'hash_h1');
    if (!credential) return null;
    return getActor(db, credential.actor_id);
  };
  const rawInvitation = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM room_invitations WHERE invitation_id = ?', ['inv_link_1']);
  const ormInvitation = async (): Promise<unknown> => getRoomInvitationById(db, 'inv_link_1');
  const rawMemberCount = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'", [
      'room_group_1',
    ]);
  const ormMemberCount = async (): Promise<unknown> =>
    countActiveRoomMembers(db, 'room_group_1');

  console.log('\nread query benchmark (in-memory, includes drizzle build):');
  console.log(`  raw   ${await bench('actor', rawActor)}`);
  console.log(`  orm   ${await bench('actor', ormActor)}`);
  console.log(`  raw   ${await bench('member', rawMember)}`);
  console.log(`  orm   ${await bench('member', ormMember)}`);
  console.log(`  raw   ${await bench('count', rawCount)}`);
  console.log(`  orm   ${await bench('count', ormCount)}`);
  console.log(`  raw   ${await bench('identity', rawIdentity)}`);
  console.log(`  orm   ${await bench('identity', ormIdentity)}`);
  console.log(`  raw   ${await bench('invitation', rawInvitation)}`);
  console.log(`  orm   ${await bench('invitation', ormInvitation)}`);
  console.log(`  raw   ${await bench('room_member_count', rawMemberCount)}`);
  console.log(`  orm   ${await bench('room_member_count', ormMemberCount)}`);
}

async function main(): Promise<void> {
  const sqlite = new Database(':memory:');
  migrate(sqlite, MIGRATIONS);
  seed(sqlite);
  const db = createD1(sqlite);
  try {
    await rowParityChecks(sqlite, db);
    explainChecks(sqlite, db);
    await benchmark(sqlite, db);
    console.log(`\ndrizzle runtime checks passed: ${checksPassed()}`);
  } finally {
    sqlite.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
