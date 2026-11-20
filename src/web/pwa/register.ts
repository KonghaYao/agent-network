/**
 * 生产构建的 Service Worker 注册。
 *
 * 只在生产构建、HTTPS（或 localhost 测试源）注册；等待首屏关键请求
 * （load）且浏览器空闲后再注册，避免与入口脚本/字体竞争。开发服务器
 * 默认关闭。注册失败静默处理，不影响网页功能。
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
  if (!__WEB_PRODUCTION__) return;
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
