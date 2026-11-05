/**
 * Agent 上下线状态机的本地事务测试。
 *
 * 使用内存 SQLite + 可控时钟，不依赖正在运行的服务；由协议验收调用。
 * 在线判定是“SSE 连接或最近活动”：覆盖请求触碰、活动 TTL、最后连接关闭、
 * pending 取消/超期、sweep 兜底、重启恢复、节流与事务回滚。
 */

import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { migrate } from '../../src/bun/migrate';
import { createD1 } from '../../src/bun/d1';
import type { Env } from '../../src/env';
import { NotificationHub } from '../../src/realtime/hub';
import { scheduleOutboxDrain } from '../../src/realtime/outbox';
import { AgentPresenceTimeline } from '../../src/realtime/presence-timeline';
import { check, checkEqual } from './harness';

const MIGRATIONS = resolve(import.meta.dir, '../../migrations');
const GRACE_MS = 1_000;
const ACTIVITY_TTL_MS = 2_000;
const TOUCH_THROTTLE_MS = 100;

function seed(db: Database): void {
  const at = 1;
  db.exec(`
    INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
                        inbox_min_seq, pending_count, created_at, updated_at)
    VALUES ('agt_unit', 'agent', 'sess_unit', 'Unit Agent', '{}', 0, 0, 0, ${at}, ${at}),
           ('usr_unit', 'human', NULL, 'Unit Human', '{}', 0, 0, 0, ${at}, ${at}),
           ('usr_other', 'human', NULL, 'Other Human', '{}', 0, 0, 0, ${at}, ${at}),
           ('agt_other', 'agent', 'sess_other', 'Other Agent', '{}', 0, 0, 0, ${at}, ${at});

    INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
                       member_seq, last_message_id, created_at, updated_at)
    VALUES ('rm_direct', 'direct', 'usr_unit', '', 'pair_direct', 0, 0, 0, NULL, ${at}, ${at}),
           ('rm_group', 'group', 'usr_unit', 'Group', NULL, 0, 0, 0, NULL, ${at}, ${at}),
           ('rm_hh', 'direct', 'usr_unit', '', 'pair_hh', 0, 0, 0, NULL, ${at}, ${at}),
           ('rm_aa', 'direct', 'agt_unit', '', 'pair_aa', 0, 0, 0, NULL, ${at}, ${at});

    INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES ('rm_direct', 'usr_unit', 'owner', 'active', 0, 0, ${at}),
           ('rm_direct', 'agt_unit', 'member', 'active', 0, 0, ${at}),
           ('rm_group', 'usr_unit', 'owner', 'active', 0, 0, ${at}),
           ('rm_group', 'agt_unit', 'member', 'active', 0, 0, ${at}),
           ('rm_hh', 'usr_unit', 'owner', 'active', 0, 0, ${at}),
           ('rm_hh', 'usr_other', 'member', 'active', 0, 0, ${at}),
           ('rm_aa', 'agt_unit', 'owner', 'active', 0, 0, ${at}),
           ('rm_aa', 'agt_other', 'member', 'active', 0, 0, ${at});
  `);
}

function presenceCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM room_presence_events').get() as { n: number }).n;
}

function pendingOutbox(db: Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'processing')")
      .get() as { n: number }
  ).n;
}

function presenceRows(db: Database): {
  room_id: string;
  transition: string;
  occurred_at: number;
  timeline_seq: number;
  time_basis: string;
  generation_id: string;
}[] {
  return db
    .prepare(
      'SELECT room_id, transition, occurred_at, timeline_seq, time_basis, generation_id FROM room_presence_events ORDER BY timeline_seq',
    )
    .all() as {
    room_id: string;
    transition: string;
    occurred_at: number;
    timeline_seq: number;
    time_basis: string;
    generation_id: string;
  }[];
}

function stateOf(db: Database): {
  phase: string;
  generation_id: string;
  online_at: number;
  last_seen_at: number | null;
  disconnect_observed_at: number | null;
  offline_due_at: number | null;
} {
  return db
    .prepare(
      'SELECT phase, generation_id, online_at, last_seen_at, disconnect_observed_at, offline_due_at FROM agent_presence_state WHERE actor_id = ?',
    )
    .get('agt_unit') as {
    phase: string;
    generation_id: string;
    online_at: number;
    last_seen_at: number | null;
    disconnect_observed_at: number | null;
    offline_due_at: number | null;
  };
}

