/**
 * MF05 验收：业务写入同批登记 Memory 来源、撤回屏障与预热资格。
 *
 * 覆盖：
 * - 消息/任务 offer/文件来源与业务写入同批提交，字段（digest、作者、origin
 *   scope、成员代次、策略版本、历史边界、来源序号）正确；
 * - Memory SQL 失败时消息事务整体回滚；
 * - 同一业务请求重放不重复写来源或预热；
 * - MEMORY_ENABLED/MEMORY_CAPTURE 未启用时不产生来源或预热，行为不变；
 * - 撤回/文件删除在 capture 关闭时仍写永久屏障；
 * - 业务路径不产生经历、retain 或摘要/curated。
 *
 * 运行：bun run test:memory-intake
 */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import type { MessageSendInput } from '../src/contracts/schemas';
import { messageRecall } from '../src/domain/message-recall';
import { messageSend } from '../src/domain/messages';
import { messageTaskMark, messageTaskUnmark } from '../src/domain/message-tasks';
import type { Principal } from '../src/domain/principal';
import {
  roomFileBind,
  roomFileDelete,
  type RoomFileSource,
} from '../src/domain/room-files';
import { ensureMemoryInstance } from '../src/memory/access';
import type { MemoryIntakeOptions } from '../src/memory/intake';
import { ensureSpaceForAgent } from '../src/memory/store';
import { sha256Hex } from '../src/storage/db';
import type { ActorRow, MessageRow } from '../src/storage/rows';
import { check, checkEqual, CheckFailure } from './lib/harness';

const MIGRATIONS = join(import.meta.dir, '../migrations');
const AT = Date.now();
const INSTANCE = 'mni_intake';
const HUMAN = 'usr_mi_human';
const AGENT = 'agt_mi_agent';
const ROOM = 'rm_mi_group';
const POLICY_REVISION = 7;
const MEMBER_GENERATION = 4;
const JOINED_SEQ = 3;
const JOINED_AT = AT - 1_000;
const ORIGIN = 'http://127.0.0.1:8792';
const SECRET = 'intake-test-secret';

interface World {
  db: Database;
  d1: D1Database;
  memory: MemoryIntakeOptions;
  human: Principal;
  agentSpaceId: string;
}

async function openWorld(): Promise<World> {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  db.prepare(
    `INSERT INTO actors
       (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
        pending_count, created_at, updated_at)
     VALUES (?, 'human', NULL, 'Intake Human', '{}', 0, 0, 0, ?, ?)`,
  ).run(HUMAN, AT, AT);
  db.prepare(
    `INSERT INTO actors
       (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
        pending_count, created_at, updated_at)
     VALUES (?, 'agent', 'sess_intake_agent', 'Intake Agent', '{}', 0, 0, 0, ?, ?)`,
  ).run(AGENT, AT, AT);
  db.prepare(
    `INSERT INTO rooms
       (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
        member_seq, last_message_id, created_at, updated_at, policy_revision,
        member_history_policy)
     VALUES (?, 'group', ?, 'Intake Group', NULL, 0, 0, 2, NULL, ?, ?, ?, 'full')`,
  ).run(ROOM, HUMAN, AT, AT, POLICY_REVISION);
  db.prepare(
    `INSERT INTO room_members
       (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
        member_generation, role_revision, updated_at)
     VALUES (?, ?, 'owner', 'active', ?, 0, ?, ?, 1, ?)`,
  ).run(ROOM, HUMAN, JOINED_SEQ, JOINED_AT, MEMBER_GENERATION, AT);
  db.prepare(
    `INSERT INTO room_members
       (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
        member_generation, role_revision, updated_at)
     VALUES (?, ?, 'member', 'active', ?, 0, ?, ?, 1, ?)`,
  ).run(ROOM, AGENT, JOINED_SEQ, JOINED_AT, MEMBER_GENERATION, AT);

  const d1 = createD1(db);
  const instanceId = await ensureMemoryInstance(d1, {
    configuredId: INSTANCE,
    now: AT,
    captureDefault: 'enabled',
  });
  const space = await ensureSpaceForAgent(d1, {
    instanceId,
    agentId: AGENT,
    capture: 'pending',
    now: AT,
  });
  const humanRow = db
    .prepare('SELECT * FROM actors WHERE actor_id = ?')
    .get(HUMAN) as ActorRow;
  return {
    db,
    d1,
    memory: { instanceId, capture: true },
    human: { credentialHash: `hash_${HUMAN}`, actor: humanRow, credential: null },
    agentSpaceId: space.space_id,
  };
}

