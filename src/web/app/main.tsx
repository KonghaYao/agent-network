import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './tokens.css';
import { useRoute } from './router';
import { ChatPage } from '../pages/ChatPage';
import { HomePage } from '../pages/HomePage';

/**
 * 应用入口：`/` 由 Home 接管，`/c/:id` 由 Chat 接管；其余 route 继续由
 * 服务端输出 legacy，这里只作为 Vite dev/误开 flag 时的安全回退。
 */
function App() {
  const route = useRoute();
  if (route.name === 'home') return <HomePage />;
  if (route.name === 'room') return <ChatPage roomId={route.roomId} />;
  return (
    <main className="spa-shell">
      <h1>页面尚未迁移</h1>
      <p>该页面仍由旧版渲染。</p>
      <a href="/?spa=0">切换到旧版</a>
    </main>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
