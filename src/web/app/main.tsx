import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './tokens.css';
import { useRoute } from './router';
import { HomePage } from '../pages/HomePage';

/**
 * 4B-1 入口：`/` 由 React Home 接管；其余 route 在服务端继续输出 legacy，
 * 这里只作为 Vite dev/误开 flag 时的安全回退，不渲染半成品聊天页。
 */
function App() {
  const route = useRoute();
  if (route.name === 'home') return <HomePage />;
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
