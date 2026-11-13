/**
 * 4C-1/4C-4 Drizzle 只读查询运行时对比。
 *
 * 对 `src/storage/queries.ts` 中已迁移到 Drizzle 的核心读查询，逐条执行：
 * 1. 手写 SQL（迁移前的原语句）与 Drizzle 构建结果逐行比较，包含字段顺序；
 * 2. 用生产实际执行的 SQL 做 `EXPLAIN QUERY PLAN`，与手写 SQL 的计划比较
 *    （4C-4 的手写 SQL 使用 `d`/`m`/`a` 别名，只归一化 FROM/JOIN 表标识）；
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
  getClaimedDelivery,
  getClaimedDeliveryId,
  getCredentialByHash,
  getDelivery,
  getDeliveryForMessage,
  getEventsMinSeq,
  getMember,
  getMessage,
  getMessageContextAnchor,
  getMessageSenderSummary,
  getRoom,
  isActiveMember,
  listActiveRoomPeers,
  listDeliveryStates,
  listHistoryMessagesAfter,
  listHistoryMessagesBefore,
  listHistoryMessagesByIds,
  listInboxDeliveries,
  listMessageContextWindow,
  listMessageMentions,
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

  const message = sqlite.prepare(
    `INSERT INTO messages
       (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
        preview, reply_to, root_id, hop, root_invocations_used, created_at,
        task_root_id, task_marked_by, task_marked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const messages: [
    string,
    string,
    string,
    number,
    string,
    string | null,
    string | null,
    number,
    string,
    string | null,
    string | null,
    number | null,
  ][] = [
    ['msg_d1_1', 'room_direct_1', 'act_human_1', 1, 'hello direct', null, null, 0, 'cm_d1_1', null, null, null],
    ['msg_d1_2', 'room_direct_1', 'act_agent_1', 2, 'agent reply', 'msg_d1_1', 'msg_d1_1', 1, 'cm_d1_2', null, null, null],
    ['msg_d1_5', 'room_direct_1', 'act_human_1', 5, 'later message', null, null, 0, 'cm_d1_5', null, null, null],
    ['msg_d2_1', 'room_direct_2', 'act_agent_2', 1, 'second room', null, null, 0, 'cm_d2_1', null, null, null],
    ['msg_d2_2', 'room_direct_2', 'act_human_1', 2, 'second reply', null, null, 0, 'cm_d2_2', null, null, null],
    ['msg_g1_3', 'room_group_1', 'act_human_1', 3, 'group start', null, null, 0, 'cm_g1_3', null, null, null],
    ['msg_g1_8', 'room_group_1', 'act_agent_1', 8, 'group task', null, null, 0, 'cm_g1_8', 'msg_g1_8', 'act_human_1', 1_300],
    ['msg_g1_9', 'room_group_1', 'act_agent_3', 9, 'group answer', 'msg_g1_8', 'msg_g1_8', 1, 'cm_g1_9', 'msg_g1_9', 'act_agent_1', 1_400],
    ['msg_ghost', 'room_group_1', 'act_missing', 7, 'ghost sender', null, null, 0, 'cm_ghost', null, null, null],
  ];
  for (const [
    id,
    roomId,
    senderId,
    seq,
    body,
    replyTo,
    rootId,
    hop,
    clientMessageId,
    taskRootId,
    taskMarkedBy,
    taskMarkedAt,
  ] of messages) {
    message.run(
      id,
      roomId,
      senderId,
      clientMessageId,
      seq,
      body,
      Buffer.byteLength(body, 'utf8'),
      body,
      replyTo,
      rootId,
      hop,
      hop,
      1_000 + seq,
      taskRootId,
      taskMarkedBy,
      taskMarkedAt,
    );
  }

  const delivery = sqlite.prepare(
    `INSERT INTO deliveries
       (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id, claimed_at,
        progress_at, result_message_id, error, created_seq, created_at, updated_at,
        last_reminded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deliveries: [
    string,
    string,
    string,
    string,
    string,
    number,
    string | null,
    number | null,
    number | null,
    string | null,
    string | null,
    number,
    number,
    number,
    number | null,
  ][] = [
    ['del_pending_1', 'act_agent_1', 'msg_d1_2', 'room_direct_1', 'pending', 0, null, null, null, null, null, 1, 1_100, 1_100, null],
    ['del_claimed_1', 'act_agent_1', 'msg_g1_8', 'room_group_1', 'claimed', 1, 'claim_1', 1_200, 1_210, null, null, 2, 1_200, 1_220, 1_230],
    ['del_pending_2', 'act_agent_3', 'msg_g1_8', 'room_group_1', 'pending', 0, null, null, null, null, null, 3, 1_210, 1_210, null],
    ['del_completed_1', 'act_agent_1', 'msg_g1_9', 'room_group_1', 'completed', 2, null, null, null, null, null, 4, 1_300, 1_400, null],
    ['del_failed_1', 'act_agent_2', 'msg_g1_9', 'room_group_1', 'failed', 1, null, null, null, null, 'boom', 5, 1_301, 1_401, null],
    ['del_ghost', 'act_agent_2', 'msg_ghost', 'room_group_1', 'pending', 0, null, null, null, null, null, 6, 1_302, 1_302, null],
  ];
  for (const row of deliveries) delivery.run(...row);

  const mention = sqlite.prepare(
    `INSERT INTO message_mentions (message_id, actor_id, actor_kind, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  mention.run('msg_g1_8', 'act_human_1', 'human', 'explicit', 1_200);
  mention.run('msg_g1_8', 'act_agent_2', 'agent', 'text', 1_200);
  mention.run('msg_g1_9', 'act_agent_3', 'agent', 'all', 1_300);
  mention.run('msg_d1_2', 'act_agent_1', 'agent', 'explicit', 1_100);
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

/** 历史页共享列；与生产 `historyMessageSelection` 的列和顺序一致。 */
const HISTORY_SELECT =
  'message_id, room_id, sender_id, created_seq, preview, body_bytes, created_at, reply_to, root_id, task_root_id, hop';

