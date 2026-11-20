import { BusinessError } from '../contracts/errors';
import type { DriveFileRow } from '../storage/rows';

/**
 * 头像只接受光栅图片。
 *
 * SVG/HTML 可携带脚本，且 `/f/:fileId` 对 SVG 强制 attachment；把它们
 * 作为头像既不可展示，也会把不可信标记带进 `<img>` 之外的渲染路径。
 */
export const AVATAR_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/** Content-Type 可带参数；只比较主类型，统一小写。 */
export function normalizeAvatarMimeType(value: string): string {
  return (value.split(';', 1)[0] ?? '').trim().toLowerCase();
}

export function isAvatarMimeType(value: string): boolean {
  return (AVATAR_MIME_TYPES as readonly string[]).includes(normalizeAvatarMimeType(value));
}

/**
 * 头像读取地址。
 *
 * 返回站内相对路径而不是拼接 `PUBLIC_ORIGIN`：浏览器按当前页面同源解析，
 * 分享页/配对页/反向代理多入口都不会指向错误主机，也不会引入外部 URL。
 */
export function avatarUrl(fileId: string | null | undefined): string | null {
  return fileId ? `/f/${fileId}` : null;
}

export function avatarInvalid(message: string): BusinessError {
  return new BusinessError('INVALID_ARGUMENT', message);
}

/**
 * 事务外预检与事务内 guard 共用的可用条件。
 *
 * 只接受当前 actor 的上传草稿：已绑定房间的文件受房间 TTL/删除逻辑约束，
 * 复用为头像会与房间文件生命周期冲突，因此在入口直接拒绝。
 */
export function avatarFileUsable(
  drive: DriveFileRow | null,
  ownerScope: string,
  uploaderId: string,
  at: number,
): drive is DriveFileRow {
  if (!drive) return false;
  if (drive.state !== 'draft' || drive.room_id !== null) return false;
  if (drive.owner_scope !== ownerScope || drive.uploader_id !== uploaderId) return false;
  if (drive.visibility !== 'public') return false;
  if (!isAvatarMimeType(drive.mime_type)) return false;
  if (drive.retained !== 1 && drive.expires_at !== null && drive.expires_at <= at) return false;
  return true;
}
