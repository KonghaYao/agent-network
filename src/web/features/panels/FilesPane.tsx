import { Tooltip } from '../../app/lenso-tooltip';
import {
  Button,
  EmptyState,
  Pagination,
  ProgressBar,
  Separator,
  Surface,
  Toolbar,
} from '../../app/lenso-controls';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';

import type { RoomFileItem } from '../../lib/files-ui';
import {
  fileCopyUrl,
  fileDownloadUrl,
  fileIconLabel,
  fileKey,
  fileMetaText,
  filePreviewKind,
  fileSafeUrl,
  previewImageMime,
} from '../../lib/files-ui';
import {
  bindFileToRoom,
  copyText,
  uploadFileToDrive,
} from '../../lib/files';
import { callTool } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';

const FilePreviewPane = lazy(() => import('./FilePreviewPane').then((module) => ({ default: module.FilePreviewPane })));

/** 读取 tokens.css 的像素变量；非浏览器环境返回 undefined，交给 React 省略属性。 */
function readCssPixels(name: string): number | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) ? value : undefined;
}

const SIDEBAR_FALLBACK_WIDTH = 300;
/** 收起聊天区后，文件栏左缘给主区留出的最小空隙。 */
const WIDE_EDGE_GAP = 24;
const WIDE_MIN_EXTRA = 200;

interface PaneLimits {
  /** 普通上限：保留聊天区最小可读宽度，并受 tokens 的 440–1000 约束。 */
  normal: number;
  /** 扩展上限：聊天区收起后右栏可占的宽度。 */
  extended: number;
}

/**
 * 右栏两组宽度上限。超过 `normal` 即进入扩展模式并收起聊天区；
 * `extended` 始终比普通上限至少多 200px，且不挤占侧栏。
 */
function readPaneLimits(): PaneLimits {
  const floor = readCssPixels('--app-pane-max') ?? 440;
  const ceiling = readCssPixels('--app-pane-max-ceiling') ?? 1000;
  const chatMin = readCssPixels('--app-chat-readable-min') ?? 280;
  if (typeof window === 'undefined') return { normal: floor, extended: floor + WIDE_MIN_EXTRA };
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  const measured = sidebar ? sidebar.getBoundingClientRect().width : 0;
  const sidebarWidth =
    measured > 0 ? measured : (readCssPixels('--app-sidebar-width') ?? SIDEBAR_FALLBACK_WIDTH);
  const normal = Math.min(ceiling, Math.max(floor, window.innerWidth - sidebarWidth - chatMin));
  const extended = Math.max(normal + WIDE_MIN_EXTRA, window.innerWidth - sidebarWidth - WIDE_EDGE_GAP);
  return { normal, extended };
}

interface FilesPaneProps {
  roomId: string;
  token: string;
  readOnly: boolean;
  open: boolean;
  onClose: () => void;
  preview: RoomFileItem | null;
  onOpenPreview: (item: RoomFileItem) => void;
  onBack: () => void;
  files: {
    items: RoomFileItem[];
    loading: boolean;
    error: string | null;
    hasMore: boolean;
    loadingMore: boolean;
    loadMoreError: string | null;
    refresh: () => Promise<void>;
    loadMore: () => Promise<void>;
  };
}

interface UploadState {
  name: string;
  percent: number;
  phase: 'upload' | 'join';
  index: number;
  total: number;
}

interface FailedBind {
  fileId: string;
  name: string;
}

/**
 * 房间文件右栏。
 *
 * DOM 与 legacy 保持一致（`files-pane`、`files-list`、预览弹窗等），
 * 上传仍走 XHR + `network_room_file_bind`，删除需要二次确认；所有文件名、
 * 链接与预览内容都用 React 文本/属性写入，不注入 HTML。
 */
