/**
 * 房间文件的只读视图工具。
 *
 * 与 legacy `chat-files-actions-script.ts` 保持同一套安全边界：只接受同源
 * `/f/` 链接、预览类型先归一化 MIME、文件名与正文都走 React 文本节点。
 */

export interface RoomFileItem {
  file_id: string;
  room_file_id?: string;
  room_id?: string;
  name?: string;
  size?: number;
  mime_type?: string;
  preview_kind?: string;
  preview_url?: string;
  download_url?: string;
  public_url?: string;
  uploader_name?: string;
  created_at?: string | number;
  can_delete?: boolean;
}

export interface RoomFilePage {
  items: RoomFileItem[];
  next_cursor: string | null;
  has_more: boolean;
}

export type PreviewKind = 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'other';

const PREVIEW_TEXT_BYTES = 262_144;
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

function extension(name: string | undefined): string {
  const match = /\.([A-Za-z0-9]{1,8})$/u.exec(name ?? '');
  return match ? match[1]!.toLowerCase() : '';
}

/** `image/jpg` 与 octet-stream + 图片扩展名按同一归一化 MIME 处理。 */
export function previewImageMime(mimeType: string | undefined, name: string | undefined): string | null {
  const mime = String(mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime.startsWith('image/') && !mime.includes('svg')) return mime;
  if (mime === 'application/octet-stream' || mime === '') {
    return IMAGE_EXTENSIONS[extension(name)] ?? null;
  }
  return null;
}

export function filePreviewKind(item: RoomFileItem): PreviewKind {
  const kind = String(item.preview_kind ?? '').toLowerCase();
  const mime = String(item.mime_type ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (kind === 'pdf' && !mime.startsWith('application/pdf')) return 'other';
  if (previewImageMime(item.mime_type, item.name)) return 'image';
  if (['image', 'pdf', 'text', 'audio', 'video'].includes(kind)) return kind as PreviewKind;
  if (['other', 'unknown', 'file', 'download'].includes(kind)) return 'other';
  if (mime.startsWith('image/')) return mime.includes('svg') ? 'other' : 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return 'text';
  }
  return 'other';
}

/** 只允许本站 `/f/` 地址；外站、带凭据或其它路径一律拒绝。 */
export function fileSafeUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value, location.origin);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  if (url.username || url.password) return null;
  if (!url.pathname.startsWith('/f/')) return null;
  return url.href;
}

export function fileDownloadUrl(item: RoomFileItem): string | null {
  return fileSafeUrl(item.download_url || item.public_url);
}

export function fileCopyUrl(item: RoomFileItem): string | null {
  return fileSafeUrl(item.download_url || item.public_url || item.preview_url);
}

export function fileKey(item: RoomFileItem): string {
  return String(item.room_file_id || item.file_id || '');
}

export function fileIconLabel(kind: PreviewKind): string {
  if (kind === 'image') return 'IMG';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'text') return 'TXT';
  if (kind === 'audio') return 'AUD';
  if (kind === 'video') return 'VID';
  return 'FILE';
}

export function formatFileSize(value: unknown): string {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = size / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10} ${units[index]}`;
}

export function fileTimeLabel(value: string | number | undefined): string {
  let ms = 0;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') {
    if (/^[0-9]+$/u.test(value)) ms = Number(value);
    else {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) ms = parsed;
    }
  }
  if (ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

export function fileMetaText(item: RoomFileItem): string {
  const parts: string[] = [];
  const size = formatFileSize(item.size);
  if (size) parts.push(size);
  parts.push(item.uploader_name || '未知上传者');
  const time = fileTimeLabel(item.created_at);
  if (time) parts.push(time);
  return parts.join(' · ');
}

export function previewRange(): string {
  return `bytes=0-${PREVIEW_TEXT_BYTES - 1}`;
}

export function textPreviewLimit(): number {
  return PREVIEW_TEXT_BYTES;
}
