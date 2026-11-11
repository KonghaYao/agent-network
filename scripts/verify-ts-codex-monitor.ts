/**
 * `agentnet monitor --harness codex` 验收：本地 mock MCP + mock Codex app-server。
 *
 * 覆盖：
 * - app-server 握手（initialize/initialized/thread/loaded/list/thread/resume）；
 * - 空闲投递 claim -> turn/start -> complete；
 * - 回合中投递 claim -> turn/steer；steer 失败保留 claim 并在回合结束后补处理；
 * - 单 claim 约束下的 DELIVERY_DEFERRED、10 秒慢确认、延后重试；
 * - SSE 断线/空闲重连、重连快照与继续投递；
 * - app-server 断开退出、锁与状态清理、--check 与配置错误。
 *
 * 运行：bun scripts/verify-ts-codex-monitor.ts
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { check, checkEqual, checksPassed } from './lib/harness';

const ROOT = resolve(import.meta.dir, '..');
const CLI = resolve(ROOT, 'client/cli.ts');
const TOKEN = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
const CLAIMED_AT = '2026-11-04T12:00:00.000Z';

type JsonObject = Record<string, unknown>;

interface MockDelivery extends JsonObject {
  delivery_id: string;
  room_id: string;
  message_id: string;
  attempt: number;
  state: 'pending' | 'claimed' | 'completed' | 'failed';
  claim_id: string | null;
  claimed_at: string | null;
  message: JsonObject;
}

function messageBody(messageId: string): string {
  return `body:${messageId}`;
}

function makeDelivery(id: string): MockDelivery {
  const messageId = `msg_${id}`;
  return {
    delivery_id: id,
    room_id: 'rm_test',
    message_id: messageId,
    attempt: 0,
    state: 'pending',
    claim_id: null,
    claimed_at: null,
    message: {
      message_id: messageId,
      room_id: 'rm_test',
      sender_id: 'agt_user',
      preview: messageBody(messageId).slice(0, 80),
    },
  };
}

function rpc(id: unknown, result: JsonObject): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function toolResult(id: unknown, result: JsonObject): Response {
  return rpc(id, { structuredContent: result });
}

function toolError(id: unknown, code: string, message: string): Response {
  return rpc(id, {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code, message }) }],
  });
}

interface McpMockState {
  pending: Map<string, MockDelivery>;
  claims: Map<string, MockDelivery>;
  claimCalls: Map<string, number>;
  loginCount: number;
  meCount: number;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  keepalive: ReturnType<typeof setInterval> | null;
}

interface McpMock {
  base: string;
  state: McpMockState;
  completed: JsonObject[];
  failed: JsonObject[];
  sends: JsonObject[];
  stop: () => void;
  closeStream: () => void;
  pauseKeepalives: () => void;
  sendItems: (items: JsonObject[], options?: { more?: boolean; dropped?: number }) => void;
}

function createMcpMock(options: { meKind?: string } = {}): McpMock {
  const state: McpMockState = {
    pending: new Map(),
    claims: new Map(),
    claimCalls: new Map(),
    loginCount: 0,
    meCount: 0,
    controller: null,
    keepalive: null,
  };
  const completed: JsonObject[] = [];
  const failed: JsonObject[] = [];
  const sends: JsonObject[] = [];
  const encoder = new TextEncoder();

  const stopKeepalive = (): void => {
    if (state.keepalive) {
      clearInterval(state.keepalive);
      state.keepalive = null;
    }
  };

  const server = Bun.serve({
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/mcp') {
        return new Response('not found', { status: 404 });
      }
      const body = (await request.json()) as {
        id?: string | number;
        method?: string;
        params?: { name?: string; arguments?: JsonObject };
      };
      if (body.method === 'server/discover') {
        return rpc(body.id, { supportedVersions: ['2026-07-28'] });
      }
      if (body.method === 'subscriptions/listen') {
        let local: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            local = controller;
            state.controller = controller;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notifications/subscriptions/acknowledged',
                  params: {},
                })}\n\n`,
              ),
            );
            stopKeepalive();
            state.keepalive = setInterval(() => {
              if (state.controller !== controller) return;
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
              } catch {
                stopKeepalive();
              }
            }, 1000);
          },
          cancel() {
            if (state.controller === local) {
              stopKeepalive();
              state.controller = null;
            }
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        });
      }
      if (body.method !== 'tools/call') return rpc(body.id, {});

      const name = body.params?.name ?? '';
      const args = (body.params?.arguments ?? {}) as JsonObject;
      switch (name) {
        case 'network_me':
          state.meCount += 1;
          return toolResult(body.id, {
            actor_id: 'agt_me',
            kind: options.meKind ?? 'agent',
          });
        case 'network_login':
          state.loginCount += 1;
          return toolResult(body.id, {
            online: true,
            pending_count: state.pending.size,
            inbox_head_seq: '1',
          });
        case 'network_inbox_list': {
          const wanted = String(args.state ?? 'active');
          const items = wanted === 'claimed' ? [...state.claims.values()] : [...state.pending.values()];
          return toolResult(body.id, {
            items,
            next_cursor: null,
            has_more: false,
            pending_count: state.pending.size,
            claimed_delivery_id: state.claims.keys().next().value ?? null,
          });
        }
        case 'network_delivery_claim': {
          const deliveryId = String(args.delivery_id ?? '');
          state.claimCalls.set(deliveryId, (state.claimCalls.get(deliveryId) ?? 0) + 1);
          if (state.claims.has(deliveryId) || deliveryId.startsWith('dlv_other')) {
            return toolError(body.id, 'CLAIM_CONFLICT', '该工作已被领取或状态已变化');
          }
          if (state.claims.size > 0) {
            return toolError(body.id, 'CLAIM_CONFLICT', '当前已有领取中的工作，不能并行领取');
          }
          const pending = state.pending.get(deliveryId);
          if (!pending) {
            return toolError(body.id, 'CLAIM_CONFLICT', '该工作已被领取或状态已变化');
          }
          const claimed: MockDelivery = {
            ...pending,
            state: 'claimed',
            attempt: pending.attempt + 1,
            claim_id: `clm_${deliveryId}`,
            claimed_at: CLAIMED_AT,
          };
          state.pending.delete(deliveryId);
          state.claims.set(deliveryId, claimed);
          return toolResult(body.id, claimed);
        }
        case 'network_message_read': {
          const messageId = String(args.message_id ?? '');
          return toolResult(body.id, {
            chunk: messageBody(messageId),
            chunk_cursor: '',
            next_cursor: null,
            eof: true,
          });
        }
        case 'network_delivery_complete': {
          completed.push(args);
          state.claims.delete(String(args.delivery_id ?? ''));
          return toolResult(body.id, { delivery_id: args.delivery_id, state: 'completed' });
        }
        case 'network_delivery_fail': {
          failed.push(args);
          state.claims.delete(String(args.delivery_id ?? ''));
          return toolResult(body.id, { delivery_id: args.delivery_id, state: 'failed' });
        }
        case 'network_message_send':
          sends.push(args);
          return toolResult(body.id, { message_id: 'msg_ack' });
        default:
          return toolError(body.id, 'INVALID_ARGUMENT', `unexpected tool ${name}`);
      }
    },
  });

  return {
    base: `http://127.0.0.1:${server.port}`,
    state,
    completed,
    failed,
    sends,
    stop: () => {
      stopKeepalive();
      server.stop(true);
    },
    closeStream: () => {
      stopKeepalive();
      const controller = state.controller;
      state.controller = null;
      try {
        controller?.close();
      } catch {
        // 已关闭；监听器按退避重连。
      }
    },
    pauseKeepalives: stopKeepalive,
    sendItems: (items, options = {}) => {
      if (!state.controller) throw new Error('subscription stream is not connected');
      state.controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/resources/updated',
            params: {
              uri: 'agentnet://stream',
              _meta: {
                'io.agent-network/event': {
                  v: 1,
                  actor_id: 'agt_me',
                  seq: 1,
                  attention: 'action_required',
                  items,
                  more: options.more ?? false,
                  dropped: options.dropped ?? 0,
                },
              },
            },
          })}\n\n`,
        ),
      );
    },
  };
}

function notificationItem(
  deliveryId: string,
  source = 'delivery.created',
  eventId?: string,
): JsonObject {
  return {
    source,
    kind: source === 'delivery.reminder' ? 'reminder' : 'task',
    attention: 'action_required',
    delivery_id: deliveryId,
    room_id: 'rm_test',
    message_id: `msg_${deliveryId}`,
    sender_id: 'agt_user',
    attempt: 0,
    seq: '1',
    event_id: eventId ?? `evt_${deliveryId}_${source}`,
    created_at: new Date().toISOString(),
  };
}

interface CodexMockState {
  threads: string[];
  status: 'idle' | 'active';
  currentTurnId: string | null;
  turnSerial: number;
  failNextSteer: boolean;
  sockets: Set<Bun.ServerWebSocket<undefined>>;
}

interface CodexMock {
  socketPath: string;
  state: CodexMockState;
  requests: { method: string; params: JsonObject }[];
  notifications: { method: string; params: JsonObject }[];
  startTexts: string[];
  steerTexts: string[];
  completeTurn: (finalText?: string, status?: 'completed' | 'failed') => void;
  closeClient: () => void;
  stop: () => void;
}

function createCodexMock(
  socketPath: string,
  options: { threads?: string[]; status?: 'idle' | 'active'; currentTurnId?: string } = {},
): CodexMock {
  const state: CodexMockState = {
    threads: options.threads ?? ['thr_test'],
    status: options.status ?? 'idle',
    currentTurnId: options.currentTurnId ?? null,
    turnSerial: options.currentTurnId ? 1 : 0,
    failNextSteer: false,
    sockets: new Set(),
  };
  const requests: { method: string; params: JsonObject }[] = [];
  const notifications: { method: string; params: JsonObject }[] = [];
  const startTexts: string[] = [];
  const steerTexts: string[] = [];

  const server = Bun.serve({
    unix: socketPath,
    fetch(request, srv) {
      if (srv.upgrade(request)) return undefined;
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(socket) {
        state.sockets.add(socket);
      },
      close(socket) {
        state.sockets.delete(socket);
      },
      message(socket, raw) {
        const message = JSON.parse(raw.toString()) as JsonObject;
        const method = String(message.method ?? '');
        const params = (message.params ?? {}) as JsonObject;
        const id = message.id;
        if (typeof id !== 'number') {
          notifications.push({ method, params });
          return;
        }
        requests.push({ method, params });
        const reply = (result: JsonObject): void => {
          socket.send(JSON.stringify({ id, result }));
        };
        const reject = (text: string): void => {
          socket.send(JSON.stringify({ id, error: { code: -32600, message: text } }));
        };
        switch (method) {
          case 'initialize':
            reply({ userAgent: 'mock-app-server' });
            return;
          case 'thread/loaded/list':
            reply({ data: state.threads });
            return;
          case 'thread/resume':
            reply({ thread: { id: params.threadId } });
            return;
          case 'thread/read':
            reply({ thread: { id: params.threadId, status: { type: state.status } } });
            return;
          case 'thread/turns/list':
            reply({
              data:
                state.status === 'active' && state.currentTurnId
                  ? [{ id: state.currentTurnId, status: 'inProgress' }]
                  : [],
            });
            return;
          case 'turn/start': {
            const input = Array.isArray(params.input) ? params.input : [];
            const text = String((input[0] as JsonObject | undefined)?.text ?? '');
            startTexts.push(text);
            state.turnSerial += 1;
            state.currentTurnId = `turn_${state.turnSerial}`;
            state.status = 'active';
            reply({ turn: { id: state.currentTurnId, status: 'inProgress' } });
            return;
          }
          case 'turn/steer': {
            if (state.failNextSteer) {
              state.failNextSteer = false;
              reject('expected turn mismatch');
              return;
            }
            if (params.expectedTurnId !== state.currentTurnId) {
              reject('expected turn mismatch');
              return;
            }
            const input = Array.isArray(params.input) ? params.input : [];
            steerTexts.push(String((input[0] as JsonObject | undefined)?.text ?? ''));
            reply({});
            return;
          }
          default:
            reject(`unexpected method ${method}`);
        }
      },
    },
  });

  const notify = (method: string, params: JsonObject): void => {
    const socket = [...state.sockets][0];
    if (!socket) throw new Error('app-server client is not connected');
    socket.send(JSON.stringify({ method, params }));
  };

  return {
    socketPath,
    state,
    requests,
    notifications,
    startTexts,
    steerTexts,
    completeTurn: (finalText, status = 'completed') => {
      const turnId = state.currentTurnId;
      if (!turnId) throw new Error('no active turn');
      if (finalText !== undefined) {
        notify('item/completed', {
          threadId: state.threads[0],
          turnId,
          item: { type: 'agentMessage', phase: 'final_answer', text: finalText },
        });
      }
      notify('turn/completed', {
        threadId: state.threads[0],
        turn: { id: turnId, status },
      });
      state.status = 'idle';
      state.currentTurnId = null;
    },
    closeClient: () => {
      for (const socket of state.sockets) socket.close();
    },
    stop: () => {
      for (const socket of state.sockets) socket.close();
      server.stop(true);
    },
  };
}

interface RunningWatcher {
  pid: number;
  stdout: string[];
  stderr: string[];
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => Promise<number>;
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  lines: string[],
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) lines.push(line);
  }
}

function startProcess(cmd: string[], env: Record<string, string>): RunningWatcher {
  const proc = Bun.spawn({
    cmd,
    cwd: ROOT,
    env: { ...process.env, CODEX_THREAD_ID: '', ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  void collect(proc.stdout, stdout);
  void collect(proc.stderr, stderr);
  return {
    pid: proc.pid,
    stdout,
    stderr,
    exited: proc.exited,
    kill: async (signal: NodeJS.Signals = 'SIGTERM') => {
      try {
        proc.kill(signal);
      } catch {
        return await proc.exited;
      }
      const result = await Promise.race([
        proc.exited.then(() => 'exit' as const),
        Bun.sleep(5000).then(() => 'timeout' as const),
      ]);
      if (result === 'timeout') {
        proc.kill('SIGKILL');
        return await proc.exited;
      }
      return await proc.exited;
    },
  };
}

async function waitForLine(
  lines: string[],
  predicate: (line: string) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = lines.find(predicate);
    if (found) return found;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}; lines=${JSON.stringify(lines)}`);
}

async function waitForExit(watcher: RunningWatcher, timeoutMs = 10_000): Promise<number> {
  const result = await Promise.race([watcher.exited, Bun.sleep(timeoutMs).then(() => null)]);
  if (result === null) throw new Error(`timeout waiting for exit; lines=${JSON.stringify(watcher.stdout)}`);
  return result;
}

function countLines(lines: string[], prefix: string): number {
  return lines.filter((line) => line.startsWith(prefix)).length;
}

async function waitForCount(
  lines: string[],
  prefix: string,
  count: number,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (countLines(lines, prefix) >= count) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}; lines=${JSON.stringify(lines)}`);
}

interface Fixture {
  mcp: McpMock;
  codex: CodexMock;
  home: string;
  watcher: RunningWatcher;
  stop: () => Promise<void>;
}

async function createFixture(
  label: string,
  options: {
    threads?: string[];
    status?: 'idle' | 'active';
    currentTurnId?: string;
    meKind?: string;
    env?: Record<string, string>;
  } = {},
): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), `agentnet-codex-${label}-`));
  const mcp = createMcpMock({ meKind: options.meKind });
  const codex = createCodexMock(join(home, 'app-server.sock'), options);
  const watcher = startProcess([process.execPath, CLI, 'monitor', '--harness', 'codex'], {
    HOME: home,
    AGENTNET_URL: mcp.base,
    AGENTNET_TOKEN: TOKEN,
    AGENTNET_CODEX_SOCKET: codex.socketPath,
    ...(options.env ?? {}),
  });
  return {
    mcp,
    codex,
    home,
    watcher,
    stop: async () => {
      await watcher.kill().catch(() => undefined);
      mcp.stop();
      codex.stop();
      await rm(home, { recursive: true, force: true });
    },
  };
}

function lockPath(home: string): string {
  const digest = createHash('sha256').update(TOKEN).digest('hex');
  return join(home, '.codex', 'agentnet-watch', `${digest}.lock`);
}

async function runCli(args: string[], env: Record<string, string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.CODEX_THREAD_ID;
  const proc = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    cwd: ROOT,
    env: { ...inheritedEnv, AGENTNET_URL: '', AGENTNET_TOKEN: '', ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

async function runHandshakeChecks(): Promise<void> {
  const fixture = await createFixture('handshake');
  try {
    let ready: string;
    try {
      ready = await waitForLine(
        fixture.watcher.stdout,
        (line) => line.startsWith('CODEX_READY'),
        'CODEX_READY',
      );
    } catch (error) {
      const stderr = fixture.watcher.stderr.join('\n').replaceAll(TOKEN, '[REDACTED]');
      throw new Error(`Codex watcher did not initialize: ${stderr}`, { cause: error });
    }
    checkEqual('Codex 握手线程日志', ready, 'CODEX_READY thread=thr_test');

    checkEqual('network_me 只调用一次', fixture.mcp.state.meCount, 1);
    const netReady = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('READY actor='),
      'READY',
    );
    check(
      'READY 携带 actor 与订阅 id',
      /^READY actor=agt_me subscription=codex-watch-[0-9a-f]{24}$/u.test(netReady),
      netReady,
    );
    checkEqual('ack 后调用 network_login', fixture.mcp.state.loginCount, 1);

    const methods = fixture.codex.requests.map((request) => request.method);
    checkEqual('initialize 是首个请求', methods[0], 'initialize');
    check('发送 initialized 通知', fixture.codex.notifications.some((item) => item.method === 'initialized'));
    check('读取已加载线程', methods.includes('thread/loaded/list'));
    checkEqual(
      'initialize clientInfo.name',
      ((fixture.codex.requests[0]?.params.clientInfo ?? {}) as JsonObject).name,
      'codex-watch',
    );
    const resume = fixture.codex.requests.find((request) => request.method === 'thread/resume');
    checkEqual('thread/resume 目标线程', resume?.params.threadId, 'thr_test');

    check('运行中持有单 token 锁', existsSync(lockPath(fixture.home)));
    checkEqual(
      '锁文件记录当前 pid',
      readFileSync(lockPath(fixture.home), 'utf8').trim(),
      String(fixture.watcher.pid),
    );
    check(
      '日志不含 token',
      !fixture.watcher.stdout.join('\n').includes(TOKEN) &&
        !fixture.watcher.stderr.join('\n').includes(TOKEN),
    );
  } finally {
    await fixture.stop();
  }
}

async function runTurnChecks(): Promise<void> {
  const fixture = await createFixture('turn');
  try {
    await waitForLine(fixture.watcher.stdout, (line) => line.startsWith('READY actor='), 'READY');

    fixture.mcp.state.pending.set('dlv_idle', makeDelivery('dlv_idle'));
    fixture.mcp.sendItems([notificationItem('dlv_idle')]);

    const claimed = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_CLAIMED delivery=dlv_idle'),
      'IDLE CLAIMED',
    );
    check('claim 日志带 claimed_at', claimed.includes(`claimed_at=${CLAIMED_AT}`), claimed);
    check('claim 日志带 auto_claimed', claimed.includes('auto_claimed=true'), claimed);
    check('claim 日志带 claim_id', claimed.includes('claim_id=clm_dlv_idle'), claimed);

    const started = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('TURN_STARTED delivery=dlv_idle'),
      'IDLE TURN_STARTED',
    );
    checkEqual('空闲投递启动 turn_1', started, 'TURN_STARTED delivery=dlv_idle turn=turn_1');
    checkEqual('空闲投递只 claim 一次', fixture.mcp.state.claimCalls.get('dlv_idle'), 1);
    checkEqual('turn/start 注入一次', fixture.codex.startTexts.length, 1);
    check(
      'turn/start 携带任务正文',
      fixture.codex.startTexts[0]?.includes('任务正文：\nbody:msg_dlv_idle') === true,
      fixture.codex.startTexts[0],
    );
    check(
      'turn/start 携带 claim 定位',
      fixture.codex.startTexts[0]?.includes('delivery_id=dlv_idle') === true &&
        fixture.codex.startTexts[0]?.includes('claim_id=clm_dlv_idle') === true,
      fixture.codex.startTexts[0],
    );
    checkEqual('turn/steer 未被调用', fixture.codex.steerTexts.length, 0);

    fixture.codex.completeTurn('第一条完成');
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_COMPLETED delivery=dlv_idle'),
      'IDLE COMPLETED',
    );
    checkEqual('complete 调用一次', fixture.mcp.completed.length, 1);
    checkEqual('complete 使用最终答复', fixture.mcp.completed[0]?.final_body, '第一条完成');
    checkEqual('complete 携带 attempt', fixture.mcp.completed[0]?.attempt, 1);
    checkEqual('complete 携带 claim_id', fixture.mcp.completed[0]?.claim_id, 'clm_dlv_idle');
    checkEqual('complete 后无 claimed', fixture.mcp.state.claims.size, 0);
    checkEqual('没有失败投递', fixture.mcp.failed.length, 0);
    checkEqual('全程无 ERROR', countLines(fixture.watcher.stdout, 'ERROR'), 0);
  } finally {
    await fixture.stop();
  }
}

async function runSteerChecks(): Promise<void> {
  const fixture = await createFixture('steer', {
    status: 'active',
    currentTurnId: 'turn_manual',
  });
  try {
    await waitForLine(fixture.watcher.stdout, (line) => line.startsWith('READY actor='), 'READY');

    fixture.mcp.state.pending.set('dlv_steer_ok', makeDelivery('dlv_steer_ok'));
    fixture.mcp.sendItems([notificationItem('dlv_steer_ok')]);
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_CLAIMED delivery=dlv_steer_ok'),
      'STEER CLAIMED',
    );
    const steered = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('STEERED delivery=dlv_steer_ok'),
      'STEERED',
    );
    checkEqual(
      'steer 指向当前回合',
      steered,
      'STEERED delivery=dlv_steer_ok turn=turn_manual claim_id=clm_dlv_steer_ok',
    );
    check(
      'steer 注入新消息正文',
      fixture.codex.steerTexts[0]?.includes('新消息：\nbody:msg_dlv_steer_ok') === true,
      fixture.codex.steerTexts[0],
    );
    check(
      'steer 不混入任务提示',
      fixture.codex.steerTexts[0]?.includes('任务正文：') === false,
      fixture.codex.steerTexts[0],
    );

    fixture.codex.completeTurn('手动回合结束');
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('TURN_STARTED delivery=dlv_steer_ok'),
      'STEERED TURN_STARTED',
    );
    checkEqual(
      '回合结束后用已领取的 steer 投递启动新回合',
      fixture.codex.startTexts.at(-1)?.includes('任务正文：\nbody:msg_dlv_steer_ok'),
      true,
    );
    checkEqual('steer 复用不重复 claim 计数', fixture.mcp.state.claimCalls.get('dlv_steer_ok'), 2);
    checkEqual(
      'steer 复用再次记录 claim',
      countLines(fixture.watcher.stdout, 'DELIVERY_CLAIMED delivery=dlv_steer_ok') >= 2,
      true,
    );

    fixture.codex.completeTurn('插话任务完成');
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_COMPLETED delivery=dlv_steer_ok'),
      'STEERED COMPLETED',
    );
    checkEqual('steer 任务最终答复', fixture.mcp.completed[0]?.final_body, '插话任务完成');

    // 另起一个手动回合，验证 steer 被 app-server 拒绝时保留 claim、回合结束后补处理。
    fixture.codex.state.status = 'active';
    fixture.codex.state.currentTurnId = 'turn_manual_2';
    fixture.codex.state.turnSerial = 2;
    fixture.codex.state.failNextSteer = true;
    fixture.mcp.state.pending.set('dlv_steer_fail', makeDelivery('dlv_steer_fail'));
    fixture.mcp.sendItems([notificationItem('dlv_steer_fail')]);
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_CLAIMED delivery=dlv_steer_fail'),
      'STEER FAIL CLAIMED',
    );
    const deferredSteer = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('STEER_DEFERRED delivery=dlv_steer_fail'),
      'STEER_DEFERRED',
    );
    check('steer 失败保留 claim 状态', deferredSteer.includes('claim_state=claimed'), deferredSteer);

    fixture.codex.completeTurn();
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('TURN_STARTED delivery=dlv_steer_fail'),
      'FAILED STEER TURN_STARTED',
    );
    fixture.codex.completeTurn('失败插话补处理完成');
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_COMPLETED delivery=dlv_steer_fail'),
      'FAILED STEER COMPLETED',
    );
    checkEqual('失败插话最终答复', fixture.mcp.completed[1]?.final_body, '失败插话补处理完成');
    checkEqual('失败插话复用 claim', fixture.mcp.state.claimCalls.get('dlv_steer_fail'), 2);
    checkEqual('没有投递失败', fixture.mcp.failed.length, 0);
    checkEqual('全程无 ERROR', countLines(fixture.watcher.stdout, 'ERROR'), 0);
  } finally {
    await fixture.stop();
  }
}

async function runDeferredChecks(): Promise<void> {
  const fixture = await createFixture('deferred');
  try {
    await waitForLine(fixture.watcher.stdout, (line) => line.startsWith('READY actor='), 'READY');

    fixture.mcp.state.pending.set('dlv_first', makeDelivery('dlv_first'));
    fixture.mcp.sendItems([notificationItem('dlv_first')]);
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('TURN_STARTED delivery=dlv_first'),
      'FIRST TURN_STARTED',
    );

    fixture.mcp.state.pending.set('dlv_deferred', makeDelivery('dlv_deferred'));
    fixture.mcp.sendItems([notificationItem('dlv_deferred')]);
    const deferred = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_DEFERRED delivery=dlv_deferred'),
      'DEFERRED',
    );
    checkEqual(
      'deferred 指向当前 claim',
      deferred.includes('claimed_delivery=dlv_first'),
      true,
    );
    checkEqual('deferred 不插话', fixture.codex.steerTexts.length, 0);
    checkEqual('deferred 不启动新回合', countLines(fixture.watcher.stdout, 'TURN_STARTED'), 1);

    const ack = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('ACK_SENT delivery=dlv_first'),
      'ACK_SENT',
      15_000,
    );
    checkEqual('慢确认日志', ack, 'ACK_SENT delivery=dlv_first');
    checkEqual('慢确认只发送一次', fixture.mcp.sends.length, 1);
    checkEqual(
      '慢确认正文',
      fixture.mcp.sends[0]?.body,
      '收到，我正在处理，稍后回复结果。',
    );
    checkEqual(
      '慢确认绑定 claim',
      ((fixture.mcp.sends[0]?.claim ?? {}) as JsonObject).delivery_id,
      'dlv_first',
    );
    checkEqual('慢确认不触发 invoke', JSON.stringify(fixture.mcp.sends[0]?.invoke), '[]');

    fixture.codex.completeTurn('第一条完成');
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_COMPLETED delivery=dlv_first'),
      'FIRST COMPLETED',
    );
    checkEqual('暂时延后的投递未处理', fixture.mcp.state.pending.has('dlv_deferred'), true);

    fixture.mcp.sendItems([notificationItem('dlv_deferred', 'delivery.created', 'evt_deferred_replay')]);
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('TURN_STARTED delivery=dlv_deferred'),
      'DEFERRED TURN_STARTED',
    );
    fixture.codex.completeTurn('延后任务完成');
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_COMPLETED delivery=dlv_deferred'),
      'DEFERRED COMPLETED',
    );
    checkEqual('延后任务最终答复', fixture.mcp.completed[1]?.final_body, '延后任务完成');
    checkEqual('没有失败投递', fixture.mcp.failed.length, 0);
    checkEqual('全程无 ERROR', countLines(fixture.watcher.stdout, 'ERROR'), 0);
  } finally {
    await fixture.stop();
  }
}

function reminderItem(deliveryId: string, progressAt: string): JsonObject {
  return {
    ...notificationItem(deliveryId, 'delivery.reminder', `evt_${deliveryId}_reminder`),
    attempt: 1,
    progress_at: progressAt,
  };
}

async function runReminderChecks(): Promise<void> {
  const fixture = await createFixture('reminder');
  try {
    await waitForLine(fixture.watcher.stdout, (line) => line.startsWith('READY actor='), 'READY');

    const first = reminderItem('dlv_rem', 'progress_1');
    fixture.mcp.sendItems([first]);
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('REMINDER_STARTED delivery=dlv_rem'),
      'REMINDER_STARTED',
    );
    check(
      '提醒回合包含 report 指引',
      fixture.codex.startTexts[0]?.includes('network_delivery_report') === true &&
        fixture.codex.startTexts[0]?.includes('delivery_id=dlv_rem') === true,
      fixture.codex.startTexts[0],
    );
    checkEqual('提醒不 claim 投递', fixture.mcp.state.claimCalls.has('dlv_rem'), false);
    fixture.codex.completeTurn();

    fixture.mcp.sendItems([first]);
    await Bun.sleep(300);
    checkEqual(
      '同一提醒不重复唤醒',
      countLines(fixture.watcher.stdout, 'REMINDER_STARTED delivery=dlv_rem'),
      1,
    );

    fixture.mcp.sendItems([reminderItem('dlv_rem', 'progress_2')]);
    await waitForCount(
      fixture.watcher.stdout,
      'REMINDER_STARTED delivery=dlv_rem',
      2,
      'REMINDER_STARTED 2',
    );
    checkEqual(
      '新进度提醒再次唤醒',
      countLines(fixture.watcher.stdout, 'REMINDER_STARTED delivery=dlv_rem'),
      2,
    );

    // 进入手动回合，提醒应改用 turn/steer。
    fixture.codex.state.status = 'active';
    fixture.codex.state.currentTurnId = 'turn_manual_rem';
    fixture.mcp.sendItems([reminderItem('dlv_rem_active', 'progress_3')]);
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('REMINDER_STEERED delivery=dlv_rem_active'),
      'REMINDER_STEERED',
    );
    check(
      '工作中提醒注入当前回合',
      fixture.codex.steerTexts[0]?.includes('delivery_id=dlv_rem_active') === true,
      fixture.codex.steerTexts[0],
    );
    checkEqual('工作中提醒不 claim', fixture.mcp.state.claimCalls.has('dlv_rem_active'), false);
    checkEqual('提醒路径无 ERROR', countLines(fixture.watcher.stdout, 'ERROR'), 0);
  } finally {
    await fixture.stop();
  }
}

async function runReconnectChecks(): Promise<void> {
  const fixture = await createFixture('reconnect');
  try {
    await waitForLine(fixture.watcher.stdout, (line) => line.startsWith('READY actor='), 'READY');

    fixture.mcp.closeStream();
    const streamReconnect = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.includes('RECONNECTING') && line.includes('reason=stream_closed'),
      'STREAM RECONNECTING',
    );
    check('SSE 断线触发重连', streamReconnect.includes('acknowledged=1'), streamReconnect);
    const streamReady = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('READY actor=') && line.includes('reconnect=1 reason=stream_closed'),
      'STREAM READY RECONNECT',
      10_000,
    );
    check('断线重连后 READY 标记 reason', streamReady.includes('reconnect=1'), streamReady);

    fixture.mcp.pauseKeepalives();
    const idleReconnect = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.includes('RECONNECTING') && line.includes('reason=idle_timeout'),
      'IDLE RECONNECTING',
      25_000,
    );
    check('SSE 空闲触发重连', idleReconnect.includes('reason=idle_timeout'), idleReconnect);
    const idleReady = await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('READY actor=') && line.includes('reconnect=1 reason=idle_timeout'),
      'IDLE READY RECONNECT',
      10_000,
    );
    check('空闲重连后 READY 标记 reason', idleReady.includes('reason=idle_timeout'), idleReady);

    fixture.mcp.state.pending.set('dlv_after', makeDelivery('dlv_after'));
    fixture.mcp.sendItems([notificationItem('dlv_after')]);
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('TURN_STARTED delivery=dlv_after'),
      'POST RECONNECT TURN_STARTED',
    );
    fixture.codex.completeTurn('重连后完成');
    await waitForLine(
      fixture.watcher.stdout,
      (line) => line.startsWith('DELIVERY_COMPLETED delivery=dlv_after'),
      'POST RECONNECT COMPLETED',
    );
    checkEqual('重连后最终答复', fixture.mcp.completed[0]?.final_body, '重连后完成');
    checkEqual('重连后无 ERROR', countLines(fixture.watcher.stdout, 'ERROR'), 0);
  } finally {
    await fixture.stop();
  }
}

async function runDisconnectChecks(): Promise<void> {
  const fixture = await createFixture('disconnect');
  try {
    await waitForLine(fixture.watcher.stdout, (line) => line.startsWith('READY actor='), 'READY');
    check('断开前锁存在', existsSync(lockPath(fixture.home)));

    fixture.codex.closeClient();
    const exitCode = await waitForExit(fixture.watcher);
    checkEqual('app-server 断开退出 1', exitCode, 1);
    await waitForLine(
      fixture.watcher.stdout,
      (line) =>
        line.includes('app_server_disconnected') &&
        line.includes('restart watcher to reconcile'),
      'DISCONNECT ERROR',
    );
    check('退出后锁已清理', !existsSync(lockPath(fixture.home)));
  } finally {
    await fixture.stop();
  }
}

async function runCheckAndConfigChecks(): Promise<void> {
  const checked = await runCli(['monitor', '--harness', 'codex', '--check'], {
    AGENTNET_CODEX_SOCKET: '/tmp/mock-codex.sock',
    CODEX_THREAD_ID: 'thr_check',
  });
  checkEqual('codex --check 退出 0', checked.code, 0);
  check('codex --check 标记 TS 引擎', checked.stdout.includes('harness=codex engine=ts'));
  check('codex --check 声明自动 claim', checked.stdout.includes('auto_claim=1'));
  check('codex --check 声明 app-server 传输', checked.stdout.includes('transport=app-server-ws'));
  check('codex --check 显示 socket 注入', checked.stdout.includes('socket=/tmp/mock-codex.sock'));
  check('codex --check 显示线程参数', checked.stdout.includes('thread=thr_check'));
  check('codex --check 不执行旧脚本', !checked.stdout.includes('codex-watch.sh'));
  check('codex --check 不含 token', !checked.stdout.includes(TOKEN));

  const autoThread = await runCli(['monitor', '--harness', 'codex', '--check'], {});
  check('codex --check 无注入时显示 daemon 命令', autoThread.stdout.includes('codex app-server daemon version'));
  check('codex --check 线程默认 auto', autoThread.stdout.includes('thread=auto'));

  const withArgs = await runCli(
    ['monitor', '--harness', 'codex', '--check', '--', '--interval', '5'],
    {},
  );
  check('codex 拒绝旧脚本位置参数', withArgs.code !== 0);
  check('codex 提示不接受位置参数', withArgs.stderr.includes('不接受位置参数'), withArgs.stderr);

  const missingToken = await runCli(['monitor', '--harness', 'codex'], {
    AGENTNET_URL: 'http://127.0.0.1:9',
  });
  checkEqual('缺 token 退出 1', missingToken.code, 1);
  check('缺 token 输出 missing_token', missingToken.stdout.includes('missing_token'), missingToken.stdout);

  const multi = await createFixture('multi-thread', { threads: ['thr_a', 'thr_b'] });
  try {
    const exitCode = await waitForExit(multi.watcher);
    checkEqual('多个已加载线程未指定时退出 1', exitCode, 1);
    await waitForLine(
      multi.watcher.stdout,
      (line) => line.includes('set CODEX_THREAD_ID: expected one loaded thread'),
      'MULTI THREAD ERROR',
    );
    check('多线程错误列出候选', multi.watcher.stdout.join('\n').includes('thr_a, thr_b'));
    check('多线程失败后锁已清理', !existsSync(lockPath(multi.home)));
  } finally {
    await multi.stop();
  }

  const missing = await createFixture('missing-thread', {
    threads: ['thr_test'],
    env: { CODEX_THREAD_ID: 'thr_missing' },
  });
  try {
    const exitCode = await waitForExit(missing.watcher);
    checkEqual('未加载的 CODEX_THREAD_ID 退出 1', exitCode, 1);
    await waitForLine(
      missing.watcher.stdout,
      (line) => line.includes('CODEX_THREAD_ID is not a loaded thread'),
      'MISSING THREAD ERROR',
    );
    check('线程校验失败后锁已清理', !existsSync(lockPath(missing.home)));
  } finally {
    await missing.stop();
  }

  const human = await createFixture('human-token', { meKind: 'human' });
  try {
    const exitCode = await waitForExit(human.watcher);
    checkEqual('人类 token 退出 1', exitCode, 1);
    await waitForLine(
      human.watcher.stdout,
      (line) => line.includes('agent_token_required'),
      'HUMAN TOKEN ERROR',
    );
  } finally {
    await human.stop();
  }

  const sources = [
    readFileSync(join(ROOT, 'client/monitor/codex.ts'), 'utf8'),
    readFileSync(join(ROOT, 'client/monitor/codex-transport.ts'), 'utf8'),
  ].join('\n');
  check(
    'codex TS 不执行 bash/python',
    !sources.includes("'bash'") &&
      !sources.includes('python3') &&
      !sources.includes("'.sh'"),
  );
  check(
    'codex 只通过 daemon version 发现 socket',
    sources.includes("['codex', 'app-server', 'daemon', 'version']"),
  );
  const commandSource = readFileSync(join(ROOT, 'client/commands/monitor.ts'), 'utf8');
  check(
    'monitor 命令不再下载/执行旧脚本',
    !commandSource.includes('LEGACY_SCRIPTS') && !commandSource.includes("'bash'"),
  );
}

async function main(): Promise<void> {
  console.log('TS codex monitor: handshake');
  await runHandshakeChecks();
  console.log('TS codex monitor: idle turn/complete');
  await runTurnChecks();
  console.log('TS codex monitor: active steer');
  await runSteerChecks();
  console.log('TS codex monitor: deferred + slow ack');
  await runDeferredChecks();
  console.log('TS codex monitor: reminders');
  await runReminderChecks();
  console.log('TS codex monitor: reconnect/idle');
  await runReconnectChecks();
  console.log('TS codex monitor: disconnect cleanup');
  await runDisconnectChecks();
  console.log('TS codex monitor: --check/config');
  await runCheckAndConfigChecks();
  console.log(`\n${checksPassed()} checks passed`);
}

await main();