function getMessageRow(env: World, messageId: string): MessageRow {
  const row = env.db
    .prepare('SELECT * FROM messages WHERE message_id = ?')
    .get(messageId) as MessageRow | null;
  if (!row) throw new Error(`缺少消息 ${messageId}`);
  return row;
}

function sources(env: World, sourceKey: string): Array<{
  source_id: string;
  source_kind: string;
  source_key: string;
  business_ref_kind: string;
  business_ref_json: string;
  origin_room_id: string;
  origin_member_generation: number;
  origin_policy_revision: number;
  origin_joined_seq: number;
  origin_joined_at: number;
  origin_archive_head_seq: number | null;
  origin_seq: number | null;
  origin_created_at: number;
  author_actor_id: string | null;
  state: string;
  revision: number;
  content_text: string | null;
  content_sha256: string | null;
  content_bytes: number | null;
}> {
  return env.db
    .prepare(
      `SELECT * FROM memory_sources
        WHERE instance_id = ? AND source_key = ?
        ORDER BY revision`,
    )
    .all(env.memory.instanceId, sourceKey) as never;
}

function warmups(env: World, requestKey: string): Array<{
  recall_id: string;
  space_id: string;
  agent_actor_id: string;
  request_key: string;
  mode: string;
  dispatch: string;
  status: string;
  target_json: string;
  warmup_only: number;
}> {
  return env.db
    .prepare(
      `SELECT r.* FROM memory_recall_requests r
        WHERE r.request_key = ?`,
    )
    .all(requestKey) as never;
}

function count(env: World, sql: string, ...binds: string[]): number {
  return (env.db.prepare(sql).get(...binds) as { n: number }).n;
}

function first<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (!row) throw new CheckFailure(label, '缺少预期的行');
  return row;
}

async function messageCases(): Promise<void> {
  const env = await openWorld();
  const body = 'MF05 来源 body 中文';
  const sent = await messageSend(
    env.d1,
    env.human,
    {
      request_id: 'req_intake_send',
      client_message_id: 'cmid_intake_send',
      room_id: ROOM,
      body,
      invoke: [AGENT],
    },
    env.memory,
  );
  const message = getMessageRow(env, sent.message.message_id);
  const messageKey = `message:${message.message_id}`;
  const source = first(sources(env, messageKey), '[MF05-01] 消息来源');
  check('[MF05-01] 消息来源与消息同批提交', source !== undefined);
  checkEqual('[MF05-01] source_kind=message', source.source_kind, 'message');
  checkEqual('[MF05-01] 作者来自真实 sender', source.author_actor_id, HUMAN);
  checkEqual('[MF05-01] origin room', source.origin_room_id, ROOM);
  checkEqual(
    '[MF05-01] origin member generation 取写入快照',
    source.origin_member_generation,
    MEMBER_GENERATION,
  );
  checkEqual(
    '[MF05-01] origin policy revision 取写入快照',
    source.origin_policy_revision,
    POLICY_REVISION,
  );
  checkEqual('[MF05-01] origin joined seq', source.origin_joined_seq, JOINED_SEQ);
  checkEqual('[MF05-01] origin joined at', source.origin_joined_at, JOINED_AT);
  checkEqual('[MF05-01] 未解散房间无归档上界', source.origin_archive_head_seq, null);
  checkEqual('[MF05-01] origin seq 等于消息 created_seq', source.origin_seq, message.created_seq);
  checkEqual(
    '[MF05-01] digest 等于正文 sha256',
    source.content_sha256,
    await sha256Hex(body),
  );
  checkEqual(
    '[MF05-01] bytes 等于正文 UTF-8 长度',
    source.content_bytes,
    new TextEncoder().encode(body).length,
  );
  checkEqual('[MF05-01] 来源 revision 从 1 开始', source.revision, 1);
  checkEqual('[MF05-01] 来源 active', source.state, 'active');
  const businessRef = JSON.parse(source.business_ref_json) as {
    message_id: string;
    created_seq: number;
  };
  checkEqual('[MF05-01] business_ref message_id', businessRef.message_id, message.message_id);
  checkEqual(
    '[MF05-01] business_ref created_seq 与来源序号一致',
    businessRef.created_seq,
    message.created_seq,
  );

  const messageWarmups = warmups(env, `auto:message:${message.message_id}`);
  checkEqual('[MF05-02] 只为真实 delivery 生成预热', messageWarmups.length, 1);
  const messageWarmup = first(messageWarmups, '[MF05-02] 消息预热');
  const target = JSON.parse(messageWarmup.target_json) as {
    kind: string;
    message: {
      room_id: string;
      message_id: string;
      created_seq: number;
      delivery_id: string;
      recipient_id: string;
    };
    task_root_id: string | null;
  };
  checkEqual('[MF05-02] 预热 dispatch=auto', messageWarmup.dispatch, 'auto');
  checkEqual('[MF05-02] 预热仅准备不注入', messageWarmup.warmup_only, 1);
  checkEqual('[MF05-02] 预热目标为 message', target.kind, 'message');
  checkEqual('[MF05-02] 预热 target message_id', target.message.message_id, message.message_id);
  checkEqual('[MF05-02] 预热 target created_seq', target.message.created_seq, message.created_seq);
  checkEqual('[MF05-02] 预热 target recipient', target.message.recipient_id, AGENT);
  checkEqual('[MF05-02] 预热 target delivery', target.message.delivery_id, sent.delivery_ids[0]);
  checkEqual('[MF05-02] 预热 target room', target.message.room_id, ROOM);
  checkEqual('[MF05-02] 业务路径不产生经历', count(env, 'SELECT COUNT(*) AS n FROM memory_experiences'), 0);
  checkEqual(
    '[MF05-02] 业务路径不产生 retain 资格',
    count(env, 'SELECT COUNT(*) AS n FROM memory_retain_intents'),
    0,
  );
  checkEqual(
    '[MF05-02] 业务路径不生成摘要/curated',
    count(env, 'SELECT COUNT(*) AS n FROM memory_representations') +
      count(env, 'SELECT COUNT(*) AS n FROM memory_curated'),
    0,
  );
  env.db.close();
}

