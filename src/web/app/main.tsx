import {
  Component,
  lazy,
  StrictMode,
  Suspense,
  useEffect,
  type ReactNode,
} from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import '@lenso/tokens/styles.css';
import './tokens.css';
import './pages.css';
import './app.css';
import { readSpaBootstrap, type SpaBootstrap } from './bootstrap';
import { Providers } from './providers';
import { useRoute } from './router';
import { TabUnreadBadge } from './TabUnreadBadge';
import { ConfirmHost } from '../features/overlays/confirm';
import { AgentMemoryDialogHost } from '../features/memory/AgentMemoryDialogHost';
import { ChatRouteFallback } from './ChatRouteFallback';
import { HomePage } from '../pages/HomePage';
import { JoinPage } from '../pages/JoinPage';
import { SharePage } from '../pages/SharePage';
import { InstallGuideHost } from '../pwa/InstallGuideHost';
import { UpdateNotice } from '../pwa/UpdateNotice';
import { initInstallPrompt } from '../pwa/install';
import { registerServiceWorker } from '../pwa/register';

/**
 * `/pair` 只在直接访问或从首页跳转时使用；拆出入口 chunk 后，普通会话
 * 启动不再下载配对页。PairPage 是纯 CSR 路由，不参与 SSR hydrate。
 */
const ChatPage = lazy(() =>
  import('../pages/ChatPage').then((module) => ({ default: module.ChatPage })),
);

const PairPage = lazy(() =>
  import('../pages/PairPage').then((module) => ({ default: module.PairPage })),
);

function RouteFallback() {
  return (
    <main aria-busy="true">
      <p className="muted" role="status">
        正在加载页面…
      </p>
    </main>
  );
}

/** 懒加载路由 chunk 失败时保留可操作页面，不让异常冒泡成空白应用。 */
class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main>
        <div className="share-head">
          <h1>页面加载失败</h1>
          <p className="muted">网络或静态资源暂不可用，请刷新后重试。</p>
        </div>
        <div className="row share-actions">
          <button className="primary" type="button" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      </main>
    );
  }
}

/**
 * 应用入口。
 *
 * home/room/pair 由客户端 CSR；share/join 的服务端已输出静态标记与公开
 * 数据，这里用同一份 bootstrap hydrate，保留链接预览与无 JS 可读内容。
 * `ConfirmHost` 与路由同级只挂一次，任何页面都能 await `confirmDialog()`。
 */
const APP_TITLES: Record<string, string> = {
  home: 'WeBots',
  room: '会话 · WeBots',
  share: 'Agent 分享 · WeBots',
  join: '加入群聊 · WeBots',
  pair: '设备配对 · WeBots',
};

function App({ bootstrap }: { bootstrap: SpaBootstrap | null }) {
  const route = useRoute();
  const baseTitle = APP_TITLES[route.name] ?? 'WeBots';
  const appRoute = route.name === 'home' || route.name === 'room';
  // 客户端导航（建群后跳转、popstate）不会重新请求 HTML；legacy CSS 仍按
  // body class 决定显示侧栏还是聊天区，因此必须同步。
  useEffect(() => {
    const body = document.body;
    for (const name of ['home', 'room', 'share', 'join', 'pair']) {
      body.classList.toggle(`page-${name}`, route.name === name);
    }
    body.dataset.spaRoute = route.name;
  }, [route.name]);
  // 应用页标题由 TabUnreadBadge 组合未读前缀；卡片页沿用服务端标题。
  useEffect(() => {
    if (appRoute) return;
    document.title = baseTitle;
  }, [appRoute, baseTitle]);
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
  else page = <HomePage />;
  return (
    <>
      <RouteBoundary>
        <Suspense fallback={route.name === 'room' ? <ChatRouteFallback /> : <RouteFallback />}>
          {page}
        </Suspense>
      </RouteBoundary>
      {appRoute ? <TabUnreadBadge baseTitle={baseTitle} /> : null}
      <ConfirmHost />
      <AgentMemoryDialogHost />
      {appRoute ? <InstallGuideHost appRoute /> : null}
      {appRoute || route.name === 'pair' ? <UpdateNotice /> : null}
    </>
  );
}

const bootstrap = readSpaBootstrap();
initInstallPrompt();
// 发布构建的 nonce 只用于支持诊断；不参与权限或业务判断。
if (typeof __WEB_BUILD_NONCE__ === 'string' && __WEB_BUILD_NONCE__.length > 0) {
  document.documentElement.dataset.webBuild = __WEB_BUILD_NONCE__;
}
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

// 首屏渲染后再等待 load/idle 注册，不与入口脚本、字体和首屏查询竞争。
registerServiceWorker();
