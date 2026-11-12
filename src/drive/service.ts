import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createFileMount,
  createFileService,
  FileError,
  type FileMount,
  type FileScope,
  type FileService,
} from '@peri-code/mcpp/files';
import { Disk } from 'flydrive';
import { FSDriver } from 'flydrive/drivers/fs';

import type { Env } from '../env';
import { LIMITS } from '../contracts/limits';
import { isBusinessError } from '../contracts/errors';
import { authenticate } from '../mcp/auth';
import {
  privateFileUrls,
  quotaForOwnerScope,
  registerDriveFile,
} from '../domain/file-access';

export interface DriveOptions {
  directory: string;
  namespace: string;
  maxFileBytes: number;
  ttlSeconds: number;
}

export interface DriveRuntime {
  fileService: FileService;
  mount: FileMount;
}

/**
 * 创建 MCPP Files v1 的本地磁盘实现。
 *
 * 上传与 MCP 共用 authenticate() 的凭据解析：
 * - 已注册 actor 使用 actor scope，工具读取与上传落在同一身份；
 * - 未注册但有凭据的客户端使用凭据摘要 scope（不保存原始 token）；
 * - 无凭据的 MCP bootstrap 请求显式使用 anonymous scope，上传则拒绝。
 */
export function createDrive(env: Env, options: DriveOptions): DriveRuntime {
  mkdirSync(options.directory, { recursive: true });
  const fileService = createFileService({
    disk: new Disk(
      new FSDriver({
        location: resolve(options.directory),
        visibility: 'private',
      }),
    ),
    namespace: options.namespace,
    uploadPath: '/mcp-upload',
    maxFileBytes: options.maxFileBytes,
    ttlSeconds: options.ttlSeconds,
  });
  const mount = createFileMount(fileService, {
    endpointPath: '/mcp',
    uploadPath: '/mcp-upload',
    // Origin 不再是认证边界：app 层在进入 mount 前移除 Origin 并统一补 CORS。
    // MCPP 要求显式传入列表，这里保留空列表以禁用其内部 Origin 匹配。
    allowedOrigins: [],
    resolveScope: async (request, operation): Promise<FileScope> => {
      let principal: Awaited<ReturnType<typeof authenticate>>;
      try {
        principal = await authenticate(env.DB, request);
      } catch (error) {
        // 凭据撤销/停用交给 handleMcp 返回 CREDENTIAL_INVALID 或 ACTOR_DISABLED；
        // MCPP 的 resolveScope 不能把它提前改写成 UNAUTHENTICATED。此时返回占位
        // scope 仅用于进入 handler，真正执行文件工具前仍会再次鉴权。
        if (operation === 'mcp' && isBusinessError(error)) {
          return { key: 'credential:rejected' };
        }
        throw new FileError('UNAUTHENTICATED');
      }
      if (principal.actor) return { key: `actor:${principal.actor.actor_id}` };
      if (principal.credentialHash) return { key: `credential:${principal.credentialHash}` };
      if (operation === 'mcp') return { key: 'anonymous' };
      throw new FileError('UNAUTHENTICATED');
    },
  });
  env.FILES = fileService;
  return { fileService, mount };
}

/** 上传成功响应追加访问地址；不改变 MCPP Files 的既有字段。 */
export interface UploadAccessOptions {
  publicOrigin: string;
  db: D1Database;
  fileService: FileService;
  ticketSecret: string;
  uploaderId: string | null;
}

/**
 * 登记上传并返回访问地址。
 *
 * 上传响应中的 `publicUrl` 是裸 `/f/<fileId>` 地址；新上传默认公开，链接
 * 本身即可读取。`previewUrl` / `downloadUrl` 仍携带 `ownerScope` 文件票据，
 * 供文件被 `network_file_publish { public: false }` 撤销后继续按上传者身份
 * 访问，也兼容需要显式票据的旧客户端。票据每次使用仍校验文件登记状态与
 * 所有权；公开/私有状态以 `drive_files.visibility` 为准。
 */
export async function attachPublicUrl(
  response: Response,
  options: UploadAccessOptions,
): Promise<Response> {
  if (response.status !== 201) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response;
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    return response;
  }
  if (typeof payload.fileId !== 'string') return response;
  let record: Awaited<ReturnType<FileService['readRecord']>>;
  try {
    record = await options.fileService.readRecord(payload.fileId);
    if (!record) throw new Error('upload record missing');
    const drive = await registerDriveFile(options.db, record, options.uploaderId, {
      draftTtlMs: LIMITS.fileDraftTtlMs,
    });
    const urls = privateFileUrls(
      options.ticketSecret,
      options.publicOrigin,
      record.fileId,
      record.ownerScope,
    );
    payload.publicUrl = urls.public_url;
    payload.previewUrl = urls.preview_url;
    payload.downloadUrl = urls.download_url;
    payload.expiresAt = new Date(
      drive.expires_at ?? Date.parse(record.expiresAt),
    ).toISOString();
    payload.state = drive.state;
    payload.visibility = drive.visibility;
    payload.retained = drive.retained === 1;
    const quota = await quotaForOwnerScope(options.db, record.ownerScope);
    // 草稿配额不足时拒绝保存本次上传，避免把 10 年底层 TTL 当作无限空间。
    // 已有文件不受影响；本次载荷立即回收，记录标记为 deleted 供 GC 兜底。
    if (quota.used_bytes > quota.limit_bytes || quota.used_files > quota.limit_files) {
      const at = Date.now();
      await options.db
        .prepare(
          `UPDATE drive_files
              SET state = 'deleted', deleted_at = ?, deleted_by = 'quota', retained = 0
            WHERE file_id = ? AND state = 'draft'`,
        )
        .bind(at, payload.fileId)
        .run();
      await purgeFilePayloads(options.fileService, payload.fileId);
      return new Response(
        JSON.stringify({
          error: 'QUOTA_EXCEEDED',
          message: '草稿配额不足，请先清理未绑定文件后重试',
          quota,
        }),
        { status: 507, headers: { 'content-type': 'application/json' } },
      );
    }
    payload.quota = quota;
  } catch {
    await purgeFilePayloads(options.fileService, payload.fileId);
    return new Response(
      JSON.stringify({ error: 'FILE_UNAVAILABLE', message: '文件登记失败，请重试上传' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    );
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), { status: 201, headers });
}

