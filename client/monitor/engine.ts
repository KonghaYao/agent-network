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
 * - room events 默认开启：所有 informational stream item（房间消息、成员、
 *   文件、在线状态、Task、已读、好友、设备、资料、未知）都输出定位字段，
 *   不按 @、attention、发送者或房间类型过滤；delivery 回执走 delivery_state，
 *   撤回/取消的 recipient 回执额外输出 stop/instruction，仍不进入 claim；按 message_id/event_id 精确去重；
 * - 房间游标与最后 stream seq 持久化到 stateDir，重启后按已存游标有界补读；
 *   reconnect 与 more/dropped 都触发所有房间的有界补读，2000 条截断后继续排队；
 *   成员代次变化触发 CURSOR_EXPIRED 时清游标、记录一次重置并重取基线；
 * - 正文只进 event_file 与 stdout 的预览，不写日志。
 */

import { setTimeout as sleepPromise } from 'node:timers/promises';

import { LIMITS } from '../../src/contracts/limits';
import { asArray, asNumber, asRecord, asString } from '../output';
import { isAlertEvent } from './alerts';
import {
  BODY_PREVIEW_CHARS,
  claimNoticeEvent,
  deliveryCancelledEvent,
  deliveryEvent,
  deliveryFields,
  deliveryStateEvent,
  eventFilePayload,
  isActionableDeliveryCancellation,
  previewBody,
  quoteOf,
  readFailedEvent,
  reminderEvent,
  roomMessageEvent,
  streamItemEvent,
  visibleWithoutRoomEvents,
  type ClaimFailure,
  type ClaimInfo,
  type DeliveryFields,
  type MessageQuote,
} from './events';
import { advanceHistoryCursor } from './room-cursor';
import {
  attachmentOrigins,
  downloadAttachments,
  type MonitorAttachment,
} from './attachments';
import {
  fetchMemoryPack,
  memoryEventFields,
  type MemoryContextResult,
  type MemoryMode,
} from './memory';
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
/** room_message 的本地去重窗口；覆盖同帧重复与短时间内的重复通知。 */
const ROOM_MESSAGE_DEDUPE_TTL_MS = 5 * 60_000;
/** reconnect 补读每页条数；服务端 historyPageMax 为 100。 */
const ROOM_HISTORY_PAGE_LIMIT = 100;
/** reconnect 补读单房间的最多页数，避免异常游标导致无限循环。 */
const ROOM_HISTORY_MAX_PAGES = 20;
/** 单次 reconnect 补读上限；超过时记录截断，下一次 reconnect 从保存的游标继续。 */
const ROOM_HISTORY_MAX_ITEMS = ROOM_HISTORY_MAX_PAGES * ROOM_HISTORY_PAGE_LIMIT;
/** 本进程已输出 room_message 的 message_id 记忆上限，用于 reconnect 补读去重。 */
const ROOM_OUTPUT_MEMORY = 10_000;
/** 非 room_message 的 stream item 去重窗口；内存有界，重启后允许重复提示。 */
const INFORMATIONAL_DEDUPE_TTL_MS = 5 * 60_000;
const INFORMATIONAL_SEEN_MAX = 4_096;
/** 单次截断后最多连续续读的轮数；超过后等待下一次 reconnect/more/dropped。 */
const ROOM_BACKFILL_MAX_ROUNDS = 10;
/** 已取消投递的记忆上限；超出时丢最旧，避免长时间运行后无限增长。 */
const CANCELLED_DELIVERIES_MAX = 1_024;

/** `network_history_list` 的单次结果；游标失效需要按业务 code 区分。 */
type RoomHistoryFetch =
  | { ok: true; data: JsonObject }
  | { ok: false; code: string };