function snapshotInvariants(db: Database): string {
  return JSON.stringify({
    room: db.prepare('SELECT head_seq, last_message_id FROM rooms WHERE room_id = ?').get('rm_direct'),
    actor: db
      .prepare('SELECT pending_count, inbox_head_seq FROM actors WHERE actor_id = ?')
      .get('usr_unit'),
    member: db
      .prepare('SELECT last_read_seq FROM room_members WHERE room_id = ? AND actor_id = ?')
      .get('rm_direct', 'usr_unit'),
  });
}

/** 0007 回填：online 行取 online_at，pending/offline 保持 NULL。 */
function checkActivityMigrationBackfill(): void {
  const db = new Database(':memory:');
  const files = [
    '0001_initial.sql',
    '0002_named_guards.sql',
    '0003_room_files.sql',
    '0004_mcp_events.sql',
    '0005_agent_archive.sql',
    '0006_agent_presence.sql',
  ];
  for (const file of files) db.exec(readFileSync(resolve(MIGRATIONS, file), 'utf8'));
  seed(db);
  db.exec(`
    INSERT INTO agent_presence_state
      (actor_id, revision, generation_id, phase, online_at, disconnect_observed_at,
       offline_due_at, time_basis, updated_at)
    VALUES ('agt_unit', 1, 'gen_backfill', 'online', 111, NULL, NULL, 'observed', 111),
           ('agt_other', 1, 'gen_old', 'offline', 222, NULL, NULL, 'observed', 222);
  `);
  db.exec(readFileSync(resolve(MIGRATIONS, '0007_agent_presence_activity.sql'), 'utf8'));
  const rows = db
    .prepare('SELECT actor_id, phase, last_seen_at FROM agent_presence_state ORDER BY actor_id')
    .all() as { actor_id: string; phase: string; last_seen_at: number | null }[];
  const onlineRow = rows.find((row) => row.actor_id === 'agt_unit');
  const offlineRow = rows.find((row) => row.actor_id === 'agt_other');
  checkEqual('0007 回填 online 的 last_seen_at', onlineRow?.last_seen_at, 111);
  checkEqual('0007 不给 offline 伪造心跳', offlineRow?.last_seen_at, null);
  db.close();
}

