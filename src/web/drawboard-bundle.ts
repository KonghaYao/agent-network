/**
 * 启动时不加载的画板岛：Fabric.js 只在用户打开画板时动态导入。
 *
 * 入口是浏览器 ESM；`src/app.ts` 以带内容版本的 `/assets/chat-drawboard.js`
 * 提供。构建失败返回 null，页面打开画板时显示可读错误而不是白屏。
 */

import { resolve } from 'node:path';

import { buildClientBundle, type ClientBundleAsset } from './client-bundle';

const ENTRY = resolve(import.meta.dir, 'drawboard/entry.ts');

export type DrawboardAsset = ClientBundleAsset;

export function buildDrawboardBundle(): Promise<DrawboardAsset | null> {
  return buildClientBundle(ENTRY, 'drawboard');
}
