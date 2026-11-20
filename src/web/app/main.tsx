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
import { RecoveryHost } from './RecoveryHost';
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
import {
  checkForUpdate,
  requestSafeUpdate,
  useUpdateState,
} from '../pwa/update-store';

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

/** 资源加载失败时保留可操作页面，不自动刷新，也不吞掉已保存的文字草稿。 */
function RouteLoadError() {
  const update = useUpdateState();
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const canUpdate =
    online && (update.phase === 'available' || update.phase === 'incompatible');
  return (
    <main id="route-load-error" data-route-error="1">
      <div className="share-head">
        <h1>页面加载失败</h1>
        <p className="muted">
          页面资源未能加载。已输入的文字草稿仍保存在本机；可以重试，或返回会话列表。
        </p>
      </div>
      <div className="row share-actions">
        <button
          className="primary"
          type="button"
          id="route-load-retry"
          onClick={() => {
            if (canUpdate) void requestSafeUpdate();
            else window.location.reload();
          }}
        >
          {canUpdate ? '更新后重试' : '重新加载'}
        </button>
        <a href="/">返回会话列表</a>
      </div>
    </main>
  );
}

/** 懒加载 chunk 或 Vite 预加载失败时保留可操作页面，不让异常冒泡成空白应用。 */
class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidMount() {
    window.addEventListener('vite:preloadError', this.onPreloadError);
  }

  componentWillUnmount() {
    window.removeEventListener('vite:preloadError', this.onPreloadError);
  }

  componentDidCatch() {
    // chunk 404 往往意味着服务器已发布新版本；强制检查一次，但不自动刷新。
    void checkForUpdate({ force: true });
  }

  private onPreloadError = () => {
    // 不 preventDefault、不直接整页报错：Lenso、Markdown 等可选模块会自行
    // 捕获动态导入失败并降级。真正的路由 chunk 失败会由 React lazy 拒绝
    // 进入本错误边界；这里只补充一次强制版本检查。
    void checkForUpdate({ force: true });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return <RouteLoadError />;
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
    // React 已提交；之后即使出现资源错误，也交给 RouteBoundary，而不是
    // 覆盖已挂载应用的壳级错误页。
    (window as unknown as { __webBootOk?: () => void }).__webBootOk?.();
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
      {appRoute ? (
        <RecoveryHost
          routeName={route.name}
          roomId={route.name === 'room' ? route.roomId : null}
        />
      ) : null}
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
  // 入口脚本 404 时内联壳负责错误页；只有真正渲染出内容后才隐藏。
  const bootOk = (window as unknown as { __webBootOk?: () => void }).__webBootOk;
  requestAnimationFrame(() => {
    if (root.childElementCount > 0) bootOk?.();
  });
}

// 首屏渲染后再等待 load/idle 注册，不与入口脚本、字体和首屏查询竞争。
registerServiceWorker();
