import { LIMITS } from '../../contracts/limits';

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

const FILE_URL =
  /(?:https?:\/\/[^\s<>"'`）)]+\/f\/|\/f\/)([A-Za-z0-9_-]{20,})(?:\?[^\s<>"'`）)]*)?/gu;

export interface FileCard {
  fileId: string;
  url: string;
}

/** 从正文提取同源/绝对 `/f/<fileId>`；只用于气泡外卡片，不改写正文。 */
export function extractFileCards(body: string): FileCard[] {
  const cards: FileCard[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(FILE_URL)) {
    const fileId = match[1];
    if (!fileId || seen.has(fileId)) continue;
    let url: URL;
    try {
      url = new URL(match[0], window.location.origin);
    } catch {
      continue;
    }
    // 只把同源 /f/ 渲染成文件卡片；外站链接仍按正文普通链接处理。
    if (url.origin !== window.location.origin) continue;
    seen.add(fileId);
    cards.push({ fileId, url: url.href });
    if (cards.length >= LIMITS.messageFileLinksMax) break;
  }
  return cards;
}

/** 非安全上下文没有 navigator.clipboard 时的兜底复制。 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
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
