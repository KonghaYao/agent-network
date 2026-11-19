import { useEffect, useState } from 'react';

import { Button } from '../../app/lenso-controls';
import { filePreviewKind, fileSafeUrl, previewRange, textPreviewLimit, type RoomFileItem } from '../../lib/files-ui';
import { MarkdownIsland } from '../chat/MarkdownIsland';

const EMPTY_FILE_PREVIEW = '（空文件）';
// sandbox 禁用主动能力，CSP 另行阻止 HTML/CSS 的被动网络请求，保留内联样式。
const HTML_PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;

/** 弹窗与右栏共用读取、截断与隔离策略；不内联 SVG。 */
export function FilePreviewBody({ item }: { item: RoomFileItem }) {
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState('');
  const [imageError, setImageError] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [textTruncated, setTextTruncated] = useState(false);
  const kind = filePreviewKind(item);
  const previewUrl = fileSafeUrl(item.preview_url || item.download_url || item.public_url);

  useEffect(() => {
    setText(null);
    setTextError('');
    setImageError(false);
    setShowSource(false);
    setTextTruncated(false);
    if (!['text', 'markdown', 'html'].includes(kind) || !previewUrl) return;
    const controller = new AbortController();
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

  // 超过 256 KB 的 Markdown 沿用纯文本兜底，不交给解析器。
  const markdownOversize = kind === 'markdown' &&
    (textTruncated || (text?.length ?? 0) >= textPreviewLimit());
  const markdownToggleVisible = kind === 'markdown' && !markdownOversize &&
    !textError && text !== null && text !== EMPTY_FILE_PREVIEW;

  return (
    <div id="file-preview-body" className="file-preview-body">
      {kind === 'image' ? (
        previewUrl && !imageError ? (
          <img src={previewUrl} alt={item.name || '图片预览'} referrerPolicy="no-referrer" onError={() => setImageError(true)} />
        ) : (
          <p className="file-preview-note">{imageError ? '图片加载失败，请下载后查看。' : '预览链接无效，请下载后查看。'}</p>
        )
      ) : kind === 'pdf' ? (
        previewUrl ? (
          <iframe sandbox="" referrerPolicy="no-referrer" title={item.name || 'PDF 预览'} src={previewUrl} />
        ) : <p className="file-preview-note">预览链接无效，请下载后查看。</p>
      ) : kind === 'html' ? (
        <>
          {textTruncated ? <p className="file-preview-note">文件较大，预览已截断，仅显示前 256 KB。</p> : null}
          {text !== null && !textError ? (
            <>
              <div className="file-preview-md-toolbar">
                <Button type="button" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}>
                  {showSource ? '渲染' : '查看原文'}
                </Button>
              </div>
              {showSource ? <pre>{text}</pre> : (
                <iframe sandbox="" srcDoc={HTML_PREVIEW_CSP + text} referrerPolicy="no-referrer" title={item.name || 'HTML 预览'} />
              )}
            </>
          ) : (
            <p className="file-preview-note">{textError || (previewUrl ? '正在读取 HTML…' : '预览链接无效，请下载后查看。')}</p>
          )}
        </>
      ) : kind === 'markdown' ? (
        <div className="file-preview-markdown">
          {markdownOversize ? <p className="file-preview-note file-preview-md-note">文件较大，已显示纯文本前 256 KB。</p> : null}
          {markdownToggleVisible ? (
            <div className="file-preview-md-toolbar">
              <Button className="file-preview-md-toggle" type="button" aria-pressed={showSource} onClick={() => setShowSource((value) => !value)}>
                {showSource ? '渲染视图' : '查看原文'}
              </Button>
            </div>
          ) : null}
          {!markdownToggleVisible || showSource ? (
            <pre className="file-preview-md-source">{textError || text || (previewUrl ? '正在读取 Markdown…' : '预览链接无效，请下载后查看。')}</pre>
          ) : (
            <div className="file-preview-md-viewer"><MarkdownIsland text={text ?? ''} mentions={[]} preview={false} /></div>
          )}
        </div>
      ) : kind === 'text' ? (
        <pre>{textError || text || '正在读取文本…'}</pre>
      ) : kind === 'audio' || kind === 'video' ? (
        previewUrl ? (
          kind === 'video' ? <video controls preload="metadata" playsInline src={previewUrl} /> : <audio controls preload="metadata" src={previewUrl} />
        ) : <p className="file-preview-note">预览链接无效，请下载后查看。</p>
      ) : <p className="file-preview-note">该文件类型不支持在线预览，请下载后查看。</p>}
    </div>
  );
}
