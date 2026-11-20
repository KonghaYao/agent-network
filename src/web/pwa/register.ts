/**
 * 生产构建的 Service Worker 注册。
 *
 * 只在生产构建、HTTPS（或 localhost 测试源）注册；等待首屏关键请求
 * （load）且浏览器空闲后再注册，避免与入口脚本/字体竞争。开发服务器
 * 默认关闭。注册失败静默处理，不影响网页功能。
 *
 * Vite 7 的 `import.meta.env.PROD` 仍由 `NODE_ENV` 推导：`NODE_ENV=test vite build`
 * 会把生产构建当成非生产，静默移除注册。因此构建默认的 `MODE=production`
 * 也视为生产，避免环境变量泄漏让发布产物丢失 PWA；开发服务器默认
 * `MODE=development`，两条都不满足，不会注册。
 */

function isLocalTestOrigin(): boolean {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function register(): void {
  navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .catch(() => {
      // 安装/离线页是增强能力；注册失败不阻断在线页面。
    });
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD && import.meta.env.MODE !== 'production') return;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext && !isLocalTestOrigin()) return;

  const schedule = () => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => register(), { timeout: 3000 });
      return;
    }
    setTimeout(register, 1600);
  };

  if (document.readyState === 'complete') {
    schedule();
    return;
  }
  window.addEventListener('load', schedule, { once: true });
}
