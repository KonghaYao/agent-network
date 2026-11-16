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
 * - `agentnet monitor --harness dsh` 的 wake.queue 九字段、过滤、catchup、
 *   不 claim/不读正文、start/stop/status/logs/wait、重连/空闲与 fatal 退出码；
 * - `--harness other` 的 ALERT 唤醒、idle 与日志缺失语义。
 *
 * 运行：bun scripts/verify-ts-monitor.ts
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { check, checkEqual, checksPassed } from './lib/harness';
import { listInboxPages, type MonitorRpc } from '../client/monitor/rpc';
import { fetchMemoryPack } from '../client/monitor/memory';
import { BODY_PREVIEW_CHARS } from '../client/monitor/events';
import { retryDelayMs } from '../client/monitor/engine';

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
  /** 按消息 id 返回的引用上下文；未登记时服务端返回 null。 */
  quotes: Map<string, JsonObject>;
  maxConcurrentClaims: number;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  keepaliveTimer: ReturnType<typeof setInterval> | null;
  encoder: TextEncoder;
  roomKinds: Map<string, string>;
  roomGetCalls: Map<string, number>;
  /** --room-events 测试用：房间列表与 history after 分页。 */
  rooms: string[];
  history: Map<string, JsonObject[]>;
  /** 模拟旧服务端：/after 返回本页消息却仍给旧游标。 */
  historyCursorStuck: boolean;
  /** 模拟成员重新加入：代次递增后旧代次游标返回 CURSOR_EXPIRED。 */
  historyGeneration: number;
  historyCalls: Array<{ room_id: string; cursor: string | null; direction: string }>;
  /** informational 帧不应触发 pending inbox 查询。 */
  pendingListCalls: number;
  /** dsh 测试用：覆盖 network_login 的 pending/head 快照。 */
  loginPending: number | null;
  loginHeadSeq: string | null;
  /** 接下来 N 次 subscriptions/listen 返回 500，用于触发 DEGRADED/RECOVERED。 */
  listenFailures: number;
  /** 接下来 N 次 pending inbox 查询返回工具错误，用于验证查询退避。 */
  inboxFailures: number;
  /** Phase C：memory pack 调用记录与故障注入。 */
  memoryCalls: JsonObject[];
  memoryFailures: number;
  memoryErrorCode: string;
  memoryDelayMs: number;
  memoryReason: string | null;
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

/**
 * 复刻服务端 modern-only 入口校验：方法头、协议版本、_meta 与 MCP-Name
 * 任一不一致都返回 400。监听器若漏发 MCP-Name 会在这里直接失败。
 */
function protocolReject(id: unknown, message: string): Response {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code: -32020, message } },
    { status: 400 },
  );
}

interface MockOptions {
  /** 所有请求返回 401，用于 dsh 的不可重试凭据路径。 */
  credentialInvalid?: boolean;
  /** network_me 返回的身份类型；默认 agent。 */
  meKind?: string;
  /** 启动时先失败 N 次 subscriptions/listen。 */
  listenFailures?: number;
  /** 启动时先失败 N 次 pending inbox 查询。 */
  inboxFailures?: number;
}

function createMock(options: MockOptions = {}): MockServer {
  const state: MockState = {
    pending: new Map(),
    claims: new Map(),
    claimCalls: new Map(),
    readCalls: 0,
    quotes: new Map(),
    maxConcurrentClaims: 0,
    controller: null,
    keepaliveTimer: null,
    encoder: new TextEncoder(),
    roomKinds: new Map(),
    roomGetCalls: new Map(),
    rooms: [],
    history: new Map(),
    historyCursorStuck: false,
    historyGeneration: 1,
    historyCalls: [],
    pendingListCalls: 0,
    loginPending: null,
    loginHeadSeq: null,
    listenFailures: options.listenFailures ?? 0,
    inboxFailures: options.inboxFailures ?? 0,
    memoryCalls: [],
    memoryFailures: 0,
    memoryErrorCode: 'MEMORY_UNAVAILABLE',
    memoryDelayMs: 0,
    memoryReason: null,
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
        params?: { name?: string; arguments?: JsonObject; _meta?: JsonObject };
      };
      if (options.credentialInvalid) {
        return new Response('unauthorized', { status: 401 });
      }
      const method = body.method ?? '';
      const meta = body.params?._meta;
      if (request.headers.get('mcp-method') !== method) {
        return protocolReject(body.id, 'Mcp-Method header does not match body method');
      }
      if (request.headers.get('mcp-protocol-version') !== '2026-07-28') {
        return protocolReject(body.id, 'MCP-Protocol-Version header missing');
      }
      if (
        meta === undefined ||
        meta['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28' ||
        typeof meta['io.modelcontextprotocol/clientInfo'] !== 'object' ||
        !('io.modelcontextprotocol/clientCapabilities' in meta)
      ) {
        return protocolReject(body.id, 'params._meta is missing protocol envelope keys');
      }
      if (method === 'tools/call' && request.headers.get('mcp-name') !== body.params?.name) {
        return protocolReject(body.id, 'MCP-Name header does not match params.name');
      }
      if (body.method === 'server/discover') {
        return rpc(body.id, { supportedVersions: ['2026-07-28'] });
      }
      if (body.method === 'subscriptions/listen') {
        if (state.listenFailures > 0) {
          state.listenFailures -= 1;
          return new Response('subscription unavailable', { status: 500 });
        }
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
          return toolResult(body.id, { actor_id: 'agt_me', kind: options.meKind ?? 'agent' });
        case 'network_login':
          return toolResult(body.id, {
            online: true,
            pending_count: state.loginPending ?? state.pending.size,
            inbox_head_seq: state.loginHeadSeq ?? '1',
          });
        case 'network_memory_context_pack': {
          state.memoryCalls.push(args);
          if (state.memoryDelayMs > 0) await Bun.sleep(state.memoryDelayMs);
          if (state.memoryFailures > 0) {
            state.memoryFailures -= 1;
            return toolError(body.id, state.memoryErrorCode, 'memory backend unavailable');
          }
          if (state.memoryReason !== null) {
            return toolResult(body.id, {
              pack_id: 'mpk_test_empty',
              trigger: 'message',
              available: false,
              reason: state.memoryReason,
              authority: 'reference_data',
              as_of: 1,
              expires_at: 2,
              room_id: String(args.room_id ?? ''),
              message_id: args.message_id ?? null,
              items: [],
              item_count: 0,
              items_bytes: 0,
              truncated: false,
              omitted: 0,
              stats: { sources: 0, experiences: 0, rooms: 0 },
              semantic: { status: 'not_requested', context_ref: null },
              injection: { eligible: false, admit_required: true, reason: 'advisory_only' },
            });
          }
          return toolResult(body.id, {
            pack_id: 'mpk_test_ready',
            trigger: 'message',
            available: true,
            reason: 'ready',
            authority: 'reference_data',
            as_of: 1,
            expires_at: 2,
            room_id: String(args.room_id ?? ''),
            message_id: args.message_id ?? null,
            items: [
              {
                item_id: 'exp:test',
                kind: 'experience',
                text: 'injected-memory-marker',
                text_bytes: 22,
                origin_room_id: String(args.room_id ?? ''),
                source_message_id: null,
                sender_id: 'agt_user',
                evidence: 'experienced',
                source_kind: 'message',
              },
            ],
            item_count: 1,
            items_bytes: 22,
            truncated: false,
            omitted: 0,
            stats: { sources: 0, experiences: 1, rooms: 1 },
            semantic: { status: 'not_requested', context_ref: null },
            injection: { eligible: false, admit_required: true, reason: 'advisory_only' },
          });
        }
        case 'network_room_get': {
          const roomId = String(args.room_id ?? '');
          state.roomGetCalls.set(roomId, (state.roomGetCalls.get(roomId) ?? 0) + 1);
          const kind = state.roomKinds.get(roomId);
          if (!kind) return toolError(body.id, 'INVALID_ARGUMENT', 'room not found');
          return toolResult(body.id, { room: { room_id: roomId, kind } });
        }
        case 'network_rooms_list': {
          const offset = Number(args.cursor ?? 0);
          const limit = Number(args.limit ?? 50);
          const rooms = state.rooms.slice(offset, offset + limit);
          return toolResult(body.id, {
            items: rooms.map((roomId) => ({ room_id: roomId, kind: 'group', head_seq: '0' })),
            next_cursor: offset + limit < state.rooms.length ? String(offset + limit) : null,
            has_more: offset + limit < state.rooms.length,
          });
        }
        case 'network_history_list': {
          const roomId = String(args.room_id ?? '');
          const direction = String(args.direction ?? 'before');
          const items = state.history.get(roomId) ?? [];
          const cursor = args.cursor === undefined ? null : String(args.cursor);
          state.historyCalls.push({ room_id: roomId, cursor, direction });
          const cursorState = cursor === null ? null : decodeHistoryCursor(cursor);
          if (cursorState !== null && cursorState.generation !== state.historyGeneration) {
            return toolError(body.id, 'CURSOR_EXPIRED', '成员代次或历史边界已变化，请重新读取');
          }
          const start =
            cursor === null
              ? direction === 'after'
                ? items.length
                : 0
              : Math.max(0, cursorState?.seq ?? 0);
          const limit = Number(args.limit ?? 50);
          const page = items.slice(start, start + limit);
          const last = page.at(-1);
          const lastSeq = last === undefined ? null : Number(last.created_seq);
          const snapshot = items.length;
          const nextSeq = state.historyCursorStuck
            ? (cursorState?.seq ?? start)
            : (lastSeq ?? Math.max(cursorState?.seq ?? 0, snapshot));
          return toolResult(body.id, {
            items: page,
            next_cursor: encodeHistoryCursor(nextSeq, snapshot, state.historyGeneration),
            has_more: start + limit < items.length,
            snapshot: String(snapshot),
            head_seq: String(snapshot),
          });
        }
        case 'network_inbox_list': {
          const wanted = String(args.state ?? 'active');
          if (wanted === 'pending') state.pendingListCalls += 1;
          if (wanted === 'pending' && state.inboxFailures > 0) {
            state.inboxFailures -= 1;
            return toolError(body.id, 'UNAVAILABLE', 'inbox temporarily unavailable');
          }
          const items = wanted === 'claimed' ? [...state.claims.values()] : [...state.pending.values()];
          const offset = Number(args.cursor ?? 0);
          const limit = Number(args.limit ?? 50);
          return toolResult(body.id, {
            items: items.slice(offset, offset + limit),
            next_cursor: offset + limit < items.length ? String(offset + limit) : null,
            has_more: offset + limit < items.length,
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
          const quote = state.quotes.get(messageId) ?? null;
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
                ...(quote ? { reply_to: String(quote.message_id ?? ''), quote } : {}),
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
            reply_to: quote ? String(quote.message_id ?? '') : null,
            quote,
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

function roomItem(
  roomId: string,
  messageId: string,
  options: {
    senderId?: string;
    seq?: string;
    eventId?: string;
    senderName?: string | null;
    senderKind?: string | null;
    change?: string;
  } = {},
): JsonObject {
  return {
    source: 'room.message',
    kind: 'message',
    attention: 'informational',
    room_id: roomId,
    message_id: messageId,
    sender_id: options.senderId ?? 'agt_user',
    sender_name: options.senderName ?? null,
    sender_kind: options.senderKind ?? null,
    ...(options.change === undefined ? {} : { change: options.change }),
    seq: options.seq ?? '9',
    event_id: options.eventId ?? `evt_${messageId}`,
    created_at: new Date().toISOString(),
  };
}

function streamItem(
  source: string,
  fields: JsonObject = {},
): JsonObject {
  return {
    source,
    kind: 'room',
    attention: 'informational',
    seq: '9',
    event_id: `evt_${source}_${String(fields.message_id ?? fields.delivery_id ?? '')}`,
    created_at: new Date().toISOString(),
    ...fields,
  };
}

function historyMessage(  roomId: string,
  messageId: string,
  seq: number,
  senderId = 'agt_user',
): JsonObject {
  return {
    message_id: messageId,
    room_id: roomId,
    sender_id: senderId,
    created_seq: String(seq),
    preview: 'history-preview-should-not-leak',
    created_at: new Date().toISOString(),
  };
}

function encodeHistoryCursor(seq: number, snapshot: number, generation = 1): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scope: `room:rm_test:history:g${generation}`,
      dir: 'after',
      seq,
      snapshot,
    }),
    'utf8',
  ).toString('base64url');
}

function decodeHistoryCursor(
  cursor: string,
): { seq: number; snapshot: number; generation: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      seq?: unknown;
      snapshot?: unknown;
      scope?: unknown;
    };
    if (typeof parsed.seq !== 'number' || typeof parsed.snapshot !== 'number') return null;
    const match = typeof parsed.scope === 'string' ? /:g(\d+)$/u.exec(parsed.scope) : null;
    return {
      seq: parsed.seq,
      snapshot: parsed.snapshot,
      generation: match === null ? 0 : Number(match[1]),
    };
  } catch {
    return null;
  }
}

function sendItems(
  mock: MockServer,
  items: JsonObject[],
  options: { more?: boolean; dropped?: number } = {},
): void {
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
          more: options.more ?? false,
          dropped: options.dropped ?? 0,
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

function startWatcher(
  base: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): RunningWatcher {
  return startProcess([process.execPath, CLI, 'monitor', '--harness', 'claude', ...extraArgs], {
    AGENTNET_URL: base,
    AGENTNET_TOKEN: TOKEN,
    // 每个 watcher 独立状态目录，避免持久游标/seen 在测试间串扰。
    AGENTNET_MONITOR_STATE_DIR: mkdtempSync(join(tmpdir(), 'ts-monitor-claude-')),
    ...extraEnv,
  });
}

function startPeriWatcher(
  base: string,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): RunningWatcher {
  return startProcess([process.execPath, CLI, 'monitor', '--harness', 'peri', ...extraArgs], {
    AGENTNET_URL: base,
    AGENTNET_TOKEN: TOKEN,
    AGENTNET_MONITOR_STATE_DIR: mkdtempSync(join(tmpdir(), 'ts-monitor-peri-')),
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

async function waitForRoomEvent(
  lines: string[],
  messageId: string,
  timeoutMs = 10_000,
): Promise<JsonObject> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const line of lines) {
      const event = parseEvent(line);
      if (event?.type === 'room_message' && event.message_id === messageId) return event;
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `timeout waiting for room_message/${messageId}; lines=${JSON.stringify(lines)}`,
  );
}

async function waitForStreamEvent(
  lines: string[],
  source: string,
  predicate: (event: JsonObject) => boolean = () => true,
  timeoutMs = 10_000,
): Promise<JsonObject> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const line of lines) {
      const event = parseEvent(line);
      if (event?.type === 'stream_event' && event.source === source && predicate(event)) {
        return event;
      }
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `timeout waiting for stream_event/${source}; lines=${JSON.stringify(lines)}`,
  );
}