async function replayCases(): Promise<void> {
  const env = await openWorld();
  const input: MessageSendInput = {
    request_id: 'req_intake_replay',
    client_message_id: 'cmid_intake_replay',
    room_id: ROOM,
    body: 'replay once',
    invoke: [AGENT],
  };
  const first = await messageSend(env.d1, env.human, input, env.memory);
  const replay = await messageSend(env.d1, env.human, input, env.memory);
  checkEqual('[MF05-03] 同 request_id 重放返回同一消息', replay.message.message_id, first.message.message_id);
  const messageKey = `message:${first.message.message_id}`;
  checkEqual('[MF05-03] 重放不重复写来源', sources(env, messageKey).length, 1);
  checkEqual(
    '[MF05-03] 重放不重复写预热',
    warmups(env, `auto:message:${first.message.message_id}`).length,
    1,
  );

  // 不同 request_id、相同 client_message_id：消息唯一键收敛到原消息，不重跑 Memory。
  const reconciled = await messageSend(
    env.d1,
    env.human,
    { ...input, request_id: 'req_intake_replay_2' },
    env.memory,
  );
  checkEqual(
    '[MF05-03] client_message_id 重放返回原消息',
    reconciled.message.message_id,
    first.message.message_id,
  );
  checkEqual('[MF05-03] client_message_id 重放不重复写来源', sources(env, messageKey).length, 1);
  checkEqual(
    '[MF05-03] client_message_id 重放不重复写预热',
    warmups(env, `auto:message:${first.message.message_id}`).length,
    1,
  );
  env.db.close();
}

async function rollbackCases(): Promise<void> {
  const env = await openWorld();
  env.db.exec(`
    CREATE TRIGGER force_memory_failure
    BEFORE INSERT ON memory_sources
    BEGIN
      SELECT RAISE(ABORT, 'forced_memory_failure');
    END;
  `);
  let failed = false;
  try {
    await messageSend(
      env.d1,
      env.human,
      {
        request_id: 'req_intake_rollback',
        client_message_id: 'cmid_intake_rollback',
        room_id: ROOM,
        body: 'rollback body',
        invoke: [AGENT],
      },
      env.memory,
    );
  } catch {
    failed = true;
  }
  check('[MF05-04] Memory 写入失败使消息事务失败', failed);
  checkEqual(
    '[MF05-04] 消息整体回滚',
    count(env, 'SELECT COUNT(*) AS n FROM messages WHERE client_message_id = ?', 'cmid_intake_rollback'),
    0,
  );
  checkEqual(
    '[MF05-04] delivery 整体回滚',
    count(env, 'SELECT COUNT(*) AS n FROM deliveries'),
    0,
  );
  checkEqual(
    '[MF05-04] 预热整体回滚',
    count(env, 'SELECT COUNT(*) AS n FROM memory_recall_requests'),
    0,
  );
  checkEqual(
    '[MF05-04] operation 整体回滚',
    count(env, 'SELECT COUNT(*) AS n FROM operations WHERE request_id = ?', 'req_intake_rollback'),
    0,
  );
  env.db.exec('DROP TRIGGER force_memory_failure;');
  await messageSend(
    env.d1,
    env.human,
    {
      request_id: 'req_intake_rollback',
      client_message_id: 'cmid_intake_rollback',
      room_id: ROOM,
      body: 'rollback body',
      invoke: [AGENT],
    },
    env.memory,
  );
  checkEqual(
    '[MF05-04] 移除故障后同一请求可重新提交',
    count(env, 'SELECT COUNT(*) AS n FROM messages WHERE client_message_id = ?', 'cmid_intake_rollback'),
    1,
  );
  env.db.close();
}

