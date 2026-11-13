import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** React 壳接管的页面。4B-6 起所有页面都由 React 渲染，不再有 legacy 分支。 */
export const SPA_ROUTES = ['home', 'room', 'share', 'join', 'pair'] as const;
export type SpaRoute = (typeof SPA_ROUTES)[number];

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
 * 启动时调用一次。4B-6 起 legacy 壳已删除，页面路由在 manifest 缺失时
 * 返回 503，提示先执行 `bun run build:web`；`/static/*` 与其它路由不受影响。
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