async function waitForDeliveryState(
  lines: string[],
  deliveryId: string,
  state?: string,
  timeoutMs = 10_000,
): Promise<JsonObject> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const line of lines) {
      const event = parseEvent(line);
      if (event?.type !== 'delivery_state' || event.delivery_id !== deliveryId) continue;
      if (state !== undefined && event.state !== state) continue;
      return event;
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `timeout waiting for delivery_state/${deliveryId}/${state ?? '*'}; lines=${JSON.stringify(lines)}`,
  );
}

async function waitForHistoryCall(
  mock: MockServer,
  predicate: (call: { room_id: string; cursor: string | null; direction: string }) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<{ room_id: string; cursor: string | null; direction: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = mock.state.historyCalls.find(predicate);
    if (found) return found;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
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

function roomEventCount(lines: string[], messageId: string): number {
  return lines.reduce((count, line) => {
    const event = parseEvent(line);
    return event?.type === 'room_message' && event.message_id === messageId ? count + 1 : count;
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
  // 本组保留手动重连快照语义，避免自动 deferred 重试打乱既有断言；
  // 自动重试由 runMonitorRetryChecks 单独覆盖。
  const watcher = startWatcher(mock.base, { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' });
  try {
    const ready = await waitForLine(watcher.stderr, (line) => line.includes('READY'), 'claude READY');
    check('READY 写 stderr 并带 actor/subscription', /READY actor=agt_me pending=\d+ subscription=sub-/.test(ready));
    check('stderr 不含 token', !watcher.stderr.join('\n').includes(TOKEN));

    for (let index = 0; index < 50; index += 1) {
      const own = delivery(`dlv_own_${index}`);
      own.message.sender_id = 'agt_me';
      mock.state.pending.set(own.delivery_id, own);
    }
    mock.state.pending.set('dlv_second_page', delivery('dlv_second_page'));
    sendItems(mock, [notificationItem('dlv_second_page', 'delivery.created', 'evt_second_page')]);
    await waitForEvent(watcher.stdout, 'delivery', 'dlv_second_page');
    checkEqual('通知匹配第二页 pending 后自动领取', mock.state.claimCalls.get('dlv_second_page'), 1);
    mock.state.pending.clear();
    mock.state.claims.clear();

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
    check('无引用时不带 quote 字段', !('quote' in ok));
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
      'deferred hint 提示 complete/fail 与自动退避重试',
      typeof deferred.hint === 'string' &&
        deferred.hint.includes('complete/fail') &&
        deferred.hint.includes('自动重试'),
    );
    check(
      'deferred 带重试轮次与间隔',
      typeof deferred.retry_attempt === 'number' && typeof deferred.retry_in_ms === 'number',
      deferred,
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

async function runDeliveryQuoteChecks(): Promise<void> {
  const mock = createMock();
  // 关闭记忆上下文，单独断言 quote 字段与既有事件键顺序。
  const watcher = startWatcher(
    mock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' },
    ['--no-memory-context'],
  );
  try {
    await waitForLine(watcher.stderr, (line) => line.includes('READY'), 'quote READY');
    const quote = {
      message_id: 'msg_parent_quote',
      sender_id: 'agt_quote_parent',
      sender_name: '引用作者',
      sender_kind: 'human',
      preview: '被引用的父消息预览',
      created_at: '2026-11-04T10:00:00.000Z',
    };
    mock.state.quotes.set('msg_dlv_quote', quote);
    mock.state.pending.set('dlv_quote', delivery('dlv_quote'));
    const beforeReads = mock.state.readCalls;
    sendItems(mock, [notificationItem('dlv_quote', 'delivery.created', 'evt_quote')]);
    const event = await waitForEvent(watcher.stdout, 'delivery', 'dlv_quote');
    checkEqual('引用投递只读取一次', mock.state.readCalls - beforeReads, 1);
    checkEqual('引用事件包含结构化 quote', JSON.stringify(event.quote), JSON.stringify(quote));
    checkEqual('引用事件正文完整', event.body, messageBody('msg_dlv_quote'));
    check(
      '引用文本不拼进正文',
      typeof event.body === 'string' && !event.body.includes(quote.preview),
      event.body,
    );
    checkEqual(
      '引用事件 quote 位于末尾',
      keysOf(event),
      'type,delivery_id,room_id,message_id,sender_id,event_id,seq,attempt,claim_id,claimed_at,auto_claimed,claim_state,claim,source,body,body_bytes,body_truncated,event_file,quote',
    );
    const quotedFile = JSON.parse(
      readFileSync(String(event.event_file ?? ''), 'utf8'),
    ) as JsonObject;
    checkEqual('引用 event_file 含 quote', JSON.stringify(quotedFile.quote), JSON.stringify(quote));
    checkEqual('引用 event_file 正文不含引用', quotedFile.body, messageBody('msg_dlv_quote'));

    // 缺失 quote：只省略字段，正文照常投递，读取次数不增加。
    mock.state.claims.clear();
    mock.state.pending.set('dlv_no_quote', delivery('dlv_no_quote'));
    const beforePlain = mock.state.readCalls;
    sendItems(mock, [notificationItem('dlv_no_quote', 'delivery.created', 'evt_no_quote')]);
    const plain = await waitForEvent(watcher.stdout, 'delivery', 'dlv_no_quote');
    check('缺失 quote 时事件不带 quote', !('quote' in plain));
    checkEqual('缺失 quote 时正文完整', plain.body, messageBody('msg_dlv_no_quote'));
    checkEqual('缺失 quote 时读取次数仍为 1', mock.state.readCalls - beforePlain, 1);
  } finally {
    await watcher.kill();
    mock.stop();
  }
}

async function runMemoryContextChecks(): Promise<void> {
  // 失败分类：只有明确关闭/工具缺失才全局停用。
  const classify = async (outcome: { ok: false; code: string; message: string }) =>
    fetchMemoryPack(
      { callTool: async () => outcome },
      { roomId: 'rm_test', messageId: 'msg_mem_classify' },
    );
  checkEqual(
    'UNKNOWN 不全局停用',
    (await classify({ ok: false, code: 'UNKNOWN', message: 'boom' })).disabled,
    false,
  );
  checkEqual(
    'MEMORY_DISABLED 全局停用',
    (await classify({ ok: false, code: 'MEMORY_DISABLED', message: 'Memory 未启用' })).disabled,
    true,
  );
  checkEqual(
    'tool not found 全局停用',
    (
      await classify({
        ok: false,
        code: 'UNKNOWN',
        message: 'Tool network_memory_context_pack not found',
      })
    ).disabled,
    true,
  );
  checkEqual(
    'method not found 全局停用',
    (await classify({ ok: false, code: 'UNKNOWN', message: 'Method not found: tools/call' }))
      .disabled,
    true,
  );

  // claude：full 包进入 stdout delivery 与 event_file；每投递一次。
  const mock = createMock();
  const watcher = startWatcher(mock.base, { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' });
  try {
    await waitForLine(watcher.stderr, (line) => line.includes('READY'), 'memory READY');
    mock.state.pending.set('dlv_mem', delivery('dlv_mem'));
    sendItems(mock, [notificationItem('dlv_mem', 'delivery.created', 'evt_mem')]);
    const event = await waitForEvent(watcher.stdout, 'delivery', 'dlv_mem');
    const memory = event.memory_context as JsonObject;
    checkEqual('claude delivery 带 memory_context', memory.available, true);
    checkEqual('claude memory_pack_id', event.memory_pack_id, 'mpk_test_ready');
    checkEqual('claude memory bytes', event.memory_context_bytes, 22);
    checkEqual('claude memory truncated', event.memory_context_truncated, false);
    check(
      'claude 记忆块含正文',
      JSON.stringify(memory.items).includes('injected-memory-marker'),
      memory,
    );
    checkEqual('每 delivery 调用一次 pack', mock.state.memoryCalls.length, 1);
    checkEqual('pack 带 room_id', mock.state.memoryCalls[0]?.room_id, 'rm_test');
    checkEqual('pack 带 message_id', mock.state.memoryCalls[0]?.message_id, 'msg_dlv_mem');
    const eventFile = String(event.event_file ?? '');
    const file = JSON.parse(readFileSync(eventFile, 'utf8')) as JsonObject;
    check('event_file 带完整 memory_context', JSON.stringify(file.memory_context).includes('injected-memory-marker'));
    checkEqual('event_file memory_pack_id', file.memory_pack_id, 'mpk_test_ready');

    // 重连后同一 delivery 不重复注入。
    mock.closeStream();
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'memory reconnect READY',
    );
    await Bun.sleep(200);
    checkEqual('重连不重复调用 pack', mock.state.memoryCalls.length, 1);
    checkEqual('重连不重复输出 delivery', eventCount(watcher.stdout, 'delivery', 'dlv_mem'), 1);

    // 失败不阻塞 delivery，也不重试同一投递。
    mock.state.claims.clear();
    mock.state.memoryFailures = 1;
    mock.state.pending.set('dlv_mem_fail', delivery('dlv_mem_fail'));
    sendItems(mock, [notificationItem('dlv_mem_fail', 'delivery.created', 'evt_mem_fail')]);
    const failed = await waitForEvent(watcher.stdout, 'delivery', 'dlv_mem_fail');
    check('memory 失败仍输出 delivery', failed.claim_state === 'claimed');
    const failedMemory = failed.memory_context as JsonObject;
    checkEqual('memory 失败降级 available=false', failedMemory.available, false);
    checkEqual('memory 失败 reason=request_failed', failedMemory.reason, 'request_failed');
    checkEqual('失败投递只调用一次', mock.state.memoryCalls.length, 2);

    // 超时不阻塞 delivery。
    mock.state.claims.clear();
    mock.state.memoryDelayMs = 2_500;
    mock.state.pending.set('dlv_mem_timeout', delivery('dlv_mem_timeout'));
    sendItems(mock, [notificationItem('dlv_mem_timeout', 'delivery.created', 'evt_mem_timeout')]);
    const timed = await waitForEvent(watcher.stdout, 'delivery', 'dlv_mem_timeout');
    checkEqual('memory 超时仍输出 delivery', timed.claim_state, 'claimed');
    checkEqual('memory 超时 reason=timeout', (timed.memory_context as JsonObject).reason, 'timeout');
    checkEqual('超时投递只调用一次', mock.state.memoryCalls.length, 3);
    mock.state.memoryDelayMs = 0;

    // UNKNOWN 只降级当前投递，下一次 delivery 仍调用工具。
    mock.state.claims.clear();
    mock.state.memoryFailures = 1;
    mock.state.memoryErrorCode = 'UNKNOWN';
    mock.state.pending.set('dlv_mem_unknown', delivery('dlv_mem_unknown'));
    sendItems(mock, [
      notificationItem('dlv_mem_unknown', 'delivery.created', 'evt_mem_unknown'),
    ]);
    const unknown = await waitForEvent(watcher.stdout, 'delivery', 'dlv_mem_unknown');
    checkEqual(
      'UNKNOWN 降级当前投递',
      (unknown.memory_context as JsonObject).reason,
      'request_failed',
    );
    checkEqual('UNKNOWN 投递调用一次', mock.state.memoryCalls.length, 4);

    mock.state.claims.clear();
    mock.state.pending.set('dlv_mem_unknown_next', delivery('dlv_mem_unknown_next'));
    sendItems(mock, [
      notificationItem('dlv_mem_unknown_next', 'delivery.created', 'evt_mem_unknown_next'),
    ]);
    await waitForEvent(watcher.stdout, 'delivery', 'dlv_mem_unknown_next');
    checkEqual('UNKNOWN 后下一次仍调用', mock.state.memoryCalls.length, 5);

    // 只有 MEMORY_DISABLED 才全局停用后续投递。
    mock.state.claims.clear();
    mock.state.memoryFailures = 1;
    mock.state.memoryErrorCode = 'MEMORY_DISABLED';
    mock.state.pending.set('dlv_mem_disabled', delivery('dlv_mem_disabled'));
    sendItems(mock, [
      notificationItem('dlv_mem_disabled', 'delivery.created', 'evt_mem_disabled'),
    ]);
    const disabled = await waitForEvent(watcher.stdout, 'delivery', 'dlv_mem_disabled');
    checkEqual(
      'MEMORY_DISABLED 降级当前投递',
      (disabled.memory_context as JsonObject).reason,
      'memory_disabled',
    );
    checkEqual('MEMORY_DISABLED 投递调用一次', mock.state.memoryCalls.length, 6);

    mock.state.claims.clear();
    mock.state.pending.set('dlv_mem_disabled_next', delivery('dlv_mem_disabled_next'));
    sendItems(mock, [
      notificationItem('dlv_mem_disabled_next', 'delivery.created', 'evt_mem_disabled_next'),
    ]);
    const disabledNext = await waitForEvent(watcher.stdout, 'delivery', 'dlv_mem_disabled_next');
    checkEqual('MEMORY_DISABLED 后不再调用', mock.state.memoryCalls.length, 6);
    checkEqual(
      'MEMORY_DISABLED 后 reason 稳定',
      (disabledNext.memory_context as JsonObject).reason,
      'memory_disabled',
    );
  } finally {
    await watcher.kill();
    mock.stop();
  }

  // --no-memory-context 完全不调用工具，也不输出记忆字段。
  const offMock = createMock();
  const offWatcher = startWatcher(
    offMock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' },
    ['--no-memory-context'],
  );
  try {
    await waitForLine(offWatcher.stderr, (line) => line.includes('READY'), 'memory off READY');
    offMock.state.pending.set('dlv_mem_off', delivery('dlv_mem_off'));
    sendItems(offMock, [notificationItem('dlv_mem_off', 'delivery.created', 'evt_mem_off')]);
    const event = await waitForEvent(offWatcher.stdout, 'delivery', 'dlv_mem_off');
    checkEqual('--no-memory-context 不调用工具', offMock.state.memoryCalls.length, 0);
    check('--no-memory-context 不输出 memory_context', !('memory_context' in event));
    check('--no-memory-context 不输出 memory_pack_id', !('memory_pack_id' in event));
  } finally {
    await offWatcher.kill();
    offMock.stop();
  }

  // peri：默认 pointer，只输出 pack id/条数/原因，不含正文。
  const periMock = createMock();
  const periWatcher = startPeriWatcher(periMock.base, {
    AGENTNET_MONITOR_RETRY_BASE_MS: '600000',
  });
  try {
    await waitForLine(periWatcher.stdout, (line) => line.includes('READY'), 'peri memory READY');
    periMock.state.pending.set('dlv_mem_peri', delivery('dlv_mem_peri'));
    sendItems(periMock, [
      notificationItem('dlv_mem_peri', 'delivery.created', 'evt_mem_peri'),
    ]);
    const event = await waitForAlert(periWatcher.stdout, 'delivery', 'dlv_mem_peri');
    checkEqual('peri pointer pack_id', event.memory_pack_id, 'mpk_test_ready');
    checkEqual('peri pointer items', event.memory_items, 1);
    checkEqual('peri pointer reason', event.memory_reason, 'ready');
    check('peri 默认不含记忆正文', !JSON.stringify(event).includes('injected-memory-marker'));
    checkEqual('peri 每 delivery 调用一次', periMock.state.memoryCalls.length, 1);
  } finally {
    await periWatcher.kill();
    periMock.stop();
  }
}

async function runRoomEventChecks(): Promise<void> {
  // 默认开启：即使没有 --room-events，也输出所有房间活动。
  const defaultMock = createMock();
  const defaultWatcher = startWatcher(defaultMock.base, {
    AGENTNET_MONITOR_RETRY_BASE_MS: '600000',
  });
  try {
    await waitForLine(defaultWatcher.stderr, (line) => line.includes('READY'), 'default READY');
    sendItems(defaultMock, [roomItem('rm_allowed', 'msg_default_on')]);
    await waitForRoomEvent(defaultWatcher.stdout, 'msg_default_on');
    checkEqual(
      '默认开启输出 room_message',
      roomEventCount(defaultWatcher.stdout, 'msg_default_on'),
      1,
    );
  } finally {
    await defaultWatcher.kill();
    defaultMock.stop();
  }

  // --no-room-events 关闭 informational 输出，但投递/提醒仍可用。
  const offMock = createMock();
  const offWatcher = startWatcher(
    offMock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' },
    ['--no-room-events'],
  );
  try {
    await waitForLine(offWatcher.stderr, (line) => line.includes('READY'), 'room-events off READY');
    sendItems(offMock, [
      roomItem('rm_allowed', 'msg_off'),
      streamItem('room.membership', {
        attention: 'action_required',
        change: 'removed',
        room_id: 'rm_allowed',
        seq: '21',
        event_id: 'evt_off_membership',
      }),
    ]);
    await waitForStreamEvent(offWatcher.stdout, 'room.membership');
    await Bun.sleep(700);
    checkEqual('--no-room-events 不输出 room_message', roomEventCount(offWatcher.stdout, 'msg_off'), 0);
    checkEqual(
      '--no-room-events 仍保留 action_required',
      offWatcher.stdout.filter((line) => {
        const event = parseEvent(line);
        return event?.type === 'stream_event' && event.source === 'room.membership';
      }).length,
      1,
    );

    // 关闭 informational 房间事件后，发送方回执、提醒、邀请与真实投递仍必须输出。
    const offDeliveryId = 'dlv_off_live';
    offMock.state.pending.set(offDeliveryId, delivery(offDeliveryId));
    sendItems(offMock, [
      notificationItem(offDeliveryId, 'delivery.created', 'evt_off_delivery'),
      streamItem('delivery.updated', {
        kind: 'receipt',
        attention: 'action_required',
        delivery_id: 'dlv_off_completed',
        room_id: 'rm_allowed',
        state: 'completed',
        attempt: 1,
        seq: '22',
        event_id: 'evt_off_completed',
      }),
      streamItem('delivery.updated', {
        kind: 'receipt',
        attention: 'action_required',
        delivery_id: 'dlv_off_failed',
        room_id: 'rm_allowed',
        state: 'failed',
        attempt: 1,
        seq: '23',
        event_id: 'evt_off_failed',
      }),
      streamItem('delivery.updated', {
        kind: 'receipt',
        delivery_id: 'dlv_off_claimed',
        room_id: 'rm_allowed',
        state: 'claimed',
        attempt: 1,
        seq: '24',
        event_id: 'evt_off_claimed',
      }),
      streamItem('mention.reminder', {
        kind: 'reminder',
        room_id: 'rm_allowed',
        message_id: 'msg_off_mention',
        seq: '25',
        event_id: 'evt_off_mention',
      }),
      streamItem('room.membership', {
        kind: 'room',
        attention: 'action_required',
        change: 'invited',
        room_id: 'rm_allowed',
        seq: '26',
        event_id: 'evt_off_invited',
      }),
      roomItem('rm_allowed', 'msg_off_pure_info', { seq: '27', eventId: 'evt_off_pure_info' }),
      streamItem('room.file', {
        kind: 'file',
        room_id: 'rm_allowed',
        file_id: 'file_off',
        seq: '28',
        event_id: 'evt_off_file',
      }),
    ]);

    const offDelivery = await waitForEvent(offWatcher.stdout, 'delivery', offDeliveryId);
    checkEqual('--no-room-events 仍输出真实 delivery', offDelivery.claim_state, 'claimed');
    checkEqual(
      '--no-room-events 真实 delivery 仍只 claim 一次',
      offMock.state.claimCalls.get(offDeliveryId),
      1,
    );
    const offCompleted = await waitForDeliveryState(
      offWatcher.stdout,
      'dlv_off_completed',
      'completed',
    );
    checkEqual(
      '--no-room-events 保留发送方 completed 回执',
      offCompleted.attention,
      'action_required',
    );
    const offFailed = await waitForDeliveryState(offWatcher.stdout, 'dlv_off_failed', 'failed');
    checkEqual('--no-room-events 保留发送方 failed 回执', offFailed.attention, 'action_required');
    const offMention = await waitForStreamEvent(offWatcher.stdout, 'mention.reminder');
    checkEqual('--no-room-events 保留 mention.reminder', offMention.message_id, 'msg_off_mention');
    const offInvite = await waitForStreamEvent(
      offWatcher.stdout,
      'room.membership',
      (event) => event.change === 'invited',
    );
    checkEqual('--no-room-events 保留邀请 membership', offInvite.change, 'invited');

    await Bun.sleep(700);
    checkEqual(
      '--no-room-events 不输出纯 informational room_message',
      roomEventCount(offWatcher.stdout, 'msg_off_pure_info'),
      0,
    );
    checkEqual(
      '--no-room-events 不输出 informational 回执',
      offWatcher.stdout.filter((line) => {
        const event = parseEvent(line);
        return event?.type === 'delivery_state' && event.delivery_id === 'dlv_off_claimed';
      }).length,
      0,
    );
    checkEqual(
      '--no-room-events 不输出 informational room.file',
      offWatcher.stdout.filter((line) => {
        const event = parseEvent(line);
        return event?.type === 'stream_event' && event.source === 'room.file';
      }).length,
      0,
    );
  } finally {
    await offWatcher.kill();
    offMock.stop();
  }

  const mock = createMock();
  mock.state.rooms = ['rm_allowed', 'rm_other'];
  const watcher = startWatcher(
    mock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' },
    ['--room-events'],
  );
  try {
    await waitForLine(watcher.stderr, (line) => line.includes('READY'), 'room-events READY');
    const baseline = await waitForHistoryCall(
      mock,
      (call) => call.room_id === 'rm_allowed' && call.cursor === null,
      'initial room history baseline',
    );
    await waitForHistoryCall(
      mock,
      (call) => call.room_id === 'rm_other' && call.cursor === null,
      'initial second room history baseline',
    );
    checkEqual('首次连接 history 基线使用 after', baseline.direction, 'after');
    checkEqual(
      '默认监听所有房间，各取一次基线',
      mock.state.historyCalls.filter((call) => call.cursor === null).length,
      2,
    );

    // 所有房间、自己发送与未 @ 的消息都输出；不做业务筛选。
    const inboxBefore = mock.state.pendingListCalls;
    sendItems(mock, [
      roomItem('rm_other', 'msg_other_room'),
      roomItem('rm_allowed', 'msg_self', { senderId: 'agt_me' }),
      roomItem('rm_allowed', 'msg_info', {
        seq: '11',
        senderName: 'Alice',
        senderKind: 'human',
      }),
    ]);
    const info = await waitForRoomEvent(watcher.stdout, 'msg_info');
    await waitForRoomEvent(watcher.stdout, 'msg_other_room');
    await waitForRoomEvent(watcher.stdout, 'msg_self');
    checkEqual('room_message room_id', info.room_id, 'rm_allowed');
    checkEqual('room_message message_id', info.message_id, 'msg_info');
    checkEqual('room_message sender_id', info.sender_id, 'agt_user');
    checkEqual('room_message sender_name', info.sender_name, 'Alice');
    checkEqual('room_message sender_kind', info.sender_kind, 'human');
    checkEqual('room_message change 缺失为 null', info.change, null);
    checkEqual('room_message item_kind 保留 stream item kind', info.item_kind, 'message');
    checkEqual('room_message seq', info.seq, '11');
    checkEqual('room_message source', info.source, 'stream');
    check('room_message 不带正文', !('body' in info));
    check('room_message 不带 preview', !('preview' in info));
    checkEqual('输出自己发送的消息', roomEventCount(watcher.stdout, 'msg_self'), 1);
    checkEqual('输出其他房间消息', roomEventCount(watcher.stdout, 'msg_other_room'), 1);
    checkEqual('纯 informational 帧不查询 pending inbox', mock.state.pendingListCalls, inboxBefore);

    // 撤回是同一 message_id 的独立变更，不能被普通消息去重吞掉。
    sendItems(mock, [roomItem('rm_allowed', 'msg_recall', { seq: '12' })]);
    await waitForRoomEvent(watcher.stdout, 'msg_recall');
    sendItems(mock, [
      roomItem('rm_allowed', 'msg_recall', {
        seq: '12',
        eventId: 'evt_msg_recall_changed',
        change: 'recalled',
      }),
    ]);
    await waitForLine(
      watcher.stdout,
      (line) => {
        const event = parseEvent(line);
        return (
          event?.type === 'room_message' &&
          event.message_id === 'msg_recall' &&
          event.change === 'recalled'
        );
      },
      'room_message recall change',
    );
    checkEqual(
      '撤回作为独立变更输出',
      watcher.stdout.filter((line) => {
        const event = parseEvent(line);
        return event?.type === 'room_message' && event.message_id === 'msg_recall';
      }).length,
      2,
    );

    // 所有 informational/action_required stream item 都输出；不按 source 过滤。
    const claimCallsBefore = mock.state.claimCalls.size;
    const pendingCallsBefore = mock.state.pendingListCalls;
    sendItems(mock, [
      streamItem('room.membership', {
        attention: 'action_required',
        change: 'removed',
        room_id: 'rm_allowed',
        subject_id: 'agt_me',
        seq: '20',
        event_id: 'evt_membership',
      }),
      streamItem('room.created', {
        change: 'created',
        room_id: 'rm_new',
        seq: '21',
        event_id: 'evt_room_created',
      }),
      streamItem('room.lifecycle', {
        change: 'dissolved',
        room_id: 'rm_old',
        seq: '22',
        event_id: 'evt_room_lifecycle',
      }),
      streamItem('room.file', {
        kind: 'file',
        change: 'added',
        ref_id: 'file_1',
        file_id: 'file_1',
        room_id: 'rm_allowed',
        seq: '23',
        event_id: 'evt_room_file',
      }),
      streamItem('room.presence', {
        kind: 'presence',
        subject_id: 'agt_peer',
        transition: 'online',
        room_id: 'rm_allowed',
        seq: '24',
        event_id: 'evt_room_presence',
      }),
      streamItem('task.updated', {
        kind: 'task',
        change: 'marked',
        ref_id: 'msg_root',
        room_id: 'rm_allowed',
        seq: '25',
        event_id: 'evt_task',
      }),
      streamItem('room.read', {
        kind: 'read',
        room_id: 'rm_allowed',
        seq: '26',
        event_id: 'evt_room_read',
      }),
      streamItem('contact', {
        kind: 'contact',
        change: 'request_pending',
        ref_id: 'req_1',
        seq: '27',
        event_id: 'evt_contact',
      }),
      streamItem('device', {
        kind: 'device',
        change: 'paired',
        ref_id: 'dev_1',
        seq: '28',
        event_id: 'evt_device',
      }),
      streamItem('profile.updated', {
        kind: 'profile',
        seq: '29',
        event_id: 'evt_profile',
      }),
      streamItem('unknown', {
        kind: 'raw',
        ref_id: 'raw_1',
        seq: '30',
        event_id: 'evt_unknown',
      }),
      streamItem('mention.reminder', {
        kind: 'reminder',
        room_id: 'rm_allowed',
        message_id: 'msg_mention',
        mention_all: true,
        seq: '31',
        event_id: 'evt_mention',
      }),
    ]);

    const membership = await waitForStreamEvent(watcher.stdout, 'room.membership');
    const created = await waitForStreamEvent(watcher.stdout, 'room.created');
    const lifecycle = await waitForStreamEvent(watcher.stdout, 'room.lifecycle');
    const file = await waitForStreamEvent(watcher.stdout, 'room.file');
    const presence = await waitForStreamEvent(watcher.stdout, 'room.presence');
    const task = await waitForStreamEvent(watcher.stdout, 'task.updated');
    await waitForStreamEvent(watcher.stdout, 'room.read');
    const contact = await waitForStreamEvent(watcher.stdout, 'contact');
    const device = await waitForStreamEvent(watcher.stdout, 'device');
    await waitForStreamEvent(watcher.stdout, 'profile.updated');
    const unknown = await waitForStreamEvent(watcher.stdout, 'unknown');
    const mention = await waitForStreamEvent(watcher.stdout, 'mention.reminder');

    checkEqual('room.membership kind', membership.kind, 'room');
    checkEqual('room.membership change', membership.change, 'removed');
    checkEqual('room.membership attention', membership.attention, 'action_required');
    checkEqual('room.membership subject_id', membership.subject_id, 'agt_me');
    checkEqual('room.created change', created.change, 'created');
    checkEqual('room.lifecycle change', lifecycle.change, 'dissolved');
    checkEqual('room.file kind', file.kind, 'file');
    checkEqual('room.file ref_id', file.ref_id, 'file_1');
    checkEqual('room.file file_id', file.file_id, 'file_1');
    checkEqual('room.presence subject_id', presence.subject_id, 'agt_peer');
    checkEqual('task.updated change', task.change, 'marked');
    checkEqual('task.updated ref_id', task.ref_id, 'msg_root');
    checkEqual('contact ref_id', contact.ref_id, 'req_1');
    checkEqual('device ref_id', device.ref_id, 'dev_1');
    checkEqual('unknown kind', unknown.kind, 'raw');
    checkEqual('unknown ref_id', unknown.ref_id, 'raw_1');
    checkEqual('mention.reminder 无 delivery_id', mention.delivery_id, '');
    checkEqual('mention.reminder message_id', mention.message_id, 'msg_mention');
    checkEqual('mention.reminder mention_all', mention.mention_all, true);
    check(
      'stream_event 不带正文/preview',
      [membership, created, lifecycle, file, task, contact, device, unknown, mention].every(
        (event) => !('body' in event) && !('preview' in event) && !('text' in event),
      ),
    );
    checkEqual('信息事件不触发 claim', mock.state.claimCalls.size, claimCallsBefore);
    checkEqual('信息事件不查询 pending inbox', mock.state.pendingListCalls, pendingCallsBefore);


    sendItems(mock, [
      roomItem('rm_allowed', 'msg_info', { seq: '12', eventId: 'evt_info_dup' }),
      roomItem('rm_allowed', 'msg_self', { senderId: 'agt_me', eventId: 'evt_self_dup' }),
    ]);
    await Bun.sleep(600);
    checkEqual('跨帧重复 message_id 去重', roomEventCount(watcher.stdout, 'msg_info'), 1);
    checkEqual('自己消息跨帧去重', roomEventCount(watcher.stdout, 'msg_self'), 1);

    // 投递回执可见，但绝不进入 claim。
    const receiptClaimBefore = mock.state.claimCalls.size;
    sendItems(mock, [
      streamItem('delivery.updated', {
        kind: 'receipt',
        delivery_id: 'dlv_receipt_claimed',
        room_id: 'rm_allowed',
        state: 'claimed',
        attempt: 1,
        seq: '40',
        event_id: 'evt_receipt_claimed',
      }),
      streamItem('delivery.updated', {
        kind: 'receipt',
        attention: 'action_required',
        delivery_id: 'dlv_receipt_done',
        room_id: 'rm_allowed',
        state: 'completed',
        attempt: 1,
        seq: '41',
        event_id: 'evt_receipt_done',
      }),
      streamItem('delivery.cancelled', {
        kind: 'receipt',
        delivery_id: 'dlv_receipt_cancel',
        room_id: 'rm_allowed',
        state: 'cancelled',
        seq: '42',
        event_id: 'evt_receipt_cancel',
      }),
    ]);
    const claimedReceipt = await waitForDeliveryState(
      watcher.stdout,
      'dlv_receipt_claimed',
      'claimed',
    );
    const completedReceipt = await waitForDeliveryState(
      watcher.stdout,
      'dlv_receipt_done',
      'completed',
    );
    const cancelledReceipt = await waitForDeliveryState(
      watcher.stdout,
      'dlv_receipt_cancel',
      'cancelled',
    );
    checkEqual('claimed 回执 kind', claimedReceipt.kind, 'receipt');
    checkEqual('completed 回执 attention', completedReceipt.attention, 'action_required');
    checkEqual('cancelled 回执 source', cancelledReceipt.source, 'delivery.cancelled');
    checkEqual('回执不触发 claim', mock.state.claimCalls.size, receiptClaimBefore);

    // 同帧 delivery + room.message：delivery 优先，不重复输出 room_message。
    mock.state.pending.set('dlv_room_same', delivery('dlv_room_same', 'msg_room_same'));
    sendItems(mock, [
      {
        ...notificationItem('dlv_room_same', 'delivery.created', 'evt_room_same'),
        message_id: 'msg_room_same',
      },
      roomItem('rm_allowed', 'msg_room_same'),
    ]);
    await waitForEvent(watcher.stdout, 'delivery', 'dlv_room_same');
    await Bun.sleep(400);
    checkEqual(
      '同帧 delivery 与 room.message 只输出 delivery',
      roomEventCount(watcher.stdout, 'msg_room_same'),
      0,
    );

    // delivery 没真正输出（deferred）时，同帧 room.message 仍必须可见。
    mock.state.pending.set('dlv_room_deferred', delivery('dlv_room_deferred', 'msg_room_deferred'));
    sendItems(mock, [
      {
        ...notificationItem('dlv_room_deferred', 'delivery.created', 'evt_room_deferred'),
        message_id: 'msg_room_deferred',
      },
      roomItem('rm_allowed', 'msg_room_deferred'),
    ]);
    await waitForEvent(watcher.stdout, 'delivery_deferred', 'dlv_room_deferred');
    await waitForRoomEvent(watcher.stdout, 'msg_room_deferred');
    checkEqual(
      'deferred 未输出 delivery 时仍输出 room_message',
      roomEventCount(watcher.stdout, 'msg_room_deferred'),
      1,
    );

    // reconnect 补读：所有房间都补，已输出过的不重复。
    mock.state.history.set('rm_allowed', [
      historyMessage('rm_allowed', 'msg_info', 1),
      historyMessage('rm_allowed', 'msg_backfill', 2),
      historyMessage('rm_allowed', 'msg_self', 3, 'agt_me'),
    ]);
    mock.state.history.set('rm_other', [
      historyMessage('rm_other', 'msg_other_room', 4),
      historyMessage('rm_other', 'msg_other_new', 5),
    ]);
    const previous = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, previous, 'room-events');
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'room-events READY after reconnect',
    );
    const backfilled = await waitForRoomEvent(watcher.stdout, 'msg_backfill');
    const otherBackfilled = await waitForRoomEvent(watcher.stdout, 'msg_other_new');
    checkEqual('补读事件 source', backfilled.source, 'history');
    checkEqual('补读事件 seq 使用 created_seq', backfilled.seq, '2');
    checkEqual('其他房间补读 source', otherBackfilled.source, 'history');
    await Bun.sleep(500);
    checkEqual('补读只输出新增消息', roomEventCount(watcher.stdout, 'msg_backfill'), 1);
    checkEqual('补读其他房间新增消息', roomEventCount(watcher.stdout, 'msg_other_new'), 1);
    checkEqual('补读不重复已输出的消息', roomEventCount(watcher.stdout, 'msg_info'), 1);
    checkEqual('补读不重复自己已输出的消息', roomEventCount(watcher.stdout, 'msg_self'), 1);
    checkEqual('补读不重复其他房间已输出消息', roomEventCount(watcher.stdout, 'msg_other_room'), 1);
    const backfillCall = await waitForHistoryCall(
      mock,
      (call) => call.room_id === 'rm_allowed' && call.cursor !== null,
      'reconnect room history backfill',
    );
    checkEqual('reconnect 补读使用 after', backfillCall.direction, 'after');

    // 第二次重连没有新消息：不重复输出。
    const previousAgain = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, previousAgain, 'room-events second');
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'room-events second READY',
    );
    await Bun.sleep(700);
    checkEqual('第二次重连不重复补读', roomEventCount(watcher.stdout, 'msg_backfill'), 1);
    checkEqual('第二次重连不重复其他房间', roomEventCount(watcher.stdout, 'msg_other_new'), 1);

    // 旧服务端可能返回与本页消息不匹配的旧游标；客户端仍须按最后一条推进。
    mock.state.historyCursorStuck = true;
    mock.state.history.set('rm_allowed', [
      historyMessage('rm_allowed', 'msg_info', 1),
      historyMessage('rm_allowed', 'msg_backfill', 2),
      historyMessage('rm_allowed', 'msg_self', 3, 'agt_me'),
      historyMessage('rm_allowed', 'msg_stuck', 4),
    ]);
    const stuckPrevious = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, stuckPrevious, 'room-events stuck cursor');
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'room-events stuck READY',
    );
    await waitForRoomEvent(watcher.stdout, 'msg_stuck');
    checkEqual('游标不前进时仍输出新消息', roomEventCount(watcher.stdout, 'msg_stuck'), 1);

    const stuckAgain = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, stuckAgain, 'room-events stuck cursor second');
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'room-events stuck second READY',
    );
    const advancedCall = await waitForHistoryCall(
      mock,
      (call) =>
        call.room_id === 'rm_allowed' &&
        call.cursor !== null &&
        (decodeHistoryCursor(call.cursor)?.seq ?? 0) >= 4,
      'stuck cursor advanced to last item',
    );
    checkEqual(
      '客户端按最后一条 created_seq 推进游标',
      decodeHistoryCursor(advancedCall.cursor ?? '')?.seq,
      4,
    );
    await Bun.sleep(700);
    checkEqual('旧游标第二次重连不重复', roomEventCount(watcher.stdout, 'msg_stuck'), 1);
  } finally {
    await watcher.kill();
    mock.stop();
  }

  // 显式 all 与裸 --room-events 等价：枚举并接受任意房间的消息。
  const allMock = createMock();
  allMock.state.rooms = ['rm_allowed', 'rm_other'];
  const allWatcher = startWatcher(
    allMock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' },
    ['--room-events', 'all'],
  );
  try {
    await waitForLine(allWatcher.stderr, (line) => line.includes('READY'), 'room-events all READY');
    await waitForHistoryCall(allMock, (call) => call.room_id === 'rm_other', 'all baseline rm_other');
    sendItems(allMock, [
      roomItem('rm_allowed', 'msg_all_a'),
      roomItem('rm_other', 'msg_all_b'),
    ]);
    await waitForRoomEvent(allWatcher.stdout, 'msg_all_a');
    await waitForRoomEvent(allWatcher.stdout, 'msg_all_b');
    checkEqual('all 输出首个房间消息', roomEventCount(allWatcher.stdout, 'msg_all_a'), 1);
    checkEqual('all 输出第二个房间消息', roomEventCount(allWatcher.stdout, 'msg_all_b'), 1);
  } finally {
    await allWatcher.kill();
    allMock.stop();
  }

  // 2000+ 积压：单次补读到 20 页上限后自动排队下一轮，而不是等 reconnect。
  const truncMock = createMock();
  truncMock.state.rooms = ['rm_trunc'];
  const truncWatcher = startWatcher(
    truncMock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' },
    ['--room-events'],
  );
  try {
    await waitForLine(truncWatcher.stderr, (line) => line.includes('READY'), 'trunc READY');
    await waitForHistoryCall(truncMock, (call) => call.room_id === 'rm_trunc', 'trunc baseline');
    truncMock.state.history.set(
      'rm_trunc',
      Array.from({ length: 2001 }, (_, index) =>
        historyMessage('rm_trunc', `msg_trunc_${index + 1}`, index + 1),
      ),
    );
    const truncPrevious = truncMock.state.controller;
    truncMock.closeStream();
    await waitForReconnect(truncMock, truncPrevious, 'trunc');
    await waitForLine(
      truncWatcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'trunc READY after reconnect',
      30_000,
    );
    await waitForLine(
      truncWatcher.stderr,
      (line) => line.includes('ROOM_HISTORY_TRUNCATED') && line.includes('room_id=rm_trunc'),
      'room history truncation notice',
      30_000,
    );
    checkEqual('截断前输出到第 2000 条', roomEventCount(truncWatcher.stdout, 'msg_trunc_2000'), 1);

    // 不关闭连接：截断后应立即续读第 2001 条。
    await waitForRoomEvent(truncWatcher.stdout, 'msg_trunc_2001', 30_000);
    const resumeCall = await waitForHistoryCall(
      truncMock,
      (call) =>
        call.room_id === 'rm_trunc' &&
        call.cursor !== null &&
        (decodeHistoryCursor(call.cursor)?.seq ?? 0) === 2000,
      'trunc continuation from saved cursor',
    );
    checkEqual('截断后保存第 2000 条游标', decodeHistoryCursor(resumeCall.cursor ?? '')?.seq, 2000);
    checkEqual(
      '自动续读第 2001 条',
      roomEventCount(truncWatcher.stdout, 'msg_trunc_2001'),
      1,
    );
    await Bun.sleep(300);
    checkEqual('续读不重复前 2000 条', roomEventCount(truncWatcher.stdout, 'msg_trunc_2000'), 1);
  } finally {
    await truncWatcher.kill();
    truncMock.stop();
  }

  // more/dropped：除了补 pending，还要对所有房间做一次有界 backfill。
  const dropMock = createMock();
  dropMock.state.rooms = ['rm_drop_a', 'rm_drop_b'];
  const dropWatcher = startWatcher(
    dropMock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' },
    ['--room-events'],
  );
  try {
    await waitForLine(dropWatcher.stderr, (line) => line.includes('READY'), 'drop READY');
    await waitForHistoryCall(dropMock, (call) => call.room_id === 'rm_drop_a', 'drop baseline a');
    await waitForHistoryCall(dropMock, (call) => call.room_id === 'rm_drop_b', 'drop baseline b');
    const dropCallsBefore = dropMock.state.historyCalls.length;
    const pendingBeforeDrop = dropMock.state.pendingListCalls;
    sendItems(dropMock, [], { more: true, dropped: 3 });
    const dropCallA = await waitForHistoryCall(
      dropMock,
      (call) =>
        call.room_id === 'rm_drop_a' &&
        call.cursor !== null &&
        dropMock.state.historyCalls.indexOf(call) >= dropCallsBefore,
      'dropped backfill room a',
    );
    const dropCallB = await waitForHistoryCall(
      dropMock,
      (call) =>
        call.room_id === 'rm_drop_b' &&
        call.cursor !== null &&
        dropMock.state.historyCalls.indexOf(call) >= dropCallsBefore,
      'dropped backfill room b',
    );
    checkEqual('dropped 补读房间 a 使用 after', dropCallA.direction, 'after');
    checkEqual('dropped 补读房间 b 使用 after', dropCallB.direction, 'after');
    check('dropped 仍补 pending', dropMock.state.pendingListCalls > pendingBeforeDrop);
  } finally {
    await dropWatcher.kill();
    dropMock.stop();
  }

  // 游标与 last_seq 持久化：重启后首连按已存游标补读，而不是重取 head 基线。
  const persistMock = createMock();
  persistMock.state.rooms = ['rm_persist'];
  const persistDir = await mkdtemp(join(tmpdir(), 'ts-monitor-persist-'));
  const persistState = join(persistDir, 'state');
  const persistWatcher = startWatcher(
    persistMock.base,
    {
      AGENTNET_MONITOR_RETRY_BASE_MS: '600000',
      AGENTNET_MONITOR_STATE_DIR: persistState,
    },
    ['--room-events'],
  );
  try {
    await waitForLine(persistWatcher.stderr, (line) => line.includes('READY'), 'persist READY');
    await waitForHistoryCall(
      persistMock,
      (call) => call.room_id === 'rm_persist' && call.cursor === null,
      'persist baseline',
    );
    sendItems(persistMock, [roomItem('rm_persist', 'msg_persist_live', { seq: '77' })]);
    await waitForRoomEvent(persistWatcher.stdout, 'msg_persist_live');
    await Bun.sleep(300);
    await persistWatcher.kill('SIGTERM');

    const statePath = join(persistState, 'stream-state.json');
    check('重启前已写入 stream-state.json', existsSync(statePath));
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as {
      cursors?: Record<string, string>;
      last_seq?: string;
    };
    check(
      '房间游标已持久化',
      typeof persisted.cursors?.rm_persist === 'string' &&
        persisted.cursors.rm_persist.length > 0,
      persisted,
    );
    checkEqual('最后 stream seq 已持久化', persisted.last_seq, '1');

    persistMock.state.history.set('rm_persist', [
      historyMessage('rm_persist', 'msg_persisted_gap', 1),
    ]);
    const callsBeforeRestart = persistMock.state.historyCalls.length;
    const restarted = startWatcher(
      persistMock.base,
      {
        AGENTNET_MONITOR_RETRY_BASE_MS: '600000',
        AGENTNET_MONITOR_STATE_DIR: persistState,
      },
      ['--room-events'],
    );
    try {
      await waitForLine(restarted.stderr, (line) => line.includes('READY'), 'persist restart READY');
      const restartCall = await waitForHistoryCall(
        persistMock,
        (call) =>
          call.room_id === 'rm_persist' &&
          call.cursor !== null &&
          persistMock.state.historyCalls.indexOf(call) >= callsBeforeRestart,
        'restart uses persisted cursor',
      );
      check('首连使用已存游标而非 null', restartCall.cursor !== null);
      await waitForRoomEvent(restarted.stdout, 'msg_persisted_gap');
      checkEqual(
        '重启后补读断线窗口消息',
        roomEventCount(restarted.stdout, 'msg_persisted_gap'),
        1,
      );
    } finally {
      await restarted.kill();
    }
  } finally {
    await persistWatcher.kill();
    persistMock.stop();
    await rm(persistDir, { recursive: true, force: true });
  }

  // 未显式指定 stateDir 时，默认持久目录也要跨重启保留。
  const defaultHome = mkdtempSync(join(tmpdir(), 'ts-monitor-home-'));
  const defaultStateMock = createMock();
  const defaultStateWatcher = startProcess(
    [process.execPath, CLI, 'monitor', '--harness', 'claude', '--room-events'],
    {
      HOME: defaultHome,
      AGENTNET_URL: defaultStateMock.base,
      AGENTNET_TOKEN: TOKEN,
      AGENTNET_MONITOR_RETRY_BASE_MS: '600000',
    },
  );
  try {
    await waitForLine(defaultStateWatcher.stderr, (line) => line.includes('READY'), 'default state READY');
    const stateRoot = join(defaultHome, '.agentnet', 'monitor');
    check('默认状态目录已创建', existsSync(stateRoot));
    await defaultStateWatcher.kill('SIGTERM');
    check('默认状态目录退出后保留', existsSync(stateRoot));
  } finally {
    await defaultStateWatcher.kill();
    defaultStateMock.stop();
    await rm(defaultHome, { recursive: true, force: true });
  }

  // 成员移除→重新加入：服务端代次变化拒绝旧游标；客户端重置一次并重取基线。
  const rejoinMock = createMock();
  rejoinMock.state.rooms = ['rm_rejoin'];
  const rejoinWatcher = startWatcher(
    rejoinMock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' },
    ['--room-events'],
  );
  try {
    await waitForLine(rejoinWatcher.stderr, (line) => line.includes('READY'), 'rejoin READY');
    await waitForHistoryCall(
      rejoinMock,
      (call) => call.room_id === 'rm_rejoin' && call.cursor === null,
      'rejoin initial baseline',
    );
    rejoinMock.state.history.set('rm_rejoin', [
      historyMessage('rm_rejoin', 'msg_rejoin_seen', 1),
      historyMessage('rm_rejoin', 'msg_rejoin_prebaseline', 2),
    ]);
    sendItems(rejoinMock, [roomItem('rm_rejoin', 'msg_rejoin_seen')]);
    await waitForRoomEvent(rejoinWatcher.stdout, 'msg_rejoin_seen');

    // 重新加入产生新代次：旧 g1 游标一律 CURSOR_EXPIRED。
    rejoinMock.state.historyGeneration = 2;
    const rejoinPrevious = rejoinMock.state.controller;
    const callsBeforeReset = rejoinMock.state.historyCalls.length;
    rejoinMock.closeStream();
    await waitForReconnect(rejoinMock, rejoinPrevious, 'rejoin');
    await waitForLine(
      rejoinWatcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'rejoin READY after reconnect',
    );
    await waitForLine(
      rejoinWatcher.stderr,
      (line) => line.includes('ROOM_HISTORY_RESET') && line.includes('room_id=rm_rejoin'),
      'room history reset notice',
    );
    await waitForHistoryCall(
      rejoinMock,
      (call) =>
        call.room_id === 'rm_rejoin' &&
        call.cursor === null &&
        rejoinMock.state.historyCalls.indexOf(call) >= callsBeforeReset,
      'rejoin rebaseline',
    );
    checkEqual(
      '重新加入后旧游标被服务端拒绝',
      rejoinMock.state.historyCalls
        .slice(callsBeforeReset)
        .some(
          (call) =>
            call.room_id === 'rm_rejoin' &&
            call.cursor !== null &&
            decodeHistoryCursor(call.cursor)?.generation === 1,
        ),
      true,
    );
    await Bun.sleep(400);
    checkEqual(
      '重新加入后只记录一次重置',
      rejoinWatcher.stderr.filter(
        (line) => line.includes('ROOM_HISTORY_RESET') && line.includes('room_id=rm_rejoin'),
      ).length,
      1,
    );
    check(
      '重新加入后不输出永久 room_history_failed',
      !rejoinWatcher.stderr.some((line) => line.includes('room_history_failed')) &&
        !rejoinWatcher.stdout.some((line) => line.includes('room_history_failed')),
    );
    checkEqual(
      '重新加入后不重复输出已见消息',
      roomEventCount(rejoinWatcher.stdout, 'msg_rejoin_seen'),
      1,
    );

    // 重置后的流消息仍只输出一次。
    sendItems(rejoinMock, [roomItem('rm_rejoin', 'msg_rejoin_after')]);
    await waitForRoomEvent(rejoinWatcher.stdout, 'msg_rejoin_after');
    checkEqual(
      '重新加入后流消息输出一次',
      roomEventCount(rejoinWatcher.stdout, 'msg_rejoin_after'),
      1,
    );

    // 重置后的新游标可继续补读断线期间的消息。
    rejoinMock.state.history.set('rm_rejoin', [
      historyMessage('rm_rejoin', 'msg_rejoin_seen', 1),
      historyMessage('rm_rejoin', 'msg_rejoin_prebaseline', 2),
      historyMessage('rm_rejoin', 'msg_rejoin_after', 3),
      historyMessage('rm_rejoin', 'msg_rejoin_gap', 4),
    ]);
    const rejoinAgain = rejoinMock.state.controller;
    rejoinMock.closeStream();
    await waitForReconnect(rejoinMock, rejoinAgain, 'rejoin backfill');
    await waitForLine(
      rejoinWatcher.stderr,
      (line) => line.includes('READY') && line.includes('reconnect=1'),
      'rejoin backfill READY',
    );
    await waitForRoomEvent(rejoinWatcher.stdout, 'msg_rejoin_gap');
    await Bun.sleep(400);
    checkEqual(
      '重新加入后离线消息补读一次',
      roomEventCount(rejoinWatcher.stdout, 'msg_rejoin_gap'),
      1,
    );
    checkEqual(
      '重新加入后流消息不因补读重复',
      roomEventCount(rejoinWatcher.stdout, 'msg_rejoin_after'),
      1,
    );
    const rejoinBackfill = await waitForHistoryCall(
      rejoinMock,
      (call) =>
        call.room_id === 'rm_rejoin' &&
        call.cursor !== null &&
        decodeHistoryCursor(call.cursor)?.generation === 2,
      'rejoin new generation backfill',
    );
    checkEqual(
      '重新加入后补读使用新代次游标',
      decodeHistoryCursor(rejoinBackfill.cursor ?? '')?.generation,
      2,
    );
    checkEqual(
      '重新加入后仍只记录一次重置',
      rejoinWatcher.stderr.filter(
        (line) => line.includes('ROOM_HISTORY_RESET') && line.includes('room_id=rm_rejoin'),
      ).length,
      1,
    );
  } finally {
    await rejoinWatcher.kill();
    rejoinMock.stop();
  }

  const nonClaude = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'peri', '--room-events', 'all', '--check-config'],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check(
    '--room-events 透传非 claude harness',
    nonClaude.exitCode === 0 && nonClaude.stdout.toString().includes('harness=peri'),
    nonClaude.stderr.toString(),
  );

  const noRoomEvents = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'claude', '--no-room-events', '--check-config'],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check(
    '--no-room-events 可用于关闭默认监听',
    noRoomEvents.exitCode === 0,
    noRoomEvents.stderr.toString(),
  );

  const invalidRoom = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'claude', '--room-events', 'rm_allowed', '--check-config'],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  check(
    '--room-events 不再接受房间白名单',
    invalidRoom.exitCode !== 0 && invalidRoom.stderr.toString().includes('只接受 all'),
  );
}

