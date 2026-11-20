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
import { RecoveryScheduler, type RecoveryReason } from '../src/web/lib/recovery-coordinator';
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
  task_root_id: string | null;
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
    task_root_id: null,
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
  const rounds: RecoveryReason[][] = [];
  const clock = fakeTimers();
  const scheduler = new RecoveryScheduler((round) => {
    rounds.push(round.reasons);
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
  checkEqual('合并后的原因数', rounds[0]?.length, 3);
  checkEqual('轮次计数', scheduler.rounds, 1);
  await clock.advance(1_500);
  check('静默窗口结束后可再次触发', scheduler.trigger('online'));
  await clock.advance(300);
  checkEqual('静默窗口后的新触发执行第二轮', rounds.length, 2);
  checkEqual('第二轮原因数', rounds[1]?.length, 1);
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

async function main(): Promise<void> {
  console.log('PWA 恢复单元验收');
  await verifyScheduler();
  await verifyCatchUpBatches();
  await verifyCatchUpFailureResume();
  await verifyCatchUpStale();
  verifyWatermark();
  console.log(`通过 ${checksPassed()} 项`);
}

await main();
