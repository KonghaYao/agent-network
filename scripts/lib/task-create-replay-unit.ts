/**
 * D01 同一来源消息创建任务的幂等回归。
 *
 * 使用内存 SQLite 与真实 migrations，不访问服务端；验证公开任务领取后、
 * 指定任务接受/重派后，用相同参数重放 `taskCreate` 仍收敛到原任务，
 * 数据库不会生成第二个任务或第二张卡片；不同语义参数仍返回 CONFLICT。
 * 同时用 0029 旧库升级到 0030，验证只有可证明创建时的 assignment 会被
 * 回填为初始负责人，公开任务的后续领取不被误判。
 */

import { Database } from 'bun:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { BusinessError } from '../../src/contracts/errors';
import type { Principal } from '../../src/domain/principal';
import {
  taskAccept,
  taskClaim,
  taskCreate,
  taskDecline,
  taskOffer,
} from '../../src/domain/tasks';
import type { ActorRow } from '../../src/storage/rows';
import { check, checkEqual } from './harness';

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const OWNER = 'usr_replay_owner';
const AGENT = 'agt_replay_agent';
const AGENT_TWO = 'agt_replay_agent_two';
const ROOM = 'rm_replay';
const AT = 1_700_000_000_000;

const MESSAGE_PUBLIC = 'msg_replay_public';
const MESSAGE_ACCEPT = 'msg_replay_accept';
const MESSAGE_REOFFER = 'msg_replay_reoffer';

