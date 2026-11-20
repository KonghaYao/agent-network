/**
 * 版本公告的纯逻辑：解析、兼容判断、检查时机与超时请求。
 *
 * 判断只比较页面 `buildId` 与目标 `buildId`，不使用 deploymentId 或摘要
 * 大小排序。`webContract` 用目标公告的兼容区间判断当前页面是否还能继续
 * 写入；同一 build 的不同部署流水号视为同一版本。
 */

import { LIMITS } from '../../contracts/limits';

export interface PageRelease {
  readonly buildId: string;
  readonly webContract: number;
}

export interface WebVersionInfo {
  readonly deploymentId: string;
  readonly buildId: string;
  readonly minWebContract: number;
  readonly maxWebContract: number;
}

export type VersionRelation = 'same' | 'update' | 'incompatible';

export type VersionCheckTrigger = 'startup' | 'foreground' | 'interval' | 'forced';

export type VersionCheckDecision = 'run' | 'paused' | 'in-flight' | 'throttled';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isContract(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 读取 HTML 内嵌的 `#web-release`；开发/兼容模式没有该标签时返回 null。 */
export function readPageRelease(
  doc: Document | null = typeof document === 'undefined' ? null : document,
): PageRelease | null {
  if (!doc) return null;
  const element = doc.getElementById('web-release');
  if (!element || element.textContent === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(element.textContent) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.buildId !== 'string' || value.buildId.length === 0) return null;
  if (!isContract(value.webContract)) return null;
  return { buildId: value.buildId, webContract: value.webContract };
}

/** 只接受公开的四字段；额外字段忽略，缺失或类型错误返回 null。 */
export function parseWebVersion(value: unknown): WebVersionInfo | null {
  if (!isRecord(value)) return null;
  if (typeof value.deploymentId !== 'string' || !value.deploymentId.startsWith('r')) {
    return null;
  }
  if (typeof value.buildId !== 'string' || value.buildId.length === 0) return null;
  if (!isContract(value.minWebContract) || !isContract(value.maxWebContract)) return null;
  if (value.minWebContract > value.maxWebContract) return null;
  return {
    deploymentId: value.deploymentId,
    buildId: value.buildId,
    minWebContract: value.minWebContract,
    maxWebContract: value.maxWebContract,
  };
}

export function versionRelation(
  page: PageRelease,
  target: WebVersionInfo,
): VersionRelation {
  if (page.buildId === target.buildId) return 'same';
  if (page.webContract < target.minWebContract) return 'incompatible';
  if (page.webContract > target.maxWebContract) return 'incompatible';
  return 'update';
}

/**
 * 是否发起一次检查。
 *
 * - 后台（`visible:false`）一律暂停；
 * - 已有请求在途时合并为一次；
 * - `forced`（chunk/资源错误或诊断探针）绕过 60 秒节流；
 * - 其余触发（启动、回前台、15 分钟周期）共享同一节流窗口。
 */
export function decideVersionCheck(input: {
  readonly trigger: VersionCheckTrigger;
  readonly visible: boolean;
  readonly inFlight: boolean;
  readonly now: number;
  readonly lastCheckAt: number | null;
}): VersionCheckDecision {
  if (!input.visible) return 'paused';
  if (input.inFlight) return 'in-flight';
  if (input.trigger === 'forced') return 'run';
  if (input.lastCheckAt === null) return 'run';
  if (input.now - input.lastCheckAt < LIMITS.webVersionCheckThrottleMs) {
    return 'throttled';
  }
  return 'run';
}

export interface VersionFetchResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type VersionFetch = (
  url: string,
  init: { cache: 'no-store'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<VersionFetchResponse>;

/**
 * 读取 `/web-version.json`。超时、非 200、JSON 损坏或字段不合法都返回 null；
 * 调用方只把它当作“没有可确认的新版本”，不阻断聊天或刷新页面。
 */
export async function fetchWebVersion(options: {
  readonly fetchImpl?: VersionFetch;
  readonly timeoutMs?: number;
  readonly url?: string;
} = {}): Promise<WebVersionInfo | null> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as VersionFetch);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? LIMITS.webVersionRequestTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(options.url ?? '/web-version.json', {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return parseWebVersion(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
