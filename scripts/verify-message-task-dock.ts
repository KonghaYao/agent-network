/**
 * 房间常驻 Task 列表与完成能力的领域验收。
 *
 * 使用内存 SQLite 与真实 migrations，不启动服务、不访问生产。覆盖完成幂等、
 * 并发只保留首次事实、权限/归档/历史边界、open/completed/all 列表、keyset
 * 分页、cursor 过期、tombstone、最近处理消息、summaries/trace/search 的完成态、
 * 事件与 outbox，以及 list 的固定查询条数（无 N+1）。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { BusinessError } from '../src/contracts/errors';
import {
  MESSAGE_TASK_COMPLETED_EVENT,
  MESSAGE_TASK_MARKED_EVENT,
  MESSAGE_TASK_UNMARKED_EVENT,
} from '../src/contracts/events';
import { LIMITS } from '../src/contracts/limits';
import { messageRecall } from '../src/domain/message-recall';
import { messageSend } from '../src/domain/messages';
import { messageTaskComplete } from '../src/domain/message-task-completion';
import { messageTaskList } from '../src/domain/message-task-list';
import { messageTaskSearch } from '../src/domain/message-task-search';
import {
  messageTaskMark,
  messageTaskSummaries,
  messageTaskTrace,
  messageTaskUnmark,
} from '../src/domain/message-tasks';
import type { Principal } from '../src/domain/principal';
import type { OutboxStreamRow } from '../src/realtime/stream';
import { roomStreamItems } from '../src/realtime/stream';
import { getActor, getMessage, getRoom } from '../src/storage/queries';
import type { MessageRow } from '../src/storage/rows';
import { check, checkEqual, CheckFailure, checksPassed } from './lib/harness';

const MIGRATIONS = join(import.meta.dir, '../migrations');
const AT = Date.now();
const HUMAN = 'usr_dock_human';
const LATE = 'usr_dock_late';
const OUTSIDER = 'usr_dock_outsider';
const AGENT_ONE = 'agt_dock_one';
const AGENT_TWO = 'agt_dock_two';
const AGENT_THREE = 'agt_dock_three';
const MAIN = 'rm_dock_main';
const DOCK = 'rm_dock_list';
const RESTRICTED = 'rm_dock_restricted';
const ARCHIVED = 'rm_dock_archived';
const EMPTY = 'rm_dock_empty';
const BOUND = 'rm_dock_bound';
const PERF = 'rm_dock_perf';
const TIE = 'rm_dock_tie';

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
      ('${HUMAN}', 'human', NULL, 'Dock Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${LATE}', 'human', NULL, 'Dock Late', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${OUTSIDER}', 'human', NULL, 'Dock Outsider', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT_ONE}', 'agent', 'sess_dock_one', 'Dock Agent One', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT_TWO}', 'agent', 'sess_dock_two', 'Dock Agent Two', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT_THREE}', 'agent', 'sess_dock_three', 'Dock Agent Three', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
       member_seq, last_message_id, created_at, updated_at)
    VALUES
      ('${MAIN}', 'group', '${HUMAN}', 'Dock Main', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${DOCK}', 'group', '${HUMAN}', 'Dock List', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${RESTRICTED}', 'group', '${HUMAN}', 'Dock Restricted', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${ARCHIVED}', 'group', '${HUMAN}', 'Dock Archived', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${EMPTY}', 'group', '${HUMAN}', 'Dock Empty', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${BOUND}', 'group', '${HUMAN}', 'Dock Bound', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${PERF}', 'group', '${HUMAN}', 'Dock Perf', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${TIE}', 'group', '${HUMAN}', 'Dock Tie', NULL, 0, 0, 0, NULL, ${AT}, ${AT});

    UPDATE rooms SET member_message_policy = 'owner_admin' WHERE room_id = '${RESTRICTED}';

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
    VALUES
      ('${MAIN}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${MAIN}', '${AGENT_ONE}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${MAIN}', '${AGENT_TWO}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${MAIN}', '${AGENT_THREE}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${DOCK}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${DOCK}', '${AGENT_ONE}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${DOCK}', '${AGENT_TWO}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${DOCK}', '${AGENT_THREE}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${RESTRICTED}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${RESTRICTED}', '${AGENT_TWO}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${ARCHIVED}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${ARCHIVED}', '${AGENT_ONE}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${EMPTY}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${BOUND}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${BOUND}', '${AGENT_ONE}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${PERF}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${TIE}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT});
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
  invoke?: string[];
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
    invoke: options.invoke ?? [],
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
): Promise<void> {
  counter += 1;
  await messageTaskMark(d1, await principalFor(actor), {
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
): Promise<void> {
  counter += 1;
  await messageTaskUnmark(d1, await principalFor(actor), {
    request_id: requestId ?? `req_unmark_${counter}`,
    room_id: roomId,
    message_id: messageId,
  });
}

async function complete(
  actor: string,
  roomId: string,
  rootId: string,
  requestId?: string,
) {
  counter += 1;
  return messageTaskComplete(d1, await principalFor(actor), {
    request_id: requestId ?? `req_complete_${counter}`,
    room_id: roomId,
    root_message_id: rootId,
  });
}

async function list(
  actor: string,
  roomId: string,
  options: { limit?: number; cursor?: string; status?: 'open' | 'completed' | 'all' } = {},
) {
  return messageTaskList(d1, await principalFor(actor), {
    room_id: roomId,
    ...options,
  });
}

async function summaries(actor: string, roomId: string, rootIds: string[]) {
  const result = await messageTaskSummaries(d1, await principalFor(actor), {
    room_id: roomId,
    root_message_ids: rootIds,
  });
  return new Map(result.items.map((item) => [item.root_message_id, item]));
}

async function trace(actor: string, roomId: string, rootId: string) {
  return messageTaskTrace(d1, await principalFor(actor), {
    room_id: roomId,
    root_message_id: rootId,
  });
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
    db.prepare('SELECT actor_id, pending_count FROM actors ORDER BY actor_id').all(),
  );
}

function readSeqs(): string {
  return JSON.stringify(
    db.prepare('SELECT room_id, actor_id, last_read_seq FROM room_members ORDER BY room_id, actor_id').all(),
  );
}

async function roomState(roomId: string) {
  const room = await getRoom(d1, roomId);
  if (!room) throw new CheckFailure('room', `房间不存在: ${roomId}`);
  return {
    head_seq: room.head_seq,
    updated_at: room.updated_at,
    last_message_id: room.last_message_id,
  };
}

function insertRoot(
  roomId: string,
  seq: number,
  messageId: string,
  body: string,
  completedBy: string | null = null,
): void {
  db.prepare(
    `INSERT INTO messages
       (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
        preview, reply_to, root_id, hop, root_invocations_used, created_at,
        task_root_id, task_marked_by, task_marked_at, task_completed_at, task_completed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?,
             ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    roomId,
    HUMAN,
    `cm_${messageId}`,
    seq,
    body,
    Buffer.byteLength(body),
    body,
    AT,
    messageId,
    HUMAN,
    AT,
    completedBy === null ? null : AT,
    completedBy,
  );
}

function countingDb(inner: D1Database): { db: D1Database; count: () => number; reset: () => void } {
  let count = 0;
  const proxy = new Proxy(inner, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          count += 1;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
  return { db: proxy, count: () => count, reset: () => { count = 0; } };
}

async function runCompletionChecks(rootA: MessageRow, rootB: MessageRow, rootC: MessageRow): Promise<void> {
  console.log('  · 完成幂等与首次事实');
  const first = await complete(AGENT_ONE, MAIN, rootA.message_id, 'req_dock_complete_a1');
  checkEqual('完成状态', first.status, 'completed');
  checkEqual('完成人', first.completed_by, AGENT_ONE);
  const replayed = await complete(AGENT_ONE, MAIN, rootA.message_id, 'req_dock_complete_a1');
  checkEqual('同 request 重放完成时间', replayed.completed_at, first.completed_at);
  const second = await complete(AGENT_TWO, MAIN, rootA.message_id, 'req_dock_complete_a2');
  checkEqual('不同 request 保留首次完成人', second.completed_by, AGENT_ONE);
  checkEqual('不同 request 保留首次完成时间', second.completed_at, first.completed_at);
  const rowA = await getMessage(d1, rootA.message_id);
  checkEqual('数据库完成人保持首次', rowA?.task_completed_by, AGENT_ONE);
  checkEqual('数据库完成时间保持首次', String(rowA?.task_completed_at), first.completed_at);
  await expectCode(
    '同 request 改目标冲突',
    complete(AGENT_ONE, MAIN, rootB.message_id, 'req_dock_complete_a1'),
    'IDEMPOTENCY_CONFLICT',
  );

  const summaryA = (await summaries(AGENT_ONE, MAIN, [rootA.message_id])).get(rootA.message_id);
  checkEqual('摘要识别 completed', summaryA?.status, 'completed');
  checkEqual('摘要完成人', summaryA?.completed_by, AGENT_ONE);
  checkEqual('摘要已完成不可再完成', summaryA?.can_complete, false);
  checkEqual('摘要仍可取消标记', summaryA?.can_unmark, true);
  const traceA = await trace(AGENT_ONE, MAIN, rootA.message_id);
  checkEqual('Trace 识别 completed', traceA.status, 'completed');
  checkEqual('Trace 完成人', traceA.completed_by, AGENT_ONE);
  check('Trace 仍返回集合', traceA.items.length > 0);
  const searchA = await messageTaskSearch(d1, await principalFor(AGENT_ONE), {
    room_id: MAIN,
    query: 'alpha',
  });
  const searched = searchA.items.find((item) => item.task.root_message_id === rootA.message_id);
  checkEqual('搜索默认包含已完成 Task', searched?.task.status, 'completed');

  const openPage = await list(AGENT_ONE, MAIN);
  check('open 列表排除已完成', !openPage.items.some((item) => item.root_message_id === rootA.message_id));
  const completedPage = await list(AGENT_ONE, MAIN, { status: 'completed', limit: 20 });
  checkEqual('completed 列表包含已完成', completedPage.items.some((item) => item.root_message_id === rootA.message_id), true);
  const allPage = await list(AGENT_ONE, MAIN, { status: 'all', limit: 20 });
  checkEqual('all 列表包含两种状态', allPage.items.some((item) => item.root_message_id === rootA.message_id), true);

  console.log('  · 并发完成只保留首次事件与事实');
  const concurrent = await Promise.all([
    complete(HUMAN, MAIN, rootB.message_id, 'req_dock_concurrent_1'),
    complete(AGENT_TWO, MAIN, rootB.message_id, 'req_dock_concurrent_2'),
  ]);
  checkEqual('并发完成返回同一时间', concurrent[0]?.completed_at, concurrent[1]?.completed_at);
  checkEqual('并发完成返回同一完成人', concurrent[0]?.completed_by, concurrent[1]?.completed_by);
  const completedBEvents = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
          WHERE event_type = ? AND ref_id = ?`,
      )
      .get(MESSAGE_TASK_COMPLETED_EVENT, rootB.message_id) as { n: number }
  ).n;
  checkEqual('并发完成只写一条事件', completedBEvents, 1);

  console.log('  · 完成不清标记、不取消 delivery、不改 head/未读');
  const deliveryRoot = await send(HUMAN, MAIN, 'DELIVERY root', { invoke: [AGENT_ONE] });
  await mark(AGENT_ONE, MAIN, deliveryRoot.message_id);
  const deliveryBefore = db
    .prepare('SELECT delivery_id, state FROM deliveries WHERE message_id = ?')
    .all(deliveryRoot.message_id) as Array<{ delivery_id: string; state: string }>;
  check('投递根已创建 delivery', deliveryBefore.length === 1);
  const beforeState = await roomState(MAIN);
  const beforePending = pendingCounts();
  const beforeReads = readSeqs();
  const beforeInbox = inboxEventCount();
  const beforeCompletedEvents = eventCount(MESSAGE_TASK_COMPLETED_EVENT);
  const beforeOutbox = outboxCount();
  await complete(AGENT_TWO, MAIN, deliveryRoot.message_id, 'req_dock_delivery_complete');
  const afterState = await roomState(MAIN);
  const deliveryAfter = db
    .prepare('SELECT delivery_id, state FROM deliveries WHERE message_id = ?')
    .all(deliveryRoot.message_id) as Array<{ delivery_id: string; state: string }>;
  checkEqual('完成不推进 head_seq', afterState.head_seq, beforeState.head_seq);
  checkEqual('完成不更新房间排序', afterState.updated_at, beforeState.updated_at);
  checkEqual('完成不改变 last_message_id', afterState.last_message_id, beforeState.last_message_id);
  checkEqual('完成不改变 pending_count', pendingCounts(), beforePending);
  checkEqual('完成不改变已读位置', readSeqs(), beforeReads);
  checkEqual('完成不写 inbox 事件', inboxEventCount(), beforeInbox);
  checkEqual('完成只写一条事件', eventCount(MESSAGE_TASK_COMPLETED_EVENT), beforeCompletedEvents + 1);
  checkEqual('完成写 room outbox', outboxCount(), beforeOutbox + 1);
  checkEqual('完成不改变 delivery 状态', JSON.stringify(deliveryAfter), JSON.stringify(deliveryBefore));
  const stillMarked = await getMessage(d1, deliveryRoot.message_id);
  checkEqual('完成不清除 Task 标记', stillMarked?.task_root_id, deliveryRoot.message_id);

  const eventRow = db
    .prepare(
      `SELECT e.event_seq, e.scope_kind, e.scope_id, e.event_type, e.ref_id, e.metadata, e.created_at,
              o.outbox_id, o.topic, o.attempts, o.created_at AS outbox_created_at
         FROM events e JOIN outbox o ON o.event_seq = e.event_seq
        WHERE e.event_type = ? AND e.ref_id = ?`,
    )
    .get(MESSAGE_TASK_COMPLETED_EVENT, deliveryRoot.message_id) as {
    event_seq: number;
    scope_kind: 'room' | 'inbox' | 'actor';
    scope_id: string;
    event_type: string;
    ref_id: string | null;
    metadata: string;
    created_at: number;
    outbox_id: string;
    topic: string;
    attempts: number;
    outbox_created_at: number;
  };
  checkEqual('完成事件 scope', `${eventRow.scope_kind}:${eventRow.scope_id}`, `room:${MAIN}`);
  checkEqual('完成 outbox topic', eventRow.topic, `room:${MAIN}`);
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
  ).map((item) => ({
    actor_id: item.actor_id,
    kind: item.kind,
    status: item.status,
    role: item.role === 'owner' ? ('owner' as const) : ('member' as const),
    joined_seq: item.joined_seq,
  }));
  const streamRow: OutboxStreamRow = {
    outbox_id: eventRow.outbox_id,
    topic: eventRow.topic,
    event_seq: eventRow.event_seq,
    attempts: eventRow.attempts,
    created_at: eventRow.outbox_created_at,
    scope_kind: eventRow.scope_kind,
    scope_id: eventRow.scope_id,
    event_type: eventRow.event_type,
    ref_id: eventRow.ref_id,
    metadata: eventRow.metadata,
  };
  const items = roomStreamItems(
    streamRow,
    JSON.parse(eventRow.metadata) as Record<string, unknown>,
    members,
  );
  checkEqual('完成提示只发 active human', items.length, 1);
  checkEqual('完成提示接收者', items[0]?.actorId, HUMAN);
  checkEqual('完成提示 source', items[0]?.item.source, 'task.updated');
  checkEqual('完成提示 change', items[0]?.item.change, 'completed');
  checkEqual('完成提示 ref_id', items[0]?.item.ref_id, deliveryRoot.message_id);

  console.log('  · 取消标记保留完成元数据，重新标记不 reopen');
  await unmark(HUMAN, MAIN, rootA.message_id);
  const afterUnmark = await getMessage(d1, rootA.message_id);
  checkEqual('取消标记保留完成时间', String(afterUnmark?.task_completed_at), first.completed_at);
  checkEqual('取消标记保留完成人', afterUnmark?.task_completed_by, AGENT_ONE);
  await expectCode('取消后不能再完成', complete(AGENT_ONE, MAIN, rootA.message_id), 'NOT_FOUND');
  await mark(AGENT_TWO, MAIN, rootA.message_id);
  const afterRemark = await getMessage(d1, rootA.message_id);
  checkEqual('重新标记仍保留完成人', afterRemark?.task_completed_by, AGENT_ONE);
  const completeAgain = await complete(AGENT_THREE, MAIN, rootA.message_id);
  checkEqual('重新标记后完成返回首次事实', completeAgain.completed_by, AGENT_ONE);
  checkEqual('重新标记后完成时间不变', completeAgain.completed_at, first.completed_at);
  const remarkedSummary = (await summaries(AGENT_ONE, MAIN, [rootA.message_id])).get(rootA.message_id);
  checkEqual('重新标记仍为 completed', remarkedSummary?.status, 'completed');

  console.log('  · 只读、归档、非成员与历史边界');
  const restrictedRoot = await send(HUMAN, RESTRICTED, 'restricted root');
  await mark(HUMAN, RESTRICTED, restrictedRoot.message_id);
  const mutedPage = await list(AGENT_TWO, RESTRICTED);
  checkEqual('禁言成员可读列表', mutedPage.items.length, 1);
  checkEqual('禁言成员不可完成', mutedPage.items[0]?.can_complete, false);
  checkEqual('禁言成员不可取消', mutedPage.items[0]?.can_unmark, false);
  await expectCode(
    '禁言成员完成返回 PERMISSION_DENIED',
    complete(AGENT_TWO, RESTRICTED, restrictedRoot.message_id),
    'PERMISSION_DENIED',
  );
  await expectCode('非成员不能读列表', list(OUTSIDER, MAIN), 'NOT_MEMBER');
  await expectCode('非成员不能完成', complete(OUTSIDER, MAIN, deliveryRoot.message_id), 'NOT_MEMBER');

  const archivedRoot = await send(HUMAN, ARCHIVED, 'archived root');
  await mark(HUMAN, ARCHIVED, archivedRoot.message_id);
  const archivedRoom = await getRoom(d1, ARCHIVED);
  const archiveHead = archivedRoom?.head_seq ?? 0;
  db.prepare('UPDATE rooms SET dissolved_at = ?, archive_head_seq = ? WHERE room_id = ?').run(
    AT,
    archiveHead,
    ARCHIVED,
  );
  insertRoot(ARCHIVED, archiveHead + 1, 'msg_dock_after_archive', 'after archive');
  const archivedPage = await list(AGENT_ONE, ARCHIVED, { status: 'all' });
  checkEqual('归档列表只读到上界内起点', archivedPage.total_count, 1);
  checkEqual('归档仍可读', archivedPage.items[0]?.root_message_id, archivedRoot.message_id);
  checkEqual('归档不可完成', archivedPage.items[0]?.can_complete, false);
  await expectCode(
    '归档完成被拒绝',
    complete(AGENT_ONE, ARCHIVED, archivedRoot.message_id),
    'PERMISSION_DENIED',
  );

  const boundOld = await send(HUMAN, BOUND, 'bound old');
  await mark(HUMAN, BOUND, boundOld.message_id);
  const maxEvent = (db.prepare('SELECT MAX(event_seq) AS n FROM events').get() as { n: number }).n;
  db.prepare(
    `INSERT INTO room_members
       (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
     VALUES (?, ?, 'member', 'active', ?, 0, ?, 1, ?)`,
  ).run(BOUND, LATE, maxEvent + 1, AT, AT);
  const boundNew = await send(HUMAN, BOUND, 'bound new');
  await mark(HUMAN, BOUND, boundNew.message_id);
  const latePage = await list(LATE, BOUND);
  checkEqual('后加入成员只看到加入后起点', latePage.total_count, 1);
  checkEqual('后加入成员看到新起点', latePage.items[0]?.root_message_id, boundNew.message_id);
  await expectCode('后加入成员不能完成旧起点', complete(LATE, BOUND, boundOld.message_id), 'NOT_FOUND');
}

async function runListChecks(): Promise<void> {
  console.log('  · 列表 open/completed/all、分页与 total_count');
  const source = await send(HUMAN, DOCK, 'DOCK source');
  const d1Root = await send(HUMAN, DOCK, 'DOCK one alpha');
  await mark(HUMAN, DOCK, d1Root.message_id);
  const d1m1 = await send(AGENT_ONE, DOCK, 'DOCK one m1', { reply_to: d1Root.message_id });
  const d1m2 = await send(AGENT_TWO, DOCK, 'DOCK one m2', { reply_to: d1m1.message_id });
  const d1m3 = await send(AGENT_ONE, DOCK, 'DOCK one m3', { reply_to: d1Root.message_id });
  const d1m4 = await send(HUMAN, DOCK, 'DOCK one m4', { reply_to: d1Root.message_id });
  const d1m5 = await send(AGENT_THREE, DOCK, 'DOCK one m5', { reply_to: d1Root.message_id });
  const refMember = await send(AGENT_ONE, DOCK, 'DOCK one ref', {
    reply_to: source.message_id,
    task_root_id: d1Root.message_id,
  });

  const d2Root = await send(AGENT_ONE, DOCK, 'DOCK two');
  await mark(AGENT_TWO, DOCK, d2Root.message_id);
  const d3Root = await send(AGENT_TWO, DOCK, 'DOCK three');
  await mark(HUMAN, DOCK, d3Root.message_id);
  const d4Root = await send(AGENT_ONE, DOCK, 'DOCK four');
  await mark(AGENT_THREE, DOCK, d4Root.message_id);

  const page1 = await list(AGENT_ONE, DOCK, { limit: 2 });
  checkEqual('open 首页条数', page1.items.length, 2);
  checkEqual('open 首页顺序', page1.items.map((item) => item.root_message_id).join(','), `${d4Root.message_id},${d3Root.message_id}`);
  checkEqual('total_count 不受 limit 影响', page1.total_count, 4);
  checkEqual('首页 has_more', page1.has_more, true);
  check('首页返回 next_cursor', page1.next_cursor !== null);

  const d1Item = page1.items.find((item) => item.root_message_id === d1Root.message_id);
  checkEqual('首页不含第二页项', d1Item, undefined);
  const detail = await list(AGENT_ONE, DOCK, { status: 'all', limit: 20 });
  const d1Detail = detail.items.find((item) => item.root_message_id === d1Root.message_id);
  if (!d1Detail) throw new CheckFailure('list', '缺少 D1 列表项');
  checkEqual('列表消息数含一层引用', d1Detail.message_count, 8);
  checkEqual('列表参与者完整计数', d1Detail.participant_count, 3);
  checkEqual('列表参与者展示上限', d1Detail.participants.length, 3);
  checkEqual('最近活动为最新处理消息', d1Detail.latest_message_id, refMember.message_id);
  checkEqual('最近处理消息条数', d1Detail.recent_messages.length, 3);
  checkEqual(
    '最近处理消息按时间升序',
    d1Detail.recent_messages.map((item) => item.message_id).join(','),
    [d1m4.message_id, d1m5.message_id, refMember.message_id].join(','),
  );
  checkEqual('最近处理消息不含引用来源', d1Detail.recent_messages.some((item) => item.message_id === source.message_id), false);
  checkEqual(
    '最近处理消息只保留最新三条',
    d1Detail.recent_messages.some(
      (item) => item.message_id === d1m2.message_id || item.message_id === d1m3.message_id,
    ),
    false,
  );
  checkEqual('列表 can_complete', d1Detail.can_complete, true);

  const noise = await send(HUMAN, DOCK, 'DOCK noise unmarked');
  checkEqual('普通消息不进入列表', noise.task_root_id, null);
  const page2 = await list(AGENT_ONE, DOCK, { limit: 2, cursor: page1.next_cursor! });
  checkEqual('普通新消息不使游标过期', page2.items.length, 2);
  checkEqual('第二页 total_count 稳定', page2.total_count, 4);
  const union = [...page1.items, ...page2.items].map((item) => item.root_message_id);
  checkEqual('分页无重复', new Set(union).size, union.length);
  checkEqual('分页覆盖全部根', union.join(','), [d4Root.message_id, d3Root.message_id, d2Root.message_id, d1Root.message_id].join(','));
  checkEqual('第二页 has_more', page2.has_more, false);

  await expectCode(
    'cursor 不能跨 status',
    list(AGENT_ONE, DOCK, { status: 'completed', cursor: page1.next_cursor! }),
    'CURSOR_EXPIRED',
  );
  await expectCode(
    'cursor 不能跨房间',
    list(AGENT_ONE, MAIN, { cursor: page1.next_cursor! }),
    'INVALID_ARGUMENT',
  );

  const d5Root = await send(HUMAN, DOCK, 'DOCK five');
  await mark(HUMAN, DOCK, d5Root.message_id);
  await expectCode(
    'mark 使旧 cursor 过期',
    list(AGENT_ONE, DOCK, { limit: 2, cursor: page1.next_cursor! }),
    'CURSOR_EXPIRED',
  );

  const fresh = await list(AGENT_ONE, DOCK, { limit: 2 });
  await complete(AGENT_ONE, DOCK, d2Root.message_id, 'req_dock_list_complete_d2');
  await expectCode(
    'complete 使旧 cursor 过期',
    list(AGENT_ONE, DOCK, { limit: 2, cursor: fresh.next_cursor! }),
    'CURSOR_EXPIRED',
  );

  const freshAfterComplete = await list(AGENT_ONE, DOCK, { limit: 2 });
  const humanMember = await send(HUMAN, DOCK, 'DOCK recall member', { reply_to: d1Root.message_id });
  await recall(HUMAN, humanMember.message_id);
  await expectCode(
    'recall 使旧 cursor 过期',
    list(AGENT_ONE, DOCK, { limit: 2, cursor: freshAfterComplete.next_cursor! }),
    'CURSOR_EXPIRED',
  );

  const completed = await list(AGENT_ONE, DOCK, { status: 'completed', limit: 20 });
  checkEqual('completed 过滤条数', completed.total_count, 1);
  checkEqual('completed 过滤内容', completed.items[0]?.root_message_id, d2Root.message_id);
  checkEqual('completed 状态字段', completed.items[0]?.status, 'completed');
  const openAfter = await list(AGENT_ONE, DOCK, { status: 'open', limit: 20 });
  checkEqual('open 过滤排除 completed', openAfter.items.some((item) => item.root_message_id === d2Root.message_id), false);
  const all = await list(AGENT_ONE, DOCK, { status: 'all', limit: 20 });
  checkEqual('all 包含 completed', all.total_count, openAfter.total_count + completed.total_count);

  console.log('  · tombstone 起点仍显示');
  const tombRoot = await send(HUMAN, DOCK, 'DOCK tombstone');
  await mark(HUMAN, DOCK, tombRoot.message_id);
  await recall(HUMAN, tombRoot.message_id);
  const tombPage = await list(AGENT_ONE, DOCK, { status: 'all', limit: 20 });
  const tombItem = tombPage.items.find((item) => item.root_message_id === tombRoot.message_id);
  if (!tombItem) throw new CheckFailure('list', '撤回起点未出现在列表');
  checkEqual('撤回起点保留 tombstone', tombItem.preview, TOMBSTONE);
  checkEqual('撤回起点状态仍 open', tombItem.status, 'open');
  checkEqual('撤回起点消息数', tombItem.message_count, 1);

  console.log('  · 空房间正视空态');
  const empty = await list(HUMAN, EMPTY);
  checkEqual('空列表 items', empty.items.length, 0);
  checkEqual('空列表 total_count', empty.total_count, 0);
  checkEqual('空列表 has_more', empty.has_more, false);
  checkEqual('空列表 next_cursor', empty.next_cursor, null);

  console.log('  · 完成态列表的完成人/时间');
  checkEqual('completed 完成人', completed.items[0]?.completed_by, AGENT_ONE);
  check('completed 完成时间存在', typeof completed.items[0]?.completed_at === 'string');
  checkEqual('completed 不可完成', completed.items[0]?.can_complete, false);
  checkEqual('completed 仍可取消', completed.items[0]?.can_unmark, true);

  const beforeUnmarkCursor = await list(AGENT_ONE, DOCK, { limit: 2 });
  await unmark(HUMAN, DOCK, d5Root.message_id);
  await expectCode(
    'unmark 使旧 cursor 过期',
    list(AGENT_ONE, DOCK, { limit: 2, cursor: beforeUnmarkCursor.next_cursor! }),
    'CURSOR_EXPIRED',
  );
}

async function runNoNPlusOneChecks(): Promise<void> {
  console.log('  · 列表固定查询条数与响应大小');
  for (let index = 1; index <= 25; index += 1) {
    insertRoot(PERF, index, `msg_dock_perf_${index}`, `PERF root ${index}`);
  }
  db.prepare('UPDATE rooms SET head_seq = 25 WHERE room_id = ?').run(PERF);

  const counted = countingDb(d1);
  counted.reset();
  const one = await messageTaskList(counted.db, await principalFor(HUMAN), {
    room_id: PERF,
    limit: 1,
  });
  const oneCount = counted.count();
  counted.reset();
  const many = await messageTaskList(counted.db, await principalFor(HUMAN), {
    room_id: PERF,
    limit: 20,
  });
  const manyCount = counted.count();
  checkEqual('limit 1 返回一条', one.items.length, 1);
  checkEqual('limit 20 返回二十条', many.items.length, 20);
  checkEqual('页大小不增加 SQL 条数', manyCount, oneCount);
  check('列表响应低于工具响应上限', JSON.stringify(many).length < LIMITS.toolResponseBytes);
  checkEqual('默认 limit 为 20', (await list(HUMAN, PERF)).items.length, 20);

  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT message_id FROM messages
        WHERE room_id = ? AND task_root_id = message_id
          AND created_seq >= 0 AND created_seq <= ?
          AND task_completed_at IS NULL
        ORDER BY created_seq DESC, message_id DESC
        LIMIT 21`,
    )
    .all(PERF, 25) as Array<{ detail: string }>;
  console.log(`    EXPLAIN QUERY PLAN: ${plan.map((row) => row.detail).join(' | ')}`);
}

async function runTieChecks(): Promise<void> {
  console.log('  · 相同 created_seq 的 keyset 分页');
  insertRoot(TIE, 10, 'msg_dock_tie_b', 'TIE b');
  insertRoot(TIE, 10, 'msg_dock_tie_a', 'TIE a');
  insertRoot(TIE, 10, 'msg_dock_tie_c', 'TIE c');
  db.prepare('UPDATE rooms SET head_seq = 10 WHERE room_id = ?').run(TIE);
  const first = await list(HUMAN, TIE, { limit: 2 });
  checkEqual('同序号首页条数', first.items.length, 2);
  checkEqual('同序号按 message_id DESC 排序', first.items.map((item) => item.root_message_id).join(','), 'msg_dock_tie_c,msg_dock_tie_b');
  const second = await list(HUMAN, TIE, { limit: 2, cursor: first.next_cursor! });
  checkEqual('同序号第二页条数', second.items.length, 1);
  checkEqual('同序号第二页内容', second.items[0]?.root_message_id, 'msg_dock_tie_a');
  checkEqual('同序号分页无重复', new Set([...first.items, ...second.items].map((item) => item.root_message_id)).size, 3);
}

async function main(): Promise<void> {
  db = openSeededDb();
  d1 = createD1(db);
  try {
    console.log('· 完成与既有读路径');
    const source = await send(HUMAN, MAIN, 'MAIN source');
    const rootA = await send(HUMAN, MAIN, 'MAIN alpha');
    await mark(HUMAN, MAIN, rootA.message_id);
    await send(AGENT_ONE, MAIN, 'MAIN a m1', { reply_to: rootA.message_id });
    await send(AGENT_TWO, MAIN, 'MAIN a m2', { reply_to: rootA.message_id });
    await send(AGENT_THREE, MAIN, 'MAIN a m3', { reply_to: rootA.message_id });
    await send(AGENT_ONE, MAIN, 'MAIN a ref', {
      reply_to: source.message_id,
      task_root_id: rootA.message_id,
    });
    const rootB = await send(AGENT_ONE, MAIN, 'MAIN beta');
    await mark(AGENT_TWO, MAIN, rootB.message_id);
    const rootC = await send(AGENT_TWO, MAIN, 'MAIN gamma');
    await mark(HUMAN, MAIN, rootC.message_id);
    await runCompletionChecks(rootA, rootB, rootC);

    console.log('· 房间列表');
    await runListChecks();
    await runNoNPlusOneChecks();
    await runTieChecks();

    checkEqual('unmarked 事件仍存在', eventCount(MESSAGE_TASK_UNMARKED_EVENT) > 0, true);
    checkEqual('marked 事件仍存在', eventCount(MESSAGE_TASK_MARKED_EVENT) > 0, true);
    console.log(`Task 列表与完成验收通过：${checksPassed()} 项检查`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
