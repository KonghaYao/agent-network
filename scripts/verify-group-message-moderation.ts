/**
 * 群主消息管理 v1 专项探针。
 *
 * 在隔离的内存 SQLite 上应用全部迁移，直接调用领域函数并检查持久行：
 * owner 撤回、delivery 取消、置顶上限/幂等/历史边界、审计与事件。
 * 不启动 HTTP 服务，不读取 `.data`，不访问生产。
 *
 * 运行：`bun scripts/verify-group-message-moderation.ts`
 */
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { LIMITS } from '../src/contracts/limits';
import { BusinessError } from '../src/contracts/errors';
import { deliveryClaim, deliveryRetry } from '../src/domain/deliveries';
import { messageRecall } from '../src/domain/message-recall';
import { roomMessagePin } from '../src/domain/room-message-pins';
import { roomGet } from '../src/domain/rooms';
import { sync } from '../src/domain/sync';
import type { Principal } from '../src/domain/principal';
import { getActor } from '../src/storage/queries';
import { sha256Hex } from '../src/storage/db';
import { check, checkEqual, checksPassed } from './lib/harness';

const NOW = Date.now();

const sqlite = new Database(':memory:');
migrate(sqlite, join(import.meta.dir, '../migrations'));
sqlite.exec('PRAGMA foreign_keys = ON');
const db = createD1(sqlite);

sqlite.exec(`
  INSERT INTO actors (actor_id, kind, name, created_at, updated_at) VALUES
    ('owner', 'human', 'Owner', ${NOW}, ${NOW}),
    ('admin', 'human', 'Admin', ${NOW}, ${NOW}),
    ('member', 'human', 'Member', ${NOW}, ${NOW}),
    ('agent', 'agent', 'Agent', ${NOW}, ${NOW}),
    ('agent_pending', 'agent', 'Pending', ${NOW}, ${NOW}),
    ('agent_claimed', 'agent', 'Claimed', ${NOW}, ${NOW}),
    ('agent_done', 'agent', 'Done', ${NOW}, ${NOW}),
    ('agent_failed', 'agent', 'Failed', ${NOW}, ${NOW}),
    ('agent_cancelled', 'agent', 'Cancelled', ${NOW}, ${NOW}),
    ('outsider', 'human', 'Outsider', ${NOW}, ${NOW});

  INSERT INTO rooms (room_id, kind, owner_id, title, created_at, updated_at) VALUES
    ('room', 'group', 'owner', 'Moderation', ${NOW}, ${NOW}),
    ('direct', 'direct', 'owner', 'DM', ${NOW}, ${NOW});

  INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, joined_at, updated_at) VALUES
    ('room', 'owner', 'owner', 'active', 0, ${NOW}, ${NOW}),
    ('room', 'admin', 'admin', 'active', 0, ${NOW}, ${NOW}),
    ('room', 'member', 'member', 'active', 0, ${NOW}, ${NOW}),
    ('room', 'agent', 'member', 'active', 0, ${NOW}, ${NOW}),
    ('direct', 'owner', 'owner', 'active', 0, ${NOW}, ${NOW});

  INSERT INTO messages
    (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes, preview, created_at)
  VALUES
    ('msg_old', 'room', 'member', 'c_old', 1, 'old text', 8, 'old text', ${NOW - 600_000}),
    ('msg_fresh', 'room', 'member', 'c_fresh', 2, 'fresh text', 10, 'fresh text', ${NOW}),
    ('msg_agent', 'room', 'agent', 'c_agent', 3, 'agent text', 10, 'agent text', ${NOW}),
    ('msg_work', 'room', 'member', 'c_work', 4, 'do work', 7, 'do work', ${NOW}),
    ('msg_file', 'room', 'member', 'c_file', 5, 'file body', 9, '[文件] report.pdf', ${NOW}),
    ('msg_direct', 'direct', 'owner', 'c_direct', 6, 'dm', 2, 'dm', ${NOW}),
    ('msg_pin1', 'room', 'member', 'c_pin1', 10, 'pin one', 7, 'pin one', ${NOW}),
    ('msg_pin2', 'room', 'member', 'c_pin2', 11, 'pin two', 7, 'pin two', ${NOW}),
    ('msg_pin3', 'room', 'member', 'c_pin3', 12, 'pin three', 9, 'pin three', ${NOW}),
    ('msg_pin4', 'room', 'member', 'c_pin4', 13, 'pin four', 8, 'pin four', ${NOW});

  INSERT INTO deliveries
    (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id, created_seq, created_at, updated_at)
  VALUES
    ('dlv_pending', 'agent_pending', 'msg_work', 'room', 'pending', 0, NULL, 4, ${NOW}, ${NOW}),
    ('dlv_claimed', 'agent_claimed', 'msg_work', 'room', 'claimed', 1, 'claim_1', 4, ${NOW}, ${NOW}),
    ('dlv_done', 'agent_done', 'msg_work', 'room', 'completed', 1, 'claim_0', 4, ${NOW}, ${NOW}),
    ('dlv_failed', 'agent_failed', 'msg_work', 'room', 'failed', 1, NULL, 4, ${NOW}, ${NOW}),
    ('dlv_cancelled', 'agent_cancelled', 'msg_work', 'room', 'cancelled', 1, NULL, 4, ${NOW}, ${NOW});

  UPDATE actors SET pending_count = 1 WHERE actor_id = 'agent_pending';

  INSERT INTO room_files
    (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256, created_at, expires_at)
  VALUES
    ('rf_1', 'room', 'file_1', 'member', 'report.pdf', 'application/pdf', 9,
     '${'a'.repeat(64)}', ${NOW}, ${NOW + 86_400_000});
`);

