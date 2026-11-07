/**
 * 验收脚本的共享工具：官方 TS SDK 客户端、工具调用与断言。
 *
 * 所有脚本都通过 AGENTNET_URL 指向被测服务（默认本地 wrangler dev），
 * 因此同一份用例既能验收本地，也能验收部署后的远端。
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { McpSubscription, SubscriptionFilter } from '@modelcontextprotocol/client';

export const PROTOCOL_VERSION = '2026-07-28';

export function baseUrl(): string {
  return (process.env.AGENTNET_URL ?? 'http://127.0.0.1:8792').replace(/\/+$/u, '');
}

export function mcpUrl(): URL {
  return new URL(`${baseUrl()}/mcp`);
}

export function newToken(): string {
  return `ank_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function newRequestId(prefix = 'req'): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export class CheckFailure extends Error {
  constructor(
    readonly label: string,
    message: string,
  ) {
    super(`${label}: ${message}`);
    this.name = 'CheckFailure';
  }
}

let checks = 0;

export function check(label: string, condition: unknown, detail?: unknown): void {
  checks += 1;
  if (!condition) {
    const suffix = detail === undefined ? '' : ` (${JSON.stringify(detail)})`;
    throw new CheckFailure(label, `断言失败${suffix}`);
  }
  console.log(`  ✓ ${label}`);
}

export function checkEqual(label: string, actual: unknown, expected: unknown): void {
  check(label, Object.is(actual, expected), { actual, expected });
}

export function checksPassed(): number {
  return checks;
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(`${code}: ${String(body.message ?? '')}`);
    this.name = 'ToolError';
  }
}

export interface McpConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  token: string;
  close(): Promise<void>;
}

export function connect(token: string): McpConnection {
  const client = new Client(
    { name: 'agent-network-acceptance', version: '0.1.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    authProvider: { token: async () => token },
  });
  return {
    client,
    transport,
    token,
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

export async function connectClient(token: string): Promise<McpConnection> {
  const connection = connect(token);
  await connection.client.connect(connection.transport);
  return connection;
}

interface RawToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** 调用工具；业务错误统一抛出 `ToolError`，错误体来自服务端契约。 */
export async function callTool<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as RawToolResult;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError) {
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { message: text };
      }
    }
    throw new ToolError(String(body.code ?? 'UNKNOWN'), body);
  }
  if (result.structuredContent) return result.structuredContent as T;
  if (text) return JSON.parse(text) as T;
  return {} as T;
}

export async function expectToolError(
  label: string,
  promise: Promise<unknown>,
  code: string,
): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ToolError) {
      checkEqual(label, error.code, code);
      return error;
    }
    throw error;
  }
  throw new CheckFailure(label, `期望错误 ${code}，但调用成功`);
}

export async function readResourceJson<T = Record<string, unknown>>(
  client: Client,
  uri: string,
): Promise<T> {
  const result = await client.readResource({ uri });
  const first = result.contents?.[0] as { text?: string } | undefined;
  if (!first?.text) throw new CheckFailure('readResource', `资源 ${uri} 没有文本内容`);
  return JSON.parse(first.text) as T;
}

export function notificationCollector(client: Client): {
  events: { method: string; params: Record<string, unknown> }[];
  reset(): void;
  waitFor(predicate: (event: { method: string; params: Record<string, unknown> }) => boolean, label: string, timeoutMs?: number): Promise<{ method: string; params: Record<string, unknown> }>;
} {
  const events: { method: string; params: Record<string, unknown> }[] = [];
  const waiters = new Set<() => void>();
  client.setNotificationHandler('notifications/resources/updated', (notification) => {
    events.push({
      method: 'notifications/resources/updated',
      params: (notification.params ?? {}) as Record<string, unknown>,
    });
    for (const notify of waiters) notify();
  });
  return {
    events,
    reset() {
      events.length = 0;
    },
    async waitFor(predicate, label, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new CheckFailure(label, '等待通知超时');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(notify);
            resolve();
          }, 250);
          const notify = () => {
            clearTimeout(timer);
            waiters.delete(notify);
            resolve();
          };
          waiters.add(notify);
        });
      }
    },
  };
}

export async function openSubscription(
  client: Client,
  uris: string[],
): Promise<McpSubscription> {
  const filter: SubscriptionFilter = { resourceSubscriptions: uris };
  return client.listen(filter);
}

