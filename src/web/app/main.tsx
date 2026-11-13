import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import './tokens.css';
import './pages.css';
import { readSpaBootstrap, type SpaBootstrap } from './bootstrap';
import { useRoute } from './router';
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
 */
function App({ bootstrap }: { bootstrap: SpaBootstrap | null }) {
  const route = useRoute();
  if (route.name === 'home') return <HomePage />;
  if (route.name === 'room') return <ChatPage roomId={route.roomId} />;
  if (route.name === 'share') {
    return <SharePage actor={bootstrap?.route === 'share' ? bootstrap.actor : null} />;
  }
  if (route.name === 'join') {
    const inviteKey =
      bootstrap?.route === 'join' ? bootstrap.inviteKey : route.inviteKey;
    return <JoinPage inviteKey={inviteKey} />;
  }
  if (route.name === 'pair') return <PairPage />;
  return (
    <main className="spa-shell">
      <h1>页面尚未迁移</h1>
      <p>该页面仍由旧版渲染。</p>
      <a href="/?spa=0">切换到旧版</a>
    </main>
  );
}

const bootstrap = readSpaBootstrap();
const root = document.getElementById('root');
if (root) {
  const app = (
    <StrictMode>
      <App bootstrap={bootstrap} />
    </StrictMode>
  );
  if (bootstrap?.route === 'share' || bootstrap?.route === 'join') {
    hydrateRoot(root, app);
  } else {
    createRoot(root).render(app);
  }
}
