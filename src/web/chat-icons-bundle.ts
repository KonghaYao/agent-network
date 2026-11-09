/**
 * 图标悬停动效岛：启动时构建，失败只禁用动效，不影响静态 SVG 与聊天服务。
 *
 * `src/web/chat-icons.ts` 只按需导入实际使用的 14 枚图标，避免把
 * `kubai-icons` 的完整图标表带进浏览器。`src/app.ts` 以
 * `/assets/chat-icons.js` 提供带内容版本的内存产物。
 */

import { resolve } from 'node:path';

import { buildClientBundle, type ClientBundleAsset } from './client-bundle';

const ENTRY = resolve(import.meta.dir, 'chat-icons.ts');

export type ChatIconsAsset = ClientBundleAsset;

/** 构建失败或没有入口产物时返回 null；页面继续使用静态图标。 */
export function buildChatIconsBundle(): Promise<ChatIconsAsset | null> {
  return buildClientBundle(ENTRY, 'chat-icons');
}
