/**
 * MCP 协议基线的采集、归一化与对比工具。
 *
 * 只使用公开 HTTP/MCP 接口和临时自托管实例；token、上传票据、webhook secret
 * 与消息正文不会进入 baseline。JSON-RPC id 使用固定序列，ID/时间字段在
 * 归一化阶段替换为占位符，SSE heartbeat 丢弃。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toolsetDigest } from '../../src/mcp/client-contract';
import { stableStringify } from '../../src/storage/db';
import { ensureTestCertificate, startTestReceiver, type TestReceiver } from './events-harness';
import { reservePort, startTestServer, type TestServer } from './test-server';

export const PARITY_PROTOCOL_VERSION = '2026-07-28';
const LOCAL_ORIGIN = /https?:\/\/127\.0\.0\.1:\d+/gu;
const ID_PATTERN = /\b([a-z]{2,12})_[0-9a-f]{32}\b/gu;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const FILE_ID_PATTERN = /\bf_[A-Za-z0-9_-]{16,}\b/gu;
const SENSITIVE_QUERY = /([?&])(t|token|ticket|secret)=([^&\s"']+)/giu;
const ISO_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
const EPOCH_PATTERN = /\b\d{10,}\b/gu;
const TOKEN_PATTERN = /\bank_[0-9a-zA-Z]+\b/gu;
const SECRET_PATTERN = /\bwhsec_[0-9a-zA-Z_-]+\b/gu;
const LONG_TEXT = 2048;
const REDACT_KEYS = new Set([
  'authorization',
  'body',
  'challenge',
  'final_body',
  'markdown',
  'preview',
  'secret',
  'snippet',
  'token',
]);
const TIME_KEY = /(?:^|_)(?:at|ts|time|until)$/u;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeString(value: string): string {
  let text = value
    .replace(SENSITIVE_QUERY, '$1$2=<redacted>')
    .replace(LOCAL_ORIGIN, '<origin>')
    .replace(ID_PATTERN, '<$1>')
    .replace(FILE_ID_PATTERN, '<file>')
    .replace(UUID_PATTERN, '<uuid>')
    .replace(ISO_PATTERN, '<ts>')
    .replace(EPOCH_PATTERN, '<ts>')
    .replace(TOKEN_PATTERN, '<token>')
    .replace(SECRET_PATTERN, '<secret>');
  if (text.length > LONG_TEXT) {
    text = `<text:sha256:${sha256Hex(value).slice(0, 16)}:len=${value.length}>`;
  }
  return text;
}

function normalizeText(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return JSON.stringify(normalizeValue(parsed));
  } catch {
    return normalizeString(value);
  }
}

export function normalizeValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (key === 'text') return normalizeText(value);
    return normalizeString(value);
  }
  if (typeof value === 'number') {
    if (TIME_KEY.test(key)) return '<ts>';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  if (key === 'headers') {
    const headers: Record<string, unknown> = {};
    for (const [name, headerValue] of Object.entries(source)) {
      headers[name] = /ticket|authorization|cookie|secret/iu.test(name)
        ? '<redacted>'
        : normalizeValue(headerValue);
    }
    return headers;
  }
  const result: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(source)) {
    if (REDACT_KEYS.has(name)) {
      result[name] = child === null || child === undefined ? child : '<redacted>';
      continue;
    }
    if (TIME_KEY.test(name) && (typeof child === 'number' || typeof child === 'string')) {
      result[name] = '<ts>';
      continue;
    }
    result[name] = normalizeValue(child, name);
  }
  return result;
}

interface ToolLike {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

function compactToolsList(result: unknown): unknown {
  const tools = (result as { tools?: ToolLike[] } | null)?.tools ?? [];
  return {
    toolCount: tools.length,
    toolset_sha256: toolsetDigest(tools),
    listing_sha256: sha256Hex(stableStringify(tools)),
    tools: tools.map((tool) => ({ name: tool.name, digest: sha256Hex(stableStringify(tool)) })),
  };
}

export interface TransportView {
  status: number;
  contentType: string | null;
  headers: Record<string, string>;
}

export interface FrameView {
  order: number;
  name: string;
  request: {
    method: string;
    auth: 'bearer' | 'none';
    protocolVersion: string;
    params: unknown;
  };
  transport: TransportView;
  response: unknown;
}

export interface SseView {
  order: number;
  name: string;
  transport: TransportView;
  frames: unknown[];
}

export interface Baseline {
  version: 1;
  protocolVersion: string;
  toolCount: number;
  toolsetSha256: string;
  instructionsSha256: string;
  frames: FrameView[];
  sse: SseView[];
  transports: FrameView[];
  digest: string;
}

interface CallOptions {
  token?: string;
  protocolVersion?: string;
  omitAuth?: boolean;
  omitVersionHeader?: boolean;
  transform?: (result: unknown) => unknown;
}

const KEEP_HEADERS = new Set([
  'access-control-allow-methods',
  'access-control-allow-origin',
  'allow',
  'cache-control',
  'content-type',
  'mcp-protocol-version',
  'vary',
]);

export function transportView(response: Response): TransportView {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (KEEP_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = normalizeString(value);
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    headers,
  };
}

function toolValue(raw: unknown): unknown {
  const result = (raw as { result?: unknown } | null)?.result as
    | { structuredContent?: unknown; content?: { type?: string; text?: string }[] }
    | undefined;
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

class Recorder {
  readonly frames: FrameView[] = [];
  readonly sse: SseView[] = [];
  readonly transports: FrameView[] = [];
  private nextId = 1;

  constructor(
    readonly base: string,
    readonly token: string,
    private readonly sequence: { value: number },
  ) {}

  async call(name: string, method: string, params: Record<string, unknown>, options: CallOptions = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const order = this.sequence.value;
    this.sequence.value += 1;
    const protocolVersion = options.protocolVersion ?? PARITY_PROTOCOL_VERSION;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': method,
    };
    if (!options.omitVersionHeader) headers['mcp-protocol-version'] = protocolVersion;
    if (!options.omitAuth) headers.authorization = `Bearer ${options.token ?? this.token}`;
    if (method === 'tools/call' && typeof params.name === 'string') {
      headers['mcp-name'] = params.name;
    } else if (method === 'resources/read' && typeof params.uri === 'string') {
      headers['mcp-name'] = params.uri;
    }
    const meta = {
      'io.modelcontextprotocol/protocolVersion': protocolVersion,
      'io.modelcontextprotocol/clientInfo': { name: 'agent-network-mcp-parity', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const response = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: { ...params, _meta: meta },
      }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // 非 JSON 响应保留文本；归一化仍会去除 token/时间。
    }
    const responseView =
      options.transform &&
      parsed !== null &&
      typeof parsed === 'object' &&
      'result' in parsed
        ? {
            ...(parsed as Record<string, unknown>),
            result: options.transform((parsed as { result?: unknown }).result),
          }
        : parsed;
    this.frames.push({
      order,
      name,
      request: {
        method,
        auth: options.omitAuth ? 'none' : 'bearer',
        protocolVersion,
        params: normalizeValue(params) as unknown,
      },
      transport: transportView(response),
      response: normalizeValue(responseView),
    });
    return parsed;
  }

  async transport(name: string, request: () => Promise<Response>): Promise<Response> {
    const order = this.sequence.value;
    this.sequence.value += 1;
    const response = await request();
    const body = await response.clone().text();
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      // 保留文本。
    }
    this.transports.push({
      order,
      name,
      request: {
        method: 'TRANSPORT',
        auth: 'bearer',
        protocolVersion: PARITY_PROTOCOL_VERSION,
        params: {},
      },
      transport: transportView(response),
      response: name.startsWith('GET /f/')
        ? { body: '<redacted>', bytes: new TextEncoder().encode(body).length }
        : normalizeValue(parsed),
    });
    return response;
  }

  async getToolValue(name: string, method: string, params: Record<string, unknown>) {
    const raw = await this.call(name, method, params);
    const value = toolValue(raw);
    if (value === undefined) {
      throw new Error(`${name} 没有工具结果：${JSON.stringify(normalizeValue(raw))}`);
    }
    return value;
  }

  async openStream(name: string, subscriptionId: string): Promise<{
    response: Response;
    frames: unknown[];
    waitFor: (predicate: (frame: Record<string, unknown>) => boolean, label: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
    close: () => Promise<void>;
  }> {
    const controller = new AbortController();
    const id = this.nextId;
    this.nextId += 1;
    const order = this.sequence.value;
    this.sequence.value += 1;
    const response = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${this.token}`,
        'mcp-protocol-version': PARITY_PROTOCOL_VERSION,
        'mcp-method': 'subscriptions/listen',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'subscriptions/listen',
        params: {
          notifications: { resourceSubscriptions: ['agentnet://stream'] },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PARITY_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': {
              name: 'agent-network-mcp-parity',
              version: '1.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
      signal: controller.signal,
    });
    const frames: unknown[] = [];
    const dataFrames: Record<string, unknown>[] = [];
    const waiters = new Set<() => void>();
    let buffer = '';
    let done = false;
    const notify = () => {
      for (const waiter of [...waiters]) waiter();
    };
    const pump = (async () => {
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const index = buffer.indexOf('\n\n');
            if (index < 0) break;
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice('data:'.length).trim())
              .join('\n');
            if (!data) continue;
            const parsed = JSON.parse(data) as Record<string, unknown>;
            frames.push(normalizeValue(parsed));
            dataFrames.push(parsed);
            notify();
          }
        }
      } catch {
        // abort 或连接关闭。
      } finally {
        done = true;
        notify();
      }
    })();
    const waitFor = async (
      predicate: (frame: Record<string, unknown>) => boolean,
      label: string,
      timeoutMs = 10_000,
    ): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = dataFrames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `${label} 超时；已收到 ${dataFrames.length} 帧：${JSON.stringify(
              dataFrames.map((frame) => normalizeValue(frame)),
            ).slice(0, 4000)}`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(waiter);
            resolve();
          }, 100);
          const waiter = () => {
            clearTimeout(timer);
            waiters.delete(waiter);
            resolve();
          };
          waiters.add(waiter);
        });
      }
    };
    const close = async () => {
      controller.abort();
      await pump.catch(() => undefined);
      this.sse.push({
        order,
        name,
        transport: transportView(response),
        frames,
      });
    };
    return { response, frames, waitFor, close };
  }
}

function agentSession(name: string): string {
  return `sess_parity_${name}`;
}

function requestId(name: string): string {
  return `parity_${name}`;
}

function toolFrame(name: string, tool: string, args: Record<string, unknown>): {
  name: string;
  method: string;
  params: Record<string, unknown>;
} {
  return { name, method: 'tools/call', params: { name: tool, arguments: args } };
}

async function register(
  recorder: Recorder,
  token: string,
  name: string,
  session: string,
): Promise<{ actor_id: string }> {
  const value = (await recorder.getToolValue(
    `register ${name}`,
    'tools/call',
    toolFrame(name, 'network_register', {
      request_id: requestId(`register_${name}`),
      kind: 'agent',
      name,
      agent_session_id: session,
    }).params,
  )) as { actor_id?: unknown };
  if (typeof value.actor_id !== 'string') {
    throw new Error(`register ${name} 未返回 actor_id`);
  }
  return { actor_id: value.actor_id };
}

async function startMainServer(
  env?: Record<string, string | undefined>,
): Promise<{ server: TestServer; base: string }> {
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startTestServer({
    port,
    tag: 'mcp-parity',
    env: {
      PUBLIC_ORIGIN: base,
      ENVIRONMENT: 'test',
      FILE_TICKET_SECRET: `parity_${randomBytes(16).toString('hex')}`,
      AGENT_PRESENCE_GRACE_MS: '60000',
      AGENT_PRESENCE_ACTIVITY_TTL_MS: '60000',
      AGENT_PRESENCE_TOUCH_THROTTLE_MS: '1000',
      AGENT_PRESENCE_SWEEP_MS: '60000',
      ...env,
    },
  });
  return { server, base };
}

async function startEventsServer(
  env?: Record<string, string | undefined>,
): Promise<{ server: TestServer; base: string }> {
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startTestServer({
    port,
    tag: 'mcp-parity-events',
    env: {
      PUBLIC_ORIGIN: base,
      ENVIRONMENT: 'test',
      EVENTS_ENABLED: '1',
      EVENTS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      EVENTS_TEST_ALLOW_PRIVATE: '1',
      EVENTS_CALLBACK_ALLOWLIST: '127.0.0.1',
      EVENTS_VERIFICATION_TIMEOUT_MS: '10000',
      FILE_TICKET_SECRET: `parity_${randomBytes(16).toString('hex')}`,
      ...env,
    },
  });
  return { server, base };
}

export interface RecordBaselineOptions {
  /** 追加到临时实例的环境变量；4D-1 用它分别验证 native 与 mcp-use 传输。 */
  readonly env?: Record<string, string | undefined>;
}

