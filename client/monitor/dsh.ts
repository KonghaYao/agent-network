/**
 * `agentnet monitor --harness dsh`：dsh-watch.sh 的 TypeScript 等价实现。
 *
 * 对外契约（与 public/skills/dsh-watch.sh 一致）：
 * - `run` 前台运行，stdout 不写事件；start 把 run 重定向到 watch.log 后台运行；
 * - `start/stop/status/logs/wait` 只读写 WEBBOTS_HOME（默认 ~/.webbots）；
 * - 事件只写 wake.queue 的九个定位字段，不读正文、不 claim、不写 token；
 * - `action_required` 与直聊普通 `room.message` 入队，群聊普通消息丢弃；
 * - `pending_count > 0` 时补 catchup，同一 pending/head 快照 30 秒内不重复；
 * - `CREDENTIAL_INVALID` 立即退出 3，`NOT_AGENT` 退出 4，`PROTOCOL` 退出 5。
 *
 * 订阅、退避与 seen 复用共享 monitor 组件；监听循环本身刻意不 claim，
 * 收到 delivery_id 的 Agent 仍需自行调用 network_delivery_claim。
 */

import { closeSync, openSync } from 'node:fs';
import { open, rm, stat, writeFile } from 'node:fs/promises';

import { CliError, resolveConfig } from '../mcp';
import { asArray, asRecord } from '../output';
import { abortableSleep, reconnectDelay } from './engine';
import {
  MonitorFatalError,
  MonitorRpc,
  subscribe,
  type JsonObject,
  type SubscriptionControl,
} from './rpc';
import {
  booleanValue,
  countLines,
  dshPaths,
  ensureHome,
  initialStatus,
  nowIso,
  nullable,
  numericValue,
  parseCount,
  pickText,
  pidRunning,
  readCursor,
  readPid,
  readStatusFile,
  readText,
  scalarText,
  tailLog,
  writeCursor,
  writeStatusFile,
  type DshPaths,
  type DshStatus,
} from './dsh-state';
import { MonitorState } from './state';

export interface MonitorContext {
  baseUrl: string | null;
  token: string | null;
}

const STREAM_URI = 'agentnet://stream';
const ACK_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 15_000;
const CLAIMED_RESET_MS = 30_000;
const CATCHUP_WINDOW_SECONDS = 30;
const CLIENT_NAME = 'dsh-watch';
const CLIENT_VERSION = '1.0.0';
const DEFAULT_LOG_LINES = 50;
const FOLLOW_POLL_MS = 200;
const WAIT_POLL_MS = 1000;

function writeStderr(text: string): void {
  process.stderr.write(`${text}\n`);
}

function usage(): void {
  writeStderr(`usage: agentnet monitor --harness dsh [run|start|stop|status|logs|wait] [args]

  run            前台运行 SSE 守护（默认）
  start          后台运行；PID 写入 $WEBBOTS_HOME/watch.pid
  stop           停止后台守护
  status         输出一行 JSON；运行中退出 0，未运行退出 3
  logs [lines]   tail -f $WEBBOTS_HOME/watch.log（默认 ${DEFAULT_LOG_LINES} 行）
  wait [seconds] 从当前 EOF 等待新的 wake.queue 行并打印；超时退出 124

环境变量：AGENTNET_TOKEN（run/start 必需）、AGENTNET_URL、WEBBOTS_HOME`);
}

function newSubscriptionId(generation: number): string {
  return `sub-${Math.floor(Date.now() / 1000)}-${process.pid}-${generation}-${Math.floor(
    Math.random() * 1_000_000,
  )}`;
}

function installSignals(controller: AbortController): () => void {
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  return () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
  };
}

