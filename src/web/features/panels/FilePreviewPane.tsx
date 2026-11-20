import { useEffect, useRef } from 'react';

import { Button } from '../../app/lenso-controls';
import { fileDownloadUrl, fileIconLabel, fileMetaText, filePreviewKind, type RoomFileItem } from '../../lib/files-ui';
import { FilePreviewBody } from './FilePreviewBody';

interface FilePreviewPaneProps {
  item: RoomFileItem;
  onBack: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

/**
 * 复用文件栏尺寸与共享正文，不创建对话框或遮罩。
 * 全屏只是页面内覆盖状态，按钮在 ≥1200 的样式断点才显示。
 */
export function FilePreviewPane({ item, onBack, fullscreen = false, onToggleFullscreen }: FilePreviewPaneProps) {
  const backRef = useRef<HTMLButtonElement>(null);
  const fullscreenRef = useRef<HTMLButtonElement>(null);
  const wasFullscreen = useRef(fullscreen);
  const download = fileDownloadUrl(item);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  // 进入全屏后焦点落在“退出全屏”，退出后回到同一触发按钮。
  useEffect(() => {
    if (fullscreen || wasFullscreen.current) fullscreenRef.current?.focus();
    wasFullscreen.current = fullscreen;
  }, [fullscreen]);

  // 全屏覆盖全页，点击正文后焦点会落到 body，section 收不到按键。
  // 监听挂在 document；非全屏的 Esc 仍由 section 处理，两者不会重复触发。
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onToggleFullscreen?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [fullscreen, onToggleFullscreen]);

  return (
    <section id="file-preview-pane" className="file-preview-card file-preview-inline" aria-label="文件预览"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // 全屏由 document 监听统一处理，避免同一按键被 section 再退出一次。
        if (fullscreen) return;
        event.stopPropagation();
        onBack();
      }}>
      <header className="file-preview-head">
        <Button ref={backRef} id="file-preview-back" type="button" onClick={onBack}>返回列表</Button>
        <div className="file-preview-id">
          <h2 id="file-preview-title">{item.name || '文件预览'}</h2>
          <p id="file-preview-meta" className="file-preview-meta">{fileIconLabel(filePreviewKind(item))} · {fileMetaText(item)}</p>
        </div>
        {onToggleFullscreen ? (
          <Button
            ref={fullscreenRef}
            id="file-preview-fullscreen"
            className="file-preview-fullscreen"
            type="button"
            aria-pressed={fullscreen}
            onClick={onToggleFullscreen}
          >
            {fullscreen ? '退出全屏' : '全屏'}
          </Button>
        ) : null}
        <Button id="file-preview-close" type="button" aria-label="关闭预览" onClick={onBack}>关闭</Button>
      </header>
      <FilePreviewBody key={item.file_id} item={item} />
      <footer className="file-preview-foot">
        {download ? <a id="file-preview-download" href={download} download={item.name || '文件'} rel="noopener" referrerPolicy="no-referrer">下载文件</a> : null}
      </footer>
    </section>
  );
}
