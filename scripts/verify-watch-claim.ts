/**
 * 本地 watcher 自动 claim 验收。
 *
 * 启动一个内存 MCP mock（不访问生产），驱动 claude-watch.sh 与 peri-watch.sh，
 * 覆盖：成功 claim 后发事件、CLAIM_CONFLICT 分流、自己已 claim 复用、
 * delivery.retried 重新 claim、deferred 后重连快照重新 claim、reminder 不 claim、
 * 其他 claim 错误不伪装成 delivery。Codex 的分类与静态顺序由
 * scripts/test_codex_watch.py 在同一 npm script 中覆盖。
 *
 * 运行：bun scripts/verify-watch-claim.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const CLAUDE_WATCH = 'public/skills/claude-watch.sh';
const PERI_WATCH = 'public/skills/peri-watch.sh';

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

interface StreamState {
  pending: Map<string, MockDelivery>;
  claims: Map<string, MockDelivery>;
  claimCalls: Map<string, number>;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  encoder: TextEncoder;
}

interface MockServer {
  base: string;
  state: StreamState;
  stop: () => void;
  closeStream: () => void;
  pauseKeepalives: () => void;
}

interface RpcRequest {
  id?: string | number;
  method?: string;
  params?: {
    name?: string;
    arguments?: JsonObject;
  };
}

interface RunningWatcher {
  kill: () => Promise<void>;
  stdout: string[];
  stderr: string[];
}

function delivery(id: string): MockDelivery {
  const roomId = 'rm_test';
  const messageId = `msg_${id}`;
  const now = new Date().toISOString();
  return {
    delivery_id: id,
    recipient_id: 'agt_me',
    room_id: roomId,
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
      room_id: roomId,
      sender_id: 'agt_user',
      preview: `body:${messageId}`,
      body_bytes: 8,
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
  const state: StreamState = {
    pending: new Map(),
    claims: new Map(),
    claimCalls: new Map(),
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
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/mcp') {
        return new Response('not found', { status: 404 });
      }
      const body = (await request.json()) as RpcRequest;
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
          const items =
            wanted === 'claimed'
              ? [...state.claims.values()]
              : [...state.pending.values()];
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
            // 已被自己领取：服务端返回 claimConflict，watcher 需从 claimed inbox 复用。
            return toolError(body.id, 'CLAIM_CONFLICT', '该工作已被领取或状态已变化');
          }
          if (deliveryId === 'dlv_other' || deliveryId === 'dlv_other_held') {
            state.pending.delete(deliveryId);
            return toolError(body.id, 'CLAIM_CONFLICT', '该工作已被领取或状态已变化');
          }
          if (deliveryId === 'dlv_stale') {
            state.pending.delete(deliveryId);
            return toolError(body.id, 'STALE_ATTEMPT', 'attempt 或 claim_id 已过期');
          }
          if (state.claims.size > 0) {
            return toolError(
              body.id,
              'CLAIM_CONFLICT',
              '当前已有领取中的工作，不能并行领取',
            );
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
          return toolResult(body.id, claimed);
        }
        case 'network_message_read': {
          const messageId = String(args.message_id ?? '');
          return toolResult(body.id, {
            message_id: messageId,
            room_id: 'rm_test',
            chunk: `body:${messageId}`,
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
        // 已关闭时忽略；watcher 会按退避重连。
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
  mock.state.controller.enqueue(
    mock.state.encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
  );
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

function startWatcher(script: string, base: string): RunningWatcher {
  const proc = Bun.spawn({
    cmd: ['bash', script],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_URL: base, AGENTNET_TOKEN: 'test-token' },
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
    kill: async () => {
      proc.kill('SIGTERM');
      const result = await Promise.race([
        proc.exited.then(() => 'exit' as const),
        Bun.sleep(3000).then(() => 'timeout' as const),
      ]);
      if (result === 'timeout') {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    },
  };
}

async function waitForLine(
  lines: string[],
  predicate: (line: string) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = lines.find(predicate);
    if (found) return found;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}; lines=${JSON.stringify(lines)}`);
}

function parseEvent(line: string, prefix: string): JsonObject | null {
  if (!line.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

async function waitForEvent(
  lines: string[],
  prefix: string,
  type: string,
  deliveryId?: string,
  timeoutMs = 8000,
): Promise<JsonObject> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const line of lines) {
      const event = parseEvent(line, prefix);
      if (!event) continue;
      if (event.type !== type) continue;
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
  timeoutMs = 12000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (mock.state.controller && mock.state.controller !== previous) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label} reconnect`);
}

function eventCount(lines: string[], prefix: string, type: string, deliveryId: string): number {
  return lines.reduce((count, line) => {
    const event = parseEvent(line, prefix);
    return event?.type === type && event.delivery_id === deliveryId ? count + 1 : count;
  }, 0);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertIdleReconnect(options: {
  mock: MockServer;
  watcher: RunningWatcher;
  logLines: string[];
  readyLines: string[];
  prefix: string;
  label: string;
}): Promise<void> {
  const { mock, watcher, logLines, readyLines, prefix, label } = options;
  mock.state.pending.clear();
  mock.state.claims.clear();

  const deliveryId = `dlv_idle_${label}`;
  mock.state.pending.set(deliveryId, delivery(deliveryId));
  sendItems(mock, [notificationItem(deliveryId, 'delivery.created', `evt_${label}_idle`)]);
  const initial = await waitForEvent(watcher.stdout, prefix, 'delivery', deliveryId);
  expect(initial.claim_state === 'claimed', `${label} idle probe must be claimed`);
  const claimCount = mock.state.claimCalls.get(deliveryId) ?? 0;
  expect(claimCount === 1, `${label} idle probe must claim once, got ${claimCount}`);

  const previous = mock.state.controller;
  expect(previous !== null, `${label} idle probe stream must be connected`);
  const started = Date.now();
  mock.pauseKeepalives();

  await waitForLine(
    logLines,
    (line) => line.includes('RECONNECTING') && line.includes('reason=idle_timeout'),
    `${label} idle RECONNECTING`,
    45000,
  );
  await waitForReconnect(mock, previous, `${label} idle`, 30000);
  await waitForLine(
    readyLines,
    (line) => line.includes('READY') && line.includes('reconnect=1'),
    `${label} READY after idle reconnect`,
    15000,
  );

  sendItems(mock, [
    notificationItem(deliveryId, 'delivery.created', `evt_${label}_idle_replay`),
  ]);
  await Bun.sleep(800);
  expect(
    mock.state.claimCalls.get(deliveryId) === claimCount,
    `${label} replay after reconnect must not claim again`,
  );
  expect(
    eventCount(watcher.stdout, prefix, 'delivery', deliveryId) === 1,
    `${label} replay after reconnect must not emit another delivery`,
  );
  console.log(`  ${label} idle reconnect observed after ${Date.now() - started}ms`);
}

async function runClaudeChecks(): Promise<void> {
  const mock = createMock();
  const watcher = startWatcher(CLAUDE_WATCH, mock.base);
  try {
    await waitForLine(watcher.stderr, (line) => line.includes('READY'), 'claude READY');

    mock.state.pending.set('dlv_other', delivery('dlv_other'));
    sendItems(mock, [notificationItem('dlv_other', 'delivery.created', 'evt_other')]);
    const conflict = await waitForEvent(watcher.stdout, '', 'delivery_conflict', 'dlv_other');
    expect(conflict.claim_state === 'conflict', 'conflict event must carry claim_state=conflict');
    expect(
      typeof conflict.hint === 'string' && conflict.hint.includes('跳过'),
      'conflict hint must tell host to skip',
    );
    expect(mock.state.claimCalls.get('dlv_other') === 1, 'conflict delivery must be claimed once');
    expect(
      eventCount(watcher.stdout, '', 'delivery', 'dlv_other') === 0,
      'conflict must not emit a processable delivery event',
    );

    mock.state.pending.set('dlv_ok', delivery('dlv_ok'));
    sendItems(mock, [notificationItem('dlv_ok', 'delivery.created', 'evt_ok')]);
    const ok = await waitForEvent(watcher.stdout, '', 'delivery', 'dlv_ok');
    expect(ok.auto_claimed === true, 'successful delivery must set auto_claimed=true');
    expect(ok.claim_state === 'claimed', 'successful delivery must set claim_state=claimed');
    expect(ok.attempt === 1, `expected attempt 1, got ${String(ok.attempt)}`);
    expect(typeof ok.claim_id === 'string' && ok.claim_id.length > 0, 'claim_id missing');
    expect(typeof ok.claimed_at === 'string' && ok.claimed_at.length > 0, 'claimed_at missing');
    const eventFile = String(ok.event_file ?? '');
    expect(eventFile.length > 0, 'event_file missing');
    const file = JSON.parse(readFileSync(eventFile, 'utf8')) as JsonObject;
    expect(file.auto_claimed === true, 'event_file must set auto_claimed=true');
    expect(file.attempt === ok.attempt, 'event_file attempt must match event');
    expect(file.claim_id === ok.claim_id, 'event_file claim_id must match event');
    expect(file.claimed_at === ok.claimed_at, 'event_file claimed_at must match event');
    expect(
      typeof file.claim === 'object' && file.claim !== null,
      'event_file must contain claim object',
    );
    expect(typeof file.body === 'string' && file.body.includes('body:'), 'event_file body missing');
    expect(mock.state.claimCalls.get('dlv_ok') === 1, 'successful delivery must be claimed once');

    sendItems(mock, [notificationItem('dlv_ok', 'delivery.reminder', 'evt_reminder')]);
    await waitForEvent(watcher.stdout, '', 'reminder', 'dlv_ok');
    expect(mock.state.claimCalls.get('dlv_ok') === 1, 'reminder must not claim again');

    mock.state.pending.set('dlv_deferred', delivery('dlv_deferred'));
    sendItems(mock, [notificationItem('dlv_deferred', 'delivery.created', 'evt_deferred')]);
    const deferred = await waitForEvent(watcher.stdout, '', 'delivery_deferred', 'dlv_deferred');
    expect(
      deferred.claimed_delivery_id === 'dlv_ok',
      `deferred must point at current claim, got ${String(deferred.claimed_delivery_id)}`,
    );
    expect(
      typeof deferred.hint === 'string' &&
        deferred.hint.includes('complete/fail') &&
        deferred.hint.includes('watcher 不轮询'),
      'deferred hint must ask to complete/fail and state watcher does not poll',
    );
    expect(
      eventCount(watcher.stdout, '', 'delivery', 'dlv_deferred') === 0,
      'deferred must not emit a processable delivery event',
    );
    mock.state.pending.delete('dlv_deferred');

    mock.state.pending.set('dlv_other_held', delivery('dlv_other_held'));
    sendItems(mock, [notificationItem('dlv_other_held', 'delivery.created', 'evt_other_held')]);
    const otherWhileHeld = await waitForEvent(
      watcher.stdout,
      '',
      'delivery_conflict',
      'dlv_other_held',
    );
    expect(
      otherWhileHeld.claimed_delivery_id === null,
      'another owner claim must stay conflict even when this actor holds a different claim',
    );

    mock.state.claims.delete('dlv_ok');
    const selfClaim = claimedDelivery('dlv_self');
    mock.state.claims.set('dlv_self', selfClaim);
    mock.state.pending.set('dlv_self', delivery('dlv_self'));
    sendItems(mock, [notificationItem('dlv_self', 'delivery.created', 'evt_self')]);
    const selfEvent = await waitForEvent(watcher.stdout, '', 'delivery', 'dlv_self');
    expect(selfEvent.auto_claimed === true, 'self reuse must keep auto_claimed=true');
    expect(
      selfEvent.claim_id === selfClaim.claim_id,
      `self reuse must return existing claim_id, got ${String(selfEvent.claim_id)}`,
    );
    expect(selfEvent.attempt === 1, `self reuse expected attempt 1, got ${String(selfEvent.attempt)}`);
    expect(selfEvent.claimed_at === selfClaim.claimed_at, 'self reuse must keep existing claimed_at');
    expect(mock.state.claimCalls.get('dlv_self') === 1, 'self reuse must attempt claim once');
    mock.state.pending.delete('dlv_self');
    mock.state.claims.delete('dlv_self');

    mock.state.claims.set('dlv_hold', claimedDelivery('dlv_hold'));
    mock.state.pending.set('dlv_retry', delivery('dlv_retry'));
    sendItems(mock, [notificationItem('dlv_retry', 'delivery.created', 'evt_retry_created')]);
    const retryDeferred = await waitForEvent(watcher.stdout, '', 'delivery_deferred', 'dlv_retry');
    expect(
      retryDeferred.claimed_delivery_id === 'dlv_hold',
      'retry setup must defer behind the held claim',
    );
    mock.state.claims.clear();
    sendItems(mock, [notificationItem('dlv_retry', 'delivery.retried', 'evt_retry')]);
    const retried = await waitForEvent(watcher.stdout, '', 'delivery', 'dlv_retry');
    expect(retried.attempt === 1, `retried delivery expected attempt 1, got ${String(retried.attempt)}`);
    expect(mock.state.claimCalls.get('dlv_retry') === 2, 'delivery.retried must trigger a new claim');

    mock.state.pending.set('dlv_stale', delivery('dlv_stale'));
    sendItems(mock, [notificationItem('dlv_stale', 'delivery.created', 'evt_stale')]);
    const failed = await waitForEvent(watcher.stdout, '', 'delivery_claim_failed', 'dlv_stale');
    expect(failed.code === 'STALE_ATTEMPT', `unexpected claim failure code ${String(failed.code)}`);
    expect(
      eventCount(watcher.stdout, '', 'delivery', 'dlv_stale') === 0,
      'claim failure must not emit a processable delivery event',
    );

    sendItems(mock, [notificationItem('dlv_ok', 'delivery.created', 'evt_ok_duplicate')]);
    await Bun.sleep(800);
    expect(mock.state.claimCalls.get('dlv_ok') === 1, 'duplicate event must not claim again');
    expect(
      eventCount(watcher.stdout, '', 'delivery', 'dlv_ok') === 1,
      'duplicate event must not emit another delivery',
    );

    mock.state.claims.clear();
    mock.state.claims.set('dlv_hold2', claimedDelivery('dlv_hold2'));
    mock.state.pending.set('dlv_snapshot', delivery('dlv_snapshot'));
    sendItems(mock, [notificationItem('dlv_snapshot', 'delivery.created', 'evt_snapshot_created')]);
    await waitForEvent(watcher.stdout, '', 'delivery_deferred', 'dlv_snapshot');
    expect(
      mock.state.claimCalls.get('dlv_snapshot') === 1,
      'snapshot delivery must be attempted once before reconnect',
    );
    mock.state.claims.clear();
    const previousController = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, previousController, 'claude');
    const snapshotEvent = await waitForEvent(watcher.stdout, '', 'delivery', 'dlv_snapshot', 12000);
    expect(snapshotEvent.auto_claimed === true, 'reconnect snapshot must re-claim deferred delivery');
    expect(
      mock.state.claimCalls.get('dlv_snapshot') === 2,
      'deferred delivery must be re-claimed by reconnect snapshot',
    );
    expect(
      eventCount(watcher.stdout, '', 'delivery', 'dlv_snapshot') === 1,
      'reconnect snapshot must emit exactly one delivery event',
    );

    await assertIdleReconnect({
      mock,
      watcher,
      logLines: watcher.stderr,
      readyLines: watcher.stderr,
      prefix: '',
      label: 'claude',
    });
  } finally {
    await watcher.kill();
    mock.stop();
  }
}

async function runPeriChecks(): Promise<void> {
  const mock = createMock();
  const watcher = startWatcher(PERI_WATCH, mock.base);
  try {
    await waitForLine(watcher.stdout, (line) => line.includes('READY'), 'peri READY');

    mock.state.pending.set('dlv_other', delivery('dlv_other'));
    sendItems(mock, [notificationItem('dlv_other', 'delivery.created', 'evt_other')]);
    const conflict = await waitForEvent(watcher.stdout, 'ALERT ', 'delivery_conflict', 'dlv_other');
    expect(conflict.claim_state === 'conflict', 'peri conflict event missing claim_state');
    expect(mock.state.claimCalls.get('dlv_other') === 1, 'peri conflict must claim once');
    expect(
      eventCount(watcher.stdout, 'ALERT ', 'delivery', 'dlv_other') === 0,
      'peri conflict must not emit delivery',
    );

    mock.state.pending.set('dlv_ok', delivery('dlv_ok'));
    sendItems(mock, [notificationItem('dlv_ok', 'delivery.created', 'evt_ok')]);
    const ok = await waitForEvent(watcher.stdout, 'ALERT ', 'delivery', 'dlv_ok');
    expect(ok.auto_claimed === true, 'peri successful delivery missing auto_claimed');
    expect(ok.attempt === 1, `peri expected attempt 1, got ${String(ok.attempt)}`);
    expect(typeof ok.claim_id === 'string' && ok.claim_id.length > 0, 'peri claim_id missing');
    expect(typeof ok.claimed_at === 'string' && ok.claimed_at.length > 0, 'peri claimed_at missing');
    expect(
      typeof ok.claim === 'object' && ok.claim !== null,
      'peri successful delivery missing claim object',
    );

    sendItems(mock, [notificationItem('dlv_ok', 'delivery.reminder', 'evt_reminder')]);
    await waitForEvent(watcher.stdout, 'ALERT ', 'reminder', 'dlv_ok');
    expect(mock.state.claimCalls.get('dlv_ok') === 1, 'peri reminder must not claim');

    mock.state.pending.set('dlv_deferred', delivery('dlv_deferred'));
    sendItems(mock, [notificationItem('dlv_deferred', 'delivery.created', 'evt_deferred')]);
    const deferred = await waitForEvent(watcher.stdout, 'ALERT ', 'delivery_deferred', 'dlv_deferred');
    expect(
      deferred.claimed_delivery_id === 'dlv_ok',
      'peri deferred must point at current claim',
    );
    expect(
      typeof deferred.hint === 'string' &&
        deferred.hint.includes('complete/fail') &&
        deferred.hint.includes('watcher 不轮询'),
      'peri deferred hint must ask to complete/fail and state watcher does not poll',
    );
    expect(
      eventCount(watcher.stdout, 'ALERT ', 'delivery', 'dlv_deferred') === 0,
      'peri deferred must not emit delivery',
    );
    mock.state.pending.delete('dlv_deferred');

    mock.state.pending.set('dlv_other_held', delivery('dlv_other_held'));
    sendItems(mock, [notificationItem('dlv_other_held', 'delivery.created', 'evt_other_held')]);
    const otherWhileHeld = await waitForEvent(
      watcher.stdout,
      'ALERT ',
      'delivery_conflict',
      'dlv_other_held',
    );
    expect(
      otherWhileHeld.claimed_delivery_id === null,
      'peri must not mistake another owner claim for its own held claim',
    );

    mock.state.claims.delete('dlv_ok');
    const selfClaim = claimedDelivery('dlv_self');
    mock.state.claims.set('dlv_self', selfClaim);
    mock.state.pending.set('dlv_self', delivery('dlv_self'));
    sendItems(mock, [notificationItem('dlv_self', 'delivery.created', 'evt_self')]);
    const selfEvent = await waitForEvent(watcher.stdout, 'ALERT ', 'delivery', 'dlv_self');
    expect(selfEvent.auto_claimed === true, 'peri self reuse missing auto_claimed');
    expect(
      selfEvent.claim_id === selfClaim.claim_id,
      `peri self reuse must return existing claim_id, got ${String(selfEvent.claim_id)}`,
    );
    expect(selfEvent.attempt === 1, `peri self reuse expected attempt 1, got ${String(selfEvent.attempt)}`);
    expect(selfEvent.claimed_at === selfClaim.claimed_at, 'peri self reuse must keep existing claimed_at');
    expect(mock.state.claimCalls.get('dlv_self') === 1, 'peri self reuse must attempt claim once');
    mock.state.pending.delete('dlv_self');
    mock.state.claims.delete('dlv_self');

    mock.state.claims.set('dlv_hold', claimedDelivery('dlv_hold'));
    mock.state.pending.set('dlv_retry', delivery('dlv_retry'));
    sendItems(mock, [notificationItem('dlv_retry', 'delivery.created', 'evt_retry_created')]);
    const retryDeferred = await waitForEvent(watcher.stdout, 'ALERT ', 'delivery_deferred', 'dlv_retry');
    expect(
      retryDeferred.claimed_delivery_id === 'dlv_hold',
      'peri retry setup must defer behind the held claim',
    );
    mock.state.claims.clear();
    sendItems(mock, [notificationItem('dlv_retry', 'delivery.retried', 'evt_retry')]);
    const retried = await waitForEvent(watcher.stdout, 'ALERT ', 'delivery', 'dlv_retry');
    expect(retried.attempt === 1, `peri retried delivery expected attempt 1, got ${String(retried.attempt)}`);
    expect(mock.state.claimCalls.get('dlv_retry') === 2, 'peri delivery.retried must trigger a new claim');

    sendItems(mock, [notificationItem('dlv_ok', 'delivery.created', 'evt_ok_duplicate')]);
    await Bun.sleep(800);
    expect(mock.state.claimCalls.get('dlv_ok') === 1, 'peri duplicate must not claim again');
    expect(
      eventCount(watcher.stdout, 'ALERT ', 'delivery', 'dlv_ok') === 1,
      'peri duplicate must not emit another delivery',
    );

    mock.state.claims.clear();
    mock.state.claims.set('dlv_hold2', claimedDelivery('dlv_hold2'));
    mock.state.pending.set('dlv_snapshot', delivery('dlv_snapshot'));
    sendItems(mock, [notificationItem('dlv_snapshot', 'delivery.created', 'evt_snapshot_created')]);
    await waitForEvent(watcher.stdout, 'ALERT ', 'delivery_deferred', 'dlv_snapshot');
    expect(
      mock.state.claimCalls.get('dlv_snapshot') === 1,
      'peri snapshot delivery must be attempted once before reconnect',
    );
    mock.state.claims.clear();
    const previousController = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, previousController, 'peri');
    const snapshotEvent = await waitForEvent(watcher.stdout, 'ALERT ', 'delivery', 'dlv_snapshot', 12000);
    expect(snapshotEvent.auto_claimed === true, 'peri reconnect snapshot must re-claim deferred delivery');
    expect(
      mock.state.claimCalls.get('dlv_snapshot') === 2,
      'peri deferred delivery must be re-claimed by reconnect snapshot',
    );
    expect(
      eventCount(watcher.stdout, 'ALERT ', 'delivery', 'dlv_snapshot') === 1,
      'peri reconnect snapshot must emit exactly one delivery event',
    );

    await assertIdleReconnect({
      mock,
      watcher,
      logLines: watcher.stdout,
      readyLines: watcher.stdout,
      prefix: 'ALERT ',
      label: 'peri',
    });
  } finally {
    await watcher.kill();
    mock.stop();
  }
}

async function main(): Promise<void> {
  const checks: Array<[string, () => Promise<void>]> = [
    ['claude-watch 自动 claim / 复用 / retried / 重连快照', runClaudeChecks],
    ['peri-watch 自动 claim / 复用 / retried / 重连快照', runPeriChecks],
  ];
  for (const [label, check] of checks) {
    await check();
    console.log(`ok - ${label}`);
  }
  console.log('watcher auto-claim checks passed');
}

await main();
