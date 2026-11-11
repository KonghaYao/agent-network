/**
 * `agentnet monitor --harness codex`：旧 codex 桥接的 TypeScript 等价实现。
 *
 * 宿主协议（Codex app-server，Unix socket + WebSocket）：
 * - `codex app-server daemon version` 返回 socketPath；测试可用
 *   AGENTNET_CODEX_SOCKET 注入 mock，不依赖真实 Codex 二进制；
 * - 连接后 `initialize` -> `initialized` 通知 -> `thread/loaded/list` -> `thread/resume`；
 * - 空闲时用 `turn/start` 注入任务，回合进行中用 `turn/steer` 插话；
 * - `item/completed` 的 agentMessage(final_answer) 记录最终答复，
 *   `turn/completed` 后用该答复 complete，否则 fail。
 *
 * 投递语义与旧脚本一致：SSE 订阅 `agentnet://stream`，收到待办先 claim；
 * deferred/conflict/claim_failed 只记录不处理；10 秒未结束的回合发送一次慢确认；
 * `delivery.reminder` 只提醒、不 claim。日志沿用旧脚本的行格式（stdout），
 * 不执行任何 `.sh`，也不依赖 Python。
 */

import { CliError, resolveConfig } from '../mcp';
import { asArray, asNumber, asRecord, asString } from '../output';
import { abortableSleep, claimDelivery } from './engine';
import type { ClaimInfo } from './events';
import {
  AsyncQueue,
  CodexCallError,
  CodexConnection,
  WatchStop,
  acquireThreadLock,
  acquireWatcherLock,
  claimPayload,
  newRequestId,
  resolveSocketPath,
  type WatcherEvent,
  type WatcherLock,
} from './codex-transport';
import {
  MonitorFatalError,
  MonitorRpc,
  subscribe,
  type JsonObject,
  type SubscriptionControl,
} from './rpc';

export interface MonitorContext {
  baseUrl: string | null;
  token: string | null;
}

const STREAM_URI = 'agentnet://stream';
const ACK_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 15_000;
const SLOW_ACK_MS = 10_000;
const RETRY_DELAY_MS = 500;
const CLIENT_NAME = 'codex-watch';
const CLIENT_VERSION = '1.0.0';
const ACK_BODY = '收到，我正在处理，稍后回复结果。';
const CONNECTION_HINT =
  'app_server_disconnected; restart watcher to reconcile pending inbox and claimed deliveries';

function writeStdout(text: string): void {
  process.stdout.write(`${text}\n`);
}

function fail(line: string): number {
  writeStdout(line);
  return 1;
}

function steerPrompt(body: string): string {
  return (
    'Agent Network 有一条新的用户消息在你工作期间到达。桥接器已自动领取该投递，' +
    '本条只供你调整当前工作；当前回合结束后会单独处理并答复，不要在此重复结束投递。\n\n' +
    `新消息：\n${body}`
  );
}

function taskPrompt(deliveryId: string, claim: ClaimInfo, body: string): string {
  return (
    '这是一条来自 Agent Network 的用户任务。桥接器已自动领取投递并读取正文；' +
    `claim 已就绪（delivery_id=${deliveryId}, attempt=${claim.attempt}, ` +
    `claim_id=${claim.claimId}）。` +
    '你只需要处理下面的任务，给出最终答复，桥接器会用该答复结束投递。' +
    '不要泄露凭据，不要调用其他 Agent 身份的 network_* 工具回复本任务。\n\n' +
    `任务正文：\n${body}`
  );
}

function reminderPrompt(item: JsonObject): string {
  return (
    'Agent Network 提醒：以下投递已领取但 3 分钟没有状态更新。' +
    '请先调用 network_inbox_list 核对状态，再用 network_delivery_report 报告当前阶段进度；' +
    '如果已完成则 network_delivery_complete，失败/阻塞则 network_delivery_fail，' +
    '确实无法继续时由接收者调用 network_delivery_retry。' +
    '不要重复 claim，不要泄露凭据或把正文发到无关房间。\n\n' +
    `delivery_id=${asString(item.delivery_id)} ` +
    `room_id=${asString(item.room_id)} ` +
    `message_id=${asString(item.message_id)} ` +
    `attempt=${asString(item.attempt)}`
  );
}