async function principalOf(actor: string): Promise<Principal> {
  const row = await getActor(db, actor);
  assert.ok(row, actor);
  return { actor: row, credential: null, credentialHash: 'test' };
}

const owner = await principalOf('owner');
const admin = await principalOf('admin');
const member = await principalOf('member');
const agent = await principalOf('agent');
const agentPending = await principalOf('agent_pending');
const agentClaimed = await principalOf('agent_claimed');
const outsider = await principalOf('outsider');

function row<T>(sql: string, ...params: unknown[]): T {
  return sqlite.prepare(sql).get(...(params as never[])) as T;
}
function rows<T>(sql: string, ...params: unknown[]): T[] {
  return sqlite.prepare(sql).all(...(params as never[])) as T[];
}
function count(sql: string, ...params: unknown[]): number {
  return (row<{ n: number }>(sql, ...params) ?? { n: 0 }).n;
}
function checkJson(label: string, actual: unknown, expected: unknown): void {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

async function expectCode(
  label: string,
  code: string,
  run: () => Promise<unknown>,
  reason?: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof BusinessError, `${label}: ${String(error)}`);
    checkEqual(`${label} code`, error.code, code);
    if (reason !== undefined) checkEqual(`${label} reason`, error.details?.reason, reason);
    return;
  }
  check(`${label} 抛出 ${code}`, false);
}

