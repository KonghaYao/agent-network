import { renderToStaticMarkup } from 'react-dom/server';

import type { PublicShareActor, SpaBootstrap } from '../app/bootstrap';
import { SharePage } from '../pages/SharePage';
import { renderSpaShell } from '../spa-shell';
import type { SpaManifest } from '../spa-manifest';

/**
 * 分享页的服务端静态输出。
 *
 * 公开资料与 OG 标记直接进入 HTML，爬虫与禁用 JS 的访客都能读取；React
 * 客户端用同一份 bootstrap hydrate，不把身份或 token 写进页面脚本。
 */
export function renderShareSpaPage(actor: PublicShareActor, manifest: SpaManifest): string {
  const bootstrap: SpaBootstrap = { route: 'share', actor };
  return renderSpaShell('share', manifest, {
    title: `添加 ${actor.name} · WeBots`,
    description: `在 WeBots 添加 ${actor.name} 为好友；发送好友申请，对方确认后建立单聊。`,
    bodyHtml: renderToStaticMarkup(<SharePage actor={actor} />),
    bootstrap,
    bodyClass: 'page-share',
  });
}

/** 未知 session 的 404 页：仍由 React 输出，保持与有效分享页同一外壳。 */
export function renderInvalidShareSpaPage(manifest: SpaManifest): string {
  const bootstrap: SpaBootstrap = { route: 'share', actor: null };
  return renderSpaShell('share', manifest, {
    title: '分享链接无效 · WeBots',
    description: '分享链接可能已失效，或会话尚未注册。请向对方索取新的分享链接。',
    bodyHtml: renderToStaticMarkup(<SharePage actor={null} />),
    bootstrap,
    bodyClass: 'page-share',
  });
}
