/**
 * 消息文件卡片的元数据/票据缓存与网络队列。
 *
 * - 缓存 key 包含当前凭据的稳定摘要：切换身份后不复用旧票据；
 * - 同一 key 合并在途请求，LRU 上限与 TTL 由 `LIMITS` 统一维护；
 * - 队列并发上限 `webMessageFileConcurrency`，名额只在真实网络 Promise
 *   结束后释放；
 * - 打开预览/下载前通过 `ensureFresh` 在缓存满 55 分钟时重签票据。
 *
 * 该模块不接触 localStorage，也不输出 token/凭据摘要。
 */

import { LIMITS } from '../../contracts/limits';
import { fileSafeUrl, type RoomFileItem } from './files-ui';
import { callTool } from './mcp-client';

export interface FileMetaEntry {
  ok: boolean;
  at: number;
  item?: RoomFileItem;
  error?: Error;
}

export interface FileMetaLoadOptions {
  /** 跳过缓存与在途合并，强制重新获取票据。 */
  force?: boolean;
}

export interface FileMetaLoader {
  /** 命中并刷新 LRU 顺序；过期/不存在返回 null。 */
  read(identity: string, roomId: string, fileId: string): FileMetaEntry | null;
  /** 读取缓存或排队请求；失败时 reject。 */
  load(
    identity: string,
    roomId: string,
    fileId: string,
    token: string,
    options?: FileMetaLoadOptions,
  ): Promise<FileMetaEntry>;
  /** 打开预览/下载前的票据检查：缓存超过 55 分钟则重新获取。 */
  ensureFresh(
    identity: string,
    roomId: string,
    fileId: string,
    token: string,
  ): Promise<FileMetaEntry>;
  /** 当前占用与排队中的任务数，供验收脚本断言并发。 */
  pending(): number;
}

export type FileMetaFetcher = (
  roomId: string,
  fileId: string,
  token: string,
) => Promise<RoomFileItem>;

interface RoomFileGetResult {
  file: RoomFileItem;
}

/**
 * 凭据的稳定内存标识。
 *
 * token 只在哈希输入中出现，缓存 key/日志都不包含明文；两路 FNV-1a 组合
 * 足以避免普通标签页内的身份碰撞，不用于任何安全边界。
 */
