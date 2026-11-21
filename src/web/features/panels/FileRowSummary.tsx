import { Button } from '../../app/lenso-controls';
import { Tooltip } from '../../app/lenso-tooltip';
import { fileIconLabel, fileMetaText, filePreviewKind, fileSafeUrl, previewImageMime, type RoomFileItem } from '../../lib/files-ui';

export function FileRowSummary({ item, onPreview }: { item: RoomFileItem; onPreview: () => void }) {
  const kind = filePreviewKind(item);
  const thumbnail = kind === 'image' ? fileSafeUrl(item.preview_url || item.download_url || item.public_url) : null;
  const name = item.name || '未命名文件';
  const summary = (
    <>
      <span className="file-thumb">
        {thumbnail && previewImageMime(item.mime_type, item.name)
          ? <img src={thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
          : fileIconLabel(kind)}
      </span>
      <span className="file-main">
        <Tooltip as="span" className="file-name" hint={name}>{name}</Tooltip>
        <span className="file-meta">{fileMetaText(item)}</span>
      </span>
    </>
  );

  if (kind === 'html' || kind === 'markdown') {
    return (
      <Button className="file-row" type="button" variant="borderless"
        aria-label={`预览 ${item.name || '文件'}`} onClick={onPreview}>
        {summary}
      </Button>
    );
  }
  return <div className="file-row">{summary}</div>;
}