async function runPeriChecks(): Promise<void> {
  const mock = createMock();
  const watcher = startPeriWatcher(mock.base, { AGENTNET_MONITOR_RETRY_BASE_MS: '600000' });
  try {
    const ready = await waitForLine(watcher.stdout, (line) => line.includes('READY'), 'peri READY');
    check(
      'peri READY 写 stdout 且带 actor/subscription',
      /^READY actor=agt_me pending=\d+ subscription=sub-/.test(ready),
      ready,
    );
    check('peri READY 不写 stderr', !watcher.stderr.join('\n').includes('READY'));
    check('peri stderr 不含 token', !watcher.stderr.join('\n').includes(TOKEN));
    check(
      'peri 启动输出 deadline 与剩余毫秒',
      watcher.stdout.some((line) =>
        /^DEADLINE at=\d{4}-\d{2}-\d{2}T[^ ]+ remaining_ms=86400000$/.test(line),
      ),
      watcher.stdout.slice(0, 3),
    );

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
      'type,source,event_id,delivery_id,room_id,message_id,sender_id,seq,created_at,attempt,claim_id,claimed_at,auto_claimed,claim_state,claim,memory_pack_id,memory_items,memory_reason',
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
      'peri deferred hint 提示 complete/fail 与自动退避重试',
      typeof deferred.hint === 'string' &&
        deferred.hint.includes('complete/fail') &&
        deferred.hint.includes('自动重试'),
    );
    check(
      'peri deferred 带重试轮次与间隔',
      typeof deferred.retry_attempt === 'number' && typeof deferred.retry_in_ms === 'number',
      deferred,
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
      'type,source,delivery_id,room_id,message_id,sender_id,seq,created_seq,attempt,claim_id,claimed_at,auto_claimed,claim_state,claim,memory_pack_id,memory_items,memory_reason',
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
          line.startsWith('ALERT ') ||
          /^(READY|RECOVERED|RECONNECTING|DEGRADED|DEADLINE|EXPIRING|EXPIRED|ERROR) /.test(line),
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

async function runPeriRecoveryCheck(): Promise<void> {
  const mock = createMock();
  const watcher = startPeriWatcher(mock.base, { AGENTNET_MONITOR_RECONNECT_BASE_MS: '1' });
  try {
    await waitForLine(watcher.stdout, (line) => line.startsWith('READY '), 'recovery READY');
    mock.state.listenFailures = 5;
    mock.closeStream();
    const degraded = await waitForLine(
      watcher.stdout,
      (line) => line.startsWith('DEGRADED '),
      'recovery DEGRADED',
      15_000,
    );
    check('peri DEGRADED 带 attempts 与原因', /^DEGRADED attempts=\d+ last_reason=/.test(degraded), degraded);

    const recovered = await waitForLine(
      watcher.stdout,
      (line) => line.startsWith('RECOVERED '),
      'recovery RECOVERED',
      15_000,
    );
    check(
      'peri RECOVERED 带 actor/pending/subscription',
      /^RECOVERED actor=agt_me pending=\d+ subscription=sub-/.test(recovered),
      recovered,
    );
    check(
      'peri RECOVERED 后不再重复输出 READY reconnect',
      watcher.stdout.filter((line) => line.startsWith('RECOVERED ')).length === 1,
      watcher.stdout,
    );
  } finally {
    await watcher.kill();
    mock.stop();
  }
}

async function runPeriJsonChecks(): Promise<void> {
  const mock = createMock();
  const watcher = startPeriWatcher(mock.base, {}, ['--json']);
  try {
    const readyLine = await waitForLine(
      watcher.stdout,
      (line) => parseEvent(line)?.type === 'ready',
      'peri json READY',
    );
    const ready = parseEvent(readyLine);
    expect(ready !== null, 'peri json READY 必须是 JSON');
    checkEqual('peri --json ready kind', ready.kind, 'control');
    checkEqual('peri --json ready seq', ready.seq, null);

    const deadlineLine = await waitForLine(
      watcher.stdout,
      (line) => parseEvent(line)?.type === 'deadline',
      'peri json DEADLINE',
    );
    const deadline = parseEvent(deadlineLine);
    expect(deadline !== null, 'peri json DEADLINE 必须是 JSON');
    checkEqual('peri --json deadline kind', deadline.kind, 'control');
    checkEqual('peri --json deadline remaining_ms', deadline.remaining_ms, 86_400_000);
    checkEqual('peri --json deadline seq', deadline.seq, null);
    check(
      'peri --json 不输出 ALERT 前缀',
      watcher.stdout.every((line) => !line.startsWith('ALERT ')),
      watcher.stdout,
    );
    check(
      'peri --json 每行都是 JSON',
      watcher.stdout.every((line) => parseEvent(line) !== null),
      watcher.stdout,
    );

    mock.state.pending.set('dlv_json', delivery('dlv_json'));
    sendItems(mock, [notificationItem('dlv_json', 'delivery.created', 'evt_json')]);
    const event = await waitForEvent(watcher.stdout, 'delivery', 'dlv_json');
    checkEqual('peri --json delivery kind', event.kind, 'delivery');
    checkEqual('peri --json delivery seq', event.seq, '1');
    checkEqual('peri --json delivery room_id', event.room_id, 'rm_test');
    checkEqual('peri --json delivery message_id', event.message_id, 'msg_dlv_json');
    checkEqual('peri --json delivery delivery_id', event.delivery_id, 'dlv_json');
    check(
      'peri --json 可用 type 正则唤醒',
      watcher.stdout.some((line) => line.includes('"type":"delivery"')),
      watcher.stdout,
    );
    check('peri --json 不含 token', !watcher.stdout.join('\n').includes(TOKEN));
  } finally {
    await watcher.kill();
    mock.stop();
  }
}

async function runPeriDeadlineChecks(): Promise<void> {
  const mock = createMock();
  const watcher = startPeriWatcher(mock.base, {}, ['--max-runtime', '2']);
  try {
    await waitForLine(watcher.stdout, (line) => line.startsWith('READY '), 'deadline READY');
    const expiring = await waitForLine(
      watcher.stdout,
      (line) => line.startsWith('EXPIRING '),
      'deadline EXPIRING',
    );
    check(
      'peri 文本 EXPIRING 带 remaining_ms/deadline',
      /^EXPIRING remaining_ms=\d+ deadline=\d{4}-\d{2}-\d{2}T/.test(expiring),
      expiring,
    );
    const expired = await waitForLine(
      watcher.stdout,
      (line) => line.startsWith('EXPIRED '),
      'deadline EXPIRED',
    );
    check('peri EXPIRED 提示重启', expired.includes('action=restart_monitor'), expired);
    const code = await Promise.race([watcher.exited, Bun.sleep(5000).then(() => 999)]);
    checkEqual('peri 到达 deadline 退出 0', code, 0);
    checkEqual(
      'peri 文本 EXPIRING 只输出一次',
      watcher.stdout.filter((line) => line.startsWith('EXPIRING ')).length,
      1,
    );
  } finally {
    await watcher.kill();
    mock.stop();
  }

  const jsonMock = createMock();
  const jsonWatcher = startPeriWatcher(jsonMock.base, {}, ['--json', '--max-runtime', '2']);
  try {
    const expiring = await waitForEvent(jsonWatcher.stdout, 'expiring');
    checkEqual('peri --json expiring kind', expiring.kind, 'control');
    checkEqual('peri --json expiring seq', expiring.seq, null);
    check(
      'peri --json expiring remaining_ms 是数字',
      typeof expiring.remaining_ms === 'number',
      expiring,
    );
    await Bun.sleep(300);
    checkEqual(
      'peri --json EXPIRING 只输出一次',
      jsonWatcher.stdout.filter((line) => parseEvent(line)?.type === 'expiring').length,
      1,
    );
    const code = await Promise.race([jsonWatcher.exited, Bun.sleep(5000).then(() => 999)]);
    checkEqual('peri --json 到达 deadline 退出 0', code, 0);
  } finally {
    await jsonWatcher.kill();
    jsonMock.stop();
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
    check('peri 退出后保留状态目录', existsSync(stateDir));
    check('peri 退出后保留 seen', existsSync(join(stateDir, 'seen')));
    check('peri 退出后清理事件文件', !existsSync(join(stateDir, 'events')));
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
    check('退出后保留状态目录', existsSync(stateDir));
    check('退出后保留 seen', existsSync(join(stateDir, 'seen')));
    check('退出后清理事件文件', !existsSync(join(stateDir, 'events')));
  } finally {
    await watcher.kill();
    mock.stop();
    await rm(workdir, { recursive: true, force: true });
  }
}

interface DshFixture {
  dir: string;
  home: string;
  temp: string;
  dshHome: string;
  bin: string;
  sessionId: string;
}

async function createDshFixture(label: string): Promise<DshFixture> {
  const dir = await mkdtemp(join(tmpdir(), `ts-monitor-${label}-`));
  const temp = join(dir, 'tmp');
  const bin = join(dir, 'bin');
  const dshHome = join(dir, 'dsh');
  const sessionId = `session-${label}`;
  await mkdir(temp, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'dsh');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('0.2.2-rc.1\\n'); process.exit(0); }
if (args.includes('list')) {
  process.stdout.write(JSON.stringify([{ name: 'dsh-profile-test', dependencies: {
    '@peri-code/dsh-webots-monitor': { version: 'link:test-package' }
  } }]) + '\\n');
  process.exit(0);
}
process.exit(args.includes('add') ? 0 : 2);
`,
  );
  chmodSync(executable, 0o755);
  return { dir, home: join(dir, 'home'), temp, dshHome, bin, sessionId };
}

function dshCommand(...args: string[]): string[] {
  return [process.execPath, CLI, 'monitor', '--harness', 'dsh', ...args];
}

function dshEnv(
  mock: MockServer,
  fixture: DshFixture,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    AGENTNET_URL: mock.base,
    AGENTNET_TOKEN: TOKEN,
    WEBBOTS_HOME: fixture.home,
    DSH_HOME: fixture.dshHome,
    DSH_PROFILE: 'web',
    DSH_SESSION_ID: fixture.sessionId,
    PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
    TMPDIR: fixture.temp,
    ...extra,
  };
}

function startDshWatcher(
  mock: MockServer,
  fixture: DshFixture,
  extraEnv: Record<string, string> = {},
): RunningWatcher {
  return startProcess(dshCommand('run'), dshEnv(mock, fixture, extraEnv));
}

function runDshCli(args: string[], env: Record<string, string>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: dshCommand(...args),
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function dshQueue(home: string): JsonObject[] {
  const file = join(home, 'wake.queue');
  if (!existsSync(file)) return [];
  const events: JsonObject[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (event) events.push(event);
  }
  return events;
}

function dshStatus(home: string): JsonObject {
  const file = join(home, 'status.json');
  if (!existsSync(file)) return {};
  const event = parseEvent(readFileSync(file, 'utf8'));
  return event ?? {};
}

async function waitForDsh(
  predicate: () => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitForDshQueue(
  home: string,
  predicate: (event: JsonObject) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitForDsh(() => dshQueue(home).some(predicate), label, timeoutMs);
}

async function waitForDshStatus(
  home: string,
  predicate: (status: JsonObject) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitForDsh(() => predicate(dshStatus(home)), label, timeoutMs);
}

async function waitForMatchingCount(
  lines: string[],
  predicate: (line: string) => boolean,
  minimum: number,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (lines.filter(predicate).length >= minimum) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout waiting for ${label}; lines=${JSON.stringify(lines)}`);
}

