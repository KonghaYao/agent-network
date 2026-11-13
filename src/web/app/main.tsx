import { StrictMode, useEffect } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import './tokens.css';
import './pages.css';
import './app.css';
import { readSpaBootstrap, type SpaBootstrap } from './bootstrap';
import { Providers } from './providers';
import { useRoute } from './router';
import { ConfirmHost } from '../features/overlays/confirm';
import { ChatPage } from '../pages/ChatPage';
import { HomePage } from '../pages/HomePage';
import { JoinPage } from '../pages/JoinPage';
import { PairPage } from '../pages/PairPage';
import { SharePage } from '../pages/SharePage';

/**
 * 应用入口。
 *
 * home/room/pair 由客户端 CSR；share/join 的服务端已输出静态标记与公开
 * 数据，这里用同一份 bootstrap hydrate，保留链接预览与无 JS 可读内容。
 * `ConfirmHost` 与路由同级只挂一次，任何页面都能 await `confirmDialog()`。
 */
function App({ bootstrap }: { bootstrap: SpaBootstrap | null }) {
  const route = useRoute();
  // 客户端导航（建群后跳转、popstate）不会重新请求 HTML；legacy CSS 仍按
  // body class 决定显示侧栏还是聊天区，因此必须同步。
  useEffect(() => {
    const titles: Record<string, string> = {
      home: 'WeBots',
      room: '会话 · WeBots',
      share: 'Agent 分享 · WeBots',
      join: '加入群聊 · WeBots',
      pair: '设备配对 · WeBots',
    };
    const body = document.body;
    for (const name of ['home', 'room', 'share', 'join', 'pair']) {
      body.classList.toggle(`page-${name}`, route.name === name);
    }
    body.dataset.spaRoute = route.name;
    document.title = titles[route.name] ?? document.title;
  }, [route.name]);
  let page;
  if (route.name === 'home') page = <HomePage />;
  else if (route.name === 'room') page = <ChatPage roomId={route.roomId} />;
  else if (route.name === 'share') {
    page = <SharePage actor={bootstrap?.route === 'share' ? bootstrap.actor : null} />;
  } else if (route.name === 'join') {
    const inviteKey =
      bootstrap?.route === 'join' ? bootstrap.inviteKey : route.inviteKey;
    page = <JoinPage inviteKey={inviteKey} />;
  } else if (route.name === 'pair') page = <PairPage />;
  else {
    page = (
      <main className="spa-shell">
        <h1>页面尚未迁移</h1>
        <p>该页面仍由旧版渲染。</p>
        <a href="/?spa=0">切换到旧版</a>
      </main>
    );
  }
  return (
    <>
      {page}
      <ConfirmHost />
    </>
  );
}

const bootstrap = readSpaBootstrap();
const root = document.getElementById('root');
if (root) {
  const app = (
    <StrictMode>
      <Providers>
        <App bootstrap={bootstrap} />
      </Providers>
    </StrictMode>
  );
  if (bootstrap?.route === 'share' || bootstrap?.route === 'join') {
    hydrateRoot(root, app);
  } else {
    createRoot(root).render(app);
  }
}
