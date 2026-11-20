import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { type BrandAsset } from './brand';
import { PWA_BRAND_ASSETS } from './brand-assets.generated';
import { buildPwaManifest } from './manifest';
import { SERVICE_WORKER_SOURCE } from './sw';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

/** 发布/兼容模式共用同一份源文件；不依赖 Vite 产物目录。 */
const assetCache = new Map<string, Promise<ArrayBuffer>>();

export const PWA_MANIFEST_BODY = `${JSON.stringify(buildPwaManifest(), null, 2)}\n`;
export const PWA_MANIFEST_ETAG = `"sha256:${sha256Hex(
  new TextEncoder().encode(PWA_MANIFEST_BODY),
)}"`;
export const PWA_SERVICE_WORKER_BODY = SERVICE_WORKER_SOURCE;
export const PWA_SERVICE_WORKER_ETAG = `"sha256:${sha256Hex(
  new TextEncoder().encode(PWA_SERVICE_WORKER_BODY),
)}"`;

export const PWA_ICON_ASSETS: readonly BrandAsset[] = [
  PWA_BRAND_ASSETS.icon192,
  PWA_BRAND_ASSETS.icon512,
  PWA_BRAND_ASSETS.iconMaskable512,
  PWA_BRAND_ASSETS.appleTouch180,
  PWA_BRAND_ASSETS.favicon,
];

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function pwaAssetForUrl(url: string): BrandAsset | null {
  return PWA_ICON_ASSETS.find((asset) => asset.url === url) ?? null;
}

/** 读取生成脚本落盘的图标字节；失败时抛出，由路由转为 404。 */
export function readPwaAsset(asset: BrandAsset): Promise<ArrayBuffer> {
  const cached = assetCache.get(asset.path);
  if (cached) return cached;
  const pending = readFile(resolve(REPO_ROOT, asset.path)).then(
    (bytes) =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  assetCache.set(asset.path, pending);
  pending.catch(() => assetCache.delete(asset.path));
  return pending;
}

export function pwaAssetEtag(asset: BrandAsset): string {
  return `"sha256:${asset.sha256}"`;
}