/** `--room-events`：开启后监听全部房间活动；缺省开启，`--no-room-events` 关闭。 */
export type RoomEventScope = 'all';

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
    memory?: JsonObject,
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
  /** 输出 informational 房间/信息事件的开关；缺省开启，false 关闭。 */
  roomEvents?: RoomEventScope | false;
  /**
   * delivery 记忆参考包粒度；缺省 off，由各 harness 入口显式开启。
   * claude=full、peri=pointer；`--no-memory-context` 传 off。
   */
  memoryMode?: MemoryMode;
  /**
   * 是否下载正文中的同源附件（图片/PDF）并写入事件；缺省关闭。
   * 只有会读正文并让 Agent 直接处理的 harness（claude）开启。
   */
  attachments?: boolean;
  /** CLI 已在连接前用 network_me 校验过的 actor；设置后引擎不再重复调用。 */
  verifiedActor?: string;
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
 * room=房间消息，stream=其它 informational 事件，receipt=投递状态回执，
 * control=连接/期限事件，error=需要人工修复的错误。
 */
export function eventKind(type: string): string {
  if (type === 'delivery') return 'delivery';
  if (type === 'reminder') return 'reminder';
  if (type === 'room_message') return 'room';
  if (type === 'stream_event') return 'stream';
  if (type === 'delivery_state') return 'receipt';
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
  /** null 表示 `--no-room-events` 关闭。 */
  private readonly roomEventScope: RoomEventScope | null;
  /** delivery 记忆参考包粒度；off 时完全不调用工具。 */
  private readonly memoryMode: MemoryMode;
  /** 开启后 claim 成功才下载同源附件；失败只计数，不影响投递。 */
  private readonly attachmentsEnabled: boolean;
  /** 允许下载的 origin：PUBLIC_ORIGIN、AGENTNET_URL 与监听 endpoint。 */
  private readonly attachmentOrigins: string[];
  /** 同一 delivery:attempt 只注入一次；有界，防止长进程无限增长。 */
  private readonly memoryResults = new Map<string, MemoryContextResult>();
  /** 并发同 key 调用合并，避免通知与补读同时触发第二次工具调用。 */
  private readonly memoryInflight = new Map<string, Promise<MemoryContextResult>>();
  /** 旧服务/关闭开关后不再逐投递尝试。 */
  private memoryToolUnavailable = false;
  /** 每个房间最近一次 history after 游标；启动时从 stateDir 恢复。 */
  private readonly roomHistoryCursors = new Map<string, string>();
  /** message_id(+change) -> 去重截止时间；delivery 与 room_message 共用。 */
  private readonly roomMessageSeen = new Map<string, number>();
  /** 本进程已见 delivery 或已输出 room_message 的 message_id；补读去重用。 */
  private readonly roomMessageHistory = new Set<string>();
  /** 非 room_message 事件的短时去重；有界内存，不写入 seen 文件。 */
  private readonly informationalSeen = new Map<string, number>();
  /** 所有房间补读串行化，避免 ack、more/dropped 与续读轮次互相覆盖。 */
  private roomSyncInFlight: Promise<void> | null = null;
  private roomSyncAgain = false;
  private roomBackfillRounds = 0;

  private meId = '';
  /** CLI 预检已确认的 actor；非空时跳过重复 network_me。 */
  private readonly verifiedActor: string;
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
  /**
   * recipient 收到的“停止”取消。撤回/取消后即使 pending 快照或延迟重试
   * 再次看到同一投递，也不能重新 claim；`delivery.retried` 时清除。
   */
  private readonly cancelledDeliveries = new Set<string>();

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
    this.roomEventScope = options.roomEvents === false ? null : 'all';
    this.memoryMode = options.memoryMode ?? 'off';
    this.attachmentsEnabled = options.attachments === true;
    this.verifiedActor = options.verifiedActor ?? '';
    this.attachmentOrigins = attachmentOrigins(options.rpc.endpoint);
    for (const [roomId, cursor] of this.state.roomCursors()) {
      this.roomHistoryCursors.set(roomId, cursor);
    }
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
    const event = {
      type,
      kind: eventKind(type),
      event_kind: eventKind(type),
      seq: null,
      delivery_id: null,
      room_id: null,
      message_id: null,
      ...fields,
    };
    this.stdout(JSON.stringify({ ...event, alert: isAlertEvent(event) }));
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

    if (this.verifiedActor !== '') {
      this.meId = this.verifiedActor;
      return;
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
    const reconnect = this.readyEmitted;
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
    await this.syncRoomEvents(reconnect);
  }

  private async handleFrame(frame: JsonObject): Promise<void> {
    const params = asRecord(frame.params);
    const envelope = asRecord(asRecord(params._meta)['io.agent-network/event']);
    if (Object.keys(envelope).length === 0) return;

    const rawEnvelopeSeq = envelope.seq;
    const envelopeSeq =
      typeof rawEnvelopeSeq === 'number' ? String(rawEnvelopeSeq) : asString(rawEnvelopeSeq);
    if (envelopeSeq.length > 0) await this.state.setLastSeq(envelopeSeq);

    const rawItems = asArray(envelope.items).map(asRecord);
    const deliveryItems = rawItems.filter((item) => this.isClaimableDelivery(item));
    const receiptItems = rawItems.filter((item) => this.isDeliveryReceipt(item));
    const reminderItems = rawItems.filter(
      (item) =>
        asString(item.source) === 'delivery.reminder' &&
        asString(item.delivery_id).length > 0,
    );
    const informationalItems = rawItems.filter(
      (item) =>
        !this.isClaimableDelivery(item) &&
        !this.isDeliveryReceipt(item) &&
        !(
          asString(item.source) === 'delivery.reminder' &&
          asString(item.delivery_id).length > 0
        ),
    );

    if (deliveryItems.length > 0) {
      const pending = await this.pendingDeliveryMap();

      for (const item of deliveryItems) {
        if (this.signal.aborted) return;
        const id = asString(item.delivery_id);
        if (id.length === 0) continue;
        const source = asString(item.source);
        const eventId = asString(item.event_id);
        const fallback = [source, asString(item.seq), id].join(':');

        // 收到 retry 回执时立即把待领队列里的同一条投递放回队首。
        if (source === 'delivery.retried') {
          this.cancelledDeliveries.delete(id);
          this.releaseDeferred(id);
        }

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
            // 待办已不在 pending：不 claim，但状态变化仍要可见。
            this.emitInformational(
              deliveryStateEvent(
                { ...item, state: asString(item.state) || 'not_pending' },
                source,
              ),
              `delivery-state:${eventId.length > 0 ? eventId : fallback}`,
              visibleWithoutRoomEvents(item),
            );
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
    }

    for (const item of reminderItems) {
      if (this.signal.aborted) return;
      const id = asString(item.delivery_id);
      const source = asString(item.source);
      const eventId = asString(item.event_id);
      const fallback = [source, asString(item.seq), id].join(':');
      const key = `reminder:${id}:${eventId.length > 0 ? eventId : fallback}`;
      if (this.state.hasSeen(key)) continue;
      const event = this.format.reminder ? this.format.reminder(item) : reminderEvent(item);
      this.emitEvent(event);
      await this.state.markSeen(key);
    }

    for (const item of receiptItems) {
      if (this.signal.aborted) return;
      const source = asString(item.source);
      const eventId = asString(item.event_id);
      const fallback = [source, asString(item.seq), asString(item.delivery_id)].join(':');
      const cancelled = isActionableDeliveryCancellation(item);
      if (cancelled) {
        // 撤回/取消是停止指令：先释放本地待领槽位并记住取消，再输出停止事件；
        // 随后的 wakeDeferred 只唤醒其他仍然有效的投递，不能重试被取消的这条。
        const deliveryId = asString(item.delivery_id);
        if (deliveryId.length > 0) {
          this.noteCancelledDelivery(deliveryId);
          this.releaseDeferred(deliveryId);
        }
      }
      this.emitInformational(
        cancelled ? deliveryCancelledEvent(item, source) : deliveryStateEvent(item, source),
        `delivery-state:${eventId.length > 0 ? eventId : fallback}`,
        cancelled || visibleWithoutRoomEvents(item),
      );
    }
    if (receiptItems.length > 0) this.wakeDeferred(0);

    for (const item of informationalItems) {
      if (this.signal.aborted) return;
      this.emitInformationalItem(item);
    }

    if (envelope.more === true || asNumber(envelope.dropped, 0) > 0) {
      await this.emitPendingSnapshot();
      await this.syncRoomEvents(true);
    }
  }

  /** 真正的待办：delivery.* 事件、attention=action_required，且不是提醒或回执。 */
  private isClaimableDelivery(item: JsonObject): boolean {
    const deliveryId = asString(item.delivery_id);
    if (deliveryId.length === 0) return false;
    if (item.attention !== 'action_required') return false;
    const source = asString(item.source);
    if (!source.startsWith('delivery.')) return false;
    if (source === 'delivery.reminder') return false;
    if (this.isDeliveryReceipt(item)) return false;
    return true;
  }

  /** informational stream item 默认全部输出；关闭时仍保留 action_required 与提醒。 */
  private emitInformationalItem(item: JsonObject): void {
    if (this.roomEventScope === null && !visibleWithoutRoomEvents(item)) return;
    const source = asString(item.source) || 'unknown';
    const eventId = asString(item.event_id);
    const fallback = [
      source,
      asString(item.seq),
      asString(item.delivery_id),
      asString(item.message_id),
    ].join(':');
    const key = `stream:${eventId.length > 0 ? eventId : fallback}`;

    if (source === 'room.message') {
      this.emitRoomMessage(item, 'stream');
      return;
    }
    this.emitInformational(
      streamItemEvent(item, source),
      key,
      visibleWithoutRoomEvents(item),
    );
  }

  /** 回执等 informational 事件；用有界短时去重，避免重复帧刷屏。 */
  private emitInformational(event: JsonObject, key: string, allowWhenOff = false): void {
    if (this.roomEventScope === null && !allowWhenOff) return;
    if (this.hasInformationalSeen(key)) return;
    this.rememberInformationalSeen(key);
    this.emitEvent(event);
  }

  private hasInformationalSeen(key: string): boolean {
    const until = this.informationalSeen.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.informationalSeen.delete(key);
    return false;
  }

  private rememberInformationalSeen(key: string): void {
    const now = Date.now();
    if (this.informationalSeen.size >= INFORMATIONAL_SEEN_MAX) {
      for (const [id, until] of this.informationalSeen) {
        if (until <= now) this.informationalSeen.delete(id);
      }
      while (this.informationalSeen.size >= INFORMATIONAL_SEEN_MAX) {
        const oldest = this.informationalSeen.keys().next().value;
        if (oldest === undefined) break;
        this.informationalSeen.delete(oldest);
      }
    }
    this.informationalSeen.set(key, now + INFORMATIONAL_DEDUPE_TTL_MS);
  }

  /** informational room.message → room_message；按 message_id(+change) 去重。 */
  private emitRoomMessage(item: JsonObject, source: string): void {
    if (this.roomEventScope === null && !visibleWithoutRoomEvents(item)) return;
    const roomId = asString(item.room_id);
    const messageId = asString(item.message_id);
    if (roomId.length === 0 || messageId.length === 0) return;
    const key = this.roomMessageDedupeKey(item);
    if (this.hasRoomMessage(key)) return;
    this.rememberRoomMessage(key);
    if (asString(item.change).length === 0) this.rememberRoomMessageHistory(messageId);
    this.emitEvent(roomMessageEvent(item, source));
  }

  /** 撤回与原始消息共用 message_id，但必须作为独立变更输出。 */
  private roomMessageDedupeKey(item: JsonObject): string {
    const messageId = asString(item.message_id);
    const change = asString(item.change);
    return change.length > 0 ? `${messageId}:${change}` : messageId;
  }

  private hasRoomMessage(messageId: string): boolean {
    const until = this.roomMessageSeen.get(messageId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.roomMessageSeen.delete(messageId);
    return false;
  }

  private rememberRoomMessage(messageId: string): void {
    const now = Date.now();
    if (this.roomMessageSeen.size >= 1024) {
      for (const [id, until] of this.roomMessageSeen) {
        if (until <= now) this.roomMessageSeen.delete(id);
      }
      while (this.roomMessageSeen.size >= 1024) {
        const oldest = this.roomMessageSeen.keys().next().value;
        if (oldest === undefined) break;
        this.roomMessageSeen.delete(oldest);
      }
    }
    this.roomMessageSeen.set(messageId, now + ROOM_MESSAGE_DEDUPE_TTL_MS);
  }

  private rememberRoomMessageHistory(messageId: string): void {
    if (this.roomMessageHistory.size >= ROOM_OUTPUT_MEMORY) {
      const oldest = this.roomMessageHistory.values().next().value;
      if (oldest !== undefined) this.roomMessageHistory.delete(oldest);
    }
    this.roomMessageHistory.add(messageId);
  }

  /**
   * 所有房间补读：启动时若 stateDir 已有游标就按 after 有界补读，
   * 否则取当前 head 基线。ack、reconnect、more/dropped 与截断续读共用，
   * 串行执行，避免同一房间的游标被并发覆盖。
   */
  private async syncRoomEvents(_reconnect: boolean): Promise<void> {
    if (this.roomEventScope === null) return;
    if (this.roomSyncInFlight !== null) {
      this.roomSyncAgain = true;
      return this.roomSyncInFlight;
    }
    this.roomSyncInFlight = this.doSyncRoomEvents().finally(() => {
      this.roomSyncInFlight = null;
      if (this.roomSyncAgain && !this.signal.aborted) {
        this.roomSyncAgain = false;
        void this.syncRoomEvents(true).catch((error: unknown) => {
          this.reportStop(error);
        });
      }
    });
    return this.roomSyncInFlight;
  }

  private async doSyncRoomEvents(): Promise<void> {
    const rooms = await this.roomEventRooms();
    let truncated = false;
    for (const roomId of rooms) {
      if (this.signal.aborted) return;
      const cursor = this.roomHistoryCursors.get(roomId) ?? this.state.getRoomCursor(roomId);
      if (cursor !== undefined) {
        if ((await this.backfillRoom(roomId, cursor)) === 'truncated') truncated = true;
      } else {
        await this.captureRoomCursor(roomId);
      }
    }

    if (!truncated) {
      this.roomBackfillRounds = 0;
      return;
    }
    // 单轮 2000 条仍有积压：立即排队下一轮，而不是等下一次 reconnect。
    // 连续轮次有上界，防止异常游标或持续写入导致本进程永不返回。
    if (this.roomBackfillRounds < ROOM_BACKFILL_MAX_ROUNDS) {
      this.roomBackfillRounds += 1;
      this.roomSyncAgain = true;
    }
  }

  private async roomEventRooms(): Promise<string[]> {
    if (this.roomEventScope === null) return [];

    const rooms: string[] = [];
    let cursor = '';
    for (let page = 0; page < ROOM_HISTORY_MAX_PAGES; page += 1) {
      const args: JsonObject = { limit: ROOM_HISTORY_PAGE_LIMIT };
      if (cursor.length > 0) args.cursor = cursor;
      let outcome;
      try {
        outcome = await this.rpc.callTool('network_rooms_list', args);
      } catch (error) {
        if (error instanceof MonitorFatalError) throw error;
        this.roomHistoryError('room_list_failed');
        return rooms;
      }
      if (!outcome.ok) {
        this.roomHistoryError('room_list_failed');
        return rooms;
      }
      for (const raw of asArray(outcome.data.items)) {
        const roomId = asString(asRecord(raw).room_id);
        if (roomId.length > 0) rooms.push(roomId);
      }
      const next = asString(outcome.data.next_cursor);
      if (outcome.data.has_more !== true || next.length === 0 || next === cursor) return rooms;
      cursor = next;
    }
    return rooms;
  }

  /**
   * 取房间当前 head 的 after 游标，作为下一次 reconnect 的补读起点。
   * 无游标的 after 按服务端契约从当前快照上界（成员加入边界之后）开始，
   * 因此重新加入后重取基线不会回放加入前的消息。
   */
  private async captureRoomCursor(roomId: string): Promise<void> {
    const result = await this.fetchRoomHistory(roomId, null);
    if (!result.ok) {
      this.roomHistoryError('room_history_failed', roomId);
      return;
    }
    const page = result.data;
    const items = asArray(page.items).map(asRecord);
    const next = advanceHistoryCursor(null, asString(page.next_cursor), items);
    if (next.length > 0) {
      this.roomHistoryCursors.set(roomId, next);
      await this.state.setRoomCursor(roomId, next);
    }
  }

  /**
   * 成员代次变化后服务端拒绝旧游标（CURSOR_EXPIRED）：丢弃旧游标，
   * 记录一次可见重置，再按契约用无游标 after 取当前 head 作为新基线。
   * 已输出的 message_id 由本地去重记忆保留，不会重复输出。
   */
  private async resetRoomCursor(roomId: string): Promise<void> {
    this.roomHistoryCursors.delete(roomId);
    await this.state.deleteRoomCursor(roomId);
    this.control(
      'room_history_reset',
      { error_type: 'room', room_id: roomId, reason: 'cursor_expired' },
      `ROOM_HISTORY_RESET room_id=${roomId} reason=cursor_expired`,
    );
    await this.captureRoomCursor(roomId);
  }

  /**
   * 用保存的游标 after 补读；分页直到 has_more=false，只输出定位字段。
   * 单次最多 20 页；达到上限返回 truncated，由调用方立即排队续读。
   */
  private async backfillRoom(roomId: string, cursor: string): Promise<'done' | 'truncated'> {
    let current = cursor;
    let seen = 0;
    for (let page = 0; page < ROOM_HISTORY_MAX_PAGES; page += 1) {
      if (this.signal.aborted) return 'done';
      const result = await this.fetchRoomHistory(roomId, current);
      if (!result.ok) {
        if (result.code === 'CURSOR_EXPIRED') {
          await this.resetRoomCursor(roomId);
          return 'done';
        }
        this.roomHistoryError('room_history_failed', roomId);
        return 'done';
      }
      const data = result.data;

      const items = asArray(data.items).map(asRecord);
      seen += items.length;
      for (const item of items) {
        const messageId = asString(item.message_id);
        if (messageId.length === 0) continue;
        if (this.roomMessageHistory.has(messageId)) continue;
        if (this.hasRoomMessage(messageId)) continue;
        this.rememberRoomMessage(messageId);
        this.rememberRoomMessageHistory(messageId);
        this.emitEvent(roomMessageEvent(item, 'history'));
      }

      // 服务端游标正常已前进；仍按本页最后一条消息推进，兼容旧服务端。
      const next = advanceHistoryCursor(current, asString(data.next_cursor), items);
      if (next.length > 0) {
        this.roomHistoryCursors.set(roomId, next);
        await this.state.setRoomCursor(roomId, next);
      }
      if (data.has_more !== true) return 'done';
      if (next.length === 0) {
        this.roomHistoryError('room_history_cursor_missing', roomId);
        return 'done';
      }
      if (next === current) {
        this.roomHistoryError('room_history_cursor_stalled', roomId);
        return 'done';
      }
      current = next;
    }
    // 达到单次上限仍有积压：游标已保存，调用方会立即排队下一轮。
    this.roomHistoryTruncated(roomId, seen);
    return 'truncated';
  }

  private async fetchRoomHistory(
    roomId: string,
    cursor: string | null,
  ): Promise<RoomHistoryFetch> {
    const args: JsonObject = {
      room_id: roomId,
      direction: 'after',
      limit: ROOM_HISTORY_PAGE_LIMIT,
    };
    if (cursor !== null) args.cursor = cursor;
    try {
      const outcome = await this.rpc.callTool('network_history_list', args);
      if (!outcome.ok) return { ok: false, code: outcome.code };
      return { ok: true, data: outcome.data };
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      return { ok: false, code: 'TRANSPORT_ERROR' };
    }
  }

  private roomHistoryError(code: string, roomId?: string): void {
    this.control(
      'error',
      {
        code,
        error_type: 'room',
        ...(roomId === undefined ? {} : { room_id: roomId }),
      },
      `ERROR type=room message=${code}${roomId === undefined ? '' : ` room_id=${roomId}`}`,
    );
  }

  /** 单次补读达到 2000 条上限：明确记录；调用方会立即排队下一轮续读。 */
  private roomHistoryTruncated(roomId: string, items: number): void {
    this.control(
      'room_history_truncated',
      {
        error_type: 'room',
        room_id: roomId,
        items,
        max_items: ROOM_HISTORY_MAX_ITEMS,
        max_pages: ROOM_HISTORY_MAX_PAGES,
      },
      `ROOM_HISTORY_TRUNCATED room_id=${roomId} items=${items} max_items=${ROOM_HISTORY_MAX_ITEMS}`,
    );
  }

  /** 投递回执：绝不 claim；claimed/progress/completed/failed/cancelled 都可见。 */
  private isDeliveryReceipt(item: JsonObject): boolean {
    const source = asString(item.source);
    if (source === 'delivery.updated' || source === 'delivery.cancelled') return true;
    if (source === 'delivery.retried' || source === 'delivery.reminder') return false;
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
    // 已收到 recipient 的停止取消：不再 claim，也不重复输出投递。
    if (this.cancelledDeliveries.has(fields.deliveryId)) return 'emitted';
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
    if (this.emittedClaims.has(claimKey)) {
      this.noteDeliveryEmitted(fields);
      return 'emitted';
    }

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
      const memory = await this.memoryForDelivery(fields, claim);
      this.emittedClaims.add(claimKey);
      this.emitEvent(
        delivery(item, fields, claim, source, this.memoryFields(memory)),
      );
      this.noteDeliveryEmitted(fields);
      return 'emitted';
    }

    // 记忆读取与正文读取并行：任一失败都不阻塞 delivery 输出。
    const memoryPromise = this.memoryForDelivery(fields, claim);
    const read = await this.readMessage(fields.messageId, fields.deliveryId);
    const memory = await memoryPromise;
    const memoryFields = this.memoryFields(memory);
    if (!read.ok) {
      this.emittedClaims.add(claimKey);
      this.emitEvent(readFailedEvent(fields, claim, source, memoryFields));
      this.noteDeliveryEmitted(fields);
      return 'emitted';
    }

    // 附件在 claim 成功且正文可读后才下载；任何失败只减少附件，不阻塞投递。
    let attachments: MonitorAttachment[] = [];
    if (this.attachmentsEnabled) {
      const outcome = await downloadAttachments({
        body: read.body,
        origins: this.attachmentOrigins,
        directory: this.state.attachmentsDir,
        signal: this.signal,
      });
      attachments = outcome.attachments;
      if (attachments.length > 0 || outcome.skipped > 0) {
        this.control(
          'attachments',
          {
            code: 'attachments',
            delivery_id: fields.deliveryId,
            downloaded: attachments.length,
            skipped: outcome.skipped,
          },
          `ATTACHMENTS delivery=${fields.deliveryId} downloaded=${attachments.length} skipped=${outcome.skipped}`,
        );
      }
    }

    let eventFile: string;
    try {
      eventFile = await this.state.writeEventFile(
        fields.deliveryId,
        eventFilePayload(fields, claim, source, read.body, memoryFields, read.quote, attachments),
      );
    } catch {
      this.control(
        'error',
        { code: 'event_write_failed', error_type: 'message', delivery_id: fields.deliveryId },
        `ERROR type=message message=event_write_failed delivery_id=${fields.deliveryId}`,
      );
      this.emittedClaims.add(claimKey);
      this.emitEvent(readFailedEvent(fields, claim, source, memoryFields));
      this.noteDeliveryEmitted(fields);
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
        memoryFields,
        read.quote,
        attachments,
      ),
    );
    this.noteDeliveryEmitted(fields);
    return 'emitted';
  }

  /** off 模式不产生任何记忆字段；否则按 full/pointer 裁剪。 */
  private memoryFields(result: MemoryContextResult): JsonObject {
    if (this.memoryMode === 'off') return {};
    return memoryEventFields(result, this.memoryMode);
  }

  /**
   * 每个 `delivery_id:attempt` 最多一次工具调用；并发同 key 合并，重连后
   * 复用同一结果。缓存有界，避免长进程无限增长。
   */
  private async memoryForDelivery(
    fields: DeliveryFields,
    claim: ClaimInfo,
  ): Promise<MemoryContextResult> {
    if (this.memoryMode === 'off') {
      return { pack: null, reason: 'disabled', disabled: false };
    }
    const key = `${fields.deliveryId}:${claim.attempt}`;
    const cached = this.memoryResults.get(key);
    if (cached) return cached;
    const inflight = this.memoryInflight.get(key);
    if (inflight) return await inflight;
    if (this.memoryToolUnavailable) {
      return { pack: null, reason: 'memory_disabled', disabled: true };
    }

    const task = (async (): Promise<MemoryContextResult> => {
      const result = await fetchMemoryPack(this.rpc, {
        roomId: fields.roomId,
        messageId: fields.messageId,
      });
      if (result.disabled) this.memoryToolUnavailable = true;
      this.rememberMemoryResult(key, result);
      return result;
    })();
    this.memoryInflight.set(key, task);
    try {
      return await task;
    } finally {
      this.memoryInflight.delete(key);
    }
  }

  private rememberMemoryResult(key: string, result: MemoryContextResult): void {
    if (this.memoryResults.size >= LIMITS.memoryInjectClientCacheEntries) {
      const oldest = this.memoryResults.keys().next().value;
      if (oldest !== undefined) this.memoryResults.delete(oldest);
    }
    this.memoryResults.set(key, result);
  }

  /** 只有 delivery 真正输出后才占用 message_id，避免吞掉同帧 room_message。 */
  private noteDeliveryEmitted(fields: DeliveryFields): void {
    if (fields.messageId.length === 0) return;
    this.rememberRoomMessage(fields.messageId);
    this.rememberRoomMessageHistory(fields.messageId);
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

  /** 记住被取消的投递；有界保留，`delivery.retried` 时移除。 */
  private noteCancelledDelivery(deliveryId: string): void {
    if (!this.cancelledDeliveries.has(deliveryId)) this.cancelledDeliveries.add(deliveryId);
    while (this.cancelledDeliveries.size > CANCELLED_DELIVERIES_MAX) {
      const oldest = this.cancelledDeliveries.values().next().value;
      if (oldest === undefined) break;
      this.cancelledDeliveries.delete(oldest);
    }
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
        if (this.cancelledDeliveries.has(deliveryId)) {
          // 已撤回/取消：释放槽位，不 claim、不输出 claim_failed。
          this.deferred.delete(deliveryId);
          this.deferredNoticeKeys.delete(deliveryId);
          continue;
        }
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

        // claim 在途期间收到取消：丢弃结果，不输出 claim 失败/延迟提示，不重试。
        if (this.cancelledDeliveries.has(deliveryId)) {
          this.deferred.delete(deliveryId);
          this.deferredNoticeKeys.delete(deliveryId);
          continue;
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
      const providedKind = asString(event.kind);
      const enriched = {
        ...event,
        type,
        event_kind: eventKind(type),
        kind: providedKind.length > 0 ? providedKind : eventKind(type),
        seq: event.seq ?? null,
        delivery_id: event.delivery_id ?? null,
        room_id: event.room_id ?? null,
        message_id: event.message_id ?? null,
      };
      this.stdout(JSON.stringify({ ...enriched, alert: isAlertEvent(event) }));
      return;
    }
    this.stdout(`${this.prefix}${JSON.stringify(event)}`);
  }

  private async readMessage(
    messageId: string,
    deliveryId: string,
  ): Promise<{ ok: true; body: string; quote: MessageQuote | null } | { ok: false }> {
    const chunks: string[] = [];
    let cursor = '';
    let quote: MessageQuote | null = null;
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
      // 引用只在首次分块返回；缺失或格式不符时省略，不影响正文。
      if (cursor.length === 0) quote = quoteOf(outcome.data.quote);
      chunks.push(typeof chunk === 'string' ? chunk : '');
      if (outcome.data.eof === true) {
        return { ok: true, body: chunks.join(''), quote };
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
