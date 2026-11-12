/**
 * 共享监控引擎：连接、订阅、自动 claim、正文读取与事件输出。
 *
 * 这是旧 shell 监听循环的 TypeScript 等价实现；peri 通过事件格式钩子
 * 复用同一套连接、claim、seen 与退避逻辑，只替换 stdout 信封、诊断流和正文读取。
 *
 * 关键不变量：
 * - stdout 只写事件行（peri 为 `ALERT <json>`）；READY/诊断默认写 stderr；
 * - 每个投递先 claim，成功后才输出可处理的 delivery 事件；
 * - claude 在 claim 后读正文并写 event_file；peri 刻意不读正文，事件不含正文；
 * - 同一时刻只保留一个 claim（由服务端约束），deferred 不写永久 seen；
 * - inbox 查询失败按指数退避重试，恢复后补领 pending；
 * - deferred 进入本地待领队列，按退避重试 claim，同一状态只提示一次；
 * - 正文只进 event_file 与 stdout 的预览，不写日志。
 */

import { setTimeout as sleepPromise } from 'node:timers/promises';

import { asArray, asNumber, asRecord, asString } from '../output';
import {
  BODY_PREVIEW_CHARS,
  claimNoticeEvent,
  deliveryEvent,
  deliveryFields,
  eventFilePayload,
  previewBody,
  readFailedEvent,
  reminderEvent,
  type ClaimFailure,
  type ClaimInfo,
  type DeliveryFields,
} from './events';
import {
  MonitorFatalError,
  MonitorRpc,
  listInboxPages,
  subscribe,
  type JsonObject,
  type SubscriptionOutcome,
} from './rpc';
import type { MonitorState } from './state';

const STREAM_URI = 'agentnet://stream';
const ACK_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 15_000;
const CLAIMED_RESET_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;
/** inbox 查询失败重试：1/2/4/8/16/30 秒封顶，持续到成功或退出。 */
const INBOX_RETRY_BASE_MS = 1_000;
const INBOX_RETRY_MAX_MS = 30_000;
/** deferred 重新 claim：2/4/8/16/30 秒封顶，单条投递在成功前持续重试。 */
const CLAIM_RETRY_BASE_MS = 2_000;
const CLAIM_RETRY_MAX_MS = 30_000;
/** 同一投递的 claim 失败提示每到这么多轮才重复一次，避免刷屏。 */
const RETRY_ERROR_NOTICE_EVERY = 10;

/** Peri 宿主 monitor 的单次上限；到期后 CLI 主动结束，避免静默失效。 */
export const PERI_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
/** 距离 deadline 剩余多少毫秒时输出一次 EXPIRING。 */
export const EXPIRING_THRESHOLD_MS = 10 * 60 * 1000;

class MonitorStop extends Error {
  constructor(
    readonly logLine: string,
    readonly exitCode = 1,
  ) {
    super(logLine);
    this.name = 'MonitorStop';
  }
}

/**
 * 宿主差异只影响事件信封，不影响连接、claim、seen 与退避：
 * - claude 走默认实现（claim 后读正文、stdout 裸 JSON、诊断写 stderr）；
 * - peri 提供无正文 delivery 与独立 claim/reminder 信封，诊断写 stdout、行首加 `ALERT `。
 */
export interface MonitorEventFormat {
  /** readBody=false 时 claim 成功后的事件；缺省视为引擎配置错误。 */
  deliveryWithoutBody?: (
    item: JsonObject,
    fields: DeliveryFields,
    claim: ClaimInfo,
    source: string,
  ) => JsonObject;
  /** 覆盖 claim 失败通知；默认与旧 shell 监听一致。 */
  claimNotice?: (
    item: JsonObject,
    fields: DeliveryFields,
    failure: ClaimFailure,
    source: string,
  ) => JsonObject;
  /** 覆盖 reminder；默认与旧 shell 监听一致。 */
  reminder?: (item: JsonObject) => JsonObject;
}

export interface MonitorEngineOptions {
  rpc: MonitorRpc;
  state: MonitorState;
  signal: AbortSignal;
  stdout?: (line: string) => void;
  diagnostics?: (line: string) => void;
  bodyPreviewChars?: number;
  ackTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** stdout 事件行前缀；peri 使用 `ALERT `。 */
  prefix?: string;
  /** claim 成功后是否读正文并写 event_file；peri 刻意保持不读。 */
  readBody?: boolean;
  format?: MonitorEventFormat;
  /** 每行一个 JSON 事件；READY 等诊断也转为 JSON，stdout 不再出现自由文本。 */
  json?: boolean;
  /** 最长运行毫秒数；0/缺省表示不限制。 */
  maxRuntimeMs?: number;
  /** 临近到期阈值；缺省 EXPIRING_THRESHOLD_MS。 */
  expiringThresholdMs?: number;
  /** 到达 deadline 时通知宿主进程停止（通常传 AbortController.abort）。 */
  onDeadline?: () => void;
}

type EmitResult = 'emitted' | 'deferred' | 'error';

export type ClaimResult =
  | { ok: true; claim: ClaimInfo }
  | { ok: false; failure: ClaimFailure };

