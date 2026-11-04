/**
 * Agent 上下线状态机的本地事务测试。
 *
 * 使用内存 SQLite + 可控时钟，不依赖正在运行的服务；由协议验收调用，
 * 覆盖 grace、CAS 去重、重启恢复与事务回滚。
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

import { migrate } from '../../src/bun/migrate';
import { createD1 } from '../../src/bun/d1';
import type { Env } from '../../src/env';
import { NotificationHub } from '../../src/realtime/hub';
import { scheduleOutboxDrain } from '../../src/realtime/outbox';
import { AgentPresenceTimeline } from '../../src/realtime/presence-timeline';
import { check, checkEqual } from './harness';

const MIGRATIONS = resolve(import.meta.dir, '../../migrations');

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
}[] {
  return db
    .prepare(
      'SELECT room_id, transition, occurred_at, timeline_seq, time_basis FROM room_presence_events ORDER BY timeline_seq',
    )
    .all() as {
    room_id: string;
    transition: string;
    occurred_at: number;
    timeline_seq: number;
    time_basis: string;
  }[];
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

export async function runAgentPresenceUnitChecks(): Promise<void> {
  const db = new Database(':memory:');
  migrate(db, MIGRATIONS);
  seed(db);
  const d1 = createD1(db);
  let now = 1_700_000_000_000;
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
    graceMs: 1_000,
    now: () => now,
    onError: (error) => errors.push(error),
    onPresenceCommitted: () => {
      committed += 1;
      drains.push(scheduleOutboxDrain(env));
    },
  });

  const before = snapshotInvariants(db);
  const onlineAt = now;
  await service.recordLogin('agt_unit');
  checkEqual('首条上线只写 direct 人类会话', presenceCount(db), 1);
  checkEqual('上线房间是 direct human-agent', presenceRows(db)[0]?.room_id, 'rm_direct');
  checkEqual('上线事件 transition', presenceRows(db)[0]?.transition, 'online');
  checkEqual('上线 occurred_at 为实际发生时间', presenceRows(db)[0]?.occurred_at, onlineAt);
  checkEqual('上线不改变 head/未读/pending', snapshotInvariants(db), before);

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

  await service.recordLogin('agt_unit');
  checkEqual('重复 login 不新增记录', presenceCount(db), 1);

  // 最后连接断开：先 pending，grace 前不落历史。
  now += 100;
  const disconnectAt = now;
  service.connectionClosed('agt_unit');
  await service.flush();
  checkEqual('grace 前不写离线记录', presenceCount(db), 1);
  now = disconnectAt + 999;
  await service.sweep();
  checkEqual('未到 due 不确认下线', presenceCount(db), 1);

  // grace 内重连：清除 pending，保留原上线时间。
  now = disconnectAt + 500;
  await service.recordLogin('agt_unit');
  checkEqual('grace 内重连不新增上下线', presenceCount(db), 1);
  now = disconnectAt + 5_000;
  await service.sweep();
  checkEqual('重连后旧 pending 不再确认', presenceCount(db), 1);
  const stateAfterResume = db
    .prepare('SELECT phase, generation_id, online_at FROM agent_presence_state WHERE actor_id = ?')
    .get('agt_unit') as { phase: string; generation_id: string; online_at: number };
  checkEqual('重连后保持 online', stateAfterResume.phase, 'online');
  checkEqual('重连后保留原上线时间', stateAfterResume.online_at, onlineAt);

  // 重复 close / 重复 sweep：只产生一条离线。
  service.connectionClosed('agt_unit');
  service.connectionClosed('agt_unit');
  await service.flush();
  now += 1_500;
  await settleDrains();
  const committedBeforeSweep = committed;
  const frameCountBeforeSweep = frames.length;
  await service.sweep();
  await settleDrains();
  check(
    'sweep 确认下线后触发 outbox drain',
    committed > committedBeforeSweep,
    { committed, committedBeforeSweep },
  );
  check(
    '人类 stream 收到 sweep 确认的下线通知',
    frames
      .slice(frameCountBeforeSweep)
      .some(
        (frame) =>
          frame.includes('"source":"room.presence"') && frame.includes('"transition":"offline"'),
      ),
    frames.slice(frameCountBeforeSweep),
  );
  checkEqual('下线 outbox 已被消费', pendingOutbox(db), 0);
  await service.sweep();
  checkEqual('重复 close/sweep 只写一条下线', presenceCount(db), 2);
  const offline = presenceRows(db).find((row) => row.transition === 'offline');
  checkEqual('下线 occurred_at 为断开观察时刻', offline?.occurred_at, disconnectAt + 5_000);
  checkEqual('正常下线 basis 为 observed', offline?.time_basis, 'observed');

  // 超过 due 才重连：先确认旧下线，再写新上线。
  now += 10_000;
  await service.recordLogin('agt_unit');
  const expiredDisconnectAt = now;
  service.connectionClosed('agt_unit');
  await service.flush();
  now = expiredDisconnectAt + 2_000;
  await service.recordLogin('agt_unit');
  const ordered = presenceRows(db).slice(-2);
  const oldOffline = ordered[0];
  const newOnline = ordered[1];
  checkEqual('超 due 重连先写旧下线', oldOffline?.transition, 'offline');
  checkEqual('超 due 重连后写新上线', newOnline?.transition, 'online');
  check(
    '超 due 重连事件顺序为旧下线在前',
    Boolean(oldOffline && newOnline && oldOffline.timeline_seq < newOnline.timeline_seq),
    ordered,
  );
  checkEqual('超 due 下线时间仍为断开时刻', oldOffline?.occurred_at, expiredDisconnectAt);

  // pending 重启恢复：同一 DB 新建 service，无需内存状态。
  now += 100;
  const pendingDisconnectAt = now;
  service.connectionClosed('agt_unit');
  await service.flush();
  const restarted = new AgentPresenceTimeline(d1, {
    graceMs: 1_000,
    now: () => now,
    onError: (error) => errors.push(error),
  });
  const pendingBefore = presenceCount(db);
  now = pendingDisconnectAt + 1_500;
  await restarted.sweep();
  checkEqual('重启后确认遗留 pending 下线', presenceCount(db), pendingBefore + 1);

  // 崩溃恢复：online 转 pending inferred，确认后如实标记 inferred。
  await restarted.recordLogin('agt_unit');
  const crashAt = now;
  const crashed = new AgentPresenceTimeline(d1, {
    graceMs: 1_000,
    now: () => now,
    onError: (error) => errors.push(error),
  });
  const recovered = await crashed.recover();
  checkEqual('启动扫描恢复一条 online', recovered, 1);
  checkEqual('崩溃恢复不立即写离线', presenceCount(db), pendingBefore + 2);
  now = crashAt + 1_500;
  await crashed.sweep();
  const inferred = presenceRows(db).at(-1);
  checkEqual('崩溃恢复写离线', inferred?.transition, 'offline');
  checkEqual('崩溃恢复标记 inferred', inferred?.time_basis, 'inferred');
  checkEqual('崩溃恢复 occurred_at 为重启观察时刻', inferred?.occurred_at, crashAt);
  checkEqual('状态机测试运行期间 invariants 不变', snapshotInvariants(db), before);

  // 事务回滚：触发器让 presence 行写入失败，state/events/outbox 必须整体回滚。
  db.exec(`
    CREATE TRIGGER fail_presence_insert BEFORE INSERT ON room_presence_events
    BEGIN SELECT RAISE(ABORT, 'presence test failure'); END;
  `);
  errors.length = 0;
  const beforeFailure = {
    events: (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
    outbox: (db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n,
    presence: presenceCount(db),
    state: db.prepare('SELECT phase FROM agent_presence_state WHERE actor_id = ?').get('agt_unit'),
  };
  await service.recordLogin('agt_unit');
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
    JSON.stringify(beforeFailure.state),
  );
  db.exec('DROP TRIGGER fail_presence_insert');
  await service.recordLogin('agt_unit');
  checkEqual('移除失败注入后可正常上线', presenceRows(db).at(-1)?.transition, 'online');
  await settleDrains();

  humanStream.unsubscribe();
  db.close();
}
