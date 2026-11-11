/**
 * 共享监控引擎：连接、订阅、自动 claim、正文读取与事件输出。
 *
 * 这是 claude-watch.sh 监听循环的 TypeScript 等价实现；Phase 2 的
 * peri/codex/dsh 只需要换 stdout 信封或入口参数，不需要复制连接与 claim 逻辑。
 *
 * 关键不变量：
 * - stdout 只写事件 JSON，一行一个；READY/诊断只写 stderr；
 * - 每个投递先 claim，成功后才读正文并输出可处理的 delivery 事件；
 * - 同一时刻只保留一个 claim（由服务端约束），deferred 不写永久 seen；
 * - 正文只进 event_file 与 stdout 的预览，不写日志。
 */

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

class MonitorStop extends Error {
  constructor(
    readonly logLine: string,
    readonly exitCode = 1,
  ) {
    super(logLine);
    this.name = 'MonitorStop';
  }
}

export interface MonitorEngineOptions {
  rpc: MonitorRpc;
  state: MonitorState;
  signal: AbortSignal;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  bodyPreviewChars?: number;
  ackTimeoutMs?: number;
  idleTimeoutMs?: number;
}

type EmitResult = 'emitted' | 'deferred' | 'error';

type ClaimResult =
  | { ok: true; claim: ClaimInfo }
  | { ok: false; failure: ClaimFailure };

function reconnectDelay(attempt: number): number {
  const base =
    attempt <= 1 ? 1 : attempt === 2 ? 2 : attempt === 3 ? 4 : attempt === 4 ? 8 : attempt === 5 ? 16 : 30;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(base * jitter * 10) / 10;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
}

function newSubscriptionId(generation: number): string {
  return `sub-${Math.floor(Date.now() / 1000)}-${process.pid}-${generation}-${Math.floor(
    Math.random() * 1_000_000,
  )}`;
}

export class MonitorEngine {
  private readonly rpc: MonitorRpc;
  private readonly state: MonitorState;
  private readonly signal: AbortSignal;
  private readonly stdout: (line: string) => void;
  private readonly stderr: (line: string) => void;
  private readonly bodyPreviewChars: number;
  private readonly ackTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  private meId = '';
  private readyEmitted = false;
  private lastDisconnectReason = 'connection_closed';
  private reconnectAttempt = 0;
  private failStartedAt = 0;
  private degraded = false;
  private generation = 0;

  constructor(options: MonitorEngineOptions) {
    this.rpc = options.rpc;
    this.state = options.state;
    this.signal = options.signal;
    this.stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
    this.stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
    this.bodyPreviewChars = options.bodyPreviewChars ?? BODY_PREVIEW_CHARS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  }