/** 校验 run/start 的凭据与地址；成功返回 endpoint。 */
function resolveEndpoint(context: MonitorContext): { endpoint: string } | { line: string; code: number } {
  if (context.token === null || context.token.length === 0) {
    return { line: 'ERROR type=credential message=AGENTNET_TOKEN_required', code: 2 };
  }
  if (/[\r\n]/u.test(context.token)) {
    return { line: 'ERROR type=credential message=invalid_token_format', code: 2 };
  }
  if (context.baseUrl === null) {
    return { line: 'ERROR type=configuration message=invalid_agentnet_url', code: 2 };
  }
  try {
    const config = resolveConfig({ url: context.baseUrl, token: context.token, json: false });
    return { endpoint: config.endpoint };
  } catch (error) {
    if (error instanceof CliError) {
      return { line: 'ERROR type=configuration message=invalid_agentnet_url', code: 2 };
    }
    throw error;
  }
}

interface WakeLine {
  key: string;
  line: string;
}

/**
 * wake.queue 的固定九字段。缺失定位字段写 null，seq/event_id 保持字符串；
 * 去重键仍是 source:event_id:delivery_id（与旧脚本一致）。
 */
function buildWakeLine(item: JsonObject): WakeLine {
  const source = scalarText(item.source);
  const attention = pickText(item.attention, 'informational');
  const roomId = scalarText(item.room_id);
  const messageId = scalarText(item.message_id);
  const deliveryId = scalarText(item.delivery_id);
  const senderId = scalarText(item.sender_id);
  const seq = scalarText(item.seq);
  const explicitEventId = scalarText(item.event_id);
  const eventId =
    explicitEventId.length > 0
      ? explicitEventId
      : `${source}:${seq}:${deliveryId}:${messageId}`;

  return {
    key: `${source}:${eventId}:${deliveryId}`,
    line: JSON.stringify({
      source,
      attention,
      room_id: nullable(roomId),
      message_id: nullable(messageId),
      delivery_id: nullable(deliveryId),
      sender_id: nullable(senderId),
      seq,
      event_id: eventId,
      at: nowIso(),
    }),
  };
}

class DshWatcher {
  private readonly paths: DshPaths;
  private readonly token: string;
  private readonly signal: AbortSignal;
  private readonly diagnostics: (line: string) => void;
  private readonly rpc: MonitorRpc;
  private readonly roomKinds = new Map<string, string>();

  private status = initialStatus(process.pid);
  private seen: MonitorState | null = null;
  private myId = '';
  private myIdFromMe = '';
  private inboxHeadSeq = '';
  private readyEmitted = false;
  private lastDisconnectReason = 'connection_closed';
  private reconnectAttempt = 0;
  private failStartedAt = 0;
  private degraded = false;
  private generation = 0;
  private ackedAt = 0;
  private catchupLastKey = '';
  private catchupLastAt = 0;
  private notAgent = false;

  constructor(options: {
    paths: DshPaths;
    endpoint: string;
    token: string;
    signal: AbortSignal;
    diagnostics?: (line: string) => void;
  }) {
    this.paths = options.paths;
    this.token = options.token;
    this.signal = options.signal;
    this.diagnostics = options.diagnostics ?? writeStderr;
    this.rpc = new MonitorRpc({
      endpoint: options.endpoint,
      token: options.token,
      signal: options.signal,
      clientName: CLIENT_NAME,
      clientVersion: CLIENT_VERSION,
    });
  }

  async run(): Promise<number> {
    const existing = await readPid(this.paths);
    if (existing !== null && existing !== process.pid) {
      this.diagnostics(`ERROR type=daemon message=already_running pid=${existing}`);
      return 1;
    }
    try {
      await writeFile(this.paths.pid, `${process.pid}\n`, { mode: 0o600 });
    } catch {
      this.diagnostics('ERROR type=environment message=pid_file_failed');
      return 1;
    }

    this.status = initialStatus(process.pid);
    await writeStatusFile(this.paths, this.status);

    try {
      this.seen = await MonitorState.create({ tempPrefix: 'dsh-watch.' });
    } catch {
      this.diagnostics('ERROR type=environment message=workdir_failed');
      await this.removeOwnPid();
      return 1;
    }

    try {
      return await this.main();
    } finally {
      await this.removeOwnPid();
      await this.seen.cleanup();
    }
  }

