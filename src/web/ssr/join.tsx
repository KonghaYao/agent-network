import { renderToStaticMarkup } from 'react-dom/server';

import type { SpaBootstrap } from '../app/bootstrap';
import { JoinPage } from '../pages/JoinPage';
import { renderSpaShell } from '../spa-shell';
import type { SpaManifest } from '../spa-manifest';

/**
 * 群邀请落地页的服务端静态输出。
 *
 * 只输出邀请壳与说明；群名、人数、审批策略仍由浏览器 token 调用工具读取，
 * 加入前不读取群消息，HTML 也不泄露群是否存在。
 */
export function renderJoinSpaPage(inviteKey: string, manifest: SpaManifest): string {
  const bootstrap: SpaBootstrap = { route: 'join', inviteKey };
  return renderSpaShell('join', manifest, {
    title: '加入群聊 · WeBots',
    description: '打开 WeBots 群邀请，用浏览器身份预览邀请并确认加入。',
    bodyHtml: renderToStaticMarkup(<JoinPage inviteKey={inviteKey} />),
    bootstrap,
    bodyClass: 'page-join',
  });
}

/** 邀请 key 格式非法时的 404 页。 */
export function renderInvalidJoinSpaPage(manifest: SpaManifest): string {
  const bootstrap: SpaBootstrap = { route: 'join', inviteKey: null };
  return renderSpaShell('join', manifest, {
    title: '邀请无效 · WeBots',
    description: '群邀请链接格式不正确，请确认链接完整或向群管理员索取新的邀请。',
    bodyHtml: renderToStaticMarkup(<JoinPage inviteKey={null} />),
    bootstrap,
    bodyClass: 'page-join',
  });
}
