import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { callTool } from '../../lib/mcp-client';
import {
  fileDownloadUrl,
  fileIconLabel,
  filePreviewKind,
  fileSafeUrl,
  formatFileSize,
  previewImageMime,
  type RoomFileItem,
} from '../../lib/files-ui';

interface RoomFileGetResult {
  file: RoomFileItem;
}

interface MessageFileCardProps {
  roomId: string;
  fileId: string;
  token: string;
  /** Markdown alt 或 URL 前一行；元数据到达前先显示，避免空白卡片。 */
  fallbackName: string;
  onOpenPreview: (item: RoomFileItem) => void;
}

type MetaState =
  | { status: 'loading' }
  | { status: 'ready'; item: RoomFileItem }
  | { status: 'error'; message: string };

interface CacheEntry {
  ok: boolean;
  at: number;
  item?: RoomFileItem;
  error?: Error;
}

/**
 * 消息文件卡片。
 *
 * 每个唯一 fileId 只在卡片接近视口时调用一次 `network_room_file_get`，
 * 换取真实文件名、大小与带票据的 `preview_url` / `download_url`。元数据与
 * 票据进入跨消息共享的 LRU（约 55 分钟，票据有效期 60 分钟），同一
 * fileId 的并发请求合并，队列并发上限 4，避免历史消息 N+1 与连接打满。
 *
 * 图片缩略图只用同源 `/f/` 的带票据地址；加载失败时重签一次，仍失败则
 * 移除缩略图并保留可重试的普通卡片。工具失败时回退 HEAD `/f/<id>`，
 * 公开文件仍可显示；私有文件 HEAD 404 时显示降级卡片，不加载裸地址。
 */