async function expect<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    check(`${label} 未抛错`, false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// ---- 授权矩阵 ----
await expectCode('admin 撤回他人', 'PERMISSION_DENIED', () =>
  messageRecall(db, admin, { request_id: 'r_admin', message_id: 'msg_fresh' }),
);
await expectCode('member 撤回他人', 'PERMISSION_DENIED', () =>
  messageRecall(db, member, { request_id: 'r_member', message_id: 'msg_agent' }),
);
await expectCode('agent 自撤回', 'PERMISSION_DENIED', () =>
  messageRecall(db, agent, { request_id: 'r_agent', message_id: 'msg_agent' }),
);
await expectCode('非成员撤回', 'NOT_MEMBER', () =>
  messageRecall(db, outsider, { request_id: 'r_outsider', message_id: 'msg_fresh' }),
);
await expectCode('普通成员撤回过期自己消息', 'CONFLICT', () =>
  messageRecall(db, member, { request_id: 'r_old_self', message_id: 'msg_old' }),
);
await expectCode('普通成员撤回含投递消息', 'CONFLICT', () =>
  messageRecall(db, member, { request_id: 'r_work_self', message_id: 'msg_work' }),
);
checkEqual(
  '拒绝路径不写 operations',
  count("SELECT COUNT(*) AS n FROM operations WHERE request_id IN ('r_admin','r_member','r_agent','r_outsider','r_old_self','r_work_self')"),
  0,
);

// ---- 普通成员撤回自己的新消息（原规则） ----
await expect('member 自撤回新消息', () =>
  messageRecall(db, member, { request_id: 'r_self', message_id: 'msg_fresh' }),
);
checkJson(
  '自撤回清空正文',
  row<{ body: string; body_bytes: number; preview: string }>(
    'SELECT body, body_bytes, preview FROM messages WHERE message_id = ?',
    'msg_fresh',
  ),
  { body: '', body_bytes: 0, preview: '此消息已撤回' },
);
checkJson(
  '自撤回事件保留 sender/recalled_by',
  row<{ sender_id: string; recalled_by: string }>(
    `SELECT json_extract(metadata, '$.sender_id') AS sender_id,
            json_extract(metadata, '$.recalled_by') AS recalled_by
       FROM events WHERE event_type = 'message_recalled' AND ref_id = ?`,
    'msg_fresh',
  ),
  { sender_id: 'member', recalled_by: 'member' },
);

// ---- owner 撤回旧消息（不限时、他人） ----
const oldHash = await sha256Hex('old text');
await expect('owner 撤回旧消息', () =>
  messageRecall(db, owner, { request_id: 'r_owner_old', message_id: 'msg_old' }),
);
checkJson(
  'owner 撤回 tombstone',
  row<{ body: string; body_bytes: number; preview: string }>(
    'SELECT body, body_bytes, preview FROM messages WHERE message_id = ?',
    'msg_old',
  ),
  { body: '', body_bytes: 0, preview: '此消息已撤回' },
);
checkJson(
  'owner 撤回保留原作者并记录 recalled_by',
  row<{ sender_id: string; recalled_by: string; body_sha256: string }>(
    `SELECT json_extract(metadata, '$.sender_id') AS sender_id,
            json_extract(metadata, '$.recalled_by') AS recalled_by,
            json_extract(metadata, '$.body_sha256') AS body_sha256
       FROM events WHERE event_type = 'message_recalled' AND ref_id = ?`,
    'msg_old',
  ),
  { sender_id: 'member', recalled_by: 'owner', body_sha256: oldHash },
);
checkJson(
  'owner 撤回写 message_recalled 审计',
  row<{ detail: string; target: string | null }>(
    `SELECT detail_json AS detail, target_actor_id AS target
       FROM room_management_audit WHERE action = 'message_recalled' AND room_id = 'room'`,
  ),
  { detail: '{"message_id":"msg_old"}', target: null },
);
const syncPage = await expect('sync 读取撤回事件', () =>
  sync(db, owner, { scope: 'room:room', limit: 200 }),
);
const recallEvent = syncPage.items.find(
  (item) => item.type === 'message_recalled' && item.ref_id === 'msg_old',
);
check('sync 返回撤回事件定位', recallEvent !== undefined);
check(
  'sync 不暴露内部 operation_nonce',
  recallEvent !== undefined && !('operation_nonce' in recallEvent.metadata),
  recallEvent?.metadata,
);
checkEqual(
  'sync 事件保留 recalled_by',
  recallEvent?.metadata.recalled_by,
  'owner',
);
check(
  '审计不包含正文/预览/摘要',
  !JSON.stringify(
    rows('SELECT * FROM room_management_audit WHERE action = ?', 'message_recalled'),
  ).includes('old text'),
);

// 已撤回 fresh request 幂等且不重复事件/审计
const auditBefore = count("SELECT COUNT(*) AS n FROM room_management_audit WHERE action = 'message_recalled'");
await expect('owner 再次撤回已撤回消息', () =>
  messageRecall(db, owner, { request_id: 'r_owner_again', message_id: 'msg_old' }),
);
checkEqual(
  '已撤回 fresh request 不重复审计',
  count("SELECT COUNT(*) AS n FROM room_management_audit WHERE action = 'message_recalled'"),
  auditBefore,
);
checkEqual(
  '已撤回 fresh request 不重建事件',
  count("SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_recalled' AND ref_id = ?", 'msg_old'),
  1,
);

// request_id 重放与 payload 冲突
await expect('同 request_id 同 payload 重放', () =>
  messageRecall(db, owner, { request_id: 'r_owner_old', message_id: 'msg_old' }),
);
await expectCode('同 request_id 不同 message_id', 'IDEMPOTENCY_CONFLICT', () =>
  messageRecall(db, owner, { request_id: 'r_owner_old', message_id: 'msg_agent' }),
);

// ---- 事件 GC 后再次撤回不补写提示 ----
sqlite.exec("DELETE FROM outbox; DELETE FROM events WHERE event_type = 'message_recalled' AND ref_id = 'msg_old'");
const outboxBefore = count('SELECT COUNT(*) AS n FROM outbox');
await expect('事件 GC 后撤回', () =>
  messageRecall(db, owner, { request_id: 'r_owner_gc', message_id: 'msg_old' }),
);
checkEqual('事件 GC 后不重建事件', count("SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_recalled' AND ref_id = ?", 'msg_old'), 0);
checkEqual('事件 GC 后不补写 outbox', count('SELECT COUNT(*) AS n FROM outbox'), outboxBefore);
checkEqual(
  '事件 GC 后不重复审计',
  count("SELECT COUNT(*) AS n FROM room_management_audit WHERE action = 'message_recalled'"),
  auditBefore,
);

// ---- owner 撤回 agent 消息 ----
await expect('owner 撤回 agent 消息', () =>
  messageRecall(db, owner, { request_id: 'r_agent_owner', message_id: 'msg_agent' }),
);
checkJson(
  'agent 消息事件 sender 仍是 agent',
  row<{ sender_id: string }>(
    `SELECT json_extract(metadata, '$.sender_id') AS sender_id
       FROM events WHERE event_type = 'message_recalled' AND ref_id = ?`,
    'msg_agent',
  ),
  { sender_id: 'agent' },
);

// ---- delivery 取消 ----
await expect('owner 撤回含投递消息', () =>
  messageRecall(db, owner, { request_id: 'r_work_owner', message_id: 'msg_work' }),
);
checkJson(
  'pending/claimed 转 cancelled，终态保留',
  rows<{ delivery_id: string; state: string; error: string | null; attempt: number; claim_id: string | null }>(
    'SELECT delivery_id, state, error, attempt, claim_id FROM deliveries ORDER BY delivery_id',
  ),
  [
    { delivery_id: 'dlv_cancelled', state: 'cancelled', error: null, attempt: 1, claim_id: null },
    { delivery_id: 'dlv_claimed', state: 'cancelled', error: 'message_recalled', attempt: 1, claim_id: 'claim_1' },
    { delivery_id: 'dlv_done', state: 'completed', error: null, attempt: 1, claim_id: 'claim_0' },
    { delivery_id: 'dlv_failed', state: 'failed', error: null, attempt: 1, claim_id: null },
    { delivery_id: 'dlv_pending', state: 'cancelled', error: 'message_recalled', attempt: 0, claim_id: null },
  ],
);
checkEqual(
  'pending_count 只扣 pending',
  row<{ pending_count: number }>('SELECT pending_count FROM actors WHERE actor_id = ?', 'agent_pending')?.pending_count,
  0,
);
checkEqual(
  '两个取消事件',
  count("SELECT COUNT(*) AS n FROM events WHERE event_type = 'delivery_cancelled' AND scope_kind = 'inbox'"),
  2,
);
checkJson(
  '取消事件 previous_state 正确',
  rows<{ state: string; reason: string }>(
    `SELECT json_extract(metadata, '$.previous_state') AS state,
            json_extract(metadata, '$.reason') AS reason
       FROM events WHERE event_type = 'delivery_cancelled' AND scope_kind = 'inbox'
       ORDER BY json_extract(metadata, '$.previous_state')`,
  ),
  [
    { state: 'claimed', reason: 'message_recalled' },
    { state: 'pending', reason: 'message_recalled' },
  ],
);
checkEqual(
  'room delivery 回执同批写入',
  count("SELECT COUNT(*) AS n FROM events WHERE event_type = 'delivery_cancelled' AND scope_kind = 'room'"),
  2,
);
await expectCode('撤回后 retry 被拒绝', 'CONFLICT', () =>
  deliveryRetry(db, agentClaimed, { request_id: 'r_retry', delivery_id: 'dlv_claimed', expected_attempt: 1 }),
  'message_recalled',
);
await expectCode('撤回后 claim 被拒绝', 'CONFLICT', () =>
  deliveryClaim(db, agentPending, { request_id: 'r_claim', delivery_id: 'dlv_pending' }),
  'message_recalled',
);
checkEqual(
  '消息正文清空后无半条投递',
  count("SELECT COUNT(*) AS n FROM deliveries WHERE message_id = 'msg_work' AND state IN ('pending','claimed')"),
  0,
);

// ---- 历史边界 ----
sqlite.exec(`
  UPDATE rooms SET member_history_policy = 'from_join' WHERE room_id = 'room';
  UPDATE room_members SET joined_seq = 10 WHERE room_id = 'room' AND actor_id = 'admin';
`);
await expectCode('from_join 撤回加入前消息', 'NOT_FOUND', () =>
  messageRecall(db, admin, { request_id: 'r_bound_admin', message_id: 'msg_file' }),
);
sqlite.exec(`
  UPDATE room_members SET joined_seq = 10 WHERE room_id = 'room' AND actor_id = 'owner';
`);
await expectCode('from_join owner 撤回加入前消息', 'NOT_FOUND', () =>
  messageRecall(db, owner, { request_id: 'r_bound_owner', message_id: 'msg_file' }),
);
checkEqual(
  '边界拒绝不写 operations',
  count("SELECT COUNT(*) AS n FROM operations WHERE request_id IN ('r_bound_admin','r_bound_owner')"),
  0,
);
sqlite.exec(`
  UPDATE rooms SET member_history_policy = 'full' WHERE room_id = 'room';
  UPDATE room_members SET joined_seq = 0 WHERE room_id = 'room' AND actor_id IN ('admin','owner');
`);

// ---- 置顶 ----
await expectCode('普通成员置顶', 'PERMISSION_DENIED', () =>
  roomMessagePin(db, member, { request_id: 'p_member', room_id: 'room', message_id: 'msg_agent', pinned: true }),
);
await expectCode('admin 置顶', 'PERMISSION_DENIED', () =>
  roomMessagePin(db, admin, { request_id: 'p_admin', room_id: 'room', message_id: 'msg_agent', pinned: true }),
);
await expectCode('direct 置顶', 'INVALID_ARGUMENT', () =>
  roomMessagePin(db, owner, { request_id: 'p_direct', room_id: 'direct', message_id: 'msg_direct', pinned: true }),
);
await expectCode('跨房间置顶', 'NOT_FOUND', () =>
  roomMessagePin(db, owner, { request_id: 'p_cross', room_id: 'room', message_id: 'msg_direct', pinned: true }),
);
await expectCode('已撤回消息置顶', 'CONFLICT', () =>
  roomMessagePin(db, owner, { request_id: 'p_recalled', room_id: 'room', message_id: 'msg_old', pinned: true }),
  'message_recalled',
);

const pin1 = await expect('置顶第一条', () =>
  roomMessagePin(db, owner, { request_id: 'p1', room_id: 'room', message_id: 'msg_pin1', pinned: true }),
);
checkJson('置顶确认结果', pin1, { room_id: 'room', message_id: 'msg_pin1', pinned: true });
const roomBeforePin = row<{ head_seq: number; member_seq: number; updated_at: number; last_message_id: string | null }>(
  'SELECT head_seq, member_seq, updated_at, last_message_id FROM rooms WHERE room_id = ?',
  'room',
);
const pinnedAt1 = row<{ pinned_at: number }>(
  'SELECT pinned_at FROM room_pinned_messages WHERE room_id = ? AND message_id = ?',
  'room',
  'msg_pin1',
)?.pinned_at;
await expect('重复置顶', () =>
  roomMessagePin(db, owner, { request_id: 'p1b', room_id: 'room', message_id: 'msg_pin1', pinned: true }),
);
checkEqual(
  '重复置顶不改变 pinned_at',
  row<{ pinned_at: number }>(
    'SELECT pinned_at FROM room_pinned_messages WHERE room_id = ? AND message_id = ?',
    'room',
    'msg_pin1',
  )?.pinned_at,
  pinnedAt1,
);
checkJson(
  'pin 不推进 head/member_seq/updated_at/last_message_id',
  row<{ head_seq: number; member_seq: number; updated_at: number; last_message_id: string | null }>(
    'SELECT head_seq, member_seq, updated_at, last_message_id FROM rooms WHERE room_id = ?',
    'room',
  ),
  roomBeforePin,
);
checkEqual(
  'pin 只写 room outbox',
  count("SELECT COUNT(*) AS n FROM outbox WHERE topic = 'inbox:agent'"),
  0,
);
checkEqual(
  'pin 写事件与 room outbox',
  count("SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_pinned' AND ref_id = 'msg_pin1'"),
  1,
);
checkJson(
  'pin 写审计且只含 message_id',
  row<{ detail: string }>(
    "SELECT detail_json AS detail FROM room_management_audit WHERE action = 'message_pinned' AND detail_json = '{\"message_id\":\"msg_pin1\"}'",
  ),
  { detail: '{"message_id":"msg_pin1"}' },
);

await expect('置顶第二条', () =>
  roomMessagePin(db, owner, { request_id: 'p2', room_id: 'room', message_id: 'msg_pin2', pinned: true }),
);
await expect('置顶第三条', () =>
  roomMessagePin(db, owner, { request_id: 'p3', room_id: 'room', message_id: 'msg_pin3', pinned: true }),
);
checkEqual('三条置顶落库', count("SELECT COUNT(*) AS n FROM room_pinned_messages WHERE room_id = 'room'"), 3);
await expectCode('第 4 条置顶', 'CONFLICT', () =>
  roomMessagePin(db, owner, { request_id: 'p4', room_id: 'room', message_id: 'msg_pin4', pinned: true }),
  'pin_limit',
);
checkEqual('第 4 条不落库', count("SELECT COUNT(*) AS n FROM room_pinned_messages WHERE room_id = 'room'"), 3);
checkEqual(
  '第 4 条不写 operations',
  count("SELECT COUNT(*) AS n FROM operations WHERE request_id = 'p4'"),
  0,
);

// 取消置顶幂等
await expect('取消置顶', () =>
  roomMessagePin(db, owner, { request_id: 'u1', room_id: 'room', message_id: 'msg_pin2', pinned: false }),
);
checkEqual('取消后剩两条', count("SELECT COUNT(*) AS n FROM room_pinned_messages WHERE room_id = 'room'"), 2);
await expect('重复取消置顶', () =>
  roomMessagePin(db, owner, { request_id: 'u1b', room_id: 'room', message_id: 'msg_pin2', pinned: false }),
);
checkEqual(
  '重复取消不写额外事件',
  count("SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_unpinned' AND ref_id = 'msg_pin2'"),
  1,
);
checkJson(
  '取消置顶审计',
  row<{ detail: string }>(
    "SELECT detail_json AS detail FROM room_management_audit WHERE action = 'message_unpinned' AND detail_json = '{\"message_id\":\"msg_pin2\"}'",
  ),
  { detail: '{"message_id":"msg_pin2"}' },
);

// 重新置顶使用新时间并排到最前
await expect('重新置顶', () =>
  roomMessagePin(db, owner, { request_id: 'p_again', room_id: 'room', message_id: 'msg_pin2', pinned: true }),
);
checkEqual(
  '重新置顶后三条',
  count("SELECT COUNT(*) AS n FROM room_pinned_messages WHERE room_id = 'room'"),
  3,
);
check(
  '重新置顶时间更新',
  (row<{ pinned_at: number }>(
    'SELECT pinned_at FROM room_pinned_messages WHERE room_id = ? AND message_id = ?',
    'room',
    'msg_pin2',
  )?.pinned_at ?? 0) >= (pinnedAt1 ?? 0),
);

// ---- room_get 置顶可见性与预览 ----
const ownerDetail = await expect('owner 读取详情', () => roomGet(db, owner, 'room'));
checkEqual('owner 看到三条置顶', ownerDetail.pinned_messages.length, 3);
check(
  '置顶预览取当前消息且含发送者',
  ownerDetail.pinned_messages.some(
    (pin) =>
      pin.message_id === 'msg_pin3' &&
      pin.preview === 'pin three' &&
      pin.sender.actor_id === 'member' &&
      pin.sender.kind === 'human',
  ),
  ownerDetail.pinned_messages,
);

sqlite.exec(`
  UPDATE rooms SET member_history_policy = 'from_join' WHERE room_id = 'room';
  UPDATE room_members SET joined_seq = 12 WHERE room_id = 'room' AND actor_id = 'member';
`);
const memberDetail = await expect('member 读取详情', () => roomGet(db, member, 'room'));
checkJson(
  'from_join 只返回边界内置顶',
  memberDetail.pinned_messages.map((pin) => pin.message_id),
  ['msg_pin3'],
);
sqlite.exec(`
  UPDATE rooms SET member_history_policy = 'full' WHERE room_id = 'room';
  UPDATE room_members SET joined_seq = 0 WHERE room_id = 'room' AND actor_id = 'member';
`);

// ---- 撤回自动取消置顶 ----
await expect('owner 撤回已置顶消息', () =>
  messageRecall(db, owner, { request_id: 'r_pinned', message_id: 'msg_pin3' }),
);
checkEqual(
  '撤回删除置顶行',
  count("SELECT COUNT(*) AS n FROM room_pinned_messages WHERE room_id = 'room' AND message_id = 'msg_pin3'"),
  0,
);
checkEqual(
  '撤回写自动 unpin 事件',
  count("SELECT COUNT(*) AS n FROM events WHERE event_type = 'message_unpinned' AND ref_id = 'msg_pin3'"),
  1,
);
checkJson(
  '撤回写自动 unpin 审计（操作者=撤回者）',
  row<{ changed_by: string; detail: string }>(
    `SELECT changed_by, detail_json AS detail FROM room_management_audit
      WHERE action = 'message_unpinned' AND detail_json = '{"message_id":"msg_pin3"}'`,
  ),
  { changed_by: 'owner', detail: '{"message_id":"msg_pin3"}' },
);
checkEqual(
  '取消置顶后 room_get 不再返回',
  (await roomGet(db, owner, 'room')).pinned_messages.some((pin) => pin.message_id === 'msg_pin3'),
  false,
);

// 普通成员撤回自己的置顶消息也自动清理
await expect('owner 置顶成员消息', () =>
  roomMessagePin(db, owner, { request_id: 'p_member_own', room_id: 'room', message_id: 'msg_file', pinned: true }),
);
await expect('member 撤回自己的置顶消息', () =>
  messageRecall(db, member, { request_id: 'r_member_own_pin', message_id: 'msg_file' }),
);
checkEqual(
  '自撤回删除置顶行',
  count("SELECT COUNT(*) AS n FROM room_pinned_messages WHERE room_id = 'room' AND message_id = 'msg_file'"),
  0,
);
checkEqual(
  '自撤回 unpin 审计 changed_by=member',
  count(
    `SELECT COUNT(*) AS n FROM room_management_audit
      WHERE action = 'message_unpinned' AND changed_by = 'member'
        AND detail_json = '{"message_id":"msg_file"}'`,
  ),
  1,
);
checkEqual(
  '文件行不因消息撤回删除',
  count("SELECT COUNT(*) AS n FROM room_files WHERE room_id = 'room'"),
  1,
);

// 同 request_id 重放不重新执行旧意图
await expect('置顶请求重放', () =>
  roomMessagePin(db, owner, { request_id: 'p1', room_id: 'room', message_id: 'msg_pin1', pinned: true }),
);
await expectCode('置顶 request_id 改 message_id', 'IDEMPOTENCY_CONFLICT', () =>
  roomMessagePin(db, owner, { request_id: 'p1', room_id: 'room', message_id: 'msg_pin4', pinned: true }),
);

// 已撤回消息可以取消遗留置顶（清理历史行），但不能重新置顶
sqlite.exec(`
  INSERT INTO room_pinned_messages (room_id, message_id, slot, pinned_by, pinned_at)
  VALUES ('room', 'msg_pin3', 3, 'owner', ${NOW});
`);
await expect('已撤回消息取消遗留置顶', () =>
  roomMessagePin(db, owner, { request_id: 'u_leftover', room_id: 'room', message_id: 'msg_pin3', pinned: false }),
);
checkEqual(
  '遗留置顶已删除',
  count("SELECT COUNT(*) AS n FROM room_pinned_messages WHERE room_id = 'room' AND message_id = 'msg_pin3'"),
  0,
);

// ---- 解散归档 ----
sqlite.exec(`
  UPDATE rooms SET dissolved_at = ${NOW}, archive_head_seq = 20, dissolved_by = 'owner' WHERE room_id = 'room';
`);
const archived = await expect('解散后读取置顶', () => roomGet(db, owner, 'room'));
checkEqual('归档仍可读置顶', archived.pinned_messages.length, 2);
await expectCode('解散后置顶写入', 'CONFLICT', () =>
  roomMessagePin(db, owner, { request_id: 'p_archived', room_id: 'room', message_id: 'msg_pin4', pinned: false }),
  'room_dissolved',
);
await expectCode('解散后撤回写入', 'CONFLICT', () =>
  messageRecall(db, owner, { request_id: 'r_archived', message_id: 'msg_pin4' }),
  'room_dissolved',
);

// ---- 并发/直接 SQL 兜底 ----
sqlite.exec(`
  UPDATE rooms SET dissolved_at = NULL, archive_head_seq = NULL, dissolved_by = NULL WHERE room_id = 'room';
  DELETE FROM room_pinned_messages WHERE room_id = 'room';
`);
// 重放旧 pin 意图不能把之后取消的置顶重新加回来。
await expect('重放前先置顶', () =>
  roomMessagePin(db, owner, { request_id: 'replay_pin', room_id: 'room', message_id: 'msg_pin1', pinned: true }),
);
await expect('重放前取消置顶', () =>
  roomMessagePin(db, owner, { request_id: 'replay_unpin', room_id: 'room', message_id: 'msg_pin1', pinned: false }),
);
await expect('重放旧置顶请求', () =>
  roomMessagePin(db, owner, { request_id: 'replay_pin', room_id: 'room', message_id: 'msg_pin1', pinned: true }),
);
checkEqual(
  '重放旧置顶请求不重新置顶',
  count("SELECT COUNT(*) AS n FROM room_pinned_messages WHERE room_id = 'room'"),
  0,
);
await expect('重新置顶 A', () =>
  roomMessagePin(db, owner, { request_id: 'c1', room_id: 'room', message_id: 'msg_pin1', pinned: true }),
);
await expect('重新置顶 B', () =>
  roomMessagePin(db, owner, { request_id: 'c2', room_id: 'room', message_id: 'msg_pin2', pinned: true }),
);
await expect('重新置顶 C', () =>
  roomMessagePin(db, owner, { request_id: 'c3', room_id: 'room', message_id: 'msg_pin4', pinned: true }),
);
let directSlot4 = false;
try {
  sqlite.exec(
    `INSERT INTO room_pinned_messages (room_id, message_id, slot, pinned_by, pinned_at)
     VALUES ('room', 'msg_pin3', 4, 'owner', ${NOW})`,
  );
} catch {
  directSlot4 = true;
}
check('直接 SQL 第 4 个 slot 被 CHECK 拒绝', directSlot4);
let directSlotDup = false;
try {
  sqlite.exec(
    `INSERT INTO room_pinned_messages (room_id, message_id, slot, pinned_by, pinned_at)
     VALUES ('room', 'msg_pin3', 1, 'owner', ${NOW})`,
  );
} catch {
  directSlotDup = true;
}
check('直接 SQL 重复 slot 被 UNIQUE 拒绝', directSlotDup);

checkEqual('LIMITS 与迁移上限一致', LIMITS.roomPinnedMessagesMax, 3);
checkEqual(
  '迁移 CHECK 强制 slot<=3',
  count(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'room_pinned_messages' AND sql LIKE '%slot <= 3%'",
  ),
  1,
);

sqlite.close();
console.log(`群主消息管理专项通过: ${checksPassed()} 项`);