export function fileMetaIdentity(token: string): string {
  if (!token) return 'anonymous';
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

export function createFileMetaLoader(
  fetchFileMeta: FileMetaFetcher,
  now: () => number = Date.now,
): FileMetaLoader {
  const cache = new Map<string, FileMetaEntry>();
  const inflight = new Map<string, Promise<FileMetaEntry>>();
  const queue: (() => Promise<void>)[] = [];
  let active = 0;

  function cacheKey(identity: string, roomId: string, fileId: string): string {
    return `${identity}:${roomId}:${fileId}`;
  }

  function read(identity: string, roomId: string, fileId: string): FileMetaEntry | null {
    const key = cacheKey(identity, roomId, fileId);
    const entry = cache.get(key);
    if (!entry) return null;
    const ttl = entry.ok ? LIMITS.webMessageFileCacheTtlMs : LIMITS.webMessageFileFailureTtlMs;
    if (now() - entry.at >= ttl) {
      cache.delete(key);
      return null;
    }
    // Map 插入顺序即 LRU：命中后移到末尾。
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function write(key: string, entry: FileMetaEntry): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > LIMITS.webMessageFileCacheMax) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function pump(): void {
    while (active < LIMITS.webMessageFileConcurrency && queue.length > 0) {
      const task = queue.shift();
      if (!task) return;
      active += 1;
      void Promise.resolve()
        .then(task)
        .catch(() => undefined)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  function enqueue(task: () => Promise<void>): void {
    queue.push(task);
    pump();
  }

  function request(
    identity: string,
    roomId: string,
    fileId: string,
    token: string,
    force: boolean,
  ): Promise<FileMetaEntry> {
    const key = cacheKey(identity, roomId, fileId);
    if (!force) {
      const cached = read(identity, roomId, fileId);
      if (cached) {
        return cached.ok && cached.item
          ? Promise.resolve(cached)
          : Promise.reject(cached.error ?? new Error('文件信息读取失败'));
      }
      const existing = inflight.get(key);
      if (existing) return existing;
    }

    let resolveTask: (entry: FileMetaEntry) => void = () => undefined;
    let rejectTask: (error: Error) => void = () => undefined;
    const promise = new Promise<FileMetaEntry>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    // 卡片可能在请求完成前被房间切换移除；提前挂空处理器避免 unhandled rejection。
    promise.catch(() => undefined);
    inflight.set(key, promise);

    enqueue(() =>
      fetchFileMeta(roomId, fileId, token).then(
        (item) => {
          const entry: FileMetaEntry = { ok: true, at: now(), item };
          // force 请求可能已被更新的一次重签取代；只有仍在 map 中的请求写缓存，
          // 避免较慢的旧响应覆盖新票据。
          if (inflight.get(key) === promise) {
            write(key, entry);
            inflight.delete(key);
          }
          resolveTask(entry);
        },
        (error: unknown) => {
          const failure = error instanceof Error ? error : new Error('文件信息读取失败');
          const entry: FileMetaEntry = { ok: false, at: now(), error: failure };
          if (inflight.get(key) === promise) {
            write(key, entry);
            inflight.delete(key);
          }
          rejectTask(failure);
        },
      ),
    );
    return promise;
  }

  async function ensureFresh(
    identity: string,
    roomId: string,
    fileId: string,
    token: string,
  ): Promise<FileMetaEntry> {
    const cached = read(identity, roomId, fileId);
    if (cached?.ok && cached.item) return cached;
    // 正在重签的请求直接复用；它必然刚刚发起，不会比缓存更旧。
    const existing = inflight.get(cacheKey(identity, roomId, fileId));
    if (existing) {
      try {
        return await existing;
      } catch {
        // 在途请求失败后按用户动作再试一次，避免把失败缓存当作结果。
      }
    }
    return request(identity, roomId, fileId, token, true);
  }

  return {
    read,
    load: (identity, roomId, fileId, token, options) =>
      request(identity, roomId, fileId, token, options?.force === true),
    ensureFresh,
    pending: () => active + queue.length,
  };
}

async function fetchRoomFileMeta(
  roomId: string,
  fileId: string,
  token: string,
): Promise<RoomFileItem> {
  try {
    const result = await callTool<RoomFileGetResult>(
      'network_room_file_get',
      { room_id: roomId, file_id: fileId },
      { token: token || undefined },
    );
    const file = result?.file;
    if (!file || file.file_id !== fileId) throw new Error('文件信息不完整');
    return file;
  } catch (error) {
    // 工具失败（FILE_UNAVAILABLE、边界外、网络等）时，公开文件仍可由
    // HEAD 读取；私有文件的裸地址会 404，随后显示可重试降级卡片。
    const head = await headMeta(fileId).catch(() => null);
    if (head) return head;
    throw error instanceof Error ? error : new Error('文件信息读取失败');
  }
}

async function headMeta(fileId: string): Promise<RoomFileItem> {
  const url = fileSafeUrl(`/f/${fileId}`);
  if (!url) throw new Error('文件地址无效');
  const response = await fetch(url, {
    method: 'HEAD',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const mime = rawMime(response.headers.get('content-type'));
  const length = Number(response.headers.get('content-length'));
  const name = dispositionName(response.headers.get('content-disposition')) || '';
  const downloadUrl = `${url}?download=1`;
  return {
    file_id: fileId,
    name,
    mime_type: mime,
    size: Number.isFinite(length) && length >= 0 ? length : 0,
    public_url: url,
    preview_url: url,
    download_url: downloadUrl,
  };
}

function rawMime(value: string | null): string {
  const essence = String(value ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(essence)
    ? essence
    : 'application/octet-stream';
}

/** RFC 5987 filename* 优先，普通 filename 兜底。 */
function dispositionName(header: string | null): string {
  const value = String(header ?? '');
  if (!value) return '';
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/iu.exec(value);
  if (star) {
    let encoded = star[2]!.trim();
    if (encoded.startsWith('"') && encoded.endsWith('"')) encoded = encoded.slice(1, -1);
    const charset = star[1]!.trim().toLowerCase();
    if (!charset || charset === 'utf-8') {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/iu.exec(value);
  if (!plain) return '';
  return plain[2] !== undefined ? plain[2] : plain[3]!.trim();
}

/** 跨消息共享的单例；身份隔离由调用方传入 `fileMetaIdentity(token)`。 */
export const fileMetaLoader = createFileMetaLoader(fetchRoomFileMeta);