export const MessageFileCard = memo(function MessageFileCard({
  roomId,
  fileId,
  token,
  fallbackName,
  onOpenPreview,
}: MessageFileCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const thumbRetriedRef = useRef(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const [thumbRetrying, setThumbRetrying] = useState(false);
  const [state, setState] = useState<MetaState>(() => fromCache(roomId, fileId));

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    thumbRetriedRef.current = false;
    setThumbBroken(false);
    setThumbRetrying(false);
    setState(fromCache(roomId, fileId));
  }, [roomId, fileId]);

  const load = useCallback(
    async (force = false): Promise<void> => {
      if (!force) {
        const cached = readCache(roomId, fileId);
        if (cached) {
          if (mountedRef.current) setState(cachedFromEntry(cached));
          return;
        }
        if (mountedRef.current) {
          setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
        }
      }
      try {
        const item = await requestMeta(roomId, fileId, token, force);
        if (mountedRef.current) setState({ status: 'ready', item });
      } catch (error) {
        if (!mountedRef.current) return;
        const message =
          error instanceof Error && error.message ? error.message : '文件信息读取失败';
        setState({ status: 'error', message });
      }
    },
    [fileId, roomId, token],
  );

  useEffect(() => {
    const node = cardRef.current;
    const cached = readCache(roomId, fileId);
    if (cached) return;
    if (!node || typeof IntersectionObserver !== 'function') {
      void load();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void load();
      },
      {
        root: document.getElementById('messages'),
        rootMargin: '160px 0px',
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [fileId, load, roomId]);

  const item = state.status === 'ready' ? state.item : null;
  const kind = item ? filePreviewKind(item) : 'other';
  const imageMime = item ? previewImageMime(item.mime_type, item.name) : null;
  const previewUrl = item ? fileSafeUrl(item.preview_url || item.download_url || item.public_url) : null;
  const imageUrl = imageMime ? previewUrl : null;
  const download = item ? fileDownloadUrl(item) : null;
  const name = cleanFileName(item?.name) || fallbackName || `附件 ${fileId.slice(0, 10)}`;
  const sizeText = item ? formatFileSize(item.size) : state.status === 'error' ? '' : '正在读取…';
  const showThumb = Boolean(imageUrl) && !thumbBroken && !thumbRetrying;

  const resign = async (): Promise<void> => {
    setThumbRetrying(true);
    try {
      await load(true);
    } finally {
      if (mountedRef.current) setThumbRetrying(false);
    }
  };

  const retryImage = () => {
    if (!thumbRetriedRef.current) {
      thumbRetriedRef.current = true;
      void resign();
      return;
    }
    setThumbBroken(true);
  };

  return (
    <div
      className={`msg-file${showThumb ? ' has-image' : ''}${state.status === 'error' ? ' unavailable' : ''}`}
      data-file-id={fileId}
      data-loading={state.status === 'loading' ? '1' : undefined}
      ref={cardRef}
    >
      {showThumb ? (
        <button
          type="button"
          className="msg-file-thumb"
          title={name}
          aria-label={`预览图片 ${name}`}
          onClick={() => {
            if (item) onOpenPreview(item);
          }}
        >
          <img
            src={imageUrl ?? undefined}
            alt={name}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={retryImage}
          />
        </button>
      ) : null}
      <span className="msg-file-kind" aria-hidden="true">
        {item ? fileIconLabel(kind) : 'FILE'}
      </span>
      <span className="msg-file-main">
        <span className="msg-file-name" title={name}>
          {name}
        </span>
        <span className="msg-file-size">{sizeText}</span>
        {state.status === 'error' ? (
          <span className="msg-file-note">文件信息读取失败</span>
        ) : null}
      </span>
      <span className="msg-file-actions">
        {item && kind !== 'other' && previewUrl ? (
          <button
            type="button"
            className="msg-file-action msg-file-preview"
            onClick={() => onOpenPreview(item)}
          >
            预览
          </button>
        ) : null}
        {download ? (
          <a
            className="msg-file-action msg-file-download"
            href={download}
            download={name}
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            下载
          </a>
        ) : null}
        {state.status === 'error' || thumbBroken ? (
          <button
            type="button"
            className="msg-file-action msg-file-retry"
            onClick={() => {
              thumbRetriedRef.current = false;
              setThumbBroken(false);
              void resign();
            }}
          >
            重试
          </button>
        ) : null}
      </span>
    </div>
  );
});

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<RoomFileItem>>();
const queue: (() => void)[] = [];
let active = 0;

function cacheKey(roomId: string, fileId: string): string {
  return `${roomId}:${fileId}`;
}

function readCache(roomId: string, fileId: string): CacheEntry | null {
  const key = cacheKey(roomId, fileId);
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = entry.ok ? LIMITS.webMessageFileCacheTtlMs : LIMITS.webMessageFileFailureTtlMs;
  if (Date.now() - entry.at >= ttl) {
    cache.delete(key);
    return null;
  }
  // Map 插入顺序即 LRU：命中后移到末尾。
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeCache(roomId: string, fileId: string, entry: CacheEntry): void {
  const key = cacheKey(roomId, fileId);
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > LIMITS.webMessageFileCacheMax) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function fromCache(roomId: string, fileId: string): MetaState {
  const entry = readCache(roomId, fileId);
  return entry ? cachedFromEntry(entry) : { status: 'loading' };
}

function cachedFromEntry(entry: CacheEntry): MetaState {
  if (entry.ok && entry.item) return { status: 'ready', item: entry.item };
  return {
    status: 'error',
    message: entry.error?.message || '文件信息读取失败',
  };
}

function pumpQueue(): void {
  while (active < LIMITS.webMessageFileConcurrency && queue.length > 0) {
    const task = queue.shift();
    if (!task) return;
    active += 1;
    Promise.resolve()
      .then(task)
      .catch(() => undefined)
      .then(() => {
        active -= 1;
        pumpQueue();
      });
  }
}

function enqueue(run: () => void): void {
  queue.push(run);
  pumpQueue();
}

function requestMeta(
  roomId: string,
  fileId: string,
  token: string,
  force = false,
): Promise<RoomFileItem> {
  const key = cacheKey(roomId, fileId);
  if (!force) {
    const cached = readCache(roomId, fileId);
    if (cached) {
      return cached.ok && cached.item
        ? Promise.resolve(cached.item)
        : Promise.reject(cached.error ?? new Error('文件信息读取失败'));
    }
    const existing = inflight.get(key);
    if (existing) return existing;
  }
  let resolveTask: (item: RoomFileItem) => void = () => undefined;
  let rejectTask: (error: Error) => void = () => undefined;
  const promise = new Promise<RoomFileItem>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  // 卡片可能在请求完成前被房间切换移除；提前挂空处理器避免 unhandled rejection。
  promise.catch(() => undefined);
  inflight.set(key, promise);
  enqueue(() => {
    void fetchMeta(roomId, fileId, token).then(
      (item) => {
        writeCache(roomId, fileId, { ok: true, at: Date.now(), item });
        if (inflight.get(key) === promise) inflight.delete(key);
        resolveTask(item);
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error('文件信息读取失败');
        writeCache(roomId, fileId, { ok: false, at: Date.now(), error: failure });
        if (inflight.get(key) === promise) inflight.delete(key);
        rejectTask(failure);
      },
    );
  });
  return promise;
}

async function fetchMeta(roomId: string, fileId: string, token: string): Promise<RoomFileItem> {
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

/** 控制字符变空格并限制长度；不解析任何标记。 */
function cleanFileName(value: string | undefined): string {
  let text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .trim();
  text = text
    .replace(/^\*\*([\s\S]+)\*\*$/u, '$1')
    .replace(/^__([\s\S]+)__$/u, '$1')
    .replace(/^`([^`]+)`$/u, '$1');
  if (text.length > 160) text = text.slice(0, 160);
  return text.trim();
}