export interface RawListen {
  response: Response;
  /** 已解析的 SSE 帧（不含空行分隔符）。 */
  frames: string[];
  text(): string;
  errorBody(): Record<string, unknown> | null;
  waitForFrame(
    predicate: (frame: string) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<string>;
  close(): Promise<void>;
}

/**
 * 原始 `subscriptions/listen` 请求，用于验证自定义 SSE 的 wire 形状、
 * keepalive、abort 与错误响应。调用方必须 close。
 */
export async function openRawListen(
  token: string,
  subscriptionId: string,
  uris: string[],
  options: { protocolVersion?: string | null; signal?: AbortSignal } = {},
): Promise<RawListen> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const meta: Record<string, unknown> = {};
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  if (protocolVersion !== null) {
    meta['io.modelcontextprotocol/protocolVersion'] = protocolVersion;
    meta['io.modelcontextprotocol/clientInfo'] = {
      name: 'agent-network-raw-listen',
      version: '0.1.0',
    };
    meta['io.modelcontextprotocol/clientCapabilities'] = {};
  }
  const response = await fetch(mcpUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: subscriptionId,
      method: 'subscriptions/listen',
      params: { _meta: meta, notifications: { resourceSubscriptions: uris } },
    }),
    signal: controller.signal,
  });

  const frames: string[] = [];
  let rawText = '';
  let buffer = '';
  let terminal = false;
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const isSse = (response.headers.get('content-type') ?? '').includes('text/event-stream');

  const pump = (async () => {
    if (!isSse || !response.body) {
      rawText = await response.text();
      terminal = true;
      notify();
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index < 0) break;
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.trim().length > 0) frames.push(frame);
        }
        notify();
      }
    } catch {
      // abort 或连接重置；由调用方按场景处理。
    } finally {
      terminal = true;
      notify();
    }
  })();

  return {
    response,
    frames,
    text() {
      return isSse ? frames.join('\n\n') : rawText;
    },
    errorBody() {
      if (isSse) return null;
      try {
        return JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async waitForFrame(predicate, label, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (terminal && Date.now() > deadline) {
          throw new CheckFailure(label, `等待 SSE 帧超时；已收到 ${frames.length} 帧`);
        }
        if (Date.now() > deadline) throw new CheckFailure(label, '等待 SSE 帧超时');
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
    },
    async close() {
      options.signal?.removeEventListener('abort', onAbort);
      controller.abort();
      await pump.catch(() => undefined);
    },
  };
}

export async function waitUntil(
  label: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new CheckFailure(label, '等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function subscriptionIdOf(params: Record<string, unknown>): string | undefined {
  const meta = params._meta as Record<string, unknown> | undefined;
  const value = meta?.['io.modelcontextprotocol/subscriptionId'];
  return typeof value === 'string' ? value : undefined;
}

/** 直接发原始 JSON-RPC POST，用于验证协议面（不依赖 SDK 的容错）。 */
export async function rawRpc(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    token?: string;
    headers?: Record<string, string>;
    protocolVersion?: string | null;
    versionHeader?: string | null;
    clientCapabilities?: Record<string, unknown>;
    /** 覆盖 MCP 端点；用于验证 URL 凭据。 */
    url?: URL;
  } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-method': method,
    ...options.headers,
  };
  if (method === 'tools/call' && typeof params.name === 'string') {
    headers['mcp-name'] = params.name;
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.versionHeader !== null) {
    headers['mcp-protocol-version'] = options.versionHeader ?? PROTOCOL_VERSION;
  }

  const meta: Record<string, unknown> = {};
  if (options.protocolVersion !== null) {
    meta['io.modelcontextprotocol/protocolVersion'] = options.protocolVersion ?? PROTOCOL_VERSION;
    meta['io.modelcontextprotocol/clientInfo'] = {
      name: 'agent-network-protocol-check',
      version: '0.1.0',
    };
    meta['io.modelcontextprotocol/clientCapabilities'] =
      options.clientCapabilities ?? {};
  }

  const response = await fetch(options.url ?? mcpUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: newRequestId('rpc'),
      method,
      params: { ...params, _meta: meta },
    }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface UploadedTestFile {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  publicUrl: string;
  previewUrl: string;
  downloadUrl: string;
  state: 'draft' | 'bound' | 'deleted';
  visibility: 'private' | 'public';
  retained: boolean;
  quota?: {
    used_bytes: number;
    limit_bytes: number;
    used_files: number;
    limit_files: number;
    retained_bytes: number;
  };
}

/** MCPP Files v1 上传；返回服务端追加的私有票据地址，供房间文件用例复用。 */
export async function uploadTestFile(
  token: string,
  input: { name: string; mimeType: string; body: string | Uint8Array },
): Promise<UploadedTestFile> {
  const bytes =
    typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body;
  const response = await fetch(`${baseUrl()}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': input.mimeType,
      'MCPP-File-Name': input.name,
      'MCPP-File-Size': String(bytes.length),
    },
    body: bytes as unknown as BodyInit,
  });
  if (response.status !== 201) {
    throw new CheckFailure('MCPP 上传', `期望 201，实际 ${response.status}`);
  }
  return (await response.json()) as UploadedTestFile;
}
