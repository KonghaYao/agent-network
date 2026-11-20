/**
 * 显式更新前的一次性文字快照与程序性重载熔断。
 *
 * 快照只存当前标签、当前 actor、当前房间的正文与光标；不写 token、配对码、
 * 文件票据或附件。key 同时包含 actor、room、tab，读取时必须三者一致。
 * 浏览器存储不可写时调用方必须留在原页并提示复制，不能假装恢复可用。
 */

import { LIMITS } from '../../contracts/limits';

const SNAPSHOT_PREFIX = 'agent-network-update-snapshot-v1:';
const TAB_KEY = 'agent-network-update-tab-v1';
const RELOAD_PREFIX = 'agent-network-update-reload-v1:';

export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UpdateDraftSource {
  readonly actorId: string;
  readonly roomId: string;
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export interface UpdateDraftSnapshot extends UpdateDraftSource {
  readonly v: 1;
  readonly tabId: string;
  readonly sourceBuildId: string;
  readonly targetBuildId: string;
  readonly createdAt: number;
}

export interface ReloadClaim {
  readonly targetBuildId: string;
  readonly count: number;
  readonly at: number;
}

export function defaultSnapshotStorage(): SnapshotStorage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

/** 当前标签的稳定 id；写入失败返回 null，调用方不得继续程序性重载。 */
export function getUpdateTabId(
  storage: SnapshotStorage | null = defaultSnapshotStorage(),
): string | null {
  if (!storage) return null;
  try {
    const existing = storage.getItem(TAB_KEY);
    if (existing) return existing;
  } catch {
    return null;
  }
  const next = crypto.randomUUID();
  try {
    storage.setItem(TAB_KEY, next);
    return next;
  } catch {
    return null;
  }
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export function updateSnapshotKey(
  actorId: string,
  roomId: string,
  tabId: string,
): string {
  return `${SNAPSHOT_PREFIX}${encode(actorId)}:${encode(roomId)}:${encode(tabId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCaret(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function writeUpdateSnapshot(input: {
  readonly storage: SnapshotStorage | null;
  readonly tabId: string | null;
  readonly source: UpdateDraftSource;
  readonly sourceBuildId: string;
  readonly targetBuildId: string;
  readonly now?: number;
}): boolean {
  const { storage, tabId, source } = input;
  if (!storage || !tabId) return false;
  const snapshot: UpdateDraftSnapshot = {
    v: 1,
    actorId: source.actorId,
    roomId: source.roomId,
    tabId,
    text: source.text,
    selectionStart: source.selectionStart,
    selectionEnd: source.selectionEnd,
    sourceBuildId: input.sourceBuildId,
    targetBuildId: input.targetBuildId,
    createdAt: input.now ?? Date.now(),
  };
  try {
    storage.setItem(
      updateSnapshotKey(source.actorId, source.roomId, tabId),
      JSON.stringify(snapshot),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 只返回当前 actor、room、tab 完全匹配且未过期的快照。损坏、过期或串号的
 * 快照会被删除；调用方必须先完成身份与房间访问核验，再调用本函数。
 */
export function readUpdateSnapshot(input: {
  readonly storage: SnapshotStorage | null;
  readonly tabId: string | null;
  readonly actorId: string;
  readonly roomId: string;
  readonly now?: number;
}): UpdateDraftSnapshot | null {
  const { storage, tabId, actorId, roomId } = input;
  if (!storage || !tabId) return null;
  const key = updateSnapshotKey(actorId, roomId, tabId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    storage.removeItem(key);
    return null;
  }
  const valid =
    isRecord(parsed) &&
    parsed.v === 1 &&
    parsed.actorId === actorId &&
    parsed.roomId === roomId &&
    parsed.tabId === tabId &&
    typeof parsed.text === 'string' &&
    isCaret(parsed.selectionStart) &&
    isCaret(parsed.selectionEnd) &&
    typeof parsed.sourceBuildId === 'string' &&
    typeof parsed.targetBuildId === 'string' &&
    typeof parsed.createdAt === 'number';
  const now = input.now ?? Date.now();
  if (!valid || now - (parsed as UpdateDraftSnapshot).createdAt > LIMITS.webUpdateSnapshotTtlMs) {
    storage.removeItem(key);
    return null;
  }
  return parsed as UpdateDraftSnapshot;
}

export function removeUpdateSnapshot(input: {
  readonly storage: SnapshotStorage | null;
  readonly tabId: string | null;
  readonly actorId: string;
  readonly roomId: string;
}): void {
  const { storage, tabId } = input;
  if (!storage || !tabId) return;
  try {
    storage.removeItem(updateSnapshotKey(input.actorId, input.roomId, tabId));
  } catch {
    // 一次性快照删除失败不影响已恢复的正文；过期后会再次被清理。
  }
}

function reloadKey(tabId: string): string {
  return `${RELOAD_PREFIX}${encode(tabId)}`;
}

export function readUpdateReloadClaim(
  storage: SnapshotStorage | null,
  tabId: string | null,
): ReloadClaim | null {
  if (!storage || !tabId) return null;
  try {
    const raw = storage.getItem(reloadKey(tabId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.targetBuildId !== 'string' ||
      typeof parsed.count !== 'number' ||
      typeof parsed.at !== 'number'
    ) {
      return null;
    }
    return {
      targetBuildId: parsed.targetBuildId,
      count: parsed.count,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}

/**
 * 同一标签、同一目标最多一次程序性重载。目标 build 改变时重新获得一次机会；
 * 写入失败返回 unavailable，调用方必须停在原页而不是继续 reload。
 */
export function claimUpdateReload(input: {
  readonly storage: SnapshotStorage | null;
  readonly tabId: string | null;
  readonly targetBuildId: string;
  readonly now?: number;
}): 'claimed' | 'already' | 'unavailable' {
  const { storage, tabId, targetBuildId } = input;
  if (!storage || !tabId) return 'unavailable';
  const existing = readUpdateReloadClaim(storage, tabId);
  if (existing?.targetBuildId === targetBuildId && existing.count >= 1) return 'already';
  const next: ReloadClaim = {
    targetBuildId,
    count: 1,
    at: input.now ?? Date.now(),
  };
  try {
    storage.setItem(reloadKey(tabId), JSON.stringify(next));
    return 'claimed';
  } catch {
    return 'unavailable';
  }
}
