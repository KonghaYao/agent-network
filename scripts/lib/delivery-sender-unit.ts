/**
 * 投递发送者身份的本地产出测试。
 *
 * 使用内存 SQLite 与真实 migrations，不访问服务端。覆盖 inbox 列表、
 * claim/complete 返回的 delivery.message，以及 room 回执 stream item 的
 * sender_name / sender_kind；发送者 actor 缺失时字段为 null 且不报错。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import type { Env } from '../../src/env';
import { deliveryClaim, deliveryComplete, inboxList } from '../../src/domain/deliveries';
import type { Principal } from '../../src/domain/principal';
import type { OutboxStreamRow } from '../../src/realtime/stream';
import { fanoutStreamItems } from '../../src/realtime/stream';
import type { ActorRow } from '../../src/storage/rows';
import { check, checkEqual } from './harness';

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const SENDER = 'usr_sender_unit';
const SENDER_NAME = '投递发送者';
const RECIPIENT = 'agt_recipient_unit';
const MISSING_SENDER = 'usr_missing_sender';
const ROOM = 'rm_sender_unit';
const MESSAGE_NAMED = 'msg_sender_named';
const MESSAGE_MISSING = 'msg_sender_missing';
const DELIVERY_NAMED = 'dlv_sender_named';
const DELIVERY_MISSING = 'dlv_sender_missing';
const BASE = Date.now();

function seed(db: Database): void {
  const at = BASE - 10_000;
  db.exec(`
    INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
                        inbox_min_seq, pending_count, created_at, updated_at)
    VALUES ('${SENDER}', 'human', NULL, '${SENDER_NAME}', '{}', 0, 0, 0, ${at}, ${at}),
           ('${RECIPIENT}', 'agent', 'sess_sender_unit', '投递接收者', '{}', 0, 0, 2, ${at}, ${at});

    INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
                       member_seq, last_message_id, created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${SENDER}', '发送者身份测试', NULL, 2, 0, 0,
            '${MESSAGE_MISSING}', ${at}, ${at});

    INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES ('${ROOM}', '${SENDER}', 'owner', 'active', 0, 0, ${at}),
           ('${ROOM}', '${RECIPIENT}', 'member', 'active', 0, 0, ${at});

    INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq, body,
                          body_bytes, preview, reply_to, root_id, hop, root_invocations_used,
                          created_at)
    VALUES ('${MESSAGE_NAMED}', '${ROOM}', '${SENDER}', 'cm_sender_named', 1, '有发送者的投递',
            21, '有发送者的投递', NULL, NULL, 0, 0, ${at}),
           ('${MESSAGE_MISSING}', '${ROOM}', '${MISSING_SENDER}', 'cm_sender_missing', 2,
            '发送者已不存在', 21, '发送者已不存在', NULL, NULL, 0, 0, ${at});

    INSERT INTO deliveries (delivery_id, recipient_id, message_id, room_id, state, attempt,
                            claim_id, claimed_at, progress_at, last_reminded_at,
                            result_message_id, error, created_seq, created_at, updated_at)
    VALUES ('${DELIVERY_NAMED}', '${RECIPIENT}', '${MESSAGE_NAMED}', '${ROOM}', 'pending', 0,
            NULL, NULL, NULL, NULL, NULL, NULL, 1, ${at}, ${at}),
           ('${DELIVERY_MISSING}', '${RECIPIENT}', '${MESSAGE_MISSING}', '${ROOM}', 'pending', 0,
            NULL, NULL, NULL, NULL, NULL, NULL, 2, ${at}, ${at});
  `);
}

function principalFor(db: Database, actorId: string): Principal {
  const actor = db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actorId) as ActorRow;
  return {
    credentialHash: `unit:${actorId}`,
    actor,
    credential: {
      credential_id: `cred_${actorId}`,
      actor_id: actorId,
      device_id: 'dev_sender_unit',
      token_hash: `hash_${actorId}`,
      revoked_at: null,
      created_at: 1,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}

function deliveryEventRow(
  db: Database,
  eventType: string,
  deliveryId: string,
): OutboxStreamRow {
  return db
    .prepare(
      `SELECT o.outbox_id, o.topic, o.event_seq, o.attempts, o.created_at,
              e.scope_kind, e.scope_id, e.event_type, e.ref_id, e.metadata
         FROM outbox o JOIN events e ON e.event_seq = o.event_seq
        WHERE e.event_type = ? AND e.ref_id = ?`,
    )
    .get(eventType, deliveryId) as OutboxStreamRow;
}

interface PublishedFrame {
  actorId: string;
  payload: string;
}

async function fanout(db: Database, rows: OutboxStreamRow[]): Promise<PublishedFrame[]> {
  const published: PublishedFrame[] = [];
  const d1 = createD1(db);
  await fanoutStreamItems(
    d1,
    {
      DB: d1,
      NOTIFICATION_HUB: {
        publishActor(actorId: string, payload: string) {
          published.push({ actorId, payload });
        },
      },
      ENVIRONMENT: 'test',
      PUBLIC_ORIGIN: 'http://test.invalid',
    } as unknown as Env,
    rows,
  );
  return published;
}

function itemOf(published: PublishedFrame[]): Record<string, unknown> {
  const senderFrame = published.find((frame) => frame.actorId === SENDER);
  if (!senderFrame) throw new Error('缺少发送者 stream 帧');
  const frame = JSON.parse(senderFrame.payload) as { items?: Record<string, unknown>[] };
  const item = frame.items?.[0];
  if (!item) throw new Error('缺少 stream item');
  return item;
}

export async function runDeliverySenderUnitChecks(): Promise<void> {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  seed(db);
  const d1 = createD1(db);
  const principal = principalFor(db, RECIPIENT);

  const page = await inboxList(d1, principal, { state: 'pending', limit: 10 });
  const named = page.items.find((item) => item.delivery_id === DELIVERY_NAMED);
  const missing = page.items.find((item) => item.delivery_id === DELIVERY_MISSING);
  check('inbox 同时返回两条投递', page.items.length === 2, page.items.length);
  checkEqual('inbox 投递携带发送者显示名', named?.message?.sender_name, SENDER_NAME);
  checkEqual('inbox 投递携带发送者类型', named?.message?.sender_kind, 'human');
  checkEqual('inbox 投递在 actor 缺失时 sender_name 为 null', missing?.message?.sender_name, null);
  checkEqual('inbox 投递在 actor 缺失时 sender_kind 为 null', missing?.message?.sender_kind, null);

  const claimed = await deliveryClaim(d1, principal, {
    request_id: 'req_sender_unit_claim_named',
    delivery_id: DELIVERY_NAMED,
  });
  checkEqual('claim 输出投递携带发送者显示名', claimed.message?.sender_name, SENDER_NAME);
  checkEqual('claim 输出投递携带发送者类型', claimed.message?.sender_kind, 'human');

  const claimedItem = itemOf(
    await fanout(db, [deliveryEventRow(db, 'delivery_claimed', DELIVERY_NAMED)]),
  );
  checkEqual('delivery.updated stream item 携带发送者显示名', claimedItem.sender_name, SENDER_NAME);
  checkEqual('delivery.updated stream item 携带发送者类型', claimedItem.sender_kind, 'human');

  const completed = await deliveryComplete(d1, principal, {
    request_id: 'req_sender_unit_complete_named',
    delivery_id: DELIVERY_NAMED,
    attempt: claimed.attempt,
    claim_id: claimed.claim_id as string,
  });
  checkEqual('complete 输出投递携带发送者显示名', completed.delivery.message?.sender_name, SENDER_NAME);
  checkEqual('complete 输出投递携带发送者类型', completed.delivery.message?.sender_kind, 'human');

  const claimedMissing = await deliveryClaim(d1, principal, {
    request_id: 'req_sender_unit_claim_missing',
    delivery_id: DELIVERY_MISSING,
  });
  checkEqual(
    'claim 在 actor 缺失时 sender_name 为 null 且不报错',
    claimedMissing.message?.sender_name,
    null,
  );
  checkEqual('claim 在 actor 缺失时 sender_kind 为 null', claimedMissing.message?.sender_kind, null);

  const missingItem = itemOf(
    await fanout(db, [deliveryEventRow(db, 'delivery_claimed', DELIVERY_MISSING)]),
  );
  checkEqual('stream item 在 actor 缺失时 sender_name 为 null', missingItem.sender_name, null);
  checkEqual('stream item 在 actor 缺失时 sender_kind 为 null', missingItem.sender_kind, null);

  db.close();
  console.log('  · 投递发送者身份本地用例通过');
}