/** dsh：wake.queue 过滤、catchup、状态、重连/空闲与退出清理。 */
async function runDshChecks(): Promise<void> {
  const fixture = await createDshFixture('dsh');
  const mock = createMock();
  mock.state.loginPending = 2;
  mock.state.loginHeadSeq = '900';
  mock.state.roomKinds.set('rm_direct', 'direct');
  mock.state.roomKinds.set('rm_group', 'group');
  const watcher = startDshWatcher(mock, fixture);
  try {
    await waitForDshStatus(
      fixture.home,
      (status) => status.state === 'running' && status.acked === true && status.online === true,
      'dsh login',
    );
    await waitForDshQueue(fixture.home, (event) => event.source === 'catchup', 'dsh catchup');
    const first = dshQueue(fixture.home);
    check('dsh catchup 排在第一条', first[0]?.source === 'catchup', first[0]);
    checkEqual('dsh catchup 的 seq 使用 inbox_head_seq', first[0]?.seq, '900');
    checkEqual('dsh catchup 的 event_id 保留原因', first[0]?.event_id, 'catchup:login:2:900');

    // 同一 pending/head 快照的 truncated 帧不重复写 catchup。
    sendItems(mock, [], { more: true });
    await Bun.sleep(300);
    checkEqual(
      'dsh 同一快照的 frame_truncated 不重复写 catchup',
      dshQueue(fixture.home).filter((event) => event.source === 'catchup').length,
      1,
    );

    const items: JsonObject[] = [
      {
        source: 'delivery.created',
        attention: 'action_required',
        room_id: 'rm_direct',
        message_id: 'msg_1',
        delivery_id: 'dlv_1',
        sender_id: 'agt_user',
        seq: '101',
        event_id: '101',
      },
      {
        source: 'room.message',
        room_id: 'rm_direct',
        message_id: 'msg_2',
        sender_id: 'agt_user',
        seq: '102',
        event_id: '102',
      },
      {
        source: 'room.message',
        room_id: 'rm_group',
        message_id: 'msg_3',
        sender_id: 'agt_user',
        seq: '103',
        event_id: '103',
      },
      {
        source: 'room.message',
        room_id: 'rm_direct',
        message_id: 'msg_4',
        sender_id: 'agt_me',
        seq: '104',
        event_id: '104',
      },
      {
        source: 'delivery.updated',
        attention: 'action_required',
        room_id: 'rm_direct',
        delivery_id: 'dlv_2',
        sender_id: 'agt_me',
        state: 'claimed',
        seq: '105',
        event_id: '105',
      },
      {
        source: 'session.login',
        attention: 'action_required',
        seq: '106',
        event_id: '106',
      },
      {
        source: 'delivery.reminder',
        attention: 'action_required',
        room_id: 'rm_direct',
        message_id: 'msg_5',
        delivery_id: 'dlv_3',
        sender_id: 'agt_user',
        seq: '107',
        event_id: '107',
      },
      {
        source: 'room.membership',
        attention: 'action_required',
        room_id: 'rm_group',
        seq: '108',
        event_id: '108',
      },
      {
        source: 'delivery.retried',
        attention: 'action_required',
        room_id: 'rm_direct',
        message_id: 'msg_6',
        delivery_id: 'dlv_4',
        sender_id: 'agt_user',
        seq: '109',
        event_id: '109',
      },
      {
        source: 'room.message',
        room_id: 'rm_unknown',
        message_id: 'msg_7',
        sender_id: 'agt_user',
        seq: '110',
        event_id: '110',
      },
    ];
    for (const item of items) {
      sendItems(mock, [item]);
      await Bun.sleep(60);
    }
    await waitForDshQueue(fixture.home, (event) => event.event_id === '109', 'dsh last event');

    const queued = dshQueue(fixture.home);
    const expectedKeys = [
      'attention',
      'at',
      'change',
      'delivery_id',
      'event_id',
      'kind',
      'message_id',
      'ref_id',
      'room_id',
      'sender_id',
      'seq',
      'source',
      'state',
    ].sort();
    check(
      'dsh wake.queue 每条事件固定十三字段',
      queued.every(
        (event) => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(expectedKeys),
      ),
      queued,
    );
    check(
      'dsh wake.queue 时间字段为 UTC ISO 8601',
      queued.every(
        (event) =>
          typeof event.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(event.at),
      ),
      queued.map((event) => event.at),
    );

    const ids = new Set(queued.map((event) => event.event_id));
    const deliveryIds = new Set(queued.map((event) => event.delivery_id));
    check('dsh 投递事件入队', deliveryIds.has('dlv_1'), queued);
    check('dsh 直聊普通消息入队', ids.has('102'), queued);
    check('dsh 自己的消息也入队', ids.has('104'), queued);
    check('dsh 群聊普通消息入队', ids.has('103'), queued);
    check('dsh 未知房间普通消息入队', ids.has('110'), queued);
    check('dsh delivery.updated 回执入队', ids.has('105'), queued);
    check('dsh session.login 入队', ids.has('106'), queued);
    check('dsh delivery.reminder 入队', deliveryIds.has('dlv_3'), queued);
    check('dsh 被移出房间入队', ids.has('108'), queued);
    check('dsh delivery.retried 入队', deliveryIds.has('dlv_4'), queued);
    checkEqual('dsh 不再查询房间类型', mock.state.roomGetCalls.size, 0);
    checkEqual('dsh 不 claim', mock.state.claimCalls.size, 0);
    checkEqual('dsh 不读正文', mock.state.readCalls, 0);

    const receipt = queued.find((event) => event.event_id === '105');
    checkEqual('dsh 回执保留 state', receipt?.state, 'claimed');
    checkEqual('dsh 回执保留 source', receipt?.source, 'delivery.updated');

    const delivery = queued.find((event) => event.event_id === '101');
    check(
      'dsh 投递事件只写定位字段',
      delivery?.source === 'delivery.created' &&
        delivery.attention === 'action_required' &&
        delivery.room_id === 'rm_direct' &&
        delivery.message_id === 'msg_1' &&
        delivery.delivery_id === 'dlv_1' &&
        delivery.sender_id === 'agt_user' &&
        delivery.seq === '101',
      delivery,
    );

    const status = dshStatus(fixture.home);
    checkEqual('dsh status state=running', status.state, 'running');
    checkEqual('dsh status acked', status.acked, true);
    checkEqual('dsh status online', status.online, true);
    checkEqual('dsh status connected', status.connected, true);
    checkEqual('dsh status pending_count', status.pending_count, 2);
    checkEqual('dsh status reconnects', status.reconnects, 0);
    check('dsh status lastEventAt', typeof status.lastEventAt === 'string');
    check('dsh status lastNotificationAt', typeof status.lastNotificationAt === 'string');
    checkEqual('dsh status lastError', status.lastError, null);
    checkEqual(
      'dsh status.json 权限 0600',
      statSync(join(fixture.home, 'status.json')).mode & 0o777,
      0o600,
    );
    checkEqual(
      'dsh wake.queue 权限 0600',
      statSync(join(fixture.home, 'wake.queue')).mode & 0o777,
      0o600,
    );
    check(
      'dsh stderr 含 READY 且不再输出 DROP',
      watcher.stderr.some((line) => line.includes('READY')) &&
        !watcher.stderr.some((line) => line.includes('DROP type=group_message')),
      watcher.stderr,
    );
    check('dsh run 不向 stdout 写事件', watcher.stdout.join('').trim() === '', watcher.stdout);

    const surface = [
      readFileSync(join(fixture.home, 'wake.queue'), 'utf8'),
      readFileSync(join(fixture.home, 'watch.log'), 'utf8'),
      readFileSync(join(fixture.home, 'status.json'), 'utf8'),
    ].join('\n');
    check('dsh token 不进入 queue/log/status', !surface.includes(TOKEN));

    const live = runDshCli(['status'], { WEBBOTS_HOME: fixture.home });
    checkEqual('dsh status 运行中退出码', live.exitCode, 0);
    const liveOut = JSON.parse(new TextDecoder().decode(live.stdout)) as JsonObject;
    check('dsh status running=true', liveOut.running === true);
    checkEqual('dsh status 输出 home', liveOut.home, fixture.home);

    // 断线重连：reason=stream_closed，重连快照不重复 catchup。
    const readyBefore = watcher.stderr.filter((line) => line.includes('READY')).length;
    const previous = mock.state.controller;
    mock.closeStream();
    await waitForReconnect(mock, previous, 'dsh');
    await waitForMatchingCount(
      watcher.stderr,
      (line) => line.includes('READY'),
      readyBefore + 1,
      'dsh READY after reconnect',
    );
    check(
      'dsh 普通断线记录 RECONNECTING reason=stream_closed',
      watcher.stderr.some(
        (line) => line.includes('RECONNECTING') && line.includes('reason=stream_closed'),
      ),
    );
    await Bun.sleep(300);
    checkEqual(
      'dsh 重连后同一快照不重复 catchup',
      dshQueue(fixture.home).filter((event) => event.source === 'catchup').length,
      1,
    );
    checkEqual('dsh 重连计数', dshStatus(fixture.home).reconnects, 1);

    // 空闲检测：15 秒没有任何字节后重连。
    const idleReady = watcher.stderr.filter((line) => line.includes('READY')).length;
    const idlePrevious = mock.state.controller;
    expect(idlePrevious !== null, 'dsh idle probe stream must be connected');
    mock.pauseKeepalives();
    await waitForLine(
      watcher.stderr,
      (line) => line.includes('RECONNECTING') && line.includes('reason=idle_timeout'),
      'dsh idle RECONNECTING',
      45_000,
    );
    await waitForReconnect(mock, idlePrevious, 'dsh idle', 30_000);
    await waitForMatchingCount(
      watcher.stderr,
      (line) => line.includes('READY'),
      idleReady + 1,
      'dsh READY after idle reconnect',
    );

    const code = await watcher.kill('SIGTERM');
    checkEqual('dsh SIGTERM 退出码', code, 0);
    checkEqual('dsh SIGTERM 后 state=stopped', dshStatus(fixture.home).state, 'stopped');
    check('dsh SIGTERM 后移除 watch.pid', !existsSync(join(fixture.home, 'watch.pid')));
    check('dsh WEBBOTS_HOME 保留', existsSync(join(fixture.home, 'wake.queue')));
    check(
      'dsh 退出后清理临时 workdir',
      readdirSync(fixture.temp).every((name) => !name.startsWith('dsh-watch.')),
      readdirSync(fixture.temp),
    );
  } finally {
    await watcher.kill();
    mock.stop();
    await rm(fixture.dir, { recursive: true, force: true });
  }
}

