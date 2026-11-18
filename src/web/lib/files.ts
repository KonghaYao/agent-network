import {
  MESSAGE_FILE_ID_SOURCE,
  extractMessageFileLinks,
  normalizeEscapedNewlines,
} from '../../contracts/file-links';

import { callTool } from './mcp-client';

/**
 * 浏览器附件：`POST /mcp-upload` 后立即 `network_room_file_bind`。
 *
 * 与 legacy 使用同一 MCPP 头与错误文案；上传进度只进入 chip，不写 console。
 */

export interface UploadedFile {
  file_id: string;
  public_url: string;
  preview_url?: string;
  download_url?: string;
  mime_type?: string;
}

interface UploadPayload {
  fileId?: string;
  file_id?: string;
  publicUrl?: string;
  public_url?: string;
  file?: UploadedFile;
}

export function formatFileSize(size: number): string {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileBadge(name: string): string {
  const match = /\.([A-Za-z0-9]{1,5})$/u.exec(name);
  return match ? match[1]!.toUpperCase().slice(0, 4) : 'FILE';
}

function uploadFailure(status: number, payload: unknown): Error {
  if (status === 401 || status === 403) return new Error('身份已失效，请刷新页面后重试');
  if (status === 413) return new Error('文件超过大小限制');
  const record = payload as { error?: { message?: unknown } | string; message?: unknown } | null;
  const nested = record?.error;
  const message =
    typeof nested === 'string'
      ? nested
      : typeof nested?.message === 'string'
        ? nested.message
        : typeof record?.message === 'string'
          ? record.message
          : '';
  return new Error(message || `上传失败（HTTP ${status}）`);
}

export function uploadFileToDrive(
  file: File,
  token: string,
  onProgress: (percent: number) => void,
): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/mcp-upload');
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('MCPP-Files-Version', '1');
    xhr.setRequestHeader('MCPP-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('MCPP-File-Size', String(file.size));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || !event.total) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', () => {
      let payload: UploadPayload | null = null;
      try {
        payload = JSON.parse(xhr.responseText || '{}') as UploadPayload;
      } catch {
        payload = null;
      }
      const fileId = payload?.fileId ?? payload?.file_id;
      if (xhr.status >= 200 && xhr.status < 300 && fileId) {
        resolve({ file_id: fileId, public_url: '' });
        return;
      }
      reject(uploadFailure(xhr.status, payload));
    });
    xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(file);
  });
}

export async function bindFileToRoom(
  roomId: string,
  fileId: string,
  token: string,
): Promise<UploadedFile> {
  const bound = await callTool<UploadedFile | { file: UploadedFile }>(
    'network_room_file_bind',
    { request_id: `file_bind_${crypto.randomUUID().replaceAll('-', '')}`, room_id: roomId, file_id: fileId },
    { token },
  );
  const file = 'file' in bound && bound.file ? bound.file : (bound as UploadedFile);
  if (!file.file_id || !file.public_url) throw new Error('上传响应缺少公开地址');
  return file;
}

const MARKDOWN_LINK = /\[([^\]\n]{0,200})\]\(\s*<?([^)\s>]+)>?\s*\)/gu;
const EXACT_FILE_URL = new RegExp(`^/f/(${MESSAGE_FILE_ID_SOURCE})$`, 'u');
const MARKDOWN_WRAPPERS = [
  /^\*\*([\s\S]+)\*\*$/u,
  /^__([\s\S]+)__$/u,
  /^`([^`]+)`$/u,
];

export interface FileCard {
  fileId: string;
  url: string;
  /** Markdown alt 或 URL 前一行；元数据到达前的兜底文件名。 */
  fallbackName: string;
}

function cleanFallbackName(value: string): string {
  let text = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .trim();
  for (const wrapper of MARKDOWN_WRAPPERS) text = text.replace(wrapper, '$1');
  if (text.length > 160) text = text.slice(0, 160);
  return text.trim();
}

/** Markdown `[文件名](/f/<id>)` 的标签；key 为 fileId。 */
function markdownFileLabels(body: string): Map<string, string> {
  const labels = new Map<string, string>();
  for (const match of normalizeEscapedNewlines(body).matchAll(MARKDOWN_LINK)) {
    let url: URL;
    try {
      url = new URL(match[2]!, window.location.origin);
    } catch {
      continue;
    }
    if (url.origin !== window.location.origin || url.username || url.password) continue;
    const fileId = url.pathname.match(EXACT_FILE_URL)?.[1];
    const label = cleanFallbackName(match[1] ?? '');
    if (fileId && label) labels.set(fileId, label);
  }
  return labels;
}

/** URL 前一行作为文件名；遇到另一个 URL 或 Markdown 链接时停止。 */
function previousLineName(body: string, fileId: string): string {
  const text = normalizeEscapedNewlines(body);
  const index = text.indexOf(`/f/${fileId}`);
  if (index < 0) return '';
  const lines = text.slice(0, index).split('\n');
  for (let cursor = lines.length - 2; cursor >= 0; cursor -= 1) {
    const line = cleanFallbackName(lines[cursor] ?? '');
    if (!line) continue;
    if (line.includes('/f/') || /^https?:/iu.test(line)) return '';
    return line;
  }
  return '';
}

/** 从正文提取同源 `/f/<fileId>`；只用于气泡外卡片，不改写正文。 */
export function extractFileCards(body: string): FileCard[] {
  const labels = markdownFileLabels(body);
  return extractMessageFileLinks(body, window.location.origin).map((fileId) => ({
    fileId,
    url: `/f/${fileId}`,
    fallbackName: labels.get(fileId) ?? previousLineName(body, fileId),
  }));
}

/** 非安全上下文没有 navigator.clipboard 时的兜底复制。 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 非安全上下文、权限被拒或焦点丢失时继续走 execCommand 回退。
    }
  }
  // 剪贴板回退的 textarea 只在内存中挂载一次用于 execCommand，不进入界面渲染树，
  // 因此不属于 Lenso 原生控件盘点范围。
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝了复制操作');
  } finally {
    area.remove();
  }
}
