import type { Env } from '../env';
import { drainEventDeliveries, nextEventDeliveryAt } from './dispatcher';
import { scanEventSubscriptions } from './scanner';
import { LIMITS } from '../contracts/limits';
import { nowMs } from '../storage/db';

interface RuntimeState {
  running: Promise<void> | null;
  rerun: boolean;
  scheduled: ReturnType<typeof setTimeout> | null;
  scheduledAt: number;
  stopped: boolean;
  scanAfter: string;
  rescan: boolean;
  scanFailed: boolean;
}

// 一个 Env 一套调度状态；多个测试实例不共用锁或唤醒定时器。
const runtimes = new WeakMap<Env, RuntimeState>();

function stateFor(env: Env): RuntimeState {
  let state = runtimes.get(env);
  if (!state) {
    state = {
      running: null, rerun: false, scheduled: null, scheduledAt: 0, stopped: false,
      scanAfter: '', rescan: false, scanFailed: false,
    };
    runtimes.set(env, state);
  }
  return state;
}

function clearScheduled(state: RuntimeState): void {
  if (state.scheduled !== null) clearTimeout(state.scheduled);
  state.scheduled = null;
  state.scheduledAt = 0;
}

function scheduleAt(env: Env, state: RuntimeState, at: number): void {
  if (state.stopped) return;
  if (state.scheduled !== null && state.scheduledAt <= at) return;
  clearScheduled(state);
  state.scheduledAt = at;
  state.scheduled = setTimeout(() => {
    clearScheduled(state);
    void runEventsTick(env).catch((error) => {
      console.error('agent-network events tick failed', error);
    });
  }, Math.max(0, Math.min(at - nowMs(), LIMITS.eventsRuntimeMaxTimerMs)));
  state.scheduled.unref?.();
}

/**
 * 请求内快速路径与定时任务共用的一次 tick：先扫描再投递。
 *
 * 每轮扫描/投递有批次上限；剩余可执行工作让出事件循环后继续，重试和
 * 崩溃遗留租约按队首到期时间唤醒。新请求可提前未来的重试定时器。
 */
export async function runEventsTick(env: Env): Promise<void> {
  if (!env.EVENTS) return;
  const state = stateFor(env);
  if (state.stopped) return;
  if (state.running) {
    state.rerun = true;
    state.rescan = true;
    return;
  }
  clearScheduled(state);
  state.running = (async () => {
    const scan = await scanEventSubscriptions(env, state.scanAfter);
    state.scanAfter = scan.nextSubscriptionId ?? '';
    state.rescan ||= scan.moreToScan;
    state.scanFailed ||= scan.failed;
    await drainEventDeliveries(env);
    let nextScan: number | null = null;
    if (state.scanAfter !== '' || state.rescan) nextScan = nowMs();
    else if (state.scanFailed) nextScan = nowMs() + LIMITS.eventsRuntimeErrorRetryMs;
    if (state.scanAfter === '') {
      state.rescan = false;
      state.scanFailed = false;
    }
    const nextDelivery = await nextEventDeliveryAt(env);
    const next = nextScan === null ? nextDelivery
      : nextDelivery === null ? nextScan : Math.min(nextScan, nextDelivery);
    if (next !== null) scheduleAt(env, state, next);
  })();
  try {
    await state.running;
  } catch (error) {
    // 查询/派发异常不能丢掉唯一唤醒，也不能零延迟忙循环。
    scheduleAt(env, state, nowMs() + LIMITS.eventsRuntimeErrorRetryMs);
    throw error;
  } finally {
    state.running = null;
    if (state.rerun) {
      state.rerun = false;
      scheduleEventsTick(env);
    }
  }
}

/** 不阻塞响应路径的异步调度；多次触发合并为一次。 */
export function scheduleEventsTick(env: Env): void {
  if (!env.EVENTS) return;
  const state = stateFor(env);
  if (state.stopped) return;
  // 扫描期间新到的消息可能位于已经处理过的订阅；本轮结束后再查一轮。
  if (state.running || state.scanAfter !== '') state.rescan = true;
  if (state.running) {
    state.rerun = true;
    return;
  }
  scheduleAt(env, state, nowMs());
}

/** 关闭数据库前停掉后续唤醒，并等待当前有界批次退出。 */
export async function stopEventsRuntime(env: Env): Promise<void> {
  const state = runtimes.get(env);
  if (!state) return;
  state.stopped = true;
  state.rerun = false;
  clearScheduled(state);
  await state.running?.catch(() => {});
}