export async function runAgentPresenceUnitChecks(): Promise<void> {
  checkActivityMigrationBackfill();

  const db = new Database(':memory:');
  migrate(db, MIGRATIONS);
  seed(db);
  const d1 = createD1(db);
  let now = 1_700_000_000_000;
  let connected = false;
  const errors: unknown[] = [];
  const hub = new NotificationHub(db);
  const frames: string[] = [];
  const humanStream = hub.subscribeActor('usr_unit', 'human', 'sub_presence_unit', (frame) => {
    frames.push(frame);
  });
  const env: Env = {
    DB: d1,
    NOTIFICATION_HUB: hub,
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://127.0.0.1',
  };
  let committed = 0;
  const drains: Promise<unknown>[] = [];
  const settleDrains = async (): Promise<void> => {
    while (drains.length > 0) {
      await Promise.allSettled(drains.splice(0));
    }
  };
  const service = new AgentPresenceTimeline(d1, {
    graceMs: GRACE_MS,
    activityTtlMs: ACTIVITY_TTL_MS,
    touchThrottleMs: TOUCH_THROTTLE_MS,
    now: () => now,
    hasConnection: () => connected,
    onError: (error) => errors.push(error),
    onPresenceCommitted: () => {
      committed += 1;
      drains.push(scheduleOutboxDrain(env));
    },
  });

  const before = snapshotInvariants(db);
  const firstTouchAt = now;

  // 1. 无 SSE、只有请求：第一次请求就产生 observed 上线。
  await service.touch('agt_unit');
  checkEqual('首个请求写入一条上线', presenceCount(db), 1);
  checkEqual('上线只写 direct 人类会话', presenceRows(db)[0]?.room_id, 'rm_direct');
  checkEqual('请求上线 transition', presenceRows(db)[0]?.transition, 'online');
  checkEqual('请求上线 occurred_at', presenceRows(db)[0]?.occurred_at, firstTouchAt);
  checkEqual('请求上线 basis 为 observed', presenceRows(db)[0]?.time_basis, 'observed');
  checkEqual('请求上线写 last_seen_at', stateOf(db).last_seen_at, firstTouchAt);

  await settleDrains();
  check('上线提交后触发 outbox drain', committed >= 1, committed);
  checkEqual('上线 outbox 已被消费', pendingOutbox(db), 0);
  check(
    '人类 stream 收到上线 presence 通知',
    frames.some(
      (frame) => frame.includes('"source":"room.presence"') && frame.includes('"transition":"online"'),
    ),
    frames,
  );
  checkEqual('上线不改变 head/未读/pending', snapshotInvariants(db), before);

  // 2. 20 秒轮询的等价场景：TTL 内持续 touch，不产生新 generation/事件。
  const firstGeneration = presenceRows(db)[0]?.generation_id;
  now = firstTouchAt + 1_000;
  await service.touch('agt_unit');
  now = firstTouchAt + 1_900;
  await service.touch('agt_unit');
  await service.sweep();
  checkEqual('轮询保持在线不新增事件', presenceCount(db), 1);
  checkEqual('轮询不换 generation', stateOf(db).generation_id, firstGeneration);
  checkEqual('轮询保持在 online', stateOf(db).phase, 'online');
  checkEqual('轮询刷新 last_seen_at', stateOf(db).last_seen_at, firstTouchAt + 1_900);

  // 3. 节流：间隔小于阈值不重复写库，但状态不丢。
  await service.touch('agt_unit', firstTouchAt + 1_950);
  checkEqual('节流窗口内不写 last_seen_at', stateOf(db).last_seen_at, firstTouchAt + 1_900);
  now = firstTouchAt + 2_050;
  await service.touch('agt_unit');
  checkEqual('超过节流窗口后写入', stateOf(db).last_seen_at, firstTouchAt + 2_050);

  // 4. 停止请求：TTL 到期后 sweep 兜底进入 pending，再到 due 确认 inferred 下线。
  const lastActivity = stateOf(db).last_seen_at as number;
  now = lastActivity + ACTIVITY_TTL_MS + 100;
  await service.sweep();
  checkEqual('活动 TTL 到期进入 pending', stateOf(db).phase, 'pending_offline');
  checkEqual('pending 记录可用性过期点', stateOf(db).disconnect_observed_at, lastActivity + ACTIVITY_TTL_MS);
  checkEqual('进入 pending 不立即写下线', presenceCount(db), 1);
  now = lastActivity + ACTIVITY_TTL_MS + GRACE_MS - 100;
  await service.sweep();
  checkEqual('grace 前不确认下线', presenceCount(db), 1);
  now = lastActivity + ACTIVITY_TTL_MS + GRACE_MS + 100;
  await service.sweep();
  await settleDrains();
  checkEqual('grace 到期确认下线', presenceCount(db), 2);
  const firstOffline = presenceRows(db).at(-1);
  checkEqual('TTL 下线 transition', firstOffline?.transition, 'offline');
  checkEqual('TTL 下线时间为最后活动 + TTL', firstOffline?.occurred_at, lastActivity + ACTIVITY_TTL_MS);
  checkEqual('TTL 下线 basis 为 inferred', firstOffline?.time_basis, 'inferred');
  checkEqual('下线后 phase 为 offline', stateOf(db).phase, 'offline');

  // 5. 离线后的第一个请求：先写新 generation 上线，再处理业务。
  const offlineSeq = firstOffline?.timeline_seq ?? 0;
  const restartAt = lastActivity + 10_000;
  now = restartAt;
  await service.touch('agt_unit');
  const afterRestart = presenceRows(db).at(-1);
  checkEqual('离线后请求写新上线', afterRestart?.transition, 'online');
  check(
    '新上线排在此前下线之后',
    Boolean(afterRestart && afterRestart.timeline_seq > offlineSeq),
    { offlineSeq, onlineSeq: afterRestart?.timeline_seq },
  );
  check(
    '离线后请求使用新 generation',
    afterRestart?.generation_id !== firstOffline?.generation_id,
    { before: firstOffline?.generation_id, after: afterRestart?.generation_id },
  );
  const restartedGeneration = afterRestart?.generation_id;
  await service.touch('agt_unit', restartAt);
  await service.touch('agt_unit', restartAt + 1);
  checkEqual('重复请求不重复 generation', presenceRows(db).filter((row) => row.transition === 'online').length, 2);
  checkEqual('重复请求保持同一 generation', stateOf(db).generation_id, restartedGeneration);

  // 6. pending 窗口内请求取消 pending，不产生新的上下线。
  connected = false;
  const closeAt = restartAt + 5_000;
  now = closeAt;
  service.connectionClosed('agt_unit');
  await service.flush();
  const ttlExpiry = restartAt + ACTIVITY_TTL_MS;
  checkEqual(
    '最后连接关闭后可用性取 max(断连, 最后活动+TTL)',
    stateOf(db).disconnect_observed_at,
    Math.max(closeAt, ttlExpiry),
  );
  now = closeAt + 200;
  await service.touch('agt_unit');
  checkEqual('pending 窗口内请求取消 pending', stateOf(db).phase, 'online');
  checkEqual('取消 pending 不新增事件', presenceCount(db), 3);
  checkEqual('取消 pending 保留原 generation', stateOf(db).generation_id, restartedGeneration);
  checkEqual('取消 pending 刷新 last_seen_at', stateOf(db).last_seen_at, closeAt + 200);

  // 7. SSE 存活但长期无请求：sweep 兜底不能下线。
  connected = true;
  now = closeAt + 200_000;
  await service.sweep();
  checkEqual('有连接时长期无请求仍在线', stateOf(db).phase, 'online');
  checkEqual('有连接时不写离线', presenceCount(db), 3);

  // 8. 最后连接关闭且无请求：TTL + grace 后下线。
  connected = false;
  const lastSeen = stateOf(db).last_seen_at as number;
  const closedAfterIdle = now;
  service.connectionClosed('agt_unit');
  await service.flush();
  const idleExpiry = Math.max(closedAfterIdle, lastSeen + ACTIVITY_TTL_MS);
  checkEqual('空闲断连的过期点', stateOf(db).disconnect_observed_at, idleExpiry);
  now = idleExpiry + GRACE_MS + 1;
  await service.sweep();
  await settleDrains();
  checkEqual('空闲断连后确认下线', presenceCount(db), 4);
  checkEqual('空闲断连下线时间', presenceRows(db).at(-1)?.occurred_at, idleExpiry);
  checkEqual('空闲断连下线 inferred', presenceRows(db).at(-1)?.time_basis, 'inferred');

  // 9. 超 due 的请求：先确认旧下线，再写新上线。
  now = idleExpiry + 20_000;
  await service.touch('agt_unit');
  const reopenedAt = now;
  connected = false;
  service.connectionClosed('agt_unit');
  await service.flush();
  const reopenExpiry = Math.max(reopenedAt, stateOf(db).last_seen_at! + ACTIVITY_TTL_MS);
  now = reopenExpiry + GRACE_MS + 1;
  await service.touch('agt_unit');
  const ordered = presenceRows(db).slice(-2);
  checkEqual('超 due 请求先写旧下线', ordered[0]?.transition, 'offline');
  checkEqual('超 due 请求后写新上线', ordered[1]?.transition, 'online');
  check(
    '超 due 事件顺序为旧下线在前',
    Boolean(ordered[0] && ordered[1] && ordered[0].timeline_seq < ordered[1].timeline_seq),
    ordered,
  );
  checkEqual('超 due 旧下线时间为过期点', ordered[0]?.occurred_at, reopenExpiry);
  checkEqual('超 due 后状态为 online', stateOf(db).phase, 'online');

  // 10. 重启恢复：last_seen_at 从 SQLite 恢复，online 收敛为 pending。
  const recoveryTouch = now;
  connected = true;
  await service.touch('agt_unit');
  const restarted = new AgentPresenceTimeline(d1, {
    graceMs: GRACE_MS,
    activityTtlMs: ACTIVITY_TTL_MS,
    touchThrottleMs: TOUCH_THROTTLE_MS,
    now: () => now,
    hasConnection: () => false,
    onError: (error) => errors.push(error),
  });
  const beforeRecover = presenceCount(db);
  now = recoveryTouch + 500;
  const recovered = await restarted.recover();
  checkEqual('启动扫描恢复一条 online', recovered, 1);
  checkEqual('恢复后 phase 为 pending', stateOf(db).phase, 'pending_offline');
  checkEqual(
    '恢复使用持久化的 last_seen_at',
    stateOf(db).disconnect_observed_at,
    recoveryTouch + ACTIVITY_TTL_MS,
  );
  checkEqual('恢复不立即写离线', presenceCount(db), beforeRecover);
  now = recoveryTouch + ACTIVITY_TTL_MS + GRACE_MS + 1;
  await restarted.sweep();
  checkEqual('恢复后到期确认下线', presenceCount(db), beforeRecover + 1);
  checkEqual('恢复下线 basis 为 inferred', presenceRows(db).at(-1)?.time_basis, 'inferred');
  checkEqual('恢复下线时间为最后活动 + TTL', presenceRows(db).at(-1)?.occurred_at, recoveryTouch + ACTIVITY_TTL_MS);

  // 11. 迁移后遗留的 online 行（last_seen 为 NULL）不崩溃：回退到 online_at。
  await restarted.touch('agt_unit');
  db.prepare('UPDATE agent_presence_state SET last_seen_at = NULL WHERE actor_id = ?').run('agt_unit');
  const legacyOnlineAt = stateOf(db).online_at;
  now += 500;
  const legacyRecover = new AgentPresenceTimeline(d1, {
    graceMs: GRACE_MS,
    activityTtlMs: ACTIVITY_TTL_MS,
    now: () => now,
    hasConnection: () => false,
    onError: (error) => errors.push(error),
  });
  await legacyRecover.recover();
  checkEqual('last_seen 为空时 pending 不崩溃', stateOf(db).phase, 'pending_offline');
  checkEqual(
    'last_seen 为空时回退 online_at',
    stateOf(db).disconnect_observed_at,
    legacyOnlineAt + ACTIVITY_TTL_MS,
  );
  now = legacyOnlineAt + ACTIVITY_TTL_MS + GRACE_MS + 1;
  await legacyRecover.sweep();
  checkEqual('遗留 online 行收敛为 offline', stateOf(db).phase, 'offline');
  checkEqual(
    '遗留行离线时间为 online_at + TTL',
    presenceRows(db).at(-1)?.occurred_at,
    legacyOnlineAt + ACTIVITY_TTL_MS,
  );

  checkEqual('状态机测试运行期间 invariants 不变', snapshotInvariants(db), before);

  // 12. 事务回滚：触发器让 presence 行写入失败，state/events/outbox 必须整体回滚。
  db.exec(`
    CREATE TRIGGER fail_presence_insert BEFORE INSERT ON room_presence_events
    BEGIN SELECT RAISE(ABORT, 'presence test failure'); END;
  `);
  errors.length = 0;
  const beforeFailure = {
    events: (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
    outbox: (db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n,
    presence: presenceCount(db),
    state: db.prepare('SELECT phase, revision FROM agent_presence_state WHERE actor_id = ?').get('agt_unit'),
  };
  await service.touch('agt_unit').catch((error) => errors.push(error));
  check('写入失败进入错误处理而不是静默成功', errors.length > 0, errors.length);
  checkEqual('失败后 presence 不新增', presenceCount(db), beforeFailure.presence);
  checkEqual(
    '失败后事件不新增',
    (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
    beforeFailure.events,
  );
  checkEqual(
    '失败后 outbox 不新增',
    (db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n,
    beforeFailure.outbox,
  );
  checkEqual(
    '失败后状态不推进',
    JSON.stringify(db.prepare('SELECT phase FROM agent_presence_state WHERE actor_id = ?').get('agt_unit')),
    JSON.stringify({ phase: (beforeFailure.state as { phase: string }).phase }),
  );
  db.exec('DROP TRIGGER fail_presence_insert');
  await service.touch('agt_unit');
  checkEqual('移除失败注入后可正常上线', presenceRows(db).at(-1)?.transition, 'online');
  await settleDrains();

  humanStream.unsubscribe();
  db.close();
}