export async function recordBaseline(options: RecordBaselineOptions = {}): Promise<Baseline> {
  const certificateDir = await mkdtemp(join(tmpdir(), 'agentnet-parity-cert-'));
  let main: TestServer | undefined;
  let events: TestServer | undefined;
  let receiver: TestReceiver | undefined;
  const frames: FrameView[] = [];
  const sse: SseView[] = [];
  const transports: FrameView[] = [];
  try {
    const started = await startMainServer(options.env);
    main = started.server;
    const base = started.base;
    const sequence = { value: 1 };
    const recorder = new Recorder(base, `ank_${randomBytes(24).toString('hex')}`, sequence);
    const peerToken = `ank_${randomBytes(24).toString('hex')}`;
    const peerRecorder = new Recorder(base, peerToken, sequence);

    await register(recorder, recorder.token, 'Parity Owner', agentSession('owner'));
    const peer = await register(peerRecorder, peerToken, 'Parity Peer', agentSession('peer'));

    await recorder.call('server/discover', 'server/discover', {});
    await recorder.call('tools/list', 'tools/list', {}, { transform: compactToolsList });
    await recorder.call(
      'network_me',
      'tools/call',
      toolFrame('network_me', 'network_me', {}).params,
    );
    await recorder.call('resources/list', 'resources/list', {});
    await recorder.call('resources/read stream', 'resources/read', { uri: 'agentnet://stream' });
    await recorder.call('skills/list', 'skills/list', {});
    await recorder.call('skills/get', 'skills/get', { uri: 'skill://agent-network/agent-network/SKILL.md' });
    await recorder.call('resources/read skill', 'resources/read', {
      uri: 'skill://agent-network/agent-network/SKILL.md',
    });

    const roomCreate = (await recorder.getToolValue(
      'network_room_create',
      'tools/call',
      toolFrame('network_room_create', 'network_room_create', {
        request_id: requestId('room_create'),
        kind: 'group',
        members: [peer.actor_id],
        title: 'Parity Room',
      }).params,
    )) as { room?: { room_id?: unknown } };
    if (typeof roomCreate.room?.room_id !== 'string') {
      throw new Error('network_room_create 未返回 room.room_id');
    }
    const roomId = roomCreate.room.room_id;

    await recorder.call('network_room_get', 'tools/call', toolFrame('network_room_get', 'network_room_get', { room_id: roomId }).params);
    const send = (await recorder.call(
      'network_message_send',
      'tools/call',
      toolFrame('network_message_send', 'network_message_send', {
        request_id: requestId('send_a'),
        client_message_id: 'parity_msg_a',
        room_id: roomId,
        body: 'parity ping',
        invoke: [peer.actor_id],
      }).params,
    )) as unknown;
    const sendValue = toolValue(send) as { delivery_ids?: unknown[] } | undefined;
    const deliveryId = Array.isArray(sendValue?.delivery_ids)
      ? sendValue.delivery_ids.find((value): value is string => typeof value === 'string')
      : undefined;
    if (!deliveryId) throw new Error('network_message_send 未返回 delivery_id');

    await recorder.call('network_history_list', 'tools/call', toolFrame('network_history_list', 'network_history_list', { room_id: roomId }).params);
    await recorder.call(
      'network_message_search',
      'tools/call',
      toolFrame('network_message_search', 'network_message_search', { query: 'parity' }).params,
    );
    await peerRecorder.getToolValue(
      'network_inbox_list',
      'tools/call',
      toolFrame('network_inbox_list', 'network_inbox_list', {}).params,
    );
    await peerRecorder.getToolValue(
      'network_delivery_claim',
      'tools/call',
      toolFrame('network_delivery_claim', 'network_delivery_claim', {
        request_id: requestId('claim'),
        delivery_id: deliveryId,
      }).params,
    );

    const listen = await recorder.openStream('subscriptions/listen', 'parity-listen');
    await listen.waitFor(
      (frame) => frame.method === 'notifications/subscriptions/acknowledged',
      'subscriptions/listen ack',
    );
    await recorder.call('network_login', 'tools/call', toolFrame('network_login', 'network_login', {}).params);
    await peerRecorder.call(
      'network_message_send_peer_stream',
      'tools/call',
      toolFrame('network_message_send_peer_stream', 'network_message_send', {
        request_id: requestId('send_peer_stream'),
        client_message_id: 'parity_msg_peer_stream',
        room_id: roomId,
        body: 'parity stream',
        invoke: [],
      }).params,
    );
    await listen.waitFor((frame) => {
      const params = frame.params as Record<string, unknown> | undefined;
      const meta = params?._meta as Record<string, unknown> | undefined;
      const event = meta?.['io.agent-network/event'] as Record<string, unknown> | undefined;
      const items = Array.isArray(event?.items) ? (event.items as Record<string, unknown>[]) : [];
      return (
        frame.method === 'notifications/resources/updated' &&
        items.some(
          (item) =>
            typeof item.source === 'string' && item.source.startsWith('room'),
        )
      );
    }, 'subscriptions/listen room update');
    await listen.close();

    // 文件上传票据与公开下载：只保留形状，票据与正文不进入 baseline。
    const bytes = new TextEncoder().encode('parity file\n');
    const prepare = (await recorder.getToolValue(
      'network_file_upload_prepare',
      'tools/call',
      toolFrame('network_file_upload_prepare', 'network_file_upload_prepare', {
        name: 'parity.txt',
        mime_type: 'text/plain',
        size: bytes.length,
        sha256: sha256Hex(bytes),
      }).params,
    )) as {
      upload_url?: unknown;
      method?: unknown;
      headers?: unknown;
      expires_at?: unknown;
      max_file_bytes?: unknown;
    };
    if (typeof prepare.upload_url !== 'string' || !prepare.headers || typeof prepare.headers !== 'object') {
      throw new Error('network_file_upload_prepare 返回不完整');
    }
    const uploadResponse = await recorder.transport('POST /mcp-upload', () =>
      fetch(prepare.upload_url as string, {
        method: 'POST',
        headers: prepare.headers as Record<string, string>,
        body: bytes,
      }),
    );
    const uploadBody = (await uploadResponse.clone().json().catch(() => null)) as
      | { publicUrl?: unknown }
      | null;
    if (typeof uploadBody?.publicUrl === 'string') {
      await recorder.transport('GET /f/<fileId>', () =>
        fetch(uploadBody.publicUrl as string),
      );
    }
    // 负例：非 POST、无 Bearer、旧版本、legacy initialize、空/多 URI 订阅、旧资源 URI。
    await recorder.transport('GET /mcp', () =>
      fetch(`${base}/mcp`, {
        headers: { authorization: `Bearer ${recorder.token}` },
      }),
    );
    await recorder.transport('OPTIONS /mcp', () =>
      fetch(`${base}/mcp`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://example.test',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      }),
    );
    await recorder.call('tools/list without bearer', 'tools/list', {}, {
      omitAuth: true,
      transform: compactToolsList,
    });
    await recorder.call(
      'network_me without bearer',
      'tools/call',
      toolFrame('network_me without bearer', 'network_me', {}).params,
      { omitAuth: true },
    );
    await recorder.call('tools/list old version', 'tools/list', {}, {
      protocolVersion: '2025-06-18',
    });
    await recorder.call(
      'legacy initialize',
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'legacy-client', version: '0.0.1' },
      },
    );
    await recorder.call('subscriptions/listen empty', 'subscriptions/listen', {
      notifications: { resourceSubscriptions: [] },
    });
    await recorder.call('subscriptions/listen multi-uri', 'subscriptions/listen', {
      notifications: { resourceSubscriptions: ['agentnet://stream', 'agentnet://stream'] },
    });
    await recorder.call('resources/read old uri', 'resources/read', { uri: 'agentnet://me' });

    frames.push(...recorder.frames, ...peerRecorder.frames);
    sse.push(...recorder.sse, ...peerRecorder.sse);
    transports.push(...recorder.transports, ...peerRecorder.transports);
    frames.sort((a, b) => a.order - b.order);
    sse.sort((a, b) => a.order - b.order);
    transports.sort((a, b) => a.order - b.order);

    // events 服务器：独立实例 + 自签 HTTPS receiver。
    const certificate = await ensureTestCertificate(certificateDir);
    receiver = startTestReceiver({ certificate });
    const eventsStarted = await startEventsServer(options.env);
    events = eventsStarted.server;
    const eventsRecorder = new Recorder(
      eventsStarted.base,
      `ank_${randomBytes(24).toString('hex')}`,
      sequence,
    );
    await register(eventsRecorder, eventsRecorder.token, 'Parity Events', agentSession('events'));
    await eventsRecorder.call('events/server/discover', 'server/discover', {});
    await eventsRecorder.call('events/list', 'events/list', {});
    const delivery = {
      mode: 'webhook',
      url: receiver.url('/parity'),
      secret: `whsec_${randomBytes(32).toString('base64')}`,
    };
    await eventsRecorder.call('events/subscribe', 'events/subscribe', {
      name: 'agentnet.message.created',
      arguments: {},
      delivery,
    });
    await eventsRecorder.call('events/unsubscribe', 'events/unsubscribe', {
      name: 'agentnet.message.created',
      delivery,
    });
    await eventsRecorder.call('events/subscribe unknown', 'events/subscribe', {
      name: 'parity.unknown',
      arguments: {},
      delivery,
    });
    frames.push(...eventsRecorder.frames);
    sse.push(...eventsRecorder.sse);
    transports.push(...eventsRecorder.transports);
    frames.sort((a, b) => a.order - b.order);
    sse.sort((a, b) => a.order - b.order);
    transports.sort((a, b) => a.order - b.order);

    const discover = frames.find((frame) => frame.name === 'server/discover')?.response as
      | { result?: { instructions?: unknown } }
      | undefined;
    const instructions = discover?.result?.instructions;
    const toolsFrame = frames.find((frame) => frame.name === 'tools/list')?.response as
      | { result?: { toolCount?: unknown; toolset_sha256?: unknown } }
      | undefined;
    const toolCount = toolsFrame?.result?.toolCount;
    const toolsetSha256 = toolsFrame?.result?.toolset_sha256;
    if (typeof toolCount !== 'number' || typeof toolsetSha256 !== 'string') {
      throw new Error('baseline 缺少 tools/list 摘要');
    }
    const baselineWithoutDigest = {
      version: 1 as const,
      protocolVersion: PARITY_PROTOCOL_VERSION,
      toolCount,
      toolsetSha256,
      instructionsSha256: typeof instructions === 'string' ? sha256Hex(instructions) : '<missing>',
      frames,
      sse,
      transports,
    };
    return {
      ...baselineWithoutDigest,
      digest: sha256Hex(stableStringify(baselineWithoutDigest)),
    };
  } finally {
    await events?.dispose();
    await main?.dispose();
    receiver?.stop();
    await rm(certificateDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function firstDifference(actual: unknown, expected: unknown, path = '$'): string | null {
  if (stableStringify(actual) === stableStringify(expected)) return null;
  if (
    actual === null ||
    expected === null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  ) {
    return `${path}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`;
  }
  if (Array.isArray(actual) !== Array.isArray(expected)) {
    return `${path}: array/object mismatch`;
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      return `${path}.length: actual=${actual.length} expected=${expected.length}`;
    }
    for (let index = 0; index < actual.length; index += 1) {
      const diff = firstDifference(actual[index], expected[index], `${path}[${index}]`);
      if (diff) return diff;
    }
    return null;
  }
  const actualObject = actual as Record<string, unknown>;
  const expectedObject = expected as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(actualObject), ...Object.keys(expectedObject)])].sort();
  for (const key of keys) {
    const diff = firstDifference(actualObject[key], expectedObject[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}

export { firstDifference };

/** baseline 不得包含凭据、票据正文或消息正文。 */
export function assertNoSecrets(baseline: Baseline, secrets: string[]): void {
  const text = stableStringify(baseline);
  for (const secret of secrets) {
    if (secret.length > 0 && text.includes(secret)) {
      throw new Error(`baseline 包含未脱敏内容：${secret}`);
    }
  }
  const leaks: [string, RegExp][] = [
    ['bearer token', /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/u],
    ['api token', /\bank_[0-9a-zA-Z]{16,}\b/u],
    ['webhook secret', /\bwhsec_[A-Za-z0-9+/=]{20,}\b/u],
    ['query secret', /[?&](?:t|token|ticket)=(?!<redacted>)[^&\s"']+/iu],
  ];
  for (const [label, pattern] of leaks) {
    if (pattern.test(text)) throw new Error(`baseline 包含 ${label}`);
  }
}
