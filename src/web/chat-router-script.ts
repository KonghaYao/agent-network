/**
 * 客户端路由：只接管 `/` 与 `/c/<room_id>`，其余链接保持浏览器默认行为。
 *
 * URL 是路由权威；`initialRoomId` 只用于首屏 SSR 提示与旧协议字符串兼容。
 * 深链、刷新、前进/后退都重新解析 pathname，不依赖服务端输出房间数据。
 */
export const CHAT_ROUTER_SCRIPT = `
let currentRoute = { view: 'home', roomId: null };

function parseRoute(pathname) {
  if (pathname === '/' || pathname === '') return { view: 'home', roomId: null };
  const match = String(pathname || '').match(/^\\/c\\/([^/]+)\\/?$/);
  if (!match) return null;
  try {
    return { view: 'room', roomId: decodeURIComponent(match[1]) };
  } catch (error) {
    return null;
  }
}

function routePath(view, roomId) {
  return view === 'room' ? '/c/' + encodeURIComponent(roomId) : '/';
}

function snapshotBeforeRouteChange() {
  snapshotActiveRoom();
  snapshotSidebarScroll();
}

function applyRouteChrome(route) {
  const home = route.view === 'home';
  document.body.classList.toggle('page-home', home);
  document.body.classList.toggle('page-room', !home);
  document.title = home ? 'WeBots' : '聊天 · WeBots';
  // 路由切换时关闭瞬时 UI；new-agent 弹窗可能正在展示只显示一次的凭据，保持打开。
  hideMentionPicker();
  closeRenameForm();
  closeGroupModal();
  syncFilesChrome();
}

function navigateTo(path, options) {
  const settings = options || {};
  const url = new URL(path, location.origin);
  const route = parseRoute(url.pathname);
  if (!route) {
    location.href = path;
    return;
  }
  if (route.view === currentRoute.view && route.roomId === currentRoute.roomId) return;
  snapshotBeforeRouteChange();
  const state = {
    app: true,
    view: route.view,
    roomId: route.roomId,
    from: currentRoute.view
  };
  const locationPath = url.pathname + url.search;
  if (settings.replace) {
    history.replaceState(state, '', locationPath);
  } else {
    history.pushState(state, '', locationPath);
  }
  currentRoute = route;
  applyRouteChrome(route);
  if (route.view === 'room') {
    openRoom(route.roomId, { initial: false }).catch(function () {});
  } else {
    closeRoomView();
    restoreSidebarScroll();
  }
}

function handleAppLinkClick(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!target) return;
  const linkTarget = target.getAttribute('target');
  if (linkTarget && linkTarget !== '_self') return;
  if (target.hasAttribute('download')) return;
  let url;
  try {
    url = new URL(target.href, location.href);
  } catch (error) {
    return;
  }
  if (url.origin !== location.origin) return;
  const route = parseRoute(url.pathname);
  if (!route) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
  event.preventDefault();
  if (target.id === 'back') {
    const state = history.state;
    if (state && state.from === 'home') {
      history.back();
    } else {
      navigateTo('/', { replace: true });
    }
    return;
  }
  navigateTo(url.pathname + url.search);
}

function handlePopState() {
  const route = parseRoute(location.pathname);
  if (!route) return;
  snapshotBeforeRouteChange();
  currentRoute = route;
  applyRouteChrome(route);
  if (route.view === 'room') {
    openRoom(route.roomId, { initial: false }).catch(function () {});
  } else {
    closeRoomView();
    restoreSidebarScroll();
  }
}

function bootstrapRoute(initialRoomId) {
  const parsed = parseRoute(location.pathname);
  const route = parsed || (initialRoomId
    ? { view: 'room', roomId: initialRoomId }
    : { view: 'home', roomId: null });
  currentRoute = route;
  history.replaceState({
    app: true,
    view: route.view,
    roomId: route.roomId,
    from: null
  }, '', location.pathname + location.search);
  applyRouteChrome(route);
  document.addEventListener('click', handleAppLinkClick);
  window.addEventListener('popstate', handlePopState);
  if (route.view === 'room') {
    openRoom(route.roomId, { initial: true }).catch(function () {});
  } else {
    closeRoomView();
    restoreSidebarScroll();
  }
}
`;
