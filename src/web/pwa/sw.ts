/**
 * WeBots Service Worker 源码与可测试的路由规则。
 *
 * 首版不写 Cache Storage：只拦截同源、无 query、无凭据、无 Range 的顶层
 * 文档导航（`/` 或 `/c/<单一非空段>`），网络优先；仅 fetch reject 时返回
 * 内嵌离线页。其它请求完全不调用 `respondWith`，包括 `/mcp`、SSE、
 * `/mcp-upload`、`/f/*`、`/pair`、`/a/*`、`/j/*` 与静态资源。
 */

export interface ServiceWorkerRequestFacts {
  readonly url: string;
  readonly origin: string;
  readonly method: string;
  readonly mode: string;
  readonly destination: string;
  readonly hasAuthorization: boolean;
  readonly hasRange: boolean;
}

/** 顶层普通文档导航；任一条件不满足都交还浏览器默认网络路径。 */
export function shouldHandleNavigation(facts: ServiceWorkerRequestFacts): boolean {
  const roomPath = /^\/c\/[^/]+$/u;
  if (facts.method !== 'GET') return false;
  if (facts.hasAuthorization || facts.hasRange) return false;
  if (facts.mode !== 'navigate' || facts.destination !== 'document') return false;
  let url: URL;
  try {
    url = new URL(facts.url);
  } catch {
    return false;
  }
  if (url.origin !== facts.origin) return false;
  // 带 query 的导航可能含 token/ticket/code/challenge，首版保守全放行。
  if (url.search !== '') return false;
  return url.pathname === '/' || roomPath.test(url.pathname);
}

/** 自包含离线页：系统字体、少量内联样式、无脚本、无外部资源。 */
export function offlinePageHtml(pathname: string): string {
  const escape = (value: string): string =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  const retryHref = escape(pathname.startsWith('/') ? pathname : '/');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>WeBots 当前离线</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { min-height: 100dvh; display: grid; place-items: center; padding: 24px;
    background: #f5f5f5; color: #1a1a1a;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  main { width: min(420px, 100%); padding: 28px 24px; border-radius: 12px;
    background: #ffffff; box-shadow: 0 1px 3px rgba(0,0,0,.08); text-align: center; }
  h1 { margin: 0 0 10px; font-size: 20px; font-weight: 600; }
  p { margin: 0 0 20px; color: #666666; }
  a { display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px; padding: 0 20px; border-radius: 8px;
    background: #07c160; color: #ffffff; font-weight: 600; text-decoration: none; }
  a:focus-visible { outline: 2px solid #1a1a1a; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    body { background: #191919; color: #ededed; }
    main { background: #2c2c2c; box-shadow: none; }
    p { color: #a3a3a3; }
    a:focus-visible { outline-color: #ededed; }
  }
</style>
</head>
<body>
<main>
<h1>WeBots 当前离线</h1>
<p>网络暂时不可用。恢复连接后可以继续使用；已发送的消息以服务端回执为准。</p>
<a id="offline-retry" href="${retryHref}">重试</a>
</main>
</body>
</html>`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function webotsServiceWorker(
  scope: any,
  handleNavigation: (facts: ServiceWorkerRequestFacts) => boolean,
  renderOffline: (pathname: string) => string,
): void {
  const CACHE_PREFIX = 'webots-sw-';

  scope.addEventListener('activate', (event: any): void => {
    event.waitUntil(
      scope.caches.keys().then((keys: string[]) =>
        Promise.all(
          keys
            .filter((key: string) => key.startsWith(CACHE_PREFIX))
            .map((key: string) => scope.caches.delete(key)),
        ),
      ),
    );
  });

  scope.addEventListener('fetch', (event: any): void => {
    const request = event.request;
    const handled = handleNavigation({
      url: request.url,
      origin: scope.location.origin,
      method: request.method,
      mode: request.mode,
      destination: request.destination,
      hasAuthorization: request.headers.has('authorization'),
      hasRange: request.headers.has('range'),
    });
    if (!handled) return;
    event.respondWith(
      scope.fetch(request).catch(() => {
        const pathname = new URL(request.url).pathname;
        return new Response(renderOffline(pathname), {
          status: 503,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }),
    );
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * 以函数源码生成 worker：规则与离线页函数只有一份实现，单元测试可直接
 * 调用上面的纯函数，运行时行为由 Playwright 覆盖。
 */
export const SERVICE_WORKER_SOURCE = `/* WeBots Service Worker: no app cache, offline fallback only. */
(${webotsServiceWorker.toString()})(self, ${shouldHandleNavigation.toString()}, ${offlinePageHtml.toString()});
`;
