/**
 * PWA 阶段 4a 单元验收：恢复合并、历史补洞批次/续读/重建、已读水位。
 *
 * 浏览器触发与真实网络由 `tests/e2e/pwa-recovery.spec.ts` 覆盖；这里只测
 * 可在 Bun 中注入时钟与分页器的纯逻辑。
 */

import { renderedWatermark } from '../src/web/lib/chat';
import {
  catchUpGap,
  type CatchUpPage,
} from '../src/web/lib/history-recovery';
import {
  createOutboxIntent,
  findReusableIntent,
  isOutboxStorageKey,
  outboxStorageKey,
  readOutbox,
  removeOutboxIntent,
  writeOutbox,
  type OutboxIntent,
  type OutboxStorage,
} from '../src/web/lib/outbox';
import {
  applySendStatus,
  reconcileOutboxStatuses,
} from '../src/web/lib/outbox-reconcile';
import {
  bumpIdentityEpoch,
  currentIdentityEpoch,
  observeIdentity,
} from '../src/web/lib/identity-epoch';
import {
  RecoveryScheduler,
  type RecoveryRound,
} from '../src/web/lib/recovery-coordinator';
import {
  getRecoverySnapshot,
  reportIdentitySignal,
  reportRecoveryBlocked,
  reportRecoveryOffline,
  reportRecoveryReady,
  reportRecoveryUnavailable,
} from '../src/web/pwa/recovery';
import { check, checkEqual, checksPassed } from './lib/harness';

interface MessageItem {
  kind?: 'message';
  message_id: string;
  room_id: string;
  sender_id: string;
  created_seq: string;
  preview: string;
  body_bytes: number;
  created_at: string;
  reply_to: string | null;
  root_id: string | null;
  hop: number;
  delivery_states: Record<string, number>;
  mentions: never[];
  delivery_claimed_at: string | null;
  delivery_updated_at: string | null;
  sender_kind: 'human' | 'agent' | null;
}

function message(seq: number): MessageItem {
  return {
    kind: 'message',
    message_id: `m${seq}`,
    room_id: 'room-1',
    sender_id: 'actor-a',
    created_seq: String(seq),
    preview: `消息 ${seq}`,
    body_bytes: 4,
    created_at: String(1_700_000_000_000 + seq),
    reply_to: null,
    root_id: null,
    hop: 0,
    delivery_states: {},
    mentions: [],
    delivery_claimed_at: null,
    delivery_updated_at: null,
    sender_kind: 'human',
  };
}

function page(range: [number, number], nextCursor: string | null, hasMore: boolean): CatchUpPage {
  return {
    items: Array.from({ length: range[1] - range[0] + 1 }, (_, index) => message(range[0] + index)),
    nextCursor,
    hasMore,
    resumeCursor: `resume:${range[1]}`,
    snapshot: '2100',
    authorization: { member_generation: '1', history_from_seq: '0' },
  };
}

