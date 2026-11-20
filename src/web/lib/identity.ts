import { isMobileDevice } from '../pwa/install';
import { bumpIdentityEpoch } from './identity-epoch';
import {
  callTool,
  mcpError,
  readBrowserToken,
  removeBrowserToken,
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
let freshPending: Promise<WebSession> | null = null;

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

function storageRemove(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** 只在用户显式点击“创建新身份并继续”后调用。 */
function clearLoggedOutState(): void {
  storageRemove(LOGGED_OUT_KEY);
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

export const PAIRING_REQUIRED = 'PAIRING_REQUIRED';

/**
 * 移动端无本地凭据时不自动注册访客：先展示安装/配对引导。这里只改变
 * 浏览器入口策略，服务端认证、角色与凭据语义不变。
 */
export function pairingRequiredError(): McpError {
  const error = mcpError(
    '在手机上使用 WeBots：请先安装并从主屏幕打开，扫描电脑上的二维码；也可以连接已有账号。',
    PAIRING_REQUIRED,
  );
  return error;
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
    throw mcpError(
      '已退出登录。请点击“创建新身份并继续”，或打开 Agent 分享链接。',
      'LOGGED_OUT',
    );
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

  // 手机普通窗口/独立窗口没有本地凭据：不生成正式 browser token、不注册，
  // 让安装引导与配对入口先出现。桌面原有自动访客保持不变。
  if (isMobileDevice()) throw pairingRequiredError();

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

/**
 * 显式创建新身份：只由退出后的恢复入口调用。
 *
 * 与 `bootstrap()` 不同，这里允许在 `agent-network-logged-out` 存在时注册；
 * 成功后清除退出标记。注册失败会撤掉本次写入的 token 并保留退出标记，
 * 避免刷新后自动注册，也避免留下半初始化身份。
 */
export function createFreshIdentity(): Promise<WebSession> {
  if (cached) return Promise.resolve(cached);
  if (freshPending) return freshPending;

  freshPending = (async () => {
    const token = newToken();
    if (!writeBrowserToken(token)) {
      throw mcpError('浏览器无法保存身份，请允许本地存储后刷新页面', 'STORAGE_UNAVAILABLE');
    }
    let identity: WebIdentity;
    try {
      identity = await register(token);
    } catch (error) {
      removeBrowserToken();
      throw error;
    }
    clearLoggedOutState();
    cached = { identity, token };
    // 新身份与旧身份之间没有可比对的会话，直接推进代次丢弃旧在途响应。
    bumpIdentityEpoch();
    return cached;
  })().finally(() => {
    freshPending = null;
  });
  return freshPending;
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

/**
 * 前台恢复的显式重新鉴权：绕过 `useWebSession` 的 Infinity 缓存，直接向
 * 服务端核对当前 localStorage token 对应的身份。失败不改用缓存结果，
 * 由调用方按错误类型遮蔽或标记离线。
 */
export async function revalidateWebSession(): Promise<WebSession> {
  const stored = readBrowserToken();
  if (!stored) {
    if (isLoggedOut()) {
      throw mcpError('已退出登录，请重新配对或创建新身份。', 'LOGGED_OUT');
    }
    throw credentialInvalid('当前浏览器没有有效凭据，请重新配对。');
  }
  try {
    const identity = await callTool<WebIdentity>('network_me', {}, { token: stored });
    const previous = cached;
    cached = { identity, token: stored };
    // token/actor 变化意味着旧身份的在途响应不能再写入新身份的缓存。
    if (
      previous &&
      (previous.token !== stored || previous.identity.actor_id !== identity.actor_id)
    ) {
      bumpIdentityEpoch();
    }
    return cached;
  } catch (error) {
    const failure = error as McpError;
    if (failure.code === 'CREDENTIAL_INVALID') {
      cached = null;
      throw credentialInvalid(
        failure.message ||
          '当前凭据已失效或已被撤销；本机不会自动创建替代身份。请重新配对。',
      );
    }
    throw error;
  }
}

export function cachedWebSession(): WebSession | null {
  return cached;
}

/** 身份/token 变化后清空缓存；SPA Home 目前不主动切换身份。 */
export function resetWebSession(): void {
  cached = null;
  pending = null;
  freshPending = null;
  // 退出/撤权后旧身份的晚到响应必须全部作废。
  bumpIdentityEpoch();
}
