/**
 * 4B-0 验收：Vite manifest、`/static/*` 与 `WEB_SPA_ROUTES` 开关。
 *
 * 默认（flag 为空）时页面输出必须与 `renderHomePage` / `renderChatPage`
 * 逐字节一致；只有显式开启 route 且 manifest 有效时才输出 React 壳。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadSpaManifest, parseSpaRoutes } from '../src/web/spa-manifest';import { check, checkEqual, checksPassed } from './lib/harness';
import { startTestServer, type TestServer } from './lib/test-server';

const DIST = resolve(import.meta.dir, '../dist/web');
const MANIFEST = resolve(DIST, '.vite/manifest.json');

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  return { response, text: await response.text() };
}

async function missingManifest(): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentnet-spa-missing-'));
  try {
    return await loadSpaManifest(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function brokenManifest(): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), 'agentnet-spa-broken-'));
  try {
    await mkdir(resolve(dir, '.vite'), { recursive: true });
    await writeFile(
      resolve(dir, '.vite/manifest.json'),
      JSON.stringify({
        'src/web/app/main.tsx': { file: 'assets/missing.js', isEntry: true },
      }),
    );
    return await loadSpaManifest(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  check('dist manifest exists (run bun run build:web first)', await Bun.file(MANIFEST).exists());
  checkEqual('WEB_SPA_ROUTES default is empty', parseSpaRoutes(undefined).size, 0);
  checkEqual('blank WEB_SPA_ROUTES is empty', parseSpaRoutes('  ').size, 0);
  const parsed = parseSpaRoutes(' home , ROOM,unknown,share ');
  checkEqual('known routes parsed', [...parsed].sort().join(','), 'home,room,share');
  checkEqual('unknown route ignored', parseSpaRoutes('nope').size, 0);
  checkEqual('missing manifest returns null', await missingManifest(), null);
  checkEqual('broken manifest returns null', await brokenManifest(), null);

  const manifest = await loadSpaManifest(DIST);
  check('real manifest loads', manifest !== null);
  if (!manifest) throw new Error('manifest 未加载');
  check('entry points at /static', manifest.entry.startsWith('/static/'), manifest.entry);
  check(
    'css entries point at /static',
    manifest.css.every((href) => href.startsWith('/static/')),
    manifest.css,
  );

  let legacy: TestServer | undefined;
  let spa: TestServer | undefined;
  let fallback: TestServer | undefined;
  let emptyDist: string | undefined;
  try {
    legacy = await startTestServer({
      tag: 'spa-legacy',
      env: { ENVIRONMENT: 'test', WEB_SPA_ROUTES: '', WEB_DIST_DIR: DIST },
    });
    const home = await fetchText(`${legacy.base}/`);
    checkEqual('legacy home status', home.response.status, 200);
    check('legacy home keeps existing shell', home.text.includes('id="room-search"'));
    check('legacy home is not the SPA shell', !home.text.includes('data-spa-route'));
    check('legacy home has no bootstrap payload', !home.text.includes('spa-bootstrap'));
    checkEqual(
      'legacy home cache-control',
      home.response.headers.get('cache-control'),
      'no-store',
    );
    const legacyChat = await fetchText(`${legacy.base}/c/room-test`);
    check('legacy chat keeps existing shell', legacyChat.text.includes('page-room'));

    const asset = await fetchText(`${legacy.base}${manifest.entry}`);
    checkEqual('static asset status', asset.response.status, 200);
    checkEqual(
      'static asset content-type',
      asset.response.headers.get('content-type'),
      'text/javascript; charset=utf-8',
    );
    checkEqual(
      'static asset cache-control',
      asset.response.headers.get('cache-control'),
      'public, max-age=31536000, immutable',
    );
    checkEqual('static asset nosniff', asset.response.headers.get('x-content-type-options'), 'nosniff');
    const etag = asset.response.headers.get('etag');
    check('static asset has etag', typeof etag === 'string' && etag.length > 2, etag);
    const notModified = await fetch(`${legacy.base}${manifest.entry}`, {
      headers: { 'if-none-match': etag ?? '' },
    });
    checkEqual('static asset 304 on etag match', notModified.status, 304);

    checkEqual(
      'static json is not served',
      (await fetch(`${legacy.base}/static/.vite/manifest.json`)).status,
      404,
    );
    checkEqual(
      'static directory is not listed',
      (await fetch(`${legacy.base}/static/assets/`)).status,
      404,
    );
    checkEqual(
      'static path traversal rejected',
      (await fetch(`${legacy.base}/static/..%2f..%2fpackage.json`)).status,
      404,
    );

    spa = await startTestServer({
      tag: 'spa-home',
      env: { ENVIRONMENT: 'test', WEB_SPA_ROUTES: 'home', WEB_DIST_DIR: DIST },
    });
    const shell = await fetchText(`${spa.base}/`);
    checkEqual('spa home status', shell.response.status, 200);
    check('spa home renders shell', shell.text.includes('data-spa-route="home"'));
    check('spa home has root mount', shell.text.includes('<div id="root"></div>'));
    check(
      'spa shell references built entry',
      shell.text.includes(`${manifest.entry}`),
    );
    checkEqual('spa home no-store', shell.response.headers.get('cache-control'), 'no-store');
    check(
      'spa home varies by cookie',
      (shell.response.headers.get('vary') ?? '').toLowerCase().includes('cookie'),
      shell.response.headers.get('vary'),
    );
    check('spa shell has no credential', !/ank_[0-9a-z]/iu.test(shell.text));
    const spaChat = await fetchText(`${spa.base}/c/room-test`);
    // legacy 页面内的图标渐变 ID 在每次进程构建时随机，不能跨进程做字节比较；
    // 这里只断言未启用的 route 仍由旧壳渲染，且没有注入 SPA 标记。
    check(
      'unlisted room route stays legacy',
      spaChat.text.includes('page-room') && !spaChat.text.includes('data-spa-route'),
    );

    emptyDist = await mkdtemp(join(tmpdir(), 'agentnet-spa-empty-'));
    fallback = await startTestServer({
      tag: 'spa-fallback',
      env: {
        ENVIRONMENT: 'test',
        WEB_SPA_ROUTES: 'home',
        WEB_DIST_DIR: emptyDist,
      },
    });
    const fallbackHome = await fetchText(`${fallback.base}/`);
    check(
      'missing manifest falls back to legacy',
      fallbackHome.text.includes('id="room-search"') &&
        !fallbackHome.text.includes('data-spa-route'),
    );
  } finally {
    await Promise.all([legacy?.dispose(), spa?.dispose(), fallback?.dispose()]);
    if (emptyDist) await rm(emptyDist, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\nspa shell checks passed: ${checksPassed()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
