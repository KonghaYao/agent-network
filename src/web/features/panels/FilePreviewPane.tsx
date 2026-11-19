import { useEffect, useRef } from 'react';

import { Button } from '../../app/lenso-controls';
import { fileDownloadUrl, fileIconLabel, fileMetaText, filePreviewKind, type RoomFileItem } from '../../lib/files-ui';
import { FilePreviewBody } from './FilePreviewBody';

/** 复用文件栏尺寸与共享正文，不创建对话框或遮罩。 */
export function FilePreviewPane({ item, onBack }: { item: RoomFileItem; onBack: () => void }) {
  const backRef = useRef<HTMLButtonElement>(null);
  const download = fileDownloadUrl(item);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  return (
    <section id="file-preview-pane" className="file-preview-card file-preview-inline" aria-label="文件预览"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onBack();
      }}>
      <header className="file-preview-head">
        <Button ref={backRef} id="file-preview-back" type="button" onClick={onBack}>返回列表</Button>
        <div className="file-preview-id">
          <h2 id="file-preview-title">{item.name || '文件预览'}</h2>
          <p id="file-preview-meta" className="file-preview-meta">{fileIconLabel(filePreviewKind(item))} · {fileMetaText(item)}</p>
        </div>
        <Button id="file-preview-close" type="button" aria-label="关闭预览" onClick={onBack}>关闭</Button>
      </header>
      <FilePreviewBody key={item.file_id} item={item} />
      <footer className="file-preview-foot">
        {download ? <a id="file-preview-download" href={download} download={item.name || '文件'} rel="noopener" referrerPolicy="no-referrer">下载文件</a> : null}
      </footer>
    </section>
  );
}
