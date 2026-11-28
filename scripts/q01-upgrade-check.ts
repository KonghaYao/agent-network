/**
 * Q01-T03：旧基线数据库升级检查。
 *
 * 用真实 migrations 构造停在 `0035_task_recovery.sql` 的合成库，写入
 * credentials/devices、无主群与 A06 的关键历史行，再顺序应用
 * `0036`–`0053`。检查重点是“升级不扩大权限”：旧凭据只回填设备行、不新增
 * credentials；无主群不被自动解散或回填 owner；审计表重建保留旧行；
 * 0042 删除旧任务表/列后普通业务行仍可读；0043 只把存量群回填为 full；
 * 0044 只把未删除文件回填为 public；0045/0046 只新增 Memory 表与索引；
 * 0047 回填消息 FTS 索引且重复执行不重复写入；0048 只增加 Task 完成两列；
 * 0049 只新增全局排序索引（仅加速读路径）；0050 只增加可空头像 file_id；
 * 0051 新增置顶表/闸门并重建审计 CHECK，保留全部旧审计行；0052 新增
 * Task Focus 的 8 张表与 2 个闸门，不修改 messages；0053 删除消息式 Task
 * 的列/索引/闸门/事件与 Memory task_* 来源，普通消息与 Focus 表不变。
 *
 * 运行：`bun scripts/q01-upgrade-check.ts`
 * 该脚本使用临时目录，不访问服务端、不读取或写入 `.data`。
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
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
  '0041_message_task_trace.sql',
  '0042_drop_legacy_tasks.sql',
  '0043_group_history_full_backfill.sql',
  '0044_files_public_backfill.sql',
  '0045_memory_ledger.sql',
  '0046_memory_experience_catchup.sql',
  '0047_message_search_fts.sql',
  '0048_message_task_completion.sql',
  '0049_message_global_order_index.sql',
  '0050_actor_avatar.sql',
  '0051_group_message_moderation.sql',
  '0052_focus_kanban.sql',
  '0053_drop_message_tasks.sql',
];
const AT = 1_700_000_000_000;

const HUMAN = 'usr_q01_owner';
const PEER = 'usr_q01_peer';
const AGENT = 'agt_q01_agent';
const ROOM = 'rm_q01_group';
const OWNERLESS = 'rm_q01_ownerless';
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

    INSERT INTO messages
      (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
       preview, reply_to, root_id, hop, root_invocations_used, created_at)
    VALUES
      ('msg_q01_legacy', '${ROOM}', '${HUMAN}', 'cli_q01_legacy', 1,
       'Q01 旧消息 可搜索关键词', 32, 'Q01 旧消息', NULL, NULL, 0, 0, ${AT});

    INSERT INTO room_management_audit
      (audit_id, room_id, action, target_actor_id, previous_role, new_role,
       previous_status, new_status, expected_revision, resulting_revision,
       changed_by, request_id, detail_json, created_at)
    VALUES
      ('rma_q01_legacy', '${ROOM}', 'member_added', '${PEER}', NULL, 'member',
       NULL, 'active', NULL, 1, '${HUMAN}', 'req_q01_legacy', '{}', ${AT});

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

/**
 * 0053 定向升级：真实业务库已运行到 0052，messages 仍带 task_* 列。
 * 先写入带任务字段的两条消息与任务派生数据，再应用 0053，核对普通消息、
 * 引用链与 delivery 相关历史不变，任务残留全部清空。
 */
