/**
 * Codex app-server 传输与本机 watcher 锁。
 *
 * 与旧 shell 桥接的 Python 内嵌实现对齐：
 * - `codex app-server daemon version` 返回 Unix socket 路径；
 * - JSON-RPC over WebSocket，请求按自增 id 匹配，通知进入事件队列；
 * - 30 秒调用超时，断线时所有 pending 失败并投递 `disconnected`；
 * - 同 token 只允许一个 watcher，同一 socket/thread 只允许一个 Agent。
 *
 * 测试通过 AGENTNET_CODEX_SOCKET 直接注入 socket，不执行真实二进制。
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { asRecord, asString } from '../output';
import type { JsonObject } from './rpc';
import type { ClaimInfo } from './events';

const CALL_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 10_000;

export function socketOverride(): string | null {
  const value = process.env.AGENTNET_CODEX_SOCKET;
  return value !== undefined && value.length > 0 ? value : null;
}

/** 宿主或 MCP 侧不可恢复错误，统一映射为 `ERROR codex_watch=<message>`。 */
export class WatchStop extends Error {
  constructor(readonly message: string) {
    super(message);
    this.name = 'WatchStop';
  }
}

export class CodexCallError extends Error {
  constructor(
    message: string,
    /** true 表示 app-server 返回 JSON-RPC error；false 表示传输层断开。 */
    readonly rpcError: boolean,
  ) {
    super(message);
    this.name = 'CodexCallError';
  }
}

export class LockHeldError extends Error {
  constructor() {
    super('watcher already running for this Agent token');
    this.name = 'LockHeldError';
  }
}

export class ThreadLockHeldError extends Error {
  constructor() {
    super('CODEX_THREAD_ID already bound to another Agent watcher');
    this.name = 'ThreadLockHeldError';
  }
}

export interface WatcherLock {
  release: () => void;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 单 token 锁：旧脚本用 flock；Node 没有跨平台 flock，这里改用
 * `O_EXCL` + PID 存活检查，崩溃残留会被下一次启动回收。
 */
function acquirePidLock(key: string, heldError: () => Error): WatcherLock {
  const directory = join(homedir(), '.codex', 'agentnet-watch');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `${key}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
          } catch {
            // 锁已被外部删除；没有需要清理的状态。
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = 0;
      try {
        owner = Number(readFileSync(path, 'utf8').trim());
      } catch {
        owner = 0;
      }
      if (Number.isInteger(owner) && owner > 0 && processAlive(owner)) {
        throw heldError();
      }
      try {
        unlinkSync(path);
      } catch {
        // 另一个进程可能已回收；下一轮重试 O_EXCL。
      }
    }
  }
  throw heldError();
}

export function acquireWatcherLock(token: string): WatcherLock {
  return acquirePidLock(createHash('sha256').update(token).digest('hex'), () => new LockHeldError());
}

export function acquireThreadLock(socketPath: string, threadId: string): WatcherLock {
  const key = createHash('sha256')
    .update(resolve(socketPath))
    .update('\0')
    .update(threadId)
    .digest('hex');
  return acquirePidLock(`thread-${key}`, () => new ThreadLockHeldError());
}

/** `codex app-server daemon version` 返回 { socketPath }；测试可完全绕过。 */
export function resolveSocketPath(): string {
  const override = socketOverride();
  if (override !== null) return override;
  let result;
  try {
    result = Bun.spawnSync({
      cmd: ['codex', 'app-server', 'daemon', 'version'],
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    throw new WatchStop('missing=codex');
  }
  if (result.exitCode !== 0) {
    throw new WatchStop('codex_daemon_unavailable; start `codex app-server daemon`');
  }
  let socketPath = '';
  try {
    socketPath = asString(asRecord(JSON.parse(result.stdout.toString()) as unknown).socketPath);
  } catch {
    throw new WatchStop('invalid_daemon_version');
  }
  if (socketPath.length === 0) throw new WatchStop('invalid_daemon_version');
  return socketPath;
}

export type WatcherEvent =
  | { kind: 'alert'; item: JsonObject }
  | { kind: 'reminder'; item: JsonObject }
  | { kind: 'retry' }
  | { kind: 'host'; method: string; params: JsonObject }
  | { kind: 'disconnected' }
  | { kind: 'stream_fatal'; message: string };

/** 单消费者事件队列；shift 可被 SIGINT/SIGTERM 打断。 */
export class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: T | null) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  async shift(signal: AbortSignal): Promise<T | null> {
    if (this.values.length > 0) return this.values.shift() ?? null;
    if (this.closed || signal.aborted) return null;
    return await new Promise<T | null>((resolve) => {
      const finish = (value: T | null): void => {
        signal.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(value);
      };
      const onAbort = (): void => finish(null);
      const waiter = (value: T | null): void => finish(value);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }
}

interface PendingCall {
  method: string;
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function decodeFrame(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  return String(data);
}

/**
 * app-server 的 JSON-RPC over WebSocket 客户端。
 * Bun 内置 WebSocket 支持 `ws+unix://`，不需要额外依赖或 stdio 桥。
 */
export class CodexConnection {
  private readonly pending = new Map<number, PendingCall>();
  private serial = 0;
  private closed = false;
  private disconnected = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly events: AsyncQueue<WatcherEvent>,
  ) {
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => this.onDisconnected());
    socket.addEventListener('error', () => this.onDisconnected());
  }

