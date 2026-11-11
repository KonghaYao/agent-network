/** Real SQLite/domain + HTTPS regression checks. Waiting never pokes the MCP server. */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { LIMITS } from '../../src/contracts/limits';
import { messageSend } from '../../src/domain/messages';
import type { Principal } from '../../src/domain/principal';
import type { Env } from '../../src/env';
import { nextEventDeliveryAt } from '../../src/events/dispatcher';
import { runEventsTick, scheduleEventsTick, stopEventsRuntime } from '../../src/events/runtime';
import { scanEventSubscriptions } from '../../src/events/scanner';
import { loadEncryptionKey } from '../../src/events/security';
import { subscribeEvents } from '../../src/events/subscriptions';
import { NotificationHub } from '../../src/realtime/hub';
import { check, checkEqual, sleep, waitUntil } from './harness';
import { startTestReceiver, type TestCertificate } from './events-harness';

const OWNER = 'usr_runtime_owner';
const SENDER = 'agt_runtime_sender';
const TARGET = 'agt_runtime_target';
const ROOM = 'rm_runtime';

export async function runEventsRuntimeChecks(certificate: TestCertificate): Promise<void> {
  const receiver = startTestReceiver({ certificate });
  const encryptionKey = await loadEncryptionKey(Buffer.alloc(32, 9).toString('base64'));
  const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
  const fixtures: Array<{ db: Database; env: Env }> = [];

  function fixture() {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, join(import.meta.dir, '../../migrations'));
    const now = Date.now();
    for (const [id, kind, name] of [
      [OWNER, 'human', 'Runtime Owner'],
      [SENDER, 'agent', 'Runtime Sender'],
      [TARGET, 'agent', 'Runtime Target'],
    ] as const) {
      db.prepare('INSERT INTO actors(actor_id,kind,name,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(id, kind, name, now, now);
      db.prepare(`INSERT INTO credentials(credential_id,actor_id,device_id,token_hash,created_at)
        VALUES(?,?,?,?,?)`).run(`cred_${id}`, id, 'runtime_local', `hash_${id}`, now);
    }
    db.prepare(`INSERT INTO rooms(room_id,kind,owner_id,title,created_at,updated_at)
      VALUES(?,'group',?,'Runtime',?,?)`).run(ROOM, OWNER, now, now);
    for (const id of [OWNER, SENDER, TARGET]) {
      db.prepare(`INSERT INTO room_members(room_id,actor_id,role,status,joined_at)
        VALUES(?,?,?,'active',?)`).run(ROOM, id, id === OWNER ? 'owner' : 'member', now);
    }
    const env: Env = {
      DB: createD1(db), NOTIFICATION_HUB: new NotificationHub(db),
      ENVIRONMENT: 'test', PUBLIC_ORIGIN: 'http://127.0.0.1',
      EVENTS: {
        encryptionKey: encryptionKey!, callbackAllowlist: null, allowPrivateCallbacks: true,
        verificationTimeoutMs: 2_000, deliveryTimeoutMs: 400, verificationPerHostPerMinute: 1_000,
      },
    };
    const principal = (id: string): Principal => ({
      actor: db.prepare('SELECT * FROM actors WHERE actor_id=?').get(id) as Principal['actor'],
      credential: db.prepare('SELECT * FROM credentials WHERE actor_id=?').get(id) as Principal['credential'],
      credentialHash: `hash_${id}`,
    });
    const send = (body: string, invoke: string[] = [TARGET]) => messageSend(env.DB, principal(SENDER), {
      room_id: ROOM, body, invoke, request_id: `req_${crypto.randomUUID()}`,
      client_message_id: `cm_${crypto.randomUUID()}`,
    });
    const subscribe = (path: string, actor = TARGET) => subscribeEvents(env, principal(actor), {
      name: 'agentnet.message.created', arguments: { attention: 'action_required' },
      cursor: null,
      delivery: { mode: 'webhook', url: receiver.url(path), secret },
    });
    const count = (status: string) => (db.prepare(
      'SELECT COUNT(*) AS n FROM mcp_event_deliveries WHERE status=?',
    ).get(status) as { n: number }).n;
    fixtures.push({ db, env });
    return { db, env, send, subscribe, count, principal };
  }

  const receivedIds = (path: string): string[] => receiver.events(path)
    .map((request) => (JSON.parse(request.body) as { data: { message_id: string } }).data.message_id);
  const delivered = async (f: ReturnType<typeof fixture>, n: number, label: string) => {
    await waitUntil(label, () => f.count('delivered') === n, 5_000, 10);
    checkEqual(label, f.count('delivered'), n);
  };

  try {
    // One initial wakeup must drain a burst, in order, without another tool call.
    {
      const f = fixture();
      await f.subscribe('/runtime-burst');
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await f.send(`burst ${i}`)).message.message_id);
      scheduleEventsTick(f.env);
      await delivered(f, ids.length, '突发消息无需后续 RPC 即全部送达');
      checkEqual('突发投递保持顺序且无重复', receivedIds('/runtime-burst').join(), ids.join());
      checkEqual('积压排空后没有后续唤醒', await nextEventDeliveryAt(f.env), null);
    }
    // An entire filtered page produces no queue; the scanner must still continue.
    {
      const f = fixture();
      await f.subscribe('/runtime-filtered');
      for (let i = 0; i < LIMITS.eventsScanBatchMax + 1; i++) {
        const visual = await f.send(`@Runtime Target informational ${i}`, []);
        if (i === 0) checkEqual('显示 @ + invoke: [] 不创建业务投递', visual.delivery_ids.length, 0);
      }
      const actionable = await f.send('please review the result');
      scheduleEventsTick(f.env);
      await delivered(f, 1, '过滤整页后自动继续扫描目标消息');
      checkEqual('仅显式派活的消息触发 webhook', receivedIds('/runtime-filtered').join(), actionable.message.message_id);
    }
    // A full subscription page can have no work while the next page is behind.
    {
      const f = fixture();
      const targets = [TARGET, 'agt_runtime_second', 'agt_runtime_third'];
      for (const actor of targets.slice(1)) {
        f.db.prepare(`INSERT INTO actors(actor_id,kind,name,created_at,updated_at)
          SELECT ?,kind,?,created_at,updated_at FROM actors WHERE actor_id=?`).run(actor, actor, TARGET);
        f.db.prepare(`INSERT INTO credentials(credential_id,actor_id,device_id,token_hash,created_at)
          SELECT ?,?,device_id,?,created_at FROM credentials WHERE actor_id=?`)
          .run(`cred_${actor}`, actor, `hash_${actor}`, TARGET);
        f.db.prepare(`INSERT INTO room_members(room_id,actor_id,role,status,joined_at)
          SELECT room_id,?,role,status,joined_at FROM room_members WHERE actor_id=?`).run(actor, TARGET);
      }
      for (let i = 0; i <= LIMITS.eventsScanSubscriptionsPerTick; i++) {
        await f.subscribe(`/runtime-many-${i}`, targets[i % targets.length]!);
      }
      const last = f.db.prepare(`SELECT subscription_id,actor_id FROM mcp_event_subscriptions
        ORDER BY subscription_id DESC LIMIT 1`).get() as { subscription_id: string; actor_id: string };
      await f.send('only the last subscription is behind', [last.actor_id]);
      f.db.prepare(`UPDATE mcp_event_subscriptions SET scanned_seq=(SELECT head_seq FROM rooms WHERE room_id=?)
        WHERE subscription_id<>?`).run(ROOM, last.subscription_id);
      scheduleEventsTick(f.env);
      await delivered(f, 1, '前 50 个订阅无工作时仍继续扫描后续订阅');
      checkEqual('空页不漏掉最后一个订阅', receiver.requests.filter((r) =>
        !r.isVerification && r.subscriptionId === last.subscription_id).length, 1);
    }
    // A future head blocks its own tail, but not another subscription's immediate work.
    {
      const f = fixture();
      const sub = await f.subscribe('/fail-once');
      const first = await f.send('retry head');
      const second = await f.send('retry tail');
      await runEventsTick(f.env);
      const due = f.db.prepare(`SELECT next_attempt_at FROM mcp_event_deliveries
        WHERE subscription_id=? ORDER BY event_seq LIMIT 1`).get(sub.id) as { next_attempt_at: number };
      checkEqual('只按队首退避时间唤醒', await nextEventDeliveryAt(f.env), due.next_attempt_at);
      const nextScan = (f.db.prepare('SELECT last_scan_at FROM mcp_event_subscriptions WHERE subscription_id=?')
        .get(sub.id) as { last_scan_at: number }).last_scan_at;
      await sleep(80);
      checkEqual('退避期间不被队尾触发忙循环', (f.db.prepare(
        'SELECT last_scan_at FROM mcp_event_subscriptions WHERE subscription_id=?',
      ).get(sub.id) as { last_scan_at: number }).last_scan_at, nextScan);
      await f.subscribe('/runtime-preempt');
      const urgent = await f.send('other subscription needs immediate delivery');
      scheduleEventsTick(f.env);
      await receiver.waitForEvent((r) => r.path === '/runtime-preempt', '新工作提前未来定时器', 700);
      check('其他订阅不被退避阻塞', receiver.events('/runtime-preempt')[0]!.at < due.next_attempt_at);
      await delivered(f, 4, '重试和后续消息无需 RPC 自行继续');
      checkEqual('重试保持 eventId', receiver.events('/fail-once')[0]!.eventId, receiver.events('/fail-once')[1]!.eventId);
      checkEqual('失败队首先重试成功再发送队尾', receivedIds('/fail-once').join(), [
        first.message.message_id, first.message.message_id, second.message.message_id, urgent.message.message_id,
      ].join());
    }
    // Recover an in-flight lease at its deadline, then drain the tail automatically.
    {
      const f = fixture();
      await f.subscribe('/runtime-lease');
      await f.send('leased head');
      await f.send('leased tail');
      await scanEventSubscriptions(f.env);
      const leaseUntil = Date.now() + 180;
      f.db.prepare(`UPDATE mcp_event_deliveries SET status='processing',lease_token='old_process',lease_until=?
        WHERE event_seq=(SELECT MIN(event_seq) FROM mcp_event_deliveries)`).run(leaseUntil);
      checkEqual('processing 队首按租约时间唤醒', await nextEventDeliveryAt(f.env), leaseUntil);
      scheduleEventsTick(f.env);
      await delivered(f, 2, '遗留租约到期后自动恢复并排空');
      check('不在租约到期前重复派发', receiver.events('/runtime-lease')[0]!.at >= leaseUntil);
    }
    // Expired rows may still be active or already disabled by maintenance.
    for (const active of [0, 1]) {
      for (const omitCursor of [false, true]) {
        const f = fixture();
        const path = `/runtime-renew-${active}-${omitCursor}`;
        const sub = await f.subscribe(path);
        await f.send('queued before expiry');
        await scanEventSubscriptions(f.env);
        const before = f.db.prepare('SELECT scanned_seq FROM mcp_event_subscriptions WHERE subscription_id=?')
          .get(sub.id) as { scanned_seq: number };
        const queued = f.db.prepare('SELECT delivery_id FROM mcp_event_deliveries').get() as { delivery_id: string };
        f.db.prepare('UPDATE mcp_event_subscriptions SET active=?,refresh_before=? WHERE subscription_id=?')
          .run(active, Date.now() - 1, sub.id);
        await f.send('unscanned during expiry');
        // The spread, rather than a default argument, exercises a truly omitted cursor.
        const renewed = await subscribeEvents(f.env, f.principal(TARGET), {
          name: 'agentnet.message.created', arguments: { attention: 'action_required' },
          ...(omitCursor ? {} : { cursor: null }),
          delivery: { mode: 'webhook', url: receiver.url(path), secret },
        });
        const label = `过期续订 active=${active} cursor=${omitCursor ? 'omitted' : 'null'}`;
        checkEqual(`${label} 复用订阅`, renewed.id, sub.id);
        checkEqual(`${label} 不丢队列`, (f.db.prepare('SELECT delivery_id FROM mcp_event_deliveries').get() as { delivery_id: string } | null)?.delivery_id, queued.delivery_id);
        checkEqual(`${label} 不跳过未扫描消息`, (f.db.prepare(
          'SELECT scanned_seq FROM mcp_event_subscriptions WHERE subscription_id=?',
        ).get(sub.id) as { scanned_seq: number }).scanned_seq, before.scanned_seq);
        scheduleEventsTick(f.env);
        await delivered(f, 2, `${label} 自动补齐队列和未扫描消息`);
      }
    }
    // A brand new cursor-less subscription must still start at the current head.
    {
      const f = fixture();
      await f.send('old message');
      await f.subscribe('/runtime-new');
      await runEventsTick(f.env);
      checkEqual('新订阅不重放历史', f.count('delivered'), 0);
      const next = await f.send('new message');
      scheduleEventsTick(f.env);
      await delivered(f, 1, '新订阅从新消息开始');
      checkEqual('新订阅只收到新消息', receivedIds('/runtime-new').join(), next.message.message_id);
    }
    // Shutting down one environment must cancel its timer without blocking another.
    {
      const stopped = fixture();
      await stopped.subscribe('/runtime-stopped');
      await stopped.send('must not run after shutdown');
      await scanEventSubscriptions(stopped.env);
      stopped.db.prepare('UPDATE mcp_event_deliveries SET next_attempt_at=?').run(Date.now() + 150);
      await runEventsTick(stopped.env);
      await stopEventsRuntime(stopped.env);
      scheduleEventsTick(stopped.env);
      const live = fixture();
      await live.subscribe('/runtime-independent');
      await live.send('another Env remains live');
      scheduleEventsTick(live.env);
      await delivered(live, 1, '不同 Env 调度互不阻塞');
      await sleep(200);
      checkEqual('关闭后不再唤醒或派发', receiver.events('/runtime-stopped').length, 0);
    }
  } finally {
    for (const { db, env } of fixtures) {
      await stopEventsRuntime(env);
      db.close();
    }
    receiver.stop();
  }
}
