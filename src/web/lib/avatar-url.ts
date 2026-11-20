import { fileSafeUrl, previewImageMime } from './files-ui';

const FILE_PATH = /^\/f\/[^/]+$/u;
const EXTENSION = /\.([A-Za-z0-9]{1,8})$/u;

/**
 * 头像地址只接受同源 `/f/<fileId>` 的裸地址。
 *
 * 复用文件预览的安全函数：拒绝外站、带凭据、非 `/f/` 路径与带查询参数的
 * 票据地址；如果 fileId 恰好带扩展名，再走 `previewImageMime` 的图片判定，
 * SVG 等非光栅图片一律拒绝。服务端头像接口本身只接受 PNG/JPEG/WebP/GIF。
 */
export function safeAvatarUrl(value: string | null | undefined): string | null {
  const href = fileSafeUrl(value ?? undefined);
  if (!href) return null;
  const url = new URL(href);
  if (url.search || url.hash) return null;
  if (!FILE_PATH.test(url.pathname)) return null;
  if (EXTENSION.test(url.pathname)) {
    const mime = previewImageMime('', url.pathname);
    if (!mime || mime.includes('svg')) return null;
  }
  return href;
}
