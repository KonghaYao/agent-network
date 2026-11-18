import { Tooltip } from '../../app/lenso-tooltip';
import { Button, Surface } from '../../app/lenso-controls';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  fileDownloadUrl,
  fileIconLabel,
  filePreviewKind,
  fileSafeUrl,
  formatFileSize,
  previewImageMime,
  type RoomFileItem,
} from '../../lib/files-ui';
import {
  fileMetaIdentity,
  fileMetaLoader,
  type FileMetaEntry,
} from '../../lib/file-meta-cache';

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
  | { status: 'ready'; item: RoomFileItem; fetchedAt: number }
  | { status: 'error'; message: string };

/**
 * 消息文件卡片。
 *
 * 每个唯一 fileId 只在卡片接近视口时调用一次 `network_room_file_get`，
 * 换取真实文件名、大小与带票据的 `preview_url` / `download_url`。元数据与
 * 票据进入跨消息共享的 LRU（55 分钟，票据有效期 60 分钟），同一
 * fileId 的并发请求合并，队列并发上限 4。缓存 key 带当前凭据摘要，
 * 同一标签页切换身份后不会复用旧票据。
 *
 * 图片缩略图只用同源 `/f/` 的带票据地址；加载失败时重签一次，仍失败则
 * 移除缩略图并保留可重试的普通卡片。点击预览/下载前若票据已接近过期，
 * 先重新获取；失败显示可重试提示。工具失败时回退 HEAD `/f/<id>`，
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
  const identity = useMemo(() => fileMetaIdentity(token), [token]);
  const [thumbBroken, setThumbBroken] = useState(false);
  const [thumbRetrying, setThumbRetrying] = useState(false);
  const [actionError, setActionError] = useState('');
  const [state, setState] = useState<MetaState>(() => fromCache(identity, roomId, fileId));

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
    setActionError('');
    setState(fromCache(identity, roomId, fileId));
  }, [fileId, identity, roomId]);

  const load = useCallback(
    async (force = false): Promise<void> => {
      if (!force) {
        const cached = fileMetaLoader.read(identity, roomId, fileId);
        if (cached) {
          if (mountedRef.current) setState(cachedFromEntry(cached));
          return;
        }
        if (mountedRef.current) {
          setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
        }
      }
      try {
        const entry = await fileMetaLoader.load(identity, roomId, fileId, token, { force });
        if (mountedRef.current) setState(cachedFromEntry(entry));
      } catch (error) {
        if (!mountedRef.current) return;
        setState({ status: 'error', message: errorMessage(error) });
      }
    },
    [fileId, identity, roomId, token],
  );

  useEffect(() => {
    const node = cardRef.current;
    const cached = fileMetaLoader.read(identity, roomId, fileId);
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
  }, [fileId, identity, load, roomId]);

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

  /** 点击时的实时判断：组件可能已挂载超过票据 TTL。 */
  const staleNow = (): boolean =>
    state.status !== 'ready' ||
    Date.now() - state.fetchedAt >= LIMITS.webMessageFileCacheTtlMs;

  const ensureActionItem = useCallback(async (): Promise<RoomFileItem | null> => {
    if (mountedRef.current) setActionError('');
    try {
      const entry = await fileMetaLoader.ensureFresh(identity, roomId, fileId, token);
      if (!entry.ok || !entry.item) throw entry.error ?? new Error('文件信息读取失败');
      if (mountedRef.current) setState(cachedFromEntry(entry));
      return entry.item;
    } catch (error) {
      if (mountedRef.current) {
        setActionError(`文件链接刷新失败：${errorMessage(error)}。请重试。`);
      }
      return null;
    }
  }, [fileId, identity, roomId, token]);

  const openPreview = async (): Promise<void> => {
    if (!item) return;
    if (!staleNow()) {
      onOpenPreview(item);
      return;
    }
    const fresh = await ensureActionItem();
    if (fresh) onOpenPreview(fresh);
  };

  const downloadFresh = async (): Promise<void> => {
    const fresh = await ensureActionItem();
    if (!fresh) return;
    const url = fileDownloadUrl(fresh);
    if (!url) return;
    triggerDownload(url, cleanFileName(fresh.name) || name);
  };

  const retry = () => {
    thumbRetriedRef.current = false;
    setThumbBroken(false);
    setActionError('');
    if (state.status === 'error' || thumbBroken) {
      void resign();
      return;
    }
    void ensureActionItem();
  };

  return (
    <Surface style={{ display: 'contents' }}>
    <div
      className={`msg-file${showThumb ? ' has-image' : ''}${state.status === 'error' ? ' unavailable' : ''}`}
      data-file-id={fileId}
      data-loading={state.status === 'loading' ? '1' : undefined}
      ref={cardRef}
    >
      {showThumb ? (
        <Tooltip as={Button}
          type="button"
          variant="borderless"
          size="sm"
          className="msg-file-thumb"
          style={{
            width: '100%',
            height: 'auto',
            padding: 0,
            border: 0,
            borderRadius: 6,
            overflow: 'hidden',
            background: 'var(--wx-search)',
          }}
          hint={name}
          aria-label={`预览图片 ${name}`}
          onClick={() => {
            void openPreview();
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
        </Tooltip>
      ) : null}
      <span className="msg-file-kind" aria-hidden="true">
        {item ? fileIconLabel(kind) : 'FILE'}
      </span>
      <span className="msg-file-main">
        <Tooltip as="span" className="msg-file-name" hint={name}>
          {name}
        </Tooltip>
        <span className="msg-file-size">{sizeText}</span>
        {state.status === 'error' ? (
          <span className="msg-file-note">文件信息读取失败</span>
        ) : null}
        {actionError ? (
          <span className="msg-file-note" role="alert">
            {actionError}
          </span>
        ) : null}
      </span>
      <span className="msg-file-actions">
        {item && kind !== 'other' && previewUrl ? (
          <Button
            type="button"
            variant="borderless"
            size="sm"
            className="msg-file-action msg-file-preview"
            style={{
              height: 'auto',
              padding: '3px 5px',
              background: 'transparent',
              color: 'var(--wx-link)',
              fontSize: 12,
              lineHeight: 1.4,
            }}
            onClick={() => {
              void openPreview();
            }}
          >
            预览
          </Button>
        ) : null}
        {download ? (
          <a
            className="msg-file-action msg-file-download"
            href={download}
            download={name}
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            onClick={(event) => {
              // 票据在点击时仍有效就保留原生下载；否则先重签再触发。
              if (!staleNow()) return;
              event.preventDefault();
              void downloadFresh();
            }}
          >
            下载
          </a>
        ) : null}
        {state.status === 'error' || thumbBroken || actionError ? (
          <Button
            type="button"
            variant="borderless"
            size="sm"
            className="msg-file-action msg-file-retry"
            style={{
              height: 'auto',
              padding: '3px 5px',
              background: 'transparent',
              color: 'var(--wx-danger)',
              fontSize: 12,
              lineHeight: 1.4,
            }}
            onClick={retry}
          >
            重试
          </Button>
        ) : null}
      </span>
    </div>
    </Surface>
  );
});

function fromCache(identity: string, roomId: string, fileId: string): MetaState {
  const entry = fileMetaLoader.read(identity, roomId, fileId);
  return entry ? cachedFromEntry(entry) : { status: 'loading' };
}

function cachedFromEntry(entry: FileMetaEntry): MetaState {
  if (entry.ok && entry.item) {
    return { status: 'ready', item: entry.item, fetchedAt: entry.at };
  }
  return {
    status: 'error',
    message: entry.error?.message || '文件信息读取失败',
  };
}

function triggerDownload(url: string, name: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener noreferrer';
  anchor.referrerPolicy = 'no-referrer';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '文件信息读取失败';
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