/** 可在浏览器内联展示的光栅图片；SVG 是主动内容，不在白名单内。 */
const RASTER_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const ACTIVE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'image/svg',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-javascript',
]);

const SAFE_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

export function mediaTypeOf(raw: string): string {
  const essence = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return SAFE_MEDIA_TYPE.test(essence) ? essence : 'application/octet-stream';
}

export function isActiveContent(mediaType: string): boolean {
  return ACTIVE_TYPES.has(mediaType) || mediaType.endsWith('+xml');
}

export type FilePreviewKind = 'image' | 'pdf' | 'text' | 'audio' | 'video' | 'download';

/**
 * 浏览器预览分类。
 *
 * 与公开下载头共享同一份安全分类：SVG/HTML/XML/JS 等主动内容以及未知类型
 * 一律归为 `download`，页面不得用 `<img>`/`<iframe>` 内联渲染。
 */
export function filePreviewKind(mimeType: string): FilePreviewKind {
  const mediaType = mediaTypeOf(mimeType);
  if (isActiveContent(mediaType)) return 'download';
  if (RASTER_IMAGE_TYPES.has(mediaType)) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('text/')) return 'text';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  return 'download';
}

export interface PublicFileRecord {
  mimeType: string;
  size: number;
  name: string;
  sha256: string;
}

export interface PublicFileHeaderOptions {
  /** `?download=1`：即使类型可内联也强制 attachment。 */
  forceAttachment?: boolean;
  /** 覆盖默认的 `private, no-store`；房间文件仍不使用长期 public 缓存。 */
  cacheControl?: string;
  /** 声明支持 Range，供媒体拖动与断点续传使用。 */
  acceptRanges?: boolean;
}

/**
 * 公开文件下载响应头。
 *
 * 公开 URL 与聊天页同源，因此把主动内容（HTML/SVG/XML/JS/未知类型）
 * 强制为 attachment 并加 sandbox CSP；光栅图片、PDF 与普通 text 才内联。
 * 所有响应禁用长期缓存，避免撤权/过期后仍被浏览器复用。
 */
export function publicFileHeaders(
  record: PublicFileRecord,
  options: PublicFileHeaderOptions = {},
): Record<string, string> {
  const mediaType = mediaTypeOf(record.mimeType);
  const active = isActiveContent(mediaType);
  const raster = RASTER_IMAGE_TYPES.has(mediaType);
  const pdf = mediaType === 'application/pdf';
  const plainText = !active && mediaType.startsWith('text/');
  const inline = !options.forceAttachment && (raster || pdf || plainText);
  const contentType = plainText ? `${mediaType}; charset=utf-8` : mediaType;

  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(record.size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    'cache-control': options.cacheControl ?? 'private, no-store, max-age=0',
    etag: `"${record.sha256}"`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-site',
  };
  if (options.acceptRanges) headers['accept-ranges'] = 'bytes';

  if (active || !inline) {
    headers['content-security-policy'] = "default-src 'none'; sandbox";
    headers['x-frame-options'] = 'DENY';
  } else if (pdf) {
    headers['content-security-policy'] = "frame-ancestors 'self'";
    headers['x-frame-options'] = 'SAMEORIGIN';
  }

  return headers;
}

/**
 * 删除房间文件对应的 FlyDrive 对象。
 *
 * 墓碑已经在数据库中提交，删除失败只影响磁盘占用，不影响 404 语义；
 * 因此这里逐项 best-effort，绝不把存储异常抛回工具调用。返回是否所有
 * 载荷都删除成功，供 GC 决定是否写 `purged_at`；失败留待下一轮重试。
 */
export async function purgeFilePayloads(
  fileService: FileService,
  fileId: string,
): Promise<boolean> {
  let complete = true;
  for (const name of ['ready.json', 'pending.json', 'payload'] as const) {
    try {
      await fileService.disk.delete(fileService.key(fileId, name));
    } catch {
      // 过期清理与磁盘回收由 FlyDrive 自身负责；这里不改变业务结果。
      complete = false;
    }
  }
  return complete;
}
