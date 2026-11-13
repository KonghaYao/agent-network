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
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { orm, schema } from '../src/storage/drizzle';
import {
  activeRoomCount,
  countActiveCredentials,
  findActiveContactBlockBetween,
  getActiveAgentManagement,
  getActiveContactBlock,
  getActiveContactRelation,
  getActor,
  getActorBySession,
  getActorManagementByIds,
  getActorsByIds,
  getContact,
  getContactRelation,
  getContactRequestById,
  getCredentialByHash,
  getEventsMinSeq,
  getExpiredPendingContactRequestForPair,
  getMember,
  getPendingContactRequest,
  getRoom,
  isActiveMember,
  listActiveManagementBindings,
  listActiveRoomPeers,
  listContactBlocks,
  listExpiredPendingContactRequests,
  listMutedMentionBlockers,
  listPendingContactRequests,
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

  const contact = sqlite.prepare(
    'INSERT INTO contacts (owner_actor_id, target_actor_id, created_at) VALUES (?, ?, ?)',
  );
  contact.run('act_human_1', 'act_agent_1', 500);
  contact.run('act_human_1', 'act_human_2', 400);
  contact.run('act_human_1', 'act_agent_3', 300);
  contact.run('act_human_2', 'act_human_1', 350);

  const relation = sqlite.prepare(
    `INSERT INTO contact_relations
       (pair_key, actor_a, actor_b, status, source, request_id,
        created_at, updated_at, ended_at, ended_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  relation.run(
    'act_agent_1|act_human_1',
    'act_agent_1',
    'act_human_1',
    'active',
    'request',
    'req_1',
    500,
    510,
    null,
    null,
  );
  relation.run(
    'act_human_1|act_human_2',
    'act_human_1',
    'act_human_2',
    'ended',
    'auto_manager',
    null,
    300,
    320,
    330,
    'act_human_1',
  );

  const request = sqlite.prepare(
    `INSERT INTO contact_requests
       (contact_request_id, pair_key, from_actor_id, to_actor_id, message, status,
        auto_accepted, created_at, updated_at, expires_at, responded_at, responded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  request.run(
    'req_1',
    'act_agent_1|act_human_1',
    'act_human_1',
    'act_agent_1',
    'hello',
    'pending',
    0,
    600,
    601,
    900,
    null,
    null,
  );
  request.run(
    'req_2',
    'act_agent_2|act_human_1',
    'act_human_1',
    'act_agent_2',
    'hi',
    'pending',
    0,
    500,
    501,
    700,
    null,
    null,
  );
  request.run(
    'req_3',
    'act_human_1|act_human_2',
    'act_human_1',
    'act_human_2',
    'yo',
    'accepted',
    1,
    400,
    410,
    900,
    410,
    'act_human_1',
  );
  request.run(
    'req_4',
    'act_agent_3|act_human_1',
    'act_human_1',
    'act_agent_3',
    '',
    'pending',
    0,
    800,
    801,
    1200,
    null,
    null,
  );

  const block = sqlite.prepare(
    `INSERT INTO contact_blocks
       (block_id, blocker_actor_id, blocked_actor_id, reason, mute_mentions,
        created_at, released_at, released_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  block.run('blk_1', 'act_human_1', 'act_agent_3', 'spam', 1, 700, null, null);
  block.run('blk_2', 'act_human_2', 'act_human_1', '', 1, 650, 660, 'act_human_2');
  block.run('blk_3', 'act_human_1', 'act_agent_2', 'mute', 1, 720, null, null);

  const management = sqlite.prepare(
    `INSERT INTO agent_managements
       (binding_id, agent_id, manager_id, status, grant_source, scopes_json,
        permission_version, initiated_by, confirmed_by, created_at, confirmed_at,
        expires_at, revoked_at, revoked_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  management.run(
    'mg_1',
    'act_agent_1',
    'act_human_1',
    'active',
    'created',
    '["manage_agent"]',
    3,
    'act_human_1',
    'act_human_1',
    100,
    101,
    null,
    null,
    null,
    102,
  );
  management.run(
    'mg_2',
    'act_agent_3',
    'act_human_1',
    'revoked',
    'created',
    '[]',
    1,
    'act_human_1',
    null,
    110,
    111,
    null,
    120,
    'act_human_1',
    121,
  );
  management.run(
    'mg_3',
    'act_agent_2',
    'act_human_2',
    'active',
    'claim',
    '[]',
    1,
    'act_human_2',
    null,
    130,
    131,
    null,
    null,
    null,
    132,
  );
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

  checkEqual(
    'getContact existing',
    JSON.stringify(await getContact(db, 'act_human_1', 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM contacts WHERE owner_actor_id = ? AND target_actor_id = ?', [
        'act_human_1',
        'act_agent_1',
      ]),
    ),
  );
  checkEqual('getContact missing', await getContact(db, 'act_human_1', 'act_agent_2'), null);

  checkEqual(
    'getActiveContactRelation',
    JSON.stringify(await getActiveContactRelation(db, 'act_agent_1|act_human_1')),
    JSON.stringify(
      rawFirst(
        sqlite,
        "SELECT * FROM contact_relations WHERE pair_key = ? AND status = 'active'",
        ['act_agent_1|act_human_1'],
      ),
    ),
  );
  checkEqual(
    'getActiveContactRelation ended',
    await getActiveContactRelation(db, 'act_human_1|act_human_2'),
    null,
  );
  checkEqual(
    'getContactRelation ended',
    JSON.stringify(await getContactRelation(db, 'act_human_1|act_human_2')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM contact_relations WHERE pair_key = ?', [
        'act_human_1|act_human_2',
      ]),
    ),
  );
  checkEqual('getContactRelation missing', await getContactRelation(db, 'missing|pair'), null);

  checkEqual(
    'getPendingContactRequest',
    JSON.stringify(await getPendingContactRequest(db, 'act_agent_1|act_human_1')),
    JSON.stringify(
      rawFirst(sqlite, "SELECT * FROM contact_requests WHERE pair_key = ? AND status = 'pending'", [
        'act_agent_1|act_human_1',
      ]),
    ),
  );
  checkEqual(
    'getPendingContactRequest ended pair',
    await getPendingContactRequest(db, 'act_human_1|act_human_2'),
    null,
  );
  checkEqual(
    'getContactRequestById',
    JSON.stringify(await getContactRequestById(db, 'req_3')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM contact_requests WHERE contact_request_id = ?', ['req_3'])),
  );
  checkEqual('getContactRequestById missing', await getContactRequestById(db, 'req_missing'), null);

  const expiredSql = `SELECT * FROM contact_requests
        WHERE status = 'pending' AND expires_at <= ?
        ORDER BY expires_at ASC, contact_request_id ASC
        LIMIT ?`;
  checkEqual(
    'listExpiredPendingContactRequests',
    JSON.stringify(await listExpiredPendingContactRequests(db, 1_000, 10)),
    JSON.stringify(rawAll(sqlite, expiredSql, [1_000, 10])),
  );
  checkEqual(
    'listExpiredPendingContactRequests limit',
    JSON.stringify(await listExpiredPendingContactRequests(db, 1_000, 1)),
    JSON.stringify(rawAll(sqlite, expiredSql, [1_000, 1])),
  );

  checkEqual(
    'getExpiredPendingContactRequestForPair',
    JSON.stringify(await getExpiredPendingContactRequestForPair(db, 'act_agent_1|act_human_1', 1_000)),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT * FROM contact_requests
          WHERE pair_key = ? AND status = 'pending' AND expires_at <= ?`,
        ['act_agent_1|act_human_1', 1_000],
      ),
    ),
  );
  checkEqual(
    'getExpiredPendingContactRequestForPair not due',
    await getExpiredPendingContactRequestForPair(db, 'act_agent_3|act_human_1', 1_000),
    null,
  );

  checkEqual(
    'listPendingContactRequests',
    JSON.stringify(await listPendingContactRequests(db, 'act_agent_1|act_human_1')),
    JSON.stringify(
      rawAll(sqlite, "SELECT * FROM contact_requests WHERE pair_key = ? AND status = 'pending'", [
        'act_agent_1|act_human_1',
      ]),
    ),
  );

  checkEqual(
    'getActiveContactBlock',
    JSON.stringify(await getActiveContactBlock(db, 'act_human_1', 'act_agent_3')),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT * FROM contact_blocks
          WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL`,
        ['act_human_1', 'act_agent_3'],
      ),
    ),
  );
  checkEqual(
    'getActiveContactBlock released',
    await getActiveContactBlock(db, 'act_human_2', 'act_human_1'),
    null,
  );

  const betweenSql = `SELECT * FROM contact_blocks
        WHERE released_at IS NULL
          AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
            OR (blocker_actor_id = ? AND blocked_actor_id = ?))
        LIMIT 1`;
  checkEqual(
    'findActiveContactBlockBetween',
    JSON.stringify(await findActiveContactBlockBetween(db, 'act_human_1', 'act_agent_3')),
    JSON.stringify(rawFirst(sqlite, betweenSql, ['act_human_1', 'act_agent_3', 'act_agent_3', 'act_human_1'])),
  );
  checkEqual(
    'findActiveContactBlockBetween reverse',
    JSON.stringify(await findActiveContactBlockBetween(db, 'act_agent_3', 'act_human_1')),
    JSON.stringify(rawFirst(sqlite, betweenSql, ['act_agent_3', 'act_human_1', 'act_human_1', 'act_agent_3'])),
  );
  checkEqual(
    'findActiveContactBlockBetween none',
    await findActiveContactBlockBetween(db, 'act_human_1', 'act_human_2'),
    null,
  );

  checkEqual(
    'listMutedMentionBlockers',
    JSON.stringify(
      (await listMutedMentionBlockers(db, 'act_agent_3', ['act_human_1', 'act_human_2'])).sort(),
    ),
    JSON.stringify(
      rawAll<{ blocker_actor_id: string }>(
        sqlite,
        `SELECT blocker_actor_id FROM contact_blocks
          WHERE released_at IS NULL
            AND mute_mentions = 1
            AND blocked_actor_id = ?
            AND blocker_actor_id IN (?, ?)`,
        ['act_agent_3', 'act_human_1', 'act_human_2'],
      )
        .map((row) => row.blocker_actor_id)
        .sort(),
    ),
  );
  checkEqual('listMutedMentionBlockers empty', JSON.stringify(await listMutedMentionBlockers(db, 'x', [])), '[]');

  const blockListSql = `SELECT b.*,
              a.kind AS blocked_kind, a.name AS blocked_name,
              a.agent_session_id AS blocked_session
         FROM contact_blocks b
         JOIN actors a ON a.actor_id = b.blocked_actor_id
        WHERE b.blocker_actor_id = ?
        ORDER BY b.created_at DESC, b.block_id ASC
        LIMIT ?`;
  checkEqual(
    'listContactBlocks',
    JSON.stringify(await listContactBlocks(db, 'act_human_1', 2, null)),
    JSON.stringify(rawAll(sqlite, blockListSql, ['act_human_1', 2])),
  );
  const blockCursorSql = `SELECT b.*,
              a.kind AS blocked_kind, a.name AS blocked_name,
              a.agent_session_id AS blocked_session
         FROM contact_blocks b
         JOIN actors a ON a.actor_id = b.blocked_actor_id
        WHERE b.blocker_actor_id = ?
          AND (b.created_at < ? OR (b.created_at = ? AND b.block_id > ?))
        ORDER BY b.created_at DESC, b.block_id ASC
        LIMIT ?`;
  checkEqual(
    'listContactBlocks cursor',
    JSON.stringify(await listContactBlocks(db, 'act_human_1', 2, { createdAt: 700, blockId: 'blk_1' })),
    JSON.stringify(rawAll(sqlite, blockCursorSql, ['act_human_1', 700, 700, 'blk_1', 2])),
  );

  checkEqual(
    'getActiveAgentManagement',
    JSON.stringify(await getActiveAgentManagement(db, 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, "SELECT * FROM agent_managements WHERE agent_id = ? AND status = 'active'", [
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getActiveAgentManagement revoked',
    await getActiveAgentManagement(db, 'act_agent_3'),
    null,
  );

  const managementIds = ['act_agent_1', 'act_agent_2', 'act_agent_3'];
  checkEqual(
    'listActiveManagementBindings',
    JSON.stringify(await listActiveManagementBindings(db, managementIds)),
    JSON.stringify(
      rawAll(
        sqlite,
        `SELECT agent_id, manager_id FROM agent_managements
          WHERE status = 'active' AND agent_id IN (${placeholders(managementIds)})`,
        managementIds,
      ),
    ),
  );
  checkEqual(
    'listActiveManagementBindings empty',
    JSON.stringify(await listActiveManagementBindings(db, [])),
    '[]',
  );

  checkEqual(
    'countActiveCredentials',
    await countActiveCredentials(db, 'act_human_1'),
    rawFirst<{ n: number }>(
      sqlite,
      'SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
      ['act_human_1'],
    )?.n ?? 0,
  );
  checkEqual(
    'countActiveCredentials none',
    await countActiveCredentials(db, 'act_agent_1'),
    0,
  );
}

function explainChecks(sqlite: Database, db: D1Database): void {
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
      label: 'getContact',
      raw: 'SELECT * FROM contacts WHERE owner_actor_id = ? AND target_actor_id = ?',
      params: ['act_human_1', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.owner_actor_id, 'act_human_1'),
            eq(schema.contacts.target_actor_id, 'act_agent_1'),
          ),
        ),
    },
    {
      label: 'getActiveContactRelation',
      raw: "SELECT * FROM contact_relations WHERE pair_key = ? AND status = 'active'",
      params: ['act_agent_1|act_human_1'],
      query: orm(db)
        .select()
        .from(schema.contactRelations)
        .where(
          and(
            eq(schema.contactRelations.pair_key, 'act_agent_1|act_human_1'),
            eq(schema.contactRelations.status, 'active'),
          ),
        ),
    },
    {
      label: 'getPendingContactRequest',
      raw: "SELECT * FROM contact_requests WHERE pair_key = ? AND status = 'pending'",
      params: ['act_agent_1|act_human_1'],
      query: orm(db)
        .select()
        .from(schema.contactRequests)
        .where(
          and(
            eq(schema.contactRequests.pair_key, 'act_agent_1|act_human_1'),
            eq(schema.contactRequests.status, 'pending'),
          ),
        ),
    },
    {
      label: 'listExpiredPendingContactRequests',
      raw: `SELECT * FROM contact_requests
        WHERE status = 'pending' AND expires_at <= ?
        ORDER BY expires_at ASC, contact_request_id ASC
        LIMIT ?`,
      params: [1_000, 10],
      query: orm(db)
        .select()
        .from(schema.contactRequests)
        .where(
          and(
            eq(schema.contactRequests.status, 'pending'),
            lte(schema.contactRequests.expires_at, 1_000),
          ),
        )
        .orderBy(
          asc(schema.contactRequests.expires_at),
          asc(schema.contactRequests.contact_request_id),
        )
        .limit(10),
    },
    {
      label: 'getActiveContactBlock',
      raw: `SELECT * FROM contact_blocks
        WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL`,
      params: ['act_human_1', 'act_agent_3'],
      query: orm(db)
        .select()
        .from(schema.contactBlocks)
        .where(
          and(
            eq(schema.contactBlocks.blocker_actor_id, 'act_human_1'),
            eq(schema.contactBlocks.blocked_actor_id, 'act_agent_3'),
            isNull(schema.contactBlocks.released_at),
          ),
        ),
    },
    {
      label: 'findActiveContactBlockBetween',
      raw: `SELECT * FROM contact_blocks
        WHERE released_at IS NULL
          AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
            OR (blocker_actor_id = ? AND blocked_actor_id = ?))
        LIMIT 1`,
      params: ['act_human_1', 'act_agent_3', 'act_agent_3', 'act_human_1'],
      query: orm(db)
        .select()
        .from(schema.contactBlocks)
        .where(
          and(
            isNull(schema.contactBlocks.released_at),
            or(
              and(
                eq(schema.contactBlocks.blocker_actor_id, 'act_human_1'),
                eq(schema.contactBlocks.blocked_actor_id, 'act_agent_3'),
              ),
              and(
                eq(schema.contactBlocks.blocker_actor_id, 'act_agent_3'),
                eq(schema.contactBlocks.blocked_actor_id, 'act_human_1'),
              ),
            ),
          ),
        )
        .limit(1),
    },
    {
      label: 'listContactBlocks',
      raw: `SELECT contact_blocks.*,
              actors.kind AS blocked_kind, actors.name AS blocked_name,
              actors.agent_session_id AS blocked_session
         FROM contact_blocks
         JOIN actors ON actors.actor_id = contact_blocks.blocked_actor_id
        WHERE contact_blocks.blocker_actor_id = ?
        ORDER BY contact_blocks.created_at DESC, contact_blocks.block_id ASC
        LIMIT ?`,
      params: ['act_human_1', 2],
      query: orm(db)
        .select({
          block_id: schema.contactBlocks.block_id,
          blocker_actor_id: schema.contactBlocks.blocker_actor_id,
          blocked_actor_id: schema.contactBlocks.blocked_actor_id,
          reason: schema.contactBlocks.reason,
          mute_mentions: schema.contactBlocks.mute_mentions,
          created_at: schema.contactBlocks.created_at,
          released_at: schema.contactBlocks.released_at,
          released_by: schema.contactBlocks.released_by,
          blocked_kind: sql<'human' | 'agent'>`${schema.actors.kind}`.as('blocked_kind'),
          blocked_name: sql<string>`${schema.actors.name}`.as('blocked_name'),
          blocked_session: sql<string | null>`${schema.actors.agent_session_id}`.as(
            'blocked_session',
          ),
        })
        .from(schema.contactBlocks)
        .innerJoin(
          schema.actors,
          eq(schema.actors.actor_id, schema.contactBlocks.blocked_actor_id),
        )
        .where(eq(schema.contactBlocks.blocker_actor_id, 'act_human_1'))
        .orderBy(desc(schema.contactBlocks.created_at), asc(schema.contactBlocks.block_id))
        .limit(2),
    },
    {
      label: 'getActiveAgentManagement',
      raw: "SELECT * FROM agent_managements WHERE agent_id = ? AND status = 'active'",
      params: ['act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.agentManagements)
        .where(
          and(
            eq(schema.agentManagements.agent_id, 'act_agent_1'),
            eq(schema.agentManagements.status, 'active'),
          ),
        ),
    },
    {
      label: 'listActiveManagementBindings',
      raw: `SELECT agent_id, manager_id FROM agent_managements
          WHERE status = 'active' AND agent_id IN (?, ?, ?)`,
      params: ['act_agent_1', 'act_agent_2', 'act_agent_3'],
      query: orm(db)
        .select({
          agent_id: schema.agentManagements.agent_id,
          manager_id: schema.agentManagements.manager_id,
        })
        .from(schema.agentManagements)
        .where(
          and(
            eq(schema.agentManagements.status, 'active'),
            inArray(schema.agentManagements.agent_id, [
              'act_agent_1',
              'act_agent_2',
              'act_agent_3',
            ]),
          ),
        ),
    },
    {
      label: 'countActiveCredentials',
      raw: 'SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
      params: ['act_human_1'],
      query: orm(db)
        .select({ n: sql<number>`count(*)`.as('n') })
        .from(schema.credentials)
        .where(
          and(
            eq(schema.credentials.actor_id, 'act_human_1'),
            isNull(schema.credentials.revoked_at),
          ),
        ),
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
  const rawContact = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM contacts WHERE owner_actor_id = ? AND target_actor_id = ?', [
      'act_human_1',
      'act_agent_1',
    ]);
  const ormContact = async (): Promise<unknown> => getContact(db, 'act_human_1', 'act_agent_1');
  const rawRelation = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT * FROM contact_relations WHERE pair_key = ? AND status = 'active'", [
      'act_agent_1|act_human_1',
    ]);
  const ormRelation = async (): Promise<unknown> =>
    getActiveContactRelation(db, 'act_agent_1|act_human_1');
  const rawBlock = async (): Promise<unknown> =>
    rawFirst(
      sqlite,
      `SELECT * FROM contact_blocks
        WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL`,
      ['act_human_1', 'act_agent_3'],
    );
  const ormBlock = async (): Promise<unknown> =>
    getActiveContactBlock(db, 'act_human_1', 'act_agent_3');
  const rawManagement = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT * FROM agent_managements WHERE agent_id = ? AND status = 'active'", [
      'act_agent_1',
    ]);
  const ormManagement = async (): Promise<unknown> =>
    getActiveAgentManagement(db, 'act_agent_1');

  console.log('\nread query benchmark (in-memory, includes drizzle build):');
  console.log(`  raw   ${await bench('actor', rawActor)}`);
  console.log(`  orm   ${await bench('actor', ormActor)}`);
  console.log(`  raw   ${await bench('member', rawMember)}`);
  console.log(`  orm   ${await bench('member', ormMember)}`);
  console.log(`  raw   ${await bench('count', rawCount)}`);
  console.log(`  orm   ${await bench('count', ormCount)}`);
  console.log(`  raw   ${await bench('identity', rawIdentity)}`);
  console.log(`  orm   ${await bench('identity', ormIdentity)}`);
  console.log(`  raw   ${await bench('contact', rawContact)}`);
  console.log(`  orm   ${await bench('contact', ormContact)}`);
  console.log(`  raw   ${await bench('relation', rawRelation)}`);
  console.log(`  orm   ${await bench('relation', ormRelation)}`);
  console.log(`  raw   ${await bench('block', rawBlock)}`);
  console.log(`  orm   ${await bench('block', ormBlock)}`);
  console.log(`  raw   ${await bench('management', rawManagement)}`);
  console.log(`  orm   ${await bench('management', ormManagement)}`);
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
