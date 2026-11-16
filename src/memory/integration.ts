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
import type { MemoryBackfillRun, MemoryBackfillStatus } from './backfill';
import type { MemoryProvisionSweepResult } from './provision';
import type { MemoryRuntime, MemoryRuntimeTickResult } from './runtime';

/** 回填由运行时组合托管，避免入口再新增一个独立 setInterval。 */
export interface MemoryBackfillRunner {
  runOnce(): Promise<MemoryBackfillRun>;
  status(): MemoryBackfillStatus;
}

/** Phase A provisioning sweep 由同一生命周期托管，启动一次 + 定时轮询。 */
export interface MemoryProvisionRunner {
  runOnce(): Promise<MemoryProvisionSweepResult>;
}

export interface MemoryIntegrationOptions {
  runtime: MemoryRuntime;
  backfill?: MemoryBackfillRunner;
  provision?: MemoryProvisionRunner;
  now?: () => number;
  tickIntervalMs?: number;
  reconcileIntervalMs?: number;
  backfillIntervalMs?: number;
  provisionIntervalMs?: number;
  onError?: (
    error: unknown,
    scope: 'tick' | 'reconcile' | 'backfill' | 'provision',
  ) => void;
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
  backfill_interval_ms: number | null;
  last_backfill_at: number | null;
  backfill: MemoryBackfillStatus | null;
  provision_interval_ms: number | null;
  last_provision_at: number | null;
  last_provision: MemoryProvisionSweepResult | null;
}

export interface MemoryIntegrationRun {
  skipped: boolean;
  tick: MemoryRuntimeTickResult | null;
  reconcile: MemoryIntegrationStatus['last_reconcile'];
}

export class MemoryIntegration {
  readonly #runtime: MemoryRuntime;
  readonly #backfill: MemoryBackfillRunner | null;
  readonly #provision: MemoryProvisionRunner | null;
  readonly #now: () => number;
  readonly #tickIntervalMs: number;
  readonly #reconcileIntervalMs: number;
  readonly #backfillIntervalMs: number;
  readonly #provisionIntervalMs: number;
  readonly #onError: NonNullable<MemoryIntegrationOptions['onError']>;

  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #backfillTimer: ReturnType<typeof setInterval> | null = null;
  #provisionTimer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<MemoryIntegrationRun> | null = null;
  #backfillInFlight: Promise<void> | null = null;
  #provisionInFlight: Promise<MemoryProvisionSweepResult | null> | null = null;
  #lastTickAt: number | null = null;
  #lastTick: MemoryRuntimeTickResult | null = null;
  #lastReconcileAt: number | null = null;
  #lastReconcile: MemoryIntegrationStatus['last_reconcile'] = null;
  #lastBackfillAt: number | null = null;
  #lastProvisionAt: number | null = null;
  #lastProvision: MemoryProvisionSweepResult | null = null;

  constructor(options: MemoryIntegrationOptions) {
    this.#runtime = options.runtime;
    this.#backfill = options.backfill ?? null;
    this.#provision = options.provision ?? null;
    this.#now = options.now ?? nowMs;
    this.#tickIntervalMs = Math.max(1, options.tickIntervalMs ?? LIMITS.memoryTickIntervalMs);
    this.#reconcileIntervalMs = Math.max(
      1,
      options.reconcileIntervalMs ?? LIMITS.memoryReconcileIntervalMs,
    );
    this.#backfillIntervalMs = Math.max(
      1,
      options.backfillIntervalMs ?? LIMITS.memoryBackfillIntervalMs,
    );
    this.#provisionIntervalMs = Math.max(
      1,
      options.provisionIntervalMs ?? LIMITS.memoryProvisionIntervalMs,
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
    if (this.#provision) {
      this.#provisionTimer = setInterval(() => {
        void this.runProvisionOnce();
      }, this.#provisionIntervalMs);
    }
    if (this.#backfill) {
      this.#backfillTimer = setInterval(() => {
        void this.runBackfillOnce();
      }, this.#backfillIntervalMs);
    }
    // 启动恢复已经由 runtime.start 完成；立即跑一轮领取/对账，不等待首个周期。
    // provisioning 同样先排定定时器再补偿；首次回填排在其后，避免存量
    // Agent 在第一个窗口因 no_space 被跳过。三者都不阻塞 HTTP 监听。
    const initialProvision = this.#provision
      ? this.runProvisionOnce()
      : Promise.resolve(null);
    void this.runOnce().catch((error) => this.#onError(error, 'tick'));
    void initialProvision.finally(() => {
      if (this.#backfill) void this.runBackfillOnce();
    });
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#backfillTimer) {
      clearInterval(this.#backfillTimer);
      this.#backfillTimer = null;
    }
    if (this.#provisionTimer) {
      clearInterval(this.#provisionTimer);
      this.#provisionTimer = null;
    }
    await this.#backfillInFlight?.catch(() => undefined);
    await this.#provisionInFlight?.catch(() => undefined);
    await this.#inFlight?.catch(() => undefined);
    await this.#runtime.stop();
    this.#started = false;
  }

  /** 执行一轮 provisioning sweep；定时器与启动补偿共享同一个 in-flight Promise。 */
  async runProvisionOnce(): Promise<MemoryProvisionSweepResult | null> {
    if (!this.#provision || !this.#started || this.#stopped) return null;
    if (this.#provisionInFlight) return this.#provisionInFlight;
    const run = this.#provision
      .runOnce()
      .then((result) => {
        this.#lastProvisionAt = this.#now();
        this.#lastProvision = result;
        return result;
      })
      .catch((error) => {
        this.#onError(error, 'provision');
        return null;
      })
      .finally(() => {
        if (this.#provisionInFlight === run) this.#provisionInFlight = null;
      });
    this.#provisionInFlight = run;
    return run;
  }

  /** 执行一轮回填；定时器与启动补偿共享同一个 in-flight Promise。 */
  async runBackfillOnce(): Promise<void> {
    if (!this.#backfill || !this.#started || this.#stopped) return;
    if (this.#backfillInFlight) return this.#backfillInFlight;
    const run = this.#backfill
      .runOnce()
      .then(() => {
        this.#lastBackfillAt = this.#now();
      })
      .catch((error) => {
        this.#onError(error, 'backfill');
      })
      .finally(() => {
        if (this.#backfillInFlight === run) this.#backfillInFlight = null;
      });
    this.#backfillInFlight = run;
    return run;
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
      backfill_interval_ms: this.#backfill ? this.#backfillIntervalMs : null,
      last_backfill_at: this.#lastBackfillAt,
      backfill: this.#backfill?.status() ?? null,
      provision_interval_ms: this.#provision ? this.#provisionIntervalMs : null,
      last_provision_at: this.#lastProvisionAt,
      last_provision: this.#lastProvision,
    };
  }
}
