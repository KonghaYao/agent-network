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
 * 输出 React 壳 HTML。
 *
 * 4B-0 只渲染空壳：不包含 token、身份、房间或消息数据；`root` 由入口脚本
 * 水合/挂载。`no-store` 与 `Vary: Cookie` 由调用方设置。
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
<style>:root{color-scheme:light dark}body{margin:0;min-height:100dvh;background:#ededed}@media (prefers-color-scheme:dark){body{background:#191919}}</style>
${css}
</head>
<body data-spa-route="${route}">
<div id="root"></div>
<script type="application/json" id="spa-bootstrap">${bootstrap}</script>
<script type="module" src="${escapeHtml(manifest.entry)}"></script>
</body>
</html>`;
}
