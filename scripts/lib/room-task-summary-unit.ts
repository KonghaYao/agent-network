/**
 * 房间任务概览的本地 SQL 测试。
 *
 * 使用内存 SQLite 与真实 migrations，不访问服务端；验证
 * `network_task_summary` 与 `login.task_summary` 的 claimed 只统计当前 actor，
 * 跨房间聚合、非成员房间排除，以及只读调用不写 events/outbox/operations。
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import type { Principal } from '../../src/domain/principal';
import { taskCounts, taskSummary } from '../../src/domain/tasks';
import type { Env } from '../../src/env';
import { NotificationHub } from '../../src/realtime/hub';
import { login } from '../../src/realtime/presence';
import { getActor } from '../../src/storage/queries';
import { check, checkEqual } from './harness';

const MIGRATIONS = resolve(import.meta.dir, '../../migrations');
const AT = 1_700_000_000_000;

function seed(db: Database): void {
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('usr_owner', 'human', NULL, 'Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('agt_a', 'agent', 'sess_a', 'Agent A', '{}', 9, 0, 3, ${AT}, ${AT}),
      ('agt_b', 'agent', 'sess_b', 'Agent B', '{}', 4, 0, 1, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
       member_seq, last_message_id, created_at, updated_at)
    VALUES
      ('rm_one', 'group', 'usr_owner', 'One', NULL, 11, 0, 0, NULL, ${AT}, ${AT}),
      ('rm_two', 'group', 'usr_owner', 'Two', NULL, 12, 0, 0, NULL, ${AT}, ${AT}),
      ('rm_three', 'group', 'usr_owner', 'Three', NULL, 13, 0, 0, NULL, ${AT}, ${AT});

    INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES
      ('rm_one', 'usr_owner', 'owner', 'active', 0, 0, ${AT}),
      ('rm_one', 'agt_a', 'member', 'active', 0, 0, ${AT}),
      ('rm_one', 'agt_b', 'member', 'active', 0, 0, ${AT}),
      ('rm_two', 'usr_owner', 'owner', 'active', 0, 0, ${AT}),
      ('rm_two', 'agt_a', 'member', 'active', 0, 0, ${AT}),
      ('rm_three', 'usr_owner', 'owner', 'active', 0, 0, ${AT}),
      ('rm_three', 'agt_b', 'member', 'active', 0, 0, ${AT});

    INSERT INTO room_tasks
      (task_id, room_id, list_id, description, status, assignee_actor_id, result,
       created_by, created_at, updated_at, completed_at, sort_order)
    VALUES
      ('tsk_pending_1', 'rm_one', 'default', 'pending one', 'pending', NULL, NULL,
       'usr_owner', ${AT}, ${AT}, NULL, 0),
      ('tsk_claimed_a', 'rm_one', 'default', 'claimed by A', 'claimed', 'agt_a', NULL,
       'usr_owner', ${AT}, ${AT}, NULL, 1),
      ('tsk_claimed_b', 'rm_one', 'default', 'claimed by B', 'claimed', 'agt_b', NULL,
       'usr_owner', ${AT}, ${AT}, NULL, 2),
      ('tsk_done', 'rm_one', 'default', 'done one', 'done', 'agt_a', 'ok',
       'usr_owner', ${AT}, ${AT}, ${AT + 1}, 3),
      ('tsk_failed', 'rm_one', 'default', 'failed one', 'failed', 'agt_b', 'nope',
       'usr_owner', ${AT}, ${AT}, ${AT + 1}, 4),
      ('tsk_pending_2', 'rm_two', 'default', 'pending two', 'pending', NULL, NULL,
       'usr_owner', ${AT}, ${AT}, NULL, 0),
      ('tsk_claimed_a_2', 'rm_two', 'default', 'claimed by A in two', 'claimed', 'agt_a', NULL,
       'usr_owner', ${AT}, ${AT}, NULL, 1),
      ('tsk_done_2', 'rm_two', 'default', 'done two', 'done', 'agt_a', 'ok',
       'usr_owner', ${AT}, ${AT}, ${AT + 1}, 2),
      ('tsk_pending_3', 'rm_three', 'default', 'pending three', 'pending', NULL, NULL,
       'usr_owner', ${AT}, ${AT}, NULL, 0),
      ('tsk_claimed_b_3', 'rm_three', 'default', 'claimed by B in three', 'claimed', 'agt_b', NULL,
       'usr_owner', ${AT}, ${AT}, NULL, 1);
  `);
}

function tableCount(db: Database, table: 'events' | 'outbox' | 'operations'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function snapshot(db: Database): string {
  return JSON.stringify({
    events: tableCount(db, 'events'),
    outbox: tableCount(db, 'outbox'),
    operations: tableCount(db, 'operations'),
    actors: db
      .prepare('SELECT actor_id, pending_count, inbox_head_seq FROM actors ORDER BY actor_id')
      .all(),
    rooms: db.prepare('SELECT room_id, head_seq, last_message_id FROM rooms ORDER BY room_id').all(),
    members: db
      .prepare('SELECT room_id, actor_id, last_read_seq FROM room_members ORDER BY room_id, actor_id')
      .all(),
    tasks: db
      .prepare('SELECT task_id, status, assignee_actor_id FROM room_tasks ORDER BY task_id')
      .all(),
  });
}

async function principalFor(db: D1Database, actorId: string): Promise<Principal> {
  const actor = await getActor(db, actorId);
  if (!actor) throw new Error(`missing seeded actor: ${actorId}`);
  return { credentialHash: 'test-hash', actor, credential: null };
}

export async function runRoomTaskSummaryUnitChecks(): Promise<void> {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  seed(db);
  const d1 = createD1(db);
  const principalA = await principalFor(d1, 'agt_a');
  const principalB = await principalFor(d1, 'agt_b');
  const principalHuman = await principalFor(d1, 'usr_owner');

  const before = snapshot(db);

  const countsA = await taskCounts(d1, principalA);
  checkEqual('login 概览 pending 是未领取跨房间总量', countsA.pending, 2);
  checkEqual('login 概览 claimed 只含 A 本人跨房间领取', countsA.claimed, 2);
  checkEqual('login 概览 done 是房间总量', countsA.done, 2);
  checkEqual('login 概览 failed 是房间总量', countsA.failed, 1);
  checkEqual('login 概览 total 含他人 claimed', countsA.total, 8);

  const summaryA = await taskSummary(d1, principalA, {});
  checkEqual('per-room summary 只返回 A 的 active 房间', summaryA.items.length, 2);
  const rmOneA = summaryA.items.find((item) => item.room_id === 'rm_one');
  const rmTwoA = summaryA.items.find((item) => item.room_id === 'rm_two');
  checkEqual('rm_one total', rmOneA?.total, 5);
  checkEqual('rm_one pending', rmOneA?.pending, 1);
  checkEqual('rm_one claimed 只含 A 本人', rmOneA?.claimed, 1);
  checkEqual('rm_one done', rmOneA?.done, 1);
  checkEqual('rm_one failed', rmOneA?.failed, 1);
  checkEqual('rm_two total', rmTwoA?.total, 3);
  checkEqual('rm_two pending', rmTwoA?.pending, 1);
  checkEqual('rm_two claimed 只含 A 本人', rmTwoA?.claimed, 1);
  checkEqual('rm_two done', rmTwoA?.done, 1);
  checkEqual('rm_two failed', rmTwoA?.failed, 0);
  check(
    'A 的 summary 不包含未加入的 rm_three',
    !summaryA.items.some((item) => item.room_id === 'rm_three'),
    summaryA.items,
  );
  checkEqual(
    'rm_one 的 pending+claimed+done+failed 可小于 total（他人 claimed 不重复计入 claimed）',
    (rmOneA?.pending ?? 0) + (rmOneA?.claimed ?? 0) + (rmOneA?.done ?? 0) + (rmOneA?.failed ?? 0),
    4,
  );

  const filteredA = await taskSummary(d1, principalA, { room_ids: ['rm_one', 'rm_three'] });
  checkEqual('summary room_ids 过滤只保留 active 成员房间', filteredA.items.length, 1);
  checkEqual('summary room_ids 过滤保留 rm_one', filteredA.items[0]?.room_id, 'rm_one');

  const countsB = await taskCounts(d1, principalB);
  checkEqual('B login 概览 claimed 只含 B 本人', countsB.claimed, 2);
  checkEqual('B login 概览 total 不含 B 未加入的 rm_two', countsB.total, 7);
  checkEqual('B login 概览 pending 只聚合 B 的 active 房间', countsB.pending, 2);
  const summaryB = await taskSummary(d1, principalB, {});
  checkEqual('B per-room summary 返回 B 的 active 房间', summaryB.items.length, 2);
  checkEqual(
    'B 在 rm_one 的 claimed 只含 B 本人',
    summaryB.items.find((item) => item.room_id === 'rm_one')?.claimed,
    1,
  );
  check(
    'B 的 summary 不包含未加入的 rm_two',
    !summaryB.items.some((item) => item.room_id === 'rm_two'),
    summaryB.items,
  );

  const countsHuman = await taskCounts(d1, principalHuman);
  checkEqual('human 不领取任务，claimed 恒为 0', countsHuman.claimed, 0);
  checkEqual('human 概览 total 是全部 active 房间总量', countsHuman.total, 10);

  checkEqual('任务概览与筛选只读，不写 events/outbox/operations', snapshot(db), before);

  const hub = new NotificationHub(db);
  const env: Env = {
    DB: d1,
    NOTIFICATION_HUB: hub,
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://127.0.0.1',
  };
  const beforeLogin = snapshot(db);
  const first = await login(env, principalA);
  const second = await login(env, principalA);
  checkEqual(
    'login.task_summary 与直接统计一致',
    JSON.stringify(first.task_summary),
    JSON.stringify(countsA),
  );
  checkEqual(
    '两次 login 返回同一任务概览',
    JSON.stringify(second.task_summary),
    JSON.stringify(first.task_summary),
  );
  checkEqual('login 透传 pending_count', first.pending_count, 3);
  checkEqual('login 透传 inbox_head_seq', first.inbox_head_seq, '9');
  checkEqual(
    '两次 login 不写 events/outbox/operations，也不改 pending_count/inbox_head/房间 head',
    snapshot(db),
    beforeLogin,
  );

  db.close();
}
