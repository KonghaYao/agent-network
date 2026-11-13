import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** 可以由 React 壳接管的页面；未列出的路径始终走 legacy 渲染。 */
export const SPA_ROUTES = ['home', 'room', 'share', 'join', 'pair'] as const;
export type SpaRoute = (typeof SPA_ROUTES)[number];

/**
 * 已迁移到 React 的 route。
 *
 * 4B-2 接管 home 与 room；4B-3 接管 share/join/pair。flag 仍按 route 独立
 * 灰度，未列出的 route 继续渲染 legacy。
 */
export const IMPLEMENTED_SPA_ROUTES: ReadonlySet<SpaRoute> = new Set<SpaRoute>([
  'home',
  'room',
  'share',
  'join',
  'pair',
]);

const SPA_ROUTE_SET: ReadonlySet<string> = new Set(SPA_ROUTES);

/**
 * 解析 `WEB_SPA_ROUTES`。
 *
 * 默认空集合 = 全部 legacy；未知名称忽略，避免拼写错误把未部署页面打开。
 */
export function parseSpaRoutes(value: string | undefined): ReadonlySet<SpaRoute> {
  if (!value) return new Set();
  const routes = new Set<SpaRoute>();
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (SPA_ROUTE_SET.has(name)) routes.add(name as SpaRoute);
  }
  return routes;
}

export interface SpaManifest {
  /** 入口脚本的公开 URL，例如 `/static/assets/main-abc.js`。 */
  readonly entry: string;
  /** 入口 CSS 的公开 URL 列表。 */
  readonly css: readonly string[];
}

interface ViteManifestEntry {
  file?: unknown;
  isEntry?: unknown;
  css?: unknown;
}

function publicStaticUrl(file: string): string {
  return `/static/${file.replace(/^\/+/u, '')}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * 读取 Vite 构建 manifest；缺失、损坏或引用文件不存在时返回 null。
 *
 * 启动时调用一次，失败只回退 legacy，不影响 `/static/*` 或其它路由。
 */
export async function loadSpaManifest(distDir: string): Promise<SpaManifest | null> {
  const manifestPath = resolve(distDir, '.vite/manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const entries = Object.values(parsed as Record<string, ViteManifestEntry>).filter(
    (entry): entry is ViteManifestEntry & { file: string } =>
      entry !== null &&
      typeof entry === 'object' &&
      entry.isEntry === true &&
      typeof entry.file === 'string' &&
      entry.file.length > 0,
  );
  const entry = entries[0];
  if (!entry) return null;

  const css = Array.isArray(entry.css)
    ? entry.css.filter((file): file is string => typeof file === 'string' && file.length > 0)
    : [];

  for (const file of [entry.file, ...css]) {
    const path = resolve(distDir, file);
    if (!path.startsWith(`${distDir}${sep}`)) return null;
    if (!(await isFile(path))) return null;
  }

  return {
    entry: publicStaticUrl(entry.file),
    css: css.map(publicStaticUrl),
  };
}
