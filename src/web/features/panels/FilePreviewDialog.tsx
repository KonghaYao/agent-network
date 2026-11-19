import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../app/lenso-controls';
import {
  fileDownloadUrl,
  fileMetaText,
  filePreviewKind,
  fileSafeUrl,
  previewRange,
  textPreviewLimit,
  type RoomFileItem,
} from '../../lib/files-ui';
import { MarkdownIsland } from '../chat/MarkdownIsland';

const EMPTY_FILE_PREVIEW = '（空文件）';
// sandbox 禁用主动能力，CSP 另行阻止 HTML/CSS 的被动网络请求，保留内联样式。
const HTML_PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;

/**
 * 文件预览弹窗。
 *
 * 文件栏与消息文件卡片共用同一实现：图片/PDF/音视频按 `preview_url` 内联，
 * Markdown、HTML 与文本只读取前 256 KB；所有地址仍由 `fileSafeUrl` 限定为同源
 * `/f/`，HTML 仅在无权限 sandbox 中渲染，不内联 SVG。
 */
export function FilePreviewDialog({
  item,
  onClose,
}: {
  item: RoomFileItem | null;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState('');
  const [imageError, setImageError] = useState(false);
  const [showMarkdownSource, setShowMarkdownSource] = useState(false);
  const [showHtmlSource, setShowHtmlSource] = useState(false);
  const [textTruncated, setTextTruncated] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const kind = item ? filePreviewKind(item) : 'other';
  const previewUrl = item ? fileSafeUrl(item.preview_url || item.download_url || item.public_url) : null;
  const download = item ? fileDownloadUrl(item) : null;

  useEffect(() => {
    setText(null);
    setTextError('');
    setImageError(false);
    setShowMarkdownSource(false);
    setShowHtmlSource(false);
    setTextTruncated(false);
    abortRef.current?.abort();
    abortRef.current = null;
    if (!item || !['text', 'markdown', 'html'].includes(kind) || !previewUrl) return;
    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        const response = await fetch(previewUrl, {
          headers: { Range: previewRange() },
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        if (controller.signal.aborted) return;
        const bodyBytes = new TextEncoder().encode(body);
        const total = Number(response.headers.get('content-range')?.split('/')[1]);
        setTextTruncated(
          Number(item.size) > textPreviewLimit() ||
          total > textPreviewLimit() ||
          bodyBytes.byteLength > textPreviewLimit(),
        );
        const previewText = kind === 'html'
          ? new TextDecoder().decode(bodyBytes.subarray(0, textPreviewLimit()))
          : body.slice(0, textPreviewLimit());
        setText(body.length > 0 ? previewText : EMPTY_FILE_PREVIEW);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setTextError(`读取文本预览失败：${(failure as Error).message || String(failure)}`);
      }
    })();
    return () => controller.abort();
  }, [item, kind, previewUrl]);

  // 与 legacy 一致：超过 256 KB 只展示纯文本，不再把整份文档交给解析器。
  const markdownOversize =
    kind === 'markdown' &&
    item !== null &&
    (Number(item.size) > textPreviewLimit() || (text?.length ?? 0) >= textPreviewLimit());

  const markdownToggleVisible =
    kind === 'markdown' &&
    !markdownOversize &&
    !textError &&
    text !== null &&
    text !== EMPTY_FILE_PREVIEW;

  return (
    <DialogPrimitive.Root open={item !== null} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="spa-file-preview-overlay" />
        <DialogPrimitive.Content
          className="spa-file-preview"
          aria-describedby={undefined}
          id="file-preview"
          onOpenAutoFocus={() => {
            openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (!openerRef.current?.isConnected) return;
            event.preventDefault();
            openerRef.current.focus();
          }}
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
              <Button id="file-preview-close" type="button" aria-label="关闭预览" onClick={onClose}>
                关闭
              </Button>
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
              ) : kind === 'html' ? (
                <>
                  {textTruncated ? (
                    <p className="file-preview-note">文件较大，预览已截断，仅显示前 256 KB。</p>
                  ) : null}
                  {text !== null && !textError ? (
                    <>
                      <div className="file-preview-md-toolbar">
                        <Button
                          type="button"
                          aria-pressed={showHtmlSource}
                          onClick={() => setShowHtmlSource((value) => !value)}
                        >
                          {showHtmlSource ? '渲染' : '查看原文'}
                        </Button>
                      </div>
                      {showHtmlSource ? (
                        <pre>{text}</pre>
                      ) : (
                        <iframe
                          sandbox=""
                          srcDoc={HTML_PREVIEW_CSP + text}
                          referrerPolicy="no-referrer"
                          title={item.name || 'HTML 预览'}
                        />
                      )}
                    </>
                  ) : (
                    <p className="file-preview-note">
                      {textError || (previewUrl ? '正在读取 HTML…' : '预览链接无效，请下载后查看。')}
                    </p>
                  )}
                </>
              ) : kind === 'markdown' ? (
                <div className="file-preview-markdown">
                  {markdownOversize ? (
                    <p className="file-preview-note file-preview-md-note">
                      文件较大，已显示纯文本前 256 KB。
                    </p>
                  ) : null}
                  {markdownToggleVisible ? (
                    <div className="file-preview-md-toolbar">
                      <Button
                        className="file-preview-md-toggle"
                        type="button"
                        onClick={() => setShowMarkdownSource((value) => !value)}
                      >
                        {showMarkdownSource ? '渲染视图' : '查看原文'}
                      </Button>
                    </div>
                  ) : null}
                  {!markdownToggleVisible || showMarkdownSource ? (
                    <pre className="file-preview-md-source">
                      {textError ||
                        text ||
                        (previewUrl ? '正在读取 Markdown…' : '预览链接无效，请下载后查看。')}
                    </pre>
                  ) : (
                    <div className="file-preview-md-viewer">
                      <MarkdownIsland text={text ?? ''} mentions={[]} preview={false} />
                    </div>
                  )}
                </div>
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