/** dsh：pending=0 时不写 catchup。 */
async function runDshZeroPendingCheck(): Promise<void> {
  const fixture = await createDshFixture('dsh-zero');
  const mock = createMock();
  mock.state.roomKinds.set('rm_direct', 'direct');
  const watcher = startDshWatcher(mock, fixture);
  try {
    await waitForDshStatus(
      fixture.home,
      (status) => status.acked === true && status.online === true && status.pending_count === 0,
      'dsh zero pending login',
    );
    sendItems(mock, [
      {
        source: 'delivery.created',
        attention: 'action_required',
        room_id: 'rm_direct',
        message_id: 'msg_zero',
        delivery_id: 'dlv_zero',
        sender_id: 'agt_user',
        seq: '201',
        event_id: '201',
      },
    ]);
    await waitForDshQueue(
      fixture.home,
      (event) => event.delivery_id === 'dlv_zero',
      'dsh zero pending event',
    );
    check(
      'dsh pending=0 不写 catchup',
      dshQueue(fixture.home).every((event) => event.source !== 'catchup'),
      dshQueue(fixture.home),
    );
  } finally {
    await watcher.kill();
    mock.stop();
    await rm(fixture.dir, { recursive: true, force: true });
  }
}

/** dsh：CREDENTIAL_INVALID 立即退出 3，写 fatal 状态且不写事件。 */
async function runDshCredentialCheck(): Promise<void> {
  const fixture = await createDshFixture('dsh-cred');
  const mock = createMock({ credentialInvalid: true });
  const watcher = startDshWatcher(mock, fixture);
  try {
    const code = await Promise.race([
      watcher.exited,
      Bun.sleep(8_000).then(() => null),
    ]);
    if (code === null) {
      await watcher.kill('SIGKILL');
      throw new Error('dsh CREDENTIAL_INVALID did not exit within 8s');
    }
    checkEqual('dsh CREDENTIAL_INVALID 退出码', code, 3);
    check(
      'dsh CREDENTIAL_INVALID 输出不可重试告警',
      watcher.stderr.some(
        (line) =>
          line.includes('ALERT') &&
          line.includes('CREDENTIAL_INVALID') &&
          line.includes('retryable=false'),
      ),
      watcher.stderr,
    );
    const status = dshStatus(fixture.home);
    checkEqual('dsh CREDENTIAL_INVALID 写入 state=fatal', status.state, 'fatal');
    checkEqual('dsh CREDENTIAL_INVALID 写入 lastError', status.lastError, 'CREDENTIAL_INVALID');
    checkEqual('dsh CREDENTIAL_INVALID 不写事件', dshQueue(fixture.home).length, 0);
    check('dsh CREDENTIAL_INVALID 移除 watch.pid', !existsSync(join(fixture.home, 'watch.pid')));
    check(
      'dsh CREDENTIAL_INVALID 不泄漏 token',
      ![watcher.stderr.join('\n'), watcher.stdout.join('\n'), JSON.stringify(status)].join('\n').includes(TOKEN),
    );
  } finally {
    await watcher.kill();
    mock.stop();
    await rm(fixture.dir, { recursive: true, force: true });
  }
}

