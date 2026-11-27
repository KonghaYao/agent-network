/**
 * Task Focus 后端核心验收（owner 工具 + 数据模型）。
 *
 * 使用内存 SQLite 与真实 migrations，不启动服务、不访问生产。覆盖：
 * 开启幂等与唯一秘书、暂停/恢复代次、owner 隔离、列表分页与筛选、
 * 证据失权遮蔽、归档幂等/版本冲突、Agent 拒绝，以及 focus_updated
 * 只写 actor scope 与 outbox、不改 inbox / 未读数 / head_seq。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { BusinessError } from '../src/contracts/errors';
import { FOCUS_UPDATED_EVENT } from '../src/contracts/events';
import type { FocusBindingRow, FocusItemRow } from '../src/domain/focus/types';
import { focusDisable, focusEnable, focusStatus } from '../src/domain/focus/bindings';
import { focusArchive, focusGet, focusList } from '../src/domain/focus/items';
import type { Principal } from '../src/domain/principal';
import type { Env } from '../src/env';
import { drainOutbox } from '../src/realtime/outbox';
import { getActor } from '../src/storage/queries';
import { check, checkEqual, CheckFailure, checksPassed } from './lib/harness';

const MIGRATIONS = join(import.meta.dir, '../migrations');
const AT = 1_760_000_000_000;

const OWNER = 'usr_focus_owner';
const OTHER = 'usr_focus_other';
const CONCURRENT = 'usr_focus_concurrent';
const AGENT = 'agt_focus_plain';
const ROOM_MAIN = 'rm_focus_main';
const ROOM_LEFT = 'rm_focus_left';

let db: Database;
let d1: D1Database;
let counter = 0;

function openSeededDb(): Database {
  const database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  migrate(database, MIGRATIONS);
  database.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${OWNER}', 'human', NULL, 'Focus Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${OTHER}', 'human', NULL, 'Focus Other', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${CONCURRENT}', 'human', NULL, 'Focus Concurrent', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT}', 'agent', 'sess_focus_plain', 'Focus Agent', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, head_seq, events_min_seq, member_seq, created_at, updated_at)
    VALUES
      ('${ROOM_MAIN}', 'group', '${OWNER}', 'Focus Main', 0, 0, 0, ${AT}, ${AT}),
      ('${ROOM_LEFT}', 'group', '${OWNER}', 'Focus Left', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
    VALUES
      ('${ROOM_MAIN}', '${OWNER}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${ROOM_MAIN}', '${AGENT}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${ROOM_LEFT}', '${OWNER}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT});
  `);
  return database;
}

async function principalFor(actor: string): Promise<Principal> {
  const row = await getActor(d1, actor);
  if (!row) throw new CheckFailure('seed', `缺少 actor: ${actor}`);
  return { credentialHash: `hash_${actor}`, actor: row, credential: null };
}

function scalar<T>(sql: string, ...binds: Array<string | number>): T {
  return db.prepare(sql).get(...binds) as T;
}

function count(sql: string, ...binds: Array<string | number>): number {
  return scalar<{ n: number }>(sql, ...binds).n;
}

function maxEventSeq(): number {
  return scalar<{ n: number }>('SELECT COALESCE(MAX(event_seq), 0) AS n FROM events').n;
}

function seedMessage(messageId: string, roomId: string, sender: string, body: string): void {
  counter += 1;
  db.prepare(
    `INSERT INTO messages
       (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
        preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    roomId,
    sender,
    `cm_${messageId}`,
    counter,
    body,
    new TextEncoder().encode(body).length,
    body.slice(0, 120),
    AT + counter,
  );
}

interface SeedItemOptions {
  itemId: string;
  owner?: string;
  secretary: string;
  column?: 'needs_me' | 'tracking' | 'done';
  title?: string;
  summary?: string;
  updatedAt?: number;
  archivedAt?: number | null;
  version?: number;
  /** 默认插入一条可读基础证据；失权/撤回场景由调用方自行插入。 */
  noEvidence?: boolean;
}

