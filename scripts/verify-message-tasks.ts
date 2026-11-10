/**
 * 消息式 Task / Trace 阶段 1 验收。
 *
 * 使用内存 SQLite 与真实 migrations，不启动服务、不访问生产。覆盖标记/取消、
 * 重复标记、发送继承、交错任务、引用来源一层去重、摘要参与者与计数、Trace
 * 分页/引用标记、撤回/权限/历史边界，以及事件不写 inbox、不推进 head 与
 * `pending_count` 的不变量。
 */

import { Database } from 'bun:sqlite';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { BusinessError } from '../src/contracts/errors';
import { MESSAGE_TASK_MARKED_EVENT, MESSAGE_TASK_UNMARKED_EVENT } from '../src/contracts/events';
import { messageRecall } from '../src/domain/message-recall';
import { messageSend } from '../src/domain/messages';
import {
  messageTaskMark,
  messageTaskSummaries,
  messageTaskTrace,
  messageTaskUnmark,
  type TaskMarkResult,
  type TaskSummary,
  type TaskUnmarkResult,
} from '../src/domain/message-tasks';
import type { Principal } from '../src/domain/principal';
import type { OutboxStreamRow } from '../src/realtime/stream';
import { roomStreamItems } from '../src/realtime/stream';
import { getActor, getMessage, getRoom } from '../src/storage/queries';
import type { MessageRow } from '../src/storage/rows';
import { check, checkEqual, CheckFailure, checksPassed } from './lib/harness';

const MIGRATIONS = join(import.meta.dir, '../migrations');
const AT = Date.now();
const MAIN = 'rm_mt_main';
const RESTRICTED = 'rm_mt_restricted';
const HUMAN = 'usr_mt_human';
const LATE = 'usr_mt_late';
const OUTSIDER = 'usr_mt_outsider';
const AGENT_ONE = 'agt_mt_one';
const AGENT_TWO = 'agt_mt_two';
const AGENT_THREE = 'agt_mt_three';

const TOMBSTONE = '此消息已撤回';

let counter = 0;
let db: Database;
let d1: D1Database;