function rawHistoryBefore(
  sqlite: Database,
  roomId: string,
  snapshot: number,
  fromSeq: number,
  beforeSeq: number | null,
  limit: number,
): string {
  const predicate = beforeSeq === null ? '' : 'AND created_seq < ?';
  const params: unknown[] =
    beforeSeq === null
      ? [roomId, snapshot, fromSeq, limit]
      : [roomId, snapshot, fromSeq, beforeSeq, limit];
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq >= ? ${predicate}
        ORDER BY created_seq DESC LIMIT ?`,
      params,
    ),
  );
}

function rawHistoryAfter(
  sqlite: Database,
  roomId: string,
  snapshot: number,
  fromSeq: number,
  afterSeq: number,
  limit: number,
): string {
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq > ? AND created_seq >= ?
        ORDER BY created_seq ASC LIMIT ?`,
      [roomId, snapshot, afterSeq, fromSeq, limit],
    ),
  );
}

const CONTEXT_SELECT = `m.message_id, m.room_id, m.sender_id, a.name AS sender_name,
  a.kind AS sender_kind, m.body_bytes, m.preview, m.created_at, m.created_seq, m.reply_to`;

function rawContextBefore(
  sqlite: Database,
  roomId: string,
  pivotSeq: number,
  fromSeq: number | null,
  limit: number,
): string {
  const lower = fromSeq === null ? '' : 'AND m.created_seq >= ?';
  const params: unknown[] =
    fromSeq === null ? [roomId, pivotSeq, limit] : [roomId, pivotSeq, fromSeq, limit];
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq < ? ${lower}
        ORDER BY m.created_seq DESC LIMIT ?`,
      params,
    ),
  );
}

function rawContextAfter(
  sqlite: Database,
  roomId: string,
  pivotSeq: number,
  fromSeq: number | null,
  toSeq: number | null,
  limit: number,
): string {
  const lower = fromSeq === null ? '' : 'AND m.created_seq >= ?';
  const upper = toSeq === null ? '' : 'AND m.created_seq <= ?';
  const params: unknown[] = [
    roomId,
    pivotSeq,
    ...(fromSeq === null ? [] : [fromSeq]),
    ...(toSeq === null ? [] : [toSeq]),
    limit,
  ];
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq > ? ${lower} ${upper}
        ORDER BY m.created_seq ASC LIMIT ?`,
      params,
    ),
  );
}

