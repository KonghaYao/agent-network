/**
 * 监控引擎专用的 MCP 2026-07-28 传输层。
 *
 * 与 `client/mcp.ts` 的普通 CLI 调用不同，监听器必须区分三类失败：
 * - `credential`：401/403 或工具返回 CREDENTIAL_INVALID，重试没有意义；
 * - `protocol`：400 或协议版本不匹配，必须让宿主修复配置；
 * - `transport`：暂时性断线，交给重连退避处理。
 *
 * 工具业务错误（例如 CLAIM_CONFLICT）不是传输错误，由调用方决定语义。
 * 这里不打印 token，也不把 Authorization 写进错误文本。
 */

import { asArray, asRecord, asString } from '../output';
import { parseRpcPayload, PROTOCOL_VERSION, redact } from '../mcp';

export type JsonObject = Record<string, unknown>;

export type FatalKind = 'credential' | 'protocol';

export class MonitorFatalError extends Error {
  constructor(
    readonly kind: FatalKind,
    message: string,
  ) {
    super(message);
    this.name = 'MonitorFatalError';
  }
}

export class MonitorTransportError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'MonitorTransportError';
  }
}

export type ToolCallOutcome =
  | { ok: true; data: JsonObject }
  | { ok: false; code: string; message: string };

export interface MonitorRpcConfig {
  endpoint: string;
  token: string;
  clientName?: string;
  clientVersion?: string;
  signal?: AbortSignal;
}

function toolErrorDetail(result: JsonObject): { code: string; message: string } {
  const text = asArray(result.content)
    .map(asRecord)
    .find((item) => item.type === 'text' && typeof item.text === 'string');
  const raw = typeof text?.text === 'string' ? text.text : '';
  if (raw.length > 0) {
    try {
      const parsed = asRecord(JSON.parse(raw) as unknown);
      return {
        code: asString(parsed.code, 'UNKNOWN'),
        message: asString(parsed.message),
      };
    } catch {
      return { code: 'UNKNOWN', message: raw };
    }
  }
  const structured = asRecord(result.structuredContent);
  const error = asRecord(structured.error);
  return {
    code: asString(error.code, 'UNKNOWN'),
    message: asString(error.message),
  };
}

export class MonitorRpc {
  readonly endpoint: string;
  private readonly token: string;
  private readonly clientName: string;
  private readonly clientVersion: string;

  constructor(private readonly config: MonitorRpcConfig) {
    this.endpoint = config.endpoint;
    this.token = config.token;
    this.clientName = config.clientName ?? 'agentnet-monitor';
    this.clientVersion = config.clientVersion ?? '3.0.0';
  }

  private meta(): JsonObject {
    return {
      'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo': {
        name: this.clientName,
        version: this.clientVersion,
      },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
  }

  authHeaders(method: string, accept: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept,
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': method,
      authorization: `Bearer ${this.token}`,
    };
  }