interface ActiveTurn {
  deliveryId: string;
  turnId: string;
  claim: ClaimInfo;
}

interface CodexWatcherOptions {
  endpoint: string;
  token: string;
  signal: AbortSignal;
  log?: (line: string) => void;
}

class CodexWatcher {
  private readonly rpc: MonitorRpc;
  private readonly externalSignal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly onExternalAbort = (): void => this.controller.abort();
  private readonly log: (line: string) => void;
  private readonly events = new AsyncQueue<WatcherEvent>();

  private readonly outstanding = new Map<string, JsonObject>();
  private readonly delivered = new Map<string, number>();
  private readonly notified = new Map<string, number>();
  private readonly remindersSeen = new Map<string, string>();
  private readonly claimSkipped = new Map<string, number>();
  private readonly steered = new Map<string, JsonObject>();

  private connection: CodexConnection | null = null;
  private threadLock: WatcherLock | null = null;
  private threadId = '';
  private actorId = '';
  private activeTurn: ActiveTurn | null = null;
  private finalMessage: string | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private ackInflight: Promise<void> | null = null;

  constructor(options: CodexWatcherOptions) {
    this.externalSignal = options.signal;
    this.log = options.log ?? writeStdout;
    this.rpc = new MonitorRpc({
      endpoint: options.endpoint,
      token: options.token,
      signal: this.controller.signal,
      clientName: CLIENT_NAME,
      clientVersion: CLIENT_VERSION,
    });
    if (options.signal.aborted) this.controller.abort();
    else options.signal.addEventListener('abort', this.onExternalAbort, { once: true });
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  async run(): Promise<number> {
    let stream: Promise<void> | null = null;
    try {
      const socketPath = resolveSocketPath();
      this.connection = await CodexConnection.open(socketPath, this.events, this.signal);
      await this.handshake(socketPath);
      await this.ensureIdentity();
      stream = this.streamLoop();
      return await this.mainLoop();
    } catch (error) {
      return this.reportStop(error);
    } finally {
      this.controller.abort();
      this.events.close();
      if (stream !== null) await stream.catch(() => undefined);
      await this.cancelAck();
      this.externalSignal.removeEventListener('abort', this.onExternalAbort);
      this.connection?.close();
      this.threadLock?.release();
    }
  }

  private reportStop(error: unknown): number {
    // Ctrl-C 在握手/连接阶段也要以 0 退出，不把信号当成协议错误。
    if (this.signal.aborted) return 0;
    if (error instanceof MonitorFatalError) {
      return fail(
        `ERROR codex_watch=${error.kind === 'credential' ? 'credential_invalid' : 'request_rejected'}`,
      );
    }
    if (error instanceof WatchStop || error instanceof CodexCallError) {
      return fail(`ERROR codex_watch=${error.message}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(`ERROR codex_watch=${message}`);
  }

  private async handshake(socketPath: string): Promise<void> {
    const connection = this.requireConnection();
    await connection.call('initialize', {
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    connection.notify('initialized');
    const loaded = asArray(asRecord(await connection.call('thread/loaded/list')).data).map(
      (item) => asString(item),
    );
    const configured = asString(process.env.CODEX_THREAD_ID);
    let threadId = configured;
    if (threadId.length === 0) {
      if (loaded.length !== 1) {
        throw new WatchStop(
          `set CODEX_THREAD_ID: expected one loaded thread; found ${loaded.join(', ')}`,
        );
      }
      threadId = loaded[0] ?? '';
    }
    if (!loaded.includes(threadId)) throw new WatchStop('CODEX_THREAD_ID is not a loaded thread');
    this.threadLock = acquireThreadLock(socketPath, threadId);
    await connection.call('thread/resume', { threadId });
    this.threadId = threadId;
    this.log(`CODEX_READY thread=${threadId}`);
  }

  private async ensureIdentity(): Promise<void> {
    try {
      await this.rpc.discover();
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      throw new WatchStop('discover_failed');
    }
    let me;
    try {
      me = await this.rpc.callTool('network_me', {});
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      throw new WatchStop('network_me_failed');
    }
    if (!me.ok) throw new WatchStop('network_me_failed');
    this.actorId = asString(me.data.actor_id);
    if (this.actorId.length === 0) throw new WatchStop('network_me_failed');
    if (asString(me.data.kind) !== 'agent') throw new WatchStop('agent_token_required');
  }

  private requireConnection(): CodexConnection {
    if (!this.connection) throw new WatchStop(CONNECTION_HINT);
    return this.connection;
  }

  private async mainLoop(): Promise<number> {
    while (!this.signal.aborted) {
      const event = await this.events.shift(this.signal);
      if (event === null) return 0;
      switch (event.kind) {
        case 'disconnected':
          return fail(`ERROR codex_watch=${CONNECTION_HINT}`);
        case 'stream_fatal':
          return fail(`ERROR codex_watch=${event.message}`);
        case 'reminder':
          await this.wakeReminder(event.item);
          break;
        case 'alert':
          this.noteAlert(event.item);
          break;
        case 'retry':
          break;
        case 'host':
          await this.handleHostNotification(event.method, event.params);
          break;
      }
      await this.pump();
    }
    return 0;
  }

  /** SSE 断线重连：1/2/4/8/16/30 秒；ack 成功后重置计数。 */
  private async streamLoop(): Promise<void> {
    let attempts = 0;
    let lastReason = 'connection_closed';
    while (!this.signal.aborted) {
      const subscriptionId = `codex-watch-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
      let outcome;
      try {
        outcome = await subscribe(this.rpc, {
          subscriptionId,
          uri: STREAM_URI,
          ackTimeoutMs: ACK_TIMEOUT_MS,
          idleTimeoutMs: IDLE_TIMEOUT_MS,
          signal: this.signal,
          onAck: (control) => this.handleAck(control, subscriptionId, attempts, lastReason),
          onFrame: (frame) => this.handleNotification(frame),
        });
      } catch (error) {
        if (this.signal.aborted) return;
        if (error instanceof MonitorFatalError) {
          this.events.push({
            kind: 'stream_fatal',
            message: error.kind === 'credential' ? 'credential_invalid' : 'request_rejected',
          });
          return;
        }
        this.events.push({ kind: 'stream_fatal', message: 'stream_watcher_stopped' });
        return;
      }
      if (this.signal.aborted) return;
      lastReason = outcome.reason;
      attempts += 1;
      this.log(
        `RECONNECTING reason=${outcome.reason} status=${outcome.status} ` +
          `acknowledged=${outcome.acked ? 1 : 0}`,
      );
      if (attempts === 5) this.log('DEGRADED stream_reconnect');
      await abortableSleep(Math.min(30, 2 ** Math.min(attempts - 1, 5)) * 1000, this.signal);
    }
  }

  private async handleAck(
    control: SubscriptionControl,
    subscriptionId: string,
    attempts: number,
    lastReason: string,
  ): Promise<void> {
    const reconnected = attempts > 0;
    let login;
    try {
      login = await this.rpc.callTool('network_login', {});
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.log('ERROR type=login message=network_login_failed');
      control.abort('login_failed');
      return;
    }
    if (!login.ok) {
      this.log('ERROR type=login message=network_login_failed');
      control.abort('login_failed');
      return;
    }
    const suffix = reconnected ? ` reconnect=1 reason=${lastReason}` : '';
    this.log(`READY actor=${this.actorId} subscription=${subscriptionId}${suffix}`);
    await this.snapshot();
  }

  private async handleNotification(frame: JsonObject): Promise<void> {
    const params = asRecord(frame.params);
    const envelope = asRecord(asRecord(params._meta)['io.agent-network/event']);
    if (Object.keys(envelope).length === 0) return;

    for (const raw of asArray(envelope.items)) {
      const item = asRecord(raw);
      const deliveryId = asString(item.delivery_id);
      const source = asString(item.source);
      if (source === 'delivery.reminder') {
        if (deliveryId.length > 0) this.events.push({ kind: 'reminder', item });
        continue;
      }
      if (
        item.attention === 'action_required' &&
        deliveryId.length > 0 &&
        asString(item.sender_id) !== this.actorId
      ) {
        this.events.push({ kind: 'alert', item });
      }
    }

    if (envelope.more === true || asNumber(envelope.dropped, 0) > 0) await this.snapshot();
  }

  /** 重连后补读 pending；失败只记日志，不把整个监听器打挂。 */
  private async snapshot(): Promise<void> {
    let outcome;
    try {
      outcome = await this.rpc.callTool('network_inbox_list', { state: 'pending', limit: 50 });
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.log('ERROR type=inbox message=snapshot_failed');
      return;
    }
    if (!outcome.ok) {
      this.log('ERROR type=inbox message=snapshot_failed');
      return;
    }
    for (const raw of asArray(outcome.data.items)) {
      const item = asRecord(raw);
      if (asString(item.delivery_id).length === 0) continue;
      if (asString(asRecord(item.message).sender_id) === this.actorId) continue;
      this.events.push({ kind: 'alert', item });
    }
  }

  private noteAlert(item: JsonObject): void {
    const deliveryId = asString(item.delivery_id);
    if (deliveryId.length === 0) return;
    const attempt = typeof item.attempt === 'number' ? item.attempt : null;
    if (asString(item.source) === 'delivery.retried') {
      this.claimSkipped.delete(deliveryId);
      this.delivered.delete(deliveryId);
    }
    const attemptKey = attempt ?? 0;
    if (this.claimSkipped.get(deliveryId) === attemptKey) return;
    const previous = this.delivered.get(deliveryId);
    if (previous !== undefined && (attempt === null || attempt <= previous)) return;
    const current = this.outstanding.get(deliveryId);
    if (current === undefined || attempt === null || asNumber(current.attempt, -1) <= attempt) {
      this.outstanding.set(deliveryId, item);
    }
  }

  private async handleHostNotification(method: string, params: JsonObject): Promise<void> {
    if (method === 'item/completed' && this.activeTurn) {
      if (asString(params.turnId) === this.activeTurn.turnId) {
        const item = asRecord(params.item);
        const phase = item.phase;
        if (
          asString(item.type) === 'agentMessage' &&
          (phase === undefined || phase === null || phase === 'final_answer')
        ) {
          this.finalMessage = asString(item.text);
        }
      }
    }

    if (method !== 'turn/completed') return;
    const turn = asRecord(params.turn);
    if (
      this.activeTurn &&
      asString(turn.id) === this.activeTurn.turnId &&
      asString(params.threadId) === this.threadId
    ) {
      await this.finalizeTurn(turn);
    }
    if (asString(params.threadId) === this.threadId && this.outstanding.size > 0) {
      setTimeout(() => this.events.push({ kind: 'retry' }), RETRY_DELAY_MS);
    }
  }

  private async finalizeTurn(turn: JsonObject): Promise<void> {
    const active = this.activeTurn;
    if (!active) return;
    await this.cancelAck();
    const finalMessage = this.finalMessage;
    try {
      if (asString(turn.status) === 'completed' && finalMessage !== null && finalMessage.length > 0) {
        const outcome = await this.rpc.callTool('network_delivery_complete', {
          request_id: newRequestId('complete'),
          client_message_id: newRequestId('msg'),
          ...claimPayload(active.claim),
          final_body: finalMessage,
        });
        if (!outcome.ok) throw new Error(outcome.code);
        this.log(`DELIVERY_COMPLETED delivery=${active.deliveryId}`);
      } else {
        const outcome = await this.rpc.callTool('network_delivery_fail', {
          request_id: newRequestId('fail'),
          ...claimPayload(active.claim),
          error: 'Codex 未能产出完整最终答复',
        });
        if (!outcome.ok) throw new Error(outcome.code);
        this.log(`DELIVERY_FAILED delivery=${active.deliveryId}`);
      }
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.log(
        `ERROR delivery_finalize_failed delivery=${active.deliveryId}; manual reconciliation required`,
      );
    }
    this.activeTurn = null;
    this.finalMessage = null;
  }

  private async wakeReminder(item: JsonObject): Promise<void> {
    const deliveryId = asString(item.delivery_id);
    const key = `${asString(item.event_id)}|${asString(item.attempt)}|${asString(item.progress_at)}`;
    if (this.remindersSeen.get(deliveryId) === key) return;
    this.remindersSeen.set(deliveryId, key);
    try {
      const status = await this.threadStatus();
      if (status === 'active') {
        const current = await this.currentTurn();
        if (asString(current.status) !== 'inProgress') return;
        await this.requireConnection().call('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: asString(current.id),
          input: [{ type: 'text', text: reminderPrompt(item) }],
        });
        this.log(`REMINDER_STEERED delivery=${deliveryId}`);
        return;
      }
      if (status === 'idle') {
        await this.requireConnection().call('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text: reminderPrompt(item) }],
        });
        this.log(`REMINDER_STARTED delivery=${deliveryId}`);
      }
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      this.log(`ERROR reminder_wake_failed delivery=${deliveryId}`);
    }
  }