function runTaskDropUpgrade(root: string): void {
  const preDir = join(root, 'migrations-0052');
  mkdirSync(preDir, { recursive: true });
  for (const name of readdirSync(SOURCE_MIGRATIONS)) {
    if (!name.endsWith('.sql') || name >= '0053') continue;
    copyFileSync(join(SOURCE_MIGRATIONS, name), join(preDir, name));
  }
  const db = new Database(join(root, 'pre-0053.sqlite'), { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  try {
    migrate(db, preDir);
    const at = AT + 10_000;
    db.prepare(
      `INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
         inbox_min_seq, pending_count, created_at, updated_at)
       VALUES (?, 'human', NULL, 'Q01 Task Owner', '{}', 0, 0, 0, ?, ?),
              (?, 'agent', 'ags_q01_task', 'Q01 Task Agent', '{}', 0, 0, 0, ?, ?)`,
    ).run(HUMAN, at, at, AGENT, at, at);
    db.prepare(
      `INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq,
         events_min_seq, member_seq, last_message_id, created_at, updated_at)
       VALUES (?, 'group', ?, 'Q01 Task 升级群', NULL, 0, 0, 2, NULL, ?, ?)`,
    ).run(ROOM, HUMAN, at, at);
    db.prepare(
      `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq,
         joined_at, role_revision, updated_at)
       VALUES (?, ?, 'owner', 'active', 0, 0, ?, 1, ?), (?, ?, 'member', 'active', 0, 0, ?, 1, ?)`,
    ).run(ROOM, HUMAN, at, at, ROOM, AGENT, at, at);
    const insertMessage = db.prepare(
      `INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq,
         body, body_bytes, preview, reply_to, root_id, hop, root_invocations_used, created_at,
         task_root_id, task_marked_by, task_marked_at, task_completed_at, task_completed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    );
    insertMessage.run('msg_task_root', ROOM, HUMAN, 'cm_task_root', 1, '任务起点正文', 18,
      '任务起点', null, null, 0, at, 'msg_task_root', HUMAN, at, at, HUMAN);
    insertMessage.run('msg_task_reply', ROOM, AGENT, 'cm_task_reply', 2, '任务回复正文', 18,
      '任务回复', 'msg_task_root', 'msg_task_root', 1, at, 'msg_task_root', null, null, null, null);
    const insertEvent = db.prepare(
      `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
       VALUES ('room', ?, ?, ?, ?, ?, ?)`,
    );
    insertEvent.run(ROOM, 'message_created', 'msg_task_root',
      '{"sender_id":"' + HUMAN + '","task_root_id":"msg_task_root"}', 'message:msg_task_root', at);
    insertEvent.run(ROOM, 'message_created', 'msg_task_reply',
      '{"sender_id":"' + AGENT + '","task_root_id":"msg_task_root"}', 'message:msg_task_reply', at);
    insertEvent.run(ROOM, 'message_task_marked', 'msg_task_root',
      '{"task_root_id":"msg_task_root","changed_by":"' + HUMAN + '"}', 'task_mark:msg_task_root', at);
    insertEvent.run(ROOM, 'message_task_completed', 'msg_task_root',
      '{"task_root_id":"msg_task_root"}', 'task_complete:msg_task_root', at);
    db.prepare(
      `INSERT INTO outbox (outbox_id, topic, event_seq, status, attempts, next_attempt_at, created_at)
       SELECT 'ob_task_' || event_seq, 'room:' || scope_id, event_seq, 'pending', 0, ?, ?
         FROM events`,
    ).run(at, at);
    const insertOperation = db.prepare(
      `INSERT INTO operations (actor_id, request_id, payload_hash, write_nonce, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertOperation.run(HUMAN, 'req_task_mark', 'h1', 'n1',
      `{"room_id":"${ROOM}","message_id":"msg_task_root","task_root_id":"msg_task_root","marked":true}`, at);
    insertOperation.run(HUMAN, 'req_task_complete', 'h2', 'n2',
      `{"room_id":"${ROOM}","root_message_id":"msg_task_root","status":"completed","completed_at":"${at}","completed_by":"${HUMAN}"}`, at);
    insertOperation.run(HUMAN, 'req_plain_send', 'h3', 'n3',
      '{"message_id":"msg_task_root","seq":"1","delivery_ids":[]}', at);
    db.prepare(
      `INSERT INTO memory_instances (instance_id, capture_default, created_at, updated_at)
       VALUES ('mi_q01_task', 'enabled', ?, ?)`,
    ).run(at, at);
    db.prepare(
      `INSERT INTO memory_spaces (space_id, instance_id, agent_actor_id, owner_actor_id,
         ownership_kind, ownership_epoch, capture, active, created_at, updated_at)
       VALUES ('sp_q01_task', 'mi_q01_task', ?, ?, 'managed', 1, 'pending', 1, ?, ?)`,
    ).run(AGENT, HUMAN, at, at);
    const insertSource = db.prepare(
      `INSERT INTO memory_sources (source_id, instance_id, source_key, source_kind,
         business_ref_kind, business_ref_json, origin_created_at, revision, state,
         content_text, content_sha256, content_bytes, created_at, updated_at)
       VALUES (?, 'mi_q01_task', ?, ?, ?, '{}', ?, 1, 'active', ?, 'sha', 4, ?, ?)`,
    );
    insertSource.run('msrc_q01_offer', 'task_offer:msg_task_root', 'task_offer', 'task', at, null, at, at);
    insertSource.run('msrc_q01_detail', 'task_detail:msg_task_root', 'task_detail', 'task', at, null, at, at);
    insertSource.run('msrc_q01_handoff', 'task_handoff:msg_task_root', 'task_handoff', 'task', at, null, at, at);
    insertSource.run('msrc_q01_message', 'message:msg_task_root', 'message', 'message', at, '正文', at, at);
    // 有 representation 引用的 task_* 来源必须保留并置 retracted，不能物理删除。
    db.prepare(
      `INSERT INTO memory_representations (representation_id, instance_id, kind, source_id,
         source_revision, text, text_bytes, text_sha256, verbatim, created_at)
       VALUES ('mrep_q01_handoff', 'mi_q01_task', 'raw_full', 'msrc_q01_handoff', 1, '正文', 4,
         'sha_q01', 1, ?)`,
    ).run(at);
    const insertRecall = db.prepare(
      `INSERT INTO memory_recall_requests (recall_id, space_id, ownership_epoch, agent_actor_id,
         request_key, mode, dispatch, status, target_json, warmup_only, created_at, updated_at, expires_at)
       VALUES (?, 'sp_q01_task', 1, ?, ?, ?, 'auto', 'pending', ?, 1, ?, ?, ?)`,
    );
    insertRecall.run('mrc_q01_offer', AGENT, 'auto:task_offer:msg_task_root', 'task',
      '{"kind":"message","task_root_id":"msg_task_root"}', at, at, at);
    insertRecall.run('mrc_q01_message', AGENT, 'auto:message:msg_task_root', 'related',
      '{"kind":"message","task_root_id":"msg_task_root"}', at, at, at);
    db.prepare(
      `INSERT INTO memory_tombstones (tombstone_id, instance_id, target_kind, target_id,
         source_key, reason, created_at)
       VALUES ('mtb_q01_task', 'mi_q01_task', 'source_key', 'task_offer:msg_task_root',
         'task_offer:msg_task_root', 'recall', ?)`,
    ).run(at);

    const applied = migrate(db, SOURCE_MIGRATIONS);
    checkEqual('停在 0052 的库只应用 0053', applied.join(','), '0053_drop_message_tasks.sql');
    const columns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    check('0053 定向升级后无 task_* 列', !columns.some((name) => name.startsWith('task_')));
    const messageRows = db
      .prepare(
        `SELECT message_id, body, reply_to, root_id, hop FROM messages ORDER BY created_seq`,
      )
      .all() as Array<{
      message_id: string;
      body: string;
      reply_to: string | null;
      root_id: string | null;
      hop: number;
    }>;
    checkEqual(
      '0053 保留普通消息与引用链',
      messageRows
        .map((row) => `${row.message_id}:${row.body}:${row.reply_to}:${row.root_id}:${row.hop}`)
        .join('|'),
      'msg_task_root:任务起点正文:null:null:0|msg_task_reply:任务回复正文:msg_task_root:msg_task_root:1',
    );
    const events = db
      .prepare('SELECT event_type, metadata FROM events ORDER BY event_seq')
      .all() as Array<{ event_type: string; metadata: string }>;
    checkEqual(
      '0053 只保留两条普通消息事件',
      events.map((row) => row.event_type).join(','),
      'message_created,message_created',
    );
    check(
      '0053 清除 message_created 的 task_root_id',
      events.every((row) => !row.metadata.includes('task_root_id')),
      events.map((row) => row.metadata),
    );
    checkEqual('0053 清除任务事件 outbox', scalar<number>(db, 'SELECT COUNT(*) FROM outbox'), 2);
    checkEqual(
      '0053 只保留普通 operations',
      (
        db.prepare('SELECT request_id FROM operations ORDER BY request_id').all() as Array<{
          request_id: string;
        }>
      )
        .map((row) => row.request_id)
        .join(','),
      'req_plain_send',
    );
    checkEqual(
      '0053 删除无引用的 task_* Memory 来源并保留 message 来源',
      (
        db.prepare('SELECT source_key FROM memory_sources ORDER BY source_key').all() as Array<{
          source_key: string;
        }>
      )
        .map((row) => row.source_key)
        .join(','),
      'message:msg_task_root,task_handoff:msg_task_root',
    );
    checkEqual(
      '0053 有引用的 task_* 来源置 retracted',
      scalar<string>(
        db,
        "SELECT state FROM memory_sources WHERE source_key = 'task_handoff:msg_task_root'",
      ),
      'retracted',
    );
    const recall = db
      .prepare('SELECT request_key, target_json FROM memory_recall_requests ORDER BY request_key')
      .all() as Array<{ request_key: string; target_json: string }>;
    checkEqual(
      '0053 只保留 message 预热且移除 task_root_id',
      recall.map((row) => row.request_key).join(','),
      'auto:message:msg_task_root',
    );
    check(
      '0053 移除预热 target_json 的任务字段',
      recall.every((row) => !row.target_json.includes('task_root_id')),
      recall.map((row) => row.target_json),
    );
    checkEqual(
      '0053 不删除永久 tombstone',
      scalar<number>(db, 'SELECT COUNT(*) FROM memory_tombstones'),
      1,
    );
    checkEqual('0053 定向升级 integrity_check=ok', scalar<string>(db, 'PRAGMA integrity_check'), 'ok');
    checkEqual('0053 定向升级 foreign_key_check 无违规', rows(db, 'PRAGMA foreign_key_check').length, 0);
  } finally {
    db.close();
  }
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
  checkEqual('恰好应用 0036–0053', appliedNow.join(','), NEW_MIGRATIONS.join(','));
  const expectedMigrations = [
    ...Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, '0')),
    ...Array.from({ length: 37 }, (_, i) => String(i + 17).padStart(4, '0')),
  ];
  const actualMigrations = (
    db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>
  ).map((row) => row.name);
  checkEqual('迁移总数为 49', actualMigrations.length, 49);
  check(
    '迁移序号为 0001–0012、0017–0053',
    actualMigrations.every((name, i) => name.startsWith(`${expectedMigrations[i]}_`)),
    actualMigrations,
  );
  const messageColumns = (
    db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
  ).map((column) => column.name);
  check(
    '0053 删除 messages 全部 task_* 列',
    !messageColumns.some((name) => name.startsWith('task_')),
    messageColumns,
  );
  const sqliteMasterCount = (type: string, pattern: string): number =>
    scalar<number>(
      db!,
      `SELECT COUNT(*) FROM sqlite_master WHERE type = '${type}' AND name LIKE '${pattern}' ESCAPE '\\'`,
    );
  checkEqual('0053 删除 idx_messages_task_root', sqliteMasterCount('index', 'idx\\_messages\\_task\\_root'), 0);
  checkEqual('0053 删除 guard_task_mark_*', sqliteMasterCount('table', 'guard\\_task\\_mark\\_%'), 0);
  checkEqual(
    '0053 不残留旧任务表',
    sqliteMasterCount('table', 'task\\_%') + sqliteMasterCount('table', 'room\\_task\\_%'),
    0,
  );
  checkEqual('0053 不删除 Focus 表', sqliteMasterCount('table', 'focus\\_%'), 8);
  const actorColumns = db.prepare('PRAGMA table_info(actors)').all() as Array<{
    name: string;
  }>;
  check(
    '0050 增加可空 avatar_file_id 且旧身份无头像',
    actorColumns.some((column) => column.name === 'avatar_file_id') &&
      scalar<number>(db, 'SELECT COUNT(*) FROM actors WHERE avatar_file_id IS NOT NULL') === 0,
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
  check(
    '0051 重建后的审计表接受 message_pinned',
    (() => {
      try {
        db!
          .prepare(
            `INSERT INTO room_management_audit
               (audit_id, room_id, action, target_actor_id, previous_role, new_role,
                previous_status, new_status, expected_revision, resulting_revision,
                changed_by, request_id, detail_json, created_at)
             VALUES ('rma_q01_pinned', '${ROOM}', 'message_pinned', NULL, NULL, NULL,
                     NULL, NULL, NULL, 0, '${HUMAN}', 'req_q01_pinned',
                     '{"message_id":"msg_q01_legacy"}', ${AT})`,
          )
          .run();
        return true;
      } catch {
        return false;
      }
    })(),
  );
  expectCheckFailure('审计仍拒绝未知 action', db, () => {
    db!.exec(
      `INSERT INTO room_management_audit
         (audit_id, room_id, action, resulting_revision, changed_by, request_id, created_at)
       VALUES ('rma_q01_unknown', '${ROOM}', 'message_edited', 0, '${HUMAN}', 'req_q01_unknown', ${AT})`,
    );
  });
  checkEqual(
    '0051 建立 room_pinned_messages',
    scalar<number>(
      db,
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'room_pinned_messages'",
    ),
    1,
  );
  expectCheckFailure('room_pinned_messages 拒绝第 4 个 slot', db, () => {
    db!.exec(
      `INSERT INTO room_pinned_messages (room_id, message_id, slot, pinned_by, pinned_at)
       VALUES ('${ROOM}', 'msg_q01_legacy', 4, '${HUMAN}', ${AT})`,
    );
  });
  expectCheckFailure('guard_room_message_pin_limit 拒绝 x=1', db, () => {
    db!.exec('INSERT INTO guard_room_message_pin_limit (x) VALUES (1)');
  });
  expectCheckFailure('guard_message_recalled 拒绝 x=1', db, () => {
    db!.exec('INSERT INTO guard_message_recalled (x) VALUES (1)');
  });
  expectCheckFailure('guard_room_message_unavailable 拒绝 x=1', db, () => {
    db!.exec('INSERT INTO guard_room_message_unavailable (x) VALUES (1)');
  });
  checkEqual(
    '升级后旧审计行仍保留',
    scalar<number>(
      db,
      "SELECT COUNT(*) FROM room_management_audit WHERE audit_id = 'rma_q01_legacy'",
    ),
    1,
  );

  for (const table of [
    'room_tasks',
    'tasks',
    'task_assignments',
    'task_transfers',
    'task_submissions',
    'task_reviews',
    'task_deliveries',
    'task_cards',
    'task_attachments',
    'task_progress',
    'task_reminders',
    'task_external_actions',
    'task_handoff_packs',
    'task_handoff_pack_items',
    'task_handoff_context_requests',
  ]) {
    checkEqual(
      `0042 删除旧任务表 ${table}`,
      scalar<number>(
        db,
        `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
      ),
      0,
    );
  }
  check(
    '0042 删除 artifacts.task_id',
    !(db.prepare('PRAGMA table_info(artifacts)').all() as Array<{ name: string }>).some(
      (column) => column.name === 'task_id',
    ),
  );
  check(
    '0042 删除 rooms.member_task_policy',
    !(db.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>).some(
      (column) => column.name === 'member_task_policy',
    ),
  );
  checkEqual('升级后普通 rooms 行数保持', scalar<number>(db, 'SELECT COUNT(*) FROM rooms'), 2);
  checkEqual(
    '0043 把存量群回填为 full',
    scalar<number>(
      db,
      "SELECT COUNT(*) FROM rooms WHERE kind = 'group' AND member_history_policy = 'full'",
    ),
    2,
  );
  checkEqual(
    '0043 递增存量群 policy_revision',
    scalar<string>(
      db,
      "SELECT group_concat(policy_revision, ',') FROM (SELECT policy_revision FROM rooms ORDER BY room_id)",
    ),
    '2,2',
  );
  checkEqual(
    '0043 不修改 updated_at',
    scalar<number>(db, `SELECT COUNT(*) FROM rooms WHERE updated_at <> ${AT}`),
    0,
  );
  checkEqual('升级后普通 actors 行数保持', scalar<number>(db, 'SELECT COUNT(*) FROM actors'), before.actors);
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

  checkEqual(
    '0047 建立消息 FTS 表',
    scalar<number>(
      db,
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'message_search_fts'",
    ),
    1,
  );
  checkEqual(
    '0047 建立三个同步触发器',
    scalar<number>(
      db,
      "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('message_search_fts_ai', 'message_search_fts_ad', 'message_search_fts_au')",
    ),
    3,
  );
  checkEqual('0047 回填存量消息', scalar<number>(db, 'SELECT COUNT(*) FROM message_search_fts'), 1);
  checkEqual(
    '0047 回填消息可搜索',
    scalar<number>(
      db,
      "SELECT COUNT(*) FROM message_search_fts WHERE message_search_fts MATCH '\"可搜索\"'",
    ),
    1,
  );
  db.exec(readFileSync(join(SOURCE_MIGRATIONS, '0047_message_search_fts.sql'), 'utf8'));
  checkEqual('0047 重复执行不重复回填', scalar<number>(db, 'SELECT COUNT(*) FROM message_search_fts'), 1);
  db.exec("UPDATE messages SET body = 'Q01 旧消息 已更新索引' WHERE message_id = 'msg_q01_legacy'");
  checkEqual(
    '0047 update 移除旧词',
    scalar<number>(
      db,
      "SELECT COUNT(*) FROM message_search_fts WHERE message_search_fts MATCH '\"可搜索\"'",
    ),
    0,
  );
  checkEqual(
    '0047 update 写入新词',
    scalar<number>(
      db,
      "SELECT COUNT(*) FROM message_search_fts WHERE message_search_fts MATCH '\"已更新\"'",
    ),
    1,
  );
  db.exec("DELETE FROM messages WHERE message_id = 'msg_q01_legacy'");
  checkEqual('0047 delete 移除索引', scalar<number>(db, 'SELECT COUNT(*) FROM message_search_fts'), 0);

  runTaskDropUpgrade(root);

  const fresh = new Database(':memory:');
  migrate(fresh, SOURCE_MIGRATIONS);
  try {
    const freshColumns = (
      fresh.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    checkEqual('空库与升级库 messages 列一致', freshColumns.join(','), messageColumns.join(','));
    const indexNames = (target: Database): string =>
      (
        target
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' ORDER BY name",
          )
          .all() as Array<{ name: string }>
      )
        .map((row) => row.name)
        .join(',');
    checkEqual('空库与升级库 messages 索引一致', indexNames(fresh), indexNames(db));
  } finally {
    fresh.close();
  }

  console.log(`Q01 升级检查通过: ${checksPassed()} 项`);
} finally {
  db?.close();
  rmSync(root, { recursive: true, force: true });
}
