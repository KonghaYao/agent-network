/**
 * 4B-1 验收：Vite manifest、`/static/*`、`WEB_SPA_ROUTES` 与灰度 cookie。
 *
 * 默认（flag 为空）时页面输出必须与 `renderHomePage` / `renderChatPage`
 * 逐字节一致；只有显式开启 route 且 manifest 有效时才输出 React 壳。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { IMPLEMENTED_SPA_ROUTES, loadSpaManifest, parseSpaRoutes } from '../src/web/spa-manifest';
import { check, checkEqual, checksPassed } from './lib/harness';
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

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

interface RegisteredAgent {
  actor_id: string;
  agent_session_id: string;
}

/** 通过真实 MCP 注册 Agent，拿到可访问 /a/<session> 的 session 与 token。 */
async function registerAgent(base: string): Promise<RegisteredAgent & { token: string }> {
  const token = crypto.randomUUID();
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'network_register',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name: 'network_register',
        arguments: {
          request_id: requestId('spa_reg'),
          kind: 'agent',
          name: 'SPA 分享',
          agent_session_id: `sess_spa_${crypto.randomUUID().replaceAll('-', '')}`,
        },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-spa-test',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    result?: { structuredContent?: RegisteredAgent; isError?: boolean };
  };
  const identity = payload.result?.structuredContent;
  if (!identity?.agent_session_id) throw new Error('注册 Agent 失败');
  return { ...identity, token };
}