  /** POST JSON-RPC；传输层失败抛错，RPC 业务错误保留在返回 payload。 */
  private async post(method: string, params: JsonObject, name?: string): Promise<JsonObject> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const onAbort = (): void => controller.abort();
    const outer = this.config.signal;
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', onAbort, { once: true });
    }
    const body = {
      jsonrpc: '2.0',
      id: `monitor-${crypto.randomUUID()}`,
      method,
      params: { ...params, _meta: this.meta() },
    };
    try {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.authHeaders(method, 'application/json, text/event-stream'),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new MonitorTransportError(redact(reason, this.token));
      }
      const text = await response.text().catch(() => '');
      if (response.status === 400) {
        throw new MonitorFatalError('protocol', 'request_rejected');
      }
      if (response.status === 401 || response.status === 403) {
        throw new MonitorFatalError('credential', 'credential_invalid');
      }
      if (!response.ok) {
        throw new MonitorTransportError(`HTTP ${response.status}`, response.status);
      }
      const payload = parseRpcPayload(text, response.headers.get('content-type') ?? '');
      if (payload === null) {
        throw new MonitorTransportError('invalid_response');
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  /** 能力发现：只接受 2026-07-28，不降级。 */
  async discover(): Promise<void> {
    let payload: JsonObject;
    try {
      payload = await this.post('server/discover', {});
    } catch (error) {
      if (error instanceof MonitorFatalError && error.kind === 'credential') throw error;
      if (error instanceof MonitorFatalError) {
        throw new MonitorFatalError('protocol', 'discover_failed');
      }
      throw error;
    }
    if (payload.error !== undefined) {
      throw new MonitorFatalError('protocol', 'discover_failed');
    }
    const supported = asArray(asRecord(payload.result).supportedVersions);
    if (!supported.includes(PROTOCOL_VERSION)) {
      throw new MonitorFatalError('protocol', 'discover_failed');
    }
  }

  async callTool(name: string, args: JsonObject = {}): Promise<ToolCallOutcome> {
    const payload = await this.post('tools/call', { name, arguments: args }, name);
    if (payload.error !== undefined) {
      const error = asRecord(payload.error);
      const data = asRecord(error.data);
      const code = asString(data.code, asString(error.code, 'UNKNOWN'));
      const message = asString(error.message);
      if (code === 'CREDENTIAL_INVALID') {
        throw new MonitorFatalError('credential', 'credential_invalid');
      }
      return { ok: false, code: code === '' ? 'UNKNOWN' : code, message };
    }
    const result = asRecord(payload.result);
    if (result.isError === true) {
      const detail = toolErrorDetail(result);
      if (detail.code === 'CREDENTIAL_INVALID') {
        throw new MonitorFatalError('credential', 'credential_invalid');
      }
      return { ok: false, code: detail.code, message: detail.message };
    }
    const structured = asRecord(result.structuredContent);
    if (Object.keys(structured).length > 0) {
      return { ok: true, data: structured };
    }
    const text = asArray(result.content)
      .map(asRecord)
      .find((item) => item.type === 'text' && typeof item.text === 'string');
    if (typeof text?.text !== 'string' || text.text.length === 0) {
      return { ok: true, data: {} };
    }
    try {
      const parsed = JSON.parse(text.text) as unknown;
      return { ok: true, data: asRecord(parsed) };
    } catch {
      return { ok: true, data: { text: text.text } };
    }
  }

  /** 订阅请求体；监听循环只负责读取 SSE 帧。 */
  subscriptionBody(subscriptionId: string, uri: string): JsonObject {
    return {
      jsonrpc: '2.0',
      id: subscriptionId,
      method: 'subscriptions/listen',
      params: {
        notifications: { resourceSubscriptions: [uri] },
        _meta: this.meta(),
      },
    };
  }
}

export interface SubscriptionOutcome {
  /** ack_timeout | idle_timeout | stream_closed | connection_reset | terminated | login_failed | http_N */
  reason: string;
  status: number;
  acked: boolean;
  /** ack 时刻（毫秒）；未 ack 为 0。 */
  ackedAt: number;
}

export interface SubscriptionControl {
  /** 由 hook 主动结束当前连接；reason 会出现在 RECONNECTING 诊断中。 */
  abort: (reason: string) => void;
}

