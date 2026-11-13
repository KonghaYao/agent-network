import { APP_STYLE } from './chat-styles';
import { DRAWBOARD_FALLBACK_STYLE } from './chat-drawboard-styles';
import { FILES_STYLE } from './chat-files-styles';
import { MARKDOWN_STYLE } from './chat-markdown-styles';
import { MESSAGE_ACTIONS_STYLE } from './chat-message-actions-styles';
import { MESSAGE_FILES_STYLE } from './chat-message-files-styles';
import { MEMORY_STYLE } from './chat-memory-styles';
import { MONITOR_STYLE } from './chat-monitor-styles';
import { TASK_TRACE_STYLE } from './chat-task-trace-styles';
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

const DESCRIPTIONS: Record<SpaRoute, string> = {
  home: 'WeBots：多 Agent 协作 MCP 服务',
  room: 'WeBots 会话',
  share: '在 WeBots 添加 Agent 为好友，发送好友申请后建立单聊。',
  join: '打开 WeBots 群邀请，用浏览器身份预览邀请并确认加入。',
  pair: '用一次性配对码把新设备绑定到当前身份。',
};

/** 分享/加入/配对是单列卡片页；home/room 才使用全屏应用布局。 */
const CARD_ROUTES: ReadonlySet<SpaRoute> = new Set<SpaRoute>(['share', 'join', 'pair']);

export interface SpaShellOptions {
  /** 覆盖页面标题；分享页把 Agent 名称放进 title 与 OG。 */
  readonly title?: string;
  readonly description?: string;
  /** 服务端静态标记；为空时由客户端 CSR 渲染。 */
  readonly bodyHtml?: string;
  /** 写入 `#spa-bootstrap` 的数据；默认只有 `{ route }`。 */
  readonly bootstrap?: unknown;
  /** 覆盖 body class；默认应用页 `wide page-<route>`，卡片页 `page-<route>`。 */
  readonly bodyClass?: string;
}

/**
 * React 壳复用 legacy 的应用页样式：会话项、头像、空状态、移动端单栏
 * 与 Memory 抽屉都沿用同一套 CSS 变量和选择器，避免灰度期间两套视觉。
 */
const SPA_STYLE = `${APP_STYLE}${DEVICE_HANDOFF_STYLE}${MEMORY_STYLE}
  html, body { height: 100%; }
  body.wide { display: block; min-height: 100dvh; height: 100dvh; padding: 0;
    overflow: hidden; background: var(--wx-bg); }
  body.wide #root { display: flex; width: 100%; height: 100dvh; min-height: 0; }
  body.wide #root > main { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; }
`;

/** Chat 复用 legacy 的 Markdown、回执菜单、附件、文件、监控与画板样式。 */
const CHAT_STYLE = `${SPA_STYLE}${MARKDOWN_STYLE}${MESSAGE_ACTIONS_STYLE}${MESSAGE_FILES_STYLE}${UPLOAD_STYLE}${FILES_STYLE}${MONITOR_STYLE}${TASK_TRACE_STYLE}${DRAWBOARD_FALLBACK_STYLE}
  /* Chat 是单栏 React 页，桌面也保留返回入口；legacy 双栏由侧栏承担。 */
  body.page-room .chat-pane .back { display: inline-flex; }
`;

/**
 * 输出 React 壳 HTML。
 *
 * 只包含静态标记与 bootstrap JSON：不输出 token、身份、房间或消息数据
 * （分享页只输出公开资料）。`root` 由入口脚本水合/挂载。`no-store` 与
 * `Vary: Cookie` 由调用方设置。
 */
export function renderSpaShell(
  route: SpaRoute,
  manifest: SpaManifest,
  options: SpaShellOptions = {},
): string {
  const title = options.title ?? TITLES[route];
  const description = options.description ?? DESCRIPTIONS[route];
  const bodyClass = options.bodyClass ?? (CARD_ROUTES.has(route) ? `page-${route}` : `wide page-${route}`);
  const bootstrap = jsonForScript(options.bootstrap ?? { route });
  const css = manifest.css
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}${route === 'room' ? CHAT_STYLE : SPA_STYLE}</style>
${css}
</head>
<body class="${escapeHtml(bodyClass)}" data-spa-route="${route}">
<div id="root">${options.bodyHtml ?? ''}</div>
<noscript><p>WeBots 需要启用 JavaScript。</p></noscript>
<script type="application/json" id="spa-bootstrap">${bootstrap}</script>
<script type="module" src="${escapeHtml(manifest.entry)}"></script>
</body>
</html>`;
}
