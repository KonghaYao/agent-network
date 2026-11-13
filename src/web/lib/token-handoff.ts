/**
 * 分享/加入/配对页共用的浏览器凭据与一次性挑战工具。
 *
 * 历史 `#t=` 链接已被协议验收明确废弃：打开带 `#t=` 的链接不会写入或切换
 * token，这里也不再提供对应入口。配对挑战只在 URL fragment 中出现，读取
 * 后立即从地址栏清除，不写日志、不进入 DOM 文本。
 */

export const TOKEN_KEY = 'agent-network-token';
export const LOGGED_OUT_KEY = 'agent-network-logged-out';
export const DEVICE_ID_KEY = 'agent-network-device-id-v1';
export const IDENTITY_PREFIX = 'agent-network-identity-v1:';
export const PAIR_TOKEN_PREFIX = 'agent-network-pair-token:';

export interface RememberedIdentity {
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
}

/** 首次访问时生成本地 token；已存在时保持原值。 */
export function browserToken(): string {
  try {
    const stored = window.localStorage.getItem(TOKEN_KEY);
    if (stored) return stored;
  } catch {
    // 存储不可用时仍返回一次性 token；调用方会得到明确错误。
  }
  const value = crypto.randomUUID();
  try {
    window.localStorage.setItem(TOKEN_KEY, value);
    window.localStorage.removeItem(LOGGED_OUT_KEY);
  } catch {
    // 忽略；后续 MCP 调用会返回 CREDENTIAL_INVALID。
  }
  return value;
}

export function currentToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function newRequestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 忽略。
  }
}

export function sessionGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function sessionSet(key: string, value: string): boolean {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function sessionRemove(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // 忽略。
  }
}

/** 把当前身份写进本机身份列表，供退出后显式切换。 */
export function rememberIdentity(identity: RememberedIdentity, token: string): boolean {
  if (!identity.actor_id || !token) return false;
  return storageSet(
    IDENTITY_PREFIX + identity.actor_id,
    JSON.stringify({
      v: 1,
      actor_id: identity.actor_id,
      name: identity.name || '未命名',
      kind: identity.kind === 'agent' ? 'agent' : 'human',
      token,
      last_used_at: Date.now(),
    }),
  );
}

/** 本机稳定设备 id；localStorage 不可用时退回 sessionStorage。 */
export function deviceId(): string {
  const stored = storageGet(DEVICE_ID_KEY);
  if (stored && /^[A-Za-z0-9._:-]{1,256}$/u.test(stored)) return stored;
  let value: string = crypto.randomUUID();
  if (!storageSet(DEVICE_ID_KEY, value)) {
    value = sessionGet('agent-network-pair-device-id') ?? value;
    if (!sessionGet('agent-network-pair-device-id')) {
      sessionSet('agent-network-pair-device-id', value);
    }
  }
  return value;
}

export function deviceLabel(): string {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/iu.test(ua)) return 'iPhone/iPad';
  if (/Android/iu.test(ua)) return 'Android 设备';
  if (/Macintosh/iu.test(ua)) return 'Mac';
  if (/Windows/iu.test(ua)) return 'Windows 设备';
  return '浏览器设备';
}

/** 12 位短码使用的字符集：去掉易混淆的 I/L/O/U。 */
export function normalizeChallenge(value: string): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/gu, '')
    .replace(/I/gu, '1')
    .replace(/L/gu, '1')
    .replace(/O/gu, '0')
    .replace(/U/gu, 'V');
}

/** 配对挑战只从 `#c=` 读取；读取后立即清除 fragment。 */
export function takePairingChallenge(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash || '';
  if (!hash.startsWith('#c=')) return '';
  let value = '';
  try {
    value = decodeURIComponent(hash.slice(3));
  } catch {
    value = '';
  }
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    // 地址栏清理失败时仍保留内存中的挑战。
  }
  return value;
}

export function pairSessionToken(challenge: string): string {
  const key = PAIR_TOKEN_PREFIX + challenge;
  const stored = sessionGet(key);
  if (stored) return stored;
  const value = crypto.randomUUID();
  sessionSet(key, value);
  return value;
}
