import type { Env } from '../env';
import { drainEventDeliveries } from './dispatcher';
import { scanEventSubscriptions } from './scanner';

let running = false;
let rerun = false;
let scheduled: ReturnType<typeof setTimeout> | null = null;

/**
 * 请求内快速路径与定时任务共用的一次 tick：先扫描再投递。
 *
 * - 模块级 running 防止同进程重入；
 * - running 期间的新触发只标记 rerun，结束后再调度一次，避免丢失。
 */
export async function runEventsTick(env: Env): Promise<void> {
  if (!env.EVENTS) return;
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    await scanEventSubscriptions(env);
    await drainEventDeliveries(env);
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      scheduleEventsTick(env);
    }
  }
}

/** 不阻塞响应路径的异步调度；多次触发合并为一次。 */
export function scheduleEventsTick(env: Env): void {
  if (!env.EVENTS || scheduled !== null) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    void runEventsTick(env).catch((error) => {
      console.error('agent-network events tick failed', error);
    });
  }, 0);
}