  private async main(): Promise<number> {
    try {
      await this.rpc.discover();
    } catch (error) {
      if (this.signal.aborted) return this.finishStopped();
      if (error instanceof MonitorFatalError) {
        return error.kind === 'credential' ? this.fatalCredential() : this.fatalProtocol();
      }
      return this.fatalProtocol();
    }

    let me;
    try {
      me = await this.rpc.callTool('network_me', {});
    } catch (error) {
      if (this.signal.aborted) return this.finishStopped();
      if (error instanceof MonitorFatalError) {
        return error.kind === 'credential' ? this.fatalCredential() : this.fatalProtocol();
      }
      this.diagnostics('ERROR type=identity message=network_me_failed');
      return 5;
    }
    if (!me.ok) {
      this.diagnostics('ERROR type=identity message=network_me_failed');
      return 5;
    }
    this.myId = scalarText(me.data.actor_id);
    this.myIdFromMe = this.myId;
    if (this.myId.length === 0) {
      this.diagnostics('ERROR type=identity message=actor_id_missing');
      return 5;
    }
    if (scalarText(me.data.kind) !== 'agent') return this.fatalNotAgent();

    return this.listenLoop();
  }

  private async listenLoop(): Promise<number> {
    while (!this.signal.aborted) {
      this.generation += 1;
      const subscriptionId = newSubscriptionId(this.generation);
      this.status.connected = false;
      this.status.acked = false;
      this.status.online = false;
      await this.writeStatus();
      this.status.connected = true;
      await this.writeStatus();

      let outcome;
      try {
        outcome = await subscribe(this.rpc, {
          subscriptionId,
          uri: STREAM_URI,
          ackTimeoutMs: ACK_TIMEOUT_MS,
          idleTimeoutMs: IDLE_TIMEOUT_MS,
          signal: this.signal,
          onAck: (control) => this.handleAck(control, subscriptionId),
          onFrame: (frame) => this.handleNotification(frame),
        });
      } catch (error) {
        if (this.signal.aborted) return this.finishStopped();
        if (error instanceof MonitorFatalError) {
          return error.kind === 'credential' ? this.fatalCredential() : this.fatalProtocol();
        }
        this.diagnostics('ERROR type=internal message=monitor_failed');
        return 1;
      }

      if (this.signal.aborted) return this.finishStopped();
      if (this.notAgent) return this.fatalNotAgent();
      this.lastDisconnectReason = outcome.reason;

      this.status.connected = false;
      this.status.acked = false;
      this.status.online = false;
      await this.writeStatus();

      const now = Date.now();
      if (this.ackedAt > 0 && now - this.ackedAt >= CLAIMED_RESET_MS) {
        this.reconnectAttempt = 0;
        this.failStartedAt = 0;
        this.degraded = false;
      }
      this.reconnectAttempt += 1;
      this.status.reconnects += 1;
      if (this.failStartedAt === 0) this.failStartedAt = now;
      const delay = reconnectDelay(this.reconnectAttempt);
      this.diagnostics(
        `RECONNECTING reason=${outcome.reason} status=${outcome.status} attempt=${this.reconnectAttempt} delay=${delay}`,
      );
      if (
        !this.degraded &&
        (this.reconnectAttempt >= 5 || now - this.failStartedAt >= 60_000)
      ) {
        this.diagnostics(`DEGRADED attempts=${this.reconnectAttempt} last_reason=${outcome.reason}`);
        this.degraded = true;
      }
      await this.writeStatus();
      await abortableSleep(delay * 1000, this.signal);
    }
    return this.finishStopped();
  }

