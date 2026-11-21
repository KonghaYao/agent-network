import { useState } from 'react';

import { Button } from '../../app/lenso-controls';
import { Tooltip } from '../../app/lenso-tooltip';
import { fileBadge, formatFileSize } from '../../lib/files';
import { fileSafeUrl, previewImageMime, type RoomFileItem } from '../../lib/files-ui';

export interface ComposerFile {
  key: string;
  name: string;
  size: number;
  mime: string;
  status: 'uploading' | 'ready' | 'failed';
  percent: number;
  phase: 'upload' | 'join';
  fileId: string | null;
  publicUrl: string | null;
  previewUrl: string | null;
  downloadUrl: string | null;
  error: string;
}

function fileMeta(file: ComposerFile): string {
  if (file.status === 'uploading') {
    return file.phase === 'join' ? '正在加入房间…' : `上传中 ${file.percent}%`;
  }
  if (file.status === 'failed') return file.error || '上传失败';
  return formatFileSize(file.size);
}

/**
 * 待发送文件 chip。
 *
 * 已绑定且可判定的图片显示 48px 缩略图，地址只接受同源 `/f/` 的带票据
 * `preview_url`；加载失败或未就绪时回退到类型 badge，不显示破图。
 */
export function ComposerFileChip({
  file,
  onOpenFile,
  onRemove,
  removeDisabled,
}: {
  file: ComposerFile;
  onOpenFile: (item: RoomFileItem) => void;
  onRemove: () => void;
  removeDisabled: boolean;
}) {
  const [thumbBroken, setThumbBroken] = useState(false);
  const image = file.status === 'ready' ? previewImageMime(file.mime, file.name) : null;
  const thumb = image ? fileSafeUrl(file.previewUrl ?? undefined) : null;
  const item: RoomFileItem | null =
    thumb && file.fileId
      ? {
          file_id: file.fileId,
          name: file.name,
          size: file.size,
          mime_type: file.mime,
          public_url: file.publicUrl ?? undefined,
          preview_url: thumb,
          download_url: file.downloadUrl ?? undefined,
        }
      : null;

  return (
    <div className="composer-file" role="listitem" data-file-id={file.fileId ?? ''}>
      {thumb && item && !thumbBroken ? (
        <Tooltip as={Button}
          type="button"
          variant="borderless"
          size="sm"
          className="composer-file-thumb"
          hint={file.name}
          aria-label={`预览图片 ${file.name}`}
          onClick={() => onOpenFile(item)}
        >
          <img
            src={thumb}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setThumbBroken(true)}
          />
        </Tooltip>
      ) : (
        <span className="composer-file-badge" aria-hidden="true">
          {fileBadge(file.name)}
        </span>
      )}
      <span className="composer-file-main">
        <Tooltip as="span" className="composer-file-name" hint={file.name}>
          {file.name}
        </Tooltip>
        <span className="composer-file-meta">{fileMeta(file)}</span>
      </span>
      <Tooltip as={Button}
        type="button"
        variant="borderless"
        size="sm"
        isIconOnly
        className="composer-file-remove"
        aria-label={`移除 ${file.name}`}
        hint={`移除 ${file.name}`}
        disabled={removeDisabled}
        onClick={onRemove}
      >
        ×
      </Tooltip>
    </div>
  );
}
