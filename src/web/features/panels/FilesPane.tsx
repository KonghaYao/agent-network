import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';

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
  textPreviewLimit,
} from '../../lib/files-ui';
import {
  bindFileToRoom,
  copyText,
  uploadFileToDrive,
} from '../../lib/files';
import { callTool } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';

interface FilesPaneProps {
  roomId: string;
  token: string;
  readOnly: boolean;
  open: boolean;
  onClose: () => void;
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
export function FilesPane({ roomId, token, readOnly, open, onClose, files }: FilesPaneProps) {
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [failedBind, setFailedBind] = useState<FailedBind | null>(null);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [busyDelete, setBusyDelete] = useState<string | null>(null);
  const [preview, setPreview] = useState<RoomFileItem | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRunning = useRef(false);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [roomId]);

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

  return (
    <>
      <aside className="files-pane" id="files-pane" aria-label="房间文件" hidden={!open}>
        <header className="files-head">
          <h2>文件</h2>
          <div className="files-head-actions">
            <button
              className="primary files-upload"
              id="files-upload"
              type="button"
              disabled={readOnly || upload !== null}
              onClick={() => inputRef.current?.click()}
            >
              上传
            </button>
            <button
              className="files-close"
              id="files-close"
              type="button"
              aria-label="关闭文件栏"
              title="关闭文件栏"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </header>
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
            <progress id="files-progress-bar" max={100} value={upload.percent} />
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
          <button
            id="files-bind-retry"
            className="files-bind-retry"
            type="button"
            onClick={() => void retryBind()}
          >
            重试加入房间
          </button>
        ) : null}
        {files.error ? (
          <div id="files-error" className="files-error" role="alert">
            <p id="files-error-text">读取文件失败：{files.error}</p>
            <button id="files-retry" type="button" onClick={() => void files.refresh()}>
              重试
            </button>
          </div>
        ) : null}
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
                  <li className="file-item" data-file-id={item.file_id} key={key}>
                    <div className="file-row">
                      <span className="file-thumb">
                        {thumbnail && previewImageMime(item.mime_type, item.name) ? (
                          <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          fileIconLabel(kind)
                        )}
                      </span>
                      <div className="file-main">
                        <span className="file-name" title={item.name || '未命名文件'}>
                          {item.name || '未命名文件'}
                        </span>
                        <span className="file-meta">{fileMetaText(item)}</span>
                      </div>
                    </div>
                    <div className="file-actions">
                      <button className="file-action" type="button" onClick={() => setPreview(item)}>
                        预览
                      </button>
                      {fileCopyUrl(item) ? (
                        <button className="file-action" type="button" onClick={() => void copyLink(item)}>
                          复制链接
                        </button>
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
                        <button
                          className={`file-action${deletePending === key ? ' danger' : ''}`}
                          type="button"
                          disabled={busyDelete !== null}
                          onClick={() => void requestDelete(item)}
                        >
                          {busyDelete === key ? '删除中…' : deletePending === key ? '确认删除' : '删除'}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
        </ul>
        {files.items.length === 0 && !files.loading && !files.error ? (
          <p id="files-empty" className="files-empty">
            这个房间还没有文件
          </p>
        ) : null}
        {files.loadMoreError ? (
          <p className="files-status error" role="alert">
            加载更多失败：{files.loadMoreError}
          </p>
        ) : null}
        {files.hasMore ? (
          <button
            id="files-more"
            className="files-more"
            type="button"
            disabled={files.loadingMore}
            onClick={() => void files.loadMore()}
          >
            {files.loadingMore ? '加载中…' : '加载更多'}
          </button>
        ) : null}
      </aside>
      <FilePreviewDialog item={preview} onClose={() => setPreview(null)} />
    </>
  );
}

function FilePreviewDialog({ item, onClose }: { item: RoomFileItem | null; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState('');
  const [imageError, setImageError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const kind = item ? filePreviewKind(item) : 'other';
  const previewUrl = item ? fileSafeUrl(item.preview_url || item.download_url || item.public_url) : null;
  const download = item ? fileDownloadUrl(item) : null;

  useEffect(() => {
    setText(null);
    setTextError('');
    setImageError(false);
    abortRef.current?.abort();
    abortRef.current = null;
    if (!item || kind !== 'text' || !previewUrl) return;
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        const response = await fetch(previewUrl, {
          headers: { Range: 'bytes=0-262143' },
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (controller.signal.aborted) return;
        setText(body.length > 0 ? body.slice(0, textPreviewLimit()) : '（空文件）');
      } catch (failure) {
        if (controller.signal.aborted) return;
        setTextError(`读取文本预览失败：${(failure as Error).message || String(failure)}`);
      }
    })();
    return () => controller.abort();
  }, [item, kind, previewUrl]);

  return (
    <DialogPrimitive.Root open={item !== null} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-file-preview-overlay" />
        <DialogPrimitive.Content
          className="spa-file-preview"
          aria-describedby={undefined}
          id="file-preview"
        >
          <div className="file-preview-card">
            <header className="file-preview-head">
              <div className="file-preview-id">
                <DialogPrimitive.Title asChild>
                  <h2 id="file-preview-title">{item?.name || '文件预览'}</h2>
                </DialogPrimitive.Title>
                <p id="file-preview-meta" className="file-preview-meta">
                  {item ? fileMetaText(item) : ''}
                </p>
              </div>
              <button id="file-preview-close" type="button" aria-label="关闭预览" onClick={onClose}>
                关闭
              </button>
            </header>
            <div id="file-preview-body" className="file-preview-body">
              {!item ? null : kind === 'image' ? (
                previewUrl && !imageError ? (
                  <img
                    src={previewUrl}
                    alt={item.name || '图片预览'}
                    referrerPolicy="no-referrer"
                    onError={() => setImageError(true)}
                  />
                ) : (
                  <p className="file-preview-note">
                    {imageError ? '图片加载失败，请下载后查看。' : '预览链接无效，请下载后查看。'}
                  </p>
                )
              ) : kind === 'pdf' ? (
                previewUrl ? (
                  <iframe
                    sandbox=""
                    referrerPolicy="no-referrer"
                    title={item.name || 'PDF 预览'}
                    src={previewUrl}
                  />
                ) : (
                  <p className="file-preview-note">预览链接无效，请下载后查看。</p>
                )
              ) : kind === 'text' ? (
                <pre>{textError || text || '正在读取文本…'}</pre>
              ) : kind === 'audio' || kind === 'video' ? (
                previewUrl ? (
                  kind === 'video' ? (
                    <video controls preload="metadata" playsInline src={previewUrl} />
                  ) : (
                    <audio controls preload="metadata" src={previewUrl} />
                  )
                ) : (
                  <p className="file-preview-note">预览链接无效，请下载后查看。</p>
                )
              ) : (
                <p className="file-preview-note">该文件类型不支持在线预览，请下载后查看。</p>
              )}
            </div>
            <footer className="file-preview-foot">
              {download ? (
                <a
                  id="file-preview-download"
                  href={download}
                  download={item?.name || '文件'}
                  rel="noopener"
                  referrerPolicy="no-referrer"
                >
                  下载文件
                </a>
              ) : null}
            </footer>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
