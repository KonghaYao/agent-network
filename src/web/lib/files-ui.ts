/**
 * 房间文件的只读视图工具。
 *
 * 与 legacy `chat-files-actions-script.ts` 保持同一套安全边界：只接受同源
 * `/f/` 链接、预览类型先归一化 MIME、文件名与正文都走 React 文本节点。
 */

import { formatByteSize, formatDisplayTime, normalizeMimeType } from './display-format';

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

export type PreviewKind = 'image' | 'pdf' | 'html' | 'markdown' | 'text' | 'audio' | 'video' | 'other';

const PREVIEW_TEXT_BYTES = 262_144;
const MARKDOWN_MIMES = new Set(['text/markdown', 'text/x-markdown']);
const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/iu;
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
  const mime = normalizeMimeType(mimeType);
  if (mime === 'image/jpg') return 'image/jpeg';
  if (mime.startsWith('image/') && !mime.includes('svg')) return mime;
  if (mime === 'application/octet-stream' || mime === '') {
    return IMAGE_EXTENSIONS[extension(name)] ?? null;
  }
  return null;
}

/**
 * `.md` / `.markdown` 按 Markdown 预览。
 *
 * 扩展名兜底只接受空 MIME、`text/plain` 与 `application/octet-stream`；HTML/XML/JS
 * 等主动内容即使文件名像 Markdown 也不进入 Markdown 渲染器。
 */
export function isMarkdownPreview(item: RoomFileItem): boolean {
  const mime = normalizeMimeType(item.mime_type);
  if (MARKDOWN_MIMES.has(mime)) return true;
  if (mime && mime !== 'text/plain' && mime !== 'application/octet-stream') return false;
  return MARKDOWN_EXTENSION.test(String(item.name ?? ''));
}

/** HTML 只按明确的 MIME 识别，文件名与服务端预览提示不能放宽边界。 */
export function isHtmlPreview(item: RoomFileItem): boolean {
  return normalizeMimeType(item.mime_type) === 'text/html';
}

/** 显式 SVG MIME 一律不预览，避免内联脚本进入图片预览路径。 */
function isSvgMime(mime: string): boolean {
  return mime === 'image/svg' || mime === 'image/svg+xml';
}

export function filePreviewKind(item: RoomFileItem): PreviewKind {
  if (isHtmlPreview(item)) return 'html';
  const kind = String(item.preview_kind ?? '').toLowerCase();
  const mime = normalizeMimeType(item.mime_type);
  if (kind === 'pdf' && !mime.startsWith('application/pdf')) return 'other';
  if (isSvgMime(mime)) return 'other';
  if (previewImageMime(item.mime_type, item.name)) return 'image';
  if (kind === 'markdown' || isMarkdownPreview(item)) return 'markdown';
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
  if (kind === 'html') return 'HTML';
  if (kind === 'markdown') return 'MD';
  if (kind === 'text') return 'TXT';
  if (kind === 'audio') return 'AUD';
  if (kind === 'video') return 'VID';
  return 'FILE';
}

const FILE_TYPE_LABELS: Record<PreviewKind, string> = {
  image: '图片',
  pdf: 'PDF',
  html: '网页',
  markdown: 'Markdown',
  text: '文本',
  audio: '音频',
  video: '视频',
  other: '文件',
};

/** 类型友好名；HTML 保留独立 kind，未知类型显示“文件”。 */
export function fileTypeLabel(kind: PreviewKind): string {
  return FILE_TYPE_LABELS[kind] ?? '文件';
}

export function formatFileSize(value: unknown): string {
  return formatByteSize(value);
}

/** 文件时间统一走 detail 口径；未知时间返回空串。 */
export function fileTimeLabel(value: string | number | undefined): string {
  return formatDisplayTime(value, { mode: 'detail' }).display;
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