function fakeTimers() {
  let now = 10_000;
  const timers: { id: number; at: number; callback: () => void }[] = [];
  let nextId = 1;
  const advance = async (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.callback();
      await Promise.resolve();
    }
  };
  return {
    now: () => now,
    setTimer: (callback: () => void, delay: number) => {
      const id = nextId++;
      timers.push({ id, at: now + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      const index = timers.findIndex((item) => item.id === (timer as unknown as number));
      if (index >= 0) timers.splice(index, 1);
    },
    advance,
  };
}

async function verifyScheduler(): Promise<void> {
  const rounds: RecoveryRound[] = [];
  const clock = fakeTimers();
  const scheduler = new RecoveryScheduler((round) => {
    rounds.push(round);
  }, {
    debounceMs: 300,
    quietMs: 1_500,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  check('online 首次触发', scheduler.trigger('online'));
  check('visibility 在窗口内不另排', !scheduler.trigger('visibility'));
  check('ACK 在窗口内不另排', !scheduler.trigger('stream-ack'));
  await clock.advance(299);
  checkEqual('300ms 前不执行', rounds.length, 0);
  await clock.advance(1);
  checkEqual('三种触发只跑一轮', rounds.length, 1);
  checkEqual('合并后的原因数', rounds[0]?.reasons.length, 3);
  check('普通触发不请求遮罩', !rounds[0]?.masked);
  check('普通触发不是长后台', !rounds[0]?.longBackground);
  checkEqual('轮次计数', scheduler.rounds, 1);
  await clock.advance(1_500);
  check('静默窗口结束后可再次触发', scheduler.trigger('online'));
  await clock.advance(300);
  checkEqual('静默窗口后的新触发执行第二轮', rounds.length, 2);
  checkEqual('第二轮原因数', rounds[1]?.reasons.length, 1);
  await clock.advance(1_500);
  check(
    '长后台触发',
    scheduler.trigger('visibility', { longBackground: true }),
  );
  await clock.advance(300);
  checkEqual('长后台执行第三轮', rounds.length, 3);
  check('长后台不请求遮罩', !rounds[2]?.masked);
  check('长后台标记完整核对', rounds[2]?.longBackground);
  await clock.advance(1_500);
  check('身份信号触发', scheduler.trigger('auth', { mask: true }));
  await clock.advance(300);
  checkEqual('身份信号执行第四轮', rounds.length, 4);
  check('身份信号请求遮罩', rounds[3]?.masked);
  check('身份信号不冒充长后台', !rounds[3]?.longBackground);
  scheduler.close();
}

async function verifyCatchUpBatches(): Promise<void> {
  const calls: string[] = [];
  const batches: number[] = [];
  const cursors = Array.from({ length: 22 }, (_, index) => `c${index}`);
  let next = 0;
  const fetchPage = async (cursor: string): Promise<CatchUpPage> => {
    calls.push(cursor);
    const index = next++;
    const start = index * 100 + 1;
    const end = index * 100 + 100;
    return page([start, end], cursors[index + 1] ?? null, index < 20);
  };
  const result = await catchUpGap({
    initialItems: [message(2100)],
    resumeCursor: 'c0',
    targetSnapshot: '2100',
    fetchPage,
    authorizationKey: (auth) => auth ? `${auth.member_generation}:${auth.history_from_seq}` : null,
    pageBudget: 20,
    onBatch: (batch) => batches.push(batch.pages),
    yieldToMain: async () => undefined,
  });
  checkEqual('补读覆盖 21 页', result.pages, 21);
  checkEqual('补读分 2 批', result.batches, 2);
  checkEqual('第一批 20 页、第二批 1 页', batches.join(','), '20,1');
  check('追平', result.caughtUp);
  checkEqual('最后覆盖游标', result.coveredCursor, 'c21');
  checkEqual('覆盖到的消息序号', result.coveredSeq, '2100');
  checkEqual('去重后 2100 条消息', result.items.length, 2100);
  checkEqual('按顺序从 c0 开始', calls[0], 'c0');
}

async function verifyCatchUpFailureResume(): Promise<void> {
  const calls: string[] = [];
  let next = 0;
  const fetchPage = async (cursor: string): Promise<CatchUpPage> => {
    calls.push(cursor);
    next += 1;
    if (next === 7) throw new Error('network down');
    const index = next - 1;
    return page([index * 100 + 1, index * 100 + 100], `c${index + 1}`, true);
  };
  const first = await catchUpGap({
    initialItems: [message(2100)],
    resumeCursor: 'c0',
    targetSnapshot: '2100',
    fetchPage,
    authorizationKey: () => 'g1:0',
    pageBudget: 20,
    yieldToMain: async () => undefined,
  });
  checkEqual('第 7 页失败', first.pages, 6);
  checkEqual('失败类型', first.failure?.kind, 'network');
  checkEqual('保留最后成功游标', first.coveredCursor, 'c6');
  check('未追平', !first.caughtUp);

  const rest: string[] = [];
  const second = await catchUpGap({
    initialItems: first.items,
    resumeCursor: first.coveredCursor,
    targetSnapshot: '2100',
    fetchPage: async (cursor) => {
      rest.push(cursor);
      const index = Number(cursor.slice(1));
      return page([index * 100 + 1, index * 100 + 100], `c${index + 1}`, index < 20);
    },
    authorizationKey: () => 'g1:0',
    pageBudget: 20,
    yieldToMain: async () => undefined,
  });
  checkEqual('从最后成功位置继续', rest[0], 'c6');
  check('第二轮追平', second.caughtUp);
  checkEqual('第二轮页数', second.pages, 15);
}

async function verifyCatchUpStale(): Promise<void> {
  const stalled = await catchUpGap({
    initialItems: [],
    resumeCursor: 'c0',
    targetSnapshot: '500',
    fetchPage: async () => ({
      items: [message(1)],
      nextCursor: 'c0',
      hasMore: true,
      resumeCursor: 'c0',
      snapshot: '500',
      authorization: { member_generation: '1', history_from_seq: '0' },
    }),
    authorizationKey: () => 'g1:0',
    yieldToMain: async () => undefined,
  });
  checkEqual('游标停滞判为 stale', stalled.failure?.kind, 'stale');

  const expired = await catchUpGap({
    initialItems: [],
    resumeCursor: 'c0',
    targetSnapshot: '500',
    fetchPage: async () => {
      const error = new Error('成员代次已变化') as Error & { code: string };
      error.code = 'CURSOR_EXPIRED';
      throw error;
    },
    authorizationKey: () => 'g1:0',
    yieldToMain: async () => undefined,
  });
  checkEqual('游标过期判为 stale', expired.failure?.kind, 'stale');

  let calls = 0;
  const generation = await catchUpGap({
    initialItems: [],
    resumeCursor: 'c0',
    targetSnapshot: '500',
    fetchPage: async () => {
      calls += 1;
      return {
        items: [message(calls)],
        nextCursor: `c${calls}`,
        hasMore: true,
        resumeCursor: `r${calls}`,
        snapshot: '500',
        authorization: { member_generation: calls === 1 ? '1' : '2', history_from_seq: '0' },
      };
    },
    expectedAuthorization: '1:0',
    authorizationKey: (auth) => auth ? `${auth.member_generation}:${auth.history_from_seq}` : null,
    yieldToMain: async () => undefined,
  });
  checkEqual('成员代次变化判为 stale', generation.failure?.kind, 'stale');
  checkEqual('代次变化后停止读取', calls, 2);
}

function verifyStickyIdentityMask(): void {
  reportRecoveryReady();
  check('初始未遮罩', !getRecoverySnapshot().masked);

  reportIdentitySignal();
  let state = getRecoverySnapshot();
  check('身份信号立即遮罩', state.masked && state.sticky);

  reportRecoveryUnavailable('network down');
  state = getRecoverySnapshot();
  check('重新鉴权网络失败不撤遮罩', state.masked && state.sticky);
  checkEqual('网络失败显示离线原因', state.phase, 'offline');

  reportRecoveryOffline();
  state = getRecoverySnapshot();
  check('离线不撤身份遮罩', state.masked && state.sticky);

  reportRecoveryReady();
  state = getRecoverySnapshot();
  check('成功鉴权后解除遮罩', !state.masked && !state.sticky);
  checkEqual('成功鉴权回到 ready', state.phase, 'ready');

  reportIdentitySignal();
  reportRecoveryBlocked('credential revoked');
  reportRecoveryUnavailable('network down');
  state = getRecoverySnapshot();
  check('撤权终态保持遮罩', state.masked && state.sticky);
  checkEqual('撤权终态不被网络失败覆盖', state.phase, 'blocked');
  checkEqual('撤权原因保留', state.blockedReason, 'credential revoked');

  reportRecoveryReady();
  check('重置粘性状态', !getRecoverySnapshot().sticky);
}

function verifyIdentityEpoch(): void {
  const start = currentIdentityEpoch();
  checkEqual(
    '首次观测身份推进代次',
    observeIdentity('actor-a', 'token-a'),
    start + 1,
  );
  checkEqual(
    '同一身份重复观测不推进',
    observeIdentity('actor-a', 'token-a'),
    start + 1,
  );
  checkEqual(
    'token 变化推进代次',
    observeIdentity('actor-a', 'token-b'),
    start + 2,
  );
  checkEqual(
    'actor 变化推进代次',
    observeIdentity('actor-b', 'token-b'),
    start + 3,
  );
  bumpIdentityEpoch();
  checkEqual('显式 bump 推进代次', currentIdentityEpoch(), start + 4);

  // 请求发起时记录代次；切号后回调读取到的当前值必须不同。
  const requestEpoch = currentIdentityEpoch();
  observeIdentity('actor-c', 'token-c');
  check('切号后旧请求代次失效', requestEpoch !== currentIdentityEpoch());
  bumpIdentityEpoch();
}

function verifyWatermark(): void {
  checkEqual('只取消息序号', renderedWatermark([message(7), message(9)]), '9');
  checkEqual(
    'presence 不推进已读',
    renderedWatermark([
      message(7),
      {
        kind: 'presence',
        presence_event_id: 'p1',
        room_id: 'room-1',
        agent_id: 'a1',
        transition: 'online',
        occurred_at: '1',
        recorded_at: '1',
        timeline_seq: '99',
        time_basis: 'observed',
      },
    ]),
    '7',
  );
  checkEqual('没有消息时为空', renderedWatermark([]), null);
}

class MemoryStorage implements OutboxStorage {
  readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

const ACTOR = 'actor-outbox';
const NOW = 1_700_000_000_000;

function outboxIntent(body: string, at = NOW, id?: string): OutboxIntent {
  const intent = createOutboxIntent({
    roomId: 'room-1',
    body,
    invoke: [],
    mentions: [],
    invokeExplicit: true,
    replyTo: null,
  });
  intent.client_message_id = id ?? intent.client_message_id;
  intent.updated_at = at;
  return intent;
}

function status(intent: OutboxIntent) {
  return {
    client_message_id: intent.client_message_id,
    found: true,
    message_id: `server-${intent.client_message_id}`,
    room_id: intent.room_id,
    created_seq: '10',
    delivery_ids: ['d1'],
    body_bytes: new TextEncoder().encode(intent.body).length,
    created_at: String(NOW),
  };
}

function verifyOutboxJournal(): void {
  const storage = new MemoryStorage();
  const legacyOnly = outboxIntent('旧版本记录', NOW - 10);
  storage.setItem(outboxStorageKey(ACTOR), JSON.stringify([legacyOnly]));
  checkEqual('旧整份 key 仍可读', readOutbox(ACTOR, NOW, storage).length, 1);

  const fromTabA = outboxIntent('标签 A', NOW - 5, 'client-a');
  const fromTabB = outboxIntent('标签 B', NOW, 'client-b');
  writeOutbox(ACTOR, [legacyOnly, fromTabA], { now: NOW, storage });
  writeOutbox(ACTOR, [fromTabB], { now: NOW, storage });
  const union = readOutbox(ACTOR, NOW, storage);
  checkEqual('两个标签的意图都在', union.length, 3);
  check('标签 A 未被覆盖', union.some((item) => item.client_message_id === 'client-a'));
  check('标签 B 已写入', union.some((item) => item.client_message_id === 'client-b'));

  const newer = { ...fromTabA, status: 'failed' as const, error: '新状态', updated_at: NOW + 10 };
  writeOutbox(ACTOR, [newer], { now: NOW + 10, storage });
  writeOutbox(ACTOR, [{ ...fromTabA, status: 'sending' as const, updated_at: NOW - 100 }], {
    now: NOW + 10,
    storage,
  });
  const winner = readOutbox(ACTOR, NOW + 10, storage).find(
    (item) => item.client_message_id === 'client-a',
  );
  checkEqual('较新 updated_at 胜出', winner?.status, 'failed');
  checkEqual('较新错误保留', winner?.error, '新状态');

  removeOutboxIntent(ACTOR, 'client-a', { now: NOW + 20, storage });
  // 模拟旧标签页用旧镜像把已删除意图写回来。
  storage.setItem(outboxStorageKey(ACTOR), JSON.stringify([fromTabA]));
  const afterRemove = readOutbox(ACTOR, NOW + 20, storage);
  check('tombstone 阻止旧镜像复活', !afterRemove.some((item) => item.client_message_id === 'client-a'));

  const committed = {
    ...outboxIntent('已提交', NOW + 1, 'client-c'),
    status: 'committed' as const,
    message_id: 'server-c',
    committed_at: NOW + 1,
  };
  writeOutbox(ACTOR, [committed], { now: NOW + 2, storage });
  writeOutbox(ACTOR, [], { now: NOW + 3, storage });
  check(
    '已提交且从列表移除后写 tombstone',
    !readOutbox(ACTOR, NOW + 3, storage).some((item) => item.client_message_id === 'client-c'),
  );
  check('journal key 识别', isOutboxStorageKey(ACTOR, `${outboxStorageKey(ACTOR)}:i:client-a`));
  check('其他 actor key 不识别', !isOutboxStorageKey(ACTOR, outboxStorageKey('other')));
}

function verifyOutboxReconcile(): void {
  const first = { ...outboxIntent('第一条', NOW, 'm1'), status: 'sending' as const };
  const second = { ...outboxIntent('第二条', NOW, 'm2'), status: 'sending' as const };
  const found = new Map([
    [first.client_message_id, status(first)],
    [second.client_message_id, status(second)],
  ]);
  const reconciled = reconcileOutboxStatuses([first, second], [first, second], found);
  checkEqual('两条 found 都提交', reconciled.items.filter((item) => item.status === 'committed').length, 2);
  check('记录 found', reconciled.found);
  checkEqual('第一条 message_id', reconciled.items[0]?.message_id, 'server-m1');
  checkEqual('第二条 message_id', reconciled.items[1]?.message_id, 'server-m2');

  const conflict = applySendStatus([first], first, {
    ...status(first),
    room_id: 'room-other',
  });
  checkEqual('client_message_id 冲突不可重试', conflict[0]?.retryable, false);

  const expired = {
    ...outboxIntent('过期', NOW - 25 * 60 * 60_000, 'm3'),
    status: 'failed' as const,
    retryable: true,
  };
  checkEqual('过期意图不复用', findReusableIntent([expired], {
    roomId: expired.room_id,
    body: expired.body,
    invoke: [],
    mentions: [],
    invokeExplicit: true,
    replyTo: null,
  }, NOW), null);
  const expiredResult = reconcileOutboxStatuses([expired], [expired], new Map(), NOW);
  checkEqual('对账发现过期不静默重发', expiredResult.items[0]?.retryable, false);
  checkEqual('过期错误可读', expiredResult.items[0]?.status, 'failed');

  const unknown = reconcileOutboxStatuses([second], [second], new Map(), NOW);
  checkEqual('查询成功但未找到的 sending 转为待确认', unknown.items[0]?.retryable, true);
  checkEqual('待确认不丢行', unknown.items.length, 1);
}

async function main(): Promise<void> {
  console.log('PWA 恢复单元验收');
  await verifyScheduler();
  await verifyCatchUpBatches();
  await verifyCatchUpFailureResume();
  await verifyCatchUpStale();
  verifyStickyIdentityMask();
  verifyIdentityEpoch();
  verifyWatermark();
  verifyOutboxJournal();
  verifyOutboxReconcile();
  console.log(`通过 ${checksPassed()} 项`);
}

await main();
