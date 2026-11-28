/**
 * 消息引用链的房间隔离回归。
 *
 * 使用内存 SQLite 与真实 migrations，不启动服务。覆盖：跨房间 claimed 投递
 * 不得成为隐式父消息、显式 reply_to 必须决定本房间的 root/hop、同房间隐式
 * 挂接保持原行为，以及显式 claim 跨房间仍返回 INVALID_ARGUMENT。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { BusinessError } from '../src/contracts/errors';
import { deliveryClaim } from '../src/domain/deliveries';
import { messageSend } from '../src/domain/messages';
import type { Principal } from '../src/domain/principal';
import { getActor, getMessage } from '../src/storage/queries';
import type { MessageRow } from '../src/storage/rows';
import { check, checkEqual, CheckFailure, checksPassed } from './lib/harness';

const MIGRATIONS = join(import.meta.dir, '../migrations');
const AT = Date.now();
const GROUP = 'rm_reply_group';
const DIRECT = 'rm_reply_direct';
const HUMAN = 'usr_reply_human';
const AGENT = 'agt_reply_agent';

let counter = 0;

function openSeededDb(): { db: Database; d1: D1Database } {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${HUMAN}', 'human', NULL, 'Reply Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${AGENT}', 'agent', 'sess_reply_agent', 'Reply Agent', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
       member_seq, last_message_id, created_at, updated_at)
    VALUES
      ('${GROUP}', 'group', '${HUMAN}', 'Reply Group', NULL, 0, 0, 0, NULL, ${AT}, ${AT}),
      ('${DIRECT}', 'direct', NULL, '', 'agt_reply_agent|usr_reply_human', 0, 0, 0, NULL, ${AT}, ${AT});

    INSERT INTO contact_relations
      (pair_key, actor_a, actor_b, status, source, created_at, updated_at)
    VALUES
      ('agt_reply_agent|usr_reply_human', '${AGENT}', '${HUMAN}', 'active', 'request', ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
    VALUES
      ('${GROUP}', '${HUMAN}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${GROUP}', '${AGENT}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${DIRECT}', '${HUMAN}', 'member', 'active', 0, 0, ${AT}, 1, ${AT}),
      ('${DIRECT}', '${AGENT}', 'member', 'active', 0, 0, ${AT}, 1, ${AT});
  `);
  return { db, d1: createD1(db) };
}

const { db, d1 } = openSeededDb();

async function principalFor(actor: string): Promise<Principal> {
  const row = await getActor(d1, actor);
  if (!row) throw new CheckFailure('seed', `缺少 actor: ${actor}`);
  return { credentialHash: `hash_${actor}`, actor: row, credential: null };
}

interface SendOptions {
  reply_to?: string;
  invoke?: string[];
  claim?: { delivery_id: string; attempt: number; claim_id: string };
}

async function send(
  actor: string,
  roomId: string,
  body: string,
  options: SendOptions = {},
): Promise<MessageRow> {
  counter += 1;
  const result = await messageSend(d1, await principalFor(actor), {
    request_id: `req_reply_${counter}`,
    client_message_id: `cm_reply_${counter}`,
    room_id: roomId,
    body,
    invoke: options.invoke ?? [],
    ...(options.reply_to === undefined ? {} : { reply_to: options.reply_to }),
    ...(options.claim === undefined ? {} : { claim: options.claim }),
  });
  const row = await getMessage(d1, result.message.message_id);
  if (!row) throw new CheckFailure('send', '消息写入后读不到');
  return row;
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

function deliveryIdFor(messageId: string): string {
  const row = db
    .prepare('SELECT delivery_id FROM deliveries WHERE message_id = ?')
    .get(messageId) as { delivery_id: string } | null;
  if (!row) throw new CheckFailure('delivery', `消息没有投递: ${messageId}`);
  return row.delivery_id;
}

function assertNoRoomOneId(label: string, row: MessageRow, roomOneIds: string[]): void {
  const fields = [row.reply_to, row.root_id];
  check(
    label,
    roomOneIds.every((id) => !fields.includes(id)),
    { fields, roomOneIds },
  );
}

try {
  // 先准备 direct 房间内的引用目标，再让 Agent 持有群聊中的 claimed 投递。
  const directBase = await send(HUMAN, DIRECT, 'R2 引用目标');
  const claimedMessage = await send(HUMAN, GROUP, 'R1 任务消息', { invoke: [AGENT] });
  const claim = await deliveryClaim(d1, await principalFor(AGENT), {
    request_id: 'req_reply_claim',
    delivery_id: deliveryIdFor(claimedMessage.message_id),
  });
  if (!claim.claim_id) throw new CheckFailure('claim', 'claim_id 为空');
  checkEqual('claimed 投递属于群聊 R1', claim.room_id, GROUP);

  console.log('  · 场景 A：跨房间 claimed 投递不产生隐式引用');
  const a = await send(AGENT, DIRECT, 'A 不传 reply_to');
  checkEqual('A reply_to 为空', a.reply_to, null);
  checkEqual('A root_id 为空', a.root_id, null);
  checkEqual('A hop 为 0', a.hop, 0);
  assertNoRoomOneId('A 不含 R1 消息 id', a, [claimedMessage.message_id]);

  console.log('  · 场景 B：显式 reply_to 决定本房间引用链');
  const b = await send(AGENT, DIRECT, 'B 显式引用 R2', { reply_to: directBase.message_id });
  checkEqual('B reply_to 指向 R2', b.reply_to, directBase.message_id);
  checkEqual('B root_id 落在 R2', b.root_id, directBase.message_id);
  checkEqual('B hop 为 1', b.hop, 1);
  assertNoRoomOneId('B 不含 R1 消息 id', b, [claimedMessage.message_id]);

  console.log('  · 场景 C：同房间 claimed 投递保持隐式挂接');
  const c = await send(AGENT, GROUP, 'C 同房间回复');
  checkEqual('C reply_to 指向 claimed 消息', c.reply_to, claimedMessage.message_id);
  checkEqual('C root_id 继承 claimed 消息', c.root_id, claimedMessage.root_id ?? claimedMessage.message_id);
  checkEqual('C hop 递增', c.hop, claimedMessage.hop + 1);

  console.log('  · 场景 D：显式 claim 跨房间仍被拒绝');
  await expectCode(
    'D 跨房间显式 claim 返回 INVALID_ARGUMENT',
    send(AGENT, DIRECT, 'D 跨房间 claim', {
      claim: { delivery_id: claim.delivery_id, attempt: claim.attempt, claim_id: claim.claim_id },
    }),
    'INVALID_ARGUMENT',
  );

  console.log(`跨房间引用链隔离通过：${checksPassed()} 项检查`);
} finally {
  db.close();
}
