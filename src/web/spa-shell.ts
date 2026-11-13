import { APP_STYLE } from './chat-styles';
import { MARKDOWN_STYLE } from './chat-markdown-styles';
import { MESSAGE_ACTIONS_STYLE } from './chat-message-actions-styles';
import { MESSAGE_FILES_STYLE } from './chat-message-files-styles';
import { UPLOAD_STYLE } from './chat-upload-styles';
import { DEVICE_HANDOFF_STYLE } from './handoff';
import { escapeHtml, jsonForScript } from './layout';
import type { SpaManifest, SpaRoute } from './spa-manifest';

const TITLES: Record<SpaRoute, string> = {
  home: 'WeBots',
  room: '会话 · WeBots',
  share: 'Agent 分享 · WeBots',
  join: '加入群聊 · WeBots',
  pair: '设备配对 · WeBots',
};

/**
 * React 壳复用 legacy 的应用页样式：会话项、头像、空状态与移动端单栏
 * 都沿用同一套 CSS 变量和选择器，避免灰度期间两套视觉。
 */
const SPA_STYLE = `${APP_STYLE}${DEVICE_HANDOFF_STYLE}
  html, body { height: 100%; }
  body.wide { display: block; min-height: 100dvh; height: 100dvh; padding: 0;
    overflow: hidden; background: var(--wx-bg); }
  body.wide #root { display: flex; width: 100%; height: 100dvh; min-height: 0; }
  body.wide #root > main { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; }
`;

/** Chat 复用 legacy 的 Markdown、回执菜单、附件与文件卡片样式。 */
const CHAT_STYLE = `${SPA_STYLE}${MARKDOWN_STYLE}${MESSAGE_ACTIONS_STYLE}${MESSAGE_FILES_STYLE}${UPLOAD_STYLE}
  /* Chat 是单栏 React 页，桌面也保留返回入口；legacy 双栏由侧栏承担。 */
  body.page-room .chat-pane .back { display: inline-flex; }
`;

/**
 * 输出 React 壳 HTML。
 *
 * 只包含空壳与静态样式：不输出 token、身份、房间或消息数据；`root` 由
 * 入口脚本水合/挂载。`no-store` 与 `Vary: Cookie` 由调用方设置。
 */
export function renderSpaShell(route: SpaRoute, manifest: SpaManifest): string {
  const bootstrap = jsonForScript({ route });
  const css = manifest.css
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="WeBots：多 Agent 协作 MCP 服务">
<title>${escapeHtml(TITLES[route])}</title>
<style>:root{color-scheme:light dark}${route === 'room' ? CHAT_STYLE : SPA_STYLE}</style>
${css}
</head>
<body class="wide page-${route}" data-spa-route="${route}">
<div id="root"></div>
<noscript><p>WeBots 需要启用 JavaScript。</p></noscript>
<script type="application/json" id="spa-bootstrap">${bootstrap}</script>
<script type="module" src="${escapeHtml(manifest.entry)}"></script>
</body>
</html>`;
}