  /** ack 后登录；失败只结束当前连接，交给退避重连。 */
  private async handleAck(control: SubscriptionControl, subscriptionId: string): Promise<void> {
    this.status.state = 'running';
    this.status.acked = true;
    this.status.connected = true;
    this.ackedAt = Date.now();
    await this.writeStatus();

    let login;
    try {
      login = await this.rpc.callTool('network_login', {});
    } catch (error) {
      if (this.signal.aborted) return;
      if (error instanceof MonitorFatalError) throw error;
      this.diagnostics('ERROR type=login message=network_login_failed');
      await this.loginFailed(control);
      return;
    }
    if (this.signal.aborted) return;
    if (!login.ok) {
      if (login.code === 'INVALID_ARGUMENT') {
        this.notAgent = true;
        control.abort('not_agent');
        return;
      }
      this.diagnostics('ERROR type=login message=network_login_failed');
      await this.loginFailed(control);
      return;
    }

    this.myId = scalarText(login.data.actor_id) || this.myIdFromMe;
    this.status.pending_count = numericValue(login.data.pending_count, 0);
    this.inboxHeadSeq = scalarText(login.data.inbox_head_seq);
    this.status.online = true;
    await this.writeStatus();

    if (!this.readyEmitted) {
      this.diagnostics(
        `READY actor=${this.myId || 'unknown'} pending=${this.status.pending_count} subscription=${subscriptionId}`,
      );
      this.readyEmitted = true;
    } else {
      this.diagnostics(
        `READY actor=${this.myId || 'unknown'} pending=${this.status.pending_count} subscription=${subscriptionId} reconnect=1 reason=${this.lastDisconnectReason}`,
      );
    }
    this.degraded = false;
    await this.emitCatchup('login');
  }

  private async loginFailed(control: SubscriptionControl): Promise<void> {
    this.status.acked = false;
    this.status.online = false;
    await this.writeStatus();
    control.abort('login_failed');
  }

  private async handleNotification(frame: JsonObject): Promise<void> {
    const params = asRecord(frame.params);
    const envelope = asRecord(asRecord(params._meta)['io.agent-network/event']);
    if (Object.keys(envelope).length === 0) return;
    this.status.lastNotificationAt = nowIso();

    for (const item of asArray(envelope.items).map(asRecord)) {
      const source = scalarText(item.source);
      if (source === 'session.login' || source === 'delivery.updated') continue;
      if (scalarText(item.sender_id) === this.myId) continue;

      const attention = pickText(item.attention, 'informational');
      if (attention !== 'action_required' && source !== 'room.message') continue;

      if (attention !== 'action_required') {
        // 只有直聊的普通消息入队；群聊普通消息不是任务。
        const roomId = scalarText(item.room_id);
        if (roomId.length === 0) continue;
        const kind = await this.roomKind(roomId);
        if (kind !== 'direct') {
          // 查询失败同样按“不唤醒”处理，避免把群聊噪声当任务。
          this.diagnostics(`DROP type=group_message room=${roomId}`);
          continue;
        }
      }

      await this.emitWake(item);
    }

    if (booleanValue(envelope.more) || numericValue(envelope.dropped, 0) > 0) {
      await this.emitCatchup('frame_truncated');
    }
    await this.writeStatus();
  }

  /** 每个房间只查一次 network_room_get；查询失败返回 unknown，由调用方丢弃。 */
  private async roomKind(roomId: string): Promise<string> {
    const cached = this.roomKinds.get(roomId);
    if (cached !== undefined) return cached;

    let outcome;
    try {
      outcome = await this.rpc.callTool('network_room_get', { room_id: roomId });
    } catch (error) {
      if (error instanceof MonitorFatalError) throw error;
      return 'unknown';
    }
    if (!outcome.ok) return 'unknown';

    const kind = scalarText(asRecord(outcome.data.room).kind);
    if (kind === 'direct' || kind === 'group') {
      this.roomKinds.set(roomId, kind);
      return kind;
    }
    return 'unknown';
  }

  private async emitWake(item: JsonObject): Promise<void> {
    const { key, line } = buildWakeLine(item);
    if (this.seen?.hasSeen(key) === true) return;
    if (await this.appendEvent(line)) await this.seen?.markSeen(key);
  }