function bootstrapJson(html: string): Record<string, unknown> | null {
  const match = /<script type="application\/json" id="spa-bootstrap">([\s\S]*?)<\/script>/u.exec(html);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
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
  let spaAll: TestServer | undefined;
  let spaPages: TestServer | undefined;
  let spaShareOnly: TestServer | undefined;
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
    const legacyFlag = await fetchText(`${legacy.base}/?spa=1`, {
      cookie: 'agent-network-spa=home',
    });
    check(
      'empty WEB_SPA_ROUTES ignores spa flag and cookie',
      legacyFlag.text.includes('id="room-search"') &&
        !legacyFlag.text.includes('data-spa-route') &&
        legacyFlag.response.headers.get('set-cookie') === null,
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
    check(
      'spa home uses the app shell layout',
      shell.text.includes('class="wide page-home"') &&
        shell.text.includes('id="root"') &&
        shell.text.includes('spa-bootstrap'),
    );
    check(
      'spa home does not load legacy chat client',
      !shell.text.includes('initialRoomId') &&
        !shell.text.includes('id="composer"') &&
        !shell.text.includes('/assets/chat-markdown.js'),
    );

    const flagged = await fetchText(`${spa.base}/?spa=1`);
    check('spa flag renders home', flagged.text.includes('data-spa-route="home"'));
    const flagCookie = flagged.response.headers.get('set-cookie') ?? '';
    check(
      'spa flag writes route cookie',
      flagCookie.includes('agent-network-spa=home') && flagCookie.includes('Max-Age='),
      flagCookie,
    );
    const cookieHome = await fetchText(`${spa.base}/`, {
      cookie: 'agent-network-spa=home',
    });
    check(
      'cookie keeps home shell',
      cookieHome.text.includes('data-spa-route="home"'),
    );
    const cookieOther = await fetchText(`${spa.base}/`, {
      cookie: 'agent-network-spa=room',
    });
    check(
      'cookie cannot enable route absent from env',
      cookieOther.text.includes('id="room-search"') &&
        !cookieOther.text.includes('data-spa-route'),
    );
    const cookieBroken = await fetchText(`${spa.base}/`, {
      cookie: 'agent-network-spa=%E0%A4%A',
    });
    check(
      'malformed cookie falls back to legacy',
      cookieBroken.response.status === 200 && !cookieBroken.text.includes('data-spa-route'),
    );
    const disabled = await fetchText(`${spa.base}/?spa=0`, {
      cookie: 'agent-network-spa=home',
    });
    check(
      'spa=0 returns legacy',
      disabled.text.includes('id="room-search"') && !disabled.text.includes('data-spa-route'),
    );
    check(
      'spa=0 clears cookie',
      (disabled.response.headers.get('set-cookie') ?? '').includes('Max-Age=0'),
      disabled.response.headers.get('set-cookie'),
    );

    const spaChat = await fetchText(`${spa.base}/c/room-test`);
    // legacy 页面内的图标渐变 ID 在每次进程构建时随机，不能跨进程做字节比较；
    // 这里只断言未启用的 route 仍由旧壳渲染，且没有注入 SPA 标记。
    check(
      'unlisted room route stays legacy',
      spaChat.text.includes('page-room') && !spaChat.text.includes('data-spa-route'),
    );

    spaAll = await startTestServer({
      tag: 'spa-multi',
      env: { ENVIRONMENT: 'test', WEB_SPA_ROUTES: 'home,room', WEB_DIST_DIR: DIST },
    });
    const multiHome = await fetchText(`${spaAll.base}/`);
    check(
      'multi route config still renders implemented home',
      multiHome.text.includes('data-spa-route="home"'),
    );
    const multiRoom = await fetchText(`${spaAll.base}/c/room-test`);
    check(
      'implemented room renders the React shell',
      multiRoom.text.includes('data-spa-route="room"') &&
        multiRoom.text.includes('class="wide page-room"') &&
        multiRoom.text.includes('<div id="root"></div>') &&
        !multiRoom.text.includes('initialRoomId'),
    );
    checkEqual(
      'all five routes are implemented',
      [...IMPLEMENTED_SPA_ROUTES].sort().join(','),
      'home,join,pair,room,share',
    );

    spaPages = await startTestServer({
      tag: 'spa-pages',
      env: { ENVIRONMENT: 'test', WEB_SPA_ROUTES: 'share,join,pair', WEB_DIST_DIR: DIST },
    });
    const agent = await registerAgent(spaPages.base);
    const share = await fetchText(`${spaPages.base}/a/${encodeURIComponent(agent.agent_session_id)}`);
    checkEqual('spa share status', share.response.status, 200);
    check(
      'spa share is server-rendered with public data',
      share.text.includes('data-spa-route="share"') &&
        share.text.includes('class="page-share"') &&
        share.text.includes('id="add"') &&
        share.text.includes(agent.actor_id) &&
        share.text.includes('发送好友申请'),
    );
    check(
      'spa share keeps title and OG metadata',
      share.text.includes('<title>添加 SPA 分享 · WeBots</title>') &&
        share.text.includes('property="og:title"') &&
        share.text.includes('property="og:description"') &&
        share.text.includes('SPA 分享'),
    );
    check(
      'spa share does not leak legacy token or inline client',
      !share.text.includes('agent-network-token=') &&
        !share.text.includes(agent.token) &&
        !share.text.includes("callTool('network_register'") &&
        !share.text.includes('id="room-search"'),
    );
    const shareBootstrap = bootstrapJson(share.text);
    check(
      'spa share bootstrap only carries public profile',
      shareBootstrap?.route === 'share' &&
        (shareBootstrap.actor as { actor_id?: string } | null)?.actor_id === agent.actor_id &&
        !JSON.stringify(shareBootstrap).includes(agent.token),
    );
    checkEqual('spa share cache-control', share.response.headers.get('cache-control'), 'no-store');

    const missingShare = await fetchText(`${spaPages.base}/a/missing_${crypto.randomUUID()}`);
    checkEqual('spa share unknown session is 404', missingShare.response.status, 404);
    check(
      'spa share 404 keeps the React shell and readable copy',
      missingShare.text.includes('data-spa-route="share"') &&
        missingShare.text.includes('分享链接无效'),
    );

    const joinPage = await fetchText(`${spaPages.base}/j/${'b'.repeat(32)}`);
    checkEqual('spa join status', joinPage.response.status, 200);
    check(
      'spa join is server-rendered shell without group data',
      joinPage.text.includes('data-spa-route="join"') &&
        joinPage.text.includes('class="page-join"') &&
        joinPage.text.includes('id="join-action"') &&
        joinPage.text.includes('邀请码有效不等于已加入') &&
        !joinPage.text.includes('join-title">群聊') &&
        !joinPage.text.includes('initialRoomId'),
    );
    check(
      'spa join keeps title and OG metadata',
      joinPage.text.includes('<title>加入群聊 · WeBots</title>') &&
        joinPage.text.includes('property="og:title"') &&
        joinPage.text.includes('property="og:description"'),
    );
    check(
      'spa join bootstrap carries invite key',
      (bootstrapJson(joinPage.text)?.inviteKey as string | undefined) === 'b'.repeat(32),
    );
    checkEqual('spa join cache-control', joinPage.response.headers.get('cache-control'), 'no-store');

    const invalidJoin = await fetchText(`${spaPages.base}/j/not-a-valid-key`);
    checkEqual('spa join invalid key is 404', invalidJoin.response.status, 404);
    check(
      'spa join 404 keeps the React shell',
      invalidJoin.text.includes('data-spa-route="join"') &&
        invalidJoin.text.includes('邀请无效'),
    );

    const pair = await fetchText(`${spaPages.base}/pair`);
    checkEqual('spa pair status', pair.response.status, 200);
    check(
      'spa pair is a CSR card shell',
      pair.text.includes('data-spa-route="pair"') &&
        pair.text.includes('class="page-pair"') &&
        pair.text.includes('<div id="root"></div>') &&
        !pair.text.includes('id="pair-challenge"'),
    );
    check(
      'spa pair keeps no-referrer',
      pair.response.headers.get('referrer-policy') === 'no-referrer',
    );
    const pairFlagged = await fetchText(`${spaPages.base}/pair`, {
      cookie: 'agent-network-spa=pair',
    });
    check(
      'cookie can enable pair without enabling join',
      pairFlagged.text.includes('data-spa-route="pair"'),
    );
    const joinStillLegacy = await fetchText(`${spaPages.base}/j/${'c'.repeat(32)}`, {
      cookie: 'agent-network-spa=pair',
    });
    check(
      'cookie intersection keeps unlisted join legacy',
      joinStillLegacy.text.includes('id="join-action"') &&
        !joinStillLegacy.text.includes('data-spa-route'),
    );
    check(
      'home stays legacy when only share/join/pair are enabled',
      (await fetchText(`${spaPages.base}/`)).text.includes('id="room-search"'),
    );

    spaShareOnly = await startTestServer({
      tag: 'spa-share-only',
      env: { ENVIRONMENT: 'test', WEB_SPA_ROUTES: 'share', WEB_DIST_DIR: DIST },
    });
    const shareOnlyAgent = await registerAgent(spaShareOnly.base);
    check(
      'single-route flag still renders share',
      (
        await fetchText(
          `${spaShareOnly.base}/a/${encodeURIComponent(shareOnlyAgent.agent_session_id)}`,
        )
      ).text.includes('data-spa-route="share"'),
    );
    const legacyJoin = await fetchText(`${spaShareOnly.base}/j/${'d'.repeat(32)}`);
    check(
      'share-only flag keeps join legacy',
      legacyJoin.text.includes('id="join-action"') &&
        !legacyJoin.text.includes('data-spa-route'),
    );
    const legacyPair = await fetchText(`${spaShareOnly.base}/pair`);
    check(
      'share-only flag keeps pair legacy',
      legacyPair.text.includes('id="pair-challenge"') &&
        !legacyPair.text.includes('data-spa-route'),
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
    await Promise.all([
      legacy?.dispose(),
      spa?.dispose(),
      spaAll?.dispose(),
      spaPages?.dispose(),
      spaShareOnly?.dispose(),
      fallback?.dispose(),
    ]);
    if (emptyDist) await rm(emptyDist, { recursive: true, force: true }).catch(() => undefined);
  }

  console.log(`\nspa shell checks passed: ${checksPassed()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