/** dsh：人类 token 在 network_me 阶段退出 4。 */
async function runDshNotAgentCheck(): Promise<void> {
  const fixture = await createDshFixture('dsh-not-agent');
  const mock = createMock({ meKind: 'human' });
  const watcher = startDshWatcher(mock, fixture);
  try {
    const code = await Promise.race([
      watcher.exited,
      Bun.sleep(8_000).then(() => null),
    ]);
    if (code === null) {
      await watcher.kill('SIGKILL');
      throw new Error('dsh NOT_AGENT did not exit within 8s');
    }
    checkEqual('dsh NOT_AGENT 退出码', code, 4);
    check(
      'dsh NOT_AGENT 输出不可重试告警',
      watcher.stderr.some((line) => line.includes('ALERT') && line.includes('NOT_AGENT')),
      watcher.stderr,
    );
    const status = dshStatus(fixture.home);
    checkEqual('dsh NOT_AGENT 写入 state=fatal', status.state, 'fatal');
    checkEqual('dsh NOT_AGENT 写入 lastError', status.lastError, 'NOT_AGENT');
    checkEqual('dsh NOT_AGENT 不写事件', dshQueue(fixture.home).length, 0);
  } finally {
    await watcher.kill();
    mock.stop();
    await rm(fixture.dir, { recursive: true, force: true });
  }
}