export interface SubscriptionOptions {
  subscriptionId: string;
  uri: string;
  ackTimeoutMs: number;
  idleTimeoutMs: number;
  signal: AbortSignal;
  onAck: (control: SubscriptionControl) => Promise<void> | void;
  onFrame: (frame: JsonObject) => Promise<void> | void;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseFrame(data: string): JsonObject | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 订阅 agentnet://stream 并在连接结束（或主动 abort）时返回结束原因。
 *
 * 行为对齐旧 shell 监听：
 * - 60 秒内没有 acknowledged 视为 ack_timeout；
 * - 15 秒没有任何字节（含 keepalive）视为 idle_timeout；
 * - 400 / 401 / 403 直接抛 MonitorFatalError，不重连。
 */
export async function subscribe(
  rpc: MonitorRpc,
  options: SubscriptionOptions,
): Promise<SubscriptionOutcome> {
  const controller = new AbortController();
  let reason = 'stream_closed';
  let acked = false;
  let ackedAt = 0;
  let status = 0;
  let fatal: MonitorFatalError | null = null;
  let finished = false;
  let lastActivity = Date.now();

  const finish = (next: string): void => {
    if (finished) return;
    finished = true;
    reason = next;
    controller.abort();
  };

  const onOuterAbort = (): void => finish('terminated');
  if (options.signal.aborted) finish('terminated');
  else options.signal.addEventListener('abort', onOuterAbort, { once: true });

  const ackTimer = setTimeout(() => {
    if (!acked) finish('ack_timeout');
  }, options.ackTimeoutMs);

  const idleTimer = setInterval(
    () => {
      if (finished) return;
      if (Date.now() - lastActivity >= options.idleTimeoutMs) finish('idle_timeout');
    },
    Math.max(100, Math.min(1000, Math.floor(options.idleTimeoutMs / 4))),
  );

  const control: SubscriptionControl = {
    abort: (next: string): void => finish(next),
  };

  const dispatch = async (data: string): Promise<void> => {
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.method === 'notifications/subscriptions/acknowledged') {
      if (!acked) {
        acked = true;
        ackedAt = Date.now();
        clearTimeout(ackTimer);
        await options.onAck(control);
      }
      return;
    }
    if (frame.method === 'notifications/resources/updated') {
      await options.onFrame(frame);
    }
  };

  try {
    let response: Response;
    try {
      response = await fetch(rpc.endpoint, {
        method: 'POST',
        headers: rpc.authHeaders('subscriptions/listen', 'text/event-stream'),
        body: JSON.stringify(rpc.subscriptionBody(options.subscriptionId, options.uri)),
        signal: controller.signal,
      });
    } catch {
      if (finished) return { reason, status, acked, ackedAt };
      return { reason: 'connection_reset', status, acked, ackedAt };
    }
    status = response.status;
    if (response.status === 400) {
      throw new MonitorFatalError('protocol', 'request_rejected');
    }
    if (response.status === 401 || response.status === 403) {
      throw new MonitorFatalError('credential', 'credential_invalid');
    }
    if (!response.ok || response.body === null) {
      return { reason: `http_${response.status}`, status, acked, ackedAt };
    }
    lastActivity = Date.now();

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const text = await response.text().catch(() => '');
      try {
        if (text.trim().length > 0) await dispatch(text.trim());
      } catch (error) {
        if (error instanceof MonitorFatalError) fatal = error;
        else throw error;
      }
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const dataLines: string[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivity = Date.now();
          buffer += decoder.decode(value, { stream: true });
          const lineBreak = /^(.*?)(\r\n|\n|\r)/;
          for (;;) {
            const match = lineBreak.exec(buffer);
            if (!match) break;
            const line = match[1] ?? '';
            buffer = buffer.slice(match[0].length);
            if (line === '') {
              if (dataLines.length > 0) {
                const data = dataLines.join('\n');
                dataLines.length = 0;
                await dispatch(data);
              }
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
        }
        if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
        if (dataLines.length > 0) {
          const data = dataLines.join('\n');
          dataLines.length = 0;
          await dispatch(data);
        }
      } catch (error) {
        if (error instanceof MonitorFatalError) {
          fatal = error;
        } else if (!controller.signal.aborted) {
          reason = 'connection_reset';
        }
      } finally {
        reader.releaseLock();
      }
    }
  } catch (error) {
    if (error instanceof MonitorFatalError) fatal = error;
    else if (!controller.signal.aborted) reason = 'connection_reset';
  } finally {
    finished = true;
    clearTimeout(ackTimer);
    clearInterval(idleTimer);
    options.signal.removeEventListener('abort', onOuterAbort);
  }

  if (fatal) throw fatal;
  if (reason === 'terminated') return { reason, status, acked, ackedAt };
  if (!acked && reason === 'stream_closed') reason = 'ack_timeout';
  return { reason, status, acked, ackedAt };
}