  /**
   * pending_count > 0 时补一条 catchup，逼 Agent 用 network_inbox_list 对账。
   * 同一 pending/head 快照 30 秒内只写一次，reason 只影响事件内容。
   */
  private async emitCatchup(reason: string): Promise<void> {
    const pending = this.status.pending_count;
    if (!Number.isInteger(pending) || pending <= 0) return;

    const head = this.inboxHeadSeq;
    const key = `${pending}:${head}`;
    const now = Math.floor(Date.now() / 1000);
    if (key === this.catchupLastKey && now - this.catchupLastAt < CATCHUP_WINDOW_SECONDS) {
      return;
    }

    const line = JSON.stringify({
      source: 'catchup',
      attention: 'action_required',
      room_id: null,
      message_id: null,
      delivery_id: null,
      sender_id: null,
      seq: head,
      event_id: `catchup:${reason}:${pending}:${head}`,
      at: nowIso(),
    });
    if (!(await this.appendEvent(line))) return;
    this.catchupLastKey = key;
    this.catchupLastAt = now;
  }

  private async appendEvent(line: string): Promise<boolean> {
    if (this.token.length > 0 && line.includes(this.token)) {
      this.diagnostics('ERROR type=queue message=refused_token_leak');
      return false;
    }
    try {
      await writeFile(this.paths.queue, `${line}\n`, { flag: 'a', mode: 0o600 });
    } catch {
      this.diagnostics('ERROR type=queue message=append_failed');
      return false;
    }
    this.status.lastEventAt = nowIso();
    await this.writeStatus();
    return true;
  }

  private async writeStatus(): Promise<void> {
    await writeStatusFile(this.paths, this.status);
  }

  private async finishStopped(): Promise<number> {
    this.status.state = 'stopped';
    this.status.connected = false;
    this.status.acked = false;
    this.status.online = false;
    await this.writeStatus();
    this.diagnostics(`STOPPED actor=${this.myId || 'unknown'}`);
    return 0;
  }

  private async fatal(
    code: number,
    lastError: string,
    alert: string,
  ): Promise<number> {
    this.status.state = 'fatal';
    this.status.connected = false;
    this.status.acked = false;
    this.status.online = false;
    this.status.lastError = lastError;
    await this.writeStatus();
    this.diagnostics(alert);
    return code;
  }

  private fatalCredential(): Promise<number> {
    return this.fatal(
      3,
      'CREDENTIAL_INVALID',
      'ALERT type=credential code=CREDENTIAL_INVALID retryable=false action=replace_token',
    );
  }

  private fatalNotAgent(): Promise<number> {
    return this.fatal(
      4,
      'NOT_AGENT',
      'ALERT type=identity code=NOT_AGENT retryable=false action=use_agent_token',
    );
  }

  private fatalProtocol(): Promise<number> {
    return this.fatal(
      5,
      'PROTOCOL',
      'ALERT type=protocol code=PROTOCOL retryable=false action=check_endpoint',
    );
  }

  private async removeOwnPid(): Promise<void> {
    try {
      const raw = (await readText(this.paths.pid)).trim();
      if (raw === String(process.pid)) await rm(this.paths.pid, { force: true });
    } catch {
      // PID 文件已被 stop 或从未写入。
    }
  }
}

async function runWatcher(context: MonitorContext): Promise<number> {
  const resolved = resolveEndpoint(context);
  if ('line' in resolved) {
    writeStderr(resolved.line);
    return resolved.code;
  }
  const token = context.token as string;

  const paths = dshPaths();
  const homeError = await ensureHome(paths);
  if (homeError !== null) {
    writeStderr(`ERROR type=environment message=${homeError}`);
    return 1;
  }

  const controller = new AbortController();
  const restoreSignals = installSignals(controller);
  try {
    const watcher = new DshWatcher({
      paths,
      endpoint: resolved.endpoint,
      token,
      signal: controller.signal,
    });
    return await watcher.run();
  } finally {
    restoreSignals();
  }
}