  private async threadStatus(): Promise<string> {
    const result = await this.requireConnection().call('thread/read', { threadId: this.threadId });
    return asString(asRecord(asRecord(result.thread).status).type);
  }

  private async currentTurn(): Promise<JsonObject> {
    const result = await this.requireConnection().call('thread/turns/list', {
      threadId: this.threadId,
      limit: 1,
    });
    return asRecord(asArray(result.data).map(asRecord)[0] ?? {});
  }

  /**
   * 与旧脚本一致的单线程处理：同一时刻只处理一个 candidate。
   * 状态既非 idle/active、或当前回合尚未 inProgress 时直接返回，
   * 由下一条宿主事件或 turn/completed 的延迟 retry 再次触发。
   */
  private async pump(): Promise<void> {
    while (this.outstanding.size > 0 && !this.signal.aborted) {
      const status = await this.threadStatus();
      if (status !== 'idle' && status !== 'active') return;

      const candidate = this.nextAlert(status === 'active');
      if (candidate === null) return;
      const [deliveryId, alert] = candidate;

      let pending;
      try {
        pending = await this.rpc.callTool('network_inbox_list', { state: 'pending', limit: 50 });
      } catch (error) {
        if (error instanceof MonitorFatalError) throw error;
        throw new WatchStop('inbox_unavailable; restart watcher to reconcile');
      }
      if (!pending.ok) throw new WatchStop('inbox_unavailable; restart watcher to reconcile');

      let match = asArray(pending.data.items)
        .map(asRecord)
        .find((item) => asString(item.delivery_id) === deliveryId);
      if (!match && this.steered.has(deliveryId)) {
        // 已插话的投递在 claim 后不再出现在 pending；当前回合结束后从自己的 claimed 列表接手。
        let claimed;
        try {
          claimed = await this.rpc.callTool('network_inbox_list', { state: 'claimed', limit: 50 });
        } catch (error) {
          if (error instanceof MonitorFatalError) throw error;
          throw new WatchStop('claimed_inbox_unavailable; restart watcher to reconcile');
        }
        if (!claimed.ok) {
          throw new WatchStop('claimed_inbox_unavailable; restart watcher to reconcile');
        }
        match = asArray(claimed.data.items)
          .map(asRecord)
          .find((item) => asString(item.delivery_id) === deliveryId);
      }

      const alertAttempt = typeof alert.attempt === 'number' ? alert.attempt : null;
      if (
        !match ||
        asString(asRecord(match.message).sender_id) === this.actorId ||
        (alertAttempt !== null && match.attempt !== alertAttempt)
      ) {
        this.outstanding.delete(deliveryId);
        if (this.outstanding.size > 0) this.events.push({ kind: 'retry' });
        continue;
      }

      if (status === 'active') {
        const current = await this.currentTurn();
        if (asString(current.status) !== 'inProgress') return;
        const outcome = await this.claimFor(deliveryId, match);
        if (outcome === 'stop') return;
        if (outcome === 'next') continue;
        const claim = outcome.claim;

        const body = await this.readForActive(claim, deliveryId, match);
        if (body === null) continue;
        const steeredItem: JsonObject = {
          ...match,
          attempt: claim.attempt,
          state: 'claimed',
          claim_id: claim.claimId,
          claimed_at: claim.claimedAt,
        };
        try {
          await this.requireConnection().call('turn/steer', {
            threadId: this.threadId,
            expectedTurnId: asString(current.id),
            input: [{ type: 'text', text: steerPrompt(body) }],
          });
        } catch (error) {
          this.notified.set(deliveryId, claim.attempt);
          this.outstanding.set(deliveryId, steeredItem);
          this.steered.set(deliveryId, steeredItem);
          const rpcError = error instanceof CodexCallError && error.rpcError;
          this.log(
            `${rpcError ? 'STEER_DEFERRED' : 'ERROR steer_failed'} delivery=${deliveryId} ` +
              'claim_state=claimed hint=process_after_current_turn',
          );
          if (rpcError) {
            const latest = await this.threadStatus();
            if (latest === 'idle') this.events.push({ kind: 'retry' });
          }
          continue;
        }
        this.notified.set(deliveryId, claim.attempt);
        this.outstanding.set(deliveryId, steeredItem);
        this.steered.set(deliveryId, steeredItem);
        this.log(
          `STEERED delivery=${deliveryId} turn=${asString(current.id)} claim_id=${claim.claimId}`,
        );
        if (this.nextAlert(true) !== null) this.events.push({ kind: 'retry' });
        continue;
      }

      if (this.activeTurn) return;
      const outcome = await this.claimFor(deliveryId, match);
      if (outcome === 'stop') return;
      if (outcome === 'next') continue;
      const claim = outcome.claim;

      let body: string;
      try {
        body = await this.readMessage(asString(match.message_id));
      } catch (error) {
        if (error instanceof MonitorFatalError) throw error;
        await this.failDelivery(claim, '读取消息失败');
        this.log(`ERROR claim_or_read_failed delivery=${deliveryId}`);
        this.outstanding.delete(deliveryId);
        if (this.outstanding.size > 0) this.events.push({ kind: 'retry' });
        continue;
      }

      let result;
      try {
        result = await this.requireConnection().call('turn/start', {
          threadId: this.threadId,
          input: [{ type: 'text', text: taskPrompt(deliveryId, claim, body) }],
        });
      } catch (error) {
        if (error instanceof MonitorFatalError) throw error;
        await this.failDelivery(claim, 'Codex 无法启动任务');
        this.log(
          `ERROR turn_start_failed delivery=${deliveryId} (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
        this.outstanding.delete(deliveryId);
        continue;
      }
      const turnId = asString(asRecord(result.turn).id);
      if (turnId.length === 0) {
        await this.failDelivery(claim, 'Codex 无法启动任务');
        this.log(`ERROR turn_start_failed delivery=${deliveryId} (missing_turn_id)`);
        this.outstanding.delete(deliveryId);
        continue;
      }
      this.activeTurn = { deliveryId, turnId, claim };
      this.scheduleAck(claim, asString(match.room_id));
      this.outstanding.delete(deliveryId);
      this.steered.delete(deliveryId);
      this.delivered.set(deliveryId, claim.attempt);
      this.log(`TURN_STARTED delivery=${deliveryId} turn=${turnId}`);
    }
  }

  private nextAlert(active: boolean): [string, JsonObject] | null {
    for (const [deliveryId, alert] of this.outstanding) {
      const attempt = typeof alert.attempt === 'number' ? alert.attempt : null;
      if (
        !active ||
        !this.notified.has(deliveryId) ||
        (attempt !== null && this.notified.get(deliveryId) !== attempt)
      ) {
        return [deliveryId, alert];
      }
    }
    return null;
  }

  /** claim + 分类；返回 'next' 时调用方继续下一个 candidate。 */
  private async claimFor(
    deliveryId: string,
    match: JsonObject,
  ): Promise<{ claim: ClaimInfo } | 'next' | 'stop'> {
    let outcome;
    try {
      outcome = await claimDelivery(this.rpc, deliveryId);
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      outcome = null;
    }
    if (outcome === null) {
      this.log(`ERROR claim_failed delivery=${deliveryId}`);
      this.outstanding.delete(deliveryId);
      if (this.outstanding.size > 0) this.events.push({ kind: 'retry' });
      return 'stop';
    }
    if (!outcome.ok) {
      const attempt = asNumber(match.attempt, 0);
      if (outcome.failure.kind === 'deferred') {
        this.log(
          `DELIVERY_DEFERRED delivery=${deliveryId} ` +
            `claimed_delivery=${outcome.failure.claimedDeliveryId ?? ''} ` +
            'hint=complete_or_fail_current_claim_first_then_claim_or_reconnect',
        );
      } else if (outcome.failure.kind === 'conflict') {
        this.claimSkipped.set(deliveryId, attempt);
        this.log(`DELIVERY_CONFLICT delivery=${deliveryId} hint=skip_do_not_process`);
      } else {
        this.claimSkipped.set(deliveryId, attempt);
        this.log(`DELIVERY_CLAIM_FAILED delivery=${deliveryId} code=${outcome.failure.code}`);
      }
      this.outstanding.delete(deliveryId);
      if (this.outstanding.size > 0) this.events.push({ kind: 'retry' });
      return 'next';
    }

    this.claimSkipped.delete(deliveryId);
    this.log(
      `DELIVERY_CLAIMED delivery=${deliveryId} attempt=${outcome.claim.attempt} ` +
        `claim_id=${outcome.claim.claimId} claimed_at=${outcome.claim.claimedAt} auto_claimed=true`,
    );
    return { claim: outcome.claim };
  }

  private async readForActive(
    claim: ClaimInfo,
    deliveryId: string,
    match: JsonObject,
  ): Promise<string | null> {
    try {
      return await this.readMessage(asString(match.message_id));
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      const failed = await this.failDelivery(claim, '读取消息失败');
      if (!failed) {
        this.log(`ERROR steer_read_failed delivery=${deliveryId}; manual reconciliation required`);
      }
      this.outstanding.delete(deliveryId);
      if (this.outstanding.size > 0) this.events.push({ kind: 'retry' });
      return null;
    }
  }

  private async readMessage(messageId: string): Promise<string> {
    const chunks: string[] = [];
    let cursor = '';
    for (let index = 0; index < 10_000; index += 1) {
      const args: JsonObject = { message_id: messageId };
      if (cursor.length > 0) args.chunk_cursor = cursor;
      const outcome = await this.rpc.callTool('network_message_read', args);
      if (!outcome.ok) throw new Error(outcome.code);
      const chunk = outcome.data.chunk;
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'string') {
        throw new Error('chunk_decode_failed');
      }
      chunks.push(typeof chunk === 'string' ? chunk : '');
      if (outcome.data.eof === true) return chunks.join('');
      const next = asString(outcome.data.next_cursor);
      if (next.length === 0) return chunks.join('');
      if (next === cursor) throw new Error('invalid_chunk_cursor');
      cursor = next;
    }
    throw new Error('invalid_chunk_cursor');
  }

  private async failDelivery(claim: ClaimInfo, reason: string): Promise<boolean> {
    try {
      const outcome = await this.rpc.callTool('network_delivery_fail', {
        request_id: newRequestId('fail'),
        ...claimPayload(claim),
        error: reason,
      });
      return outcome.ok;
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      return false;
    }
  }

  private scheduleAck(claim: ClaimInfo, roomId: string): void {
    this.clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      this.ackInflight = this.sendAck(claim, roomId);
    }, SLOW_ACK_MS);
  }

  private clearAckTimer(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  private async cancelAck(): Promise<void> {
    this.clearAckTimer();
    const inflight = this.ackInflight;
    this.ackInflight = null;
    if (inflight) await inflight;
  }

  private async sendAck(claim: ClaimInfo, roomId: string): Promise<void> {
    try {
      const outcome = await this.rpc.callTool('network_message_send', {
        request_id: newRequestId('ack'),
        client_message_id: newRequestId('msg'),
        room_id: roomId,
        body: ACK_BODY,
        invoke: [],
        claim: claimPayload(claim),
      });
      if (!outcome.ok) throw new Error(outcome.code);
      this.log(`ACK_SENT delivery=${claim.deliveryId}`);
    } catch (error) {
      if (error instanceof MonitorFatalError) return;
      this.log(`ERROR ack_failed delivery=${claim.deliveryId}`);
    }
  }
}

function lastLine(error: unknown): string {
  if (error instanceof CliError) return 'invalid_agentnet_url';
  return error instanceof Error ? error.message : String(error);
}

export async function runCodexMonitor(context: MonitorContext): Promise<number> {
  const token = context.token;
  if (!token) return fail('ERROR type=credential message=missing_token');
  if (/[\r\n]/u.test(token)) return fail('ERROR type=credential message=invalid_token_format');
  if (context.baseUrl === null) return fail('ERROR type=configuration message=missing_agentnet_url');

  let endpoint: string;
  try {
    endpoint = resolveConfig({ url: context.baseUrl, token, json: false }).endpoint;
  } catch (error) {
    return fail(`ERROR type=configuration message=${lastLine(error)}`);
  }

  let lock: WatcherLock;
  try {
    lock = acquireWatcherLock(token);
  } catch (error) {
    return fail(`ERROR codex_watch=${lastLine(error)}`);
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try {
    const watcher = new CodexWatcher({ endpoint, token, signal: controller.signal });
    return await watcher.run();
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    lock.release();
  }
}