function principalFor(db: Database, actorId: string): Principal {
  const row = db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actorId) as ActorRow;
  return {
    credentialHash: `replay:${actorId}`,
    actor: row,
    credential: {
      credential_id: `cred_${actorId}`,
      actor_id: actorId,
      device_id: `dev_${actorId}`,
      token_hash: `hash_${actorId}`,
      revoked_at: null,
      created_at: 1,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}

function count(db: Database, sql: string, ...binds: string[]): number {
  return (db.prepare(sql).get(...binds) as { n: number }).n;
}

function seedPeople(db: Database): void {
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${OWNER}', 'human', NULL, 'Replay Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT}', 'agent', 'sess_replay_agent', 'Replay Agent', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT_TWO}', 'agent', 'sess_replay_agent_two', 'Replay Agent Two', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
       member_seq, last_message_id, created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${OWNER}', 'Replay Room', NULL, 10, 0, 0, NULL,
            ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES
      ('${ROOM}', '${OWNER}', 'owner', 'active', 0, 0, ${AT}),
      ('${ROOM}', '${AGENT}', 'member', 'active', 0, 0, ${AT}),
      ('${ROOM}', '${AGENT_TWO}', 'member', 'active', 0, 0, ${AT});

    INSERT INTO messages
      (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
       preview, reply_to, root_id, hop, root_invocations_used, created_at)
    VALUES
      ('${MESSAGE_PUBLIC}', '${ROOM}', '${OWNER}', 'cm_replay_public', 1, '公开任务来源', 18,
       '公开任务来源', NULL, NULL, 0, 0, ${AT}),
      ('${MESSAGE_ACCEPT}', '${ROOM}', '${OWNER}', 'cm_replay_accept', 2, '接受任务来源', 18,
       '接受任务来源', NULL, NULL, 0, 0, ${AT}),
      ('${MESSAGE_REOFFER}', '${ROOM}', '${OWNER}', 'cm_replay_reoffer', 3, '重派任务来源', 18,
       '重派任务来源', NULL, NULL, 0, 0, ${AT});
  `);
}

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  seedPeople(db);
  return db;
}

async function expectConflict(label: string, run: Promise<unknown>): Promise<void> {
  try {
    await run;
  } catch (error) {
    check(
      label,
      error instanceof BusinessError && error.code === 'CONFLICT',
      error instanceof Error ? error.message : error,
    );
    return;
  }
  check(label, false, '期望 CONFLICT，实际成功');
}

/** 0029 旧库 + 旧任务行；用于验证 0030 的真实升级回填。 */
function legacyDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const names = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names) {
    if (name >= '0030') break;
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, 1);
  }
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${OWNER}', 'human', NULL, 'Replay Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT}', 'agent', 'sess_replay_agent', 'Replay Agent', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
       member_seq, last_message_id, created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${OWNER}', 'Replay Room', NULL, 10, 0, 0, NULL,
            ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES
      ('${ROOM}', '${OWNER}', 'owner', 'active', 0, 0, ${AT}),
      ('${ROOM}', '${AGENT}', 'member', 'active', 0, 0, ${AT});

    INSERT INTO messages
      (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
       preview, reply_to, root_id, hop, root_invocations_used, created_at)
    VALUES
      ('${MESSAGE_PUBLIC}', '${ROOM}', '${OWNER}', 'cm_replay_public', 1, '公开任务来源', 18,
       '公开任务来源', NULL, NULL, 0, 0, ${AT}),
      ('${MESSAGE_ACCEPT}', '${ROOM}', '${OWNER}', 'cm_replay_accept', 2, '接受任务来源', 18,
       '接受任务来源', NULL, NULL, 0, 0, ${AT});

    -- 旧任务 A：创建时即指派给 AGENT，assignment 与任务同一时刻、由创建者发出。
    INSERT INTO tasks
      (task_id, room_id, created_by, source_message_id, title, description,
       acceptance_criteria, status, revision, owner_actor_id, current_assignment_id,
       reviewer_actor_id, due_at, blocked_reason, blocked_at, last_progress_at,
       business_authority, external_binding_id, created_at, updated_at,
       accepted_at, cancelled_at)
    VALUES
      ('tsk_legacy_assigned', '${ROOM}', '${OWNER}', '${MESSAGE_ACCEPT}', '旧指派任务', '', '',
       'offered', 1, NULL, 'asg_legacy_assigned', '${OWNER}', NULL, NULL, NULL, NULL,
       'native', NULL, ${AT}, ${AT}, NULL, NULL);

    INSERT INTO task_assignments
      (assignment_id, task_id, assignment_version, owner_actor_id, status,
       offered_by, offer_expires_at, accepted_at, ended_at, last_progress_at,
       delivery_id, created_at, updated_at)
    VALUES ('asg_legacy_assigned', 'tsk_legacy_assigned', 1, '${AGENT}', 'offered',
            '${OWNER}', ${AT + 3_600_000}, NULL, NULL, NULL, NULL, ${AT}, ${AT});

    -- 旧任务 B：公开任务创建后由 AGENT 领取，assignment 晚于任务且由领取者发出。
    INSERT INTO tasks
      (task_id, room_id, created_by, source_message_id, title, description,
       acceptance_criteria, status, revision, owner_actor_id, current_assignment_id,
       reviewer_actor_id, due_at, blocked_reason, blocked_at, last_progress_at,
       business_authority, external_binding_id, created_at, updated_at,
       accepted_at, cancelled_at)
    VALUES
      ('tsk_legacy_public', '${ROOM}', '${OWNER}', '${MESSAGE_PUBLIC}', '旧公开任务', '', '',
       'in_progress', 2, '${AGENT}', 'asg_legacy_public', '${OWNER}', NULL, NULL, NULL, ${AT},
       'native', NULL, ${AT}, ${AT + 1000}, NULL, NULL);

    INSERT INTO task_assignments
      (assignment_id, task_id, assignment_version, owner_actor_id, status,
       offered_by, offer_expires_at, accepted_at, ended_at, last_progress_at,
       delivery_id, created_at, updated_at)
    VALUES ('asg_legacy_public', 'tsk_legacy_public', 1, '${AGENT}', 'active',
            '${AGENT}', NULL, ${AT + 1000}, NULL, ${AT + 1000}, NULL, ${AT + 1000}, ${AT + 1000});
  `);
  return db;
}