/** dsh：start/status/logs/wait/stop 生命周期与缺 token。 */
async function runDshLifecycleChecks(): Promise<void> {
  const fixture = await createDshFixture('dsh-lifecycle');
  const mock = createMock();
  try {
    const missing = Bun.spawnSync({
      cmd: dshCommand('run'),
      cwd: ROOT,
      env: {
        ...process.env,
        AGENTNET_URL: mock.base,
        AGENTNET_TOKEN: '',
        WEBBOTS_HOME: fixture.home,
        TMPDIR: fixture.temp,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    checkEqual('dsh 缺少 token 退出码', missing.exitCode, 2);
    check(
      'dsh 缺少 token 输出 AGENTNET_TOKEN_required',
      new TextDecoder().decode(missing.stderr).includes('AGENTNET_TOKEN_required'),
    );

    const start = runDshCli(['start'], dshEnv(mock, fixture));
    const startOut = new TextDecoder().decode(start.stdout);
    checkEqual('dsh start 退出码', start.exitCode, 0);
    check('dsh start 输出 STARTED', /^STARTED pid=\d+ home=/u.test(startOut.trim()), startOut);
    await waitForDshStatus(
      fixture.home,
      (status) => status.state === 'running' && status.acked === true,
      'dsh start ack',
    );
    check('dsh start 写 watch.pid', existsSync(join(fixture.home, 'watch.pid')));

    const live = runDshCli(['status'], { WEBBOTS_HOME: fixture.home });
    checkEqual('dsh start 后 status 退出码', live.exitCode, 0);
    const liveOut = JSON.parse(new TextDecoder().decode(live.stdout)) as JsonObject;
    check('dsh start 后 status running=true', liveOut.running === true);
    checkEqual('dsh start 后 status state=running', liveOut.state, 'running');
    checkEqual('dsh start 后 status acked', liveOut.acked, true);

    const logs = startProcess(dshCommand('logs', '20'), {
      WEBBOTS_HOME: fixture.home,
      TMPDIR: fixture.temp,
    });
    try {
      await waitForLine(logs.stdout, (line) => line.includes('READY'), 'dsh logs READY');
      appendFileSync(join(fixture.home, 'watch.log'), 'MARKER dsh-logs\n');
      await waitForLine(
        logs.stdout,
        (line) => line.includes('MARKER dsh-logs'),
        'dsh logs follow',
      );
    } finally {
      await logs.kill();
    }

    // EOF：wait 首次调用从当前行数开始，不重放已有事件。
    appendFileSync(join(fixture.home, 'wake.queue'), '{"probe":"eof"}\n');
    const waitOne = startProcess(dshCommand('wait', '5'), {
      WEBBOTS_HOME: fixture.home,
      TMPDIR: fixture.temp,
    });
    await waitForDsh(() => existsSync(join(fixture.home, 'wake.cursor')), 'dsh wait cursor', 2_000);
    await Bun.sleep(300);
    appendFileSync(join(fixture.home, 'wake.queue'), '{"probe":"new"}\n');
    checkEqual('dsh wait 退出码', await waitOne.exited, 0);
    check(
      'dsh wait 从 EOF 起读并输出新行',
      waitOne.stdout.join('\n').includes('"probe":"new"'),
      waitOne.stdout,
    );
    check('dsh wait 不重放已有事件', !waitOne.stdout.join('\n').includes('"probe":"eof"'));

    // truncate：游标大于当前行数时回退 0。
    truncateSync(join(fixture.home, 'wake.queue'), 0);
    const waitTwo = startProcess(dshCommand('wait', '5'), {
      WEBBOTS_HOME: fixture.home,
      TMPDIR: fixture.temp,
    });
    await Bun.sleep(300);
    appendFileSync(join(fixture.home, 'wake.queue'), '{"probe":"truncate"}\n');
    checkEqual('dsh wait truncate 退出码', await waitTwo.exited, 0);
    check(
      'dsh wake.queue 被 truncate 后游标回退 0',
      waitTwo.stdout.join('\n').includes('"probe":"truncate"'),
      waitTwo.stdout,
    );

    const waitTimeout = runDshCli(['wait', '1'], { WEBBOTS_HOME: fixture.home });
    checkEqual('dsh wait 超时退出码', waitTimeout.exitCode, 124);
    check(
      'dsh wait 非法参数退出码',
      runDshCli(['wait', 'abc'], { WEBBOTS_HOME: fixture.home }).exitCode === 2,
    );

    const stop = runDshCli(['stop'], { WEBBOTS_HOME: fixture.home });
    checkEqual('dsh stop 退出码', stop.exitCode, 0);
    check(
      'dsh stop 输出 STOPPED',
      new TextDecoder().decode(stop.stdout).includes('STOPPED'),
      new TextDecoder().decode(stop.stdout),
    );
    await waitForDsh(
      () => !existsSync(join(fixture.home, 'watch.pid')),
      'dsh pid removal',
      5_000,
    );
    await waitForDsh(() => dshStatus(fixture.home).state === 'stopped', 'dsh stopped status', 5_000);

    const stopped = runDshCli(['status'], { WEBBOTS_HOME: fixture.home });
    checkEqual('dsh status 未运行时退出码 3', stopped.exitCode, 3);
    check(
      'dsh status 输出 running=false',
      (JSON.parse(new TextDecoder().decode(stopped.stdout)) as JsonObject).running === false,
    );

    // 状态文件声称 running 但进程已退出：status 报 stale 并回落 stopped。
    const staleHome = join(fixture.dir, 'stale-home');
    mkdirSync(staleHome, { recursive: true });
    writeFileSync(join(staleHome, 'status.json'), JSON.stringify({ state: 'running' }));
    const stale = runDshCli(['status'], { WEBBOTS_HOME: staleHome });
    checkEqual('dsh stale status 退出码 3', stale.exitCode, 3);
    const staleOut = JSON.parse(new TextDecoder().decode(stale.stdout)) as JsonObject;
    checkEqual('dsh stale status stale=true', staleOut.stale, true);
    checkEqual('dsh stale status state=stopped', staleOut.state, 'stopped');
  } finally {
    const pidFile = join(fixture.home, 'watch.pid');
    if (existsSync(pidFile)) {
      runDshCli(['stop'], { WEBBOTS_HOME: fixture.home });
    }
    mock.stop();
    await rm(fixture.dir, { recursive: true, force: true });
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

  // --check-config 不连接服务、不输出 token。
  const claudeCheck = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'claude', '--check-config'],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  checkEqual('claude --check-config 退出码', claudeCheck.exitCode, 0);
  check('claude --check-config 标记 TS 引擎', new TextDecoder().decode(claudeCheck.stdout).includes('engine=ts'));

  const otherCheck = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'other', '--check-config', '--log', alertPath],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  checkEqual('other --check-config 退出码', otherCheck.exitCode, 0);
  const otherCheckOutput = new TextDecoder().decode(otherCheck.stdout);
  check('other --check-config 标记 TS 引擎', otherCheckOutput.includes('engine=ts'));
  check('other --check-config 明示尚未连接', otherCheckOutput.includes('connected=false'));
  const badOtherCheck = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'other', '--check-config', '--poll', '-1'],
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  checkEqual('other --check-config 拒绝非法 poll', badOtherCheck.exitCode, 1);
  check('other --check-config 错误与启动一致', new TextDecoder().decode(badOtherCheck.stdout).includes('invalid_poll'));
  check('--check-config 输出不含 token', !otherCheckOutput.includes(TOKEN));

  const periCheck = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'peri', '--check-config'],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  checkEqual('peri --check-config 退出码', periCheck.exitCode, 0);
  const periCheckOutput = new TextDecoder().decode(periCheck.stdout);
  check('peri --check-config 标记 TS 引擎', periCheckOutput.includes('engine=ts'));
  check('peri --check-config 声明自动 claim', periCheckOutput.includes('auto_claim=1'));
  check('peri --check-config 声明不读正文', periCheckOutput.includes('read_body=0'));
  check('peri --check-config 不执行旧脚本', !periCheckOutput.includes('peri-watch.sh'));
  check('peri --check-config 输出不含 token', !periCheckOutput.includes(TOKEN));

  const dshCheck = Bun.spawnSync({
    cmd: [process.execPath, CLI, 'monitor', '--harness', 'dsh', '--check-config', 'wait', '5'],
    cwd: ROOT,
    env: { ...process.env, AGENTNET_TOKEN: TOKEN },
    stdout: 'pipe',
  });
  checkEqual('dsh --check-config 退出码', dshCheck.exitCode, 0);
  const dshCheckOutput = new TextDecoder().decode(dshCheck.stdout);
  check('dsh --check-config 标记 TS 引擎', dshCheckOutput.includes('engine=ts'));
  check('dsh --check-config 声明不 claim', dshCheckOutput.includes('auto_claim=0'));
  check('dsh --check-config 声明不读正文', dshCheckOutput.includes('read_body=0'));
  check('dsh --check-config 透传子命令参数', dshCheckOutput.includes('args=wait 5'));
  check('dsh --check-config 不执行旧脚本', !dshCheckOutput.includes('dsh-watch.sh'));
  check('dsh --check-config 输出不含 token', !dshCheckOutput.includes(TOKEN));

  await rm(workdir, { recursive: true, force: true });
}

