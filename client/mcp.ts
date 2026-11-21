/**
 * MCP 2026-07-28 原始 JSON-RPC 客户端。
 *
 * 服务端是 modern-only：没有 initialize、没有协议 session，也不接受旧版本。
 * 每个请求都必须带 `MCP-Protocol-Version`、`MCP-Method`，tools/call 还需
 * `MCP-Name`，并在 `params._meta` 中放命名空间化的协议元数据。
 *
 * 这里刻意不依赖 MCP SDK：CLI 要能独立打包成单文件，且错误信息必须
 * 可读、可脚本判断，同时绝不把 token 写进日志或错误输出。
 */

import { readFileSync, statSync } from 'node:fs';

import { parseSseJsonText } from '../src/contracts/sse';
import { ActorMismatchError } from './expect-actor';
import { asString } from './output';

export const PROTOCOL_VERSION = '2026-07-28';
export const CLIENT_NAME = 'agentnet-cli';
export const CLIENT_VERSION = '3.0.0';

export interface GlobalCliOptions {
  url?: string | undefined;
  token?: string | undefined;
  json: boolean;
}

export interface ResolvedConfig {
  /** 完整 MCP 端点（不含 token 查询参数）。 */
  endpoint: string;
  /** 服务根地址，用于下载 /skills/* 脚本。 */
  baseUrl: string;
  token: string | null;
  json: boolean;
}

export class CliError extends Error {
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, options: { code?: string | undefined; details?: unknown } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = options.code;
    this.details = options.details;
  }
}

/** 统一脱敏：任何要展示给用户的文本都先经过这里。 */
export function redact(text: string, token: string | null | undefined): string {
  let output = text;
  if (token) output = output.split(token).join('[REDACTED]');
  return output
    .replace(/(authorization:\s*bearer\s+)\S+/giu, '$1[REDACTED]')
    .replace(/([?&]token=)[^&\s]+/giu, '$1[REDACTED]');
}

/** 结构化错误同样要脱敏；递归处理 details 里的字符串与键值。 */
export function redactValue(value: unknown, token: string | null | undefined): unknown {
  if (typeof value === 'string') return redact(value, token);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, token));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactValue(item, token);
    }
    return output;
  }
  return value;
}

/**
 * 读取 token 文件。
 *
 * - 只取首行并去掉首尾空白；空文件视为配置错误。
 * - POSIX 下要求权限恰好为 600，避免凭据被同机其他用户读取；Windows 不做这项检查。
 * - 错误信息只包含路径与权限，不回显文件内容。
 */
export function readTokenFile(path: string, label = 'AGENTNET_TOKEN_FILE'): string {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new CliError(`无法读取 ${label}：${path}（检查路径与权限）`);
  }
  if (!stats.isFile()) {
    throw new CliError(`${label} 不是普通文件：${path}`);
  }
  if (process.platform !== 'win32') {
    const mode = stats.mode & 0o777;
    if (mode !== 0o600) {
      throw new CliError(
        `${label} 权限必须是 600（当前 ${mode.toString(8).padStart(3, '0')}）：` +
          `运行 chmod 600 ${path} 后重试`,
      );
    }
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CliError(`无法读取 ${label}：${path}（检查路径与权限）`);
  }
  const first = (text.split(/\r?\n/u)[0] ?? '').trim();
  if (first.length === 0) {
    throw new CliError(`${label} 为空：${path}`);
  }
  return first;
}

/**
 * token 优先级：`--token` > `AGENTNET_TOKEN` > `AGENTNET_TOKEN_FILE` > URL 的
 * `?token=`。高优先级来源存在时不会读取低优先级来源，也不会打印 token。
 */
export function resolveToken(explicit?: string): string | null {
  if (explicit !== undefined && explicit !== '') return explicit;
  const envToken = process.env.AGENTNET_TOKEN;
  if (envToken !== undefined && envToken !== '') return envToken;
  const tokenFile = process.env.AGENTNET_TOKEN_FILE;
  if (tokenFile !== undefined && tokenFile !== '') return readTokenFile(tokenFile);
  return null;
}

function normalizeEndpoint(raw: string): { endpoint: string; urlToken: string | null } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError('服务地址不是合法 URL（检查 --url 或 AGENTNET_URL）');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError('服务地址必须是 http:// 或 https://');
  }
  const urlToken = parsed.searchParams.get('token');
  parsed.searchParams.delete('token');
  parsed.hash = '';
  const path = parsed.pathname.replace(/\/+$/u, '');
  parsed.pathname = path.endsWith('/mcp') ? path : `${path}/mcp`;
  return { endpoint: parsed.toString(), urlToken };
}

export function resolveConfig(options: GlobalCliOptions): ResolvedConfig {
  const raw = options.url ?? process.env.AGENTNET_URL;
  if (!raw) {
    throw new CliError('缺少服务地址：使用 --url 或设置 AGENTNET_URL');
  }
  const { endpoint, urlToken } = normalizeEndpoint(raw);
  const token = resolveToken(options.token) ?? urlToken;
  const parsed = new URL(endpoint);
  const basePath = parsed.pathname.replace(/\/mcp$/u, '').replace(/\/+$/u, '');
  return {
    endpoint,
    baseUrl: `${parsed.origin}${basePath}`,
    token: token ? token : null,
    json: options.json,
  };
}

interface JsonRpcSuccess {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
}

interface JsonRpcFailure {
  jsonrpc?: string;
  id?: string | number | null;
  error?: {
    code?: number;
    message?: string;
    data?: { code?: string; details?: unknown };
  };
}

