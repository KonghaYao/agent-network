/**
 * MF10：Memory 运行时组合。
 *
 * 把四件事放到同一生命周期里，避免入口各自 setInterval：
 * 1. MemoryRuntime 启动恢复、作业领取、租约与关闭；
 * 2. unknown 作业对账（只查询原 JobRef，不重跑写入）；
 * 3. Langfuse importer 定时拉取（LANGFUSE_ENABLED=1 且 Memory 已启动）；
 * 4. MCP/UI 可读的组合状态。
 *
 * 关闭顺序：停止调度 → 中止 importer → 等待当前轮 → 停止运行时（中止在途
 * 适配器请求）。已提交的本地意图仍由数据库保留，重启可恢复。
 */
import { LIMITS } from '../contracts/limits';
import { nowMs } from '../storage/db';
import type { MemoryRuntime, MemoryRuntimeTickResult } from './runtime';
import type { LangfuseImportResult } from './sources/langfuse-import';

export interface MemoryIntegrationImporter {
  importOnce(options: {
    signal: AbortSignal;
    deadlineAt?: number | null;
  }): Promise<LangfuseImportResult>;
}

export interface MemoryIntegrationOptions {
  runtime: MemoryRuntime;
  /** 未配置时保持 disabled，不发起任何网络请求。 */
  langfuse?: MemoryIntegrationImporter | null;
  now?: () => number;
  tickIntervalMs?: number;
  reconcileIntervalMs?: number;
  importIntervalMs?: number;
  /** 单轮导入的 deadline；缺省不限制，由 importer 自身超时控制。 */
  importDeadlineMs?: number;
  onError?: (error: unknown, scope: 'tick' | 'reconcile' | 'import') => void;
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
  langfuse: {
    configured: boolean;
    last_at: number | null;
    last_status: LangfuseImportResult['status'] | null;
    last_reason: string | null;
    last_imported: number;
    last_duplicates: number;
    last_errors: number;
  };
}

export interface MemoryIntegrationRun {
  skipped: boolean;
  tick: MemoryRuntimeTickResult | null;
  reconcile: MemoryIntegrationStatus['last_reconcile'];
  langfuse: LangfuseImportResult | null;
}

export class MemoryIntegration {
  readonly #runtime: MemoryRuntime;
  readonly #langfuse: MemoryIntegrationImporter | null;
  readonly #now: () => number;
  readonly #tickIntervalMs: number;
  readonly #reconcileIntervalMs: number;
  readonly #importIntervalMs: number;
  readonly #importDeadlineMs: number | null;
  readonly #onError: NonNullable<MemoryIntegrationOptions['onError']>;

  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<MemoryIntegrationRun> | null = null;
  #importController: AbortController | null = null;
  #lastTickAt: number | null = null;
  #lastTick: MemoryRuntimeTickResult | null = null;
  #lastReconcileAt: number | null = null;
  #lastReconcile: MemoryIntegrationStatus['last_reconcile'] = null;
  #lastImportAt: number | null = null;
  #lastImportStatus: LangfuseImportResult['status'] | null = null;
  #lastImportReason: string | null = null;
  #lastImported = 0;
  #lastDuplicates = 0;
  #lastErrors = 0;

  constructor(options: MemoryIntegrationOptions) {
    this.#runtime = options.runtime;
    this.#langfuse = options.langfuse ?? null;
    this.#now = options.now ?? nowMs;
    this.#tickIntervalMs = Math.max(1, options.tickIntervalMs ?? LIMITS.memoryTickIntervalMs);
    this.#reconcileIntervalMs = Math.max(
      1,
      options.reconcileIntervalMs ?? LIMITS.memoryReconcileIntervalMs,
    );
    this.#importIntervalMs = Math.max(
      1,
      options.importIntervalMs ?? LIMITS.memoryLangfuseIntervalMs,
    );
    this.#importDeadlineMs = options.importDeadlineMs ?? null;
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
    // 不阻塞 HTTP 监听，也不自动发起 Langfuse 拉取。
    void this.runOnce({ import: false }).catch((error) => this.#onError(error, 'tick'));
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#importController?.abort();
    await this.#inFlight?.catch(() => undefined);
    this.#importController = null;
    await this.#runtime.stop();
    this.#started = false;
  }

  /**
   * 执行一轮：作业领取 → unknown 对账 → 到期的 Langfuse 拉取。
   *
   * `import: true` 强制拉取，`false` 跳过拉取（启动首轮使用），省略时按周期。
   * 同一时刻只允许一轮；定时器与显式调用共享同一个 in-flight Promise。
   */
  async runOnce(options: { import?: boolean } = {}): Promise<MemoryIntegrationRun> {
    if (!this.#started || this.#stopped) {
      return { skipped: true, tick: null, reconcile: null, langfuse: null };
    }
    if (this.#inFlight) return this.#inFlight;
    const run = this.#execute(options).finally(() => {
      if (this.#inFlight === run) this.#inFlight = null;
    });
    this.#inFlight = run;
    return run;
  }

  async #execute(options: { import?: boolean }): Promise<MemoryIntegrationRun> {
    const now = this.#now();
    let tick: MemoryRuntimeTickResult | null = null;
    let reconcile: MemoryIntegrationStatus['last_reconcile'] = null;
    let langfuse: LangfuseImportResult | null = null;

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

    const importDue =
      options.import !== false &&
      this.#langfuse !== null &&
      this.#runtime.captureEnabled &&
      (options.import === true ||
        this.#lastImportAt === null ||
        now - this.#lastImportAt >= this.#importIntervalMs);
    if (importDue && !this.#stopped) {
      const controller = new AbortController();
      this.#importController = controller;
      try {
        langfuse = await this.#langfuse!.importOnce({
          signal: controller.signal,
          ...(this.#importDeadlineMs
            ? { deadlineAt: this.#now() + this.#importDeadlineMs }
            : {}),
        });
        this.#lastImportAt = this.#now();
        this.#lastImportStatus = langfuse.status;
        this.#lastImportReason = langfuse.reason;
        this.#lastImported = langfuse.imported;
        this.#lastDuplicates = langfuse.duplicates;
        this.#lastErrors = langfuse.errors;
      } catch (error) {
        this.#lastImportAt = this.#now();
        this.#lastImportStatus = null;
        this.#lastImportReason = 'exception';
        this.#onError(error, 'import');
      } finally {
        if (this.#importController === controller) this.#importController = null;
      }
    }

    return { skipped: false, tick, reconcile, langfuse };
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
      langfuse: {
        configured: this.#langfuse !== null,
        last_at: this.#lastImportAt,
        last_status: this.#lastImportStatus,
        last_reason: this.#lastImportReason,
        last_imported: this.#lastImported,
        last_duplicates: this.#lastDuplicates,
        last_errors: this.#lastErrors,
      },
    };
  }
}