/**
 * 漏消息回归：inbox 查询失败重试、deferred 槽位释放后重领、
 * 重复通知去重与可见事件字段。
 */
async function runMonitorRetryChecks(): Promise<void> {
  checkEqual('inbox 退避 1 秒起', retryDelayMs(1, 1_000, 30_000), 1_000);
  checkEqual('inbox 退避指数增长', retryDelayMs(4, 1_000, 30_000), 8_000);
  checkEqual('inbox 退避封顶 30 秒', retryDelayMs(20, 1_000, 30_000), 30_000);
  checkEqual('claim 退避封顶 30 秒', retryDelayMs(20, 2_000, 30_000), 30_000);

  // 1) pending inbox 查询连续失败后恢复，必须补领并输出可见 ERROR/RECOVERED。
  const inboxMock = createMock({ inboxFailures: 2 });
  inboxMock.state.pending.set('dlv_inbox_retry', delivery('dlv_inbox_retry'));
  const inboxWatcher = startWatcher(inboxMock.base, { AGENTNET_MONITOR_RETRY_BASE_MS: '20' });
  try {
    const errorLine = await waitForLine(
      inboxWatcher.stderr,
      (line) => line.includes('ERROR type=inbox') && line.includes('pending_lookup_failed'),
      'inbox retry ERROR',
      10_000,
    );
    check('inbox 失败输出 attempt/retry_in_ms', /attempt=1 retry_in_ms=\d+/.test(errorLine), errorLine);
    const recovered = await waitForLine(
      inboxWatcher.stderr,
      (line) => line.startsWith('RECOVERED type=inbox'),
      'inbox recovered',
      10_000,
    );
    check('inbox 恢复输出尝试次数', recovered.includes('attempts=2'), recovered);
    const inboxEvent = await waitForEvent(inboxWatcher.stdout, 'delivery', 'dlv_inbox_retry');
    checkEqual('inbox 恢复后补领 pending', inboxMock.state.claimCalls.get('dlv_inbox_retry'), 1);
    checkEqual('inbox 补领只输出一条 delivery', eventCount(inboxWatcher.stdout, 'delivery', 'dlv_inbox_retry'), 1);
    checkEqual('inbox 补领事件 claim_state', inboxEvent.claim_state, 'claimed');
  } finally {
    await inboxWatcher.kill();
    inboxMock.stop();
  }

  // 2) deferred 队列：槽位占用时退避重试、重复通知只提示一次、槽位释放后领取。
  const deferredMock = createMock();
  const deferredWatcher = startWatcher(deferredMock.base, {
    AGENTNET_MONITOR_RETRY_BASE_MS: '30',
  });
  try {
    await waitForLine(deferredWatcher.stderr, (line) => line.includes('READY'), 'deferred READY');
    deferredMock.state.claims.set('dlv_hold', claimedDelivery('dlv_hold'));
    deferredMock.state.pending.set('dlv_wait', delivery('dlv_wait'));
    sendItems(deferredMock, [notificationItem('dlv_wait', 'delivery.created', 'evt_wait_1')]);
    const deferred = await waitForEvent(deferredWatcher.stdout, 'delivery_deferred', 'dlv_wait');
    checkEqual('deferred 指向当前占用者', deferred.claimed_delivery_id, 'dlv_hold');
    check(
      'deferred 带重试轮次与间隔',
      typeof deferred.retry_attempt === 'number' && typeof deferred.retry_in_ms === 'number',
      deferred,
    );

    sendItems(deferredMock, [notificationItem('dlv_wait', 'delivery.created', 'evt_wait_2')]);
    await Bun.sleep(250);
    checkEqual(
      '重复通知不重复输出 deferred',
      eventCount(deferredWatcher.stdout, 'delivery_deferred', 'dlv_wait'),
      1,
    );
    check(
      '槽位占用期间持续退避重试',
      (deferredMock.state.claimCalls.get('dlv_wait') ?? 0) >= 2,
      deferredMock.state.claimCalls.get('dlv_wait'),
    );

    deferredMock.state.claims.clear();
    const delivered = await waitForEvent(deferredWatcher.stdout, 'delivery', 'dlv_wait', 10_000);
    checkEqual('槽位释放后自动领取 attempt', delivered.attempt, 1);
    checkEqual(
      '自动领取只输出一条 delivery',
      eventCount(deferredWatcher.stdout, 'delivery', 'dlv_wait'),
      1,
    );
    const claimCallsAfter = deferredMock.state.claimCalls.get('dlv_wait') ?? 0;
    sendItems(deferredMock, [notificationItem('dlv_wait', 'delivery.created', 'evt_wait_3')]);
    await Bun.sleep(300);
    checkEqual('成功领取后的重复事件不重复 claim', deferredMock.state.claimCalls.get('dlv_wait'), claimCallsAfter);
    checkEqual(
      '成功领取后的重复事件不重复输出',
      eventCount(deferredWatcher.stdout, 'delivery', 'dlv_wait'),
      1,
    );
    checkEqual('deferred 重试全程保持单 claim', deferredMock.state.maxConcurrentClaims, 1);
  } finally {
    await deferredWatcher.kill();
    deferredMock.stop();
  }

  // 3) peri --json：inbox 失败仍输出结构化 error，恢复后正常 delivery。
  const jsonMock = createMock({ inboxFailures: 1 });
  jsonMock.state.pending.set('dlv_json_retry', delivery('dlv_json_retry'));
  const jsonWatcher = startPeriWatcher(
    jsonMock.base,
    { AGENTNET_MONITOR_RETRY_BASE_MS: '20' },
    ['--json'],
  );
  try {
    const jsonError = await waitForEvent(jsonWatcher.stdout, 'error');
    checkEqual('peri --json inbox 错误 kind', jsonError.kind, 'error');
    checkEqual('peri --json inbox 错误 code', jsonError.code, 'pending_lookup_failed');
    checkEqual('peri --json inbox 错误 error_type', jsonError.error_type, 'inbox');
    checkEqual('peri --json inbox 错误 seq', jsonError.seq, null);
    checkEqual('peri --json inbox 错误 delivery_id', jsonError.delivery_id, null);
    checkEqual('peri --json inbox 错误 attempt', jsonError.attempt, 1);
    check(
      'peri --json inbox 错误带 retry_in_ms',
      typeof jsonError.retry_in_ms === 'number' && jsonError.retry_in_ms > 0,
      jsonError,
    );
    const jsonDelivery = await waitForEvent(jsonWatcher.stdout, 'delivery', 'dlv_json_retry');
    checkEqual('peri --json 恢复后补领', jsonMock.state.claimCalls.get('dlv_json_retry'), 1);
    checkEqual('peri --json 补领 kind', jsonDelivery.kind, 'delivery');
  } finally {
    await jsonWatcher.kill();
    jsonMock.stop();
  }
}

async function main(): Promise<void> {
  const requests: JsonObject[] = [];
  const paginatedRpc = {
    callTool: async (_name: string, args: JsonObject) => {
      requests.push(args);
      const offset = args.cursor === 'page-2' ? 50 : 0;
      return {
        ok: true as const,
        data: {
          items: Array.from({ length: offset === 0 ? 50 : 1 }, (_, index) => ({
            delivery_id: `dlv_${offset + index}`,
          })),
          has_more: offset === 0,
          next_cursor: offset === 0 ? 'page-2' : null,
        },
      };
    },
  } as Pick<MonitorRpc, 'callTool'>;
  const paginated = await listInboxPages(paginatedRpc, 'pending');
  check('inbox 补读覆盖第 51 条', paginated.ok && (paginated.data.items as JsonObject[])[50]?.delivery_id === 'dlv_50');
  checkEqual('inbox 第二页携带游标', requests[1]?.cursor, 'page-2');
  const brokenRpc = {
    callTool: async () => ({ ok: true as const, data: { items: [], has_more: true, next_cursor: null } }),
  } as Pick<MonitorRpc, 'callTool'>;
  let rejectedIncomplete = false;
  try {
    await listInboxPages(brokenRpc, 'pending');
  } catch {
    rejectedIncomplete = true;
  }
  check('inbox 缺失下一页游标不得把首页当完整结果', rejectedIncomplete);
  const malformedRpc = {
    callTool: async () => ({ ok: true as const, data: { items: [] } }),
  } as Pick<MonitorRpc, 'callTool'>;
  let rejectedMalformed = false;
  try {
    await listInboxPages(malformedRpc, 'pending');
  } catch {
    rejectedMalformed = true;
  }
  check('inbox 无分页标记不得误判为完整结果', rejectedMalformed);
  console.log('TS monitor: claude harness');
  await runClaudeChecks();
  console.log('TS monitor: delivery quote');
  await runDeliveryQuoteChecks();
  console.log('TS monitor: delivery memory context');
  await runMemoryContextChecks();
  console.log('TS monitor: room events');
  await runRoomEventChecks();
  console.log('TS monitor: inbox/deferred retry');
  await runMonitorRetryChecks();
  console.log('TS monitor: signal cleanup');
  await runCleanupCheck();
  console.log('TS monitor: peri harness');
  await runPeriChecks();
  console.log('TS monitor: peri DEGRADED/RECOVERED');
  await runPeriRecoveryCheck();
  console.log('TS monitor: peri --json contract');
  await runPeriJsonChecks();
  console.log('TS monitor: peri deadline/EXPIRING');
  await runPeriDeadlineChecks();
  console.log('TS monitor: peri signal cleanup');
  await runPeriCleanupCheck();
  console.log('TS monitor: dsh harness');
  await runDshChecks();
  console.log('TS monitor: dsh pending/fatal');
  await runDshZeroPendingCheck();
  await runDshCredentialCheck();
  await runDshNotAgentCheck();
  console.log('TS monitor: dsh lifecycle');
  await runDshLifecycleChecks();
  console.log('TS monitor: other harness');
  await runOtherChecks();
  console.log(`\n${checksPassed()} checks passed`);
}

await main();