interface ToolResult {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

export function parseRpcPayload(text: string, contentType: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 继续尝试 SSE。
  }
  if (!contentType.includes('text/event-stream')) return null;
  return parseSseJsonText(trimmed);
}

function toolErrorDetail(result: ToolResult): { message: string; code?: string; details?: unknown } {
  const text = (result.content ?? []).find((item) => item.type === 'text')?.text;
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      } else {
        return { message: text };
      }
    } catch {
      return { message: text };
    }
  } else {
    // Drive 等文件工具把错误放在 structuredContent.error；content 可能为空。
    const structured = result.structuredContent;
    const error =
      structured !== null && typeof structured === 'object'
        ? (structured as Record<string, unknown>).error
        : undefined;
    if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
      parsed = error as Record<string, unknown>;
    }
  }
  const code = typeof parsed.code === 'string' ? parsed.code : undefined;
  const message =
    typeof parsed.message === 'string' && parsed.message.length > 0
      ? parsed.message
      : (code ?? '工具调用失败');
  // 保留 details；没有 details 时把同一错误对象里的 parameter/retryable
  // 等附加字段带出去，避免 Drive 错误只剩一句 code。
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== 'message' && key !== 'code' && key !== 'details') extras[key] = value;
  }
  const details =
    parsed.details !== undefined
      ? parsed.details
      : Object.keys(extras).length > 0
        ? extras
        : undefined;
  return {
    message,
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
  };
}

export interface RpcOptions {
  name?: string;
  /** 仅供身份闸门内部调用 network_me 时跳过递归校验。 */
  skipIdentity?: boolean;
}

export interface McpClientOptions {
  /** 设置后，任何 RPC 前先调用 network_me 并核对 actor_id。 */
  expectActor?: string;
}

export class McpClient {
  private verifiedActor: string | null = null;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly options: McpClientOptions = {},
  ) {}

  get resolved(): ResolvedConfig {
    return this.config;
  }

  private toolResult(result: ToolResult): Record<string, unknown> {
    if (result.isError) {
      const detail = toolErrorDetail(result);
      throw new CliError(detail.message, { code: detail.code, details: detail.details });
    }
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      return result.structuredContent;
    }
    const text = (result.content ?? []).find((item) => item.type === 'text')?.text;
    if (!text) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    } catch {
      return { text };
    }
  }

  private async callToolUnchecked(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.toolResult(
      (await this.rpc('tools/call', { name, arguments: args }, { name, skipIdentity: true })) as ToolResult,
    );
  }

  /**
   * 在业务调用前确认凭据归属。与 network_me 复用同一次请求；
   * 错误只包含 actor id，绝不包含 token。
   */
  async verifyActor(expected: string): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]+$/u.test(expected)) {
      throw new CliError('--expect-actor 必须是非空 actor_id');
    }
    if (this.verifiedActor === expected) return {};
    // network_me 自己就是身份调用；绕过闸门，避免递归。
    const me = await this.callToolUnchecked('network_me', {});
    const actual = asString(me.actor_id);
    if (!/^[A-Za-z0-9_-]+$/u.test(actual)) {
      throw new CliError('network_me 未返回有效 actor_id');
    }
    if (actual !== expected) throw new ActorMismatchError(expected, actual);
    this.verifiedActor = expected;
    return me;
  }

  private async ensureIdentity(): Promise<void> {
    const expected = this.options.expectActor;
    if (!expected || this.verifiedActor === expected) return;
    await this.verifyActor(expected);
  }

  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    options: RpcOptions = {},
  ): Promise<Record<string, unknown>> {
    if (!options.skipIdentity) await this.ensureIdentity();
    const id = `cli-${crypto.randomUUID()}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-method': method,
    };
    if (options.name) headers['mcp-name'] = options.name;
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': {
            name: CLIENT_NAME,
            version: CLIENT_VERSION,
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };

    let response: Response;
    try {
      response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(`无法连接 MCP 服务：${reason}`);
    }

    const text = await response.text().catch(() => '');
    const payload = parseRpcPayload(text, response.headers.get('content-type') ?? '');
    const failure = payload as JsonRpcFailure | null;
    if (failure?.error) {
      throw new CliError(failure.error.message ?? 'MCP 请求失败', {
        code: failure.error.data?.code,
        details: failure.error.data?.details,
      });
    }
    if (!response.ok) {
      throw new CliError(`MCP 请求失败：HTTP ${response.status} ${response.statusText}`);
    }
    if (payload === null) {
      throw new CliError('MCP 响应不是合法 JSON');
    }
    const success = payload as JsonRpcSuccess;
    if (!('result' in success)) {
      throw new CliError('MCP 响应缺少 result');
    }
    return success.result !== null && typeof success.result === 'object'
      ? (success.result as Record<string, unknown>)
      : { value: success.result };
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (name === 'network_me' && this.options.expectActor) {
      if (this.verifiedActor !== this.options.expectActor) {
        return this.verifyActor(this.options.expectActor);
      }
    } else {
      await this.ensureIdentity();
    }
    return this.callToolUnchecked(name, args);
  }

  async readResource(uri: string): Promise<string> {
    const result = await this.rpc('resources/read', { uri }, { name: uri });
    const contents = result.contents;
    if (!Array.isArray(contents)) return '';
    const first = contents[0] as { text?: unknown } | undefined;
    return typeof first?.text === 'string' ? first.text : '';
  }
}
