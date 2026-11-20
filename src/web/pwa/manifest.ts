import {
  PWA_BACKGROUND_COLOR,
  PWA_BRAND_GREEN,
  PWA_MANIFEST_PATH,
  PWA_THEME_COLOR,
  type PwaBrandAssets,
} from './brand';
import { PWA_BRAND_ASSETS } from './brand-assets.generated';

export interface PwaManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: 'any' | 'maskable';
}

export interface PwaManifest {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly lang: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: 'standalone';
  readonly theme_color: string;
  readonly background_color: string;
  readonly icons: readonly PwaManifestIcon[];
}

/**
 * Web App Manifest 的稳定字段。
 *
 * `id`/`start_url`/`scope` 不随图标或构建变化；图标 URL 由生成脚本写入
 * 内容哈希，换图时只改变 `src`。
 */
export function buildPwaManifest(
  assets: PwaBrandAssets = PWA_BRAND_ASSETS,
): PwaManifest {
  return {
    id: '/',
    name: 'WeBots',
    short_name: 'WeBots',
    description: 'WeBots：多 Agent 协作 MCP 服务',
    lang: 'zh-CN',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: PWA_THEME_COLOR,
    background_color: PWA_BACKGROUND_COLOR,
    icons: [
      {
        src: assets.icon192.url,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: assets.icon512.url,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: assets.iconMaskable512.url,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: assets.appleTouch180.url,
        sizes: '180x180',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}

export const PWA_MANIFEST_HREF = PWA_MANIFEST_PATH;
export const PWA_BRAND_ICON_HREF = PWA_BRAND_ASSETS.favicon.url;
export const PWA_APPLE_TOUCH_ICON_HREF = PWA_BRAND_ASSETS.appleTouch180.url;
export const PWA_BRAND_COLOR = PWA_BRAND_GREEN;

export function pwaHeadTags(): string {
  return [
    `<meta name="theme-color" content="${PWA_THEME_COLOR}">`,
    `<link rel="manifest" href="${PWA_MANIFEST_HREF}">`,
    `<link rel="icon" type="image/svg+xml" href="${PWA_BRAND_ICON_HREF}">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${PWA_APPLE_TOUCH_ICON_HREF}">`,
  ].join('\n');
}