function selfCommand(): string[] {
  const entry = process.argv[1];
  if (entry && /\.[cm]?[jt]sx?$/u.test(entry)) return [process.execPath, entry];
  return [process.execPath];
}

async function startDaemon(context: MonitorContext): Promise<number> {
  const resolved = resolveEndpoint(context);
  if ('line' in resolved) {
    writeStderr(resolved.line);
    return resolved.code;
  }
  const token = context.token as string;
  const paths = dshPaths();
  const homeError = await ensureHome(paths);
  if (homeError !== null) {
    writeStderr(`ERROR type=environment message=${homeError}`);
    return 1;
  }

  const existing = await readPid(paths);
  if (existing !== null) {
    writeStderr(`ERROR type=daemon message=already_running pid=${existing}`);
    return 1;
  }
  await rm(paths.pid, { force: true }).catch(() => undefined);

  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENTNET_URL: context.baseUrl ?? process.env.AGENTNET_URL,
    AGENTNET_TOKEN: token,
    WEBBOTS_HOME: paths.home,
  };
  let child;
  let fd = -1;
  try {
    fd = openSync(paths.log, 'a', 0o600);
    child = Bun.spawn({
      cmd: [...selfCommand(), 'monitor', '--harness', 'dsh', 'run'],
      env,
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
      detached: true,
    });
  } catch {
    if (fd >= 0) closeSync(fd);
    writeStderr('ERROR type=daemon message=start_failed');
    return 1;
  }
  if (fd >= 0) closeSync(fd);
  child.unref();

  try {
    await writeFile(paths.pid, `${child.pid}\n`, { mode: 0o600 });
  } catch {
    // 子进程 run 自己也会写 PID；这里只为让 start 立即可见。
  }

  await Bun.sleep(1000);
  if (pidRunning(child.pid)) {
    process.stdout.write(`STARTED pid=${child.pid} home=${paths.home}\n`);
    return 0;
  }

  writeStderr('ERROR type=daemon message=start_failed');
  for (const line of await tailLog(paths.log, 20)) writeStderr(line);
  await rm(paths.pid, { force: true }).catch(() => undefined);
  return 1;
}

async function stopDaemon(): Promise<number> {
  const paths = dshPaths();
  const pid = await readPid(paths);
  if (pid === null) {
    await rm(paths.pid, { force: true }).catch(() => undefined);
    process.stdout.write(`NOT_RUNNING home=${paths.home}\n`);
    return 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 进程可能刚好退出；下面按实际存活状态收尾。
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!pidRunning(pid)) break;
    await Bun.sleep(100);
  }
  if (pidRunning(pid)) {
    writeStderr(`WARN type=daemon message=force_kill pid=${pid}`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出。
    }
    await Bun.sleep(200);
  }
  await rm(paths.pid, { force: true }).catch(() => undefined);
  if (pidRunning(pid)) {
    writeStderr(`ERROR type=daemon message=stop_failed pid=${pid}`);
    return 1;
  }
  process.stdout.write(`STOPPED pid=${pid} home=${paths.home}\n`);
  return 0;
}

