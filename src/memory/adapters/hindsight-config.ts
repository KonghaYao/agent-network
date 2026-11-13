/**
 * Hindsight 适配器配置：服务端注入、fail closed、错误文本不含凭据。
 */
import { LIMITS } from '../../contracts/limits';

/** 服务端注入的 Hindsight 配置。apiKey 只用于请求头，绝不能序列化或记录。 */
export interface HindsightAdapterConfig {
  /** Hindsight API 根地址，例如 https://hindsight.example/。 */
  baseUrl: string;
  /** 解析后的 bearer 凭据；服务端负责从 secret manager/env 读取。 */
  apiKey: string;
  /** bank 路由前缀；默认 agentnet。最终 bank 是前缀 + 派生哈希。 */
  bankPrefix?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  listPageSize?: number;
  /** 测试注入点；生产使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 测试注入点；生产使用定时器等待。 */
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ResolvedHindsightConfig {
  baseUrl: string;
  apiKey: string;
  bankPrefix: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  listPageSize: number;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  now: () => number;
}

export type HindsightConfigLoadResult =
  | { ok: true; config: HindsightAdapterConfig }
  | { ok: false; error: string };

function parsePositiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value.trim() === '') return { ok: true, value: fallback };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    return { ok: false, error: `${name} must be an integer >= ${min}` };
  }
  return { ok: true, value: parsed };
}

export function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Hindsight base URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Hindsight base URL must use http or https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Hindsight base URL must not contain credentials, query or fragment');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
}

export function validBankPrefix(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/u.test(value);
}

/**
 * 从服务端 env 解析配置。错误文本只包含变量名，不包含凭据。
 * 调用方在 MEMORY_ADAPTER=hindsight 时使用；缺失时传 null 构造 fail-closed 适配器。
 */
export function loadHindsightConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): HindsightConfigLoadResult {
  const baseUrl = env.HINDSIGHT_URL?.trim() || env.HINDSIGHT_BASE_URL?.trim() || '';
  const apiKey = env.HINDSIGHT_API_KEY ?? '';
  if (!baseUrl) return { ok: false, error: 'HINDSIGHT_URL is required' };
  if (!apiKey) return { ok: false, error: 'HINDSIGHT_API_KEY is required' };
  if (/[\r\n]/u.test(apiKey)) {
    return { ok: false, error: 'HINDSIGHT_API_KEY contains invalid characters' };
  }
  let normalizedBaseUrl: string;
  try {
    // 配置加载即归一化，调用方直接使用也不会拼出 `//v1/...`。
    normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  } catch {
    return { ok: false, error: 'HINDSIGHT_URL is invalid' };
  }
  const bankPrefix = (env.HINDSIGHT_BANK_PREFIX ?? 'agentnet').trim() || 'agentnet';
  if (!validBankPrefix(bankPrefix)) {
    return { ok: false, error: 'HINDSIGHT_BANK_PREFIX is invalid' };
  }
  const timeout = parsePositiveInt(
    env.HINDSIGHT_TIMEOUT_MS,
    'HINDSIGHT_TIMEOUT_MS',
    LIMITS.memoryAdapterTimeoutMs,
    1,
  );
  if (!timeout.ok) return { ok: false, error: timeout.error };
  const retries = parsePositiveInt(
    env.HINDSIGHT_MAX_RETRIES,
    'HINDSIGHT_MAX_RETRIES',
    LIMITS.memoryAdapterMaxRetries,
    0,
  );
  if (!retries.ok) return { ok: false, error: retries.error };
  const retryBase = parsePositiveInt(
    env.HINDSIGHT_RETRY_BASE_MS,
    'HINDSIGHT_RETRY_BASE_MS',
    LIMITS.memoryAdapterRetryBaseMs,
    1,
  );
  if (!retryBase.ok) return { ok: false, error: retryBase.error };
  const pageSize = parsePositiveInt(
    env.HINDSIGHT_LIST_PAGE_SIZE,
    'HINDSIGHT_LIST_PAGE_SIZE',
    LIMITS.memoryAdapterListPageSize,
    1,
  );
  if (!pageSize.ok) return { ok: false, error: pageSize.error };
  return {
    ok: true,
    config: {
      baseUrl: normalizedBaseUrl,
      apiKey,
      bankPrefix,
      requestTimeoutMs: timeout.value,
      maxRetries: retries.value,
      retryBaseMs: retryBase.value,
      listPageSize: pageSize.value,
    },
  };
}

/**
 * 校验并冻结配置。null 表示配置缺失（返回 null，由适配器 fail closed）；
 * 非法字段抛错，错误文本不包含凭据。
 */
export function resolveHindsightConfig(
  config: HindsightAdapterConfig | null,
): ResolvedHindsightConfig | null {
  if (!config) return null;
  if (!config.apiKey) throw new Error('Hindsight credential is required');
  if (/[\r\n]/u.test(config.apiKey)) {
    throw new Error('Hindsight credential contains invalid characters');
  }
  const bankPrefix = (config.bankPrefix ?? 'agentnet').trim() || 'agentnet';
  if (!validBankPrefix(bankPrefix)) throw new Error('Hindsight bank prefix is invalid');
  const requestTimeoutMs = config.requestTimeoutMs ?? LIMITS.memoryAdapterTimeoutMs;
  const maxRetries = config.maxRetries ?? LIMITS.memoryAdapterMaxRetries;
  const retryBaseMs = config.retryBaseMs ?? LIMITS.memoryAdapterRetryBaseMs;
  const listPageSize = config.listPageSize ?? LIMITS.memoryAdapterListPageSize;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error('Hindsight requestTimeoutMs must be a positive integer');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('Hindsight maxRetries must be a non-negative integer');
  }
  if (!Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1) {
    throw new Error('Hindsight retryBaseMs must be a positive integer');
  }
  if (!Number.isSafeInteger(listPageSize) || listPageSize < 1) {
    throw new Error('Hindsight listPageSize must be a positive integer');
  }
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKey: config.apiKey,
    bankPrefix,
    requestTimeoutMs,
    maxRetries,
    retryBaseMs,
    listPageSize: Math.min(listPageSize, 100),
    fetchImpl: config.fetchImpl ?? fetch,
    sleepImpl: config.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: config.now ?? Date.now,
  };
}