function seedItem(options: SeedItemOptions): void {
  db.prepare(
    `INSERT INTO focus_items
       (item_id, owner_actor_id, secretary_actor_id, title, column_key, next_step,
        waiting_on, due_at, due_text, summary, version, archived_at, archived_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.itemId,
    options.owner ?? OWNER,
    options.secretary,
    options.title ?? options.itemId,
    options.column ?? 'needs_me',
    options.summary ?? '',
    options.version ?? 1,
    options.archivedAt ?? null,
    options.archivedAt === null || options.archivedAt === undefined ? null : (options.owner ?? OWNER),
    AT,
    options.updatedAt ?? AT,
  );
  if (options.noEvidence !== true) {
    seedEvidence(
      `fev_${options.itemId}_base`,
      options.itemId,
      options.owner ?? OWNER,
      'msg_focus_base',
      ROOM_MAIN,
    );
  }
}

function seedEvidence(
  evidenceId: string,
  itemId: string,
  owner: string,
  messageId: string,
  roomId: string,
  purpose = 'source',
  sourceKind: 'message' | 'delivery' = 'message',
): void {
  db.prepare(
    `INSERT INTO focus_evidence
       (evidence_id, item_id, owner_actor_id, source_kind, source_key, room_id, message_id,
        delivery_id, source_revision, purpose, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
  ).run(
    evidenceId,
    itemId,
    owner,
    sourceKind,
    `message:${messageId}`,
    roomId,
    messageId,
    purpose,
    AT,
    AT,
  );
}

async function expectCode(label: string, promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof BusinessError)) throw error;
    checkEqual(label, error.code, code);
    return;
  }
  throw new CheckFailure(label, `期望 ${code}，但调用成功`);
}

async function bindingOf(owner: string): Promise<FocusBindingRow | null> {
  return d1.prepare('SELECT * FROM focus_bindings WHERE owner_actor_id = ?').bind(owner).first<FocusBindingRow>();
}

async function itemOf(itemId: string): Promise<FocusItemRow> {
  return d1
    .prepare('SELECT * FROM focus_items WHERE item_id = ?')
    .bind(itemId)
    .first<FocusItemRow>() as Promise<FocusItemRow>;
}

interface InboxSnapshot {
  inboxHead: number;
  pending: number;
  headSeq: number;
  inboxEvents: number;
  deliveries: number;
  operations: number;
}

function snapshot(): InboxSnapshot {
  const actor = scalar<{ inbox_head_seq: number; pending_count: number }>(
    'SELECT inbox_head_seq, pending_count FROM actors WHERE actor_id = ?',
    OWNER,
  );
  return {
    inboxHead: actor.inbox_head_seq,
    pending: actor.pending_count,
    headSeq: scalar<{ n: number }>('SELECT COALESCE(MAX(head_seq), 0) AS n FROM rooms').n,
    inboxEvents: count("SELECT COUNT(*) AS n FROM events WHERE scope_kind = 'inbox'"),
    deliveries: count('SELECT COUNT(*) AS n FROM deliveries'),
    operations: count('SELECT COUNT(*) AS n FROM operations'),
  };
}