  static async open(
    socketPath: string,
    events: AsyncQueue<WatcherEvent>,
    signal: AbortSignal,
  ): Promise<CodexConnection> {
    if (/[#?]/u.test(socketPath)) throw new WatchStop('invalid_socket_path');
    const socket = new WebSocket(`ws+unix://${socketPath}:/`);
    const connection = new CodexConnection(socket, events);
    await connection.waitOpen(signal);
    return connection;
  }

  private waitOpen(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.socket.removeEventListener('open', onOpen);
        this.socket.removeEventListener('error', onError);
        this.socket.removeEventListener('close', onClose);
        if (error) {
          try {
            this.socket.close();
          } catch {
            // 连接从未建立；关闭只是尽力清理。
          }
          reject(error);
        } else {
          resolve();
        }
      };
      const onOpen = (): void => finish();
      const onError = (): void => finish(new WatchStop('app_server_connect_failed'));
      const onClose = (): void => finish(new WatchStop('app_server_connect_closed'));
      const onAbort = (): void => finish(new WatchStop('terminated'));
      const timer = setTimeout(
        () => finish(new WatchStop('app_server_connect_timeout')),
        OPEN_TIMEOUT_MS,
      );
      if (signal.aborted) {
        finish(new WatchStop('terminated'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.socket.addEventListener('open', onOpen);
      this.socket.addEventListener('error', onError);
      this.socket.addEventListener('close', onClose);
    });
  }

  private onMessage(raw: unknown): void {
    let message: JsonObject;
    try {
      message = asRecord(JSON.parse(decodeFrame(raw)) as unknown);
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id === 'number') {
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      clearTimeout(call.timer);
      if (message.error !== undefined) {
        const error = asRecord(message.error);
        call.reject(
          new CodexCallError(`${call.method}: ${asString(error.message, 'failed')}`, true),
        );
      } else {
        call.resolve(asRecord(message.result));
      }
      return;
    }
    const method = asString(message.method);
    if (method.length === 0) return;
    this.events.push({ kind: 'host', method, params: asRecord(message.params) });
  }

  private onDisconnected(): void {
    this.closed = true;
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      this.pending.delete(id);
      call.reject(new CodexCallError('app-server disconnected', false));
    }
    if (this.disconnected) return;
    this.disconnected = true;
    this.events.push({ kind: 'disconnected' });
  }

  async call(method: string, params: JsonObject = {}): Promise<JsonObject> {
    if (this.closed) throw new CodexCallError(`${method}: app-server disconnected`, false);
    this.serial += 1;
    const id = this.serial;
    return await new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexCallError(`${method}: request timeout`, false));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(`${method}: send failed`));
      }
    });
  }

  notify(method: string, params: JsonObject = {}): void {
    if (this.closed) return;
    this.socket.send(JSON.stringify({ method, params }));
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // 已关闭。
    }
  }
}

/** 与脚本一致的 claim 载荷；complete/fail/send 都带这四个定位字段。 */
export function claimPayload(claim: ClaimInfo): JsonObject {
  return {
    delivery_id: claim.deliveryId,
    attempt: claim.attempt,
    claim_id: claim.claimId,
    claimed_at: claim.claimedAt,
  };
}

export function newRequestId(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}
