import {
  callTool,
  mcpError,
  readBrowserToken,
  writeBrowserToken,
  type McpError,
} from './mcp-client';

/**
 * 浏览器身份引导。
 *
 * 与 legacy 内联脚本保持同一 localStorage 契约：token 在
 * `agent-network-token`，退出状态在 `agent-network-logged-out`。
 * SPA Home 只读取身份和会话列表，不提供切换/退出 UI。
 */

export interface WebIdentity {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  agent_session_id: string | null;
  pending_count: number;
  inbox_head_seq: string;
  created_at: string;
}

export interface WebSession {
  identity: WebIdentity;
  token: string;
}

const LOGGED_OUT_KEY = 'agent-network-logged-out';
const DEVICE_ID_KEY = 'agent-network-device-id-v1';

let cached: WebSession | null = null;
let pending: Promise<WebSession> | null = null;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function isLoggedOut(): boolean {
  return storageGet(LOGGED_OUT_KEY) !== null;
}

function ensureDeviceId(): string {
  const existing = storageGet(DEVICE_ID_KEY);
  if (existing) return existing;
  const value = crypto.randomUUID();
  storageSet(DEVICE_ID_KEY, value);
  return value;
}

function newRequestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function credentialInvalid(message: string): McpError {
  const error = mcpError(message, 'CREDENTIAL_INVALID');
  error.credentialInvalid = true;
  return error;
}

function newToken(): string {
  return crypto.randomUUID();
}

async function register(token: string): Promise<WebIdentity> {
  return callTool<WebIdentity>(
    'network_register',
    {
      request_id: newRequestId('web_reg'),
      kind: 'human',
      name: `网页访客 ${token.replaceAll('-', '').slice(0, 4)}`,
      device_id: ensureDeviceId(),
    },
    { token },
  );
}

async function bootstrap(): Promise<WebSession> {
  if (isLoggedOut()) {
    throw mcpError('已退出登录。请先在首页创建新身份，或打开 Agent 分享链接。', 'LOGGED_OUT');
  }

  const stored = readBrowserToken();
  if (stored) {
    try {
      const identity = await callTool<WebIdentity>('network_me', {}, { token: stored });
      return { identity, token: stored };
    } catch (error) {
      const failure = error as McpError;
      if (failure.code !== 'CREDENTIAL_INVALID') throw error;
      throw credentialInvalid(
        '当前凭据已失效或已被撤销；本机不会自动创建替代身份。请用另一台已登录设备生成配对码后打开 /pair。',
      );
    }
  }

  const token = newToken();
  if (!writeBrowserToken(token)) {
    throw mcpError('浏览器无法保存身份，请允许本地存储后刷新页面', 'STORAGE_UNAVAILABLE');
  }
  try {
    const identity = await register(token);
    return { identity, token };
  } catch (error) {
    const failure = error as McpError;
    if (failure.code !== 'CREDENTIAL_INVALID') throw error;
  }

  // 新生成的 token 被并发注册抢占时，legacy 也换一个 token 重试一次。
  const retryToken = newToken();
  if (!writeBrowserToken(retryToken)) {
    throw mcpError('浏览器无法保存身份，请允许本地存储后刷新页面', 'STORAGE_UNAVAILABLE');
  }
  const identity = await register(retryToken);
  return { identity, token: retryToken };
}

/** single-flight：首屏列表与实时订阅同时启动时只注册一次。 */
export function ensureWebSession(): Promise<WebSession> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  pending = bootstrap()
    .then((session) => {
      cached = session;
      return session;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** 身份/token 变化后清空缓存；SPA Home 目前不主动切换身份。 */
export function resetWebSession(): void {
  cached = null;
  pending = null;
}