async function run(): Promise<void> {
  console.log('  · 身份与权限');
  const owner = await principalFor(OWNER);
  const other = await principalFor(OTHER);
  const agent = await principalFor(AGENT);

  await expectCode('Agent 不能读状态', focusStatus(d1, agent), 'PERMISSION_DENIED');
  await expectCode(
    'Agent 不能开启秘书',
    focusEnable(d1, agent, { request_id: 'req_agent_enable' }),
    'PERMISSION_DENIED',
  );
  await expectCode(
    'Agent 不能暂停秘书',
    focusDisable(d1, agent, { request_id: 'req_agent_disable' }),
    'PERMISSION_DENIED',
  );
  await expectCode('Agent 不能列卡', focusList(d1, agent, {}), 'PERMISSION_DENIED');
  await expectCode(
    'Agent 不能读卡',
    focusGet(d1, agent, { item_id: 'fit_missing' }),
    'PERMISSION_DENIED',
  );
  await expectCode(
    'Agent 不能归档',
    focusArchive(d1, agent, { item_id: 'fit_missing', request_id: 'req_agent_archive', expected_version: 1 }),
    'PERMISSION_DENIED',
  );

  console.log('  · 开启与唯一秘书');
  const disabled = await focusStatus(d1, owner);
  checkEqual('未开启为 disabled', disabled.status, 'disabled');
  checkEqual('未开启无秘书', disabled.secretary_actor_id, null);
  checkEqual('未开启 runtime_ready=false', disabled.runtime_ready, false);
  checkEqual('未开启计数为零', JSON.stringify(disabled.counts), JSON.stringify({ needs_me: 0, tracking: 0, done: 0, archived: 0 }));

  const watermark = maxEventSeq();
  const firstEnable = await focusEnable(d1, owner, { request_id: 'req_enable_first' });
  checkEqual('首次开启为 provisioning', firstEnable.status, 'provisioning');
  checkEqual('首次开启 enabled=true', firstEnable.enabled, true);
  checkEqual('首次开启非幂等', firstEnable.idempotent, false);
  check('首次开启返回秘书 actor', typeof firstEnable.secretary_actor_id === 'string');

  const bindingAfterEnable = await bindingOf(OWNER);
  check('绑定已建立', bindingAfterEnable !== null);
  checkEqual('绑定代次为 1', bindingAfterEnable?.generation, 1);
  checkEqual('水位取开启前事件序号', bindingAfterEnable?.event_from_seq, watermark);
  checkEqual('绑定无远端 session', bindingAfterEnable?.session_id, null);
  checkEqual('绑定 status=provisioning', bindingAfterEnable?.status, 'provisioning');
  const secretaryRow = scalar<{ kind: string; agent_session_id: string | null; name: string; inbox_head_seq: number; pending_count: number }>(
    'SELECT kind, agent_session_id, name, inbox_head_seq, pending_count FROM actors WHERE actor_id = ?',
    firstEnable.secretary_actor_id as string,
  );
  checkEqual('秘书是 agent', secretaryRow.kind, 'agent');
  checkEqual('秘书无 agent_session_id', secretaryRow.agent_session_id, null);
  checkEqual('秘书名称为任务秘书', secretaryRow.name, '任务秘书');

  const replay = await focusEnable(d1, owner, { request_id: 'req_enable_first' });
  checkEqual('同 request_id 重放结果一致', JSON.stringify(replay), JSON.stringify(firstEnable));
  const secondEnable = await focusEnable(d1, owner, { request_id: 'req_enable_second' });
  checkEqual('重复开启返回同一秘书', secondEnable.secretary_actor_id, firstEnable.secretary_actor_id);
  checkEqual('重复开启标记幂等', secondEnable.idempotent, true);
  checkEqual('同一 owner 只有一个绑定', count('SELECT COUNT(*) AS n FROM focus_bindings WHERE owner_actor_id = ?', OWNER), 1);
  checkEqual(
    '同一 owner 只有一个秘书 actor',
    count(
      `SELECT COUNT(*) AS n FROM actors
        WHERE kind = 'agent' AND name = '任务秘书'
          AND actor_id IN (SELECT secretary_actor_id FROM focus_bindings WHERE owner_actor_id = ?)`,
      OWNER,
    ),
    1,
  );

  const otherEnable = await focusEnable(d1, other, { request_id: 'req_enable_other' });
  check('另一位 owner 得到不同秘书', otherEnable.secretary_actor_id !== firstEnable.secretary_actor_id);
  checkEqual('owner 隔离：另一位 owner 只有一个绑定', count('SELECT COUNT(*) AS n FROM focus_bindings WHERE owner_actor_id = ?', OTHER), 1);

  const concurrent = await principalFor(CONCURRENT);
  const [raceA, raceB] = await Promise.all([
    focusEnable(d1, concurrent, { request_id: 'req_race_a' }),
    focusEnable(d1, concurrent, { request_id: 'req_race_b' }),
  ]);
  checkEqual('并发开启收敛到同一秘书', raceA.secretary_actor_id, raceB.secretary_actor_id);
  checkEqual(
    '并发开启只建一个绑定',
    count('SELECT COUNT(*) AS n FROM focus_bindings WHERE owner_actor_id = ?', CONCURRENT),
    1,
  );

  const secretary = firstEnable.secretary_actor_id as string;

  console.log('  · 计数与列定义');
  seedMessage('msg_focus_base', ROOM_MAIN, AGENT, '基础可读来源');
  seedItem({ itemId: 'fit_owner_a', secretary, column: 'needs_me', updatedAt: AT + 10 });
  seedItem({ itemId: 'fit_owner_b', secretary, column: 'needs_me', updatedAt: AT + 20 });
  seedItem({ itemId: 'fit_owner_extra', secretary, column: 'needs_me', updatedAt: AT + 5 });
  seedItem({ itemId: 'fit_owner_track', secretary, column: 'tracking', updatedAt: AT + 30 });
  seedItem({ itemId: 'fit_owner_done', secretary, column: 'done', updatedAt: AT + 40 });
  seedItem({
    itemId: 'fit_owner_archived',
    secretary,
    column: 'needs_me',
    updatedAt: AT + 50,
    archivedAt: AT + 55,
  });
  const counted = await focusStatus(d1, owner);
  checkEqual(
    '计数排除归档卡',
    JSON.stringify(counted.counts),
    JSON.stringify({ needs_me: 3, tracking: 1, done: 1, archived: 1 }),
  );
  checkEqual('归档卡不进入 needs_me', counted.counts.needs_me, 3);
  checkEqual('计数只含本人卡', (await focusStatus(d1, other)).counts.needs_me, 0);

  seedItem({ itemId: 'fit_no_evidence', secretary, column: 'needs_me', updatedAt: AT + 6, noEvidence: true });
  checkEqual(
    '无证据卡不计入计数',
    JSON.stringify((await focusStatus(d1, owner)).counts),
    JSON.stringify({ needs_me: 3, tracking: 1, done: 1, archived: 1 }),
  );
  checkEqual(
    '无证据卡不出现在列表',
    (await focusList(d1, owner, { query: 'fit_no_evidence' })).items.length,
    0,
  );
  await expectCode(
    '无证据卡详情 NOT_FOUND',
    focusGet(d1, owner, { item_id: 'fit_no_evidence' }),
    'NOT_FOUND',
  );

  console.log('  · 暂停与代次');
  db.prepare(
    `INSERT INTO focus_jobs
       (job_id, owner_actor_id, secretary_actor_id, attempt_ref, submission_key, status,
        generation, created_at, updated_at)
     VALUES ('fjob_pause', ?, ?, 'att_pause', 'sub_pause', 'queued', 1, ?, ?)`,
  ).run(OWNER, secretary, AT, AT);
  db.prepare(
    `INSERT INTO focus_candidates
       (candidate_id, owner_actor_id, job_id, source_kind, event_seq, room_id, message_id,
        source_key, reason, state, created_at, updated_at)
     VALUES ('fcand_pause', ?, 'fjob_pause', 'message', 1, ?, NULL, 'message:fcand',
             '委托', 'assigned', ?, ?)`,
  ).run(OWNER, ROOM_MAIN, AT, AT);
  const beforeDisable = snapshot();
  const paused = await focusDisable(d1, owner, { request_id: 'req_disable_first' });
  checkEqual('暂停后 status=paused', paused.status, 'paused');
  checkEqual('暂停后 enabled=false', paused.enabled, false);
  checkEqual('暂停非幂等', paused.idempotent, false);
  const bindingAfterPause = (await bindingOf(OWNER)) as FocusBindingRow;
  checkEqual('暂停提升代次', bindingAfterPause.generation, 2);
  check('暂停写入 paused_at', bindingAfterPause.paused_at !== null);
  checkEqual(
    '暂停取消活跃作业',
    scalar<{ status: string }>('SELECT status FROM focus_jobs WHERE job_id = ?', 'fjob_pause').status,
    'cancelled',
  );
  checkEqual(
    '暂停时尝试次数保持',
    scalar<{ attempt_count: number }>('SELECT attempt_count FROM focus_jobs WHERE job_id = ?', 'fjob_pause').attempt_count,
    0,
  );
  const pausedCandidate = scalar<{ state: string; job_id: string | null }>(
    'SELECT state, job_id FROM focus_candidates WHERE candidate_id = ?',
    'fcand_pause',
  );
  checkEqual('暂停释放候选回到 pending', pausedCandidate.state, 'pending');
  checkEqual('暂停清空候选 job_id', pausedCandidate.job_id, null);
  const pauseReplay = await focusDisable(d1, owner, { request_id: 'req_disable_first' });
  checkEqual('同 request_id 暂停重放一致', JSON.stringify(pauseReplay), JSON.stringify(paused));
  const pauseAgain = await focusDisable(d1, owner, { request_id: 'req_disable_again' });
  checkEqual('重复暂停标记幂等', pauseAgain.idempotent, true);
  checkEqual('重复暂停不再提升代次', (await bindingOf(OWNER))?.generation, 2);

  const afterDisable = snapshot();
  checkEqual('focus_updated 不增加 pending_count', afterDisable.pending, beforeDisable.pending);
  checkEqual('focus_updated 不推进 inbox_head_seq', afterDisable.inboxHead, beforeDisable.inboxHead);
  checkEqual('focus_updated 不推进房间 head_seq', afterDisable.headSeq, beforeDisable.headSeq);
  checkEqual('focus_updated 不写 inbox 事件', afterDisable.inboxEvents, beforeDisable.inboxEvents);
  checkEqual('focus_updated 不产生 delivery', afterDisable.deliveries, beforeDisable.deliveries);
  checkEqual('暂停只写一条 focus_updated', count(
    "SELECT COUNT(*) AS n FROM events WHERE event_type = ? AND scope_id = ?",
    FOCUS_UPDATED_EVENT,
    OWNER,
  ), 2);
  const pauseEvent = scalar<{ scope_kind: string; metadata: string }>(
    `SELECT scope_kind, metadata FROM events
      WHERE event_type = ? AND scope_id = ? ORDER BY event_seq DESC LIMIT 1`,
    FOCUS_UPDATED_EVENT,
    OWNER,
  );
  checkEqual('focus_updated 为 actor scope', pauseEvent.scope_kind, 'actor');
  checkEqual(
    'focus_updated change=paused',
    (JSON.parse(pauseEvent.metadata) as { change?: string }).change,
    'paused',
  );

  console.log('  · 恢复');
  const beforeResumeSeq = maxEventSeq();
  const resumed = await focusEnable(d1, owner, { request_id: 'req_enable_resume' });
  checkEqual('恢复正常为 provisioning', resumed.status, 'provisioning');
  checkEqual('恢复复用同一秘书', resumed.secretary_actor_id, secretary);
  checkEqual('恢复非幂等', resumed.idempotent, false);
  const bindingAfterResume = (await bindingOf(OWNER)) as FocusBindingRow;
  checkEqual('恢复再提升代次', bindingAfterResume.generation, 3);
  checkEqual('恢复清空 paused_at', bindingAfterResume.paused_at, null);
  checkEqual('恢复更新水位', bindingAfterResume.event_from_seq, beforeResumeSeq);
  const resumedCandidate = scalar<{ state: string; job_id: string | null }>(
    'SELECT state, job_id FROM focus_candidates WHERE candidate_id = ?',
    'fcand_pause',
  );
  checkEqual('重开后候选可再次组 job', resumedCandidate.state, 'pending');
  checkEqual('重开后候选未绑定旧作业', resumedCandidate.job_id, null);
  checkEqual('provisioning 时 runtime_ready=false', (await focusStatus(d1, owner)).runtime_ready, false);
  db.prepare(
    "UPDATE focus_bindings SET status = 'active', session_id = 'sess_focus', root_session_id = 'root_focus' WHERE owner_actor_id = ?",
  ).run(OWNER);
  checkEqual('会话齐备时 runtime_ready=true', (await focusStatus(d1, owner)).runtime_ready, true);
  db.prepare(
    "UPDATE focus_bindings SET status = 'provisioning', session_id = NULL, root_session_id = NULL WHERE owner_actor_id = ?",
  ).run(OWNER);

  console.log('  · 列表分页与筛选');
  const page1 = await focusList(d1, owner, { limit: 2 });
  checkEqual('默认只返回未归档卡', page1.items.length, 2);
  checkEqual('按 updated_at 倒序', page1.items[0]?.item_id, 'fit_owner_done');
  checkEqual('第二项', page1.items[1]?.item_id, 'fit_owner_track');
  check('第一页返回 next_cursor', typeof page1.next_cursor === 'string');
  const page2 = await focusList(d1, owner, { limit: 2, cursor: page1.next_cursor as string });
  checkEqual('第二页条数', page2.items.length, 2);
  checkEqual('第二页首项', page2.items[0]?.item_id, 'fit_owner_b');
  const page3 = await focusList(d1, owner, { limit: 2, cursor: page2.next_cursor as string });
  checkEqual('第三页条数', page3.items.length, 1);
  checkEqual('第三页为末项', page3.items[0]?.item_id, 'fit_owner_extra');
  checkEqual('末页无 next_cursor', page3.next_cursor, null);
  const ids = [...page1.items, ...page2.items, ...page3.items].map((item) => item.item_id);
  checkEqual('分页无重复', new Set(ids).size, ids.length);

  const tracking = await focusList(d1, owner, { column: 'tracking' });
  checkEqual('column 过滤只返回 tracking', tracking.items.length, 1);
  checkEqual('column 过滤命中', tracking.items[0]?.item_id, 'fit_owner_track');
  const archivedList = await focusList(d1, owner, { archived: true });
  checkEqual('archived=true 只返回已归档', archivedList.items.length, 1);
  checkEqual('已归档卡命中', archivedList.items[0]?.item_id, 'fit_owner_archived');

  seedItem({ itemId: 'fit_pct', secretary, title: '覆盖率 100%', updatedAt: AT + 60 });
  seedItem({ itemId: 'fit_plain', secretary, title: '覆盖率 100 分', updatedAt: AT + 61 });
  const literal = await focusList(d1, owner, { query: '%' });
  checkEqual('query 的 % 按字面量匹配', literal.items.length, 1);
  checkEqual('query 命中含 % 的标题', literal.items[0]?.item_id, 'fit_pct');

  await expectCode(
    'cursor 不能跨筛选复用',
    focusList(d1, owner, { column: 'done', cursor: page1.next_cursor as string }),
    'INVALID_ARGUMENT',
  );
  await expectCode(
    'cursor 不能跨 query 复用',
    focusList(d1, owner, { cursor: page1.next_cursor as string, query: '覆盖率' }),
    'INVALID_ARGUMENT',
  );
  const otherList = await focusList(d1, other, {});
  checkEqual('owner 隔离：看不到他人卡', otherList.items.length, 0);

  console.log('  · 证据与遮蔽');
  seedMessage('msg_focus_ok', ROOM_MAIN, AGENT, '回归 32/32 通过');
  seedMessage('msg_focus_left', ROOM_LEFT, OWNER, '已失去成员的来源');
  seedItem({ itemId: 'fit_evidence_mixed', secretary, title: '确认灰度放行', updatedAt: AT + 70, summary: '等两份交付', noEvidence: true });
  seedEvidence('fev_mixed_ok', 'fit_evidence_mixed', OWNER, 'msg_focus_ok', ROOM_MAIN, 'progress');
  seedEvidence('fev_mixed_left', 'fit_evidence_mixed', OWNER, 'msg_focus_left', ROOM_LEFT, 'request');
  seedItem({ itemId: 'fit_evidence_clean', secretary, title: '整理复盘', updatedAt: AT + 73, noEvidence: true });
  seedEvidence('fev_clean', 'fit_evidence_clean', OWNER, 'msg_focus_ok', ROOM_MAIN, 'progress');
  seedItem({ itemId: 'fit_evidence_left_only', secretary, title: '仅私群来源', updatedAt: AT + 74, noEvidence: true });
  seedEvidence('fev_left_only', 'fit_evidence_left_only', OWNER, 'msg_focus_left', ROOM_LEFT);
  db.prepare(
    `INSERT INTO focus_revisions
       (revision_id, item_id, version, decision_id, changes_json, reason, evidence_json, created_at)
     VALUES ('frev_one', 'fit_evidence_clean', 1, 'dec_one', '{"column_key":"needs_me"}', '首次建卡', '["fev_clean"]', ?)`,
  ).run(AT);
  // 退出群：成员从 active 变为 left，历史证据必须立即失效。
  const countsBeforeLeave = await focusStatus(d1, owner);
  const otherCountsBeforeLeave = (await focusStatus(d1, other)).counts;
  db.prepare("UPDATE room_members SET status = 'left' WHERE room_id = ? AND actor_id = ?").run(
    ROOM_LEFT,
    OWNER,
  );
  const countsAfterLeave = await focusStatus(d1, owner);
  checkEqual(
    '退出私群后计数减少一张卡',
    countsAfterLeave.counts.needs_me,
    countsBeforeLeave.counts.needs_me - 1,
  );
  checkEqual(
    '另一 owner 的计数不受影响',
    JSON.stringify((await focusStatus(d1, other)).counts),
    JSON.stringify(otherCountsBeforeLeave),
  );
  await expectCode(
    '仅失权来源的卡详情 NOT_FOUND',
    focusGet(d1, owner, { item_id: 'fit_evidence_left_only' }),
    'NOT_FOUND',
  );
  checkEqual(
    '仅失权来源的卡从列表隐藏',
    (await focusList(d1, owner, { query: '仅私群来源' })).items.length,
    0,
  );

  const mixed = await focusGet(d1, owner, { item_id: 'fit_evidence_mixed' });
  checkEqual('任一证据失权则 restricted=true', mixed.item.restricted, true);
  checkEqual('失权遮蔽标题', mixed.item.title, '');
  checkEqual('失权遮蔽下一步', mixed.item.next_step, '');
  checkEqual('失权遮蔽摘要', mixed.item.summary, '');
  checkEqual('失权遮蔽来源计数', mixed.item.source_count, 0);
  const readableEvidence = mixed.evidence.find((item) => item.evidence_id === 'fev_mixed_ok');
  const hiddenEvidence = mixed.evidence.find((item) => item.evidence_id === 'fev_mixed_left');
  checkEqual('可读证据 readable=true', readableEvidence?.readable, true);
  check('可读证据带摘录', (readableEvidence?.excerpt ?? '').includes('32/32'));
  checkEqual('失权证据 readable=false', hiddenEvidence?.readable, false);
  checkEqual('失权证据不带 room_id', hiddenEvidence?.room_id, undefined);
  checkEqual('失权证据不带 message_id', hiddenEvidence?.message_id, undefined);
  checkEqual('失权证据不带摘录', hiddenEvidence?.excerpt, undefined);
  checkEqual('失权证据保留用途', hiddenEvidence?.purpose, 'request');
  checkEqual('失权详情不返回修订', mixed.revisions.length, 0);
  const clean = await focusGet(d1, owner, { item_id: 'fit_evidence_clean' });
  checkEqual('可读卡不遮蔽', clean.item.restricted, false);
  checkEqual('可读卡返回来源计数', clean.item.source_count, 1);
  checkEqual('修订 changes 解析为对象', JSON.stringify(clean.revisions[0]?.changes), JSON.stringify({ column_key: 'needs_me' }));
  checkEqual('修订 evidence 解析为数组', JSON.stringify(clean.revisions[0]?.evidence), JSON.stringify(['fev_clean']));

  seedItem({ itemId: 'fit_evidence_all_hidden', secretary, title: '全部失权', updatedAt: AT + 71, noEvidence: true });
  seedEvidence('fev_all_hidden', 'fit_evidence_all_hidden', OWNER, 'msg_focus_left', ROOM_LEFT);
  await expectCode(
    '全部证据失权返回 NOT_FOUND',
    focusGet(d1, owner, { item_id: 'fit_evidence_all_hidden' }),
    'NOT_FOUND',
  );
  checkEqual(
    '全部证据失权的卡从列表隐藏',
    (await focusList(d1, owner, { query: '全部失权' })).items.length,
    0,
  );
  const byRoom = await focusList(d1, owner, { query: 'Focus Main' });
  check(
    'query 可命中来源会话名',
    byRoom.items.some((item) => item.item_id === 'fit_evidence_clean'),
  );

  seedItem({ itemId: 'fit_evidence_recalled', secretary, title: '撤回来源', updatedAt: AT + 72, noEvidence: true });
  seedMessage('msg_focus_recalled', ROOM_MAIN, AGENT, '将被撤回');
  seedEvidence('fev_recalled', 'fit_evidence_recalled', OWNER, 'msg_focus_recalled', ROOM_MAIN);
  db.prepare("UPDATE messages SET body = '', body_bytes = 0 WHERE message_id = ?").run('msg_focus_recalled');
  await expectCode(
    '来源撤回后整卡不可见',
    focusGet(d1, owner, { item_id: 'fit_evidence_recalled' }),
    'NOT_FOUND',
  );

  await expectCode(
    'owner 隔离：读不到他人卡',
    focusGet(d1, other, { item_id: 'fit_evidence_mixed' }),
    'NOT_FOUND',
  );

  console.log('  · 归档');
  const archiveTarget = await itemOf('fit_evidence_mixed');
  await expectCode(
    '归档版本冲突',
    focusArchive(d1, owner, {
      item_id: 'fit_evidence_mixed',
      request_id: 'req_archive_conflict',
      expected_version: archiveTarget.version + 5,
    }),
    'CONFLICT',
  );
  const evidenceBefore = count('SELECT COUNT(*) AS n FROM focus_evidence WHERE item_id = ?', 'fit_evidence_mixed');
  const archived = await focusArchive(d1, owner, {
    item_id: 'fit_evidence_mixed',
    request_id: 'req_archive_first',
    expected_version: archiveTarget.version,
  });
  checkEqual('归档非幂等', archived.idempotent, false);
  checkEqual('归档递增版本', archived.version, archiveTarget.version + 1);
  const archiveReplay = await focusArchive(d1, owner, {
    item_id: 'fit_evidence_mixed',
    request_id: 'req_archive_first',
    expected_version: archiveTarget.version,
  });
  checkEqual('同 request_id 归档重放一致', JSON.stringify(archiveReplay), JSON.stringify(archived));
  const archiveAgain = await focusArchive(d1, owner, {
    item_id: 'fit_evidence_mixed',
    request_id: 'req_archive_again',
    expected_version: archiveTarget.version,
  });
  checkEqual('重复归档返回同一次归档', archiveAgain.archived_at, archived.archived_at);
  checkEqual('重复归档标记幂等', archiveAgain.idempotent, true);
  checkEqual('重复归档不再提升版本', archiveAgain.version, archived.version);
  checkEqual(
    '归档不删除证据',
    count('SELECT COUNT(*) AS n FROM focus_evidence WHERE item_id = ?', 'fit_evidence_mixed'),
    evidenceBefore,
  );
  checkEqual('归档写 focus_updated', count(
    "SELECT COUNT(*) AS n FROM events WHERE event_type = ? AND ref_id = ?",
    FOCUS_UPDATED_EVENT,
    'fit_evidence_mixed',
  ), 1);
  const archiveEvent = scalar<{ metadata: string }>(
    "SELECT metadata FROM events WHERE event_type = ? AND ref_id = ?",
    FOCUS_UPDATED_EVENT,
    'fit_evidence_mixed',
  );
  checkEqual(
    '归档提示 change=archived',
    (JSON.parse(archiveEvent.metadata) as { change?: string }).change,
    'archived',
  );
  checkEqual('归档卡从默认列表移出', (await focusList(d1, owner, { query: '确认灰度放行' })).items.length, 0);
  checkEqual('归档卡可在归档列表回看', (await focusList(d1, owner, { archived: true, query: '确认灰度放行' })).items.length, 1);

  console.log('  · 读取不写库 / 提示只走 actor stream');
  const operationsBeforeReads = snapshot().operations;
  await focusStatus(d1, owner);
  await focusList(d1, owner, {});
  await focusGet(d1, owner, { item_id: 'fit_evidence_mixed' });
  checkEqual('列表/详情/状态不写 operations', snapshot().operations, operationsBeforeReads);

  const afterAll = snapshot();

  const frames: Array<{ actorId: string; data: string }> = [];
  const env = {
    DB: d1,
    NOTIFICATION_HUB: {
      publishActor: (actorId: string, data: string) => frames.push({ actorId, data }),
    },
  } as unknown as Env;
  await drainOutbox(env);
  const items: Array<Record<string, unknown>> = frames.flatMap((frame) => {
    const parsed = JSON.parse(frame.data) as { items?: Array<Record<string, unknown>> };
    return parsed.items ?? [];
  });
  const pauseItem = items.find((item) => item.source === 'focus.updated' && item.change === 'paused');
  check('stream 输出 focus_updated', pauseItem !== undefined);
  checkEqual('stream kind=focus', pauseItem?.kind, 'focus');
  checkEqual('stream attention=informational', pauseItem?.attention, 'informational');
  const archiveItem = items.find((item) => item.source === 'focus.updated' && item.change === 'archived');
  checkEqual('归档 stream ref_id 来自 metadata', archiveItem?.ref_id, 'fit_evidence_mixed');
  checkEqual('提示不产生 inbox 事件', snapshot().inboxEvents, afterAll.inboxEvents);
  checkEqual('提示不产生 delivery', snapshot().deliveries, afterAll.deliveries);
}

db = openSeededDb();
d1 = createD1(db);
try {
  await run();
  console.log(`Task Focus 后端核心通过：${checksPassed()} 项检查`);
} finally {
  db.close();
}
