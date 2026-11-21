import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef } from 'react';

import { Button } from '../../app/lenso-controls';
import { fileMetaText, type RoomFileItem } from '../../lib/files-ui';
import { FileDownloadLink } from './FileDownloadLink';
import { FilePreviewBody } from './FilePreviewBody';

/** 移动端和非文档类型沿用弹窗，共享正文负责预览安全边界。 */
export function FilePreviewDialog({ item, onClose }: { item: RoomFileItem | null; onClose: () => void }) {
  const openerRef = useRef<HTMLElement | null>(null);

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
                <p id="file-preview-meta" className="file-preview-meta">{item ? fileMetaText(item) : ''}</p>
              </div>
              <Button id="file-preview-close" type="button" aria-label="关闭预览" onClick={onClose}>关闭</Button>
            </header>
            {item ? <FilePreviewBody key={item.file_id} item={item} /> : null}
            <footer className="file-preview-foot">
              {item ? <FileDownloadLink id="file-preview-download" item={item}>下载文件</FileDownloadLink> : null}
            </footer>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
