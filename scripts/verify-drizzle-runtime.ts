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
import { and, eq, inArray, ne } from 'drizzle-orm';
import { resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { orm, schema } from '../src/storage/drizzle';
import {
  activeRoomCount,
  getActor,
  getActorBySession,
  getActorManagementByIds,
  getActorsByIds,
  getCredentialByHash,
  getEventsMinSeq,
  getMember,
  getRoom,
  isActiveMember,
  listActiveRoomPeers,
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

  console.log('\nread query benchmark (in-memory, includes drizzle build):');
  console.log(`  raw   ${await bench('actor', rawActor)}`);
  console.log(`  orm   ${await bench('actor', ormActor)}`);
  console.log(`  raw   ${await bench('member', rawMember)}`);
  console.log(`  orm   ${await bench('member', ormMember)}`);
  console.log(`  raw   ${await bench('count', rawCount)}`);
  console.log(`  orm   ${await bench('count', ormCount)}`);
  console.log(`  raw   ${await bench('identity', rawIdentity)}`);
  console.log(`  orm   ${await bench('identity', ormIdentity)}`);
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