function rawInbox(
  sqlite: Database,
  recipientId: string,
  states: string[] | null,
  afterSeq: number | null,
  limit: number,
): string {
  const stateFilter = states ? `AND d.state IN (${placeholders(states)})` : '';
  const cursor = afterSeq === null ? '' : 'AND d.created_seq > ?';
  const params: unknown[] = states ? [recipientId, ...states] : [recipientId];
  if (afterSeq !== null) params.push(afterSeq);
  params.push(limit);
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? ${stateFilter} ${cursor}
        ORDER BY d.created_seq ASC
        LIMIT ?`,
      params,
    ),
  );
}

function deliveryStateRows(rows: {
  message_id: string;
  state: string;
  n: number;
  max_claimed_at: number | null;
  max_updated_at: number | null;
}[]): string {
  return JSON.stringify(
    rows
      .map((row) => [row.message_id, row.state, row.n, row.max_claimed_at, row.max_updated_at])
      .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`)),
  );
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

  // -------- 4C-4 messages --------
  checkEqual(
    'getMessage',
    JSON.stringify(await getMessage(db, 'msg_d1_2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM messages WHERE message_id = ?', ['msg_d1_2'])),
  );
  checkEqual(
    'getMessage task root',
    JSON.stringify(await getMessage(db, 'msg_g1_9')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM messages WHERE message_id = ?', ['msg_g1_9'])),
  );
  checkEqual('getMessage missing', await getMessage(db, 'msg_missing'), null);

  checkEqual(
    'listHistoryMessagesBefore first page',
    JSON.stringify(
      await listHistoryMessagesBefore(db, {
        roomId: 'room_direct_1',
        snapshot: 5,
        fromSeq: 0,
        beforeSeq: null,
        limit: 3,
      }),
    ),
    rawHistoryBefore(sqlite, 'room_direct_1', 5, 0, null, 3),
  );
  checkEqual(
    'listHistoryMessagesBefore cursor',
    JSON.stringify(
      await listHistoryMessagesBefore(db, {
        roomId: 'room_direct_1',
        snapshot: 5,
        fromSeq: 0,
        beforeSeq: 5,
        limit: 3,
      }),
    ),
    rawHistoryBefore(sqlite, 'room_direct_1', 5, 0, 5, 3),
  );
  checkEqual(
    'listHistoryMessagesBefore from_join boundary',
    JSON.stringify(
      await listHistoryMessagesBefore(db, {
        roomId: 'room_group_1',
        snapshot: 9,
        fromSeq: 4,
        beforeSeq: null,
        limit: 20,
      }),
    ),
    rawHistoryBefore(sqlite, 'room_group_1', 9, 4, null, 20),
  );
  checkEqual(
    'listHistoryMessagesBefore empty room',
    JSON.stringify(
      await listHistoryMessagesBefore(db, {
        roomId: 'room_missing',
        snapshot: 9,
        fromSeq: 0,
        beforeSeq: null,
        limit: 20,
      }),
    ),
    rawHistoryBefore(sqlite, 'room_missing', 9, 0, null, 20),
  );
  checkEqual(
    'listHistoryMessagesAfter',
    JSON.stringify(
      await listHistoryMessagesAfter(db, {
        roomId: 'room_direct_1',
        snapshot: 5,
        fromSeq: 0,
        afterSeq: 2,
        limit: 5,
      }),
    ),
    rawHistoryAfter(sqlite, 'room_direct_1', 5, 0, 2, 5),
  );
  checkEqual(
    'listHistoryMessagesAfter fromSeq floor',
    JSON.stringify(
      await listHistoryMessagesAfter(db, {
        roomId: 'room_group_1',
        snapshot: 9,
        fromSeq: 4,
        afterSeq: 4,
        limit: 20,
      }),
    ),
    rawHistoryAfter(sqlite, 'room_group_1', 9, 4, 4, 20),
  );
  checkEqual(
    'listHistoryMessagesAfter snapshot upper bound',
    JSON.stringify(
      await listHistoryMessagesAfter(db, {
        roomId: 'room_group_1',
        snapshot: 8,
        fromSeq: 0,
        afterSeq: 3,
        limit: 20,
      }),
    ),
    rawHistoryAfter(sqlite, 'room_group_1', 8, 0, 3, 20),
  );

  const messageIds = ['msg_g1_9', 'msg_d1_1', 'msg_missing'];
  checkEqual(
    'listHistoryMessagesByIds',
    JSON.stringify(await listHistoryMessagesByIds(db, messageIds)),
    JSON.stringify(
      rawAll(
        sqlite,
        `SELECT ${HISTORY_SELECT} FROM messages WHERE message_id IN (${placeholders(messageIds)})`,
        messageIds,
      ),
    ),
  );
  checkEqual('listHistoryMessagesByIds empty', JSON.stringify(await listHistoryMessagesByIds(db, [])), '[]');

  // -------- 4C-4 message context --------
  checkEqual(
    'getMessageContextAnchor',
    JSON.stringify(await getMessageContextAnchor(db, 'room_group_1', 'msg_g1_8')),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
          WHERE m.room_id = ? AND m.message_id = ?`,
        ['room_group_1', 'msg_g1_8'],
      ),
    ),
  );
  checkEqual(
    'getMessageContextAnchor missing',
    await getMessageContextAnchor(db, 'room_group_1', 'msg_missing'),
    null,
  );
  checkEqual(
    'listMessageContextWindow before full',
    JSON.stringify(
      await listMessageContextWindow(db, {
        roomId: 'room_group_1',
        pivotSeq: 8,
        direction: 'before',
        fromSeq: null,
        toSeq: null,
        limit: 2,
      }),
    ),
    rawContextBefore(sqlite, 'room_group_1', 8, null, 2),
  );
  checkEqual(
    'listMessageContextWindow before from_join',
    JSON.stringify(
      await listMessageContextWindow(db, {
        roomId: 'room_group_1',
        pivotSeq: 8,
        direction: 'before',
        fromSeq: 4,
        toSeq: 8,
        limit: 20,
      }),
    ),
    rawContextBefore(sqlite, 'room_group_1', 8, 4, 20),
  );
  checkEqual(
    'listMessageContextWindow after full',
    JSON.stringify(
      await listMessageContextWindow(db, {
        roomId: 'room_group_1',
        pivotSeq: 8,
        direction: 'after',
        fromSeq: null,
        toSeq: null,
        limit: 20,
      }),
    ),
    rawContextAfter(sqlite, 'room_group_1', 8, null, null, 20),
  );
  checkEqual(
    'listMessageContextWindow after archived',
    JSON.stringify(
      await listMessageContextWindow(db, {
        roomId: 'room_group_1',
        pivotSeq: 3,
        direction: 'after',
        fromSeq: 3,
        toSeq: 8,
        limit: 20,
      }),
    ),
    rawContextAfter(sqlite, 'room_group_1', 3, 3, 8, 20),
  );

  // -------- 4C-4 messages / deliveries joins --------
  const senderSql = `SELECT m.message_id, m.sender_id, m.created_seq, m.preview, m.body_bytes,
              m.created_at, a.name AS sender_name, a.kind AS sender_kind
         FROM messages m LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.message_id = ?`;
  checkEqual(
    'getMessageSenderSummary',
    JSON.stringify(await getMessageSenderSummary(db, 'msg_g1_8')),
    JSON.stringify(rawFirst(sqlite, senderSql, ['msg_g1_8'])),
  );
  checkEqual(
    'getMessageSenderSummary ghost sender',
    JSON.stringify(await getMessageSenderSummary(db, 'msg_ghost')),
    JSON.stringify(rawFirst(sqlite, senderSql, ['msg_ghost'])),
  );
  checkEqual('getMessageSenderSummary missing', await getMessageSenderSummary(db, 'msg_missing'), null);

  const stateIds = ['msg_d1_2', 'msg_g1_8', 'msg_g1_9', 'msg_missing'];
  checkEqual(
    'listDeliveryStates',
    deliveryStateRows(await listDeliveryStates(db, stateIds)),
    deliveryStateRows(
      rawAll(
        sqlite,
        `SELECT message_id, state, COUNT(*) AS n,
                MAX(CASE WHEN state = 'claimed' THEN claimed_at END) AS max_claimed_at,
                MAX(CASE WHEN state = 'claimed' THEN updated_at END) AS max_updated_at
           FROM deliveries WHERE message_id IN (${placeholders(stateIds)})
          GROUP BY message_id, state`,
        stateIds,
      ),
    ),
  );
  checkEqual('listDeliveryStates empty', JSON.stringify(await listDeliveryStates(db, [])), '[]');

  const mentionIds = ['msg_g1_8', 'msg_g1_9', 'msg_missing'];
  checkEqual(
    'listMessageMentions',
    JSON.stringify(await listMessageMentions(db, mentionIds)),
    JSON.stringify(
      rawAll(
        sqlite,
        `SELECT message_id, actor_id, actor_kind, source FROM message_mentions
          WHERE message_id IN (${placeholders(mentionIds)})
          ORDER BY message_id, actor_id`,
        mentionIds,
      ),
    ),
  );
  checkEqual('listMessageMentions empty', JSON.stringify(await listMessageMentions(db, [])), '[]');

  // -------- 4C-4 deliveries --------
  checkEqual(
    'getDelivery',
    JSON.stringify(await getDelivery(db, 'del_claimed_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM deliveries WHERE delivery_id = ?', ['del_claimed_1'])),
  );
  checkEqual('getDelivery missing', await getDelivery(db, 'del_missing'), null);
  checkEqual(
    'getDeliveryForMessage',
    JSON.stringify(await getDeliveryForMessage(db, 'act_agent_1', 'msg_g1_8')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM deliveries WHERE recipient_id = ? AND message_id = ?', [
        'act_agent_1',
        'msg_g1_8',
      ]),
    ),
  );
  checkEqual('getDeliveryForMessage missing', await getDeliveryForMessage(db, 'act_agent_3', 'msg_d1_1'), null);
  checkEqual(
    'getClaimedDelivery',
    JSON.stringify(await getClaimedDelivery(db, 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, "SELECT * FROM deliveries WHERE recipient_id = ? AND state = 'claimed' LIMIT 1", [
        'act_agent_1',
      ]),
    ),
  );
  checkEqual('getClaimedDelivery none', await getClaimedDelivery(db, 'act_agent_2'), null);
  checkEqual('getClaimedDeliveryId', await getClaimedDeliveryId(db, 'act_agent_1'), 'del_claimed_1');
  checkEqual('getClaimedDeliveryId none', await getClaimedDeliveryId(db, 'act_human_1'), null);

  checkEqual(
    'listInboxDeliveries active',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_agent_1',
        states: ['pending', 'claimed'],
        afterSeq: null,
        limit: 3,
      }),
    ),
    rawInbox(sqlite, 'act_agent_1', ['pending', 'claimed'], null, 3),
  );
  checkEqual(
    'listInboxDeliveries cursor',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_agent_1',
        states: ['pending', 'claimed'],
        afterSeq: 1,
        limit: 3,
      }),
    ),
    rawInbox(sqlite, 'act_agent_1', ['pending', 'claimed'], 1, 3),
  );
  checkEqual(
    'listInboxDeliveries all states',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_agent_1',
        states: null,
        afterSeq: null,
        limit: 10,
      }),
    ),
    rawInbox(sqlite, 'act_agent_1', null, null, 10),
  );
  checkEqual(
    'listInboxDeliveries single state',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_agent_2',
        states: ['pending'],
        afterSeq: null,
        limit: 10,
      }),
    ),
    rawInbox(sqlite, 'act_agent_2', ['pending'], null, 10),
  );
  checkEqual(
    'listInboxDeliveries empty',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_human_1',
        states: ['pending'],
        afterSeq: null,
        limit: 10,
      }),
    ),
    rawInbox(sqlite, 'act_human_1', ['pending'], null, 10),
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

interface ExecutedQuery {
  sql: string;
  params: unknown[];
}

/** 记录 D1 实际执行的 SQL，用于对生产语句本身做 EXPLAIN，而不是在测试里重写 builder。 */
function capture(inner: D1Database): { db: D1Database; executed: ExecutedQuery[] } {
  const executed: ExecutedQuery[] = [];
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
    values: unknown[],
  ): D1PreparedStatement => ({
    bind: (...next) => wrap(statement.bind(...next), sql, next),
    first: async <T = unknown>(colName?: string) => {
      executed.push({ sql, params: values });
      return statement.first<T>(colName);
    },
    all: async <T = unknown>() => {
      executed.push({ sql, params: values });
      return statement.all<T>();
    },
    run: async <T = unknown>() => {
      executed.push({ sql, params: values });
      return statement.run<T>();
    },
    raw: async <T = unknown>() => {
      executed.push({ sql, params: values });
      return statement.raw<T>();
    },
  });
  const db: D1Database = {
    prepare: (sql) => wrap(inner.prepare(sql), sql, []),
    batch: (statements) => inner.batch(statements),
    exec: (query) => inner.exec(query),
  };
  return { db, executed };
}

const EXPLAIN_ALIASES: Record<string, string> = {
  d: 'deliveries',
  m: 'messages',
  a: 'actors',
};

/** 手写 SQL 使用 `d`/`m`/`a` 别名，Drizzle 使用表名；只归一化 FROM/JOIN 的表标识。 */
function normalizePlan(lines: string[]): string[] {
  return lines.map((line) =>
    line.replace(/\b(SCAN|SEARCH) (d|m|a)\b/gu, (_match, op: string, alias: string) => {
      return `${op} ${EXPLAIN_ALIASES[alias] ?? alias}`;
    }),
  );
}

interface ExplainCase {
  label: string;
  /** 从捕获到的语句中挑选目标 SQL；未命中即失败。 */
  pattern: RegExp;
  run: (db: D1Database) => Promise<unknown>;
  raw: string;
  params: unknown[];
}

async function messageExplainChecks(sqlite: Database, db: D1Database): Promise<void> {
  const cases: ExplainCase[] = [
    {
      label: 'getMessage',
      pattern: /^select .* from "messages" where "messages"\."message_id" = \?$/u,
      run: (target) => getMessage(target, 'msg_d1_2'),
      raw: 'SELECT * FROM messages WHERE message_id = ?',
      params: ['msg_d1_2'],
    },
    {
      label: 'listHistoryMessagesBefore first page',
      pattern: /from "messages" where .*order by "messages"\."created_seq" desc limit \?$/u,
      run: (target) =>
        listHistoryMessagesBefore(target, {
          roomId: 'room_group_1',
          snapshot: 9,
          fromSeq: 4,
          beforeSeq: null,
          limit: 20,
        }),
      raw: `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq >= ?
        ORDER BY created_seq DESC LIMIT ?`,
      params: ['room_group_1', 9, 4, 20],
    },
    {
      label: 'listHistoryMessagesBefore cursor',
      pattern: /from "messages" where .*order by "messages"\."created_seq" desc limit \?$/u,
      run: (target) =>
        listHistoryMessagesBefore(target, {
          roomId: 'room_group_1',
          snapshot: 9,
          fromSeq: 4,
          beforeSeq: 9,
          limit: 20,
        }),
      raw: `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq >= ? AND created_seq < ?
        ORDER BY created_seq DESC LIMIT ?`,
      params: ['room_group_1', 9, 4, 9, 20],
    },
    {
      label: 'listHistoryMessagesAfter',
      pattern: /from "messages" where .*order by "messages"\."created_seq" asc limit \?$/u,
      run: (target) =>
        listHistoryMessagesAfter(target, {
          roomId: 'room_group_1',
          snapshot: 9,
          fromSeq: 4,
          afterSeq: 4,
          limit: 20,
        }),
      raw: `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq > ? AND created_seq >= ?
        ORDER BY created_seq ASC LIMIT ?`,
      params: ['room_group_1', 9, 4, 4, 20],
    },
    {
      label: 'listHistoryMessagesByIds',
      pattern: /from "messages" where "messages"\."message_id" in \(\?, \?\)$/u,
      run: (target) => listHistoryMessagesByIds(target, ['msg_g1_8', 'msg_g1_9']),
      raw: `SELECT ${HISTORY_SELECT} FROM messages WHERE message_id IN (?, ?)`,
      params: ['msg_g1_8', 'msg_g1_9'],
    },
    {
      label: 'getMessageContextAnchor',
      pattern: /inner join "actors" .*where .*"messages"\."message_id" = \?\)$/u,
      run: (target) => getMessageContextAnchor(target, 'room_group_1', 'msg_g1_8'),
      raw: `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.message_id = ?`,
      params: ['room_group_1', 'msg_g1_8'],
    },
    {
      label: 'listMessageContextWindow before',
      pattern: /inner join "actors" .*order by "messages"\."created_seq" desc limit \?$/u,
      run: (target) =>
        listMessageContextWindow(target, {
          roomId: 'room_group_1',
          pivotSeq: 8,
          direction: 'before',
          fromSeq: 4,
          toSeq: 8,
          limit: 20,
        }),
      raw: `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq < ? AND m.created_seq >= ?
        ORDER BY m.created_seq DESC LIMIT ?`,
      params: ['room_group_1', 8, 4, 20],
    },
    {
      label: 'listMessageContextWindow after',
      pattern: /inner join "actors" .*order by "messages"\."created_seq" asc limit \?$/u,
      run: (target) =>
        listMessageContextWindow(target, {
          roomId: 'room_group_1',
          pivotSeq: 3,
          direction: 'after',
          fromSeq: 3,
          toSeq: 8,
          limit: 20,
        }),
      raw: `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq > ? AND m.created_seq >= ? AND m.created_seq <= ?
        ORDER BY m.created_seq ASC LIMIT ?`,
      params: ['room_group_1', 3, 3, 8, 20],
    },
    {
      label: 'getMessageSenderSummary',
      pattern: /left join "actors" .*where "messages"\."message_id" = \?$/u,
      run: (target) => getMessageSenderSummary(target, 'msg_g1_8'),
      raw: `SELECT m.message_id, m.sender_id, m.created_seq, m.preview, m.body_bytes,
              m.created_at, a.name AS sender_name, a.kind AS sender_kind
         FROM messages m LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.message_id = ?`,
      params: ['msg_g1_8'],
    },
    {
      label: 'listDeliveryStates',
      pattern: /from "deliveries" where .*group by "deliveries"\."message_id", "deliveries"\."state"$/u,
      run: (target) => listDeliveryStates(target, ['msg_g1_8', 'msg_g1_9']),
      raw: `SELECT message_id, state, COUNT(*) AS n,
              MAX(CASE WHEN state = 'claimed' THEN claimed_at END) AS max_claimed_at,
              MAX(CASE WHEN state = 'claimed' THEN updated_at END) AS max_updated_at
         FROM deliveries WHERE message_id IN (?, ?) GROUP BY message_id, state`,
      params: ['msg_g1_8', 'msg_g1_9'],
    },
    {
      label: 'listMessageMentions',
      pattern: /from "message_mentions" where .*order by "message_mentions"\."message_id", "message_mentions"\."actor_id"$/u,
      run: (target) => listMessageMentions(target, ['msg_g1_8', 'msg_g1_9']),
      raw: `SELECT message_id, actor_id, actor_kind, source FROM message_mentions
        WHERE message_id IN (?, ?) ORDER BY message_id, actor_id`,
      params: ['msg_g1_8', 'msg_g1_9'],
    },
    {
      label: 'listInboxDeliveries active',
      pattern: /from "deliveries" inner join "messages".*order by "deliveries"\."created_seq" asc limit \?$/u,
      run: (target) =>
        listInboxDeliveries(target, {
          recipientId: 'act_agent_1',
          states: ['pending', 'claimed'],
          afterSeq: null,
          limit: 3,
        }),
      raw: `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? AND d.state IN (?, ?)
        ORDER BY d.created_seq ASC
        LIMIT ?`,
      params: ['act_agent_1', 'pending', 'claimed', 3],
    },
    {
      label: 'listInboxDeliveries cursor',
      pattern: /from "deliveries" inner join "messages".*order by "deliveries"\."created_seq" asc limit \?$/u,
      run: (target) =>
        listInboxDeliveries(target, {
          recipientId: 'act_agent_1',
          states: ['pending', 'claimed'],
          afterSeq: 1,
          limit: 3,
        }),
      raw: `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? AND d.state IN (?, ?) AND d.created_seq > ?
        ORDER BY d.created_seq ASC
        LIMIT ?`,
      params: ['act_agent_1', 'pending', 'claimed', 1, 3],
    },
  ];

  console.log('\nmessage/delivery query plans (EXPLAIN QUERY PLAN):');
  for (const item of cases) {
    const captured = capture(db);
    await item.run(captured.db);
    const query = captured.executed.find((entry) => item.pattern.test(entry.sql));
    check(`捕获 ${item.label} 的 SQL`, query !== undefined);
    if (!query) continue;
    const actual = normalizePlan(plan(sqlite, query.sql, query.params));
    const expected = normalizePlan(plan(sqlite, item.raw, item.params));
    checkEqual(`EXPLAIN ${item.label}`, JSON.stringify(actual), JSON.stringify(expected));
    console.log(`  ${item.label}: ${actual.join(' | ')}`);
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

  const rawMessage = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM messages WHERE message_id = ?', ['msg_g1_8']);
  const ormMessage = async (): Promise<unknown> => getMessage(db, 'msg_g1_8');
  const rawHistory = async (): Promise<unknown> =>
    rawAll(
      sqlite,
      `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq >= ?
        ORDER BY created_seq DESC LIMIT ?`,
      ['room_group_1', 9, 4, 21],
    );
  const ormHistory = async (): Promise<unknown> =>
    listHistoryMessagesBefore(db, {
      roomId: 'room_group_1',
      snapshot: 9,
      fromSeq: 4,
      beforeSeq: null,
      limit: 21,
    });
  const rawStates = async (): Promise<unknown> =>
    rawAll(
      sqlite,
      `SELECT message_id, state, COUNT(*) AS n,
              MAX(CASE WHEN state = 'claimed' THEN claimed_at END) AS max_claimed_at,
              MAX(CASE WHEN state = 'claimed' THEN updated_at END) AS max_updated_at
         FROM deliveries WHERE message_id IN (?, ?) GROUP BY message_id, state`,
      ['msg_g1_8', 'msg_g1_9'],
    );
  const ormStates = async (): Promise<unknown> =>
    listDeliveryStates(db, ['msg_g1_8', 'msg_g1_9']);
  const rawInboxBench = async (): Promise<unknown> =>
    rawAll(
      sqlite,
      `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? AND d.state IN (?, ?)
        ORDER BY d.created_seq ASC LIMIT ?`,
      ['act_agent_1', 'pending', 'claimed', 21],
    );
  const ormInboxBench = async (): Promise<unknown> =>
    listInboxDeliveries(db, {
      recipientId: 'act_agent_1',
      states: ['pending', 'claimed'],
      afterSeq: null,
      limit: 21,
    });
  const rawMentionsBench = async (): Promise<unknown> =>
    rawAll(
      sqlite,
      `SELECT message_id, actor_id, actor_kind, source FROM message_mentions
        WHERE message_id IN (?, ?) ORDER BY message_id, actor_id`,
      ['msg_g1_8', 'msg_g1_9'],
    );
  const ormMentionsBench = async (): Promise<unknown> =>
    listMessageMentions(db, ['msg_g1_8', 'msg_g1_9']);

  console.log('\nread query benchmark (in-memory, includes drizzle build):');
  console.log(`  raw   ${await bench('actor', rawActor)}`);
  console.log(`  orm   ${await bench('actor', ormActor)}`);
  console.log(`  raw   ${await bench('member', rawMember)}`);
  console.log(`  orm   ${await bench('member', ormMember)}`);
  console.log(`  raw   ${await bench('count', rawCount)}`);
  console.log(`  orm   ${await bench('count', ormCount)}`);
  console.log(`  raw   ${await bench('identity', rawIdentity)}`);
  console.log(`  orm   ${await bench('identity', ormIdentity)}`);
  console.log(`  raw   ${await bench('message', rawMessage, 2_000)}`);
  console.log(`  orm   ${await bench('message', ormMessage, 2_000)}`);
  console.log(`  raw   ${await bench('history', rawHistory, 2_000)}`);
  console.log(`  orm   ${await bench('history', ormHistory, 2_000)}`);
  console.log(`  raw   ${await bench('states', rawStates, 2_000)}`);
  console.log(`  orm   ${await bench('states', ormStates, 2_000)}`);
  console.log(`  raw   ${await bench('inbox', rawInboxBench, 2_000)}`);
  console.log(`  orm   ${await bench('inbox', ormInboxBench, 2_000)}`);
  console.log(`  raw   ${await bench('mentions', rawMentionsBench, 2_000)}`);
  console.log(`  orm   ${await bench('mentions', ormMentionsBench, 2_000)}`);
}

async function main(): Promise<void> {
  const sqlite = new Database(':memory:');
  migrate(sqlite, MIGRATIONS);
  seed(sqlite);
  const db = createD1(sqlite);
  try {
    await rowParityChecks(sqlite, db);
    explainChecks(sqlite, db);
    await messageExplainChecks(sqlite, db);
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