function openSeededDb(): Database {
  const database = new Database(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  migrate(database, MIGRATIONS);
  database.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${HUMAN}', 'human', NULL, 'MT Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${LATE}', 'human', NULL, 'MT Late', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${OUTSIDER}', 'human', NULL, 'MT Outsider', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT_ONE}', 'agent', 'sess_mt_one', 'MT Agent One', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT_TWO}', 'agent', 'sess_mt_two', 'MT Agent Two', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT_THREE}', 'agent', 'sess_mt_three', 'MT Agent Three', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
       member_seq, last_message_id, created_at, updated_at)
    VALUES
      ('${MAIN}', 'group', '${HUMAN}', 'MT Main', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${RESTRICTED}', 'group', '${HUMAN}', 'MT Restricted', NULL, 0, 0, 0, NULL, ${AT}, ${AT});

    UPDATE rooms SET member_message_policy = 'owner_admin' WHERE room_id = '${RESTRICTED}';

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
    VALUES
      ('${MAIN}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${MAIN}', '${AGENT_ONE}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${MAIN}', '${AGENT_TWO}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${MAIN}', '${AGENT_THREE}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${RESTRICTED}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${RESTRICTED}', '${AGENT_TWO}', 'member', 'active', 0, 0, ${AT}, 1, ${AT});
  `);
  return database;
}

async function principalFor(actor: string): Promise<Principal> {
  const row = await getActor(d1, actor);
  if (!row) throw new CheckFailure('seed', `缺少 actor: ${actor}`);
  return { credentialHash: `hash_${actor}`, actor: row, credential: null };
}

interface SendOptions {
  reply_to?: string;
  task_root_id?: string;
  client_message_id?: string;
  request_id?: string;
}

async function send(
  actor: string,
  roomId: string,
  body: string,
  options: SendOptions = {},
): Promise<MessageRow> {
  counter += 1;
  const result = await messageSend(d1, await principalFor(actor), {
    request_id: options.request_id ?? `req_send_${counter}`,
    client_message_id: options.client_message_id ?? `cm_${actor}_${counter}`,
    room_id: roomId,
    body,
    invoke: [],
    ...(options.reply_to === undefined ? {} : { reply_to: options.reply_to }),
    ...(options.task_root_id === undefined ? {} : { task_root_id: options.task_root_id }),
  });
  const row = await getMessage(d1, result.message.message_id);
  if (!row) throw new CheckFailure('send', '消息写入后读不到');
  return row;
}

async function mark(
  actor: string,
  roomId: string,
  messageId: string,
  requestId?: string,
): Promise<TaskMarkResult> {
  counter += 1;
  return messageTaskMark(d1, await principalFor(actor), {
    request_id: requestId ?? `req_mark_${counter}`,
    room_id: roomId,
    message_id: messageId,
  });
}

async function unmark(
  actor: string,
  roomId: string,
  messageId: string,
  requestId?: string,
): Promise<TaskUnmarkResult> {
  counter += 1;
  return messageTaskUnmark(d1, await principalFor(actor), {
    request_id: requestId ?? `req_unmark_${counter}`,
    room_id: roomId,
    message_id: messageId,
  });
}

async function summaries(
  actor: string,
  roomId: string,
  rootIds: string[],
): Promise<Map<string, TaskSummary>> {
  const result = await messageTaskSummaries(d1, await principalFor(actor), {
    room_id: roomId,
    root_message_ids: rootIds,
  });
  return new Map(result.items.map((item) => [item.root_message_id, item]));
}

async function expectCode(
  label: string,
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof BusinessError)) throw error;
    checkEqual(label, error.code, code);
    return;
  }
  throw new CheckFailure(label, `期望 ${code}，但调用成功`);
}

async function recall(actor: string, messageId: string): Promise<void> {
  counter += 1;
  await messageRecall(d1, await principalFor(actor), {
    request_id: `req_recall_${counter}`,
    message_id: messageId,
  });
}

function eventCount(type: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM events WHERE event_type = ?').get(type) as { n: number }
  ).n;
}

function outboxCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;
}

function inboxEventCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE scope_kind = 'inbox'").get() as {
      n: number;
    }
  ).n;
}

function pendingCounts(): string {
  return JSON.stringify(
    db
      .prepare('SELECT actor_id, pending_count FROM actors ORDER BY actor_id')
      .all(),
  );
}

async function roomState(): Promise<{ head_seq: number; updated_at: number; last_message_id: string | null }> {
  const room = await getRoom(d1, MAIN);
  if (!room) throw new CheckFailure('room', '主房间不存在');
  return {
    head_seq: room.head_seq,
    updated_at: room.updated_at,
    last_message_id: room.last_message_id,
  };
}

async function collectTrace(
  actor: string,
  roomId: string,
  rootId: string,
  limit: number,
): Promise<{
  ids: string[];
  counts: number[];
  pages: number;
  items: Awaited<ReturnType<typeof messageTaskTrace>>['items'];
}> {
  const ids: string[] = [];
  const counts: number[] = [];
  const items: Awaited<ReturnType<typeof messageTaskTrace>>['items'] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await messageTaskTrace(d1, await principalFor(actor), {
      room_id: roomId,
      root_message_id: rootId,
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
    pages += 1;
    counts.push(page.message_count);
    ids.push(...page.items.map((item) => item.message_id));
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
    if (pages > 20) throw new CheckFailure('trace', '分页未收敛');
  } while (cursor !== undefined);
  return { ids, counts, pages, items };
}

function verifyMigrationUpgrade(): void {
  console.log('  · 0041 在已有 messages 行上升级');
  const dir = mkdtempSync(join(tmpdir(), 'agent-network-mt-'));
  const upgrade = new Database(':memory:');
  try {
    for (const file of readdirSync(MIGRATIONS).filter(
      (name) => name.endsWith('.sql') && name < '0041',
    )) {
      copyFileSync(join(MIGRATIONS, file), join(dir, file));
    }
    migrate(upgrade, dir);
    upgrade
      .prepare(
        `INSERT INTO messages
           (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
            preview, reply_to, root_id, hop, root_invocations_used, created_at)
         VALUES ('msg_mt_upgrade', 'rm_mt_upgrade', 'usr_mt_upgrade', 'cm_mt_upgrade', 1,
                 'upgrade', 7, 'upgrade', NULL, NULL, 0, 0, ?)`,
      )
      .run(AT);
    copyFileSync(
      join(MIGRATIONS, '0041_message_task_trace.sql'),
      join(dir, '0041_message_task_trace.sql'),
    );
    migrate(upgrade, dir);
    const columns = upgrade.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const column of ['task_root_id', 'task_marked_by', 'task_marked_at']) {
      check(`升级后 messages.${column} 存在`, names.has(column));
    }
    const row = upgrade
      .prepare("SELECT task_root_id, task_marked_by, task_marked_at FROM messages WHERE message_id = 'msg_mt_upgrade'")
      .get() as {
      task_root_id: string | null;
      task_marked_by: string | null;
      task_marked_at: number | null;
    };
    checkEqual('旧消息 task_root_id 保持 NULL', row.task_root_id, null);
    checkEqual('旧消息 task_marked_by 保持 NULL', row.task_marked_by, null);
    checkEqual('旧消息 task_marked_at 保持 NULL', row.task_marked_at, null);
    const indexes = new Set(
      (upgrade.prepare('PRAGMA index_list(messages)').all() as Array<{ name: string }>).map(
        (index) => index.name,
      ),
    );
    check('task_root 索引已创建', indexes.has('idx_messages_task_root'));
    check('reply_to 索引已创建', indexes.has('idx_messages_room_reply_to'));
    const guards = new Set(
      (
        upgrade
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'guard_task_mark_%'")
          .all() as Array<{ name: string }>
      ).map((table) => table.name),
    );
    check('标记闸门表已创建', guards.has('guard_task_mark_unavailable'));
    check('冲突闸门表已创建', guards.has('guard_task_mark_conflict'));
  } finally {
    upgrade.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runMessageTaskChecks(): Promise<void> {
  verifyMigrationUpgrade();

  console.log('  · 标记、发送继承与交错任务');
  const rootA = await send(HUMAN, MAIN, 'TASK-A 起点');
  const rootB = await send(HUMAN, MAIN, 'TASK-B 起点');
  const interleavedChat = await send(HUMAN, MAIN, '两项工作之间的闲聊');
  const earlyReplyA = await send(AGENT_ONE, MAIN, 'A 标记前的回复', {
    reply_to: rootA.message_id,
  });
  checkEqual('标记前回复不自动归属', earlyReplyA.task_root_id, null);
  checkEqual('无关顶层消息不归属', interleavedChat.task_root_id, null);

  const rootAMarked = await mark(AGENT_ONE, MAIN, rootA.message_id);
  checkEqual('A 起点标记结果', rootAMarked.task_root_id, rootA.message_id);
  checkEqual('A 起点 marked', rootAMarked.marked, true);
  await mark(AGENT_TWO, MAIN, rootB.message_id);
  checkEqual('可标记他人发送的消息', (await getMessage(d1, rootA.message_id))?.task_marked_by, AGENT_ONE);

  const markedAt = (await getMessage(d1, rootA.message_id))?.task_marked_at;
  const markEvents = eventCount(MESSAGE_TASK_MARKED_EVENT);
  const again = await mark(AGENT_TWO, MAIN, rootA.message_id);
  checkEqual('重复标记仍成功', again.marked, true);
  checkEqual('重复标记不改标记人', (await getMessage(d1, rootA.message_id))?.task_marked_by, AGENT_ONE);
  checkEqual('重复标记不改标记时间', (await getMessage(d1, rootA.message_id))?.task_marked_at, markedAt);
  checkEqual('重复标记不重复事件', eventCount(MESSAGE_TASK_MARKED_EVENT), markEvents);

  const a1 = await send(AGENT_ONE, MAIN, 'A 处理一', { reply_to: rootA.message_id });
  const b1 = await send(AGENT_TWO, MAIN, 'B 处理一', { reply_to: rootB.message_id });
  const chatBetween = await send(HUMAN, MAIN, '交错闲聊');
  const a2 = await send(AGENT_TWO, MAIN, 'A 处理二', { reply_to: a1.message_id });
  const a1again = await send(AGENT_ONE, MAIN, 'A 处理三', { reply_to: rootA.message_id });
  const b2 = await send(AGENT_ONE, MAIN, 'B 处理二', { reply_to: b1.message_id });
  checkEqual('回复 A 继承 A', a1.task_root_id, rootA.message_id);
  checkEqual('回复 B 继承 B', b1.task_root_id, rootB.message_id);
  checkEqual('回复 A 的处理消息仍继承 A', a2.task_root_id, rootA.message_id);
  checkEqual('顶层回复 A 继承 A', a1again.task_root_id, rootA.message_id);
  checkEqual('回复 B 的处理消息仍继承 B', b2.task_root_id, rootB.message_id);
  checkEqual('无关闲聊不归属任何 Task', chatBetween.task_root_id, null);

  const initial = await summaries(HUMAN, MAIN, [rootA.message_id, rootB.message_id]);
  const summaryA = initial.get(rootA.message_id);
  const summaryB = initial.get(rootB.message_id);
  if (!summaryA || !summaryB) throw new CheckFailure('summary', '缺少 A/B 摘要');
  checkEqual('A 集合含标记前回复', summaryA.message_count, 5);
  checkEqual('B 集合只含 B 消息', summaryB.message_count, 3);
  checkEqual('A 参与者去重顺序', summaryA.participants.map((item) => item.actor_id).join(','), `${AGENT_ONE},${AGENT_TWO}`);
  checkEqual('B 参与者去重顺序', summaryB.participants.map((item) => item.actor_id).join(','), `${AGENT_TWO},${AGENT_ONE}`);
  checkEqual('A 参与者计数', summaryA.participant_count, 2);
  checkEqual('闲聊不在 A', summaryA.message_count, 5);

  console.log('  · 引用来源、跨 Task 引用与摘要计数');
  const sourceShared = await send(AGENT_THREE, MAIN, '共享来源');
  const aRef1 = await send(AGENT_ONE, MAIN, 'A 引用共享来源一', {
    reply_to: sourceShared.message_id,
    task_root_id: rootA.message_id,
  });
  const aRef2 = await send(AGENT_TWO, MAIN, 'A 引用共享来源二', {
    reply_to: sourceShared.message_id,
    task_root_id: rootA.message_id,
  });
  const bRefA = await send(AGENT_TWO, MAIN, 'B 引用 A 的处理消息', {
    reply_to: a1.message_id,
    task_root_id: rootB.message_id,
  });
  checkEqual('显式归属覆盖父消息 Task', aRef1.task_root_id, rootA.message_id);
  checkEqual('B 引用 A 消息仍归 B', bRefA.task_root_id, rootB.message_id);

  const referenced = await summaries(HUMAN, MAIN, [rootA.message_id, rootB.message_id]);
  const referencedA = referenced.get(rootA.message_id);
  const referencedB = referenced.get(rootB.message_id);
  if (!referencedA || !referencedB) throw new CheckFailure('summary', '缺少引用后的摘要');
  checkEqual('引用来源按 message_id 去重计数', referencedA.message_count, 8);
  checkEqual('B 含 A 的处理消息作为引用来源', referencedB.message_count, 5);
  checkEqual('引用来源不计入参与者', referencedA.participant_count, 2);
  checkEqual('A 引用未合并 B 的回复', referencedA.message_count, 8);

  const markC = await mark(HUMAN, MAIN, sourceShared.message_id);
  checkEqual('来源消息可作为独立 Task', markC.task_root_id, sourceShared.message_id);
  const withC = await summaries(HUMAN, MAIN, [rootA.message_id, rootB.message_id, sourceShared.message_id]);
  checkEqual('A 计数不因来源成为 Task 而改变', withC.get(rootA.message_id)?.message_count, 8);
  checkEqual('B 计数不因来源成为 Task 而改变', withC.get(rootB.message_id)?.message_count, 5);
  const summaryC = withC.get(sourceShared.message_id);
  if (!summaryC) throw new CheckFailure('summary', '缺少 C 摘要');
  checkEqual('C 计数', summaryC.message_count, 1);
  checkEqual('C 根发送者为 Agent', summaryC.root_sender_kind, 'agent');
  checkEqual('C 根作者进入参与者', summaryC.participants.map((item) => item.actor_id).join(','), AGENT_THREE);

  console.log('  · Trace 顺序、引用标记与分页');
  const traceA = await collectTrace(AGENT_ONE, MAIN, rootA.message_id, 3);
  checkEqual('Trace A 总数', traceA.counts.at(-1), 8);
  checkEqual('Trace A 无重复', new Set(traceA.ids).size, 8);
  check('Trace A 分页', traceA.pages > 1);
  check(
    'Trace A 按原消息顺序',
    traceA.ids.join(',') ===
      [
        rootA.message_id,
        earlyReplyA.message_id,
        a1.message_id,
        a2.message_id,
        a1again.message_id,
        sourceShared.message_id,
        aRef1.message_id,
        aRef2.message_id,
      ].join(','),
  );
  const refItem = traceA.items.find((item) => item.message_id === sourceShared.message_id);
  if (!refItem) throw new CheckFailure('trace', 'A 缺少引用来源');
  checkEqual('引用来源 role', refItem.role, 'reference');
  checkEqual('引用来源 referenced_by', refItem.referenced_by, aRef1.message_id);
  const aRef1Item = traceA.items.find((item) => item.message_id === aRef1.message_id);
  checkEqual('处理消息保留 reply_to', aRef1Item?.reply_to, sourceShared.message_id);

  const traceB = await collectTrace(AGENT_TWO, MAIN, rootB.message_id, 50);
  checkEqual('Trace B 总数', traceB.counts.at(-1), 5);
  const bRefAItem = traceB.items.find((item) => item.message_id === bRefA.message_id);
  checkEqual('B 中跨 Task 引用保留 reply_to', bRefAItem?.reply_to, a1.message_id);
  const a1InB = traceB.items.find((item) => item.message_id === a1.message_id);
  checkEqual('A 的处理消息在 B 中为引用', a1InB?.role, 'reference');
  checkEqual('B 引用来源 referenced_by', a1InB?.referenced_by, bRefA.message_id);
  check('A 的 Trace 不含 B 的处理消息', !traceA.ids.includes(b1.message_id));

  console.log('  · 引用链上的不可见关系标记');
  const chainParent = await send(HUMAN, MAIN, 'CHAIN parent');
  const chainChild = await send(HUMAN, MAIN, 'CHAIN child', { reply_to: chainParent.message_id });
  const flagRoot = await send(HUMAN, MAIN, 'FLAG root');
  await mark(AGENT_ONE, MAIN, flagRoot.message_id);
  const flagMember = await send(AGENT_ONE, MAIN, 'FLAG member', {
    reply_to: chainChild.message_id,
    task_root_id: flagRoot.message_id,
  });
  const traceFlag = await messageTaskTrace(d1, await principalFor(AGENT_ONE), {
    room_id: MAIN,
    root_message_id: flagRoot.message_id,
  });
  checkEqual('引用链 Task 计数', traceFlag.message_count, 3);
  const chainItem = traceFlag.items.find((item) => item.message_id === chainChild.message_id);
  checkEqual('引用项 role', chainItem?.role, 'reference');
  checkEqual('引用项自身外部 reply_to 置空', chainItem?.reply_to, null);
  checkEqual('引用项标记不可见关系', chainItem?.has_unavailable_reference, true);
  const flagMemberItem = traceFlag.items.find((item) => item.message_id === flagMember.message_id);
  checkEqual('成员指向引用项时保留 reply_to', flagMemberItem?.reply_to, chainChild.message_id);
  checkEqual('成员无不可见关系', flagMemberItem?.has_unavailable_reference, false);

  console.log('  · 撤回消息');
  const humanSource = await send(HUMAN, MAIN, 'HUMAN 来源');
  const aRefHuman = await send(AGENT_ONE, MAIN, 'A 引用人类来源', {
    reply_to: humanSource.message_id,
    task_root_id: rootA.message_id,
  });
  const beforeHumanRecall = (await summaries(HUMAN, MAIN, [rootA.message_id])).get(rootA.message_id);
  if (!beforeHumanRecall) throw new CheckFailure('summary', '缺少撤回前摘要');
  checkEqual('人类来源进入集合计数', beforeHumanRecall.message_count, 10);
  await recall(HUMAN, humanSource.message_id);
  const afterHumanRecall = (await summaries(HUMAN, MAIN, [rootA.message_id])).get(rootA.message_id);
  checkEqual('撤回引用来源仍是 tombstone 并计数', afterHumanRecall?.message_count, 10);
  const recalledTrace = await messageTaskTrace(d1, await principalFor(AGENT_ONE), {
    room_id: MAIN,
    root_message_id: rootA.message_id,
  });
  const recalledSource = recalledTrace.items.find((item) => item.message_id === humanSource.message_id);
  checkEqual('撤回引用来源显示 tombstone', recalledSource?.preview, TOMBSTONE);
  checkEqual('撤回引用来源 recalled', recalledSource?.recalled, true);
  checkEqual('撤回引用来源仍被引用', recalledSource?.role, 'reference');
  checkEqual('撤回前的引用关系仍在', aRefHuman.task_root_id, rootA.message_id);

  const sourceOnly = await send(AGENT_THREE, MAIN, 'ONLY 来源');
  const hRefOnly = await send(HUMAN, MAIN, 'HUMAN 唯一引用者', {
    reply_to: sourceOnly.message_id,
    task_root_id: rootA.message_id,
  });
  const withOnly = (await summaries(HUMAN, MAIN, [rootA.message_id])).get(rootA.message_id);
  checkEqual('唯一引用者加入后计数', withOnly?.message_count, 12);
  await recall(HUMAN, hRefOnly.message_id);
  const afterOnlyRecall = (await summaries(HUMAN, MAIN, [rootA.message_id])).get(rootA.message_id);
  checkEqual('撤回唯一引用者后来源移出集合', afterOnlyRecall?.message_count, 11);
  const noOnlyTrace = await messageTaskTrace(d1, await principalFor(AGENT_ONE), {
    room_id: MAIN,
    root_message_id: rootA.message_id,
  });
  check('撤回处理消息不再贡献引用来源', !noOnlyTrace.items.some((item) => item.message_id === sourceOnly.message_id));
  const hRefOnlyItem = noOnlyTrace.items.find((item) => item.message_id === hRefOnly.message_id);
  checkEqual('撤回处理消息仍以 tombstone 留在集合', hRefOnlyItem?.recalled, true);

  const recallRoot = await send(HUMAN, MAIN, 'RECALL root');
  await mark(AGENT_ONE, MAIN, recallRoot.message_id);
  await recall(HUMAN, recallRoot.message_id);
  const recallSummary = (await summaries(HUMAN, MAIN, [recallRoot.message_id])).get(recallRoot.message_id);
  if (!recallSummary) throw new CheckFailure('summary', '撤回起点摘要缺失');
  checkEqual('撤回起点保留摘要', recallSummary.preview, TOMBSTONE);
  checkEqual('撤回起点计数', recallSummary.message_count, 1);
  checkEqual('撤回起点无参与者', recallSummary.participant_count, 0);
  const recallTrace = await messageTaskTrace(d1, await principalFor(AGENT_ONE), {
    room_id: MAIN,
    root_message_id: recallRoot.message_id,
  });
  checkEqual('撤回起点 Trace tombstone', recallTrace.items[0]?.recalled, true);
  await expectCode(
    '撤回消息不能新标记为起点',
    mark(AGENT_ONE, MAIN, recallRoot.message_id),
    'NOT_FOUND',
  );
  await unmark(AGENT_TWO, MAIN, recallRoot.message_id);
  checkEqual(
    '撤回起点可取消标记',
    (await summaries(HUMAN, MAIN, [recallRoot.message_id])).size,
    0,
  );

  console.log('  · 取消标记与重新标记');
  const countBeforeUnmark = (await summaries(HUMAN, MAIN, [rootA.message_id])).get(rootA.message_id)?.message_count;
  const unmarkResult = await unmark(AGENT_TWO, MAIN, rootA.message_id);
  checkEqual('非原标记者可取消标记', unmarkResult.marked, false);
  const unmarkedRoot = await getMessage(d1, rootA.message_id);
  checkEqual('取消后 task_root_id 清空', unmarkedRoot?.task_root_id, null);
  checkEqual('取消后 task_marked_by 清空', unmarkedRoot?.task_marked_by, null);
  checkEqual('取消后 task_marked_at 清空', unmarkedRoot?.task_marked_at, null);
  checkEqual('取消后处理消息保留归属', (await getMessage(d1, a1.message_id))?.task_root_id, rootA.message_id);
  checkEqual('取消后原消息仍存在', (await getMessage(d1, rootA.message_id))?.body, 'TASK-A 起点');
  checkEqual('取消后集合入口消失', (await summaries(HUMAN, MAIN, [rootA.message_id])).size, 0);
  await expectCode(
    '取消后 Trace 不可读',
    messageTaskTrace(d1, await principalFor(AGENT_ONE), {
      room_id: MAIN,
      root_message_id: rootA.message_id,
    }),
    'NOT_FOUND',
  );
  await mark(AGENT_THREE, MAIN, rootA.message_id);
  const restored = (await summaries(HUMAN, MAIN, [rootA.message_id])).get(rootA.message_id);
  checkEqual('重新标记恢复原集合', restored?.message_count, countBeforeUnmark);
  checkEqual('重新标记记录新标记者', (await getMessage(d1, rootA.message_id))?.task_marked_by, AGENT_THREE);

  console.log('  · 权限、历史边界与冲突');
  await expectCode('非成员不能标记', mark(OUTSIDER, MAIN, rootB.message_id), 'NOT_MEMBER');
  await expectCode('非成员不能读摘要', summaries(OUTSIDER, MAIN, [rootB.message_id]), 'NOT_MEMBER');
  await expectCode(
    '非成员不能读 Trace',
    messageTaskTrace(d1, await principalFor(OUTSIDER), {
      room_id: MAIN,
      root_message_id: rootB.message_id,
    }),
    'NOT_MEMBER',
  );
  const unmarkedSummary = await summaries(HUMAN, MAIN, [chatBetween.message_id]);
  checkEqual('未标记消息摘要为空', unmarkedSummary.size, 0);
  await expectCode(
    '未标记消息 Trace 不存在',
    messageTaskTrace(d1, await principalFor(AGENT_ONE), {
      room_id: MAIN,
      root_message_id: chatBetween.message_id,
    }),
    'NOT_FOUND',
  );
  await expectCode(
    '显式归属未标记起点失败',
    send(AGENT_ONE, MAIN, 'EXPLICIT invalid', {
      reply_to: rootB.message_id,
      task_root_id: chatBetween.message_id,
    }),
    'NOT_FOUND',
  );
  await expectCode('标记其他 Task 的处理消息冲突', mark(AGENT_ONE, MAIN, a1.message_id), 'CONFLICT');
  const bCandidate = await send(HUMAN, MAIN, 'B 线程候选', { reply_to: rootB.message_id });
  await expectCode('标记其他 Task 的线程消息冲突', mark(AGENT_ONE, MAIN, bCandidate.message_id), 'CONFLICT');

  const restrictedRoot = await send(HUMAN, RESTRICTED, 'RESTRICTED root');
  await expectCode('无发言权成员不能标记', mark(AGENT_TWO, RESTRICTED, restrictedRoot.message_id), 'PERMISSION_DENIED');
  await mark(HUMAN, RESTRICTED, restrictedRoot.message_id);
  const restrictedSummary = (await summaries(AGENT_TWO, RESTRICTED, [restrictedRoot.message_id])).get(restrictedRoot.message_id);
  checkEqual('只读成员仍可读摘要', restrictedSummary?.can_unmark, false);
  const restrictedVisible = (await summaries(AGENT_TWO, RESTRICTED, [restrictedRoot.message_id])).get(restrictedRoot.message_id);
  checkEqual('群 owner 标记成功', restrictedVisible?.message_count, 1);

  console.log('  · 发送幂等与显式归属冲突');
  const explicitClient = 'cm_mt_explicit';
  const explicitRequest = 'req_mt_explicit_first';
  const explicit = await send(AGENT_ONE, MAIN, 'EXPLICIT A', {
    task_root_id: rootA.message_id,
    client_message_id: explicitClient,
    request_id: explicitRequest,
  });
  checkEqual('显式归属写入', explicit.task_root_id, rootA.message_id);
  const replayed = await send(AGENT_ONE, MAIN, 'EXPLICIT A', {
    task_root_id: rootA.message_id,
    client_message_id: explicitClient,
    request_id: explicitRequest,
  });
  checkEqual('同请求重放返回同一消息', replayed.message_id, explicit.message_id);
  await expectCode(
    '同 client_message_id 改 Task 归属冲突',
    send(AGENT_ONE, MAIN, 'EXPLICIT A', {
      task_root_id: rootB.message_id,
      client_message_id: explicitClient,
    }),
    'IDEMPOTENCY_CONFLICT',
  );

  console.log('  · 事件不写 inbox、不推 head、只提示 human');
  const eventRoot = await send(HUMAN, MAIN, 'EVENT root');
  const beforeMark = await roomState();
  const beforeOutbox = outboxCount();
  const beforeInbox = inboxEventCount();
  const beforePending = pendingCounts();
  const beforeMarkEvents = eventCount(MESSAGE_TASK_MARKED_EVENT);
  const fixedRequest = 'req_mt_event_mark';
  await mark(AGENT_ONE, MAIN, eventRoot.message_id, fixedRequest);
  const afterMark = await roomState();
  checkEqual('标记不推进 head_seq', afterMark.head_seq, beforeMark.head_seq);
  checkEqual('标记不更新房间排序', afterMark.updated_at, beforeMark.updated_at);
  checkEqual('标记不改变 last_message_id', afterMark.last_message_id, beforeMark.last_message_id);
  checkEqual('标记不增加 pending_count', pendingCounts(), beforePending);
  checkEqual('标记不写 inbox 事件', inboxEventCount(), beforeInbox);
  checkEqual('标记只写一条事件', eventCount(MESSAGE_TASK_MARKED_EVENT), beforeMarkEvents + 1);
  checkEqual('标记写 room outbox', outboxCount(), beforeOutbox + 1);
  checkEqual('重复标记同一 request_id 收敛', (await mark(AGENT_ONE, MAIN, eventRoot.message_id, fixedRequest)).marked, true);
  checkEqual('重放不重复事件', eventCount(MESSAGE_TASK_MARKED_EVENT), beforeMarkEvents + 1);
  checkEqual('重放不重复 outbox', outboxCount(), beforeOutbox + 1);
  await expectCode(
    '同 request_id 改目标冲突',
    mark(AGENT_ONE, MAIN, rootB.message_id, fixedRequest),
    'IDEMPOTENCY_CONFLICT',
  );

  const markEvent = db
    .prepare('SELECT * FROM events WHERE event_key = ?')
    .get(`message_task_marked:${eventRoot.message_id}:${fixedRequest}`) as {
    event_seq: number;
    scope_kind: 'room' | 'inbox' | 'actor';
    scope_id: string;
    event_type: string;
    ref_id: string | null;
    metadata: string;
    created_at: number;
  };
  const markOutbox = db
    .prepare('SELECT * FROM outbox WHERE event_seq = ?')
    .get(markEvent.event_seq) as {
    outbox_id: string;
    topic: string;
    attempts: number;
    created_at: number;
  };
  checkEqual('标记事件 scope', `${markEvent.scope_kind}:${markEvent.scope_id}`, `room:${MAIN}`);
  checkEqual('标记 outbox topic', markOutbox.topic, `room:${MAIN}`);
  const members = (
    db
      .prepare(
        `SELECT m.actor_id, a.kind, m.status, m.role, m.joined_seq
           FROM room_members m JOIN actors a ON a.actor_id = m.actor_id
          WHERE m.room_id = ?`,
      )
      .all(MAIN) as Array<{
      actor_id: string;
      kind: 'human' | 'agent';
      status: 'active' | 'left' | 'removed';
      role: 'owner' | 'admin' | 'member';
      joined_seq: number;
    }>
  ).map((row) => ({
    actor_id: row.actor_id,
    kind: row.kind,
    status: row.status,
    role: row.role === 'owner' ? ('owner' as const) : ('member' as const),
    joined_seq: row.joined_seq,
  }));
  const streamRow: OutboxStreamRow = {
    outbox_id: markOutbox.outbox_id,
    topic: markOutbox.topic,
    event_seq: markEvent.event_seq,
    attempts: markOutbox.attempts,
    created_at: markOutbox.created_at,
    scope_kind: markEvent.scope_kind,
    scope_id: markEvent.scope_id,
    event_type: markEvent.event_type,
    ref_id: markEvent.ref_id,
    metadata: markEvent.metadata,
  };
  const items = roomStreamItems(streamRow, JSON.parse(markEvent.metadata) as Record<string, unknown>, members);
  checkEqual('标记提示只发 active human', items.length, 1);
  checkEqual('标记提示接收者', items[0]?.actorId, HUMAN);
  checkEqual('标记提示 source', items[0]?.item.source, 'task.updated');
  checkEqual('标记提示 change', items[0]?.item.change, 'marked');
  checkEqual('标记提示 message_id', items[0]?.item.message_id, eventRoot.message_id);

  const beforeUnmarkState = await roomState();
  const beforeUnmarkOutbox = outboxCount();
  const beforeUnmarkEvents = eventCount(MESSAGE_TASK_UNMARKED_EVENT);
  const unmarkEventFixed = 'req_mt_event_unmark';
  await unmark(AGENT_TWO, MAIN, eventRoot.message_id, unmarkEventFixed);
  const afterUnmarkState = await roomState();
  checkEqual('取消标记不推进 head_seq', afterUnmarkState.head_seq, beforeUnmarkState.head_seq);
  checkEqual('取消标记不更新房间排序', afterUnmarkState.updated_at, beforeUnmarkState.updated_at);
  checkEqual('取消标记不增加 pending_count', pendingCounts(), beforePending);
  checkEqual('取消标记不写 inbox 事件', inboxEventCount(), beforeInbox);
  checkEqual('取消标记写一条事件', eventCount(MESSAGE_TASK_UNMARKED_EVENT), beforeUnmarkEvents + 1);
  checkEqual('取消标记写 room outbox', outboxCount(), beforeUnmarkOutbox + 1);
  await unmark(AGENT_TWO, MAIN, eventRoot.message_id, unmarkEventFixed);
  checkEqual('取消标记重放不重复事件', eventCount(MESSAGE_TASK_UNMARKED_EVENT), beforeUnmarkEvents + 1);

  console.log('  · 历史边界');
  const maxSeq = (db.prepare('SELECT MAX(event_seq) AS n FROM events').get() as { n: number }).n;
  db.prepare(
    `INSERT INTO room_members
       (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
     VALUES (?, ?, 'member', 'active', ?, 0, ?, 1, ?)`,
  ).run(MAIN, LATE, maxSeq + 1, AT, AT);
  checkEqual('后加入成员看不到旧 Task 摘要', (await summaries(LATE, MAIN, [rootB.message_id])).size, 0);
  await expectCode(
    '后加入成员读不到旧 Trace',
    messageTaskTrace(d1, await principalFor(LATE), {
      room_id: MAIN,
      root_message_id: rootB.message_id,
    }),
    'NOT_FOUND',
  );
  await expectCode(
    '后加入成员不能标记加入前消息',
    mark(LATE, MAIN, rootB.message_id),
    'NOT_FOUND',
  );
}

db = openSeededDb();
d1 = createD1(db);
try {
  await runMessageTaskChecks();
  console.log(`消息式 Task / Trace 阶段 1 通过：${checksPassed()} 项检查`);
} finally {
  db.close();
}
