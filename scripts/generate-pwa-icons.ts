/**
 * 生成 WeBots PWA 图标与 favicon。
 *
 * 只用仓库内的 Node API：按品牌几何栅格化绿色圆角方块 + 白色 W，再用
 * `node:zlib` 编码 PNG；不调用外部图片服务或新增依赖。文件名带内容哈希，
 * 并同步生成 `src/web/pwa/brand-assets.generated.ts`，保证 manifest 与
 * HTML 引用同一份字节。
 *
 * 用法：`bun scripts/generate-pwa-icons.ts`
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

import {
  BRAND_CORNER_RADIUS,
  BRAND_W_POINTS,
  BRAND_W_STROKE,
  PWA_BACKGROUND_COLOR,
  PWA_BRAND_GREEN,
  PWA_MANIFEST_PATH,
  PWA_SERVICE_WORKER_PATH,
  PWA_THEME_COLOR,
  brandIconSvg,
  type BrandAsset,
} from '../src/web/pwa/brand';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PUBLIC_DIR = join(REPO_ROOT, 'public/pwa');
const GENERATED_FILE = join(REPO_ROOT, 'src/web/pwa/brand-assets.generated.ts');
const SAMPLE_GRID = 4;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/iu.test(value)) throw new Error(`不支持的颜色: ${hex}`);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

const GREEN = parseHex(PWA_BRAND_GREEN);
const WHITE = { r: 255, g: 255, b: 255 };

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(typeBytes, 4);
  result.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return result;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array()),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function insideRoundedSquare(x: number, y: number, radius: number): boolean {
  if (x < 0 || y < 0 || x > 1 || y > 1) return false;
  if (x >= radius && x <= 1 - radius) return true;
  if (y >= radius && y <= 1 - radius) return true;
  const cx = x < radius ? radius : 1 - radius;
  const cy = y < radius ? radius : 1 - radius;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function insideW(x: number, y: number): boolean {
  const half = BRAND_W_STROKE / 2;
  for (let index = 0; index < BRAND_W_POINTS.length - 1; index += 1) {
    const [ax, ay] = BRAND_W_POINTS[index]!;
    const [bx, by] = BRAND_W_POINTS[index + 1]!;
    if (distanceToSegment(x, y, ax, ay, bx, by) <= half) return true;
  }
  return false;
}

interface IconOptions {
  readonly size: number;
  /** maskable/apple 使用全幅绿色底，避免平台裁切后露出透明角。 */
  readonly fullBleed: boolean;
}

function renderIcon({ size, fullBleed }: IconOptions): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const samples = SAMPLE_GRID * SAMPLE_GRID;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      let white = 0;
      for (let sy = 0; sy < SAMPLE_GRID; sy += 1) {
        for (let sx = 0; sx < SAMPLE_GRID; sx += 1) {
          const x = (px + (sx + 0.5) / SAMPLE_GRID) / size;
          const y = (py + (sy + 0.5) / SAMPLE_GRID) / size;
          if (fullBleed || insideRoundedSquare(x, y, BRAND_CORNER_RADIUS)) covered += 1;
          if (insideW(x, y)) white += 1;
        }
      }
      const index = (py * size + px) * 4;
      if (covered === 0) continue;
      const ratio = white / covered;
      const color: Rgba = {
        r: Math.round(GREEN.r * (1 - ratio) + WHITE.r * ratio),
        g: Math.round(GREEN.g * (1 - ratio) + WHITE.g * ratio),
        b: Math.round(GREEN.b * (1 - ratio) + WHITE.b * ratio),
        a: Math.round((covered / samples) * 255),
      };
      rgba[index] = color.r;
      rgba[index + 1] = color.g;
      rgba[index + 2] = color.b;
      rgba[index + 3] = color.a;
    }
  }
  return rgba;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writePng(
  label: string,
  options: IconOptions,
): Promise<{ asset: BrandAsset; bytes: Uint8Array }> {
  const bytes = encodePng(options.size, options.size, renderIcon(options));
  const hash = sha256(bytes);
  const fileName = `${label}-${hash.slice(0, 12)}.png`;
  await writeFile(join(PUBLIC_DIR, fileName), bytes);
  return {
    asset: {
      url: `/pwa/${fileName}`,
      path: `public/pwa/${fileName}`,
      contentType: 'image/png',
      sha256: hash,
    },
    bytes,
  };
}

function timestampHeader(): string {
  return [
    '// 由 scripts/generate-pwa-icons.ts 生成，请勿手改。',
    '// 重新生成：bun scripts/generate-pwa-icons.ts',
    '',
    "import type { PwaBrandAssets } from './brand';",
    '',
  ].join('\n');
}

async function main() {
  await mkdir(PUBLIC_DIR, { recursive: true });
  const existing = await readdir(PUBLIC_DIR).catch(() => []);
  await Promise.all(
    existing
      .filter((name) => /^(?:icon-|apple-touch-icon-|favicon-).*\.(?:png|svg)$/u.test(name))
      .map((name) => rm(join(PUBLIC_DIR, name), { force: true })),
  );

  const icon192 = await writePng('icon-192', { size: 192, fullBleed: false });
  const icon512 = await writePng('icon-512', { size: 512, fullBleed: false });
  const maskable = await writePng('icon-maskable-512', { size: 512, fullBleed: true });
  const apple = await writePng('apple-touch-icon-180', { size: 180, fullBleed: true });

  const svg = new TextEncoder().encode(brandIconSvg());
  const faviconHash = sha256(svg);
  const faviconName = `favicon-${faviconHash.slice(0, 12)}.svg`;
  await writeFile(join(PUBLIC_DIR, faviconName), svg);
  const favicon: BrandAsset = {
    url: `/pwa/${faviconName}`,
    path: `public/pwa/${faviconName}`,
    contentType: 'image/svg+xml; charset=utf-8',
    sha256: faviconHash,
  };

  const assets = {
    icon192: icon192.asset,
    icon512: icon512.asset,
    iconMaskable512: maskable.asset,
    appleTouch180: apple.asset,
    favicon,
  };

  const generated = `${timestampHeader()}export const PWA_BRAND_ASSETS: PwaBrandAssets = ${JSON.stringify(
    assets,
    null,
    2,
  )} as const;\n`;
  await writeFile(GENERATED_FILE, generated);

  console.log(
    JSON.stringify(
      {
        manifest: PWA_MANIFEST_PATH,
        serviceWorker: PWA_SERVICE_WORKER_PATH,
        themeColor: PWA_THEME_COLOR,
        backgroundColor: PWA_BACKGROUND_COLOR,
        assets,
      },
      null,
      2,
    ),
  );
}

await main();
