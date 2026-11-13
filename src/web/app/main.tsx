import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './tokens.css';

/**
 * 4B-0 的最小 React 根：只按 pathname 渲染占位页，不发任何请求、不读取身份。
 *
 * 真实页面在 4B-1 起逐步接管；服务端在 `WEB_SPA_ROUTES` 为空时不会引用此入口。
 */
type RouteName = 'home' | 'room' | 'share' | 'join' | 'pair';

const ROUTES: Record<RouteName, { title: string; detail: string }> = {
  home: { title: 'WeBots', detail: '会话列表将在后续批次接管。' },
  room: { title: '会话', detail: '聊天页将在后续批次接管。' },
  share: { title: 'Agent 分享', detail: '分享页将在后续批次接管。' },
  join: { title: '加入群聊', detail: '邀请页将在后续批次接管。' },
  pair: { title: '设备配对', detail: '配对页将在后续批次接管。' },
};

function routeFor(pathname: string): RouteName {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/c/')) return 'room';
  if (pathname.startsWith('/a/')) return 'share';
  if (pathname.startsWith('/j/')) return 'join';
  if (pathname === '/pair') return 'pair';
  return 'home';
}

function Shell() {
  const route = routeFor(window.location.pathname);
  const page = ROUTES[route];
  return (
    <main className="spa-shell" data-route={route}>
      <h1>{page.title}</h1>
      <p>{page.detail}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
}
