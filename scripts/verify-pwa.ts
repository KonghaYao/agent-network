/**
 * PWA 阶段 2a 单元验收：manifest 字段、图标字节、head 标签、SW 路由规则
 * 与离线页自包含约束。HTTP 头与真实拦截行为由 Playwright 用例覆盖。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  PWA_BACKGROUND_COLOR,
  PWA_BRAND_GREEN,
  PWA_MANIFEST_PATH,
  PWA_THEME_COLOR,
} from '../src/web/pwa/brand';
import { PWA_BRAND_ASSETS } from '../src/web/pwa/brand-assets.generated';
import { buildPwaManifest, pwaHeadTags } from '../src/web/pwa/manifest';
import {
  SERVICE_WORKER_SOURCE,
  offlinePageHtml,
  shouldHandleNavigation,
  type ServiceWorkerRequestFacts,
} from '../src/web/pwa/sw';
import { check, checkEqual, checksPassed } from './lib/harness';

const REPO_ROOT = resolve(import.meta.dir, '..');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24) throw new Error('PNG 太短');
  const signature = Array.from(bytes.subarray(0, 8)).join(',');
  if (signature !== '137,80,78,71,13,10,26,10') throw new Error('PNG 签名不正确');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) throw new Error('IHDR 长度不正确');
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function facts(
  overrides: Partial<ServiceWorkerRequestFacts> = {},
): ServiceWorkerRequestFacts {
  return {
    url: 'https://bots.example/',
    origin: 'https://bots.example',
    method: 'GET',
    mode: 'navigate',
    destination: 'document',
    hasAuthorization: false,
    hasRange: false,
    ...overrides,
  };
}

async function assertAsset(
  label: string,
  asset: { url: string; path: string; contentType: string; sha256: string },
  expected: { width: number; height: number } | null,
): Promise<void> {
  const bytes = new Uint8Array(await readFile(resolve(REPO_ROOT, asset.path)));
  check(`${label} URL 含内容哈希`, new RegExp(`-${asset.sha256.slice(0, 12)}\\.`, 'u').test(asset.url));
  checkEqual(`${label} 摘要与文件一致`, sha256(bytes), asset.sha256);
  if (expected) {
    const size = pngSize(bytes);
    checkEqual(`${label} 宽`, size.width, expected.width);
    checkEqual(`${label} 高`, size.height, expected.height);
  }
}

async function main() {
  const manifest = buildPwaManifest();
  checkEqual('manifest id 稳定', manifest.id, '/');
  checkEqual('manifest start_url', manifest.start_url, '/');
  checkEqual('manifest scope', manifest.scope, '/');
  checkEqual('manifest display', manifest.display, 'standalone');
  checkEqual('manifest name', manifest.name, 'WeBots');
  checkEqual('manifest short_name', manifest.short_name, 'WeBots');
  checkEqual('manifest lang', manifest.lang, 'zh-CN');
  checkEqual('manifest theme_color 保持蓝色', manifest.theme_color, PWA_THEME_COLOR);
  checkEqual('manifest theme_color 值', manifest.theme_color, '#007aff');
  checkEqual('manifest background_color', manifest.background_color, PWA_BACKGROUND_COLOR);
  checkEqual('品牌绿色', PWA_BRAND_GREEN, '#07C160');
  const anyIcons = manifest.icons.filter((icon) => icon.purpose === 'any');
  const maskable = manifest.icons.find((icon) => icon.purpose === 'maskable');
  check('manifest 有 192 与 512 any', anyIcons.some((i) => i.sizes === '192x192') && anyIcons.some((i) => i.sizes === '512x512'));
  check('manifest 有 180 Apple 图标', anyIcons.some((i) => i.sizes === '180x180'));
  check('manifest 有 512 maskable', maskable?.sizes === '512x512');
  for (const icon of manifest.icons) {
    check(`manifest 图标 URL 以 /pwa/ 开头: ${icon.src}`, icon.src.startsWith('/pwa/'));
  }

  const head = pwaHeadTags();
  check('head 有 manifest link', head.includes(`rel="manifest" href="${PWA_MANIFEST_PATH}"`));
  check('head 有 theme-color', head.includes(`name="theme-color" content="${PWA_THEME_COLOR}"`));
  check('head 有 apple-touch-icon', head.includes('rel="apple-touch-icon"'));
  check('head 有 favicon', head.includes('rel="icon" type="image/svg+xml"'));
  check('head 不再内联旧 data URI favicon', !head.includes('data:image/svg+xml'));

  await assertAsset('icon192', PWA_BRAND_ASSETS.icon192, { width: 192, height: 192 });
  await assertAsset('icon512', PWA_BRAND_ASSETS.icon512, { width: 512, height: 512 });
  await assertAsset('maskable512', PWA_BRAND_ASSETS.iconMaskable512, {
    width: 512,
    height: 512,
  });
  await assertAsset('apple180', PWA_BRAND_ASSETS.appleTouch180, {
    width: 180,
    height: 180,
  });
  await assertAsset('favicon', PWA_BRAND_ASSETS.favicon, null);

  check('SW 处理根路径', shouldHandleNavigation(facts()));
  check(
    'SW 处理单段会话路径',
    shouldHandleNavigation(facts({ url: 'https://bots.example/c/rm_123' })),
  );
  check('SW 不处理带 query', !shouldHandleNavigation(facts({ url: 'https://bots.example/?t=x' })));
  check('SW 不处理 POST', !shouldHandleNavigation(facts({ method: 'POST' })));
  check('SW 不处理 Authorization', !shouldHandleNavigation(facts({ hasAuthorization: true })));
  check('SW 不处理 Range', !shouldHandleNavigation(facts({ hasRange: true })));
  check('SW 不处理跨源', !shouldHandleNavigation(facts({ url: 'https://evil.example/' })));
  check('SW 不处理非导航', !shouldHandleNavigation(facts({ mode: 'cors' })));
  check(
    'SW 不处理 iframe 文档',
    !shouldHandleNavigation(facts({ destination: 'iframe' })),
  );
  for (const path of [
    '/pair',
    '/a/agent',
    '/j/invite',
    '/mcp',
    '/mcp-upload',
    '/f/file',
    '/static/assets/main.js',
    '/c/',
    '/c/a/b',
    '/c/rm_123',
    '/',
  ]) {
    const expected = path === '/' || path === '/c/rm_123';
    checkEqual(
      `SW 路径规则 ${path}`,
      shouldHandleNavigation(facts({ url: `https://bots.example${path}` })),
      expected,
    );
  }

  const offline = offlinePageHtml('/c/rm_123');
  check('离线页含原路径重试链接', offline.includes('href="/c/rm_123"'));
  check('离线页无脚本', !/<script/iu.test(offline) && !/javascript:/iu.test(offline));
  check('离线页无外部资源', !/(?:src|href)="https?:/iu.test(offline));
  check('离线页使用系统字体', offline.includes('-apple-system'));
  check('离线页转义路径', offlinePageHtml('/c/a"><script>').includes('&quot;&gt;&lt;script&gt;'));

  check('SW 源码含 fetch 拦截', SERVICE_WORKER_SOURCE.includes('respondWith'));
  check('SW 只捕获 fetch reject', SERVICE_WORKER_SOURCE.includes('scope.fetch(request).catch'));
  check('SW 不读取响应状态改写结果', !SERVICE_WORKER_SOURCE.includes('.then((response'));
  check('SW 源码含 503 离线页', SERVICE_WORKER_SOURCE.includes('503'));
  check('SW 源码无 skipWaiting', !SERVICE_WORKER_SOURCE.includes('skipWaiting'));
  check('SW 源码无 clients.claim', !SERVICE_WORKER_SOURCE.includes('clients.claim'));
  check('SW 源码无 caches.open', !SERVICE_WORKER_SOURCE.includes('caches.open'));
  check('SW 源码只在 activate 清旧缓存', SERVICE_WORKER_SOURCE.includes('caches.delete'));
  check('SW 源码包含路径判断函数', SERVICE_WORKER_SOURCE.includes('URL'));
  check('SW 源码包含离线页函数', SERVICE_WORKER_SOURCE.includes('offlinePageHtml'));
  check('SW 源码含离线 HTML', SERVICE_WORKER_SOURCE.includes('<!doctype html>'));

  console.log(`\nPWA 单元检查通过：${checksPassed()} 项`);
}

await main();
