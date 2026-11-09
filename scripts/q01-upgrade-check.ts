/**
 * Q01-T03：旧基线数据库升级检查。
 *
 * 用真实 migrations 构造停在 `0035_task_recovery.sql` 的合成库，写入
 * credentials/devices、无主群、D04–D08 与 A06 的关键历史行，再顺序应用
 * `0036`–`0039`。检查重点是“升级不扩大权限”：旧凭据只回填设备行、不新增
 * credentials；无主群不被自动解散或回填 owner；审计表重建保留旧行。
 *
 * 运行：`bun scripts/q01-upgrade-check.ts`
 * 该脚本使用临时目录，不访问服务端、不读取或写入 `.data`。
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from '../src/bun/migrate';
import { check, checkEqual, checksPassed } from './lib/harness';

const SOURCE_MIGRATIONS = join(import.meta.dir, '../migrations');
const OLD_LAST = '0035_task_recovery.sql';
const NEW_MIGRATIONS = [
  '0036_device_pairing_sync.sql',
  '0037_room_lifecycle.sql',
  '0038_ownerless_room_guard.sql',
  '0039_delivery_message_state_index.sql',
  '0040_contact_invite_links.sql',
];
const AT = 1_700_000_000_000;

const HUMAN = 'usr_q01_owner';
const PEER = 'usr_q01_peer';
const AGENT = 'agt_q01_agent';
const ROOM = 'rm_q01_group';
const OWNERLESS = 'rm_q01_ownerless';
const TASK = 'tsk_q01_legacy';
const ASSIGNMENT = 'tas_q01_legacy';
const TRANSFER = 'ttr_q01_legacy';
const SUBMISSION = 'tsb_q01_legacy';
const REVIEW = 'trv_q01_legacy';
const PACK = 'thp_q01_legacy';
const DEVICE_ACTIVE = 'dev_q01_active';
const DEVICE_REVOKED = 'dev_q01_revoked';

function prepareOldMigrations(root: string): string {
  const dir = join(root, 'migrations-0035');
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(SOURCE_MIGRATIONS)) {
    if (!name.endsWith('.sql') || name > OLD_LAST) continue;
    copyFileSync(join(SOURCE_MIGRATIONS, name), join(dir, name));
  }
  return dir;
}

function seedOldDatabase(db: Database): void {
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${HUMAN}', 'human', NULL, 'Q01 Legacy Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${PEER}', 'human', NULL, 'Q01 Legacy Peer', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT}', 'agent', 'ags_q01_agent', 'Q01 Legacy Agent', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO credentials
      (credential_id, actor_id, device_id, token_hash, revoked_at, created_at, last_used_at, label)
    VALUES
      ('crd_q01_active', '${HUMAN}', '${DEVICE_ACTIVE}', 'hash_q01_active', NULL, ${AT}, ${AT}, '旧桌面'),
      ('crd_q01_revoked', '${HUMAN}', '${DEVICE_REVOKED}', 'hash_q01_revoked', ${AT}, ${AT}, ${AT}, '旧手机');

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq, member_seq,
       last_message_id, created_at, updated_at)
    VALUES
      ('${ROOM}', 'group', '${HUMAN}', 'Q01 升级群', NULL, 0, 0, 2, NULL, ${AT}, ${AT}),
      ('${OWNERLESS}', 'group', NULL, 'Q01 历史无主群', NULL, 0, 0, 1, NULL, ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
    VALUES
      ('${ROOM}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${ROOM}', '${PEER}', 'member', 'active', 1, 0, ${AT}, 1, ${AT}),
      ('${OWNERLESS}', '${PEER}', 'admin', 'active', 0, 0, ${AT}, 1, ${AT});

    INSERT INTO room_management_audit
      (audit_id, room_id, action, target_actor_id, previous_role, new_role,
       previous_status, new_status, expected_revision, resulting_revision,
       changed_by, request_id, detail_json, created_at)
    VALUES
      ('rma_q01_legacy', '${ROOM}', 'member_added', '${PEER}', NULL, 'member',
       NULL, 'active', NULL, 1, '${HUMAN}', 'req_q01_legacy', '{}', ${AT});

    INSERT INTO tasks
      (task_id, room_id, created_by, source_message_id, title, description, acceptance_criteria,
       status, revision, owner_actor_id, current_assignment_id, reviewer_actor_id, due_at,
       blocked_reason, blocked_at, last_progress_at, business_authority, external_binding_id,
       created_at, updated_at, accepted_at, cancelled_at, cancelled_by, cancel_reason,
       external_stop_status, parent_task_id, related_task_id)
    VALUES
      ('${TASK}', '${ROOM}', '${HUMAN}', NULL, 'Q01 旧任务', '', '可读取',
       'in_progress', 3, '${AGENT}', '${ASSIGNMENT}', '${PEER}', NULL,
       NULL, NULL, ${AT}, 'native', NULL, ${AT}, ${AT}, NULL, NULL, NULL, NULL, NULL, NULL, NULL);

    INSERT INTO task_assignments
      (assignment_id, task_id, assignment_version, owner_actor_id, status, offered_by,
       offer_expires_at, accepted_at, ended_at, last_progress_at, delivery_id, created_at, updated_at)
    VALUES
      ('${ASSIGNMENT}', '${TASK}', 2, '${AGENT}', 'active', '${HUMAN}', NULL, ${AT}, NULL, ${AT}, NULL, ${AT}, ${AT});

    INSERT INTO task_transfers
      (transfer_id, task_id, from_assignment_id, from_assignment_version, to_actor_id, status,
       context_json, version, created_by, created_at, expires_at, responded_at, responded_by)
    VALUES
      ('${TRANSFER}', '${TASK}', '${ASSIGNMENT}', 2, '${PEER}', 'pending', '{}', 1, '${HUMAN}',
       ${AT}, ${AT + 86_400_000}, NULL, NULL);

    INSERT INTO task_submissions
      (submission_id, task_id, assignment_id, assignment_version, version, summary, materials_json,
       evidence_json, known_limits, submitted_by, status, created_at, reviewed_at)
    VALUES
      ('${SUBMISSION}', '${TASK}', '${ASSIGNMENT}', 2, 1, '旧提交', '[]', '[]', '', '${AGENT}',
       'pending', ${AT}, NULL);

    INSERT INTO task_reviews
      (review_id, submission_id, task_id, reviewer_actor_id, decision, reason, created_at, checklist_json)
    VALUES
      ('${REVIEW}', '${SUBMISSION}', '${TASK}', '${PEER}', 'return', '旧退回', ${AT}, '[]');

    INSERT INTO task_handoff_packs
      (pack_id, task_id, room_id, version, from_assignment_id, from_assignment_version,
       from_owner_actor_id, created_by, goal, completed_json, current_result_json, unresolved_json,
       next_steps_json, source_room_id, created_at)
    VALUES
      ('${PACK}', '${TASK}', '${ROOM}', 1, '${ASSIGNMENT}', 2, '${AGENT}', '${AGENT}',
       '旧交接包', '[]', '{"summary":"进行中"}', '[]', '[]', NULL, ${AT});

    INSERT INTO task_reminders
      (reminder_id, task_id, assignment_id, assignment_version, owner_actor_id, anchor_at, event_key, created_at)
    VALUES
      ('trm_q01_legacy', '${TASK}', '${ASSIGNMENT}', 2, '${AGENT}', ${AT},
       'task_reminder:${TASK}:2:${AT}', ${AT});

    INSERT INTO task_external_actions
      (action_id, task_id, intent, state, evidence, created_by, created_at, updated_at)
    VALUES
      ('act_q01_legacy', '${TASK}', '发布旧版本', 'unknown', '等待对账', '${AGENT}', ${AT}, ${AT});

    INSERT INTO agent_management_transfers
      (transfer_id, agent_id, from_manager_id, to_manager_id, status, from_permission_version,
       context_json, created_by, created_at, expires_at, responded_at, responded_by, updated_at)
    VALUES
      ('amt_q01_legacy', '${AGENT}', '${HUMAN}', '${PEER}', 'pending', 1, '{}', '${HUMAN}',
       ${AT}, ${AT + 86_400_000}, NULL, NULL, ${AT});

    INSERT INTO device_pairings
      (pairing_id, challenge_hash, status, actor_id, created_at, expires_at, approved_by_actor_id,
       approved_by_credential_id, approved_at, redeemed_credential_id, redeemed_at, attempts,
       max_attempts, updated_at)
    VALUES
      ('dpq_q01_legacy', 'challenge_hash_q01', 'pending', '${HUMAN}', ${AT}, ${AT + 300_000},
       NULL, NULL, NULL, NULL, NULL, 0, 5, ${AT});
  `);
}

function rows(db: Database, sql: string): unknown[] {
  return db.prepare(sql).all();
}

function scalar<T>(db: Database, sql: string): T {
  const row = db.prepare(sql).get() as Record<string, T> | null;
  return Object.values(row ?? {})[0] as T;
}

function expectCheckFailure(label: string, db: Database, run: () => void): void {
  let failed = false;
  try {
    run();
  } catch {
    failed = true;
  }
  check(label, failed, '预期 CHECK 失败但没有失败');
}

const root = mkdtempSync(join(tmpdir(), 'q01-upgrade-'));
const dbPath = join(root, 'legacy.sqlite');
const oldDir = prepareOldMigrations(root);
let db: Database | null = null;
try {
  db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const oldApplied = migrate(db, oldDir);
  checkEqual('旧库停在 0035', oldApplied.at(-1), OLD_LAST);
  checkEqual('旧库迁移数 31', oldApplied.length, 31);

  seedOldDatabase(db);
  const before = {
    actors: scalar<number>(db, 'SELECT COUNT(*) FROM actors'),
    credentials: scalar<number>(db, 'SELECT COUNT(*) FROM credentials'),
    members: scalar<number>(db, 'SELECT COUNT(*) FROM room_members'),
    audit: scalar<number>(db, 'SELECT COUNT(*) FROM room_management_audit'),
    devices: scalar<number>(db, 'SELECT COUNT(*) FROM devices'),
    pairings: scalar<number>(db, "SELECT COUNT(*) FROM device_pairings WHERE status = 'pending'"),
  };
  checkEqual('升级前没有设备行', before.devices, 0);

  const appliedNow = migrate(db, SOURCE_MIGRATIONS);
  checkEqual('恰好应用 0036–0040', appliedNow.join(','), NEW_MIGRATIONS.join(','));
  const expectedMigrations = [
    ...Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, '0')),
    ...Array.from({ length: 24 }, (_, i) => String(i + 17).padStart(4, '0')),
  ];
  const actualMigrations = (
    db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>
  ).map((row) => row.name);
  checkEqual('迁移总数为 36', actualMigrations.length, 36);
  check(
    '迁移序号为 0001–0012、0017–0040',
    actualMigrations.every((name, i) => name.startsWith(`${expectedMigrations[i]}_`)),
    actualMigrations,
  );

  checkEqual('integrity_check=ok', scalar<string>(db, 'PRAGMA integrity_check'), 'ok');
  checkEqual('foreign_key_check 无违规', rows(db, 'PRAGMA foreign_key_check').length, 0);

  const devices = db
    .prepare('SELECT device_id, status FROM devices WHERE actor_id = ? ORDER BY device_id')
    .all(HUMAN) as Array<{ device_id: string; status: string }>;
  checkEqual(
    'credentials→devices 回填两台设备',
    devices.map((row) => `${row.device_id}:${row.status}`).join(','),
    `${DEVICE_ACTIVE}:active,${DEVICE_REVOKED}:revoked`,
  );
  checkEqual('升级未新增 credentials', scalar<number>(db, 'SELECT COUNT(*) FROM credentials'), before.credentials);
  checkEqual('升级未新增 actors', scalar<number>(db, 'SELECT COUNT(*) FROM actors'), before.actors);
  checkEqual('升级未新增成员', scalar<number>(db, 'SELECT COUNT(*) FROM room_members'), before.members);
  checkEqual(
    '旧配对不自动成为已批准/已兑换',
    scalar<number>(db, "SELECT COUNT(*) FROM device_pairings WHERE status = 'pending'"),
    before.pairings,
  );

  checkEqual(
    '历史无主群仍无 owner 且未解散',
    scalar<string>(
      db,
      `SELECT COALESCE(owner_id, 'NULL') || ':' || COALESCE(dissolved_at, 'NULL') FROM rooms WHERE room_id = '${OWNERLESS}'`,
    ),
    'NULL:NULL',
  );
  checkEqual('解散列初始为空', scalar<number>(db, 'SELECT COUNT(*) FROM rooms WHERE dissolved_at IS NOT NULL'), 0);

  expectCheckFailure('guard_owner_missing 拒绝 x=1', db, () => {
    db!.exec('INSERT INTO guard_owner_missing (x) VALUES (1)');
  });
  db.exec('INSERT INTO guard_owner_missing (x) VALUES (0)');
  expectCheckFailure('guard_room_dissolved 拒绝 x=1', db, () => {
    db!.exec('INSERT INTO guard_room_dissolved (x) VALUES (1)');
  });
  db.exec('INSERT INTO guard_room_dissolved (x) VALUES (0)');

  checkEqual('旧审计行保留', scalar<number>(db, 'SELECT COUNT(*) FROM room_management_audit'), before.audit);
  check(
    '重建后的审计表接受 room_dissolved',
    (() => {
      try {
        db!
          .prepare(
            `INSERT INTO room_management_audit
               (audit_id, room_id, action, target_actor_id, previous_role, new_role,
                previous_status, new_status, expected_revision, resulting_revision,
                changed_by, request_id, detail_json, created_at)
             VALUES ('rma_q01_dissolved', '${ROOM}', 'room_dissolved', NULL, NULL, NULL,
                     NULL, NULL, NULL, 2, '${HUMAN}', 'req_q01_dissolved', '{}', ${AT})`,
          )
          .run();
        return true;
      } catch {
        return false;
      }
    })(),
  );

  checkEqual(
    '任务历史可读',
    scalar<string>(db, `SELECT status || ':' || revision FROM tasks WHERE task_id = '${TASK}'`),
    'in_progress:3',
  );
  checkEqual(
    'assignment/transfer/submission/review 可读',
    scalar<number>(
      db,
      `SELECT (SELECT COUNT(*) FROM task_assignments WHERE assignment_id = '${ASSIGNMENT}')
            + (SELECT COUNT(*) FROM task_transfers WHERE transfer_id = '${TRANSFER}')
            + (SELECT COUNT(*) FROM task_submissions WHERE submission_id = '${SUBMISSION}')
            + (SELECT COUNT(*) FROM task_reviews WHERE review_id = '${REVIEW}')`,
    ),
    4,
  );
  checkEqual(
    '交接包/催办/外部动作可读',
    scalar<number>(
      db,
      `SELECT (SELECT COUNT(*) FROM task_handoff_packs WHERE pack_id = '${PACK}')
            + (SELECT COUNT(*) FROM task_reminders WHERE reminder_id = 'trm_q01_legacy')
            + (SELECT COUNT(*) FROM task_external_actions WHERE action_id = 'act_q01_legacy')`,
    ),
    3,
  );
  checkEqual(
    'A06 管理权交接历史可读',
    scalar<string>(
      db,
      "SELECT status || ':' || agent_id FROM agent_management_transfers WHERE transfer_id = 'amt_q01_legacy'",
    ),
    `pending:${AGENT}`,
  );
  checkEqual(
    'Q02 旧配对挑战可读',
    scalar<string>(db, "SELECT status || ':' || device_label FROM device_pairings WHERE pairing_id = 'dpq_q01_legacy'"),
    'pending:',
  );

  console.log(`Q01 升级检查通过: ${checksPassed()} 项`);
} finally {
  db?.close();
  rmSync(root, { recursive: true, force: true });
}