async function disabledCases(): Promise<void> {
  const env = await openWorld();
  const noMemory = await messageSend(env.d1, env.human, {
    request_id: 'req_intake_off',
    client_message_id: 'cmid_intake_off',
    room_id: ROOM,
    body: 'memory off',
    invoke: [AGENT],
  });
  const offKey = `message:${noMemory.message.message_id}`;
  checkEqual('[MF05-05] 未启用 Memory 不写来源', sources(env, offKey).length, 0);
  checkEqual(
    '[MF05-05] 未启用 Memory 不写预热',
    warmups(env, `auto:message:${noMemory.message.message_id}`).length,
    0,
  );

  const captureOff = await messageSend(
    env.d1,
    env.human,
    {
      request_id: 'req_intake_capture_off',
      client_message_id: 'cmid_intake_capture_off',
      room_id: ROOM,
      body: 'capture off',
      invoke: [AGENT],
    },
    { ...env.memory, capture: false },
  );
  const offCaptureKey = `message:${captureOff.message.message_id}`;
  checkEqual('[MF05-05] MEMORY_CAPTURE=0 不新增来源', sources(env, offCaptureKey).length, 0);
  checkEqual(
    '[MF05-05] MEMORY_CAPTURE=0 不新增预热',
    warmups(env, `auto:message:${captureOff.message.message_id}`).length,
    0,
  );
  checkEqual(
    '[MF05-05] 业务消息仍正常提交',
    count(env, 'SELECT COUNT(*) AS n FROM messages WHERE message_id = ?', noMemory.message.message_id),
    1,
  );
  env.db.close();
}

async function recallCases(): Promise<void> {
  const env = await openWorld();
  const sent = await messageSend(
    env.d1,
    env.human,
    {
      request_id: 'req_intake_recall_send',
      client_message_id: 'cmid_intake_recall_send',
      room_id: ROOM,
      body: 'recall me',
    },
    env.memory,
  );
  const messageKey = `message:${sent.message.message_id}`;
  await messageRecall(
    env.d1,
    env.human,
    { request_id: 'req_intake_recall', message_id: sent.message.message_id },
    env.memory,
  );
  const source = first(sources(env, messageKey), '[MF05-06] 撤回消息来源');
  checkEqual('[MF05-06] 撤回使来源不可读', source.state, 'retracted');
  check('[MF05-06] 撤回记录 retracted_at', env.db.prepare(
    'SELECT retracted_at FROM memory_sources WHERE source_key = ?',
  ).get(messageKey) !== null);
  checkEqual(
    '[MF05-06] 撤回写 message 永久 tombstone',
    count(
      env,
      "SELECT COUNT(*) AS n FROM memory_tombstones WHERE source_key = ? AND reason = 'recall'",
      messageKey,
    ),
    1,
  );
  await messageRecall(
    env.d1,
    env.human,
    { request_id: 'req_intake_recall', message_id: sent.message.message_id },
    env.memory,
  );
  checkEqual(
    '[MF05-06] 撤回重放不重复 tombstone',
    count(
      env,
      "SELECT COUNT(*) AS n FROM memory_tombstones WHERE source_key = ? AND reason = 'recall'",
      messageKey,
    ),
    1,
  );

  // capture 关闭仍执行撤回屏障。
  const second = await messageSend(
    env.d1,
    env.human,
    {
      request_id: 'req_intake_recall_send_2',
      client_message_id: 'cmid_intake_recall_send_2',
      room_id: ROOM,
      body: 'capture off recall',
    },
    env.memory,
  );
  await messageRecall(
    env.d1,
    env.human,
    { request_id: 'req_intake_recall_2', message_id: second.message.message_id },
    { ...env.memory, capture: false },
  );
  checkEqual(
    '[MF05-06] capture 关闭仍撤回既有来源',
    first(sources(env, `message:${second.message.message_id}`), '[MF05-06] 撤回来源').state,
    'retracted',
  );
  env.db.close();
}

