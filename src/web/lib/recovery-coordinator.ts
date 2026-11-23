/**
 * 前台恢复的合并调度器（纯逻辑，可在 Bun 单测中注入时钟）。
 *
 * online、visibility visible、pageshow 与 SSE 重连 ACK 在短窗口内只触发
 * 一轮恢复；上一轮尚未结束时到达的触发并入当前轮，或在上轮结束后排下一轮。
 * 调度器不读 DOM、不发请求，鉴权与查询由持有者执行。
 */

export type RecoveryReason =
  | 'visibility'
  | 'online'
  | 'pageshow'
  | 'stream-ack'
  | 'auth'
  | 'membership'
  | 'manual';

export interface RecoveryRound {
  id: number;
  reasons: RecoveryReason[];
  /**
   * 身份/成员/凭据信号：先遮住私有视图再核对。
   * 普通长后台不是身份边界，不得置为 true。
   */
  masked: boolean;
  /** 后台超过阈值：需要完整核对，但仍可继续显示同一身份的缓存内容。 */
  longBackground: boolean;
}

export interface RecoveryTriggerOptions {
  longBackground?: boolean;
  /** 身份切换、撤权通知等必须立即遮蔽私有视图。 */
  mask?: boolean;
}

export interface RecoverySchedulerOptions {
  debounceMs: number;
  quietMs: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type Runner = (round: RecoveryRound) => Promise<void> | void;

export class RecoveryScheduler {
  private readonly run: Runner;
  private readonly debounceMs: number;
  private readonly quietMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<RecoverySchedulerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<RecoverySchedulerOptions['clearTimer']>;
  private reasons = new Set<RecoveryReason>();
  private mask = false;
  private longBackground = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastRoundEndAt = 0;
  private roundCount = 0;
  private closed = false;

  constructor(run: Runner, options: RecoverySchedulerOptions) {
    this.run = run;
    this.debounceMs = options.debounceMs;
    this.quietMs = options.quietMs;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get rounds(): number {
    return this.roundCount;
  }

  get pending(): boolean {
    return this.timer !== null || this.running;
  }

  trigger(reason: RecoveryReason, options: RecoveryTriggerOptions = {}): boolean {
    if (this.closed) return false;
    this.reasons.add(reason);
    // 长后台只要求完整核对；遮罩必须由明确的身份/授权信号触发。
    if (options.mask === true) this.mask = true;
    if (options.longBackground === true) this.longBackground = true;
    if (this.running || this.timer !== null) return false;
    const sinceLastRound = this.now() - this.lastRoundEndAt;
    const wait = Math.max(this.debounceMs, this.quietMs - sinceLastRound);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.execute();
    }, Math.max(0, wait));
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private async execute(): Promise<void> {
    if (this.closed || this.running || this.reasons.size === 0) return;
    const reasons = [...this.reasons];
    const masked = this.mask;
    const longBackground = this.longBackground;
    this.reasons.clear();
    this.mask = false;
    this.longBackground = false;
    this.running = true;
    this.roundCount += 1;
    const round: RecoveryRound = { id: this.roundCount, reasons, masked, longBackground };
    try {
      await this.run(round);
    } finally {
      this.running = false;
      this.lastRoundEndAt = this.now();
      // 恢复期间到达的事件不丢弃：等当前轮结束后再合并执行一轮。
      if (this.reasons.size > 0 && !this.closed) this.trigger('manual');
    }
  }
}