  async run(): Promise<number> {
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
        this.stderr(
          `RECONNECTING reason=${outcome.reason} status=${outcome.status} attempt=${this.reconnectAttempt} delay=${delay}`,
        );
        if (
          !this.degraded &&
          (this.reconnectAttempt >= 5 || now - this.failStartedAt >= 60_000)
        ) {
          this.stderr(`DEGRADED attempts=${this.reconnectAttempt} last_reason=${outcome.reason}`);
          this.degraded = true;
        }
        await abortableSleep(delay * 1000, this.signal);
      }
      return 0;
    } catch (error) {
      return this.reportStop(error);
    }
  }

  private reportStop(error: unknown): number {
    if (error instanceof MonitorStop) {
      this.stderr(error.logLine);
      return error.exitCode;
    }
    if (error instanceof MonitorFatalError) {
      if (error.kind === 'credential') {
        this.stderr('ERROR type=credential message=credential_invalid');
      } else {
        this.stderr(`ERROR type=protocol message=${error.message || 'request_rejected'}`);
      }
      return 1;
    }
    this.stderr('ERROR type=internal message=monitor_failed');
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
    let login;
    try {
      login = await this.rpc.callTool('network_login', {});
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.stderr('ERROR type=login message=network_login_failed');
      abort('login_failed');
      return;
    }
    if (!login.ok) {
      this.stderr('ERROR type=login message=network_login_failed');
      abort('login_failed');
      return;
    }

    const pending = asNumber(login.data.pending_count, 0);
    if (!this.readyEmitted) {
      this.stderr(`READY actor=${this.meId} pending=${pending} subscription=${subscriptionId}`);
      this.readyEmitted = true;
    } else {
      this.stderr(
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
        this.stdout(JSON.stringify(reminderEvent(item)));
        await this.state.markSeen(key);
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

    if (envelope.more === true || asNumber(envelope.dropped, 0) > 0) {
      await this.emitPendingSnapshot();
    }
  }

  /** 只在通知需要时读一次 pending；失败时退回事件自身的 attempt。 */
  private async pendingDeliveryMap(): Promise<Map<string, number> | null> {
    let outcome;
    try {
      outcome = await this.rpc.callTool('network_inbox_list', { state: 'pending', limit: 50 });
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.stderr('ERROR type=inbox message=pending_lookup_failed');
      return null;
    }
    if (!outcome.ok) {
      this.stderr('ERROR type=inbox message=pending_lookup_failed');
      return null;
    }
    const map = new Map<string, number>();
    for (const raw of asArray(outcome.data.items).map(asRecord)) {
      const message = asRecord(raw.message);
      if (asString(message.sender_id) === this.meId) continue;
      const id = asString(raw.delivery_id);
      if (id.length === 0) continue;
      map.set(id, asNumber(raw.attempt, 0));
    }
    return map;
  }

  private async emitPendingSnapshot(): Promise<void> {
    let outcome;
    try {
      outcome = await this.rpc.callTool('network_inbox_list', { state: 'pending', limit: 50 });
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.stderr('ERROR type=inbox message=snapshot_failed');
      return;
    }
    if (!outcome.ok) {
      this.stderr('ERROR type=inbox message=snapshot_failed');
      return;
    }

    for (const item of asArray(outcome.data.items).map(asRecord)) {
      if (asString(asRecord(item.message).sender_id) === this.meId) continue;
      const id = asString(item.delivery_id);
      if (id.length === 0) continue;
      const key = `pending:${id}:${asNumber(item.attempt, 0)}`;
      if (this.state.hasSeen(key)) continue;
      const result = await this.emitFound(item, 'inbox.snapshot');
      if (result === 'emitted') await this.state.markSeen(key);
      else if (result === 'error') return;
    }
  }

  private async emitFound(item: JsonObject, source: string): Promise<EmitResult> {
    const fields = deliveryFields(item);
    if (!SAFE_ID.test(fields.deliveryId)) {
      this.stderr('ERROR type=format message=invalid_delivery_reference');
      return 'error';
    }
    if (!SAFE_ID.test(fields.messageId)) {
      this.stderr('ERROR type=format message=invalid_message_reference');
      return 'error';
    }

    const claim = await this.claimDelivery(fields.deliveryId);
    if (claim === null) return 'error';
    if (!claim.ok) {
      this.stdout(JSON.stringify(claimNoticeEvent(fields, claim.failure, source)));
      return claim.failure.kind === 'deferred' ? 'deferred' : 'emitted';
    }

    const read = await this.readMessage(fields.messageId, fields.deliveryId);
    if (!read.ok) {
      this.stdout(JSON.stringify(readFailedEvent(fields, claim.claim, source)));
      return 'emitted';
    }

    let eventFile: string;
    try {
      eventFile = await this.state.writeEventFile(
        fields.deliveryId,
        eventFilePayload(fields, claim.claim, source, read.body),
      );
    } catch {
      this.stderr(`ERROR type=message message=event_write_failed delivery_id=${fields.deliveryId}`);
      this.stdout(JSON.stringify(readFailedEvent(fields, claim.claim, source)));
      return 'emitted';
    }

    this.stdout(
      JSON.stringify(
        deliveryEvent(
          fields,
          claim.claim,
          source,
          previewBody(read.body, this.bodyPreviewChars),
          eventFile,
        ),
      ),
    );
    return 'emitted';
  }

  /**
   * 自动 claim；CLAIM_CONFLICT 只读一次 claimed inbox 区分“自己已领取”
   * 与“别人领取/当前已有其他 claim”，不轮询。
   */
  private async claimDelivery(deliveryId: string): Promise<ClaimResult | null> {
    let outcome;
    try {
      outcome = await this.rpc.callTool('network_delivery_claim', {
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
      const page = await this.rpc.callTool('network_inbox_list', { state: 'claimed', limit: 50 });
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
        this.stderr(`ERROR type=message message=read_failed delivery_id=${deliveryId}`);
        return { ok: false };
      }
      if (!outcome.ok) {
        this.stderr(`ERROR type=message message=read_failed delivery_id=${deliveryId}`);
        return { ok: false };
      }

      const chunk = outcome.data.chunk;
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'string') {
        this.stderr(`ERROR type=message message=chunk_decode_failed delivery_id=${deliveryId}`);
        return { ok: false };
      }
      chunks.push(typeof chunk === 'string' ? chunk : '');
      if (outcome.data.eof === true) {
        return { ok: true, body: chunks.join('') };
      }
      const next = asString(outcome.data.next_cursor);
      if (next.length === 0 || next === cursor) {
        this.stderr(`ERROR type=message message=invalid_chunk_cursor delivery_id=${deliveryId}`);
        return { ok: false };
      }
      cursor = next;
    }
    this.stderr(`ERROR type=message message=invalid_chunk_cursor delivery_id=${deliveryId}`);
    return { ok: false };
  }
}