async function taskCases(): Promise<void> {
  const env = await openWorld();
  const sent = await messageSend(
    env.d1,
    env.human,
    {
      request_id: 'req_intake_task_send',
      client_message_id: 'cmid_intake_task_send',
      room_id: ROOM,
      body: 'task root body',
      invoke: [AGENT],
    },
    env.memory,
  );
  const messageId = sent.message.message_id;
  const taskKey = `task_offer:${messageId}`;
  await messageTaskMark(
    env.d1,
    env.human,
    { request_id: 'req_intake_mark', room_id: ROOM, message_id: messageId },
    env.memory,
  );
  const taskSource = first(sources(env, taskKey), '[MF05-07] task_offer 来源');
  check('[MF05-07] 任务标记写 task_offer 来源', taskSource !== undefined);
  checkEqual('[MF05-07] task_offer source_kind', taskSource.source_kind, 'task_offer');
  checkEqual('[MF05-07] task_offer 作者', taskSource.author_actor_id, HUMAN);
  checkEqual(
    '[MF05-07] task_offer 序号等于消息 created_seq',
    taskSource.origin_seq,
    getMessageRow(env, messageId).created_seq,
  );
  checkEqual(
    '[MF05-07] task_offer digest 等于正文',
    taskSource.content_sha256,
    await sha256Hex('task root body'),
  );
  checkEqual('[MF05-07] task_offer 不复制正文', taskSource.content_text, null);
  const taskRef = JSON.parse(taskSource.business_ref_json) as {
    task_id: string;
    revision: number;
    created_seq: number;
  };
  checkEqual('[MF05-07] task business_ref task_id', taskRef.task_id, messageId);
  checkEqual(
    '[MF05-07] task business_ref created_seq',
    taskRef.created_seq,
    getMessageRow(env, messageId).created_seq,
  );
  checkEqual(
    '[MF05-07] 正文由 message 来源持有',
    first(sources(env, `message:${messageId}`), '[MF05-07] 任务消息来源').content_text,
    'task root body',
  );
  const taskWarmups = warmups(env, `auto:task_offer:${messageId}`);
  checkEqual('[MF05-07] task_offer 预热覆盖真实 delivery', taskWarmups.length, 1);
  const taskWarmup = first(taskWarmups, '[MF05-07] 任务预热');
  checkEqual('[MF05-07] task_offer 预热 mode=task', taskWarmup.mode, 'task');
  const taskTarget = JSON.parse(taskWarmup.target_json) as {
    task_root_id: string;
    message: { message_id: string };
  };
  checkEqual('[MF05-07] 任务预热 target task_root_id', taskTarget.task_root_id, messageId);

  // 已是起点时重复标记：不制造新 revision 或新预热。
  await messageTaskMark(
    env.d1,
    env.human,
    { request_id: 'req_intake_mark_replay', room_id: ROOM, message_id: messageId },
    env.memory,
  );
  checkEqual('[MF05-07] 重复标记不新增 revision', sources(env, taskKey).length, 1);
  checkEqual(
    '[MF05-07] 重复标记不新增任务预热',
    warmups(env, `auto:task_offer:${messageId}`).length,
    1,
  );

  await messageTaskUnmark(
    env.d1,
    env.human,
    { request_id: 'req_intake_unmark', room_id: ROOM, message_id: messageId },
    env.memory,
  );
  checkEqual(
    '[MF05-08] 取消标记使 task_offer 不可读',
    first(sources(env, taskKey), '[MF05-08] 取消后的 task_offer').state,
    'retracted',
  );
  checkEqual(
    '[MF05-08] 取消标记不写永久 tombstone',
    count(env, "SELECT COUNT(*) AS n FROM memory_tombstones WHERE source_key = ?", taskKey),
    0,
  );
  await messageTaskMark(
    env.d1,
    env.human,
    { request_id: 'req_intake_remark', room_id: ROOM, message_id: messageId },
    env.memory,
  );
  const taskVersions = sources(env, taskKey);
  checkEqual('[MF05-08] 重新标记生成新 revision', taskVersions.length, 2);
  const remark = first(
    taskVersions.filter((row) => row.state === 'active'),
    '[MF05-08] 重新标记后的 active task_offer',
  );
  checkEqual('[MF05-08] 新 revision active', remark.state, 'active');
  checkEqual('[MF05-08] 新 revision 编号为 2', remark.revision, 2);
  env.db.close();
}

