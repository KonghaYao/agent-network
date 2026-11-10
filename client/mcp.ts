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

export const PROTOCOL_VERSION = '2026-07-28';
export const CLIENT_NAME = 'agentnet-cli';
export const CLIENT_VERSION = '2.0.0';

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
  const token = options.token ?? process.env.AGENTNET_TOKEN ?? urlToken;
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

function parseRpcPayload(text: string, contentType: string): Record<string, unknown> | null {
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
  let candidate: Record<string, unknown> | null = null;
  for (const frame of trimmed.split(/\r?\n\r?\n/u)) {
    const data = frame
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        candidate = parsed as Record<string, unknown>;
      }
    } catch {
      // 忽略无法解析的帧；SSE 可能包含 keepalive 或通知。
    }
  }
  return candidate;
}

function toolErrorDetail(result: ToolResult): { message: string; code?: string; details?: unknown } {
  const text = (result.content ?? []).find((item) => item.type === 'text')?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        message?: unknown;
        code?: unknown;
        details?: unknown;
      };
      if (typeof parsed.message === 'string') {
        return {
          message: parsed.message,
          ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
          ...(parsed.details !== undefined ? { details: parsed.details } : {}),
        };
      }
    } catch {
      return { message: text };
    }
  }
  return { message: '工具调用失败' };
}

export class McpClient {
  constructor(private readonly config: ResolvedConfig) {}

  get resolved(): ResolvedConfig {
    return this.config;
  }

  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    options: { name?: string } = {},
  ): Promise<Record<string, unknown>> {
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
    const result = (await this.rpc('tools/call', { name, arguments: args }, { name })) as ToolResult;
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

  async readResource(uri: string): Promise<string> {
    const result = await this.rpc('resources/read', { uri }, { name: uri });
    const contents = result.contents;
    if (!Array.isArray(contents)) return '';
    const first = contents[0] as { text?: unknown } | undefined;
    return typeof first?.text === 'string' ? first.text : '';
  }
}
