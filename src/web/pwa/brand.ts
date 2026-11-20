/**
 * WeBots 品牌常量与可复现的图标几何。
 *
 * 图标由 `scripts/generate-pwa-icons.ts` 在仓库内生成，不调用外部图片
 * 服务。主题色保持既有蓝色；品牌绿色只用于 logo/图标。
 */

export const PWA_THEME_COLOR = '#007aff';
export const PWA_BACKGROUND_COLOR = '#ffffff';
export const PWA_BRAND_GREEN = '#07C160';
export const PWA_MANIFEST_PATH = '/manifest.webmanifest';
export const PWA_SERVICE_WORKER_PATH = '/sw.js';

/** 白色 W 的五个端点；与脚本的位图栅格化共用同一组比例。 */
export const BRAND_W_POINTS = [
  [0.285, 0.34],
  [0.385, 0.665],
  [0.5, 0.47],
  [0.615, 0.665],
  [0.715, 0.34],
] as const;

/** 描边宽度占边长的比例。 */
export const BRAND_W_STROKE = 0.09;

/** 普通图标的圆角半径占边长的比例。 */
export const BRAND_CORNER_RADIUS = 0.225;

export interface BrandAsset {
  /** 公开 URL，包含内容哈希。 */
  readonly url: string;
  /** 相对仓库根的源文件路径。 */
  readonly path: string;
  readonly contentType: string;
  readonly sha256: string;
}

export interface PwaBrandAssets {
  readonly icon192: BrandAsset;
  readonly icon512: BrandAsset;
  readonly iconMaskable512: BrandAsset;
  readonly appleTouch180: BrandAsset;
  readonly favicon: BrandAsset;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 与 PNG 图标同源的 SVG：绿色圆角方块 + 白色 W。 */
export function brandIconSvg(): string {
  const size = 64;
  const radius = round(size * BRAND_CORNER_RADIUS);
  const stroke = round(size * BRAND_W_STROKE);
  const points = BRAND_W_POINTS.map(([x, y]) => `${round(x * size)} ${round(y * size)}`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="${radius}" fill="${PWA_BRAND_GREEN}"/>`,
    `<path d="M${points.join(' L')}" fill="none" stroke="#ffffff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
    '</svg>',
  ].join('');
}