async function fileCases(): Promise<void> {
  const env = await openWorld();
  const fileId = 'f_intake_bind';
  const bytes = new TextEncoder().encode('file body');
  const digest = await sha256Hex('file body');
  const record = {
    fileId,
    name: 'intake.txt',
    mimeType: 'text/plain',
    size: bytes.length,
    sha256: digest,
    createdAt: new Date(AT).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ownerScope: `actor:${HUMAN}`,
  };
  const source: RoomFileSource = {
    async readFile(id) {
      return id === fileId ? record : null;
    },
  };
  await roomFileBind(
    env.d1,
    env.human,
    { request_id: 'req_intake_file_bind', room_id: ROOM, file_id: fileId },
    source,
    ORIGIN,
    SECRET,
    env.memory,
  );
  const fileKey = `file:${fileId}`;
  const fileSource = first(sources(env, fileKey), '[MF05-09] file 来源');
  check('[MF05-09] 文件绑定写 file 来源', fileSource !== undefined);
  checkEqual('[MF05-09] file source_kind', fileSource.source_kind, 'file');
  checkEqual('[MF05-09] file author 为上传者', fileSource.author_actor_id, HUMAN);
  checkEqual('[MF05-09] file digest 为 sha256', fileSource.content_sha256, digest);
  checkEqual('[MF05-09] file bytes 为文件大小', fileSource.content_bytes, bytes.length);
  checkEqual('[MF05-09] 文件来源不保存正文副本', fileSource.content_text, null);
  checkEqual('[MF05-09] file origin policy revision', fileSource.origin_policy_revision, POLICY_REVISION);
  const roomFile = env.db
    .prepare('SELECT room_file_id FROM room_files WHERE file_id = ?')
    .get(fileId) as { room_file_id: string };
  const bindEvent = env.db
    .prepare('SELECT event_seq FROM events WHERE event_key = ?')
    .get(`room_file:added:${roomFile.room_file_id}`) as { event_seq: number };
  checkEqual('[MF05-09] file origin seq 为绑定事件序号', fileSource.origin_seq, bindEvent.event_seq);
  const fileRef = JSON.parse(fileSource.business_ref_json) as { file_id: string; sha256: string };
  checkEqual('[MF05-09] file business_ref file_id', fileRef.file_id, fileId);
  checkEqual('[MF05-09] file business_ref sha256', fileRef.sha256, digest);

  await roomFileBind(
    env.d1,
    env.human,
    { request_id: 'req_intake_file_bind', room_id: ROOM, file_id: fileId },
    source,
    ORIGIN,
    SECRET,
    env.memory,
  );
  checkEqual('[MF05-09] 绑定重放不重复写来源', sources(env, fileKey).length, 1);

  await roomFileDelete(
    env.d1,
    env.human,
    { request_id: 'req_intake_file_delete', room_id: ROOM, file_id: fileId },
    env.memory,
  );
  checkEqual(
    '[MF05-10] 删除文件使来源不可读',
    first(sources(env, fileKey), '[MF05-10] 删除后的文件来源').state,
    'retracted',
  );
  checkEqual(
    '[MF05-10] 删除文件写永久 tombstone',
    count(
      env,
      "SELECT COUNT(*) AS n FROM memory_tombstones WHERE source_key = ? AND reason = 'file_deleted'",
      fileKey,
    ),
    1,
  );
  await roomFileDelete(
    env.d1,
    env.human,
    { request_id: 'req_intake_file_delete', room_id: ROOM, file_id: fileId },
    env.memory,
  );
  checkEqual(
    '[MF05-10] 删除重放不重复 tombstone',
    count(
      env,
      "SELECT COUNT(*) AS n FROM memory_tombstones WHERE source_key = ? AND reason = 'file_deleted'",
      fileKey,
    ),
    1,
  );
  env.db.close();
}

async function main(): Promise<void> {
  await messageCases();
  await replayCases();
  await rollbackCases();
  await disabledCases();
  await recallCases();
  await taskCases();
  await fileCases();
}

main()
  .then(() => {
    console.log('memory intake checks passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
