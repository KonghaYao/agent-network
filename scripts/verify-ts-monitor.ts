/**
 * TS 监控引擎验收：本地 mock MCP，不访问生产。
 *
 * 覆盖：
 * - `agentnet monitor --harness claude` 的自动 claim、正文预览、event_file、
 *   seen 去重、deferred/conflict/reminder/claim_failed、自己已 claim 复用、
 *   delivery.retried、重连快照、空闲重连、单 claim 约束与退出清理；
 * - 事件字段与 claude-watch.sh 兼容（delivery/message/attempt/body 等）；
 * - `agentnet monitor --harness peri` 的 `ALERT <json>` 信封、自动 claim、
 *   不读正文、reminder/deferred/conflict/claim_failed、重连快照、空闲重连与退出清理；
 * - `--harness other` 的 ALERT 唤醒、idle 与日志缺失语义。
 *
 * 运行：bun scripts/verify-ts-monitor.ts
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { check, checkEqual, checksPassed } from './lib/harness';
import { BODY_PREVIEW_CHARS } from '../client/monitor/events';

const ROOT = resolve(import.meta.dir, '..');
const CLI = resolve(ROOT, 'client/cli.ts');
const TOKEN = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
const LONG_MESSAGE_ID = 'msg_dlv_long';
const LONG_BODY = `${'投递正文'.repeat(1200)}尾部标记`;

type JsonObject = Record<string, unknown>;

interface MockMessage extends JsonObject {
  message_id: string;
  room_id: string;
  sender_id: string;
}

interface MockDelivery extends JsonObject {
  delivery_id: string;
  room_id: string;
  message_id: string;
  attempt: number;
  state: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
  claim_id: string | null;
  claimed_at: string | null;
  message: MockMessage;
}

interface MockState {
  pending: Map<string, MockDelivery>;
  claims: Map<string, MockDelivery>;
  claimCalls: Map<string, number>;
  readCalls: number;
  maxConcurrentClaims: number;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  encoder: TextEncoder;
}

interface MockServer {
  base: string;
  state: MockState;
  stop: () => void;
  closeStream: () => void;
  pauseKeepalives: () => void;
}

interface RunningWatcher {
  stdout: string[];
  stderr: string[];
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => Promise<number>;
}

function messageBody(messageId: string): string {
  return messageId === LONG_MESSAGE_ID ? LONG_BODY : `body:${messageId}`;
}

function delivery(id: string, messageId = `msg_${id}`): MockDelivery {
  const now = new Date().toISOString();
  const body = messageBody(messageId);
  return {
    delivery_id: id,
    recipient_id: 'agt_me',
    room_id: 'rm_test',
    message_id: messageId,
    state: 'pending',
    attempt: 0,
    claim_id: null,
    claimed_at: null,
    progress_at: null,
    result_message_id: null,
    error: null,
    created_seq: '1',
    created_at: now,
    updated_at: now,
    message: {
      message_id: messageId,
      room_id: 'rm_test',
      sender_id: 'agt_user',
      preview: body.slice(0, 80),
      body_bytes: Buffer.byteLength(body, 'utf8'),
      created_seq: '1',
      created_at: now,
    },
  };
}

function claimedDelivery(id: string, attempt = 1): MockDelivery {
  return {
    ...delivery(id),
    state: 'claimed',
    attempt,
    claim_id: `clm_${id}`,
    claimed_at: new Date().toISOString(),
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

function createMock(): MockServer {
  const state: MockState = {
    pending: new Map(),
    claims: new Map(),
    claimCalls: new Map(),
    readCalls: 0,
    maxConcurrentClaims: 0,
    controller: null,
    keepaliveTimer: null,
    encoder: new TextEncoder(),
  };

  const stopKeepalives = (): void => {
    if (state.keepaliveTimer) {
      clearInterval(state.keepaliveTimer);
      state.keepaliveTimer = null;
    }
  };

  const startKeepalives = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    stopKeepalives();
    state.keepaliveTimer = setInterval(() => {
      if (state.controller !== controller) return;
      try {
        controller.enqueue(state.encoder.encode(': keepalive\n\n'));
      } catch {
        stopKeepalives();
      }
    }, 1000);
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
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            state.controller = controller;
            controller.enqueue(
              state.encoder.encode(
                `data: ${JSON.stringify({
                  jsonrpc: '2.0',
                  method: 'notifications/subscriptions/acknowledged',
                  params: {},
                })}\n\n`,
              ),
            );
            startKeepalives(controller);
          },
          cancel() {
            if (state.controller === streamController) {
              stopKeepalives();
              state.controller = null;
            }
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        });
      }
      if (body.method !== 'tools/call') {
        return rpc(body.id, {});
      }

      const name = body.params?.name ?? '';
      const args = (body.params?.arguments ?? {}) as JsonObject;
      switch (name) {
        case 'network_me':
          return toolResult(body.id, { actor_id: 'agt_me', kind: 'agent' });
        case 'network_login':
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

          const existing = state.claims.get(deliveryId);
          if (existing) {
            return toolError(body.id, 'CLAIM_CONFLICT', '该工作已被领取或状态已变化');
          }
          if (deliveryId.startsWith('dlv_other')) {
            state.pending.delete(deliveryId);
            return toolError(body.id, 'CLAIM_CONFLICT', '该工作已被领取或状态已变化');
          }
          if (deliveryId === 'dlv_stale') {
            state.pending.delete(deliveryId);
            return toolError(body.id, 'STALE_ATTEMPT', 'attempt 或 claim_id 已过期');
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
            claimed_at: new Date().toISOString(),
          };
          state.pending.delete(deliveryId);
          state.claims.set(deliveryId, claimed);
          state.maxConcurrentClaims = Math.max(state.maxConcurrentClaims, state.claims.size);
          return toolResult(body.id, claimed);
        }
        case 'network_message_read': {
          state.readCalls += 1;
          const messageId = String(args.message_id ?? '');
          const full = messageBody(messageId);
          if (messageId === LONG_MESSAGE_ID) {
            const cursor = String(args.chunk_cursor ?? '');
            const splitAt = 2400;
            if (cursor === '') {
              return toolResult(body.id, {
                message_id: messageId,
                room_id: 'rm_test',
                chunk: full.slice(0, splitAt),
                chunk_cursor: 'c1',
                next_cursor: 'c1',
                eof: false,
              });
            }
            return toolResult(body.id, {
              message_id: messageId,
              room_id: 'rm_test',
              chunk: full.slice(splitAt),
              chunk_cursor: 'c1',
              next_cursor: null,
              eof: true,
            });
          }
          return toolResult(body.id, {
            message_id: messageId,
            room_id: 'rm_test',
            chunk: full,
            chunk_cursor: '',
            next_cursor: null,
            eof: true,
          });
        }
        default:
          return toolError(body.id, 'INVALID_ARGUMENT', `unexpected tool ${name}`);
      }
    },
  });

  return {
    base: `http://127.0.0.1:${server.port}`,
    state,
    stop: () => {
      stopKeepalives();
      server.stop(true);
    },
    closeStream: () => {
      stopKeepalives();
      const controller = state.controller;
      state.controller = null;
      try {
        controller?.close();
      } catch {
        // 已关闭时忽略；监听器会按退避重连。
      }
    },
    pauseKeepalives: stopKeepalives,
  };
}

function notificationItem(deliveryId: string, source = 'delivery.created', eventId?: string): JsonObject {
  return {
    source,
    kind: source === 'delivery.reminder' ? 'reminder' : 'task',
    attention: 'action_required',
    delivery_id: deliveryId,
    room_id: 'rm_test',
    message_id: `msg_${deliveryId}`,
    sender_id: 'agt_user',
    seq: '1',
    event_id: eventId ?? `evt_${deliveryId}_${source}`,
    created_at: new Date().toISOString(),
  };
}

function sendItems(mock: MockServer, items: JsonObject[]): void {
  if (!mock.state.controller) throw new Error('subscription stream is not connected');
  const payload = {
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
          more: false,
          dropped: 0,
        },
      },
    },
  };
  mock.state.controller.enqueue(mock.state.encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

async function collect(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
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
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  void collect(proc.stdout, stdout);
  void collect(proc.stderr, stderr);
  return {
    stdout,
    stderr,
    exited: proc.exited,
    kill: async (signal: NodeJS.Signals = 'SIGTERM') => {
      proc.kill(signal);
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

function startWatcher(base: string, extraEnv: Record<string, string> = {}): RunningWatcher {
  return startProcess([process.execPath, CLI, 'monitor', '--harness', 'claude'], {
    AGENTNET_URL: base,
    AGENTNET_TOKEN: TOKEN,
    ...extraEnv,
  });
}

function startPeriWatcher(base: string, extraEnv: Record<string, string> = {}): RunningWatcher {
  return startProcess([process.execPath, CLI, 'monitor', '--harness', 'peri'], {
    AGENTNET_URL: base,
    AGENTNET_TOKEN: TOKEN,
    ...extraEnv,
  });
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

function parseEvent(line: string): JsonObject | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

async function waitForEvent(
  lines: string[],
  type: string,
  deliveryId?: string,
  timeoutMs = 10_000,
): Promise<JsonObject> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const line of lines) {
      const event = parseEvent(line);
      if (!event || event.type !== type) continue;
      if (deliveryId && event.delivery_id !== deliveryId) continue;
      return event;
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `timeout waiting for ${type}${deliveryId ? `/${deliveryId}` : ''}; lines=${JSON.stringify(lines)}`,
  );
}

async function waitForReconnect(
  mock: MockServer,
  previous: ReadableStreamDefaultController<Uint8Array> | null,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (mock.state.controller && mock.state.controller !== previous) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label} reconnect`);
}

function eventCount(lines: string[], type: string, deliveryId: string): number {
  return lines.reduce((count, line) => {
    const event = parseEvent(line);
    return event?.type === type && event.delivery_id === deliveryId ? count + 1 : count;
  }, 0);
}

const ALERT_PREFIX = 'ALERT ';

function parseAlert(line: string): JsonObject | null {
  if (!line.startsWith(ALERT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(ALERT_PREFIX.length)) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
}

async function waitForAlert(
  lines: string[],
  type: string,
  deliveryId?: string,
  timeoutMs = 10_000,
): Promise<JsonObject> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const line of lines) {
      const event = parseAlert(line);
      if (!event || event.type !== type) continue;
      if (deliveryId && event.delivery_id !== deliveryId) continue;
      return event;
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `timeout waiting for ALERT ${type}${deliveryId ? `/${deliveryId}` : ''}; lines=${JSON.stringify(lines)}`,
  );
}

function alertCount(lines: string[], type: string, deliveryId: string): number {
  return lines.reduce((count, line) => {
    const event = parseAlert(line);
    return event?.type === type && event.delivery_id === deliveryId ? count + 1 : count;
  }, 0);
}

function keysOf(event: JsonObject): string {
  return Object.keys(event).join(',');
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runClaudeChecks(): Promise<void> {
  const mock = createMock();
  const watcher = startWatcher(mock.base);
  try {
    const ready = await waitForLine(watcher.stderr, (line) => line.includes('READY'), 'claude READY');
    check('READY 写 stderr 并带 actor/subscription', /READY actor=agt_me pending=\d+ subscription=sub-/.test(ready));
    check('stderr 不含 token', !watcher.stderr.join('\n').includes(TOKEN));

    // 冲突：别人已领取，不能伪装成可处理投递。
    mock.state.pending.set('dlv_other', delivery('dlv_other'));
    sendItems(mock, [notificationItem('dlv_other', 'delivery.created', 'evt_other')]);
    const conflict = await waitForEvent(watcher.stdout, 'delivery_conflict', 'dlv_other');
    checkEqual('冲突 claim_state', conflict.claim_state, 'conflict');
    check('冲突不含正文', !('body' in conflict));
    check('冲突 hint 提示跳过', typeof conflict.hint === 'string' && conflict.hint.includes('跳过'));
    checkEqual('冲突只 claim 一次', mock.state.claimCalls.get('dlv_other'), 1);
    checkEqual('冲突不产生 delivery', eventCount(watcher.stdout, 'delivery', 'dlv_other'), 0);

    // 成功：事件字段 + 正文预览 + event_file。
    mock.state.pending.set('dlv_ok', delivery('dlv_ok'));
    sendItems(mock, [notificationItem('dlv_ok', 'delivery.created', 'evt_ok')]);
    const ok = await waitForEvent(watcher.stdout, 'delivery', 'dlv_ok');
    checkEqual('成功事件 auto_claimed', ok.auto_claimed, true);
    checkEqual('成功事件 claim_state', ok.claim_state, 'claimed');
    checkEqual('成功事件 attempt', ok.attempt, 1);
    check('成功事件 claim_id 非空', typeof ok.claim_id === 'string' && ok.claim_id.length > 0);
    check('成功事件 claimed_at 非空', typeof ok.claimed_at === 'string' && ok.claimed_at.length > 0);
    checkEqual('成功事件 delivery_id', ok.delivery_id, 'dlv_ok');
    checkEqual('成功事件 message_id', ok.message_id, 'msg_dlv_ok');
    checkEqual('成功事件 room_id', ok.room_id, 'rm_test');
    checkEqual('成功事件 sender_id', ok.sender_id, 'agt_user');
    checkEqual('成功事件 source', ok.source, 'stream');
    check('成功事件包含 claim 对象', typeof ok.claim === 'object' && ok.claim !== null);
    const okBody = messageBody('msg_dlv_ok');
    checkEqual('成功事件正文完整', ok.body, okBody);
    checkEqual('成功事件 body_bytes', ok.body_bytes, Buffer.byteLength(okBody, 'utf8'));
    checkEqual('短正文不截断', ok.body_truncated, false);
    const eventFile = String(ok.event_file ?? '');
    check('event_file 存在', eventFile.length > 0 && existsSync(eventFile));
    const fileMode = statSync(eventFile).mode & 0o777;
    checkEqual('event_file 权限 0600', fileMode, 0o600);
    const file = JSON.parse(readFileSync(eventFile, 'utf8')) as JsonObject;
    checkEqual('event_file 保留完整正文', file.body, okBody);
    checkEqual('event_file claim_id 与事件一致', file.claim_id, ok.claim_id);
    checkEqual('event_file attempt 与事件一致', file.attempt, ok.attempt);
    checkEqual('成功投递只 claim 一次', mock.state.claimCalls.get('dlv_ok'), 1);

    // reminder：不 claim、不带正文。
    sendItems(mock, [notificationItem('dlv_ok', 'delivery.reminder', 'evt_reminder')]);
    const reminder = await waitForEvent(watcher.stdout, 'reminder', 'dlv_ok');
    check('reminder 不含正文', !('body' in reminder));
    check('reminder hint 指向 report', typeof reminder.hint === 'string' && reminder.hint.includes('network_delivery_report'));
    checkEqual('reminder 不重复 claim', mock.state.claimCalls.get('dlv_ok'), 1);

    // deferred：自己已有 claim；不写永久 seen。
    mock.state.pending.set('dlv_deferred', delivery('dlv_deferred'));
    sendItems(mock, [notificationItem('dlv_deferred', 'delivery.created', 'evt_deferred')]);
    const deferred = await waitForEvent(watcher.stdout, 'delivery_deferred', 'dlv_deferred');
    check('deferred 不含正文', !('body' in deferred));
    checkEqual('deferred 指向当前 claim', deferred.claimed_delivery_id, 'dlv_ok');
    check(
      'deferred hint 提示 complete/fail 且不轮询',
      typeof deferred.hint === 'string' &&
        deferred.hint.includes('complete/fail') &&
        deferred.hint.includes('watcher 不轮询'),
    );
    checkEqual('deferred 不产生 delivery', eventCount(watcher.stdout, 'delivery', 'dlv_deferred'), 0);
    checkEqual('单 claim 约束：mock 从未同时持有多条 claim', mock.state.maxConcurrentClaims, 1);
    mock.state.pending.delete('dlv_deferred');

    // 别人持有另一条 claim 时仍是 conflict，不能误报 deferred。
    mock.state.pending.set('dlv_other_held', delivery('dlv_other_held'));
    sendItems(mock, [notificationItem('dlv_other_held', 'delivery.created', 'evt_other_held')]);
    const heldConflict = await waitForEvent(watcher.stdout, 'delivery_conflict', 'dlv_other_held');
    checkEqual('他人持有 claim 时为 conflict', heldConflict.claimed_delivery_id, null);

    // 自己已 claim：从 claimed inbox 复用，不重复 claim。
    mock.state.claims.delete('dlv_ok');
    const selfClaim = claimedDelivery('dlv_self');
    mock.state.claims.set('dlv_self', selfClaim);
    mock.state.pending.set('dlv_self', delivery('dlv_self'));
    sendItems(mock, [notificationItem('dlv_self', 'delivery.created', 'evt_self')]);
    const selfEvent = await waitForEvent(watcher.stdout, 'delivery', 'dlv_self');
    checkEqual('复用自己 claim 的 id', selfEvent.claim_id, selfClaim.claim_id);
    checkEqual('复用自己 claim 的 attempt', selfEvent.attempt, 1);
    checkEqual('复用自己 claim 的 claimed_at', selfEvent.claimed_at, selfClaim.claimed_at);
    checkEqual('复用自己 claim 只尝试一次', mock.state.claimCalls.get('dlv_self'), 1);
    mock.state.pending.delete('dlv_self');
    mock.state.claims.delete('dlv_self');

    // delivery.retried：deferred 后清除旧 claim，新事件重新 claim。
    mock.state.claims.set('dlv_hold', claimedDelivery('dlv_hold'));
    mock.state.pending.set('dlv_retry', delivery('dlv_retry'));
    sendItems(mock, [notificationItem('dlv_retry', 'delivery.created', 'evt_retry_created')]);
    const retryDeferred = await waitForEvent(watcher.stdout, 'delivery_deferred', 'dlv_retry');
    checkEqual('retry 前置 deferred 指向旧 claim', retryDeferred.claimed_delivery_id, 'dlv_hold');
    mock.state.claims.clear();
    sendItems(mock, [notificationItem('dlv_retry', 'delivery.retried', 'evt_retry')]);
    const retried = await waitForEvent(watcher.stdout, 'delivery', 'dlv_retry');
    checkEqual('retried attempt', retried.attempt, 1);
    checkEqual('retried 触发新的 claim', mock.state.claimCalls.get('dlv_retry'), 2);

    // claim 业务失败：明确类型，不伪装成 delivery。
    mock.state.pending.set('dlv_stale', delivery('dlv_stale'));
    sendItems(mock, [notificationItem('dlv_stale', 'delivery.created', 'evt_stale')]);
    const stale = await waitForEvent(watcher.stdout, 'delivery_claim_failed', 'dlv_stale');
    checkEqual('claim 失败 code', stale.code, 'STALE_ATTEMPT');
    check('claim 失败不含正文', !('body' in stale));
    checkEqual('claim 失败不产生 delivery', eventCount(watcher.stdout, 'delivery', 'dlv_stale'), 0);

    // 重复事件：seen 去重，不重复 claim/输出。
    sendItems(mock, [notificationItem('dlv_ok', 'delivery.created', 'evt_ok_duplicate')]);
    await Bun.sleep(800);
    checkEqual('重复事件不重复 claim', mock.state.claimCalls.get('dlv_ok'), 1);
    checkEqual('重复事件不重复输出', eventCount(watcher.stdout, 'delivery', 'dlv_ok'), 1);

    // 重连快照：deferred 未写 seen，重连后重新 claim。
    mock.state.claims.clear();
    mock.state.claims.set('dlv_hold2', claimedDelivery('dlv_hold2'));
    mock.state.pending.set('dlv_snapshot', delivery('dlv_snapshot'));
    sendItems(mock, [notificationItem('dlv_snapshot', 'delivery.created', 'evt_snapshot_created')]);
    await waitForEvent(watcher.stdout, 'delivery_deferred', 'dlv_snapshot');
    checkEqual('重连前只尝试一次', mock.state.claimCalls.get('dlv_snapshot'), 1);

    mock.state.claims.clear();
    const previous = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, previous, 'claude');
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'claude READY after reconnect',
    );
    check(
      '普通断线记录 RECONNECTING reason=stream_closed',
      watcher.stderr.some(
        (line) => line.includes('RECONNECTING') && line.includes('reason=stream_closed'),
      ),
    );
    const snapshot = await waitForEvent(watcher.stdout, 'delivery', 'dlv_snapshot');
    checkEqual('重连快照重新 claim', mock.state.claimCalls.get('dlv_snapshot'), 2);
    checkEqual('重连快照只输出一条 delivery', eventCount(watcher.stdout, 'delivery', 'dlv_snapshot'), 1);
    checkEqual('重连快照 auto_claimed', snapshot.auto_claimed, true);

    // 超长正文：按码点截断，event_file 保留全文。
    mock.state.pending.clear();
    mock.state.claims.clear();
    mock.state.pending.set('dlv_long', delivery('dlv_long', LONG_MESSAGE_ID));
    sendItems(mock, [notificationItem('dlv_long', 'delivery.created', 'evt_long')]);
    const longEvent = await waitForEvent(watcher.stdout, 'delivery', 'dlv_long');
    const expectedPreview = Array.from(LONG_BODY).slice(0, BODY_PREVIEW_CHARS).join('');
    check('长正文确实超过预览上限', Array.from(LONG_BODY).length > BODY_PREVIEW_CHARS);
    checkEqual('长正文按码点截断', longEvent.body, expectedPreview);
    checkEqual('长正文 body_truncated', longEvent.body_truncated, true);
    checkEqual('长正文 body_bytes 描述全文', longEvent.body_bytes, Buffer.byteLength(LONG_BODY, 'utf8'));
    const longFile = JSON.parse(readFileSync(String(longEvent.event_file ?? ''), 'utf8')) as JsonObject;
    checkEqual('长正文 event_file 保留全文', longFile.body, LONG_BODY);
    checkEqual('长正文只 claim 一次', mock.state.claimCalls.get('dlv_long'), 1);

    // 空闲检测：15 秒没有任何字节后重连。
    mock.state.pending.clear();
    mock.state.claims.clear();
    const idleId = 'dlv_idle';
    mock.state.pending.set(idleId, delivery(idleId));
    sendItems(mock, [notificationItem(idleId, 'delivery.created', 'evt_idle')]);
    const idleEvent = await waitForEvent(watcher.stdout, 'delivery', idleId);
    checkEqual('空闲探针已 claim', idleEvent.claim_state, 'claimed');
    const idleClaimCount = mock.state.claimCalls.get(idleId) ?? 0;
    const idlePrevious = mock.state.controller;
    expect(idlePrevious !== null, 'idle probe stream must be connected');
    mock.pauseKeepalives();
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('RECONNECTING') && line.includes('reason=idle_timeout'),
      'claude idle RECONNECTING',
      45_000,
    );
    await waitForReconnect(mock, idlePrevious, 'claude idle', 30_000);
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'claude READY after idle reconnect',
      15_000,
    );
    sendItems(mock, [notificationItem(idleId, 'delivery.created', 'evt_idle_replay')]);
    await Bun.sleep(800);
    checkEqual('空闲重连不回放 claim', mock.state.claimCalls.get(idleId), idleClaimCount);
    checkEqual('空闲重连不回放 delivery', eventCount(watcher.stdout, 'delivery', idleId), 1);

    checkEqual('整体只允许单 claim', mock.state.maxConcurrentClaims, 1);
    check('stdout 每行都是事件 JSON', watcher.stdout.every((line) => parseEvent(line) !== null));
    check('stdout 不含 token', !watcher.stdout.join('\n').includes(TOKEN));
    check('stderr 不含 token', !watcher.stderr.join('\n').includes(TOKEN));
  } finally {
    await watcher.kill();
    mock.stop();
  }
}

async function runPeriChecks(): Promise<void> {
  const mock = createMock();
  const watcher = startPeriWatcher(mock.base);
  try {
    const ready = await waitForLine(watcher.stdout, (line) => line.includes('READY'), 'peri READY');
    check(
      'peri READY 写 stdout 且带 actor/subscription',
      /^READY actor=agt_me pending=\d+ subscription=sub-/.test(ready),
      ready,
    );
    check('peri READY 不写 stderr', !watcher.stderr.join('\n').includes('READY'));
    check('peri stderr 不含 token', !watcher.stderr.join('\n').includes(TOKEN));

    // 冲突：别人已领取，输出不可处理的 claim 通知，不带正文。
    mock.state.pending.set('dlv_other', delivery('dlv_other'));
    sendItems(mock, [notificationItem('dlv_other', 'delivery.created', 'evt_other')]);
    const conflict = await waitForAlert(watcher.stdout, 'delivery_conflict', 'dlv_other');
    checkEqual(
      'peri conflict 键顺序',
      keysOf(conflict),
      'type,source,delivery_id,room_id,message_id,sender_id,event_id,seq,attempt,code,reason,claim_state,claimed_delivery_id,hint',
    );
    checkEqual('peri conflict source', conflict.source, 'delivery.created');
    checkEqual('peri conflict claim_state', conflict.claim_state, 'conflict');
    checkEqual('peri conflict claimed_delivery_id', conflict.claimed_delivery_id, null);
    checkEqual('peri conflict code', conflict.code, 'CLAIM_CONFLICT');
    check('peri conflict 不含正文', !('body' in conflict));
    checkEqual('peri conflict 只 claim 一次', mock.state.claimCalls.get('dlv_other'), 1);
    checkEqual('peri conflict 不产生 delivery', alertCount(watcher.stdout, 'delivery', 'dlv_other'), 0);

    // 成功：流通知事件保留 source/event_id/seq/created_at，不读正文。
    mock.state.pending.set('dlv_ok', delivery('dlv_ok'));
    const okNotice = notificationItem('dlv_ok', 'delivery.created', 'evt_ok');
    sendItems(mock, [okNotice]);
    const ok = await waitForAlert(watcher.stdout, 'delivery', 'dlv_ok');
    checkEqual(
      'peri delivery 键顺序',
      keysOf(ok),
      'type,source,event_id,delivery_id,room_id,message_id,sender_id,seq,created_at,attempt,claim_id,claimed_at,auto_claimed,claim_state,claim',
    );
    checkEqual('peri delivery source 来自事件', ok.source, 'delivery.created');
    checkEqual('peri delivery event_id', ok.event_id, 'evt_ok');
    checkEqual('peri delivery seq', ok.seq, '1');
    checkEqual('peri delivery created_at', ok.created_at, okNotice.created_at);
    checkEqual('peri delivery sender_id', ok.sender_id, 'agt_user');
    checkEqual('peri delivery attempt', ok.attempt, 1);
    checkEqual('peri delivery auto_claimed', ok.auto_claimed, true);
    checkEqual('peri delivery claim_state', ok.claim_state, 'claimed');
    check(
      'peri delivery 不含正文/event_file',
      !('body' in ok) && !('body_bytes' in ok) && !('body_truncated' in ok) && !('event_file' in ok),
    );
    const claimedOk = mock.state.claims.get('dlv_ok');
    expect(claimedOk !== undefined, 'peri mock must hold the claim');
    checkEqual('peri delivery claim_id 来自 claim', ok.claim_id, claimedOk.claim_id);
    checkEqual('peri delivery claimed_at 来自 claim', ok.claimed_at, claimedOk.claimed_at);
    checkEqual('peri delivery 不读正文', mock.state.readCalls, 0);
    checkEqual('peri delivery 只 claim 一次', mock.state.claimCalls.get('dlv_ok'), 1);

    // reminder：不 claim、不读正文，字段保持 jq 的 null 语义。
    const reminderNotice = notificationItem('dlv_ok', 'delivery.reminder', 'evt_reminder');
    sendItems(mock, [reminderNotice]);
    const reminder = await waitForAlert(watcher.stdout, 'reminder', 'dlv_ok');
    checkEqual(
      'peri reminder 键顺序',
      keysOf(reminder),
      'type,source,delivery_id,room_id,message_id,attempt,progress_at,event_id,seq,created_at,hint',
    );
    checkEqual('peri reminder source', reminder.source, 'stream');
    checkEqual('peri reminder attempt 保留 null', reminder.attempt, null);
    checkEqual('peri reminder progress_at', reminder.progress_at, null);
    checkEqual('peri reminder created_at', reminder.created_at, reminderNotice.created_at);
    check('peri reminder 不含正文', !('body' in reminder));
    checkEqual('peri reminder 不 claim', mock.state.claimCalls.get('dlv_ok'), 1);

    // deferred：自己已有 claim；不写永久 seen。
    mock.state.pending.set('dlv_deferred', delivery('dlv_deferred'));
    sendItems(mock, [notificationItem('dlv_deferred', 'delivery.created', 'evt_deferred')]);
    const deferred = await waitForAlert(watcher.stdout, 'delivery_deferred', 'dlv_deferred');
    check('peri deferred 不含正文', !('body' in deferred));
    checkEqual('peri deferred 指向当前 claim', deferred.claimed_delivery_id, 'dlv_ok');
    check(
      'peri deferred hint 提示 complete/fail 且不轮询',
      typeof deferred.hint === 'string' &&
        deferred.hint.includes('complete/fail') &&
        deferred.hint.includes('watcher 不轮询'),
    );
    checkEqual('peri deferred 不产生 delivery', alertCount(watcher.stdout, 'delivery', 'dlv_deferred'), 0);
    mock.state.pending.delete('dlv_deferred');

    // 别人持有另一条 claim 时仍是 conflict，不能误报 deferred。
    mock.state.pending.set('dlv_other_held', delivery('dlv_other_held'));
    sendItems(mock, [notificationItem('dlv_other_held', 'delivery.created', 'evt_other_held')]);
    const heldConflict = await waitForAlert(watcher.stdout, 'delivery_conflict', 'dlv_other_held');
    checkEqual('peri 他人持有 claim 时为 conflict', heldConflict.claimed_delivery_id, null);

    // 自己已 claim：从 claimed inbox 复用，不重复 claim。
    mock.state.claims.delete('dlv_ok');
    const selfClaim = claimedDelivery('dlv_self');
    mock.state.claims.set('dlv_self', selfClaim);
    mock.state.pending.set('dlv_self', delivery('dlv_self'));
    sendItems(mock, [notificationItem('dlv_self', 'delivery.created', 'evt_self')]);
    const selfEvent = await waitForAlert(watcher.stdout, 'delivery', 'dlv_self');
    checkEqual('peri 复用自己 claim 的 id', selfEvent.claim_id, selfClaim.claim_id);
    checkEqual('peri 复用自己 claim 的 attempt', selfEvent.attempt, 1);
    checkEqual('peri 复用自己 claim 的 claimed_at', selfEvent.claimed_at, selfClaim.claimed_at);
    checkEqual('peri 复用自己 claim 只尝试一次', mock.state.claimCalls.get('dlv_self'), 1);
    mock.state.pending.delete('dlv_self');
    mock.state.claims.delete('dlv_self');

    // delivery.retried：deferred 后清除旧 claim，新事件重新 claim。
    mock.state.claims.set('dlv_hold', claimedDelivery('dlv_hold'));
    mock.state.pending.set('dlv_retry', delivery('dlv_retry'));
    sendItems(mock, [notificationItem('dlv_retry', 'delivery.created', 'evt_retry_created')]);
    const retryDeferred = await waitForAlert(watcher.stdout, 'delivery_deferred', 'dlv_retry');
    checkEqual('peri retry 前置 deferred 指向旧 claim', retryDeferred.claimed_delivery_id, 'dlv_hold');
    mock.state.claims.clear();
    sendItems(mock, [notificationItem('dlv_retry', 'delivery.retried', 'evt_retry')]);
    const retried = await waitForAlert(watcher.stdout, 'delivery', 'dlv_retry');
    checkEqual('peri retried attempt', retried.attempt, 1);
    checkEqual('peri retried 触发新的 claim', mock.state.claimCalls.get('dlv_retry'), 2);

    // claim 业务失败：明确类型，不伪装成 delivery。
    mock.state.pending.set('dlv_stale', delivery('dlv_stale'));
    sendItems(mock, [notificationItem('dlv_stale', 'delivery.created', 'evt_stale')]);
    const stale = await waitForAlert(watcher.stdout, 'delivery_claim_failed', 'dlv_stale');
    checkEqual('peri claim 失败 code', stale.code, 'STALE_ATTEMPT');
    checkEqual('peri claim 失败 claim_state', stale.claim_state, 'failed');
    check('peri claim 失败不含正文', !('body' in stale));
    checkEqual('peri claim 失败不产生 delivery', alertCount(watcher.stdout, 'delivery', 'dlv_stale'), 0);

    // 重复事件：seen 去重，不重复 claim/输出。
    sendItems(mock, [notificationItem('dlv_ok', 'delivery.created', 'evt_ok_duplicate')]);
    await Bun.sleep(800);
    checkEqual('peri 重复事件不重复 claim', mock.state.claimCalls.get('dlv_ok'), 1);
    checkEqual('peri 重复事件不重复输出', alertCount(watcher.stdout, 'delivery', 'dlv_ok'), 1);

    // 重连快照：deferred 未写 seen，重连后按 inbox 条目重新 claim。
    mock.state.claims.clear();
    mock.state.claims.set('dlv_hold2', claimedDelivery('dlv_hold2'));
    mock.state.pending.set('dlv_snapshot', delivery('dlv_snapshot'));
    sendItems(mock, [notificationItem('dlv_snapshot', 'delivery.created', 'evt_snapshot_created')]);
    await waitForAlert(watcher.stdout, 'delivery_deferred', 'dlv_snapshot');
    checkEqual('peri 重连前只尝试一次', mock.state.claimCalls.get('dlv_snapshot'), 1);

    mock.state.claims.clear();
    const previous = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, previous, 'peri');
    await waitForLine(
      watcher.stdout,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'peri READY after reconnect',
    );
    check(
      'peri 普通断线记录 RECONNECTING reason=stream_closed',
      watcher.stdout.some(
        (line) => line.includes('RECONNECTING') && line.includes('reason=stream_closed'),
      ),
    );
    const snapshot = await waitForAlert(watcher.stdout, 'delivery', 'dlv_snapshot');
    checkEqual(
      'peri snapshot 键顺序',
      keysOf(snapshot),
      'type,source,delivery_id,room_id,message_id,sender_id,seq,created_seq,attempt,claim_id,claimed_at,auto_claimed,claim_state,claim',
    );
    checkEqual('peri snapshot source', snapshot.source, 'inbox.snapshot');
    checkEqual('peri snapshot seq 取 created_seq', snapshot.seq, '1');
    checkEqual('peri snapshot created_seq', snapshot.created_seq, '1');
    check(
      'peri snapshot 不含 event_id/created_at',
      !('event_id' in snapshot) && !('created_at' in snapshot),
    );
    checkEqual('peri 重连快照重新 claim', mock.state.claimCalls.get('dlv_snapshot'), 2);
    checkEqual('peri 重连快照只输出一条 delivery', alertCount(watcher.stdout, 'delivery', 'dlv_snapshot'), 1);
    checkEqual('peri 重连快照 auto_claimed', snapshot.auto_claimed, true);

    // 空闲检测：15 秒没有任何字节后重连。
    mock.state.pending.clear();
    mock.state.claims.clear();
    const idleId = 'dlv_peri_idle';
    mock.state.pending.set(idleId, delivery(idleId));
    sendItems(mock, [notificationItem(idleId, 'delivery.created', 'evt_peri_idle')]);
    const idleEvent = await waitForAlert(watcher.stdout, 'delivery', idleId);
    checkEqual('peri 空闲探针已 claim', idleEvent.claim_state, 'claimed');
    const idleClaimCount = mock.state.claimCalls.get(idleId) ?? 0;
    const idlePrevious = mock.state.controller;
    expect(idlePrevious !== null, 'peri idle probe stream must be connected');
    mock.pauseKeepalives();
    await waitForLine(
      watcher.stdout,
      (line) => line.includes('RECONNECTING') && line.includes('reason=idle_timeout'),
      'peri idle RECONNECTING',
      45_000,
    );
    await waitForReconnect(mock, idlePrevious, 'peri idle', 30_000);
    await waitForLine(
      watcher.stdout,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'peri READY after idle reconnect',
      15_000,
    );
    sendItems(mock, [notificationItem(idleId, 'delivery.created', 'evt_peri_idle_replay')]);
    await Bun.sleep(800);
    checkEqual('peri 空闲重连不回放 claim', mock.state.claimCalls.get(idleId), idleClaimCount);
    checkEqual('peri 空闲重连不回放 delivery', alertCount(watcher.stdout, 'delivery', idleId), 1);

    checkEqual('peri 整体只允许单 claim', mock.state.maxConcurrentClaims, 1);
    checkEqual('peri 全程不读正文', mock.state.readCalls, 0);
    check(
      'peri stdout 每行是 ALERT 或诊断',
      watcher.stdout.every(
        (line) =>
          line.startsWith('ALERT ') || /^(READY|RECONNECTING|DEGRADED|ERROR) /.test(line),
      ),
      watcher.stdout,
    );
    check(
      'peri ALERT 行都是紧凑 JSON',
      watcher.stdout
        .filter((line) => line.startsWith('ALERT '))
        .every((line) => {
          const event = parseAlert(line);
          return event !== null && `ALERT ${JSON.stringify(event)}` === line;
        }),
    );
    check('peri stdout 不含 token', !watcher.stdout.join('\n').includes(TOKEN));
    check('peri stderr 不含 token', !watcher.stderr.join('\n').includes(TOKEN));
  } finally {
    await watcher.kill();
    mock.stop();
  }
}

async function runPeriCleanupCheck(): Promise<void> {
  const mock = createMock();
  const workdir = await mkdtemp(join(tmpdir(), 'ts-monitor-peri-cleanup-'));
  const stateDir = join(workdir, 'state');
  const watcher = startPeriWatcher(mock.base, { AGENTNET_MONITOR_STATE_DIR: stateDir });
  try {
    await waitForLine(watcher.stdout, (line) => line.includes('READY'), 'peri cleanup READY');
    check('peri 状态目录启动时存在', existsSync(stateDir));
    const code = await watcher.kill('SIGTERM');
    checkEqual('peri SIGTERM 退出码', code, 0);
    check('peri 退出后清理状态目录', !existsSync(stateDir));
  } finally {
    await watcher.kill();
    mock.stop();
    await rm(workdir, { recursive: true, force: true });
  }
}

async function runCleanupCheck(): Promise<void> {
  const mock = createMock();
  const workdir = await mkdtemp(join(tmpdir(), 'ts-monitor-cleanup-'));
  const stateDir = join(workdir, 'state');
  const watcher = startWatcher(mock.base, { AGENTNET_MONITOR_STATE_DIR: stateDir });
  try {
    await waitForLine(watcher.stderr, (line) => line.includes('READY'), 'cleanup READY');
    check('状态目录启动时存在', existsSync(stateDir));
    const code = await watcher.kill('SIGTERM');
    checkEqual('SIGTERM 退出码', code, 0);
    check('退出后清理状态目录', !existsSync(stateDir));
  } finally {
    await watcher.kill();
    mock.stop();
    await rm(workdir, { recursive: true, force: true });
  }
}

function runOtherCheck(args: string[], logPath: string, expectedExit: number, label: string): {
  code: number;
  lines: string[];
} {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'other', '--log', logPath, ...args],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const lines = new TextDecoder()
    .decode(result.stdout)
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  checkEqual(`${label} 退出码`, result.exitCode, expectedExit);
  return { code: result.exitCode ?? -1, lines };
}

async function runOtherChecks(): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), 'ts-monitor-other-'));

  const missingPath = join(workdir, 'missing.log');
  const missing = runOtherCheck(['--max-wait', '1', '--poll', '1'], missingPath, 2, '日志缺失');
  check('日志缺失输出 log_not_found', missing.lines[0]?.startsWith('ERROR log_not_found path=') ?? false);

  const idlePath = join(workdir, 'idle.log');
  writeFileSync(idlePath, '');
  const idle = runOtherCheck(['--max-wait', '1', '--poll', '1'], idlePath, 0, 'idle');
  checkEqual('idle 输出 WAKE reason=idle', idle.lines[0], 'WAKE reason=idle total_alerts=0');

  const alertPath = join(workdir, 'alert.log');
  writeFileSync(alertPath, 'ALERT {"delivery_id":"dlv_old"}\n');
  const alertWatcher = startProcess(
    [process.execPath, CLI, 'monitor', '--harness', 'other', '--log', alertPath, '--max-wait', '10', '--poll', '1'],
    { AGENTNET_TOKEN: TOKEN },
  );
  await Bun.sleep(400);
  appendFileSync(alertPath, 'ALERT {"delivery_id":"dlv_new1"}\nALERT {"delivery_id":"dlv_new2"}\n');
  const exitCode = await Promise.race([
    alertWatcher.exited,
    Bun.sleep(8000).then(() => 'timeout' as const),
  ]);
  if (exitCode === 'timeout') {
    await alertWatcher.kill('SIGKILL');
    throw new Error(`other alert sentinel did not wake; lines=${JSON.stringify(alertWatcher.stdout)}`);
  }
  checkEqual('ALERT 唤醒退出码', exitCode, 0);
  checkEqual('ALERT 唤醒首行', alertWatcher.stdout[0], 'WAKE reason=alert new=2 total=3');
  check('只输出新增 ALERT（1）', alertWatcher.stdout[1]?.includes('dlv_new1') ?? false);
  check('只输出新增 ALERT（2）', alertWatcher.stdout[2]?.includes('dlv_new2') ?? false);
  check('不重复输出旧 ALERT', !alertWatcher.stdout.join('\n').includes('dlv_old'));

  // --check 不连接服务、不输出 token。
  const claudeCheck = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'claude', '--check'],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  checkEqual('claude --check 退出码', claudeCheck.exitCode, 0);
  check('claude --check 标记 TS 引擎', new TextDecoder().decode(claudeCheck.stdout).includes('engine=ts'));

  const otherCheck = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'other', '--check', '--log', alertPath],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  checkEqual('other --check 退出码', otherCheck.exitCode, 0);
  const otherCheckOutput = new TextDecoder().decode(otherCheck.stdout);
  check('other --check 标记 TS 引擎', otherCheckOutput.includes('engine=ts'));
  check('--check 输出不含 token', !otherCheckOutput.includes(TOKEN));

  const periCheck = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'peri', '--check'],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  checkEqual('peri --check 退出码', periCheck.exitCode, 0);
  const periCheckOutput = new TextDecoder().decode(periCheck.stdout);
  check('peri --check 标记 TS 引擎', periCheckOutput.includes('engine=ts'));
  check('peri --check 声明自动 claim', periCheckOutput.includes('auto_claim=1'));
  check('peri --check 声明不读正文', periCheckOutput.includes('read_body=0'));
  check('peri --check 不执行旧脚本', !periCheckOutput.includes('peri-watch.sh'));
  check('peri --check 输出不含 token', !periCheckOutput.includes(TOKEN));

  await rm(workdir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log('TS monitor: claude harness');
  await runClaudeChecks();
  console.log('TS monitor: signal cleanup');
  await runCleanupCheck();
  console.log('TS monitor: peri harness');
  await runPeriChecks();
  console.log('TS monitor: peri signal cleanup');
  await runPeriCleanupCheck();
  console.log('TS monitor: other harness');
  await runOtherChecks();
  console.log(`\n${checksPassed()} checks passed`);
}

await main();