interface DeferredDelivery {
  item: JsonObject;
  fields: DeliveryFields;
  source: string;
  failures: number;
  nextAt: number;
  lastErrorNotice: number;
}

/** 纯退避曲线，便于验收断言封顶；实际调用会叠加测试用固定毫秒覆盖。 */
export function retryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
}

function monitorRetryDelay(attempt: number, baseMs: number, maxMs: number): number {
  // 验收脚本用固定毫秒覆盖退避，避免等待 30 秒；生产不设置。
  const override = Number(process.env.AGENTNET_MONITOR_RETRY_BASE_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return retryDelayMs(attempt, baseMs, maxMs);
}

export function inboxRetryDelay(attempt: number): number {
  return monitorRetryDelay(attempt, INBOX_RETRY_BASE_MS, INBOX_RETRY_MAX_MS);
}

export function claimRetryDelay(attempt: number): number {
  return monitorRetryDelay(attempt, CLAIM_RETRY_BASE_MS, CLAIM_RETRY_MAX_MS);
}

/**
 * 自动 claim；CLAIM_CONFLICT 只读一次 claimed inbox 区分“自己已领取”
 * 与“别人领取/当前已有其他 claim”，不轮询。
 *
 * codex 桥接复用同一份分类，保证 deferred/conflict/failed 的日志与
 * 处理分支与 claude 引擎一致。
 */
export async function claimDelivery(
  rpc: MonitorRpc,
  deliveryId: string,
): Promise<ClaimResult | null> {
  let outcome;
  try {
    outcome = await rpc.callTool('network_delivery_claim', {
      request_id: `watch-claim-${Math.floor(Date.now() / 1000)}-${process.pid}-${Math.floor(
        Math.random() * 1_000_000,
      )}`,
      delivery_id: deliveryId,
    });
  } catch (error) {
    if (error instanceof MonitorFatalError) throw error;
    return null;
  }

  if (outcome.ok) {
    return {
      ok: true,
      claim: {
        deliveryId: asString(outcome.data.delivery_id, deliveryId) || deliveryId,
        attempt: asNumber(outcome.data.attempt, 0),
        claimId: asString(outcome.data.claim_id),
        claimedAt: asString(outcome.data.claimed_at),
      },
    };
  }
  if (outcome.code !== 'CLAIM_CONFLICT') {
    return {
      ok: false,
      failure: {
        deliveryId,
        code: outcome.code === '' ? 'UNKNOWN' : outcome.code,
        message: outcome.message,
        kind: 'failed',
      },
    };
  }

  let claimedPage: JsonObject | null = null;
  try {
    const page = await listInboxPages(rpc, 'claimed');
    if (page.ok) claimedPage = page.data;
  } catch (error) {
    if (error instanceof MonitorFatalError) throw error;
    // 读取 claimed inbox 失败时按错误消息分类，与脚本一致。
  }

  if (claimedPage !== null) {
    const own = asArray(claimedPage.items)
      .map(asRecord)
      .find((item) => asString(item.delivery_id) === deliveryId);
    if (own) {
      return {
        ok: true,
        claim: {
          deliveryId,
          attempt: asNumber(own.attempt, 0),
          claimId: asString(own.claim_id),
          claimedAt: asString(own.claimed_at),
        },
      };
    }
  }

  const deferred = outcome.message.includes('当前已有领取中的工作');
  const held = claimedPage === null ? '' : asString(claimedPage.claimed_delivery_id);
  return {
    ok: false,
    failure: {
      deliveryId,
      code: 'CLAIM_CONFLICT',
      message: outcome.message,
      kind: deferred ? 'deferred' : 'conflict',
      ...(deferred && held.length > 0 ? { claimedDeliveryId: held } : {}),
    },
  };
}

/** 断线退避：1/2/4/8/16/30 秒，带 ±20% 抖动；dsh 复用同一曲线。 */
export function reconnectDelay(attempt: number): number {
  // 验收脚本用固定毫秒覆盖退避，避免等待 31 秒才能进入 DEGRADED；生产不设置。
  const override = Number(process.env.AGENTNET_MONITOR_RECONNECT_BASE_MS);
  if (Number.isFinite(override) && override > 0) return override / 1000;
  const base =
    attempt <= 1 ? 1 : attempt === 2 ? 2 : attempt === 3 ? 4 : attempt === 4 ? 8 : attempt === 5 ? 16 : 30;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(base * jitter * 10) / 10;
}

/** 可被信号打断的 sleep；abort 时仍 resolve，由调用方读取 signal 决定退出。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return sleepPromise(ms, undefined, signal ? { signal } : undefined).then(
    () => undefined,
    () => undefined,
  );
}

function newSubscriptionId(generation: number): string {
  return `sub-${Math.floor(Date.now() / 1000)}-${process.pid}-${generation}-${Math.floor(
    Math.random() * 1_000_000,
  )}`;
}

/**
 * `--json` 事件行的粗分类，供宿主用稳定正则过滤：
 * delivery=可处理投递，reminder=进度提醒，notice=不可处理的 claim 回执，
 * control=连接/期限事件，error=需要人工修复的错误。
 */
export function eventKind(type: string): string {
  if (type === 'delivery') return 'delivery';
  if (type === 'reminder') return 'reminder';
  if (type.startsWith('delivery_')) return 'notice';
  if (type === 'error') return 'error';
  return 'control';
}

export class MonitorEngine {
  private readonly rpc: MonitorRpc;
  private readonly state: MonitorState;
  private readonly signal: AbortSignal;
  private readonly stdout: (line: string) => void;
  private readonly diagnostics: (line: string) => void;
  private readonly bodyPreviewChars: number;
  private readonly ackTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly prefix: string;
  private readonly readBody: boolean;
  private readonly format: MonitorEventFormat;
  private readonly json: boolean;
  private readonly maxRuntimeMs: number;
  private readonly expiringThresholdMs: number;
  private readonly onDeadline: (() => void) | undefined;

  private meId = '';
  private readyEmitted = false;
  private lastDisconnectReason = 'connection_closed';
  private reconnectAttempt = 0;
  private failStartedAt = 0;
  private degraded = false;
  private generation = 0;
  private deadlineAt = 0;
  private expiringEmitted = false;
  private deadlineTimers: ReturnType<typeof setTimeout>[] = [];

  /** inbox 查询失败后的补领状态；恢复后重置。 */
  private inboxRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private inboxRetryAttempt = 0;
  private inboxRetryInFlight = false;

  /** 服务端单 claim 约束下暂时领不到的投递；成功后移除。 */
  private readonly deferred = new Map<string, DeferredDelivery>();
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredRunning = false;
  /** 防止通知路径与退避定时器同时 claim 同一条投递。 */
  private readonly claiming = new Set<string>();
  /** 已输出的 claim（delivery:attempt:claim_id），阻止重复事件与重复回复。 */
  private readonly emittedClaims = new Set<string>();
  /** deferred 提示去重：同一状态只输出一次，holder/attempt 变化再输出。 */
  private readonly deferredNoticeKeys = new Map<string, string>();

  constructor(options: MonitorEngineOptions) {
    this.rpc = options.rpc;
    this.state = options.state;
    this.signal = options.signal;
    this.stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
    this.diagnostics = options.diagnostics ?? ((line) => process.stderr.write(`${line}\n`));
    this.bodyPreviewChars = options.bodyPreviewChars ?? BODY_PREVIEW_CHARS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.prefix = options.prefix ?? '';
    this.readBody = options.readBody !== false;
    this.format = options.format ?? {};
    this.json = options.json === true;
    this.maxRuntimeMs = options.maxRuntimeMs ?? 0;
    this.expiringThresholdMs = options.expiringThresholdMs ?? EXPIRING_THRESHOLD_MS;
    this.onDeadline = options.onDeadline;
  }

  async run(): Promise<number> {
    this.startDeadline();
    try {
      await this.ensureIdentity();
      while (!this.signal.aborted) {
        this.generation += 1;
        const subscriptionId = newSubscriptionId(this.generation);
        let outcome: SubscriptionOutcome;
        try {
          outcome = await subscribe(this.rpc, {
            subscriptionId,
            uri: STREAM_URI,
            ackTimeoutMs: this.ackTimeoutMs,
            idleTimeoutMs: this.idleTimeoutMs,
            signal: this.signal,
            onAck: (control) => this.handleAck(control.abort, subscriptionId),
            onFrame: (frame) => this.handleFrame(frame),
          });
        } catch (error) {
          return this.reportStop(error);
        }
        if (this.signal.aborted) break;
        this.lastDisconnectReason = outcome.reason;

        const now = Date.now();
        if (outcome.acked && outcome.ackedAt > 0 && now - outcome.ackedAt >= CLAIMED_RESET_MS) {
          this.reconnectAttempt = 0;
          this.failStartedAt = 0;
          this.degraded = false;
        }
        this.reconnectAttempt += 1;
        if (this.failStartedAt === 0) this.failStartedAt = now;
        const delay = reconnectDelay(this.reconnectAttempt);
        this.control(
          'reconnecting',
          {
            reason: outcome.reason,
            status: outcome.status,
            attempt: this.reconnectAttempt,
            delay,
          },
          `RECONNECTING reason=${outcome.reason} status=${outcome.status} attempt=${this.reconnectAttempt} delay=${delay}`,
        );
        if (
          !this.degraded &&
          (this.reconnectAttempt >= 5 || now - this.failStartedAt >= 60_000)
        ) {
          this.control(
            'degraded',
            { attempts: this.reconnectAttempt, last_reason: outcome.reason },
            `DEGRADED attempts=${this.reconnectAttempt} last_reason=${outcome.reason}`,
          );
          this.degraded = true;
        }
        await abortableSleep(delay * 1000, this.signal);
      }
      return 0;
    } catch (error) {
      return this.reportStop(error);
    } finally {
      this.clearDeadlineTimers();
      this.clearRetryTimers();
    }
  }

  private clearRetryTimers(): void {
    if (this.inboxRetryTimer !== null) {
      clearTimeout(this.inboxRetryTimer);
      this.inboxRetryTimer = null;
    }
    if (this.deferredTimer !== null) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
    }
  }

  /** 启动时输出绝对 deadline，并在阈值与到期时各触发一次。 */
  private startDeadline(): void {
    if (this.maxRuntimeMs <= 0) return;
    const now = Date.now();
    this.deadlineAt = now + this.maxRuntimeMs;
    const at = new Date(this.deadlineAt).toISOString();
    this.control(
      'deadline',
      { at, deadline: at, remaining_ms: this.maxRuntimeMs },
      `DEADLINE at=${at} remaining_ms=${this.maxRuntimeMs}`,
    );

    const untilExpiring = this.deadlineAt - this.expiringThresholdMs - now;
    if (untilExpiring <= 0) {
      this.emitExpiring();
    } else {
      this.deadlineTimers.push(setTimeout(() => this.emitExpiring(), untilExpiring));
    }
    this.deadlineTimers.push(
      setTimeout(() => {
        const deadline = new Date(this.deadlineAt).toISOString();
        this.control(
          'expired',
          { deadline, remaining_ms: 0 },
          `EXPIRED deadline=${deadline} action=restart_monitor`,
        );
        this.onDeadline?.();
      }, this.maxRuntimeMs),
    );
    for (const timer of this.deadlineTimers) {
      (timer as { unref?: () => void }).unref?.();
    }
  }

  private emitExpiring(): void {
    if (this.expiringEmitted) return;
    this.expiringEmitted = true;
    const remaining = Math.max(0, this.deadlineAt - Date.now());
    const deadline = new Date(this.deadlineAt).toISOString();
    this.control(
      'expiring',
      { deadline, remaining_ms: remaining },
      `EXPIRING remaining_ms=${remaining} deadline=${deadline}`,
    );
  }

  private clearDeadlineTimers(): void {
    for (const timer of this.deadlineTimers) clearTimeout(timer);
    this.deadlineTimers = [];
  }

  /**
   * 诊断/控制行：文本模式写既有 stderr/stdout 文本，JSON 模式写单个 JSON
   * 对象。JSON 行始终包含 type/kind/seq 与定位字段，缺失时显式 null。
   */
  private control(type: string, fields: JsonObject, textLine: string): void {
    if (!this.json) {
      this.diagnostics(textLine);
      return;
    }
    this.stdout(
      JSON.stringify({
        type,
        kind: eventKind(type),
        seq: null,
        delivery_id: null,
        room_id: null,
        message_id: null,
        ...fields,
      }),
    );
  }

  private reportStop(error: unknown): number {
    if (error instanceof MonitorStop) {
      this.control(
        'error',
        { code: 'monitor_stopped', exit_code: error.exitCode, message: error.logLine },
        error.logLine,
      );
      return error.exitCode;
    }
    if (error instanceof MonitorFatalError) {
      if (error.kind === 'credential') {
        this.control(
          'error',
          { code: 'credential_invalid', error_type: 'credential' },
          'ERROR type=credential message=credential_invalid',
        );
      } else {
        this.control(
          'error',
          { code: 'request_rejected', error_type: 'protocol', message: error.message || 'request_rejected' },
          `ERROR type=protocol message=${error.message || 'request_rejected'}`,
        );
      }
      return 1;
    }
    this.control(
      'error',
      { code: 'monitor_failed', error_type: 'internal' },
      'ERROR type=internal message=monitor_failed',
    );
    return 1;
  }

  private async ensureIdentity(): Promise<void> {
    try {
      await this.rpc.discover();
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      throw new MonitorStop('ERROR type=protocol message=discover_failed');
    }

    let me;
    try {
      me = await this.rpc.callTool('network_me', {});
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      throw new MonitorStop('ERROR type=identity message=network_me_failed');
    }
    if (!me.ok) {
      throw new MonitorStop('ERROR type=identity message=network_me_failed');
    }
    this.meId = asString(me.data.actor_id);
    if (this.meId.length === 0) {
      throw new MonitorStop('ERROR type=identity message=network_me_failed');
    }
    if (asString(me.data.kind) !== 'agent') {
      throw new MonitorStop('ERROR type=identity message=agent_token_required');
    }
  }

  /** ack 后登录并补读 pending；登录失败只结束当前连接，交给退避重连。 */
  private async handleAck(
    abort: (reason: string) => void,
    subscriptionId: string,
  ): Promise<void> {
    const wasDegraded = this.degraded;
    let login;
    try {
      login = await this.rpc.callTool('network_login', {});
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.control(
        'error',
        { code: 'network_login_failed', error_type: 'login' },
        'ERROR type=login message=network_login_failed',
      );
      abort('login_failed');
      return;
    }
    if (!login.ok) {
      this.control(
        'error',
        { code: 'network_login_failed', error_type: 'login' },
        'ERROR type=login message=network_login_failed',
      );
      abort('login_failed');
      return;
    }

    const pending = asNumber(login.data.pending_count, 0);
    if (!this.readyEmitted) {
      this.control(
        'ready',
        { actor: this.meId, pending, subscription: subscriptionId, reconnect: false },
        `READY actor=${this.meId} pending=${pending} subscription=${subscriptionId}`,
      );
      this.readyEmitted = true;
    } else if (wasDegraded) {
      this.control(
        'recovered',
        { actor: this.meId, pending, subscription: subscriptionId },
        `RECOVERED actor=${this.meId} pending=${pending} subscription=${subscriptionId}`,
      );
    } else {
      this.control(
        'ready',
        {
          actor: this.meId,
          pending,
          subscription: subscriptionId,
          reconnect: true,
          reason: this.lastDisconnectReason,
        },
        `READY actor=${this.meId} pending=${pending} subscription=${subscriptionId} reconnect=1 reason=${this.lastDisconnectReason}`,
      );
    }
    this.degraded = false;
    await this.emitPendingSnapshot();
  }

  private async handleFrame(frame: JsonObject): Promise<void> {
    const params = asRecord(frame.params);
    const envelope = asRecord(asRecord(params._meta)['io.agent-network/event']);
    if (Object.keys(envelope).length === 0) return;

    const pending = await this.pendingDeliveryMap();
    const items = asArray(envelope.items)
      .map(asRecord)
      .filter(
        (item) =>
          item.attention === 'action_required' &&
          item.delivery_id !== null &&
          item.delivery_id !== undefined &&
          asString(item.sender_id) !== this.meId,
      );

    for (const item of items) {
      const id = asString(item.delivery_id);
      if (id.length === 0) continue;
      const source = asString(item.source);
      const eventId = asString(item.event_id);
      const fallback = [asString(item.source), asString(item.seq), id].join(':');

      if (source === 'delivery.reminder') {
        const key = `reminder:${id}:${eventId.length > 0 ? eventId : fallback}`;
        if (this.state.hasSeen(key)) continue;
        const event = this.format.reminder ? this.format.reminder(item) : reminderEvent(item);
        this.emitEvent(event);
        await this.state.markSeen(key);
        continue;
      }

      // 收到 retry 回执时立即把待领队列里的同一条投递放回队首。
      if (source === 'delivery.retried') this.releaseDeferred(id);

      if (this.claiming.has(id)) continue;
      const queued = this.deferred.get(id);
      if (queued !== undefined) {
        // 重复通知只刷新快照，不重复 claim、不重复输出 deferred。
        queued.item = item;
        queued.source = 'stream';
        continue;
      }

      let attempt: number;
      let key: string;
      if (pending !== null) {
        const found = pending.get(id);
        if (found === undefined) {
          await this.state.markSeen(`event:${eventId.length > 0 ? eventId : fallback}`);
          continue;
        }
        attempt = found;
        key = `pending:${id}:${attempt}`;
      } else {
        attempt = asNumber(item.attempt, 0);
        key = `event:${eventId.length > 0 ? eventId : fallback}`;
      }

      if (this.state.hasSeen(key)) continue;
      const result = await this.emitFound(item, 'stream');
      if (result === 'emitted') await this.state.markSeen(key);
      else if (result === 'error') return;
    }

    if (items.some((item) => this.isDeliveryReceipt(item))) this.wakeDeferred(0);

    if (envelope.more === true || asNumber(envelope.dropped, 0) > 0) {
      await this.emitPendingSnapshot();
    }
  }

  private isDeliveryReceipt(item: JsonObject): boolean {
    const source = asString(item.source);
    if (source === 'delivery.updated') return true;
    const state = asString(item.state);
    return state === 'completed' || state === 'failed' || state === 'cancelled';
  }

  private async fetchPending(): Promise<
    { ok: true; items: JsonObject[] } | { ok: false; code: string }
  > {
    let outcome;
    try {
      outcome = await listInboxPages(this.rpc, 'pending');
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      return { ok: false, code: 'pending_lookup_failed' };
    }
    if (!outcome.ok) {
      return { ok: false, code: 'pending_lookup_failed' };
    }
    return { ok: true, items: asArray(outcome.data.items).map(asRecord) };
  }

  /** 记录 inbox 查询失败并按退避安排补领；首次与周期性失败都可见，不静默跳过。 */
  private reportInboxFailure(code: string): void {
    this.inboxRetryAttempt += 1;
    const attempt = this.inboxRetryAttempt;
    const retryIn = inboxRetryDelay(attempt);
    if (attempt === 1 || attempt % RETRY_ERROR_NOTICE_EVERY === 0) {
      this.control(
        'error',
        { code, error_type: 'inbox', attempt, retry_in_ms: retryIn },
        `ERROR type=inbox message=${code} attempt=${attempt} retry_in_ms=${retryIn}`,
      );
    }
    this.scheduleInboxRetry();
  }

  /** 查询恢复：重置退避并输出一次可见恢复事件，随后由调用方补领 pending。 */
  private noteInboxSuccess(): void {
    if (this.inboxRetryAttempt === 0) return;
    const attempts = this.inboxRetryAttempt;
    this.inboxRetryAttempt = 0;
    this.control(
      'inbox_recovered',
      { error_type: 'inbox', attempts },
      `RECOVERED type=inbox attempts=${attempts}`,
    );
  }

  private scheduleInboxRetry(): void {
    if (this.signal.aborted || this.inboxRetryTimer !== null) return;
    const delay = inboxRetryDelay(this.inboxRetryAttempt);
    this.inboxRetryTimer = setTimeout(() => {
      this.inboxRetryTimer = null;
      void this.retryInbox().catch((error: unknown) => this.reportStop(error));
    }, delay);
    (this.inboxRetryTimer as { unref?: () => void }).unref?.();
  }

  /** 后台补领：查询成功后才遍历 pending，失败继续退避，不会丢消息。 */
  private async retryInbox(): Promise<void> {
    if (this.signal.aborted || this.inboxRetryInFlight) return;
    this.inboxRetryInFlight = true;
    try {
      const outcome = await this.fetchPending();
      if (!outcome.ok) {
        this.reportInboxFailure(outcome.code);
        return;
      }
      this.noteInboxSuccess();
      await this.emitPendingItems(outcome.items, 'inbox.snapshot');
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.reportInboxFailure('pending_lookup_failed');
    } finally {
      this.inboxRetryInFlight = false;
    }
  }

  /** 只在通知需要时读一次 pending；失败时退回事件自身的 attempt 并安排补领。 */
  private async pendingDeliveryMap(): Promise<Map<string, number> | null> {
    const outcome = await this.fetchPending();
    if (!outcome.ok) {
      this.reportInboxFailure('pending_lookup_failed');
      return null;
    }
    this.noteInboxSuccess();
    const map = new Map<string, number>();
    for (const raw of outcome.items) {
      const message = asRecord(raw.message);
      if (asString(message.sender_id) === this.meId) continue;
      const id = asString(raw.delivery_id);
      if (id.length === 0) continue;
      map.set(id, asNumber(raw.attempt, 0));
    }
    return map;
  }

  private async emitPendingSnapshot(): Promise<void> {
    const outcome = await this.fetchPending();
    if (!outcome.ok) {
      this.reportInboxFailure('pending_lookup_failed');
      return;
    }
    this.noteInboxSuccess();
    await this.emitPendingItems(outcome.items, 'inbox.snapshot');
  }

  private async emitPendingItems(items: JsonObject[], source: string): Promise<void> {
    for (const item of items) {
      if (this.signal.aborted) return;
      if (asString(asRecord(item.message).sender_id) === this.meId) continue;
      const id = asString(item.delivery_id);
      if (id.length === 0) continue;
      if (this.claiming.has(id)) continue;
      const queued = this.deferred.get(id);
      if (queued !== undefined) {
        // 新的 pending 快照是更可靠的状态来源：刷新条目并立即重试。
        queued.item = item;
        queued.fields = deliveryFields(item);
        queued.source = source;
        this.wakeDeferred(0);
        continue;
      }
      const key = `pending:${id}:${asNumber(item.attempt, 0)}`;
      if (this.state.hasSeen(key)) continue;
      const result = await this.emitFound(item, source);
      if (result === 'emitted') await this.state.markSeen(key);
      else if (result === 'error') return;
    }
  }

  private async emitFound(item: JsonObject, source: string): Promise<EmitResult> {
    const fields = deliveryFields(item);
    if (this.readBody && !SAFE_ID.test(fields.deliveryId)) {
      this.control(
        'error',
        { code: 'invalid_delivery_reference', error_type: 'format' },
        'ERROR type=format message=invalid_delivery_reference',
      );
      return 'error';
    }
    if (this.readBody && !SAFE_ID.test(fields.messageId)) {
      this.control(
        'error',
        { code: 'invalid_message_reference', error_type: 'format' },
        'ERROR type=format message=invalid_message_reference',
      );
      return 'error';
    }
    if (this.claiming.has(fields.deliveryId)) return 'deferred';

    this.claiming.add(fields.deliveryId);
    let claim: ClaimResult | null;
    try {
      claim = await claimDelivery(this.rpc, fields.deliveryId);
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      claim = null;
    } finally {
      this.claiming.delete(fields.deliveryId);
    }

    if (claim === null) {
      this.control(
        'error',
        {
          code: 'claim_retry_failed',
          error_type: 'claim',
          delivery_id: fields.deliveryId,
        },
        `ERROR type=claim message=claim_retry_failed delivery_id=${fields.deliveryId}`,
      );
      this.deferDelivery(
        item,
        fields,
        {
          deliveryId: fields.deliveryId,
          code: 'CLAIM_REQUEST_FAILED',
          message: 'claim request failed',
          kind: 'deferred',
        },
        source,
      );
      return 'deferred';
    }
    if (!claim.ok) {
      if (claim.failure.kind === 'deferred') {
        this.deferDelivery(item, fields, claim.failure, source);
        return 'deferred';
      }
      this.emitClaimFailureNotice(item, fields, claim.failure, source);
      return 'emitted';
    }

    return await this.emitClaimed(item, fields, claim.claim, source);
  }

  /** claim 成功后的唯一出口；同一交付只输出一次，避免重复回复。 */
  private async emitClaimed(
    item: JsonObject,
    fields: DeliveryFields,
    claim: ClaimInfo,
    source: string,
  ): Promise<EmitResult> {
    const claimKey = `${fields.deliveryId}:${claim.attempt}:${claim.claimId}`;
    if (this.emittedClaims.has(claimKey)) return 'emitted';

    if (!this.readBody) {
      const delivery = this.format.deliveryWithoutBody;
      if (!delivery) {
        this.control(
          'error',
          { code: 'monitor_failed', error_type: 'internal' },
          'ERROR type=internal message=monitor_failed',
        );
        return 'error';
      }
      this.emittedClaims.add(claimKey);
      this.emitEvent(delivery(item, fields, claim, source));
      return 'emitted';
    }

    const read = await this.readMessage(fields.messageId, fields.deliveryId);
    if (!read.ok) {
      this.emittedClaims.add(claimKey);
      this.emitEvent(readFailedEvent(fields, claim, source));
      return 'emitted';
    }

    let eventFile: string;
    try {
      eventFile = await this.state.writeEventFile(
        fields.deliveryId,
        eventFilePayload(fields, claim, source, read.body),
      );
    } catch {
      this.control(
        'error',
        { code: 'event_write_failed', error_type: 'message', delivery_id: fields.deliveryId },
        `ERROR type=message message=event_write_failed delivery_id=${fields.deliveryId}`,
      );
      this.emittedClaims.add(claimKey);
      this.emitEvent(readFailedEvent(fields, claim, source));
      return 'emitted';
    }

    this.emittedClaims.add(claimKey);
    this.emitEvent(
      deliveryEvent(
        fields,
        claim,
        source,
        previewBody(read.body, this.bodyPreviewChars),
        eventFile,
      ),
    );
    return 'emitted';
  }

  private emitClaimFailureNotice(
    item: JsonObject,
    fields: DeliveryFields,
    failure: ClaimFailure,
    source: string,
    retryAttempt?: number,
    retryInMs?: number,
  ): void {
    const enriched: ClaimFailure =
      retryAttempt === undefined
        ? failure
        : { ...failure, retryAttempt, retryInMs };
    const notice = this.format.claimNotice
      ? this.format.claimNotice(item, fields, enriched, source)
      : claimNoticeEvent(fields, enriched, source);
    this.emitEvent(notice);
  }

  /** 进入本地待领队列；同一 holder/attempt 状态只提示一次。 */
  private deferDelivery(
    item: JsonObject,
    fields: DeliveryFields,
    failure: ClaimFailure,
    source: string,
  ): void {
    const existing = this.deferred.get(fields.deliveryId);
    const failures = existing?.failures ?? 0;
    const nextAt = Date.now() + claimRetryDelay(failures + 1);
    const noticeKey = [
      failure.kind,
      failure.code,
      failure.claimedDeliveryId ?? '',
      fields.attempt,
    ].join('|');
    this.deferred.set(fields.deliveryId, {
      item,
      fields,
      source,
      failures,
      nextAt,
      lastErrorNotice: existing?.lastErrorNotice ?? 0,
    });
    if (this.deferredNoticeKeys.get(fields.deliveryId) !== noticeKey) {
      this.deferredNoticeKeys.set(fields.deliveryId, noticeKey);
      this.emitClaimFailureNotice(
        item,
        fields,
        failure,
        source,
        failures + 1,
        claimRetryDelay(failures + 1),
      );
    }
    this.scheduleDeferred();
  }

  private releaseDeferred(deliveryId: string): void {
    if (!this.deferred.delete(deliveryId)) return;
    this.deferredNoticeKeys.delete(deliveryId);
    this.scheduleDeferred();
  }

  /** 收到 claim 完成/失败/重试回执后，立即唤醒待领队列。 */
  private wakeDeferred(delayMs: number): void {
    if (this.deferred.size === 0) return;
    const at = Date.now() + delayMs;
    for (const entry of this.deferred.values()) {
      entry.nextAt = Math.min(entry.nextAt, at);
    }
    this.scheduleDeferred();
  }

  private scheduleDeferred(): void {
    if (this.deferredTimer !== null) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
    }
    if (this.signal.aborted || this.deferred.size === 0) return;
    let nextAt = Number.POSITIVE_INFINITY;
    for (const entry of this.deferred.values()) nextAt = Math.min(nextAt, entry.nextAt);
    const delay = Math.max(0, nextAt - Date.now());
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      void this.runDeferredRetries().catch((error: unknown) => this.reportStop(error));
    }, delay);
    (this.deferredTimer as { unref?: () => void }).unref?.();
  }

  /** 按退避重试 claim；成功才输出 delivery，槽位仍被占用时继续排队。 */
  private async runDeferredRetries(): Promise<void> {
    if (this.deferredRunning || this.signal.aborted) return;
    this.deferredRunning = true;
    try {
      const now = Date.now();
      for (const [deliveryId, entry] of [...this.deferred.entries()]) {
        if (this.signal.aborted) break;
        if (entry.nextAt > now || this.claiming.has(deliveryId)) continue;

        this.claiming.add(deliveryId);
        let claim: ClaimResult | null;
        try {
          claim = await claimDelivery(this.rpc, deliveryId);
        } catch (error) {
          if (error instanceof MonitorFatalError) throw error;
          claim = null;
        } finally {
          this.claiming.delete(deliveryId);
        }

        if (claim === null) {
          entry.failures += 1;
          entry.nextAt = Date.now() + claimRetryDelay(entry.failures);
          if (
            entry.lastErrorNotice === 0 ||
            entry.failures % RETRY_ERROR_NOTICE_EVERY === 0
          ) {
            entry.lastErrorNotice = entry.failures;
            this.control(
              'error',
              {
                code: 'claim_retry_failed',
                error_type: 'claim',
                delivery_id: deliveryId,
                attempt: entry.failures,
                retry_in_ms: claimRetryDelay(entry.failures + 1),
              },
              `ERROR type=claim message=claim_retry_failed delivery_id=${deliveryId} ` +
                `attempt=${entry.failures} retry_in_ms=${claimRetryDelay(entry.failures + 1)}`,
            );
          }
          continue;
        }

        if (claim.ok) {
          this.deferred.delete(deliveryId);
          this.deferredNoticeKeys.delete(deliveryId);
          const result = await this.emitClaimed(entry.item, entry.fields, claim.claim, entry.source);
          if (result === 'emitted') {
            await this.state.markSeen(`pending:${deliveryId}:${entry.fields.attempt}`);
          }
          continue;
        }

        if (claim.failure.kind === 'deferred') {
          entry.failures += 1;
          entry.nextAt = Date.now() + claimRetryDelay(entry.failures);
          const noticeKey = [
            claim.failure.kind,
            claim.failure.code,
            claim.failure.claimedDeliveryId ?? '',
            entry.fields.attempt,
          ].join('|');
          if (this.deferredNoticeKeys.get(deliveryId) !== noticeKey) {
            this.deferredNoticeKeys.set(deliveryId, noticeKey);
            this.emitClaimFailureNotice(
              entry.item,
              entry.fields,
              claim.failure,
              entry.source,
              entry.failures + 1,
              claimRetryDelay(entry.failures + 1),
            );
          }
          continue;
        }

        // 终态冲突/失败：不再重试，标记 seen 避免快照反复尝试。
        this.deferred.delete(deliveryId);
        this.deferredNoticeKeys.delete(deliveryId);
        this.emitClaimFailureNotice(entry.item, entry.fields, claim.failure, entry.source);
        await this.state.markSeen(`pending:${deliveryId}:${entry.fields.attempt}`);
      }
    } finally {
      this.deferredRunning = false;
      this.scheduleDeferred();
    }
  }

  /**
   * 事件行只走 stdout；peri 的前缀 `ALERT ` 在此统一追加。
   * `--json` 时输出去掉前缀的单个 JSON 对象，并补齐宿主可稳定过滤的字段。
   */
  private emitEvent(event: JsonObject): void {
    if (this.json) {
      const type = asString(event.type);
      this.stdout(
        JSON.stringify({
          ...event,
          type,
          kind: eventKind(type),
          seq: event.seq ?? null,
          delivery_id: event.delivery_id ?? null,
          room_id: event.room_id ?? null,
          message_id: event.message_id ?? null,
        }),
      );
      return;
    }
    this.stdout(`${this.prefix}${JSON.stringify(event)}`);
  }

  private async readMessage(
    messageId: string,
    deliveryId: string,
  ): Promise<{ ok: true; body: string } | { ok: false }> {
    const chunks: string[] = [];
    let cursor = '';
    for (let index = 0; index < 10_000; index += 1) {
      const args: JsonObject = { message_id: messageId };
      if (cursor.length > 0) args.chunk_cursor = cursor;

      let outcome;
      try {
        outcome = await this.rpc.callTool('network_message_read', args);
      } catch (error) {
        if (error instanceof MonitorFatalError) throw error;
        this.control(
          'error',
          { code: 'read_failed', error_type: 'message', delivery_id: deliveryId },
          `ERROR type=message message=read_failed delivery_id=${deliveryId}`,
        );
        return { ok: false };
      }
      if (!outcome.ok) {
        this.control(
          'error',
          { code: 'read_failed', error_type: 'message', delivery_id: deliveryId },
          `ERROR type=message message=read_failed delivery_id=${deliveryId}`,
        );
        return { ok: false };
      }

      const chunk = outcome.data.chunk;
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'string') {
        this.control(
          'error',
          { code: 'chunk_decode_failed', error_type: 'message', delivery_id: deliveryId },
          `ERROR type=message message=chunk_decode_failed delivery_id=${deliveryId}`,
        );
        return { ok: false };
      }
      chunks.push(typeof chunk === 'string' ? chunk : '');
      if (outcome.data.eof === true) {
        return { ok: true, body: chunks.join('') };
      }
      const next = asString(outcome.data.next_cursor);
      if (next.length === 0 || next === cursor) {
        this.control(
          'error',
          { code: 'invalid_chunk_cursor', error_type: 'message', delivery_id: deliveryId },
          `ERROR type=message message=invalid_chunk_cursor delivery_id=${deliveryId}`,
        );
        return { ok: false };
      }
      cursor = next;
    }
    this.control(
      'error',
      { code: 'invalid_chunk_cursor', error_type: 'message', delivery_id: deliveryId },
      `ERROR type=message message=invalid_chunk_cursor delivery_id=${deliveryId}`,
    );
    return { ok: false };
  }
}