export async function runTaskCreateReplayUnitChecks(): Promise<void> {
  const db = freshDb();
  const d1 = createD1(db);
  const owner = principalFor(db, OWNER);
  const agent = principalFor(db, AGENT);

  // 公开任务 create → claim → 相同参数重放。
  const publicCreate = {
    request_id: 'req_replay_public_create',
    room_id: ROOM,
    title: '公开重放任务',
    description: '公开任务领取后重放。',
    source_message_id: MESSAGE_PUBLIC,
  };
  const publicTask = await taskCreate(d1, owner, publicCreate);
  checkEqual('[D01-REPLAY] 公开任务创建无初始负责人', publicTask.task.owner_actor_id, null);

  const claimed = await taskClaim(d1, agent, {
    request_id: 'req_replay_public_claim',
    task_id: publicTask.task.task_id,
  });
  checkEqual('[D01-REPLAY] 公开任务领取转为 in_progress', claimed.task.status, 'in_progress');
  checkEqual('[D01-REPLAY] 领取记录负责人', claimed.task.owner_actor_id, AGENT);

  const publicReplay = await taskCreate(d1, owner, {
    ...publicCreate,
    request_id: 'req_replay_public_replay',
  });
  checkEqual(
    '[D01-REPLAY] 公开任务领取后相同参数重放返回同一任务',
    publicReplay.task.task_id,
    publicTask.task.task_id,
  );
  checkEqual('[D01-REPLAY] 重放返回领取后的状态', publicReplay.task.status, 'in_progress');
  checkEqual('[D01-REPLAY] 重放返回领取后的负责人', publicReplay.task.owner_actor_id, AGENT);
  checkEqual(
    '[D01-REPLAY] 公开任务重放后数据库只有一个任务',
    count(db, 'SELECT COUNT(*) AS n FROM tasks WHERE source_message_id = ?', MESSAGE_PUBLIC),
    1,
  );
  checkEqual(
    '[D01-REPLAY] 公开任务重放后只有一张任务卡片',
    count(db, 'SELECT COUNT(*) AS n FROM task_cards WHERE task_id = ?', publicTask.task.task_id),
    1,
  );
  checkEqual(
    '[D01-REPLAY] 公开任务初始负责人保持 NULL',
    (
      db
        .prepare('SELECT initial_assignee_actor_id FROM tasks WHERE task_id = ?')
        .get(publicTask.task.task_id) as { initial_assignee_actor_id: string | null }
    ).initial_assignee_actor_id,
    null,
  );

  // 指定 Agent 的任务 create → accept → 相同参数重放。
  const acceptCreate = {
    request_id: 'req_replay_accept_create',
    room_id: ROOM,
    title: '接受后重放任务',
    description: '接受后重放。',
    source_message_id: MESSAGE_ACCEPT,
    assignee_actor_id: AGENT,
  };
  const acceptTask = await taskCreate(d1, owner, acceptCreate);
  const accepted = await taskAccept(d1, agent, {
    request_id: 'req_replay_accept',
    task_id: acceptTask.task.task_id,
    assignment_id: acceptTask.task.assignment?.assignment_id,
  });
  checkEqual('[D01-REPLAY] 指定任务接受后为 in_progress', accepted.task.status, 'in_progress');
  const acceptReplay = await taskCreate(d1, owner, {
    ...acceptCreate,
    request_id: 'req_replay_accept_replay',
  });
  checkEqual(
    '[D01-REPLAY] 接受后相同参数重放返回同一任务',
    acceptReplay.task.task_id,
    acceptTask.task.task_id,
  );
  checkEqual(
    '[D01-REPLAY] 接受后重放不新增 assignment',
    count(db, 'SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ?', acceptTask.task.task_id),
    1,
  );

  // 指定 Agent 的任务 create → decline → reoffer → 相同参数重放。
  const reofferCreate = {
    request_id: 'req_replay_reoffer_create',
    room_id: ROOM,
    title: '重派后重放任务',
    description: '重派后重放。',
    source_message_id: MESSAGE_REOFFER,
    assignee_actor_id: AGENT,
  };
  const reofferTask = await taskCreate(d1, owner, reofferCreate);
  const declined = await taskDecline(d1, agent, {
    request_id: 'req_replay_decline',
    task_id: reofferTask.task.task_id,
    assignment_id: reofferTask.task.assignment?.assignment_id,
  });
  const reoffered = await taskOffer(d1, owner, {
    request_id: 'req_replay_reoffer',
    task_id: reofferTask.task.task_id,
    assignee_actor_id: AGENT_TWO,
    expected_revision: declined.task.revision,
  });
  checkEqual('[D01-REPLAY] 重派生成第二个 assignment', reoffered.task.assignment?.assignment_version, 2);
  const reofferReplay = await taskCreate(d1, owner, {
    ...reofferCreate,
    request_id: 'req_replay_reoffer_replay',
  });
  checkEqual(
    '[D01-REPLAY] 重派后相同参数重放返回同一任务',
    reofferReplay.task.task_id,
    reofferTask.task.task_id,
  );
  checkEqual(
    '[D01-REPLAY] 重派后初始负责人仍是创建时的 AGENT',
    (
      db
        .prepare('SELECT initial_assignee_actor_id FROM tasks WHERE task_id = ?')
        .get(reofferTask.task.task_id) as { initial_assignee_actor_id: string | null }
    ).initial_assignee_actor_id,
    AGENT,
  );

  // 同来源不同语义参数仍必须 CONFLICT，并带既有 task_id。
  const base = publicCreate;
  await expectConflict(
    '[D01-REPLAY] 不同标题返回 CONFLICT',
    taskCreate(d1, owner, { ...base, request_id: 'req_replay_bad_title', title: '另一个标题' }),
  );
  await expectConflict(
    '[D01-REPLAY] 不同描述返回 CONFLICT',
    taskCreate(d1, owner, {
      ...base,
      request_id: 'req_replay_bad_description',
      description: '另一个描述',
    }),
  );
  await expectConflict(
    '[D01-REPLAY] 不同验收条件返回 CONFLICT',
    taskCreate(d1, owner, {
      ...base,
      request_id: 'req_replay_bad_acceptance',
      acceptance_criteria: '另一个验收条件',
    }),
  );
  await expectConflict(
    '[D01-REPLAY] 不同期限返回 CONFLICT',
    taskCreate(d1, owner, {
      ...base,
      request_id: 'req_replay_bad_due',
      due_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
  await expectConflict(
    '[D01-REPLAY] 不同负责人返回 CONFLICT',
    taskCreate(d1, owner, {
      ...base,
      request_id: 'req_replay_bad_assignee',
      assignee_actor_id: AGENT,
    }),
  );
  await expectConflict(
    '[D01-REPLAY] 不同验收人返回 CONFLICT',
    taskCreate(d1, owner, {
      ...base,
      request_id: 'req_replay_bad_reviewer',
      reviewer_actor_id: AGENT,
    }),
  );
  checkEqual(
    '[D01-REPLAY] 参数冲突后仍只有一个任务',
    count(db, 'SELECT COUNT(*) AS n FROM tasks WHERE source_message_id = ?', MESSAGE_PUBLIC),
    1,
  );

  // 0029 旧库升级到 0030：只回填可证明创建时的 assignment。
  const legacy = legacyDb();
  const applied = migrate(legacy, MIGRATIONS);
  checkEqual('[D01-REPLAY] 旧库只应用 0030', applied.join(','), '0030_task_initial_assignee.sql');
  const legacyAssigned = legacy
    .prepare('SELECT initial_assignee_actor_id FROM tasks WHERE task_id = ?')
    .get('tsk_legacy_assigned') as { initial_assignee_actor_id: string | null };
  checkEqual(
    '[D01-REPLAY] 旧指派任务按创建时 assignment 回填负责人',
    legacyAssigned.initial_assignee_actor_id,
    AGENT,
  );
  const legacyPublic = legacy
    .prepare('SELECT initial_assignee_actor_id FROM tasks WHERE task_id = ?')
    .get('tsk_legacy_public') as { initial_assignee_actor_id: string | null };
  checkEqual(
    '[D01-REPLAY] 旧公开任务的领取 assignment 不回填',
    legacyPublic.initial_assignee_actor_id,
    null,
  );

  const legacyD1 = createD1(legacy);
  const legacyOwner = principalFor(legacy, OWNER);
  const legacyPublicReplay = await taskCreate(legacyD1, legacyOwner, {
    request_id: 'req_replay_legacy_public',
    room_id: ROOM,
    title: '旧公开任务',
    source_message_id: MESSAGE_PUBLIC,
  });
  checkEqual(
    '[D01-REPLAY] 旧公开任务升级后相同参数重放返回同一任务',
    legacyPublicReplay.task.task_id,
    'tsk_legacy_public',
  );
  const legacyAssignedReplay = await taskCreate(legacyD1, legacyOwner, {
    request_id: 'req_replay_legacy_assigned',
    room_id: ROOM,
    title: '旧指派任务',
    source_message_id: MESSAGE_ACCEPT,
    assignee_actor_id: AGENT,
  });
  checkEqual(
    '[D01-REPLAY] 旧指派任务升级后相同参数重放返回同一任务',
    legacyAssignedReplay.task.task_id,
    'tsk_legacy_assigned',
  );
  await expectConflict(
    '[D01-REPLAY] 旧公开任务用非创建负责人重放仍 CONFLICT',
    taskCreate(legacyD1, legacyOwner, {
      request_id: 'req_replay_legacy_public_bad',
      room_id: ROOM,
      title: '旧公开任务',
      source_message_id: MESSAGE_PUBLIC,
      assignee_actor_id: AGENT,
    }),
  );
}
