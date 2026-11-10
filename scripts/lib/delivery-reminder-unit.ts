/**
 * claimed 投递 3 分钟无状态更新提醒的本地事务测试。
 *
 * 使用内存 SQLite（重启用例使用临时文件）与真实 migrations，不访问服务端、
 * 不创建生产身份或消息。覆盖 179999/180000ms 边界、重复提醒、report 重置、
 * complete/fail/retry 停止、pending/head 不变量、并发扫描与 stream 映射。
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import type { Env } from '../../src/env';
import { DELIVERY_REMINDER_EVENT, DELIVERY_REMINDER_SOURCE } from '../../src/contracts/events';
import { LIMITS } from '../../src/contracts/limits';
import type { SyncInput } from '../../src/contracts/schemas';
import {
  deliveryClaim,
  deliveryComplete,
  deliveryFail,
  deliveryReport,
  deliveryRetry,
} from '../../src/domain/deliveries';
import { remindStaleDeliveries } from '../../src/domain/delivery-reminders';
import type { DeliveryReminderScanResult } from '../../src/domain/delivery-reminders';
import type { Principal } from '../../src/domain/principal';
import { sync } from '../../src/domain/sync';
import type { OutboxStreamRow } from '../../src/realtime/stream';
import { fanoutStreamItems } from '../../src/realtime/stream';
import type { ActorRow, DeliveryRow } from '../../src/storage/rows';
import { utf8Bytes } from '../../src/storage/db';
import { check, checkEqual } from './harness';

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const SENDER = 'usr_reminder';
const AGENT_ONE = 'agt_reminder_one';
const AGENT_TWO = 'agt_reminder_two';
const ROOM = 'rm_reminder';
const MESSAGE_ONE = 'msg_reminder_one';
const MESSAGE_TWO = 'msg_reminder_two';
const BASE = Date.now();
const ROOM_HEAD = 77;

function openMemoryDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  seed(db);
  return db;
}

function seed(db: Database): void {
  const at = BASE - 10_000;
  db.exec(`
    INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
                        inbox_min_seq, pending_count, created_at, updated_at)
    VALUES ('${SENDER}', 'human', NULL, 'Reminder User', '{}', 0, 0, 0, ${at}, ${at}),
           ('${AGENT_ONE}', 'agent', 'sess_reminder_one', 'Reminder One', '{}', 0, 0, 0, ${at}, ${at}),
           ('${AGENT_TWO}', 'agent', 'sess_reminder_two', 'Reminder Two', '{}', 0, 0, 0, ${at}, ${at});

    INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
                       member_seq, last_message_id, created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${SENDER}', 'Reminder Room', NULL, ${ROOM_HEAD}, 0, 0,
            '${MESSAGE_TWO}', ${at}, ${at});

    INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES ('${ROOM}', '${SENDER}', 'owner', 'active', 0, 0, ${at}),
           ('${ROOM}', '${AGENT_ONE}', 'member', 'active', 0, 0, ${at}),
           ('${ROOM}', '${AGENT_TWO}', 'member', 'active', 0, 0, ${at});

    INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq, body,
                          body_bytes, preview, reply_to, root_id, hop, root_invocations_used,
                          created_at)
    VALUES ('${MESSAGE_ONE}', '${ROOM}', '${SENDER}', 'cm_reminder_one', 10, '提醒测试一', 15,
            '提醒测试一', NULL, NULL, 0, 0, ${at}),
           ('${MESSAGE_TWO}', '${ROOM}', '${SENDER}', 'cm_reminder_two', 11, '提醒测试二', 15,
            '提醒测试二', NULL, NULL, 0, 0, ${at});
  `);
}

interface InsertOptions {
  progressAt: number | null;
  lastRemindedAt?: number | null;
  updatedAt?: number;
  claimId?: string;
  state?: 'pending' | 'claimed';
}

function insertDelivery(
  db: Database,
  deliveryId: string,
  recipient: string,
  messageId: string,
  options: InsertOptions,
): { claimId: string } {
  const state = options.state ?? 'claimed';
  const claimId = options.claimId ?? `clm_${deliveryId}`;
  const createdAt = BASE - 20_000;
  db.prepare(
    `INSERT INTO deliveries (delivery_id, recipient_id, message_id, room_id, state, attempt,
                             claim_id, claimed_at, progress_at, last_reminded_at,
                             result_message_id, error, created_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    deliveryId,
    recipient,
    messageId,
    ROOM,
    state,
    state === 'claimed' ? claimId : null,
    state === 'claimed' ? createdAt : null,
    options.progressAt,
    options.lastRemindedAt ?? null,
    messageId === MESSAGE_ONE ? 10 : 11,
    createdAt,
    options.updatedAt ?? createdAt,
  );
  if (state === 'pending') {
    db.prepare('UPDATE actors SET pending_count = pending_count + 1 WHERE actor_id = ?').run(
      recipient,
    );
  }
  return { claimId };
}

function principalFor(db: Database, actorId: string): Principal {
  const actor = db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actorId) as ActorRow;
  return {
    credentialHash: `unit:${actorId}`,
    actor,
    credential: {
      credential_id: `cred_${actorId}`,
      actor_id: actorId,
      device_id: 'dev_reminder_unit',
      token_hash: `hash_${actorId}`,
      revoked_at: null,
      created_at: 1,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}

function deliveryRow(db: Database, deliveryId: string): DeliveryRow {
  return db.prepare('SELECT * FROM deliveries WHERE delivery_id = ?').get(deliveryId) as DeliveryRow;
}

function actorRow(db: Database, actorId: string): ActorRow {
  return db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actorId) as ActorRow;
}

function countWhere(db: Database, sql: string, ...binds: string[]): number {
  return (db.prepare(sql).get(...binds) as { n: number }).n;
}

function reminderEvents(db: Database): number {
  return countWhere(
    db,
    'SELECT COUNT(*) AS n FROM events WHERE event_type = ?',
    DELIVERY_REMINDER_EVENT,
  );
}

function reminderMetadata(db: Database, deliveryId: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT metadata FROM events WHERE event_type = ? AND ref_id = ?')
    .get(DELIVERY_REMINDER_EVENT, deliveryId) as { metadata: string } | null;
  return row ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
}

function reminderOutbox(db: Database): number {
  return countWhere(
    db,
    `SELECT COUNT(*) AS n FROM outbox o JOIN events e ON e.event_seq = o.event_seq
      WHERE e.event_type = ?`,
    DELIVERY_REMINDER_EVENT,
  );
}

interface Invariants {
  pendingOne: number;
  pendingTwo: number;
  inboxHeadOne: number;
  inboxHeadTwo: number;
  roomHead: number;
  roomUpdatedAt: number;
  roomEvents: number;
  roomOutbox: number;
}

function invariants(db: Database): Invariants {
  const room = db.prepare('SELECT head_seq, updated_at FROM rooms WHERE room_id = ?').get(ROOM) as {
    head_seq: number;
    updated_at: number;
  };
  return {
    pendingOne: actorRow(db, AGENT_ONE).pending_count,
    pendingTwo: actorRow(db, AGENT_TWO).pending_count,
    inboxHeadOne: actorRow(db, AGENT_ONE).inbox_head_seq,
    inboxHeadTwo: actorRow(db, AGENT_TWO).inbox_head_seq,
    roomHead: room.head_seq,
    roomUpdatedAt: room.updated_at,
    roomEvents: countWhere(
      db,
      "SELECT COUNT(*) AS n FROM events WHERE scope_kind = 'room' AND scope_id = ?",
      ROOM,
    ),
    roomOutbox: countWhere(db, 'SELECT COUNT(*) AS n FROM outbox WHERE topic = ?', `room:${ROOM}`),
  };
}

function checkNoRoomSideEffects(before: Invariants, after: Invariants): void {
  checkEqual('提醒不推进房间 head', after.roomHead, before.roomHead);
  checkEqual('提醒不更新房间 updated_at', after.roomUpdatedAt, before.roomUpdatedAt);
  checkEqual('提醒不写 room scope 事件', after.roomEvents, before.roomEvents);
  checkEqual('提醒不写 room:{id} outbox', after.roomOutbox, before.roomOutbox);
  checkEqual('提醒不改变第二个 Agent 的 pending_count', after.pendingTwo, before.pendingTwo);
}

async function checkBoundary(): Promise<void> {
  const db = openMemoryDb();
  const d1 = createD1(db);
  const deliveryId = 'dlv_boundary';
  const { claimId } = insertDelivery(db, deliveryId, AGENT_ONE, MESSAGE_ONE, {
    progressAt: BASE - LIMITS.deliveryReminderMs + 1,
    updatedAt: BASE - 60_000,
  });
  const before = invariants(db);
  const beforeUpdatedAt = deliveryRow(db, deliveryId).updated_at;

  let result = await remindStaleDeliveries(d1, BASE);
  checkEqual('179999ms 不提醒', result.reminded, 0);
  checkEqual('179999ms 不写 reminder 事件', reminderEvents(db), 0);
  checkEqual('179999ms 不写 outbox', reminderOutbox(db), 0);

  db.prepare('UPDATE deliveries SET progress_at = ? WHERE delivery_id = ?').run(
    BASE - LIMITS.deliveryReminderMs,
    deliveryId,
  );
  result = await remindStaleDeliveries(d1, BASE);
  checkEqual('180000ms 提醒一次', result.reminded, 1);
  checkEqual('提醒事件恰好一条', reminderEvents(db), 1);
  checkEqual('提醒 outbox 恰好一条', reminderOutbox(db), 1);

  const event = db
    .prepare('SELECT * FROM events WHERE event_type = ?')
    .get(DELIVERY_REMINDER_EVENT) as {
    scope_kind: string;
    scope_id: string;
    ref_id: string;
    metadata: string;
  };
  const metadata = JSON.parse(event.metadata) as Record<string, unknown>;
  checkEqual('提醒事件 scope 为 inbox', event.scope_kind, 'inbox');
  checkEqual('提醒事件投递给 recipient', event.scope_id, AGENT_ONE);
  checkEqual('提醒事件 ref_id 为 delivery', event.ref_id, deliveryId);
  checkEqual('提醒事件包含 delivery_id', metadata.delivery_id, deliveryId);
  checkEqual('提醒事件包含 attempt', metadata.attempt, 1);
  checkEqual('提醒事件包含 claim_id', metadata.claim_id, claimId);
  checkEqual('提醒事件包含 room_id', metadata.room_id, ROOM);
  checkEqual('提醒事件包含 message_id', metadata.message_id, MESSAGE_ONE);
  checkEqual(
    '提醒事件包含 progress_at',
    metadata.progress_at,
    BASE - LIMITS.deliveryReminderMs,
  );
  checkEqual('提醒事件包含消息摘要', metadata.preview, '提醒测试一');
  checkEqual(
    '提醒事件包含可直接展示的文案',
    metadata.text,
    '「提醒测试一」尚未完成，请汇报进度',
  );
  checkEqual('提醒事件包含发送者 ID', metadata.sender_id, SENDER);
  checkEqual('提醒事件包含发送者名称', metadata.sender_name, 'Reminder User');
  checkEqual('提醒事件包含未完成时长', metadata.age_ms, LIMITS.deliveryReminderMs);
  check(
    '提醒事件不含完整正文',
    !('body' in metadata) &&
      !('body_bytes' in metadata) &&
      utf8Bytes(String(metadata.preview)) <= LIMITS.deliveryReminderPreviewBytes,
    Object.keys(metadata),
  );

  const outbox = db
    .prepare(
      `SELECT o.topic, o.status FROM outbox o JOIN events e ON e.event_seq = o.event_seq
        WHERE e.event_type = ?`,
    )
    .get(DELIVERY_REMINDER_EVENT) as { topic: string; status: string };
  checkEqual('提醒 outbox 使用 recipient inbox topic', outbox.topic, `inbox:${AGENT_ONE}`);
  checkEqual('提醒 outbox 初始为 pending', outbox.status, 'pending');

  const row = deliveryRow(db, deliveryId);
  checkEqual('提醒记录 last_reminded_at', row.last_reminded_at, BASE);
  checkEqual('提醒不更新 delivery updated_at', row.updated_at, beforeUpdatedAt);

  const after = invariants(db);
  checkEqual('提醒不改变 pending_count', after.pendingOne, before.pendingOne);
  check( '提醒推进 recipient inbox_head_seq', after.inboxHeadOne > before.inboxHeadOne, after);
  checkNoRoomSideEffects(before, after);
  db.close();
}

async function checkPreviewContent(): Promise<void> {
  const db = openMemoryDb();
  const d1 = createD1(db);
  const unsafePreview = `第一行\n第二行 "引号" \\ 反斜杠 ${'长'.repeat(200)}`;
  db.prepare('UPDATE actors SET name = ? WHERE actor_id = ?').run('名'.repeat(96), SENDER);
  db.prepare('UPDATE messages SET preview = ? WHERE message_id = ?').run(unsafePreview, MESSAGE_ONE);
  db.prepare('UPDATE messages SET preview = ? WHERE message_id = ?').run('', MESSAGE_TWO);
  insertDelivery(db, 'dlv_long_preview', AGENT_ONE, MESSAGE_ONE, {
    progressAt: BASE - LIMITS.deliveryReminderMs,
  });
  insertDelivery(db, 'dlv_empty_preview', AGENT_TWO, MESSAGE_TWO, {
    progressAt: BASE - LIMITS.deliveryReminderMs,
  });
  const before = invariants(db);

  checkEqual('空摘要与超长摘要都提醒', (await remindStaleDeliveries(d1, BASE)).reminded, 2);

  const empty = reminderMetadata(db, 'dlv_empty_preview');
  checkEqual('空摘要的 preview 为空字符串', empty.preview, '');
  checkEqual('空摘要退化为固定文案', empty.text, '投递尚未完成，请汇报进度');
  checkEqual('空摘要仍带发送者名称', empty.sender_name, '名'.repeat(32));
  checkEqual('空摘要仍带未完成时长', empty.age_ms, LIMITS.deliveryReminderMs);

  const long = reminderMetadata(db, 'dlv_long_preview');
  const preview = String(long.preview ?? '');
  check(
    '超长摘要按 UTF-8 字节截断',
    utf8Bytes(preview) <= LIMITS.deliveryReminderPreviewBytes,
    { bytes: utf8Bytes(preview), preview },
  );
  check('超长摘要不输出完整内容', preview.length < unsafePreview.length, preview.length);
  check('摘要折叠换行并去除 JSON 敏感字符', !/[\n\r"\\]/u.test(preview), preview);
  checkEqual('截断后的文案引用摘要', long.text, `「${preview}」尚未完成，请汇报进度`);
  check(
    '超长发送者名称按字节截断',
    typeof long.sender_name === 'string' &&
      utf8Bytes(long.sender_name) <= LIMITS.deliveryReminderSenderNameBytes,
    long.sender_name,
  );

  const rows = db
    .prepare(
      `SELECT o.outbox_id, o.topic, o.event_seq, o.attempts, o.created_at,
              e.scope_kind, e.scope_id, e.event_type, e.ref_id, e.metadata
         FROM outbox o JOIN events e ON e.event_seq = o.event_seq
        WHERE e.event_type = ?`,
    )
    .all(DELIVERY_REMINDER_EVENT) as OutboxStreamRow[];
  const published: { actorId: string; payload: string }[] = [];
  await fanoutStreamItems(d1, {
    DB: d1,
    NOTIFICATION_HUB: {
      publishActor(actorId: string, payload: string) {
        published.push({ actorId, payload });
      },
    },
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://test.invalid',
  } as unknown as Env, rows);
  checkEqual('空/超长摘要提醒各扇出一帧', published.length, 2);
  for (const { payload } of published) {
    const frame = JSON.parse(payload) as { items?: Record<string, unknown>[] };
    check('摘要截断后的提醒帧未超过 hintBytes', utf8Bytes(payload) <= LIMITS.hintBytes, {
      bytes: utf8Bytes(payload),
    });
    checkEqual('摘要截断后的提醒帧未被丢弃', frame.items?.length, 1);
  }

  const after = invariants(db);
  checkEqual('空/超长摘要提醒不改变 pending_count', after.pendingOne, before.pendingOne);
  checkEqual('空/超长摘要提醒不改变第二个 pending_count', after.pendingTwo, before.pendingTwo);
  checkNoRoomSideEffects(before, after);
  db.close();
}

async function checkRepeatAndRestart(): Promise<void> {
  const db = openMemoryDb();
  const d1 = createD1(db);
  const deliveryId = 'dlv_repeat';
  insertDelivery(db, deliveryId, AGENT_ONE, MESSAGE_ONE, {
    progressAt: BASE - LIMITS.deliveryReminderMs,
  });

  checkEqual('首次提醒', (await remindStaleDeliveries(d1, BASE)).reminded, 1);
  checkEqual(
    '同一窗口 179999ms 后不重复',
    (await remindStaleDeliveries(d1, BASE + LIMITS.deliveryReminderMs - 1)).reminded,
    0,
  );
  checkEqual('reminder 事件仍为一条', reminderEvents(db), 1);
  checkEqual(
    '下一个 3 分钟窗口再次提醒',
    (await remindStaleDeliveries(d1, BASE + LIMITS.deliveryReminderMs)).reminded,
    1,
  );
  checkEqual('两个窗口恰好两条事件', reminderEvents(db), 2);
  checkEqual('两个窗口恰好两条 outbox', reminderOutbox(db), 2);
  checkEqual(
    '同一窗口重复扫描不增加',
    (await remindStaleDeliveries(d1, BASE + LIMITS.deliveryReminderMs)).reminded,
    0,
  );
  db.close();

  const directory = mkdtempSync(join(tmpdir(), 'agentnet-reminder-'));
  const path = join(directory, 'reminder.sqlite');
  try {
    let fileDb = new Database(path, { create: true });
    fileDb.exec('PRAGMA foreign_keys = ON;');
    migrate(fileDb, MIGRATIONS);
    seed(fileDb);
    insertDelivery(fileDb, 'dlv_restart', AGENT_ONE, MESSAGE_ONE, {
      progressAt: BASE - LIMITS.deliveryReminderMs,
    });
    checkEqual(
      '重启前写入一条提醒',
      (await remindStaleDeliveries(createD1(fileDb), BASE)).reminded,
      1,
    );
    fileDb.close();

    fileDb = new Database(path);
    fileDb.exec('PRAGMA foreign_keys = ON;');
    checkEqual(
      '重启后同一窗口不重复提醒',
      (await remindStaleDeliveries(createD1(fileDb), BASE)).reminded,
      0,
    );
    checkEqual('重启后事件仍只有一条', reminderEvents(fileDb), 1);
    checkEqual('重启后 outbox 仍只有一条', reminderOutbox(fileDb), 1);
    fileDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function checkReportReset(): Promise<void> {
  const db = openMemoryDb();
  const d1 = createD1(db);
  const principal = principalFor(db, AGENT_ONE);
  const deliveryId = 'dlv_report_reset';
  insertDelivery(db, deliveryId, AGENT_ONE, MESSAGE_ONE, {
    state: 'pending',
    progressAt: null,
    lastRemindedAt: BASE,
  });

  const claimed = await deliveryClaim(d1, principal, {
    request_id: 'req_claim_reset',
    delivery_id: deliveryId,
  });
  checkEqual('claim 清空 last_reminded_at', deliveryRow(db, deliveryId).last_reminded_at, null);

  db.prepare(
    'UPDATE deliveries SET progress_at = ?, last_reminded_at = ?, updated_at = ? WHERE delivery_id = ?',
  ).run(
    BASE - LIMITS.deliveryReminderMs,
    BASE - LIMITS.deliveryReminderMs,
    BASE - 1_000,
    deliveryId,
  );
  checkEqual('report 前到期提醒', (await remindStaleDeliveries(d1, BASE)).reminded, 1);
  checkEqual('report 前一条提醒', reminderEvents(db), 1);

  await deliveryReport(d1, principal, {
    request_id: 'req_report_reset',
    delivery_id: deliveryId,
    attempt: claimed.attempt,
    claim_id: claimed.claim_id ?? '',
    status: '阶段一完成',
  });
  const reported = deliveryRow(db, deliveryId);
  checkEqual('report 清空 last_reminded_at', reported.last_reminded_at, null);
  check(
    'report 更新 progress_at',
    (reported.progress_at ?? 0) > BASE - LIMITS.deliveryReminderMs,
    reported.progress_at,
  );
  checkEqual('report 后同一时刻不提醒', (await remindStaleDeliveries(d1, BASE)).reminded, 0);
  checkEqual(
    'report 后满 3 分钟重新提醒',
    (await remindStaleDeliveries(d1, (reported.progress_at ?? BASE) + LIMITS.deliveryReminderMs))
      .reminded,
    1,
  );
  checkEqual('report 周期共两条提醒', reminderEvents(db), 2);
  db.close();
}

async function checkTerminalStates(): Promise<void> {
  const db = openMemoryDb();
  const d1 = createD1(db);
  const principalOne = principalFor(db, AGENT_ONE);
  const principalTwo = principalFor(db, AGENT_TWO);
  insertDelivery(db, 'dlv_complete', AGENT_ONE, MESSAGE_ONE, {
    state: 'pending',
    progressAt: null,
  });
  insertDelivery(db, 'dlv_fail', AGENT_TWO, MESSAGE_TWO, {
    state: 'pending',
    progressAt: null,
  });

  const claimedOne = await deliveryClaim(d1, principalOne, {
    request_id: 'req_claim_complete',
    delivery_id: 'dlv_complete',
  });
  const claimedTwo = await deliveryClaim(d1, principalTwo, {
    request_id: 'req_claim_fail',
    delivery_id: 'dlv_fail',
  });
  for (const deliveryId of ['dlv_complete', 'dlv_fail']) {
    db.prepare(
      'UPDATE deliveries SET progress_at = ?, last_reminded_at = ? WHERE delivery_id = ?',
    ).run(
      BASE - LIMITS.deliveryReminderMs,
      BASE - LIMITS.deliveryReminderMs,
      deliveryId,
    );
  }

  await deliveryComplete(d1, principalOne, {
    request_id: 'req_complete',
    delivery_id: 'dlv_complete',
    attempt: claimedOne.attempt,
    claim_id: claimedOne.claim_id ?? '',
  });
  await deliveryFail(d1, principalTwo, {
    request_id: 'req_fail',
    delivery_id: 'dlv_fail',
    attempt: claimedTwo.attempt,
    claim_id: claimedTwo.claim_id ?? '',
    error: '无法继续',
  });
  const beforeScan = invariants(db);
  checkEqual('complete/fail 后不提醒', (await remindStaleDeliveries(d1, BASE)).reminded, 0);
  checkEqual('complete/fail 后无 reminder 事件', reminderEvents(db), 0);
  checkNoRoomSideEffects(beforeScan, invariants(db));

  await deliveryRetry(d1, principalTwo, {
    request_id: 'req_retry',
    delivery_id: 'dlv_fail',
    expected_attempt: claimedTwo.attempt,
  });
  const retried = deliveryRow(db, 'dlv_fail');
  checkEqual('retry 回到 pending', retried.state, 'pending');
  checkEqual('retry 清空 last_reminded_at', retried.last_reminded_at, null);
  checkEqual('pending 状态不提醒', (await remindStaleDeliveries(d1, BASE)).reminded, 0);
  checkEqual('retry 后仍无 reminder 事件', reminderEvents(db), 0);
  db.close();
}

async function captureErrors<T>(
  run: () => Promise<T>,
): Promise<{ value: T; errors: unknown[][] }> {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    return { value: await run(), errors };
  } finally {
    console.error = original;
  }
}

function sumField(
  results: DeliveryReminderScanResult[],
  field: keyof DeliveryReminderScanResult,
): number {
  return results.reduce((sum, result) => sum + result[field], 0);
}

async function checkConcurrentScanAcrossWindows(): Promise<void> {
  const db = openMemoryDb();
  const d1 = createD1(db);
  const deliveryId = 'dlv_concurrent_window';
  insertDelivery(db, deliveryId, AGENT_ONE, MESSAGE_ONE, {
    progressAt: BASE - LIMITS.deliveryReminderMs,
  });
  const before = invariants(db);

  const { value: results, errors } = await captureErrors(() =>
    Promise.all([0, 1, 2, 3, 4].map((offset) => remindStaleDeliveries(d1, BASE + offset))),
  );
  checkEqual('不同毫秒并发扫描恰好提醒一次', sumField(results, 'reminded'), 1);
  checkEqual('不同毫秒并发扫描其余 skipped', sumField(results, 'skipped'), 4);
  checkEqual('不同毫秒并发扫描无失败', sumField(results, 'failed'), 0);
  checkEqual('不同毫秒并发扫描无错误输出', errors.length, 0);
  checkEqual('不同毫秒并发扫描事件恰好一条', reminderEvents(db), 1);
  checkEqual('不同毫秒并发扫描 outbox 恰好一条', reminderOutbox(db), 1);
  const winner = results.findIndex((result) => result.reminded === 1);
  checkEqual('提醒窗口归属唯一扫描', deliveryRow(db, deliveryId).last_reminded_at, BASE + winner);

  const after = invariants(db);
  checkEqual('并发提醒不改变 pending_count', after.pendingOne, before.pendingOne);
  check('并发提醒推进 recipient inbox_head_seq', after.inboxHeadOne > before.inboxHeadOne, after);
  checkNoRoomSideEffects(before, after);
  db.close();
}

async function checkConcurrentScanSameNow(): Promise<void> {
  const db = openMemoryDb();
  const d1 = createD1(db);
  insertDelivery(db, 'dlv_concurrent_one', AGENT_ONE, MESSAGE_ONE, {
    progressAt: BASE - LIMITS.deliveryReminderMs,
  });
  insertDelivery(db, 'dlv_concurrent_two', AGENT_TWO, MESSAGE_TWO, {
    progressAt: BASE - LIMITS.deliveryReminderMs,
  });
  const before = invariants(db);

  const { value: results, errors } = await captureErrors(() =>
    Promise.all([0, 1, 2].map(() => remindStaleDeliveries(d1, BASE))),
  );
  checkEqual('同毫秒并发扫描共提醒两个 delivery', sumField(results, 'reminded'), 2);
  checkEqual('同毫秒并发扫描其余 skipped', sumField(results, 'skipped'), 4);
  checkEqual('同毫秒并发扫描无失败', sumField(results, 'failed'), 0);
  checkEqual('同毫秒并发扫描无错误输出', errors.length, 0);
  checkEqual('同毫秒并发扫描恰好两条事件', reminderEvents(db), 2);
  checkEqual('同毫秒并发扫描恰好两条 outbox', reminderOutbox(db), 2);
  checkEqual(
    '同毫秒并发扫描 event_key 唯一',
    countWhere(
      db,
      'SELECT COUNT(DISTINCT event_key) AS n FROM events WHERE event_type = ?',
      DELIVERY_REMINDER_EVENT,
    ),
    2,
  );
  const after = invariants(db);
  checkEqual('并发提醒不改变 pending_count', after.pendingOne, before.pendingOne);
  check('并发提醒不倒退 inbox head', after.inboxHeadOne >= before.inboxHeadOne);
  checkNoRoomSideEffects(before, after);
  db.close();
}

async function checkConcurrentScan(): Promise<void> {
  await checkConcurrentScanAcrossWindows();
  await checkConcurrentScanSameNow();
}

async function checkSyncAndStreamMapping(): Promise<void> {
  const db = openMemoryDb();
  const d1 = createD1(db);
  const deliveryId = 'dlv_visible';
  insertDelivery(db, deliveryId, AGENT_ONE, MESSAGE_ONE, {
    progressAt: BASE - LIMITS.deliveryReminderMs,
  });
  await remindStaleDeliveries(d1, BASE);

  const synced = await sync(d1, principalFor(db, AGENT_ONE), {
    scope: 'inbox',
  } as SyncInput);
  const reminder = synced.items.find((item) => item.type === DELIVERY_REMINDER_EVENT);
  check('network_sync 可读取提醒事件', reminder !== undefined);
  checkEqual('sync 提醒 ref_id', reminder?.ref_id, deliveryId);
  checkEqual('sync 提醒 metadata claim_id', reminder?.metadata.claim_id, `clm_${deliveryId}`);
  checkEqual('sync 提醒 metadata preview', reminder?.metadata.preview, '提醒测试一');
  checkEqual(
    'sync 提醒 metadata text',
    reminder?.metadata.text,
    '「提醒测试一」尚未完成，请汇报进度',
  );
  checkEqual('sync 提醒 metadata sender_id', reminder?.metadata.sender_id, SENDER);
  checkEqual('sync 提醒 metadata sender_name', reminder?.metadata.sender_name, 'Reminder User');
  checkEqual('sync 提醒 metadata age_ms', reminder?.metadata.age_ms, LIMITS.deliveryReminderMs);

  const rows = db
    .prepare(
      `SELECT o.outbox_id, o.topic, o.event_seq, o.attempts, o.created_at,
              e.scope_kind, e.scope_id, e.event_type, e.ref_id, e.metadata
         FROM outbox o JOIN events e ON e.event_seq = o.event_seq
        WHERE e.event_type = ?`,
    )
    .all(DELIVERY_REMINDER_EVENT) as OutboxStreamRow[];
  const published: { actorId: string; payload: string }[] = [];
  const fakeEnv = {
    DB: d1,
    NOTIFICATION_HUB: {
      publishActor(actorId: string, payload: string) {
        published.push({ actorId, payload });
      },
    },
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://test.invalid',
  } as unknown as Env;
  await fanoutStreamItems(d1, fakeEnv, rows);

  checkEqual('提醒扇出给 recipient', published[0]?.actorId, AGENT_ONE);
  const frame = JSON.parse(published[0]?.payload ?? '{}') as {
    attention?: string;
    items?: Record<string, unknown>[];
  };
  const item = frame.items?.[0] ?? {};
  checkEqual('提醒帧 attention 为 action_required', frame.attention, 'action_required');
  checkEqual('提醒 item source', item.source, DELIVERY_REMINDER_SOURCE);
  checkEqual('提醒 item kind', item.kind, 'reminder');
  checkEqual('提醒 item delivery_id', item.delivery_id, deliveryId);
  checkEqual('提醒 item attempt', item.attempt, 1);
  checkEqual('提醒 item progress_at', item.progress_at, String(BASE - LIMITS.deliveryReminderMs));
  checkEqual('提醒 item preview', item.preview, '提醒测试一');
  checkEqual('提醒 item text', item.text, '「提醒测试一」尚未完成，请汇报进度');
  checkEqual('提醒 item sender_id', item.sender_id, SENDER);
  checkEqual('提醒 item sender_name', item.sender_name, 'Reminder User');
  checkEqual('提醒 item age_ms', item.age_ms, LIMITS.deliveryReminderMs);
  check('提醒 stream 不含 claim_id', !('claim_id' in item), Object.keys(item));
  check(
    '提醒 stream 不含完整正文',
    !('body' in item) && !('body_bytes' in item),
    Object.keys(item),
  );
  const payload = published[0]?.payload ?? '{}';
  check('提醒帧未超过 hintBytes', utf8Bytes(payload) <= LIMITS.hintBytes, utf8Bytes(payload));
  checkEqual('提醒帧未被截断丢弃', frame.items?.length, 1);
  db.close();
}

export async function runDeliveryReminderUnitChecks(): Promise<void> {
  await checkBoundary();
  await checkPreviewContent();
  await checkRepeatAndRestart();
  await checkReportReset();
  await checkTerminalStates();
  await checkConcurrentScan();
  await checkSyncAndStreamMapping();
}
