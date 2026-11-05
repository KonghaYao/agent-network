/**
 * 启动时构建 AI 消息 Markdown 岛，失败只禁用 Markdown，不影响聊天服务。
 *
 * Streamdown 是 ESM + React，不能用页面内联的 vanilla 脚本直接渲染；
 * 这里把 `src/web/markdown/entry.tsx` 打成单个浏览器 bundle，
 * `src/app.ts` 以 `/assets/chat-markdown.js` 提供，页面按需动态导入。
 */

import { resolve } from 'node:path';

import { buildClientBundle, type ClientBundleAsset } from './client-bundle';

const ENTRY = resolve(import.meta.dir, 'markdown/entry.tsx');

export type MarkdownAsset = ClientBundleAsset;

/**
 * 构建失败或没有入口产物时返回 null。
 * 开发、测试与生产都复用同一份内存产物。
 */
export function buildMarkdownBundle(): Promise<MarkdownAsset | null> {
  return buildClientBundle(ENTRY, 'markdown');
}
