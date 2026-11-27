import { APP_STYLE } from './chat-styles';
import { DRAWBOARD_FALLBACK_STYLE } from './chat-drawboard-styles';
import { FILES_STYLE } from './chat-files-styles';
import { MARKDOWN_STYLE } from './chat-markdown-styles';
import { MESSAGE_ACTIONS_STYLE } from './chat-message-actions-styles';
import { MESSAGE_FILES_STYLE } from './chat-message-files-styles';
import { MEMORY_STYLE } from './chat-memory-styles';
import { MONITOR_STYLE } from './chat-monitor-styles';
import { TASK_DOCK_STYLE } from './chat-task-dock-styles';
import { TASK_TRACE_STYLE } from './chat-task-trace-styles';
import { UPLOAD_STYLE } from './chat-upload-styles';
import { DEVICE_HANDOFF_STYLE } from './device-handoff-styles';
import { FOCUS_STYLE } from './focus-styles';
import { pwaHeadTags } from './pwa/manifest';
import { PWA_STYLE } from './pwa-styles';
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
 * 入口脚本 404/解析失败时 React 尚未运行；这段标记与内联脚本不依赖 CSS
 * chunk、Lenso 或任何业务数据，直接显示可操作错误页。它放在 `#root` 外，
 * 避免 share/join hydrate 不匹配；成功挂载后由 `__webBootOk` 隐藏。
 */
export const BOOT_ERROR_MARKUP = `<div id="web-boot-error" class="web-boot-error" hidden>
<main class="web-boot-error-card" role="alert">
<h1>资源加载失败</h1>
<p>页面脚本未能加载。请检查网络连接后重试；已输入的文字草稿仍保存在本机。</p>
<button type="button" id="web-boot-retry">重试</button>
<p class="web-boot-error-hint">如果刚完成更新，也可以关闭页面后重新打开。</p>
</main>
</div>`;

/** 不读取 storage、不请求网络、不自动刷新；只响应脚本错误并提供手动重试。 */
export const BOOT_ERROR_SCRIPT = `(function(){
  var panel = document.getElementById('web-boot-error');
  var retry = document.getElementById('web-boot-retry');
  var booted = false;
  function show() {
    if (booted || !panel) return;
    panel.hidden = false;
  }
  function bootOk() {
    booted = true;
    if (panel) panel.hidden = true;
  }
  window.__webBootOk = bootOk;
  window.addEventListener('error', function (event) {
    if (booted) return;
    // 入口模块 404/解析失败在部分浏览器只把 target 指向 window；挂载前
    // 的任何脚本错误都应停在可操作错误页，而不是留下空壳。
    var target = event.target;
    if (target && target.tagName === 'SCRIPT') { show(); return; }
    show();
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    if (booted) return;
    var reason = event.reason;
    var text = reason && (reason.message || String(reason));
    if (typeof text === 'string' &&
      /Importing a module script failed|Failed to fetch dynamically imported module/i.test(text)) {
      show();
    }
  });
  if (retry) retry.addEventListener('click', function () { window.location.reload(); });
})();`;

const BOOT_ERROR_STYLE = `
  .web-boot-error { position: fixed; inset: 0; z-index: 1000; display: grid;
    place-items: center; padding: 24px; background: #f5f5f5; color: #1a1a1a;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  .web-boot-error[hidden] { display: none; }
  .web-boot-error-card { width: min(420px, 100%); padding: 28px 24px; border-radius: 12px;
    background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,.08); text-align: center; }
  .web-boot-error-card h1 { margin: 0 0 10px; font-size: 20px; font-weight: 600; }
  .web-boot-error-card p { margin: 0 0 18px; color: #666666; }
  .web-boot-error-card button { min-height: 44px; padding: 0 24px; border: 0;
    border-radius: 8px; background: #07c160; color: #ffffff; font: inherit;
    font-weight: 600; cursor: pointer; }
  .web-boot-error-card button:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 2px; }
  .web-boot-error-hint { margin: 12px 0 0 !important; font-size: 12px; color: #999999 !important; }
  @media (prefers-color-scheme: dark) {
    .web-boot-error { background: #191919; color: #ededed; }
    .web-boot-error-card { background: #2c2c2c; box-shadow: none; }
    .web-boot-error-card p { color: #a3a3a3; }
    .web-boot-error-card button:focus-visible { outline-color: #ededed; }
  }
`;

/**
 * React 壳复用原有的应用页样式：会话项、头像、空状态、移动端单栏
 * 与 Memory 抽屉都沿用同一套 CSS 变量和选择器。
 */
const SPA_STYLE = `${APP_STYLE}${DEVICE_HANDOFF_STYLE}${MEMORY_STYLE}${PWA_STYLE}${FOCUS_STYLE}
  html, body { height: 100%; }
  body.wide { display: block; min-height: 100dvh; height: 100dvh; padding: 0;
    overflow: hidden; background: var(--wx-bg); }
  body.wide #root { display: flex; width: 100%; height: 100dvh; min-height: 0; }
  body.wide #root > .lenso-root > main { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; }
`;

/** Chat 复用 Markdown、回执菜单、附件、文件、监控与画板样式。 */
const CHAT_STYLE = `${SPA_STYLE}${MARKDOWN_STYLE}${MESSAGE_ACTIONS_STYLE}${MESSAGE_FILES_STYLE}${UPLOAD_STYLE}${FILES_STYLE}${MONITOR_STYLE}${TASK_TRACE_STYLE}${TASK_DOCK_STYLE}${DRAWBOARD_FALLBACK_STYLE}`;

/**
 * 输出 React 壳 HTML。
 *
 * 只包含静态标记与 bootstrap JSON：不输出 token、身份、房间或消息数据
 * （分享页只输出公开资料）。`root` 由入口脚本水合/挂载。`no-store` 由调用方设置。
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
  // 发布模式下五条路由（含 SSR share/join）共用一个进程已固定的 buildId；
  // 开发/旧模式没有发布描述，不输出该标签，客户端只依赖 bootstrap。
  const release =
    typeof manifest.buildId === 'string' &&
    manifest.buildId.length > 0 &&
    typeof manifest.webContract === 'number'
      ? `<script type="application/json" id="web-release">${jsonForScript({
          buildId: manifest.buildId,
          webContract: manifest.webContract,
        })}</script>`
      : '';
  const css = manifest.css
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
${pwaHeadTags()}
<title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}${CHAT_STYLE}${BOOT_ERROR_STYLE}</style>
${css}
</head>
<body class="${escapeHtml(bodyClass)}" data-spa-route="${route}">
<div id="root">${options.bodyHtml ?? ''}</div>
${BOOT_ERROR_MARKUP}
<noscript><p>WeBots 需要启用 JavaScript。</p></noscript>
<script type="application/json" id="spa-bootstrap">${bootstrap}</script>
${release}
<script>${BOOT_ERROR_SCRIPT}</script>
<script type="module" src="${escapeHtml(manifest.entry)}"></script>
</body>
</html>`;
}
