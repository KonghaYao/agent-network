/**
 * MF10：Memory 运行时组合。
 *
 * 把三件事放到同一生命周期里，避免入口各自 setInterval：
 * 1. MemoryRuntime 启动恢复、作业领取、租约与关闭；
 * 2. unknown 作业对账（只查询原 JobRef，不重跑写入）；
 * 3. MCP/UI 可读的组合状态。
 *
 * 关闭顺序：停止调度 → 等待当前轮 → 停止运行时（中止在途适配器请求）。
 * 已提交的本地意图仍由数据库保留，重启可恢复。
 */
import { LIMITS } from '../contracts/limits';
import { nowMs } from '../storage/db';
import type { MemoryRuntime, MemoryRuntimeTickResult } from './runtime';

export interface MemoryIntegrationOptions {
  runtime: MemoryRuntime;
  now?: () => number;
  tickIntervalMs?: number;
  reconcileIntervalMs?: number;
  onError?: (error: unknown, scope: 'tick' | 'reconcile') => void;
}

export interface MemoryIntegrationStatus {
  started: boolean;
  running: boolean;
  capture: boolean;
  last_tick_at: number | null;
  last_tick: MemoryRuntimeTickResult | null;
  last_reconcile_at: number | null;
  last_reconcile: {
    completed: number;
    requeued: number;
    stillUnknown: number;
    unsupported: number;
  } | null;
}

export interface MemoryIntegrationRun {
  skipped: boolean;
  tick: MemoryRuntimeTickResult | null;
  reconcile: MemoryIntegrationStatus['last_reconcile'];
}

export class MemoryIntegration {
  readonly #runtime: MemoryRuntime;
  readonly #now: () => number;
  readonly #tickIntervalMs: number;
  readonly #reconcileIntervalMs: number;
  readonly #onError: NonNullable<MemoryIntegrationOptions['onError']>;

  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<MemoryIntegrationRun> | null = null;
  #lastTickAt: number | null = null;
  #lastTick: MemoryRuntimeTickResult | null = null;
  #lastReconcileAt: number | null = null;
  #lastReconcile: MemoryIntegrationStatus['last_reconcile'] = null;

  constructor(options: MemoryIntegrationOptions) {
    this.#runtime = options.runtime;
    this.#now = options.now ?? nowMs;
    this.#tickIntervalMs = Math.max(1, options.tickIntervalMs ?? LIMITS.memoryTickIntervalMs);
    this.#reconcileIntervalMs = Math.max(
      1,
      options.reconcileIntervalMs ?? LIMITS.memoryReconcileIntervalMs,
    );
    this.#onError = options.onError ?? (() => undefined);
  }

  get started(): boolean {
    return this.#started;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await this.#runtime.start();
    this.#started = true;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.runOnce().catch((error) => this.#onError(error, 'tick'));
    }, this.#tickIntervalMs);
    // 启动恢复已经由 runtime.start 完成；立即跑一轮领取/对账，不等待首个周期。
    // 不阻塞 HTTP 监听。
    void this.runOnce().catch((error) => this.#onError(error, 'tick'));
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight?.catch(() => undefined);
    await this.#runtime.stop();
    this.#started = false;
  }

  /**
   * 执行一轮：作业领取 → unknown 对账。
   *
   * 同一时刻只允许一轮；定时器与显式调用共享同一个 in-flight Promise。
   */
  async runOnce(): Promise<MemoryIntegrationRun> {
    if (!this.#started || this.#stopped) {
      return { skipped: true, tick: null, reconcile: null };
    }
    if (this.#inFlight) return this.#inFlight;
    const run = this.#execute().finally(() => {
      if (this.#inFlight === run) this.#inFlight = null;
    });
    this.#inFlight = run;
    return run;
  }

  async #execute(): Promise<MemoryIntegrationRun> {
    const now = this.#now();
    let tick: MemoryRuntimeTickResult | null = null;
    let reconcile: MemoryIntegrationStatus['last_reconcile'] = null;

    try {
      tick = await this.#runtime.tick();
      this.#lastTickAt = now;
      this.#lastTick = tick;
    } catch (error) {
      this.#onError(error, 'tick');
    }

    const reconcileDue =
      this.#lastReconcileAt === null ||
      now - this.#lastReconcileAt >= this.#reconcileIntervalMs ||
      (tick?.unknown ?? 0) > 0;
    if (reconcileDue && !this.#stopped) {
      try {
        reconcile = await this.#runtime.reconcile();
        this.#lastReconcileAt = now;
        this.#lastReconcile = reconcile;
      } catch (error) {
        this.#onError(error, 'reconcile');
      }
    }

    return { skipped: false, tick, reconcile };
  }

  status(): MemoryIntegrationStatus {
    return {
      started: this.#started,
      running: this.#inFlight !== null,
      capture: this.#runtime.captureEnabled,
      last_tick_at: this.#lastTickAt,
      last_tick: this.#lastTick,
      last_reconcile_at: this.#lastReconcileAt,
      last_reconcile: this.#lastReconcile,
    };
  }
}