async function showStatus(): Promise<number> {
  const paths = dshPaths();
  const pid = await readPid(paths);
  const running = pid !== null;
  const stored = await readStatusFile(paths);

  let state = 'stopped';
  let stale = false;
  if (Object.keys(stored).length > 0) {
    state = typeof stored.state === 'string' && stored.state.length > 0 ? stored.state : 'stopped';
    if (!running && state === 'running') {
      state = 'stopped';
      stale = true;
    }
  } else if (running) {
    state = 'starting';
  }

  const output = {
    running,
    stale,
    pid: running ? pid : null,
    state,
    home: paths.home,
    checkedAt: nowIso(),
    connected: stored.connected ?? false,
    acked: stored.acked ?? false,
    online: stored.online ?? false,
    pending_count: stored.pending_count ?? 0,
    lastEventAt: stored.lastEventAt ?? null,
    lastNotificationAt: stored.lastNotificationAt ?? null,
    lastError: stored.lastError ?? null,
    reconnects: stored.reconnects ?? 0,
    startedAt: stored.startedAt ?? null,
    updatedAt: stored.updatedAt ?? null,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return running ? 0 : 3;
}

async function followLog(path: string, lines: number, signal: AbortSignal): Promise<number> {
  const initial = await tailLog(path, lines);
  for (const line of initial) process.stdout.write(`${line}\n`);

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let position = (await stat(path).catch(() => ({ size: 0 }))).size;
  try {
    for (;;) {
      if (signal.aborted) return 0;
      const info = await stat(path).catch(() => null);
      if (info !== null) {
        if (handle === null) handle = await open(path, 'r').catch(() => null);
        if (handle !== null) {
          if (info.size < position) position = 0;
          if (info.size > position) {
            const length = info.size - position;
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            if (bytesRead > 0) {
              position += bytesRead;
              process.stdout.write(buffer.subarray(0, bytesRead));
            }
          }
        }
      }
      await Bun.sleep(FOLLOW_POLL_MS);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function runLogs(argument: string | undefined, signal: AbortSignal): Promise<number> {
  const lines = parseCount(argument, DEFAULT_LOG_LINES);
  if (lines === null) {
    writeStderr('ERROR type=configuration message=invalid_lines');
    return 2;
  }
  const paths = dshPaths();
  const homeError = await ensureHome(paths);
  if (homeError !== null) {
    writeStderr(`ERROR type=environment message=${homeError}`);
    return 1;
  }
  return followLog(paths.log, lines, signal);
}

async function runWait(argument: string | undefined, signal: AbortSignal): Promise<number> {
  const timeout = parseCount(argument, 0);
  if (timeout === null) {
    writeStderr('ERROR type=configuration message=invalid_timeout');
    return 2;
  }
  const paths = dshPaths();
  const homeError = await ensureHome(paths);
  if (homeError !== null) {
    writeStderr(`ERROR type=environment message=${homeError}`);
    return 1;
  }

  // 首次调用把当前 EOF 持久化；后续调用从该游标继续。
  const stored = await readCursor(paths);
  let cursor = stored ?? countLines(await readText(paths.queue));
  await writeCursor(paths, cursor);

  const started = Date.now();
  for (;;) {
    if (signal.aborted) return 0;
    const text = await readText(paths.queue);
    const total = countLines(text);
    // 文件被 truncate 时游标可能大于当前行数，回到 0 重读。
    if (total < cursor) cursor = 0;
    if (total > cursor) {
      const lines = text.split('\n');
      const fresh = lines.slice(cursor, total);
      if (fresh.length > 0) process.stdout.write(`${fresh.join('\n')}\n`);
      cursor = total;
      await writeCursor(paths, cursor);
      return 0;
    }
    if (timeout > 0 && Date.now() - started >= timeout * 1000) return 124;
    await Bun.sleep(WAIT_POLL_MS);
  }
}

export async function runDshMonitor(
  context: MonitorContext,
  scriptArgs: readonly string[],
): Promise<number> {
  const raw = [...scriptArgs];
  const command = raw[0] ?? 'run';
  const argument = raw[1];

  switch (command) {
    case 'run':
      return runWatcher(context);
    case 'start':
      return startDaemon(context);
    case 'stop':
      return stopDaemon();
    case 'status':
      return showStatus();
    case 'logs': {
      const controller = new AbortController();
      const restoreSignals = installSignals(controller);
      try {
        return await runLogs(argument, controller.signal);
      } finally {
        restoreSignals();
      }
    }
    case 'wait': {
      const controller = new AbortController();
      const restoreSignals = installSignals(controller);
      try {
        return await runWait(argument, controller.signal);
      } finally {
        restoreSignals();
      }
    }
    case 'help':
      usage();
      return 0;
    default:
      writeStderr(`ERROR type=configuration message=unknown_command command=${command}`);
      usage();
      return 2;
  }
}