export function FilesPane({ roomId, token, readOnly, open, onClose, preview, onOpenPreview, onBack, files }: FilesPaneProps) {
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [failedBind, setFailedBind] = useState<FailedBind | null>(null);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState<string | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRunning = useRef(false);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [paneSize, setPaneSize] = useState<{ width: number; wide: boolean } | null>(null);
  const [limits, setLimits] = useState<PaneLimits | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const resizePane = (width: number) => {
    const minimum = readCssPixels('--app-pane-min') ?? 280;
    const currentLimits = limits ?? readPaneLimits();
    const wide = width > currentLimits.normal;
    const maximum = wide ? currentLimits.extended : currentLimits.normal;
    setPaneSize({ width: Math.max(minimum, Math.min(maximum, width)), wide });
  };

  // 窗口变化时重算两组上限，并按当前模式把右栏夹回新上限。
  useEffect(() => {
    const syncLimits = () => {
      const next = readPaneLimits();
      const minimum = readCssPixels('--app-pane-min') ?? 280;
      setLimits(next);
      setPaneSize((current) => {
        if (current === null) return current;
        const maximum = current.wide ? next.extended : next.normal;
        return { ...current, width: Math.max(minimum, Math.min(maximum, current.width)) };
      });
    };
    syncLimits();
    window.addEventListener('resize', syncLimits);
    return () => window.removeEventListener('resize', syncLimits);
  }, []);

  // 全屏是页面内覆盖，不是浏览器 Fullscreen API；退出时只移除覆盖，宽度与聊天状态不变。
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onResize = () => {
      if (window.innerWidth < 1200) setFullscreen(false);
    };
    document.body.classList.add('file-preview-fullscreen-open');
    window.addEventListener('resize', onResize);
    return () => {
      document.body.classList.remove('file-preview-fullscreen-open');
      window.removeEventListener('resize', onResize);
    };
  }, [fullscreen]);

  // 关闭预览或切换会话时结束全屏，避免下一次预览继承覆盖状态。
  useEffect(() => {
    if (!preview) setFullscreen(false);
  }, [preview]);

  useEffect(() => {
    setFullscreen(false);
  }, [roomId]);

  const showStatus = useCallback((text: string, options: { error?: boolean; transient?: boolean } = {}) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus(text);
    setStatusError(Boolean(options.error));
    if (text && options.transient) {
      statusTimer.current = setTimeout(() => {
        setStatus('');
        setStatusError(false);
      }, 2400);
    }
  }, []);

  useEffect(
    () => () => {
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  useEffect(() => {
    setDeletePending(null);
    setFailedBind(null);
    setStatus('');
    setSelectedFileId(null);
  }, [roomId]);

  useEffect(() => {
    if (preview) setSelectedFileId(preview.file_id);
  }, [preview]);

  const uploadFiles = useCallback(
    async (list: File[]) => {
      const filesToSend = list.filter((file) => file.name.length > 0);
      if (filesToSend.length === 0) return;
      if (readOnly) {
        showStatus('群已解散，当前为只读归档，不能上传文件。', { error: true });
        return;
      }
      if (uploadRunning.current) return;
      uploadRunning.current = true;
      try {
        for (let index = 0; index < filesToSend.length; index += 1) {
          const file = filesToSend[index]!;
          setUpload({
            name: file.name,
            percent: 0,
            phase: 'upload',
            index: index + 1,
            total: filesToSend.length,
          });
          showStatus(`正在上传（${index + 1}/${filesToSend.length}）：${file.name}`);
          let uploadedId: string | null = null;
          try {
            const uploaded = await uploadFileToDrive(file, token, (percent) => {
              setUpload((current) =>
                current ? { ...current, percent, phase: 'upload' } : current,
              );
            });
            uploadedId = uploaded.file_id;
            setUpload((current) =>
              current ? { ...current, percent: 100, phase: 'join' } : current,
            );
            await bindFileToRoom(roomId, uploaded.file_id, token);
          } catch (failure) {
            const message = (failure as Error).message || '上传失败';
            showStatus(`上传「${file.name}」失败：${message}`, { error: true });
            if (uploadedId) setFailedBind({ fileId: uploadedId, name: file.name });
            await files.refresh();
            continue;
          }
          await files.refresh();
        }
        showStatus(`已上传 ${filesToSend.length} 个文件。`, { transient: true });
      } finally {
        uploadRunning.current = false;
        setUpload(null);
      }
    },
    [files, readOnly, roomId, showStatus, token],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragOver(false);
      const list = Array.from(event.dataTransfer?.files ?? []);
      void uploadFiles(list);
    },
    [uploadFiles],
  );

  const retryBind = useCallback(async () => {
    if (!failedBind?.fileId) {
      showStatus('请重新选择文件上传；上次响应没有返回可重试的文件 id。', { error: true });
      return;
    }
    try {
      setUpload({ name: failedBind.name, percent: 100, phase: 'join', index: 1, total: 1 });
      await bindFileToRoom(roomId, failedBind.fileId, token);
      setFailedBind(null);
      await files.refresh();
      showStatus(`「${failedBind.name}」已加入房间。`, { transient: true });
    } catch (failure) {
      showStatus(
        `重试加入房间失败：${(failure as Error).message || String(failure)}`,
        { error: true },
      );
    } finally {
      setUpload(null);
    }
  }, [failedBind, files, roomId, showStatus, token]);

  const requestDelete = useCallback(
    async (item: RoomFileItem) => {
      if (readOnly || busyDelete) return;
      const key = fileKey(item);
      if (deletePending !== key) {
        if (deleteTimer.current) clearTimeout(deleteTimer.current);
        setDeletePending(key);
        showStatus(`再次点击“确认删除”以移除「${item.name || '文件'}」。`);
        deleteTimer.current = setTimeout(() => setDeletePending(null), 4000);
        return;
      }
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
      setDeletePending(null);
      setBusyDelete(key);
      try {
        await callTool(
          'network_room_file_delete',
          {
            request_id: newRequestId('file_del'),
            room_id: item.room_id || roomId,
            file_id: item.file_id,
          },
          { token },
        );
        await files.refresh();
        showStatus(`已删除「${item.name || '文件'}」。`, { transient: true });
      } catch (failure) {
        showStatus(`删除失败：${(failure as Error).message || String(failure)}`, {
          error: true,
        });
      } finally {
        setBusyDelete(null);
      }
    },
    [busyDelete, deletePending, files, readOnly, roomId, showStatus, token],
  );

  const copyLink = useCallback(
    async (item: RoomFileItem) => {
      const url = fileCopyUrl(item);
      if (!url) {
        showStatus('无法复制：文件链接不是本站 /f/ 地址。', { error: true });
        return;
      }
      try {
        await copyText(url);
        showStatus('链接已复制。链接即下载权限，请勿转发给不信任的人。', {
          transient: true,
        });
      } catch (failure) {
        showStatus(`复制失败：${(failure as Error).message || String(failure)}`, {
          error: true,
        });
      }
    },
    [showStatus],
  );

  const currentMax = paneSize?.wide ? limits?.extended : limits?.normal;
  const closePreview = () => {
    setFullscreen(false);
    onBack();
  };

  return (
    <>
      <aside ref={paneRef} className={`files-pane${fullscreen ? ' files-pane-fullscreen' : ''}`} id="files-pane" aria-label="房间文件" hidden={!open}
        data-pane-wide={paneSize?.wide ? 'true' : undefined}
        style={
          paneSize === null && limits === null
            ? undefined
            : ({
                ...(paneSize === null ? {} : { '--app-pane-width': `${paneSize.width}px` }),
                ...(limits === null || currentMax === undefined
                  ? {}
                  : { '--app-pane-max': `${currentMax}px` }),
              } as CSSProperties)
        }>
        <div id="files-resizer" className="files-resizer" role="separator" tabIndex={0}
          aria-label="调整文件栏宽度" aria-orientation="vertical" aria-controls="files-pane"
          aria-valuemin={readCssPixels('--app-pane-min')}
          aria-valuemax={currentMax ?? readCssPixels('--app-pane-max')}
          aria-valuenow={paneSize?.width ?? readCssPixels('--app-pane-width')}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizeStart.current = { x: event.clientX, width: paneRef.current!.getBoundingClientRect().width };
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (start) resizePane(start.width + start.x - event.clientX);
          }}
          onPointerUp={(event) => {
            resizeStart.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => { resizeStart.current = null; }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            resizePane(paneRef.current!.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 10 : -10));
          }}
        />
        <header className="files-head">
          <Toolbar
            aria-label="文件操作"
            xstyle={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              borderRadius: 0,
            }}
          >
          <h2>文件</h2>
          <div className="files-head-actions">
            <Separator
              orientation="vertical"
              style={{ alignSelf: 'center', margin: '0 2px' }}
            />
            <Button
              className="primary files-upload"
              id="files-upload"
              type="button"
              variant="prominent"
              size="sm"
              disabled={readOnly || upload !== null}
              onClick={() => inputRef.current?.click()}
            >
              上传
            </Button>
            <Tooltip as={Button}
              className="files-close"
              id="files-close"
              type="button"
              variant="borderless"
              size="sm"
              style={{ color: 'var(--wx-text)', backgroundColor: 'transparent' }}
              aria-label="关闭文件栏"
              hint="关闭文件栏"
              onClick={onClose}
            >
              关闭
            </Tooltip>
          </div>
        </Toolbar>
        </header>
        {preview ? (
          <Suspense fallback={<p role="status">正在读取预览…</p>}>
            <FilePreviewPane
              item={preview}
              onBack={closePreview}
              fullscreen={fullscreen}
              onToggleFullscreen={() => setFullscreen((value) => !value)}
            />
          </Suspense>
        ) : null}
        <div className="files-list-view" hidden={preview !== null}>
        <input
          id="files-input"
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const list = Array.from(event.target.files ?? []);
            event.target.value = '';
            void uploadFiles(list);
          }}
        />
        <div
          id="files-drop"
          className={`files-drop${dragOver ? ' dragover' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="拖拽文件到这里，或点击选择文件"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            inputRef.current?.click();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <span className="files-drop-icon" aria-hidden="true">
            +
          </span>
          <span>拖拽文件到这里，或点击“上传”</span>
        </div>
        {upload ? (
          <div id="files-progress" className="files-progress">
            <p id="files-progress-text" className="files-progress-text">
              {upload.phase === 'join'
                ? `正在加入房间（${upload.index}/${upload.total}）：${upload.name}`
                : `正在上传（${upload.index}/${upload.total}）：${upload.name}`}
            </p>
            <ProgressBar
              id="files-progress-bar"
              className="files-progress-bar"
              max={100}
              value={upload.percent}
              aria-valuenow={upload.percent}
              aria-label={`文件上传进度 ${upload.percent}%`}
            />
          </div>
        ) : null}
        <p
          id="files-status"
          className={`files-status${statusError ? ' error' : ''}`}
          role="status"
          hidden={!status}
        >
          {status}
        </p>
        {failedBind ? (
          <Button
            id="files-bind-retry"
            className="files-bind-retry"
            type="button"
            variant="bordered"
            size="sm"
            onClick={() => void retryBind()}
          >
            重试加入房间
          </Button>
        ) : null}
        {files.error ? (
          <div id="files-error" className="files-error" role="alert">
            <p id="files-error-text">读取文件失败：{files.error}</p>
            <Button id="files-retry" type="button" variant="bordered" size="sm" onClick={() => void files.refresh()}>
              重试
            </Button>
          </div>
        ) : null}
        <Surface style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ul id="files-list" className="files-list" aria-label="文件列表">
          {files.loading && files.items.length === 0
            ? Array.from({ length: 3 }, (_, index) => (
                <li className="file-skeleton" aria-hidden="true" key={index}>
                  <span className="skeleton-avatar" />
                  <span className="file-skeleton-lines">
                    <span />
                    <span />
                  </span>
                </li>
              ))
            : files.items.map((item) => {
                const key = fileKey(item);
                const kind = filePreviewKind(item);
                const thumbnail = kind === 'image' ? fileSafeUrl(item.preview_url || item.download_url || item.public_url) : null;
                const download = fileDownloadUrl(item);
                return (
                  <li className="file-item" data-file-id={item.file_id}
                    data-selected={(preview?.file_id ?? selectedFileId) === item.file_id} key={key}>
                    <div className="file-row"
                      role={kind === 'html' || kind === 'markdown' ? 'button' : undefined}
                      tabIndex={kind === 'html' || kind === 'markdown' ? 0 : undefined}
                      aria-label={kind === 'html' || kind === 'markdown' ? `预览 ${item.name || '文件'}` : undefined}
                      onClick={() => {
                        if (kind !== 'html' && kind !== 'markdown') return;
                        setSelectedFileId(item.file_id);
                        onOpenPreview(item);
                      }}
                      onKeyDown={(event) => {
                        if ((kind !== 'html' && kind !== 'markdown') || !['Enter', ' '].includes(event.key)) return;
                        event.preventDefault();
                        setSelectedFileId(item.file_id);
                        onOpenPreview(item);
                      }}>
                      <span className="file-thumb">
                        {thumbnail && previewImageMime(item.mime_type, item.name) ? (
                          <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          fileIconLabel(kind)
                        )}
                      </span>
                      <div className="file-main">
                        <Tooltip as="span" className="file-name" hint={item.name || '未命名文件'}>
                          {item.name || '未命名文件'}
                        </Tooltip>
                        <span className="file-meta">{fileMetaText(item)}</span>
                      </div>
                    </div>
                    <div className="file-actions">
                      <Button className="file-action" type="button" variant="borderless" size="sm" onClick={() => { setSelectedFileId(item.file_id); onOpenPreview(item); }}>
                        预览
                      </Button>
                      {fileCopyUrl(item) ? (
                        <Button className="file-action" type="button" variant="borderless" size="sm" onClick={() => void copyLink(item)}>
                          复制链接
                        </Button>
                      ) : null}
                      {download ? (
                        <a
                          className="file-action"
                          href={download}
                          download={item.name || '文件'}
                          rel="noopener"
                          referrerPolicy="no-referrer"
                        >
                          下载
                        </a>
                      ) : null}
                      {item.can_delete === true && !readOnly ? (
                        <Button
                          className={`file-action${deletePending === key ? ' danger' : ''}`}
                          type="button"
                          variant="borderless"
                          size="sm"
                          disabled={busyDelete !== null}
                          onClick={() => void requestDelete(item)}
                        >
                          {busyDelete === key ? '删除中…' : deletePending === key ? '确认删除' : '删除'}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
        </ul>
        {files.items.length === 0 && !files.loading && !files.error ? (
          <EmptyState
            id="files-empty"
            style={{
              margin: 'auto 16px',
              padding: '28px 0',
              textAlign: 'center',
              color: 'var(--wx-muted)',
              fontSize: 12,
              width: 'auto',
            }}
          >
            这个房间还没有文件
          </EmptyState>
        ) : null}
        {files.loadMoreError ? (
          <p className="files-status error" role="alert">
            加载更多失败：{files.loadMoreError}
          </p>
        ) : null}
        {files.hasMore ? (
          <Pagination
            aria-label="文件分页"
            style={{ flex: '0 0 auto', width: '100%', paddingBottom: 12 }}
          >
            <Button
              id="files-more"
              className="files-more"
              type="button"
              variant="borderless"
              size="sm"
              disabled={files.loadingMore}
              onClick={() => void files.loadMore()}
            >
              {files.loadingMore ? '加载中…' : '加载更多'}
            </Button>
          </Pagination>
        ) : null}
        </Surface>
        </div>
      </aside>
    </>
  );
}
