import { LIMITS } from '../../contracts/limits';

/**
 * 浏览器端最小 MCP 客户端：固定 `2026-07-28`，只调用工具。
 *
 * 与 legacy 内联客户端保持同一请求头与错误解析，方便灰度期间对照；
 * token 只出现在 Authorization，不进入日志、URL 或错误消息。
 */

const PROTOCOL_VERSION = '2026-07-28';
const TOKEN_KEY = 'agent-network-token';

export interface McpError extends Error {
  code?: string;
  /** 业务错误 details；配对页用 `reason` 区分过期、未批准等下一步。 */
  details?: Record<string, unknown>;
  credentialInvalid?: boolean;
}

export interface CallToolOptions {
  /** 显式 token；省略时读取当前浏览器身份。 */
  token?: string;
  signal?: AbortSignal;
}

export function readBrowserToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeBrowserToken(token: string): boolean {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function removeBrowserToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 存储不可用时没有可清理的 token。
  }
}

export function mcpError(
  message: string,
  code?: string,
  details?: Record<string, unknown>,
): McpError {
  const error = new Error(message) as McpError;
  if (code) error.code = code;
  if (details) error.details = details;
  return error;
}

function asDetails(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requestId(): string {
  return crypto.randomUUID();
}

function requestParts(
  method: string,
  params: Record<string, unknown>,
  toolName: string | undefined,
  token: string,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept:
      method === 'subscriptions/listen'
        ? 'text/event-stream'
        : 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-method': method,
    authorization: `Bearer ${token}`,
  };
  if (toolName) headers['mcp-name'] = toolName;
  return {
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId(),
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-web',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  };
}

interface RpcFailure {
  message?: unknown;
  data?: { code?: unknown; details?: unknown };
}

interface RpcResponse {
  error?: RpcFailure;
  result?: unknown;
}

interface ToolContent {
  type?: unknown;
  text?: unknown;
}

interface ToolResult {
  isError?: unknown;
  content?: unknown;
  structuredContent?: unknown;
}

function parseToolError(result: ToolResult): McpError {
  const content = Array.isArray(result.content) ? (result.content as ToolContent[]) : [];
  const item = content.find((entry) => entry.type === 'text');
  let detail: { message?: unknown; code?: unknown; details?: unknown } | null = null;
  if (item && typeof item.text === 'string') {
    try {
      detail = JSON.parse(item.text) as {
        message?: unknown;
        code?: unknown;
        details?: unknown;
      };
    } catch {
      detail = { message: item.text };
    }
  }
  const message =
    detail && typeof detail.message === 'string' ? detail.message : '请求失败';
  const code = detail && typeof detail.code === 'string' ? detail.code : undefined;
  return mcpError(message, code, asDetails(detail?.details));
}

/** 普通 JSON RPC；超时、调用方取消和格式错误都映射为可识别错误。 */
export async function callTool<T>(
  name: string,
  args: Record<string, unknown> = {},
  options: CallToolOptions = {},
): Promise<T> {
  const token = options.token ?? readBrowserToken();
  if (!token) {
    throw mcpError('浏览器身份尚未初始化，请刷新页面后重试', 'CREDENTIAL_INVALID');
  }

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LIMITS.webRequestTimeoutMs);

  try {
    const request = requestParts('tools/call', { name, arguments: args }, name, token);
    const response = await fetch('/mcp', {
      method: 'POST',
      headers: request.headers,
      signal: controller.signal,
      body: request.body,
    });
    let payload: RpcResponse;
    try {
      payload = (await response.json()) as RpcResponse;
    } catch {
      if (timedOut) throw mcpError('请求超时，请重试', 'TIMEOUT');
      if (options.signal?.aborted) throw mcpError('请求已取消', 'ABORTED');
      throw mcpError('服务响应格式错误，请重试', 'INVALID_RESPONSE');
    }
    if (!payload || typeof payload !== 'object') {
      throw mcpError('服务响应格式错误，请重试', 'INVALID_RESPONSE');
    }
    if (payload.error) {
      const message =
        typeof payload.error.message === 'string' ? payload.error.message : '请求失败';
      const code =
        typeof payload.error.data?.code === 'string' ? payload.error.data.code : undefined;
      throw mcpError(message, code, asDetails(payload.error.data?.details));
    }
    const result = payload.result as ToolResult | undefined;
    if (!result || typeof result !== 'object') {
      throw mcpError('服务响应格式错误，请重试', 'INVALID_RESPONSE');
    }
    if (result.isError === true) throw parseToolError(result);
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
      return result.structuredContent as T;
    }
    const content = Array.isArray(result.content) ? (result.content as ToolContent[]) : [];
    const item = content.find((entry) => entry.type === 'text');
    if (!item || typeof item.text !== 'string') {
      throw mcpError('服务响应格式错误，请重试', 'INVALID_RESPONSE');
    }
    return JSON.parse(item.text) as T;
  } catch (error) {
    if (timedOut) throw mcpError('请求超时，请重试', 'TIMEOUT');
    if (options.signal?.aborted) throw mcpError('请求已取消', 'ABORTED');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
