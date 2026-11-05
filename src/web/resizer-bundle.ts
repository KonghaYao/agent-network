/**
 * 启动时构建右侧面板拖拽岛。
 *
 * 主布局仍是 vanilla TS；这个 bundle 只接管分隔条与宽度状态，
 * 通过 CSS 变量改变右栏宽度，不重建聊天、文件或监控面板。
 * 产物由 `src/app.ts` 以 `/assets/chat-resizer.js` 提供。
 */

import { resolve } from 'node:path';

import { buildClientBundle, type ClientBundleAsset } from './client-bundle';

const ENTRY = resolve(import.meta.dir, 'resizer/entry.tsx');

export type ResizerAsset = ClientBundleAsset;

/** 构建失败返回 null；页面保留默认 50/50 的 CSS 布局，分隔条不可拖拽。 */
export function buildResizerBundle(): Promise<ResizerAsset | null> {
  return buildClientBundle(ENTRY, 'resizer');
}
